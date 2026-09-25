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

const CHAT_NAMESPACES = ['chat.preferences', 'chat.tts_defaults', 'chat.dm_settings', 'chat.presence_prefs'];

// Initial grants: what each service does against Network today (docs/roadmap-baseline/04-cross-service.md).
const DEFAULT_GRANTS = [
    ['live', 'network.coins.credit', SELF_AUDIENCE, ['live']],
    ['live', 'network.coins.debit', SELF_AUDIENCE, ['live']],
    ['live', 'network.notifications.push', SELF_AUDIENCE, ['live']],
    // User modules: each service reads and writes the namespaces it owns (openvibe-contracts manifests/namespaces).
    // The chat.* namespaces are Chat's (chat.preferences since the Wave 6 cutover, chat.tts_defaults since
    // contracts 0.41.0). A service reading another's namespace sees only the fields `readers` lists for it.
    ['live', 'network.modules.read', SELF_AUDIENCE, ['live.profile', 'live.stats']],
    ['live', 'network.modules.write', SELF_AUDIENCE, ['live.profile', 'live.stats']],
    ['chat', 'network.modules.read', SELF_AUDIENCE, CHAT_NAMESPACES],
    ['chat', 'network.modules.write', SELF_AUDIENCE, CHAT_NAMESPACES],
    ['ai', 'network.modules.read', SELF_AUDIENCE, ['ai.preferences', 'ai.usage_summary']],
    ['ai', 'network.modules.write', SELF_AUDIENCE, ['ai.usage_summary']],
    ['community', 'network.modules.read', SELF_AUDIENCE, ['community.profile']],
    ['community', 'network.modules.write', SELF_AUDIENCE, ['community.profile']],
    ['wiki', 'network.modules.read', SELF_AUDIENCE, ['wiki.projects']],
    ['wiki', 'network.modules.write', SELF_AUDIENCE, ['wiki.projects']],
    ['tools', 'network.modules.read', SELF_AUDIENCE, ['tools.usage']],
    ['tools', 'network.modules.write', SELF_AUDIENCE, ['tools.usage']],
    ['games', 'network.modules.read', SELF_AUDIENCE, ['games.progress.summary']],
    ['games', 'network.modules.write', SELF_AUDIENCE, ['games.progress.summary']],
    // Wave 5: Community owns pastes. It resolves authors and uploads screenshot bytes to Media; Live writes
    // pastes into Community on behalf of its users and its AI jobs.
    ['community', 'identity.subject.resolve', SELF_AUDIENCE, []],
    ['community', 'media.object.upload', 'openvibe.media', ['community']],
    // Wave 11: Tools job results as Media objects; Wave 12: Games map-editor assets.
    ['tools', 'media.object.upload', 'openvibe.media', ['tools']],
    ['tools', 'media.object.read', 'openvibe.media', ['tools']],
    ['games', 'media.object.upload', 'openvibe.media', ['games']],
    ['games', 'identity.subject.resolve', SELF_AUDIENCE, []],
    // Games subscribes to network.user.token_valid_after (sign-out everywhere closes game sessions).
    ['games', 'events.subscription.manage', 'openvibe.events', []],
    // Media and Tools subscribe to network.user.token_valid_after too (their sign-in refuses older tokens).
    ['media', 'events.subscription.manage', 'openvibe.events', []],
    ['tools', 'events.subscription.manage', 'openvibe.events', []],
    // Wave 9: Tips starts purchases and transfers in Billing, follows settlement through Events, and
    // announces delivered tips in the creator's Live chat.
    ['tips', 'billing.intent.create', 'openvibe.billing', []],
    ['tips', 'billing.transfer.create', 'openvibe.billing', []],
    ['tips', 'events.subscription.manage', 'openvibe.events', []],
    ['tips', 'identity.subject.resolve', SELF_AUDIENCE, []],
    ['tips', 'live.tips_delivery.write', 'openvibe.live', []],
    ['live', 'tips.interaction.record', 'openvibe.tips', []],
    // Wave 7: Live manages its slots' streams, keys and sessions on OpenRe.Stream; OpenRe publishes
    // session/output events (Live consumes openre.session.* by webhook).
    ...['openre.stream.read', 'openre.stream.write', 'openre.key.rotate', 'openre.session.read'].map(c => ['live', c, 'openvibe.openre', []]),
    ['openre', 'events.event.publish', 'openvibe.events', []],
    // Wave 16: Wiki publishes events, attaches Community discussion, cites Sources items, reads its Media.
    ['wiki', 'events.event.publish', 'openvibe.events', []],
    ['wiki', 'community.comment.write', 'openvibe.community', []],
    ['wiki', 'community.comment.moderate', 'openvibe.community', []],
    ['wiki', 'sources.item.read', 'openvibe.sources', []],
    ['wiki', 'media.object.read', 'openvibe.media', ['wiki']],
    // Wave 16: Blog (same shape as Wiki; it may hide the thread of a post that stopped being public).
    ['blog', 'identity.subject.resolve', SELF_AUDIENCE, []],
    // The network changelog reads the GitHub token the owner configures (server/integrations/github.js).
    ['blog', 'network.integration.github.read', SELF_AUDIENCE, []],
    ['blog', 'events.event.publish', 'openvibe.events', []],
    ['blog', 'community.comment.write', 'openvibe.community', []],
    ['blog', 'community.comment.moderate', 'openvibe.community', []],
    ['blog', 'media.object.read', 'openvibe.media', ['blog']],
    // Wave 10: VIP sells plans through Billing and projects its entitlements from Billing events.
    ['vip', 'billing.intent.create', 'openvibe.billing', []],
    ['vip', 'billing.subscription.manage', 'openvibe.billing', []],
    ['vip', 'billing.entitlement.check', 'openvibe.billing', []],
    ['vip', 'events.event.publish', 'openvibe.events', []],
    ['vip', 'events.subscription.manage', 'openvibe.events', []],
    ['vip', 'identity.subject.resolve', SELF_AUDIENCE, []],
    // Wave 17: Reviews reads Sources review items (and follows them by event), links Community discussion.
    ['reviews', 'sources.item.read', 'openvibe.sources', []],
    ['reviews', 'sources.source.read', 'openvibe.sources', []],
    ['reviews', 'events.event.publish', 'openvibe.events', []],
    ['reviews', 'events.subscription.manage', 'openvibe.events', []],
    ['reviews', 'community.comment.write', 'openvibe.community', []],
    // Wave 17: News reads Sources news items (and follows them and fetch failures by event).
    ['news', 'sources.item.read', 'openvibe.sources', []],
    ['news', 'sources.source.read', 'openvibe.sources', []],
    ['news', 'events.event.publish', 'openvibe.events', []],
    ['news', 'events.subscription.manage', 'openvibe.events', []],
    ['news', 'identity.subject.resolve', SELF_AUDIENCE, []],
    ['news', 'community.comment.write', 'openvibe.community', []],
    ['news', 'community.comment.moderate', 'openvibe.community', []],
    ['news', 'ai.run.create', 'openvibe.ai', ['news.*']],
    ['news', 'ai.run.read', 'openvibe.ai', ['news.*']],
    // Blog's "Draft with AI" (blog.draft_post; Blog server/domain/ai-drafts.js, 2026-09-24).
    ['blog', 'ai.run.create', 'openvibe.ai', ['blog.*']],
    ['blog', 'ai.run.read', 'openvibe.ai', ['blog.*']],
    // Wave 19: Trade (informational) reads Sources filings and publishes events.
    ['trade', 'events.event.publish', 'openvibe.events', []],
    ['trade', 'sources.item.read', 'openvibe.sources', []],
    ['trade', 'sources.source.read', 'openvibe.sources', []],
    // Wave 18: Deals and Coupons; Wave 21 Stage B: the Host API publishes deploy/domain events.
    ['deals', 'identity.subject.resolve', SELF_AUDIENCE, []],
    ['deals', 'events.event.publish', 'openvibe.events', []],
    ['deals', 'events.subscription.manage', 'openvibe.events', []],
    ['deals', 'sources.item.read', 'openvibe.sources', []],
    ['deals', 'community.comment.write', 'openvibe.community', []],
    ['deals', 'community.comment.moderate', 'openvibe.community', []],
    ['coupons', 'events.event.publish', 'openvibe.events', []],
    ['coupons', 'sources.item.read', 'openvibe.sources', []],
    ['host', 'events.event.publish', 'openvibe.events', []],
    // Wave 20: the Codes portal relays its release events.
    ['codes', 'events.event.publish', 'openvibe.events', []],
    ['ai', 'events.event.publish', 'openvibe.events', []],          // ai.run.* (AI server/events.js, 2026-09-24)
    // Wave 13: Live's AI features run as OpenVibe.AI workflows (AI_SERVICE=remote in live.env).
    // Live runs its own live.* workflows and, as the footer-copy fallback, network.site_copy
    // (OpenVibe.AI fails closed on a token with no ns).
    ['live', 'ai.run.create', 'openvibe.ai', ['live.*', 'network.site_copy']],
    ['live', 'ai.run.read', 'openvibe.ai', ['live.*', 'network.site_copy']],
    // Wave 3: producers publish to OpenVibe.Events (their own source only, enforced by Events).
    ...['live', 'media', 'network', 'community', 'billing', 'chat', 'tools', 'games', 'search', 'sources', 'tips'].map(c => [c, 'events.event.publish', 'openvibe.events', []]),
    // Wave 14: Search subscribes to <owner>.index_document.* deliveries.
    ['search', 'events.subscription.manage', 'openvibe.events', []],
    ['live', 'events.subscription.manage', 'openvibe.events', []],
    ['live', 'events.event.read', 'openvibe.events', []],
    // VIP gates in products: Chat's subscriber badge, Community's and Blog's members-only content, Live's own checks.
    ['chat', 'vip.entitlement.check', 'openvibe.vip', []],
    ['community', 'vip.resource.policy.evaluate', 'openvibe.vip', []],
    ['blog', 'vip.resource.policy.evaluate', 'openvibe.vip', []],
    ['live', 'vip.entitlement.check', 'openvibe.vip', []],
    ['community', 'events.subscription.manage', 'openvibe.events', []],
    ['community', 'events.event.read', 'openvibe.events', []],
    ['community', 'events.event.publish', 'openvibe.events', []],   // community.* events (Community server/events.js, 2026-09-24)
    ['billing', 'identity.subject.resolve', SELF_AUDIENCE, []],
    ['chat', 'identity.subject.resolve', SELF_AUDIENCE, []],
    ['live', 'identity.subject.resolve', SELF_AUDIENCE, []],
    // Media records each object's owner as a canonical subject (roadmap D01/D20): it resolves the app-local
    // owner ids it is given (X-OV-User-Id) through resolve-batch, in its backfill and its reconcile job.
    ['media', 'identity.subject.resolve', SELF_AUDIENCE, []],
    ['live', 'community.paste.create', 'openvibe.community', []],
    ['live', 'community.paste.write', 'openvibe.community', []],
    ['live', 'community.paste.moderate', 'openvibe.community', []],
    // One canonical channel/owner resolver (roadmap §10.5/§15.10, D20-R1): OpenRe, Media and Community (Pulse)
    // resolve channels, streams, VODs and clips through Live's /internal/lineage/resolve instead of their own
    // channel mappings.
    ...['openre', 'media', 'community'].map(c => [c, 'live.lineage.resolve', 'openvibe.live', []]),
    // Wave 5 remainder: Live comments on its own entities, publishes stream/VOD items to Pulse, and
    // hides a thread when it takes the entity down.
    ['live', 'community.comment.write', 'openvibe.community', []],
    ['live', 'community.comment.moderate', 'openvibe.community', []],
    ['live', 'community.pulse.write', 'openvibe.community', []],
    // Wave 6: OpenVibe.Chat reads Live's chat context, asks Live for effects and mirrors chat rows
    // back; Live bridges its remaining chat writers to Chat and reads presence.
    ['chat', 'live.chat_context.read', 'openvibe.live', []],
    ['chat', 'live.chat_effects.write', 'openvibe.live', []],
    ['chat', 'live.chat_mirror.write', 'openvibe.live', []],
    // Chat consumes live.release.deployed (the deploy card, register C-84) and network.module.updated
    // (its chat.preferences cache) through its own Events subscriptions, created at Chat's boot.
    ['chat', 'events.subscription.manage', 'openvibe.events', []],
    ['live', 'chat.live_bridge.write', 'openvibe.chat', []],
    ['live', 'chat.presence.read', 'openvibe.chat', []],
    ['live', 'chat.message.send', 'openvibe.chat', []],
    // Wave 8: Live as a Billing client (used only with BILLING_AUTHORITY=billing). Never cashout.manage
    // or ledger.admin: approving payouts is a separately controlled capability (ADR-012 rule 10).
    ...['billing.intent.create', 'billing.transfer.create', 'billing.balance.read', 'billing.cashout.request',
        'billing.subscription.manage', 'billing.entitlement.check'].map(c => ['live', c, 'openvibe.billing', []]),
    // Tools platform S9: products call the Tools run API (the kiosk's page titles, Chat's audio conversion,
    // Community's save-as-paste) with their own token, on the service tier instead of the anonymous one.
    ...['live', 'chat', 'community'].flatMap(c => ['tools.tool.run', 'tools.job.read'].map(cap => [c, cap, 'openvibe.tools', []])),
    // Tools indexes its own tool pages in Search through the owner API (owner tools only).
    ['tools', 'search.document.write', 'openvibe.search', []],
];

// Grants withdrawn by decision; applied at every boot so an old default can't come back.
const REVOKED_GRANTS = [['live', 'network.coins.transfer', SELF_AUDIENCE]];

// Default grants whose namespaces changed: a row still exactly as the old default seeded it is moved to
// the new list at boot, in this order (a row someone edited is left alone). Live's write grant lost
// chat.preferences when the namespace moved to Chat (Wave 6), then chat.tts_defaults (contracts 0.41.0).
const CHANGED_DEFAULT_NAMESPACES = [
    ['live', 'network.modules.write', SELF_AUDIENCE, ['chat.preferences', 'chat.tts_defaults', 'live.profile'], ['chat.tts_defaults', 'live.profile']],
    ['live', 'network.modules.write', SELF_AUDIENCE, ['chat.tts_defaults', 'live.profile'], ['live.profile', 'live.stats']],
    ['live', 'network.modules.read', SELF_AUDIENCE, ['chat.preferences', 'chat.tts_defaults', 'live.profile'], ['live.profile', 'live.stats']],
    ['chat', 'network.modules.read', SELF_AUDIENCE, ['chat.preferences'], CHAT_NAMESPACES],
    ['chat', 'network.modules.write', SELF_AUDIENCE, ['chat.preferences'], CHAT_NAMESPACES],
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
    // ADR-012 rule 5: loyalty is not transferable between people, so nobody holds the transfer grant.
    for (const [client, cap, aud] of REVOKED_GRANTS) {
        db.prepare("UPDATE principal_grants SET revoked_at = CURRENT_TIMESTAMP WHERE client_id = ? AND capability = ? AND audience = ? AND revoked_at IS NULL").run(client, cap, aud);
    }
    for (const [client, cap, aud, was, now] of CHANGED_DEFAULT_NAMESPACES) {
        db.prepare("UPDATE principal_grants SET namespaces = ? WHERE client_id = ? AND capability = ? AND audience = ? AND granted_by = 'default' AND namespaces = ?")
            .run(JSON.stringify(now), client, cap, aud, JSON.stringify(was));
    }
    const seed = db.prepare("INSERT OR IGNORE INTO principal_grants (client_id, capability, audience, namespaces, granted_by) VALUES (?, ?, ?, ?, 'default')");
    // A default grant that later gained namespaces fills them in on a row still seeded without any
    // (INSERT OR IGNORE alone would leave it at []); a row someone edited is left alone.
    const fillNs = db.prepare("UPDATE principal_grants SET namespaces = ? WHERE client_id = ? AND capability = ? AND audience = ? AND granted_by = 'default' AND namespaces = '[]'");
    for (const [client, cap, aud, ns] of DEFAULT_GRANTS) {
        if (!db.prepare('SELECT 1 FROM oauth_clients WHERE client_id = ?').get(client)) continue;
        seed.run(client, cap, aud, JSON.stringify(ns));
        if (ns.length) fillNs.run(JSON.stringify(ns), client, cap, aud);
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
        const bearer = String(req.headers.authorization || '').startsWith('Bearer ');
        const auth = bearer ? 'service-token' : req.internalKeyOk ? 'internal-key' : 'none';
        const who = principal ? (principal.legacy ? 'legacy-key' : principal.sub) : (auth === 'internal-key' ? 'legacy-key' : 'unknown');
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
                onDecision: (d) => { if (!d.allowed) { record(d); require('../observability').principalDenied(d); } },
            });
        }
        check(req, res, () => {
            const principal = req.principal;
            // Developer sandbox tokens (env: sandbox) are refused unless Network opted in as an audience
            // (DEV_SANDBOX_AUDIENCES); the signature was verified by check() above.
            if (principal && !principal.legacy) {
                const devPolicy = require('../developer/policy');
                const claims = devPolicy.unverifiedClaims(String(req.headers.authorization || '').slice(7).trim());
                const env = devPolicy.environmentDecision(claims, { acceptSandbox: devPolicy.settings(req.app.locals.config).sandboxAudiences.has(SELF_AUDIENCE) });
                if (!env.ok) {
                    record({ req, capability, principal, allowed: false, code: env.code });
                    require('../observability').principalDenied({ req, code: env.code });
                    return http.sendProblem(res, 401, env.code, { detail: env.reason, ctx: req.ov });
                }
            }
            if (ownApp && principal && !principal.legacy) {
                const app = ownApp(req);
                const self = String(principal.sub).replace(/^svc:/, '');
                if (app !== undefined && app !== self) {
                    record({ req, capability, principal, allowed: false, code: 'capability.owner_denied' });
                    require('../observability').principalDenied({ req, code: 'capability.owner_denied' });
                    return http.sendProblem(res, 403, 'capability.owner_denied', { detail: `${principal.sub} may only act for app_id '${self}'` });
                }
            }
            record({ req, capability, principal, allowed: true, code: null });
            next();
        });
    };
}

module.exports = { ensureSchema, issueToken, guard, grantsFor, recordDecision, DEFAULT_GRANTS, TOKEN_TTL_S, SELF_AUDIENCE };
