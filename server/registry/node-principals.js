'use strict';
/**
 * Pairing a person's machine (plan T2, docs/t2-cells-and-node-principal.md section 4.2, slice N4b;
 * migrations/0014_node_pairing.sql). A service holding network.node.manage (Bot) mints a one-time pairing code for one
 * of its users; the machine redeems it with no other credential and becomes a node principal (nod_<ULID>) owned by that
 * person, with a long-lived credential shown once. The service may then read and revoke only the principals it paired.
 *
 * Secrets: the code and the credential are shown once and stored only as their sha256; neither is ever logged nor
 * returned by a read. A paired principal is never a platform machine: no platform_nodes row is created, and Host's node
 * report naming its node_id is refused (cells.checkPlatformNodes, 409 registry.node_not_platform).
 *
 *   POST /internal/node-pairings                 network.node.manage   → 201 {pairing_id, code, expires_at}
 *   POST /api/v1/node-pairing                    none (the code)       → 201 {principal, node_id, home_cell, credential, …}
 *   GET  /internal/node-principals/:id           network.node.manage   → the principal, if the caller paired it
 *   POST /internal/node-principals/:id/revoke    network.node.manage   → the principal, revoked (idempotent)
 *   GET  /api/v1/me/nodes                        session               → the person's own machines, newest first
 *   POST /api/v1/me/nodes/:id/revoke             session               → their principal, revoked (idempotent)
 *
 * Every revoke — the service route, the owner's route, or an account deletion — writes network.node.revoked@1 into
 * the outbox in the same transaction (Contracts 0.98.0; docs/t2-cells-and-node-principal.md section 10): a service
 * holding the machine's session stops it at once, not at its next reauth (≤ 330 s). A second revoke emits nothing;
 * the payload carries the ids, the owner and the reason, never the credential or its hash.
 *
 * The paired machine itself (section 4.3, slice N4c): its credential buys a node token (sub node:nod_…) at
 * POST /oauth/token, and with it the machine manages only its own row. The routes resolve the node from the verified
 * token, never from the body or the path.
 *   POST /oauth/token  client_id=nod_…            the credential        → 200 node token (oauth-routes.js)
 *   PUT  /api/v1/node/self/capabilities          network.node.self.manage → 200 {node_id, reported_at}
 *   POST /api/v1/node/self/credential            network.node.self.manage → 200 {principal, node_id, credential, …}
 */
const crypto = require('crypto');
const express = require('express');
const { ids, http, serviceAuth, validate, assertValid } = require('openvibe-contracts');
const { BOOTSTRAP_CELL, RegistryError } = require('./cells');
const { TOKEN_TTL_S, SELF_AUDIENCE } = require('../identity/principals');
const eventRelay = require('../developer/event-relay');

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_TRIES = 5;
const PREV_GRACE_MS = 60 * 1000;   // a rotated-out credential still works this long (Bot's grace window)
const SEEN_EVERY_MS = 60 * 1000;   // last_seen_at is written at most this often
const SUBJECT = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const PAIRING_ID = /^pair_[0-9A-HJKMNP-TV-Z]{26}$/;
const PRINCIPAL_ID = /^nod_[0-9A-HJKMNP-TV-Z]{26}$/;
const REGION = /^[a-z][a-z0-9-]{1,39}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

// Crockford base32 (Bot's alphabet): no I, L, O or U, so a code read aloud cannot be mistyped into another.
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const normaliseCode = (s) => String(s || '').toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/[ILO]/g, (c) => ({ I: '1', L: '1', O: '0' }[c]));
const isCodeShape = (s) => /^[0-9A-HJKMNP-TV-Z]{8}$/.test(s);
const formatCode = (s) => `${s.slice(0, 4)}-${s.slice(4)}`;
function newCode() {
    const b = crypto.randomBytes(8);
    let s = '';
    for (let i = 0; i < 8; i++) s += CROCKFORD[b[i] % 32]; // 256 % 32 = 0: no bias
    return s;
}
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
/** Constant-time equality of two stored hashes. */
function sameHash(a, b) {
    const x = Buffer.from(String(a || ''));
    const y = Buffer.from(String(b || ''));
    if (x.length !== y.length) { crypto.timingSafeEqual(x, x); return false; }
    return crypto.timingSafeEqual(x, y);
}
const text = (v, max) => typeof v === 'string' && v.trim().length >= 1 && v.trim().length <= max && !CONTROL.test(v) ? v.trim() : null;
const iso = (ms) => new Date(ms).toISOString();

/** The first active cell of a region, else wnam-1 (the same rule as cells.js cellForRegion, for a paired machine). */
async function cellForRegion(db, region) {
    const row = region ? await db.prepare("SELECT id FROM platform_cells WHERE region = ? AND status = 'active' ORDER BY id LIMIT 1").get(region) : null;
    return row ? row.id : BOOTSTRAP_CELL;
}

/** The service a verified service token speaks for: svc:<id> → <id>. */
const serviceOf = (req) => String(req.principal && req.principal.sub || '').replace(/^svc:/, '');

/** What a service or the owner may see of a principal: never a hash. */
const principalView = (p) => ({
    principal: p.id, node_id: p.node_id, name: p.name || null,
    owner: p.owner_kind === 'user' ? { kind: 'user', subject: p.owner_subject } : p.owner_kind === 'project' ? { kind: 'project', project_id: p.project_id } : { kind: p.owner_kind },
    home_cell: p.home_cell, status: p.status,
    paired_for: p.paired_by_service ? { service: p.paired_by_service, ref: p.pairing_ref } : null,
    last_seen_at: p.last_seen_at || null, created_at: p.created_at, revoked_at: p.revoked_at || null,
});

/**
 * Mint a pairing code for `service`'s user. Replaces that service's unused codes for the same ref.
 * Throws RegistryError. → { pairing_id, code, expires_at } (the code in the clear, this once).
 */
async function createPairing(db, service, body, now = Date.now()) {
    const owner = body && body.owner;
    if (owner && owner.kind === 'project') throw new RegistryError(501, 'registry.not_yet', 'project-owned machines are not paired yet');
    if (!owner || owner.kind !== 'user' || typeof owner.subject !== 'string' || !SUBJECT.test(owner.subject)) {
        throw new RegistryError(400, 'registry.invalid_pairing_request', "owner must be {kind: 'user', subject: 'usr_…'}");
    }
    const ref = text(body.ref, 80);
    if (!ref) throw new RegistryError(400, 'registry.invalid_pairing_request', 'ref must be 1-80 characters');
    if (body.home_cell !== undefined && body.home_cell !== null && typeof body.home_cell !== 'string') throw new RegistryError(400, 'registry.invalid_pairing_request', 'home_cell must be a cell id');
    const user = await db.prepare(`SELECT id FROM users WHERE subject_id = ? AND COALESCE(is_banned, 0) = 0 AND deleted_at IS NULL
        AND merged_into IS NULL AND COALESCE(is_anon, 0) = 0`).get(owner.subject);
    if (!user) throw new RegistryError(404, 'registry.unknown_owner', `no person ${owner.subject}`);
    const homeCell = body.home_cell || null;
    if (homeCell) {
        const cell = await db.prepare('SELECT status FROM platform_cells WHERE id = ?').get(homeCell);
        if (!cell) throw new RegistryError(400, 'registry.unknown_cell', `no cell ${homeCell}`);
        if (cell.status !== 'active') throw new RegistryError(409, 'registry.cell_not_active', `cell ${homeCell} is ${cell.status}`);
    }
    const id = `pair_${ids.ulid(now)}`;
    const expiresAt = iso(now + CODE_TTL_MS);
    let code = null;
    await db.tx(async (t) => {
        // One live code per (service, ref), as Bot's one live code per robot.
        await t.prepare('DELETE FROM platform_node_pairings WHERE service = ? AND ref = ? AND used_at IS NULL').run(service, ref);
        const insert = t.prepare(`INSERT INTO platform_node_pairings (id, code_hash, owner_kind, owner_subject, service, ref, home_cell, created_by, created_at, expires_at)
            VALUES (?, ?, 'user', ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (code_hash) DO NOTHING`);
        // 40 random bits: a clash with a stored hash is improbable, and is drawn again rather than failing.
        for (let i = 0; i < 3 && !code; i++) {
            const c = newCode();
            if ((await insert.run(id, sha256(c), owner.subject, service, ref, homeCell, `svc:${service}`, iso(now), expiresAt)).changes) code = c;
        }
        if (!code) throw new Error('could not draw a unique pairing code');
    });
    return { pairing_id: id, code: formatCode(code), expires_at: expiresAt };
}

/**
 * Redeem a code (Bot's redeem, OpenVibe.Bot server/domain/index.js:158-205). With `pairing` a wrong code counts a try
 * against that row (5 lock it); without it the code is found by its hash. Refusals are returned from the transaction and
 * thrown after it commits, so a counted try survives. Throws RegistryError. → { principal row, credential }
 */
async function redeem(db, body, now = Date.now()) {
    const b = body && typeof body === 'object' ? body : {};
    const normal = normaliseCode(typeof b.code === 'string' ? b.code : '');
    if (!isCodeShape(normal)) throw new RegistryError(422, 'registry.invalid_pairing_code', 'the pairing code must be 8 characters (XXXX-XXXX)');
    if (b.pairing !== undefined && b.pairing !== null && (typeof b.pairing !== 'string' || !PAIRING_ID.test(b.pairing))) throw new RegistryError(400, 'registry.invalid_pairing_request', 'pairing must be a pair_ id');
    const name = b.name === undefined || b.name === null ? null : text(b.name, 80);
    if (b.name != null && !name) throw new RegistryError(400, 'registry.invalid_pairing_request', 'name must be 1-80 characters');
    if (b.region != null && (typeof b.region !== 'string' || !REGION.test(b.region))) throw new RegistryError(400, 'registry.invalid_pairing_request', 'region must be a region id');
    const hash = sha256(normal);
    const at = iso(now);
    const result = await db.tx(async (t) => {
        let row;
        if (b.pairing) {
            row = await t.prepare('SELECT * FROM platform_node_pairings WHERE id = ? FOR UPDATE').get(b.pairing);
            if (!row) return { error: [403, 'registry.pairing_code_invalid', 'that is not a live pairing code'] };
            if (!sameHash(row.code_hash, hash)) {
                if (row.used_at) return { error: [403, 'registry.pairing_code_invalid', 'that is not the pairing code'] };
                if (Number(row.tries) >= MAX_TRIES) return { error: [403, 'registry.pairing_code_locked', 'too many wrong tries; the code is dead'] };
                const tries = Number(row.tries) + 1;
                await t.prepare('UPDATE platform_node_pairings SET tries = ? WHERE id = ?').run(tries, row.id);
                return { error: tries >= MAX_TRIES ? [403, 'registry.pairing_code_locked', 'too many wrong tries; the code is dead'] : [403, 'registry.pairing_code_invalid', 'that is not the pairing code'] };
            }
        } else {
            row = await t.prepare('SELECT * FROM platform_node_pairings WHERE code_hash = ? FOR UPDATE').get(hash);
            if (!row) return { error: [403, 'registry.pairing_code_invalid', 'that is not a live pairing code'] };
        }
        if (row.used_at) return { error: [403, 'registry.pairing_code_used', 'that pairing code has already been used'] };
        if (Number(row.tries) >= MAX_TRIES) return { error: [403, 'registry.pairing_code_locked', 'too many wrong tries; the code is dead'] };
        if (Date.parse(row.expires_at) <= now) return { error: [403, 'registry.pairing_code_expired', 'that pairing code has expired'] };
        if (row.owner_kind !== 'user') return { error: [501, 'registry.not_yet', 'project-owned machines are not paired yet'] };
        await t.prepare('UPDATE platform_node_pairings SET used_at = ? WHERE id = ?').run(at, row.id);
        const ulid = ids.ulid(now);
        const principalId = `nod_${ulid}`;
        const credential = crypto.randomBytes(32).toString('base64url');
        const homeCell = row.home_cell || await cellForRegion(t, b.region);
        // A paired machine is a principal only: no platform_nodes row, so it is never a platform machine.
        await t.prepare(`INSERT INTO platform_node_principals (id, node_id, home_cell, owner_kind, owner_subject, name, trust, status,
                credential_hash, paired_by_service, pairing_ref, created_at, created_by, updated_at)
            VALUES (?, ?, ?, 'user', ?, ?, 'community', 'active', ?, ?, ?, ?, ?, ?)`)
            .run(principalId, `n-${ulid.toLowerCase()}`, homeCell, row.owner_subject, name, sha256(credential), row.service, row.ref, at, `pairing:${row.id}`, at);
        await t.prepare('UPDATE platform_node_pairings SET principal_id = ? WHERE id = ?').run(principalId, row.id);
        return { principal: await t.prepare('SELECT * FROM platform_node_principals WHERE id = ?').get(principalId), credential };
    });
    if (result.error) throw new RegistryError(...result.error);
    return result;
}

/**
 * The principal `id` matching a caller-owned scope (`where` + `params`, literals only), or null. A principal
 * another caller owns is indistinguishable from none: the routes answer 404, never 403, so nobody can probe
 * whose machine an id is.
 */
async function byScope(db, id, scope) {
    if (!PRINCIPAL_ID.test(String(id))) return null;
    return await db.prepare(`SELECT * FROM platform_node_principals WHERE id = ? AND ${scope.where}`).get(String(id), ...scope.params) || null;
}

/** A principal `service` paired, or null (another service's principal is indistinguishable from none). */
const pairedBy = (db, id, service) => byScope(db, id, { where: 'paired_by_service = ?', params: [service] });

/** The payload's `owner` (network.node.revoked@1's oneOf), from the principal row. */
const ownerOf = (p) => p.owner_kind === 'user' ? { kind: 'user', subject: p.owner_subject }
    : p.owner_kind === 'project' ? { kind: 'project', project_id: p.project_id }
    : { kind: 'platform' };

/**
 * The network.node.revoked@1 envelope for a principal row just revoked (Contracts 0.98.0; docs/t2-cells-and-node-
 * principal.md section 10). Only the ids, who owns the machine, why and when: never the credential or its hash.
 * Validates payload and envelope (a bug if either is off, never user input).
 */
function revokedEnvelope(p, { actor, reason, at }) {
    const payload = { node_id: p.node_id, principal_id: p.id, owner: ownerOf(p), at };
    if (reason) payload.reason = reason;
    const env = {
        event_id: ids.newId('event', Date.parse(at)), event_type: 'network.node.revoked', version: 1, source: 'network',
        actor, timestamp: at, visibility: 'internal', subject: { type: 'node_principal', id: p.id }, payload,
    };
    const ev = validate('events.event-envelope@1', env);
    const pv = validate('network.node.revoked@1', payload);
    if (!ev.valid || !pv.valid) throw new Error(`node-principals: bad event ${JSON.stringify((ev.errors || []).concat(pv.errors || [])).slice(0, 300)}`);
    return env;
}

/** The caller's reason text (1-500 chars, no control characters), or null; anything else is a 400. */
function reasonOf(raw) {
    if (raw === undefined || raw === null) return null;
    const r = text(raw, 500);
    if (!r) throw new RegistryError(400, 'registry.invalid_reason', 'reason must be 1-500 characters');
    return r;
}

/**
 * Revoke one active principal row and enqueue its network.node.revoked@1 on the ambient transaction, so the change
 * and the event share it. → changes (0 or 1): a row already revoked changes nothing and emits nothing.
 */
async function revokeRow(db, p, { revokedBy, actor, reason, at }) {
    const changed = (await db.prepare(`UPDATE platform_node_principals SET status = 'revoked', revoked_at = ?, revoked_by = ?, credential_prev_hash = NULL,
        prev_valid_until = NULL, updated_at = ? WHERE id = ? AND status <> 'revoked'`).run(at, revokedBy, at, p.id)).changes;
    if (!changed) return 0;
    await eventRelay.writerFor(db).enqueue(db, revokedEnvelope(p, { actor, reason, at }));
    return 1;
}

/**
 * Revoke a principal matching a caller-owned scope; a second revoke changes nothing (and emits nothing). → the row,
 * or null. The previous credential and its grace window are cleared. `credential_hash` stays: migrations/0014's
 * platform_node_principals_credential CHECK requires one for a user-owned principal, and a revoked row cannot
 * authenticate because every reader requires status = 'active'. One function, so the service route and the
 * person's own route revoke identically, both writing the event in the same transaction as the revoke.
 */
async function revokeScoped(db, id, scope, revokedBy, now = Date.now(), reason = null) {
    const at = iso(now);
    const actor = String(revokedBy).startsWith('svc:')
        ? { type: 'service', id: String(revokedBy).slice(4) }
        : { type: 'user', id: String(revokedBy) };
    return await db.tx(async () => {
        const p = await db.prepare(`SELECT * FROM platform_node_principals WHERE id = ? AND ${scope.where}`).get(String(id), ...scope.params);
        if (!p) return null;
        await revokeRow(db, p, { revokedBy, actor, reason, at });
        return await db.prepare(`SELECT * FROM platform_node_principals WHERE id = ? AND ${scope.where}`).get(String(id), ...scope.params);
    });
}

/** Revoke a principal `service` paired; revoked_by is svc:<service>. → the row, or null. */
const revoke = (db, id, service, now = Date.now(), reason = null) => revokeScoped(db, id, { where: 'paired_by_service = ?', params: [service] }, `svc:${service}`, now, reason);

/**
 * Revoke every active principal owned by any of `subjects` and enqueue its event, on the caller's ambient
 * transaction (an account deletion: the person's machines go with the account, and each revoke is announced so a
 * consumer stops the machine at once). Returns how many changed; a row already revoked emits nothing.
 */
async function revokeOwnedBy(db, subjects, { revokedBy = 'account_deleted', actor, reason = 'account_deleted', now = Date.now() } = {}) {
    const at = iso(now);
    let revoked = 0;
    for (const sid of subjects || []) {
        if (!SUBJECT.test(String(sid))) continue;
        const rows = await db.prepare("SELECT * FROM platform_node_principals WHERE owner_kind = 'user' AND owner_subject = ? AND status <> 'revoked'").all(String(sid));
        for (const p of rows) revoked += await revokeRow(db, p, { revokedBy, actor: actor || { type: 'user', id: String(sid) }, reason, at });
    }
    return revoked;
}

/** The query filters of the operator and service principal lists; anything but a string is ignored. */
const principalFilter = (q = {}) => Object.fromEntries(['cell', 'owner_kind', 'status'].map((k) => [k, typeof q[k] === 'string' ? q[k] : null]));

/** Every node principal for operators and services holding network.registry.read, newest first, at most 500. */
async function listPrincipals(db, { cell = null, owner_kind: ownerKind = null, status = null } = {}) {
    const where = []; const params = [];
    if (cell) { where.push('home_cell = ?'); params.push(cell); }
    if (ownerKind) { where.push('owner_kind = ?'); params.push(ownerKind); }
    if (status) { where.push('status = ?'); params.push(status); }
    const rows = await db.prepare(`SELECT * FROM platform_node_principals ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY created_at DESC, id DESC LIMIT 500`).all(...params);
    return rows.map((p) => ({ ...principalView(p), trust: p.trust }));
}

/** What an operator may set a principal to: revoked has its own routes (revokeScoped), and is never undone. */
const OPERATOR_STATUS = ['active', 'draining'];

/**
 * Operator write (plan T2): drain a node principal, or make it active again, from a staff session
 * (server/registry/registry-admin.js). Throws RegistryError. → the principal (with trust)
 */
async function setPrincipalStatus(db, id, status, now = Date.now()) {
    if (!OPERATOR_STATUS.includes(status)) throw new RegistryError(422, 'registry.invalid_status', 'status must be active or draining (revoking has its own route)');
    const get = db.prepare('SELECT * FROM platform_node_principals WHERE id = ?');
    const p = PRINCIPAL_ID.test(String(id)) ? await get.get(String(id)) : null;
    if (!p) throw new RegistryError(404, 'registry.unknown_node', `no node principal ${id}`);
    const at = iso(now);
    const changed = (await db.prepare("UPDATE platform_node_principals SET status = ?, updated_at = ? WHERE id = ? AND status <> 'revoked'").run(status, at, p.id)).changes;
    if (!changed) throw new RegistryError(409, 'registry.node_revoked', `node principal ${id} was revoked`);
    const row = await get.get(p.id);
    return { ...principalView(row), trust: row.trust };
}

/** Scope for a person's own machines: the principals they own, and no others. */
const ownScope = (me) => ({ where: "owner_kind = 'user' AND owner_subject = ?", params: [me] });

/** The signed-in person's subject id, or a RegistryError for a guest (never manages machines). */
async function meOf(db, user) {
    if (!user || user.is_anon) throw new RegistryError(403, 'registry.guest', 'sign in with an account to manage your machines');
    const sid = await require('../identity/subjects').ensureUserSubject(db, user);
    if (!SUBJECT.test(String(sid || ''))) throw new RegistryError(403, 'registry.guest', 'sign in with an account to manage your machines');
    return sid;
}

// Mounted at /api/v1/me/nodes behind requireAuth (server/index.js): a person's own machines, and nothing else.
function userRouter(requireAuth, now = () => Date.now()) {
    const router = express.Router();
    router.use(http.middleware());
    const send = async (res, fn) => {
        try { return await fn(); } catch (e) {
            if (e instanceof RegistryError) return http.sendProblem(res, e.status, e.code, { detail: e.message });
            console.error('[Node principals]', e.message);
            return http.sendProblem(res, 500, 'registry.failed', { detail: 'the machines could not be read or changed' });
        }
    };
    router.get('/', requireAuth, async (req, res) => await send(res, async () => {
        res.set('Cache-Control', 'private, no-store');
        const db = req.app.locals.db;
        const me = await meOf(db, req.user);
        const rows = await db.prepare(`SELECT * FROM platform_node_principals WHERE owner_kind = 'user' AND owner_subject = ?
            ORDER BY created_at DESC, id DESC`).all(me);
        res.json({ nodes: rows.map(principalView) });
    }));
    router.post('/:principal/revoke', requireAuth, async (req, res) => await send(res, async () => {
        res.set('Cache-Control', 'private, no-store');
        const db = req.app.locals.db;
        const me = await meOf(db, req.user);
        const p = await revokeScoped(db, req.params.principal, ownScope(me), me, now(), reasonOf((req.body || {}).reason));
        if (!p) return http.sendProblem(res, 404, 'registry.unknown_node', { detail: `no node principal ${req.params.principal}` });
        res.json(principalView(p));
    }));
    return router;
}

/** Every refusal of a node's credential, whatever the reason: one status, one body. */
const INVALID_CLIENT = Object.freeze({ status: 401, body: Object.freeze({ error: 'invalid_client', error_description: 'Invalid client credentials' }) });

/**
 * grant_type=client_credentials for a node principal (client_id nod_…): its current credential, or the previous one
 * while prev_valid_until is in the future, buys a 300 s token for openvibe.network (network.node.self.manage) or for
 * the service that paired it (no capability: that service authorises the node by its own binding). The secret is only
 * ever hashed and compared in constant time; it is never logged or returned. → { status, body } (OAuth shapes).
 */
async function issueNodeToken(db, { clientId, clientSecret, audience, privateKey, issuer, now = Date.now() }) {
    if (typeof clientId !== 'string' || !PRINCIPAL_ID.test(clientId) || typeof clientSecret !== 'string' || !clientSecret) return INVALID_CLIENT;
    const p = await db.prepare('SELECT * FROM platform_node_principals WHERE id = ?').get(clientId);
    const hash = sha256(clientSecret);
    // Both comparisons always run, so the answer's timing does not tell which secret (if any) matched.
    const current = sameHash(p && p.credential_hash, hash);
    const previous = sameHash(p && p.credential_prev_hash, hash);
    const prevLive = !!(p && p.prev_valid_until && Date.parse(p.prev_valid_until) > now);
    if (!p || p.status !== 'active' || !p.credential_hash || !(current || (previous && prevLive))) return INVALID_CLIENT;
    const aud = typeof audience === 'string' ? audience.trim() : '';
    if (aud !== SELF_AUDIENCE && !(p.paired_by_service && aud === `openvibe.${p.paired_by_service}`)) {
        return { status: 400, body: { error: 'invalid_scope', error_description: `a node token is for ${SELF_AUDIENCE}${p.paired_by_service ? ` or openvibe.${p.paired_by_service}` : ''}` } };
    }
    const iat = Math.floor(now / 1000);
    const claims = {
        iss: issuer, sub: `node:${p.id}`, actor_type: 'node', aud: [aud],
        cap: aud === SELF_AUDIENCE ? ['network.node.self.manage'] : [],
        ...(p.owner_kind === 'project' && p.project_id ? { project_id: p.project_id } : {}),
        iat, exp: iat + TOKEN_TTL_S, jti: `tok_${crypto.randomBytes(12).toString('hex')}`,
    };
    assertValid('identity.service-token-claims@1', claims);
    const access = serviceAuth.signServiceToken(claims, privateKey);
    // The health of a paired machine: written at most once a minute, so a busy machine is not a write per token.
    await db.prepare('UPDATE platform_node_principals SET last_seen_at = ? WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)')
        .run(iso(now), p.id, iso(now - SEEN_EVERY_MS));
    return { status: 200, body: { access_token: access, token_type: 'Bearer', expires_in: TOKEN_TTL_S, scope: claims.cap.join(' ') } };
}

const NODE_SUB = /^node:(nod_[0-9A-HJKMNP-TV-Z]{26})$/;

/**
 * The node principal a verified token speaks for, live. A token of any other actor (svc:, app:) is 403
 * capability.owner_denied whatever it holds; a node revoked since its token was issued (≤ 300 s ago) is 401.
 */
async function selfOf(db, req) {
    const m = NODE_SUB.exec(String(req.principal && req.principal.sub || ''));
    if (!m) throw new RegistryError(403, 'capability.owner_denied', 'only a node principal manages itself');
    const p = await db.prepare('SELECT * FROM platform_node_principals WHERE id = ?').get(m[1]);
    if (!p || p.status !== 'active') throw new RegistryError(401, 'registry.node_revoked', 'this node principal is revoked');
    return p;
}

/**
 * Store the capabilities the machine presents (platform.node-capabilities@1, verbatim). Its node_id must be the
 * machine's own. Throws RegistryError. → { node_id, reported_at }
 */
async function putCapabilities(db, p, body, now = Date.now()) {
    const v = validate('platform.node-capabilities@1', body);
    if (!v.valid) throw new RegistryError(400, 'registry.invalid_capabilities', v.errors.map((e) => `${e.path} ${e.message}`).join('; ').slice(0, 500));
    if (body.node_id !== p.node_id) throw new RegistryError(409, 'registry.node_mismatch', `this token is node ${p.node_id}, not ${String(body.node_id).slice(0, 80)}`);
    const at = iso(now);
    await db.prepare(`INSERT INTO platform_node_capabilities (node_id, doc, reported_at) VALUES (?, ?, ?)
        ON CONFLICT (node_id) DO UPDATE SET doc = excluded.doc, reported_at = excluded.reported_at`).run(p.node_id, JSON.stringify(body), at);
    return { node_id: p.node_id, reported_at: at };
}

/**
 * The machine rotates its own credential: a new one (returned this once), the old one valid PREV_GRACE_MS more so a
 * machine that crashes mid-rotation can still sign in. Throws RegistryError. → { principal, node_id, credential, prev_valid_until }
 */
async function rotateCredential(db, id, now = Date.now()) {
    const credential = crypto.randomBytes(32).toString('base64url');
    const at = iso(now);
    const until = iso(now + PREV_GRACE_MS);
    const row = await db.tx(async (t) => {
        const p = await t.prepare('SELECT * FROM platform_node_principals WHERE id = ? FOR UPDATE').get(id);
        if (!p || p.status !== 'active') return null;
        await t.prepare(`UPDATE platform_node_principals SET credential_prev_hash = credential_hash,
            prev_valid_until = CASE WHEN credential_hash IS NULL THEN NULL ELSE ? END, credential_hash = ?, updated_at = ?
            WHERE id = ? AND status = 'active'`).run(until, sha256(credential), at, id);
        return p;
    });
    if (!row) throw new RegistryError(401, 'registry.node_revoked', 'this node principal is revoked');
    return { principal: row.id, node_id: row.node_id, credential, prev_valid_until: row.credential_hash ? until : null };
}

// Mounted at /api/v1/node/self behind principals.guard('network.node.self.manage') (server/index.js). The guard checks
// the token's signature, audience and capability; ownership is selfOf's, before any write.
function selfRouter(now = () => Date.now()) {
    const router = express.Router();
    router.use(http.middleware());
    const send = async (res, fn) => {
        res.set('Cache-Control', 'no-store');
        try { return await fn(); } catch (e) {
            if (e instanceof RegistryError) return http.sendProblem(res, e.status, e.code, { detail: e.message });
            console.error('[Node self]', e.message);
            return http.sendProblem(res, 500, 'registry.failed', { detail: 'the node could not be changed' });
        }
    };
    router.put('/capabilities', express.json({ limit: '64kb' }), async (req, res) => await send(res, async () => {
        const db = req.app.locals.db;
        res.json(await putCapabilities(db, await selfOf(db, req), req.body, now()));
    }));
    router.post('/credential', async (req, res) => await send(res, async () => {
        const db = req.app.locals.db;
        res.json(await rotateCredential(db, (await selfOf(db, req)).id, now()));
    }));
    return router;
}

function routers({ guard, now = () => Date.now() }) {
    const problem = (res, e) => http.sendProblem(res, e.status, e.code, { detail: e.message });
    const internal = express.Router();
    internal.post('/node-pairings', guard, express.json({ limit: '8kb' }), async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try {
            res.status(201).json(await createPairing(req.app.locals.db, serviceOf(req), req.body || {}, now()));
        } catch (e) {
            if (e instanceof RegistryError) return problem(res, e);
            throw e;
        }
    });
    internal.get('/node-principals/:id', guard, async (req, res) => {
        res.set('Cache-Control', 'no-store');
        const p = await pairedBy(req.app.locals.db, req.params.id, serviceOf(req));
        if (!p) return http.sendProblem(res, 404, 'registry.unknown_node', { detail: `no node principal ${req.params.id}` });
        res.json(principalView(p));
    });
    internal.post('/node-principals/:id/revoke', guard, async (req, res) => {
        res.set('Cache-Control', 'no-store');
        let reason;
        try { reason = reasonOf((req.body || {}).reason); } catch (e) { return problem(res, e); }
        const p = await revoke(req.app.locals.db, req.params.id, serviceOf(req), now(), reason);
        if (!p) return http.sendProblem(res, 404, 'registry.unknown_node', { detail: `no node principal ${req.params.id}` });
        res.json(principalView(p));
    });

    // Mounted at /api/v1/node-pairing behind its own rate limit (server/index.js).
    const pairing = express.Router();
    pairing.post('/', express.json({ limit: '8kb' }), async (req, res) => {
        res.set('Cache-Control', 'no-store');
        let out;
        try {
            out = await redeem(req.app.locals.db, req.body, now());
        } catch (e) {
            if (e instanceof RegistryError) return problem(res, e);
            throw e;
        }
        const p = out.principal;
        res.status(201).json({
            principal: p.id, node_id: p.node_id, home_cell: p.home_cell, credential: out.credential,
            token_endpoint: `${req.app.locals.config.jwt.issuer}/oauth/token`,
            paired_for: { service: p.paired_by_service, ref: p.pairing_ref },
        });
    });
    return { internal, pairing };
}

module.exports = { CODE_TTL_MS, MAX_TRIES, PREV_GRACE_MS, OPERATOR_STATUS, createPairing, redeem, revoke, revokeOwnedBy, principalView, principalFilter, listPrincipals, setPrincipalStatus, routers, userRouter, issueNodeToken, selfRouter };
