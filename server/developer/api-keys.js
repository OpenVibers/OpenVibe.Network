'use strict';
/**
 * Developer API keys and per-project budgets (plan G-P3, ADR-014; Network stays the identity authority).
 *
 * A developer API key is a project-bound credential: a person mints it in a project, sees the secret
 * once, and uses it as a bearer credential against OpenVibe.AI. Only sha256(secret) is stored; the
 * secret is returned exactly once, never stored, never logged and never written to the audit.
 *
 *   people (project routes, Bearer user tokens; developer/routes.js)
 *     list      viewer+ and staff: metadata only, never the secret
 *     create    developer+ (admin+ for a live key): { name, app_id, scopes, environment }
 *     rotate    the same key id with a new secret, shown once; the old secret fails at once
 *     revoke    the key stops authenticating at once
 *
 *   services (POST /internal/api-keys/exchange, internal/routes.js)
 *     exchange  a service token (network.project.read) presents the key a caller sent and Network
 *               answers with the facts and a short-lived scoped token: the project's tenancy and the
 *               key's environment and scopes. A revoked or unknown key is refused at once.
 *
 * The key is bound to a project AND to one of that project's apps, so the token it exchanges for is
 * an ordinary app token (sub app:app_<ULID>, project_id, ns, env). Revoking the app revokes its keys
 * with it, and archiving the project does the same.
 *
 * Scopes are Network's own vocabulary (below), not capability ids: a key says what it may do, and
 * the exchange turns the scopes into the token's cap claim (the capability id of the scope) for the
 * audience the scope belongs to. A key may not exchange for an audience its scopes do not cover.
 *
 * The per-project monthly budget is an integer number of nano-USD (D1: 1e-9 USD, never a float),
 * kept as a decimal string so it is exact. NULL means the project set no ceiling. The owning
 * service (OpenVibe.AI) reads it with its service token (GET /internal/projects/:project_id/budget).
 */
const crypto = require('crypto');
const { ids, serviceAuth, assertValid, capabilities } = require('openvibe-contracts');
const store = require('./store');

const { DevError } = store;
const fail = (status, code, detail) => { throw new DevError(status, code, detail); };
const nowIso = () => new Date().toISOString();

const KEY_PREFIX = 'ovk_';
const KEY_ID_RE = /^key_[0-9A-HJKMNP-TV-Z]{26}$/;
const ENVIRONMENTS = ['live', 'test'];
/** The token environment a key's environment means (Network's sandbox/production). */
const ENV_TO_TOKEN_ENV = { live: 'production', test: 'sandbox' };
const TOKEN_TTL_S = 300;
const MAX_KEYS_PER_PROJECT = 50;

/**
 * The scope vocabulary. A scope names what a key may do; `capability` is the id that goes into the
 * token's cap claim and `audience` is the service that serves it.
 *
 * `ai.inference` is the OpenVibe.AI developer-inference scope (plan D8: the public capability
 * ai.app.run, the public capability developer apps already hold: ADR-014; D8'). The capability id is used even
 * when the installed contracts release is older and does not know it yet: the claim schema accepts
 * it, and the receiver that knows the capability is the one that acts on it.
 */
const SCOPES = Object.freeze({
    'ai.inference': Object.freeze({
        capability: 'ai.app.run',   // the public capability apps already call AI with (ADR-014; AI Exchange D8')
        audience: 'openvibe.ai',
        description: 'Call OpenVibe.AI inference (POST /v1/chat/completions, POST /v1/messages, GET /v1/models)',
    }),
});

const scopeIds = () => Object.keys(SCOPES).sort();

/** The feature is off unless NETWORK_DEV_API_KEYS=1 (server/config.js). */
function requireEnabled(config) {
    const on = !!(config && config.developer && config.developer.apiKeys);
    if (!on) fail(503, 'api_keys.disabled', 'developer API keys are off on this Network (NETWORK_DEV_API_KEYS)');
}

// ── The secret ───────────────────────────────────────────────

/** A new key: 32 random bytes, base64url, behind the ovk_ prefix. Only its hash is stored. */
function newKeySecret() {
    const secret = KEY_PREFIX + crypto.randomBytes(32).toString('base64url');
    return { secret, hash: crypto.createHash('sha256').update(secret).digest('hex'), hint: secret.slice(-4) };
}

const hashSecret = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function cleanName(v) {
    const s = String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, '').trim();
    if (!s || s.length > 80) fail(422, 'api_key.invalid', 'name must be 1-80 characters');
    return s;
}

function cleanEnvironment(v) {
    const e = String(v || 'test');
    if (!ENVIRONMENTS.includes(e)) fail(422, 'api_key.invalid', 'environment is live or test');
    return e;
}

/** The scopes a key may hold: a non-empty subset of the vocabulary, in a stable order. */
function cleanScopes(list) {
    if (!Array.isArray(list) || !list.length) fail(422, 'api_key.invalid', 'scopes must be a non-empty array');
    if (list.length > 10) fail(422, 'api_key.invalid', 'at most 10 scopes');
    const wanted = [...new Set(list.map(String))].sort();
    for (const id of wanted) {
        if (!SCOPES[id]) fail(422, 'api_key.unknown_scope', `unknown scope ${id}; known scopes: ${scopeIds().join(', ')}`);
    }
    return wanted;
}

// ── Views ────────────────────────────────────────────────────

function keyView(row) {
    return {
        id: row.id, name: row.name, project_id: row.project_id, app_id: row.app_id, hint: row.hint,
        scopes: JSON.parse(row.scopes || '[]'), environment: row.environment, status: row.status,
        created_at: row.created_at, rotated_at: row.rotated_at || null, revoked_at: row.revoked_at || null,
        last_used_at: row.last_used_at || null,
    };
}

async function loadKey(db, projectId, keyId) {
    const row = KEY_ID_RE.test(String(keyId)) ? await db.prepare('SELECT * FROM dev_api_keys WHERE id = ? AND project_id = ?').get(String(keyId), projectId) : null;
    if (!row) fail(404, 'api_key.not_found', 'no such key');
    return row;
}

// ── People: the key lifecycle ────────────────────────────────

/** Members (viewer+) and staff: the project's keys, metadata only. */
async function list(db, actor, projectId, { config } = {}) {
    requireEnabled(config);
    const { project } = await store.access(db, actor, projectId, { allowArchived: true });
    const rows = await db.prepare('SELECT * FROM dev_api_keys WHERE project_id = ? ORDER BY id DESC').all(project.id);
    return rows.map(keyView);
}

/**
 * Mint a key. The secret is in the answer of this call and nowhere else: only sha256(secret) is
 * stored. A live key needs an admin+ member and an app the project may run in production; a test key
 * needs a developer+ member and a sandbox app.
 */
async function create(db, actor, projectId, body, { ctx, config }) {
    requireEnabled(config);
    const { project } = await store.access(db, actor, projectId, { allowArchived: true });
    const environment = cleanEnvironment(body.environment);
    const manage = environment === 'live' ? 'admin' : 'developer';
    await store.access(db, actor, projectId, { need: manage, staffOk: false, allowArchived: true });
    const appId = String(body.app_id || '');
    const app = await store.loadApp(db, project.id, appId);
    if (app.revoked_at) fail(409, 'app.revoked', 'app is revoked');
    const appEnvironment = environment === 'live' ? 'production' : 'sandbox';
    if (app.environment !== appEnvironment) {
        fail(422, 'api_key.invalid', `a ${environment} key belongs to a ${appEnvironment} app; this app is ${app.environment}`);
    }
    const scopes = cleanScopes(body.scopes);
    const count = (await db.prepare('SELECT COUNT(*) AS n FROM dev_api_keys WHERE project_id = ?').get(project.id)).n;
    if (count >= MAX_KEYS_PER_PROJECT) fail(409, 'api_key.limit', `at most ${MAX_KEYS_PER_PROJECT} keys per project`);
    const id = `key_${ids.ulid()}`;
    const secret = newKeySecret();
    await db.tx(async () => {
        await db.prepare(`INSERT INTO dev_api_keys (id, project_id, app_id, name, key_hash, hint, scopes, environment, status, created_at, created_by)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`)
            .run(id, project.id, app.id, cleanName(body.name), secret.hash, secret.hint, JSON.stringify(scopes), environment, nowIso(), actor.label);
        await store.audit(db, { projectId: project.id, actor: actor.label, action: 'api_key.created', target: `key:${id}`,
            detail: { key_id: id, app_id: app.id, scopes, environment, hint: secret.hint }, ctx });
    });
    return { ...keyView(await db.prepare('SELECT * FROM dev_api_keys WHERE id = ?').get(id)), api_key: secret.secret, shown_once: true };
}

/**
 * Rotate: the same key id with a new secret, shown once. The old secret fails from that moment
 * (a key is a bearer credential in a request header, where an overlap would only widen the window).
 */
async function rotate(db, actor, projectId, keyId, { ctx, config }) {
    requireEnabled(config);
    const { project } = await store.access(db, actor, projectId, { need: 'viewer', staffOk: false, allowArchived: true });
    const row = await loadKey(db, project.id, keyId);
    if (row.status !== 'active') fail(409, 'api_key.revoked', 'key is revoked');
    const app = await db.prepare('SELECT * FROM dev_apps WHERE id = ?').get(row.app_id);
    await store.access(db, actor, projectId, { need: app && app.environment === 'production' ? 'admin' : 'developer', staffOk: false, allowArchived: true });
    const secret = newKeySecret();
    await db.tx(async () => {
        await db.prepare('UPDATE dev_api_keys SET key_hash = ?, hint = ?, rotated_at = ? WHERE id = ?').run(secret.hash, secret.hint, nowIso(), row.id);
        await store.audit(db, { projectId: project.id, actor: actor.label, action: 'api_key.rotated', target: `key:${row.id}`,
            detail: { key_id: row.id, app_id: row.app_id, scopes: JSON.parse(row.scopes || '[]'), environment: row.environment, hint: secret.hint }, ctx });
    });
    return { ...keyView(await db.prepare('SELECT * FROM dev_api_keys WHERE id = ?').get(row.id)), api_key: secret.secret, shown_once: true };
}

/** Revoke: the key stops authenticating at once. */
async function revoke(db, actor, projectId, keyId, { ctx, config }) {
    requireEnabled(config);
    const { project } = await store.access(db, actor, projectId, { need: 'viewer', staffOk: true, allowArchived: true });
    const row = await loadKey(db, project.id, keyId);
    if (row.status !== 'revoked') {
        await db.tx(async () => {
            await db.prepare('UPDATE dev_api_keys SET status = ?, revoked_at = ?, revoked_by = ? WHERE id = ?').run('revoked', nowIso(), actor.label, row.id);
            await store.audit(db, { projectId: project.id, actor: actor.label, action: 'api_key.revoked', target: `key:${row.id}`,
                detail: { key_id: row.id, app_id: row.app_id, scopes: JSON.parse(row.scopes || '[]'), environment: row.environment }, ctx });
        });
    }
    return keyView(await db.prepare('SELECT * FROM dev_api_keys WHERE id = ?').get(row.id));
}

/** Revoke every key of an app (its app is revoked). Called inside the app's transaction. */
async function revokeForApp(db, appId, { actor, reason, ctx }) {
    const rows = await db.prepare("SELECT * FROM dev_api_keys WHERE app_id = ? AND status = 'active'").all(appId);
    for (const row of rows) {
        await db.prepare('UPDATE dev_api_keys SET status = ?, revoked_at = ?, revoked_by = ? WHERE id = ?').run('revoked', nowIso(), actor, row.id);
        await store.audit(db, { projectId: row.project_id, actor, action: 'api_key.revoked', target: `key:${row.id}`,
            detail: { key_id: row.id, app_id: appId, scopes: JSON.parse(row.scopes || '[]'), environment: row.environment, reason: reason || null }, ctx });
    }
    return rows.length;
}

// ── Services: the exchange ───────────────────────────────────

/**
 * The key a caller presented, if it is live. The lookup is by hash: an unknown, revoked or
 * malformed key is the same 401, so a guess learns nothing.
 */
async function matchKey(db, presented) {
    const raw = String(presented || '');
    if (!raw.startsWith(KEY_PREFIX) || raw.length > 200) return null;
    const want = Buffer.from(hashSecret(raw), 'hex');
    const row = await db.prepare('SELECT * FROM dev_api_keys WHERE key_hash = ?').get(hashSecret(raw));
    if (!row || row.status !== 'active') return null;
    const stored = Buffer.from(row.key_hash, 'hex');
    if (stored.length !== want.length || !crypto.timingSafeEqual(stored, want)) return null;
    return row;
}

/** The audience a set of scopes covers. */
const audiencesOf = (scopes) => [...new Set(scopes.map(s => (SCOPES[s] || {}).audience).filter(Boolean))];

/**
 * The scopes the app may use: the key's scopes, narrowed by the app's APPROVED grants. Fail closed: a
 * scope whose capability the installed contracts release does not know, or that the app was not granted,
 * is dropped (a key never stands in for a grant).
 */
async function scopesForApp(db, appId, scopes) {
    const out = [];
    for (const scope of scopes) {
        const capability = (SCOPES[scope] || {}).capability;
        if (!capability || !capabilities.get(capability)) continue;
        const grant = await db.prepare("SELECT status FROM dev_grants WHERE app_id = ? AND capability = ?").get(appId, capability);
        if (!grant || grant.status !== 'approved') continue;
        out.push(scope);
    }
    return out;
}

/**
 * Exchange a presented key for the facts and a short-lived scoped token.
 *
 * - the key must be live (a revoked key is refused at once);
 * - the audience must be one the key's scopes cover (the scope is enforced here, by Network);
 * - the token is an app token of the key's app: sub app:app_<ULID>, project_id, ns, env
 *   (live -> production, test -> sandbox), cap = the capability ids of the key's scopes.
 *
 * The token is signed with Network's key, so the receiver verifies it offline exactly as it does an
 * app token today. Nothing here is ever logged: the key itself, its hash and the token stay out of
 * the logs, the audit carries ids and scopes only.
 */
async function exchange(db, presented, { audience, privateKey, issuer, ctx }) {
    const row = await matchKey(db, presented);
    if (!row) fail(401, 'api_key.invalid', 'unknown or revoked key');
    const scopes = JSON.parse(row.scopes || '[]');
    const aud = String(audience || '').trim();
    if (!aud) fail(400, 'api_key.invalid_audience', 'audience is required');
    // The scope is enforced here, by Network: the key may only be used at an audience its scopes cover.
    if (!audiencesOf(scopes).includes(aud)) fail(403, 'api_key.scope_denied', `this key may not be used at ${aud}`);
    const app = await db.prepare('SELECT * FROM dev_apps WHERE id = ?').get(row.app_id);
    if (!app || app.revoked_at) fail(401, 'api_key.invalid', 'the key\'s app is revoked');
    const project = await db.prepare('SELECT * FROM dev_projects WHERE id = ?').get(row.project_id);
    if (!project || project.archived_at) fail(401, 'api_key.invalid', 'the key\'s project is archived');
    // The key's scopes, narrowed by what the app holds (the narrowing bites once the installed
    // contracts release knows the scope's capability).
    const held = await scopesForApp(db, app.id, scopes);
    if (!held.length) fail(403, 'api_key.scope_denied', 'this key holds no scope the app may use');
    if (!audiencesOf(held).includes(aud)) fail(403, 'api_key.scope_denied', `this key may not be used at ${aud}`);
    const cap = held.map(s => SCOPES[s].capability).filter(Boolean);
    const now = Math.floor(Date.now() / 1000);
    const claims = {
        iss: issuer, sub: `app:${app.id}`, actor_type: 'app', aud: [aud], cap,
        ns: [project.id, `app.${project.id}.*`], project_id: project.id,
        env: ENV_TO_TOKEN_ENV[row.environment],
        iat: now, exp: now + TOKEN_TTL_S, jti: `tok_${crypto.randomBytes(12).toString('hex')}`,
    };
    assertValid('identity.service-token-claims@1', claims);
    const token = serviceAuth.signServiceToken(claims, privateKey);
    await db.prepare('UPDATE dev_api_keys SET last_used_at = ? WHERE id = ?').run(nowIso(), row.id);
    await store.audit(db, { projectId: project.id, actor: 'system:network', action: 'api_key.exchanged', target: `key:${row.id}`,
        detail: { key_id: row.id, app_id: app.id, audience: aud, scopes: held, environment: row.environment, jti: claims.jti, expires_at: new Date(claims.exp * 1000).toISOString() }, ctx });
    return {
        access_token: token, token_type: 'Bearer', expires_in: TOKEN_TTL_S,
        project_id: project.id, app_id: app.id, subject: claims.sub, environment: row.environment,
        token_env: claims.env, scopes: held, capability: cap, jti: claims.jti,
    };
}

// ── The per-project monthly budget ───────────────────────────

/** A budget is an integer number of nano-USD (D1), kept as a decimal string: never a float. */
function cleanBudget(v) {
    if (v === null || v === undefined || v === '') return null;
    const s = String(v).trim();
    if (!/^(0|[1-9][0-9]{0,24})$/.test(s)) fail(422, 'budget.invalid', 'monthly_budget_nano_usd is a whole number of nano-USD (a decimal string)');
    return s;
}

/** The project's budget as the API answers it. */
function budgetView(project) {
    return {
        project_id: project.id,
        monthly_budget_nano_usd: project.monthly_budget_nano_usd || null,
        currency: 'nano_usd',
        updated_at: project.budget_updated_at || null,
    };
}

/** Members (admin+) and staff: the project's monthly budget. */
async function readBudget(db, actor, projectId, { config } = {}) {
    requireEnabled(config);
    const { project } = await store.access(db, actor, projectId, { need: 'admin', allowArchived: true });
    return budgetView(project);
}

/** Set or clear the project's monthly budget (admin+ members and staff). */
async function writeBudget(db, actor, projectId, body, { ctx, config } = {}) {
    requireEnabled(config);
    const { project } = await store.access(db, actor, projectId, { need: 'admin', allowArchived: true });
    const value = cleanBudget(body ? body.monthly_budget_nano_usd : null);
    await db.tx(async () => {
        await db.prepare('UPDATE dev_projects SET monthly_budget_nano_usd = ?, budget_updated_at = ?, budget_updated_by = ? WHERE id = ?')
            .run(value, nowIso(), actor.label, project.id);
        await store.audit(db, { projectId: project.id, actor: actor.label, action: 'project.budget_set', target: project.id,
            detail: { from: project.monthly_budget_nano_usd || null, to: value, currency: 'nano_usd' }, ctx });
    });
    return budgetView(await db.prepare('SELECT * FROM dev_projects WHERE id = ?').get(project.id));
}

/** The budget as a service sees it (GET /internal/projects/:project_id/budget). */
async function internalBudget(db, projectId) {
    if (!store.PROJECT_ID_RE.test(String(projectId))) return null;
    const project = await db.prepare('SELECT * FROM dev_projects WHERE id = ?').get(String(projectId));
    return project ? budgetView(project) : null;
}

module.exports = {
    KEY_PREFIX, ENVIRONMENTS, ENV_TO_TOKEN_ENV, SCOPES, TOKEN_TTL_S, MAX_KEYS_PER_PROJECT,
    requireEnabled, scopeIds, keyView, list, create, rotate, revoke, revokeForApp,
    matchKey, exchange, audiencesOf,
    cleanBudget, budgetView, readBudget, writeBudget, internalBudget,
};
