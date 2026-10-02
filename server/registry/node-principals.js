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
 */
const crypto = require('crypto');
const express = require('express');
const { ids, http } = require('openvibe-contracts');
const { BOOTSTRAP_CELL, RegistryError } = require('./cells');

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_TRIES = 5;
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

/** A principal `service` paired, or null (another service's principal is indistinguishable from none). */
async function pairedBy(db, id, service) {
    if (!PRINCIPAL_ID.test(String(id))) return null;
    return await db.prepare('SELECT * FROM platform_node_principals WHERE id = ? AND paired_by_service = ?').get(String(id), service) || null;
}

/** Revoke a principal `service` paired; a second revoke changes nothing. → the row, or null. */
async function revoke(db, id, service, now = Date.now()) {
    if (!await pairedBy(db, id, service)) return null;
    const at = iso(now);
    await db.prepare(`UPDATE platform_node_principals SET status = 'revoked', revoked_at = ?, revoked_by = ?, credential_prev_hash = NULL,
        prev_valid_until = NULL, updated_at = ? WHERE id = ? AND paired_by_service = ? AND status <> 'revoked'`).run(at, `svc:${service}`, at, String(id), service);
    return pairedBy(db, id, service);
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
        const p = await revoke(req.app.locals.db, req.params.id, serviceOf(req), now());
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

module.exports = { CODE_TTL_MS, MAX_TRIES, createPairing, redeem, revoke, principalView, routers };
