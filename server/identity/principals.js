'use strict';
/**
 * Service principals (roadmap Wave 1, ADR-003; contract identity.service-token-claims@1).
 *
 * A first-party service authenticates to /oauth/token with grant_type=client_credentials and the
 * OAuth client id/secret it already has, and receives a 5-minute RS256 token whose `cap` claim is
 * exactly what principal_grants allows it for the requested audience. Receivers check the one
 * capability each route performs (openvibe-contracts serviceAuth.requireCapability).
 *
 * The shared X-Internal-Key keeps working in parallel. principal_usage counts, per caller and route,
 * how each request authenticated, so the key can be retired once legacy use reaches zero.
 */
const crypto = require('crypto');
const { serviceAuth, capabilities, assertValid, http } = require('openvibe-contracts');

const TOKEN_TTL_S = 300;
const SELF_AUDIENCE = 'openvibe.network';

// Initial grants: what each service does against Network today (docs/roadmap-baseline/04-cross-service.md).
const DEFAULT_GRANTS = [
    ['live', 'network.coins.credit', SELF_AUDIENCE, ['live']],
    ['live', 'network.coins.debit', SELF_AUDIENCE, ['live']],
    ['live', 'network.coins.transfer', SELF_AUDIENCE, ['live']],
    ['live', 'network.notifications.push', SELF_AUDIENCE, ['live']],
    // User modules: each service reads and writes the namespaces it owns (openvibe-contracts manifests/namespaces).
    ['live', 'network.modules.read', SELF_AUDIENCE, ['chat.preferences', 'chat.tts_defaults', 'live.profile']],
    ['live', 'network.modules.write', SELF_AUDIENCE, ['chat.preferences', 'chat.tts_defaults', 'live.profile']],
    ['tools', 'network.modules.read', SELF_AUDIENCE, ['tools.usage']],
    ['tools', 'network.modules.write', SELF_AUDIENCE, ['tools.usage']],
    ['games', 'network.modules.read', SELF_AUDIENCE, ['games.progress.summary']],
    ['games', 'network.modules.write', SELF_AUDIENCE, ['games.progress.summary']],
];

function ensureSchema(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS principal_grants (
            client_id  TEXT NOT NULL,
            capability TEXT NOT NULL,
            audience   TEXT NOT NULL,
            namespaces TEXT NOT NULL DEFAULT '[]',
            granted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            granted_by TEXT,
            revoked_at DATETIME,
            PRIMARY KEY (client_id, capability, audience)
        );
        CREATE TABLE IF NOT EXISTS principal_usage (
            principal  TEXT NOT NULL,
            route      TEXT NOT NULL,
            capability TEXT NOT NULL,
            auth       TEXT NOT NULL,
            allowed    INTEGER NOT NULL,
            code       TEXT NOT NULL DEFAULT '',
            count      INTEGER NOT NULL DEFAULT 0,
            first_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (principal, route, auth, allowed, code)
        );
    `);
    const seed = db.prepare("INSERT OR IGNORE INTO principal_grants (client_id, capability, audience, namespaces, granted_by) VALUES (?, ?, ?, ?, 'default')");
    for (const [client, cap, aud, ns] of DEFAULT_GRANTS) {
        if (db.prepare('SELECT 1 FROM oauth_clients WHERE client_id = ?').get(client)) seed.run(client, cap, aud, JSON.stringify(ns));
    }
}

function grantsFor(db, clientId, audience) {
    return db.prepare('SELECT capability, namespaces FROM principal_grants WHERE client_id = ? AND audience = ? AND revoked_at IS NULL ORDER BY capability')
        .all(clientId, audience).map(r => ({ capability: r.capability, namespaces: JSON.parse(r.namespaces || '[]') }));
}

function sameSecret(a, b) {
    const x = Buffer.from(String(a || ''));
    const y = Buffer.from(String(b || ''));
    return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

/**
 * grant_type=client_credentials. Returns { status, body } (OAuth error shapes on failure).
 * `scope` (space-separated capability ids) narrows the token; omitted = every grant for the audience.
 */
function issueToken(db, { clientId, clientSecret, audience, scope, privateKey, issuer }) {
    const client = db.prepare('SELECT client_id, client_secret FROM oauth_clients WHERE client_id = ?').get(String(clientId || ''));
    if (!client || !sameSecret(client.client_secret, clientSecret)) return { status: 401, body: { error: 'invalid_client', error_description: 'Invalid client credentials' } };
    if (!/^[a-z][a-z0-9-]{1,39}$/.test(client.client_id)) return { status: 400, body: { error: 'unauthorized_client', error_description: 'client id is not a service principal' } };
    const aud = String(audience || '').trim();
    if (!aud) return { status: 400, body: { error: 'invalid_request', error_description: 'audience is required' } };
    const grants = grantsFor(db, client.client_id, aud);
    const wanted = scope ? String(scope).split(/\s+/).filter(Boolean) : null;
    const chosen = wanted ? grants.filter(g => wanted.includes(g.capability)) : grants;
    if (wanted && wanted.some(w => !chosen.find(g => g.capability === w))) {
        return { status: 400, body: { error: 'invalid_scope', error_description: `not granted: ${wanted.filter(w => !chosen.find(g => g.capability === w)).join(' ')}` } };
    }
    if (!chosen.length) return { status: 400, body: { error: 'invalid_scope', error_description: `no grants for audience ${aud}` } };
    const now = Math.floor(Date.now() / 1000);
    const claims = {
        iss: issuer, sub: `svc:${client.client_id}`, actor_type: 'service', aud: [aud],
        cap: chosen.map(g => g.capability),
        ns: [...new Set(chosen.flatMap(g => g.namespaces))],
        iat: now, exp: now + TOKEN_TTL_S, jti: `tok_${crypto.randomBytes(12).toString('hex')}`,
    };
    assertValid('identity.service-token-claims@1', claims);
    return { status: 200, body: { access_token: serviceAuth.signServiceToken(claims, privateKey), token_type: 'Bearer', expires_in: TOKEN_TTL_S, scope: claims.cap.join(' ') } };
}

/** Audit hook for requireCapability: one counter row per (principal, route, auth, outcome). */
function recordDecision(db) {
    const up = db.prepare(`INSERT INTO principal_usage (principal, route, capability, auth, allowed, code, count) VALUES (?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT(principal, route, auth, allowed, code) DO UPDATE SET count = count + 1, last_at = CURRENT_TIMESTAMP`);
    return ({ req, capability, principal, allowed, code }) => {
        const who = principal ? (principal.legacy ? 'legacy-key' : principal.sub) : 'unknown';
        const auth = principal && principal.legacy ? 'internal-key' : 'service-token';
        try { up.run(who, `${req.method} ${req.baseUrl || ''}${req.route ? req.route.path : req.path}`, capability, auth, allowed ? 1 : 0, code || ''); } catch { /* best effort */ }
    };
}

/**
 * Guard for a Network internal route. `ownApp(req)` returns the app id the request acts for; a
 * service token may only act for its own app (svc:live -> app_id 'live'). Legacy-key callers are
 * unchanged.
 */
function guard(capability, { ownApp, namespace, legacy = true } = {}) {
    if (!capabilities.get(capability)) throw new Error(`unknown capability ${capability}`);
    let check = null;
    let record = null;
    return function principalGuard(req, res, next) {
        if (!check) {
            record = recordDecision(req.app.locals.db);
            check = serviceAuth.requireCapability(capability, {
                getPublicKey: (r) => r.app.locals.publicKey,
                issuer: req.app.locals.config.jwt && req.app.locals.config.jwt.issuer,
                audience: SELF_AUDIENCE,
                // New routes can refuse the shared key outright (legacy: false) so its use never grows.
                legacy: legacy ? (r) => r.internalKeyOk === true : undefined,
                namespace,
                // Denials are final here; an allow is recorded below, after the ownership check.
                onDecision: (d) => { if (!d.allowed) record(d); },
            });
        }
        check(req, res, () => {
            const principal = req.principal;
            if (ownApp && principal && !principal.legacy) {
                const app = ownApp(req);
                const self = String(principal.sub).replace(/^svc:/, '');
                if (app !== undefined && app !== self) {
                    record({ req, capability, principal, allowed: false, code: 'capability.owner_denied' });
                    return http.sendProblem(res, 403, 'capability.owner_denied', { detail: `${principal.sub} may only act for app_id '${self}'` });
                }
            }
            record({ req, capability, principal, allowed: true, code: null });
            next();
        });
    };
}

module.exports = { ensureSchema, issueToken, guard, grantsFor, recordDecision, DEFAULT_GRANTS, TOKEN_TTL_S, SELF_AUDIENCE };
