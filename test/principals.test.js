'use strict';
// Service principals (server/identity/principals.js): client_credentials tokens, capability guards on
// /internal routes, the refusal of the retired shared key and the usage audit. Roadmap Wave 1, ADR-003.
//   node test/principals.test.js
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { serviceAuth, validate } = require('openvibe-contracts');
const { getDb } = require('../server/db/database');

(async () => {
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-principals-'));
const log = console.log; console.log = () => {};
const db = getDb();
console.log = log;
const spaceClient = await db.prepare("SELECT name, redirect_uris, is_first_party FROM oauth_clients WHERE client_id = 'space'").get();
assert.strictEqual(spaceClient.name, 'OpenVibe.Space');
assert.strictEqual(spaceClient.is_first_party, 1);
assert.ok(JSON.parse(spaceClient.redirect_uris).includes('https://openvibe.space/auth/callback'));
assert.ok(JSON.parse(spaceClient.redirect_uris).includes('http://localhost:4940/auth/callback'));

await db.prepare("UPDATE oauth_clients SET client_secret = 'live-secret' WHERE client_id = 'live'").run();
await db.prepare("UPDATE oauth_clients SET client_secret = 'media-secret' WHERE client_id = 'media'").run();
// The `search` client is created with server/setup/service-principal.js, not seeded with the signed-in products.
await db.prepare("INSERT INTO oauth_clients (client_id, client_secret, name, redirect_uris, is_first_party) VALUES ('search', 'search-secret', 'OpenVibe.Search', '[]', 1) ON CONFLICT DO NOTHING").run();
// Events is created the same way (setup/service-principal.js); it is a usage producer with its own token.
await db.prepare("INSERT INTO oauth_clients (client_id, client_secret, name, redirect_uris, is_first_party) VALUES ('events', 'events-secret', 'OpenVibe.Events', '[]', 1) ON CONFLICT DO NOTHING").run();
await db.prepare("UPDATE oauth_clients SET client_secret = 'ai-secret' WHERE client_id = 'ai'").run();
await db.prepare("UPDATE oauth_clients SET client_secret = 'bot-secret' WHERE client_id = 'bot'").run();
await db.prepare("UPDATE oauth_clients SET client_secret = 'tips-secret' WHERE client_id = 'tips'").run();
await db.prepare("INSERT INTO users (id, username, password_hash) VALUES (7, 'payee', 'x'), (8, 'payer', 'x')").run();
// A database seeded before media.analyze (Live's AI grants as the old default) is moved at the next boot.
await db.prepare("UPDATE principal_grants SET namespaces = ? WHERE client_id = 'live' AND audience = 'openvibe.ai'").run(JSON.stringify(['live.*', 'network.site_copy']));
await require('../server/identity/principals').ensureSchema(db);

const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const ISSUER = 'https://openvibe.network';
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.locals.db = db;
app.locals.config = { jwt: { issuer: ISSUER, accessTokenExpiry: '1h' } };
app.locals.privateKey = keys.privateKey;
app.locals.publicKey = keys.publicKey;
app.use('/oauth', require('../server/auth/oauth-routes'));
app.use('/internal', require('../server/internal/routes'));
const server = http.createServer(app);

(async () => {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const token = (form) => fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', ...form }) })
        .then(async r => ({ status: r.status, cache: r.headers.get('cache-control'), body: await r.json() }));
    const post = (p, body, headers) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
        .then(async r => ({ status: r.status, type: r.headers.get('content-type') || '', body: await r.json() }));
    const credit = (extra = {}) => ({ user_id: 7, app_id: 'live', amount: 5, reason: 'test', idempotency_key: `k-${crypto.randomBytes(4).toString('hex')}`, ...extra });

    // ── Issuing ──
    let t = await token({ client_id: 'live', client_secret: 'live-secret', audience: 'openvibe.network' });
    assert.strictEqual(t.status, 200, JSON.stringify(t.body));
    assert.strictEqual(t.cache, 'no-store');
    const claims = serviceAuth.verifyServiceToken(t.body.access_token, { publicKey: keys.publicKey, issuer: ISSUER, audience: 'openvibe.network' });
    assert.ok(claims.ok, claims.reason);
    assert.strictEqual(claims.claims.sub, 'svc:live');
    assert.deepStrictEqual(claims.claims.cap, ['identity.subject.resolve', 'network.account.deletion.confirm', 'network.account.export.contribute', 'network.analytics.creator.read', 'network.avatar.write', 'network.coins.credit', 'network.coins.debit', 'network.coins.read', 'network.follows.read', 'network.follows.write', 'network.modules.read', 'network.modules.write', 'network.notifications.push', 'network.registry.read']);
    assert.ok(validate('identity.service-token-claims@1', claims.claims).valid);
    assert.ok(claims.claims.exp - claims.claims.iat <= 300, 'short-lived');
    const full = t.body.access_token;
    // Live's OpenVibe.AI token: its own workflows, the footer copy and media.analyze (WS-O task 5), nothing else.
    t = await token({ client_id: 'live', client_secret: 'live-secret', audience: 'openvibe.ai' });
    const aiClaims = serviceAuth.verifyServiceToken(t.body.access_token, { publicKey: keys.publicKey, issuer: ISSUER, audience: 'openvibe.ai' });
    assert.ok(aiClaims.ok, aiClaims.reason);
    assert.deepStrictEqual([aiClaims.claims.cap, aiClaims.claims.ns], [['ai.credential.manage', 'ai.quota.attribution.manage', 'ai.run.create', 'ai.run.read'], ['live.*', 'network.site_copy', 'media.analyze']]);

    // Plan T9: Search's saved-search notifier resolves the saved search's owner and pushes one notification
    // per new match through Network, and holds nothing else there.
    t = await token({ client_id: 'search', client_secret: 'search-secret', audience: 'openvibe.network' });
    assert.strictEqual(t.status, 200, JSON.stringify(t.body));
    assert.deepStrictEqual(t.body.scope.split(' '), ['identity.subject.resolve', 'network.notifications.push']);
    const searchToken = t.body.access_token;

    t = await token({ client_id: 'live', client_secret: 'wrong', audience: 'openvibe.network' });
    assert.strictEqual(t.status, 401); assert.strictEqual(t.body.error, 'invalid_client');
    t = await token({ client_id: 'live', client_secret: 'live-secret' });
    assert.strictEqual(t.status, 400, 'audience required');
    t = await token({ client_id: 'live', client_secret: 'live-secret', audience: 'openvibe.network', scope: 'network.coins.credit' });
    assert.strictEqual(t.status, 200); assert.strictEqual(t.body.scope, 'network.coins.credit', 'scope narrows the token');
    const creditOnly = t.body.access_token;
    t = await token({ client_id: 'live', client_secret: 'live-secret', audience: 'openvibe.network', scope: 'network.coins.credit network.coins.mint' });
    assert.strictEqual(t.status, 400); assert.strictEqual(t.body.error, 'invalid_scope', 'asking for an ungranted capability fails');
    await db.prepare("UPDATE oauth_clients SET client_secret = 'openre-secret' WHERE client_id = 'openre'").run();
    t = await token({ client_id: 'openre', client_secret: 'openre-secret', audience: 'openvibe.network' });
    assert.strictEqual(t.status, 400); assert.strictEqual(t.body.error, 'invalid_scope', 'a client with no grants gets no token');
    // The canonical channel/owner resolver on Live (D20-R1): OpenRestream, Media and Community hold it, nobody else.
    await db.prepare("UPDATE oauth_clients SET client_secret = 'community-secret' WHERE client_id = 'community'").run();
    for (const [client, secret] of [['openre', 'openre-secret'], ['media', 'media-secret'], ['community', 'community-secret']]) {
        t = await token({ client_id: client, client_secret: secret, audience: 'openvibe.live' });
        assert.strictEqual(t.status, 200, `${client}: ${JSON.stringify(t.body)}`);
        assert.ok(t.body.scope.split(' ').includes('live.lineage.resolve'), `${client} may resolve lineage on Live`);
        const c = serviceAuth.verifyServiceToken(t.body.access_token, { publicKey: keys.publicKey, issuer: ISSUER, audience: 'openvibe.live' });
        assert.ok(c.ok && c.claims.sub === `svc:${client}` && c.claims.aud.includes('openvibe.live'));
    }
    t = await token({ client_id: 'live', client_secret: 'live-secret', audience: 'openvibe.live', scope: 'live.lineage.resolve' });
    assert.strictEqual(t.status, 400, 'Live does not grant itself its own resolver');
    const holders = (await db.prepare("SELECT client_id FROM principal_grants WHERE capability = 'live.lineage.resolve' AND audience = 'openvibe.live' AND revoked_at IS NULL ORDER BY client_id").all()).map(x => x.client_id);
    assert.deepStrictEqual(holders, ['community', 'media', 'openre']);
    // OpenVibe Live on by default (contracts 0.126.0): only OpenRestream binds Live slots to its streams.
    const binders = (await db.prepare("SELECT client_id FROM principal_grants WHERE capability = 'live.openre.slot.bind' AND audience = 'openvibe.live' AND revoked_at IS NULL ORDER BY client_id").all()).map(x => x.client_id);
    assert.deepStrictEqual(binders, ['openre']);
    t = await token({ client_id: 'media', client_secret: 'media-secret', audience: 'openvibe.network' });
    assert.strictEqual(t.status, 200, JSON.stringify(t.body));
    assert.strictEqual(t.body.scope, 'identity.subject.resolve network.account.deletion.confirm network.account.export.contribute', 'Media resolves object owners to subjects and takes part in account export and deletion (ADR-033), nothing else here');
    const mediaResolve = t.body.access_token;
    t = await token({ client_id: 'live', client_secret: 'live-secret', audience: 'openvibe.media' });
    assert.strictEqual(t.status, 200, JSON.stringify(t.body));
    assert.deepStrictEqual(t.body.scope.split(' ').sort(), ['media.object.delete', 'media.object.list', 'media.object.read', 'media.object.upload'], 'plan T4: Live reaches Media with its own token, nothing more');
    t = await token({ client_id: 'live', client_secret: 'live-secret', audience: 'openvibe.games' });
    assert.strictEqual(t.status, 400, 'no grants for that audience');

    // ── Guarded routes ──
    let r = await post('/internal/coins/credit', credit(), { authorization: `Bearer ${full}` });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body)); assert.strictEqual(r.body.balance, 5);
    r = await post('/internal/coins/credit', credit({ app_id: 'games' }), { authorization: `Bearer ${full}` });
    assert.strictEqual(r.status, 403); assert.strictEqual(r.body.code, 'capability.owner_denied', 'a token acts only for its own app');
    assert.ok(r.type.startsWith('application/problem+json'));
    r = await post('/internal/coins/debit', credit({ amount: 1 }), { authorization: `Bearer ${creditOnly}` });
    assert.strictEqual(r.status, 403); assert.strictEqual(r.body.code, 'capability.denied', 'narrowed token cannot debit');
    r = await post('/internal/coins/transfer', { from_user_id: 7, to_user_id: 8, app_id: 'live', amount: 2, reason: 't', idempotency_key: 'tr-1' }, { authorization: `Bearer ${full}` });
    assert.strictEqual(r.status, 403, 'ADR-012: loyalty is not transferable between people'); assert.strictEqual(r.body.code, 'capability.denied');
    // The two routes Live called with the key only (plan T2): its token opens them, a narrower one does not.
    r = await post('/internal/user-avatar', { user_id: 7, avatar_url: null, origin: 'live' }, { authorization: `Bearer ${full}` });
    assert.notStrictEqual(r.status, 403, `network.avatar.write opens /internal/user-avatar: ${JSON.stringify(r.body)}`);
    assert.notStrictEqual(r.status, 401);
    r = await post('/internal/notifications/mark-read', { user_id: 7, type: 'follow' }, { authorization: `Bearer ${full}` });
    assert.notStrictEqual(r.status, 403, `network.notifications.push opens mark-read: ${JSON.stringify(r.body)}`);
    // Search pushes for its own app only (plan T9).
    r = await post('/internal/notifications/push', { user_id: 7, type: 'SEARCH_SAVED_MATCH', category: 'service', priority: 'normal', title: 'New results', service: 'search' }, { authorization: `Bearer ${searchToken}` });
    assert.notStrictEqual(r.status, 403, `network.notifications.push opens push for app search: ${JSON.stringify(r.body)}`);
    r = await post('/internal/notifications/push', { user_id: 7, title: 'x', service: 'live' }, { authorization: `Bearer ${searchToken}` });
    assert.strictEqual(r.status, 403, 'search may only push for its own app'); assert.strictEqual(r.body.code, 'capability.owner_denied');
    r = await post('/internal/user-avatar', { user_id: 7, avatar_url: null }, { authorization: `Bearer ${creditOnly}` });
    assert.strictEqual(r.status, 403, 'a token without network.avatar.write');
    r = await post('/internal/coins/credit', credit(), { authorization: 'Bearer not-a-jwt' });
    assert.strictEqual(r.status, 401); assert.strictEqual(r.body.code, 'token.malformed');
    r = await post('/internal/coins/credit', credit(), { authorization: 'Bearer not-a-jwt', 'x-internal-key': 'legacy-key' });
    assert.strictEqual(r.status, 401, 'a bad token is not rescued by a header the server no longer reads');
    const forged = serviceAuth.signServiceToken({ ...claims.claims, jti: 'tok_forged000' }, crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey);
    r = await post('/internal/coins/credit', credit(), { authorization: `Bearer ${forged}` });
    assert.strictEqual(r.status, 401); assert.strictEqual(r.body.code, 'token.bad_signature');
    const expired = serviceAuth.signServiceToken({ ...claims.claims, iat: 1000, exp: 1300 }, keys.privateKey);
    r = await post('/internal/coins/credit', credit(), { authorization: `Bearer ${expired}` });
    assert.strictEqual(r.body.code, 'token.expired');
    const wrongAud = serviceAuth.signServiceToken({ ...claims.claims, aud: ['openvibe.media'] }, keys.privateKey);
    r = await post('/internal/coins/credit', credit(), { authorization: `Bearer ${wrongAud}` });
    assert.strictEqual(r.body.code, 'token.wrong_audience');
    r = await post('/internal/notifications/push', { user_id: 7, service: 'games', title: 'x' }, { authorization: `Bearer ${full}` });
    assert.strictEqual(r.status, 403, 'notifications are sent only as the principal\'s own service');
    r = await fetch(`${base}/internal/stats`, { headers: { authorization: `Bearer ${full}` } }).then(x => ({ status: x.status }));
    assert.strictEqual(r.status, 404, 'the key-only internal routes are gone, not merely locked');
    r = await fetch(`${base}/internal/audit`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${full}` }, body: JSON.stringify({ action: 'x' }) }).then(x => x.status);
    assert.strictEqual(r, 404, 'the key-only internal routes are gone');

    // Community resolves authors with its own token; Live's token lacks that grant.
    await db.prepare("UPDATE oauth_clients SET client_secret = 'community-secret' WHERE client_id = 'community'").run();
    const com = await token({ client_id: 'community', client_secret: 'community-secret', audience: 'openvibe.network' });
    assert.strictEqual(com.status, 200, JSON.stringify(com.body));
    assert.deepStrictEqual(com.body.scope.split(' '), ['identity.subject.resolve', 'network.account.deletion.confirm', 'network.account.export.contribute', 'network.blocks.read', 'network.modules.read', 'network.modules.write'], 'resolve, account export and deletion, platform blocks, plus its community.profile module');
    await db.prepare("UPDATE oauth_clients SET client_secret = 'space-secret' WHERE client_id = 'space'").run();
    // The forum returned to Community (contracts 0.118.0): Space keeps only its sign-in client, so its service token
    // gets no grant on any audience.
    const spaceNetwork = await token({ client_id: 'space', client_secret: 'space-secret', audience: 'openvibe.network' });
    assert.strictEqual(spaceNetwork.status, 400, 'Space holds no Network grant');
    r = await post('/internal/identity/resolve-batch', { system: 'network', ids: ['7'] }, { authorization: `Bearer ${com.body.access_token}` });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.results['7'].username, 'payee');
    // Bot adds an operator by @username: the same projection, any case, a leading @ ignored; an unknown name is a 404.
    for (const name of ['payee', 'PAYEE', '@payee']) {
        const byName = await fetch(`${base}/internal/identity/resolve?username=${encodeURIComponent(name)}`, { headers: { authorization: `Bearer ${com.body.access_token}` } });
        assert.strictEqual(byName.status, 200, name);
        assert.strictEqual((await byName.json()).username, 'payee', name);
    }
    const nobody = await fetch(`${base}/internal/identity/resolve?username=nobody-here`, { headers: { authorization: `Bearer ${com.body.access_token}` } });
    assert.strictEqual(nobody.status, 404, 'an unknown name resolves to nothing');
    r = await post('/internal/identity/resolve-batch', { system: 'network', ids: ['7'] }, { authorization: `Bearer ${creditOnly}` });
    assert.strictEqual(r.status, 403, 'a token narrowed to coins cannot resolve identities');
    // Media's owner_subject backfill: Live user ids -> subjects, an unknown id answers null.
    await db.prepare("INSERT INTO identity_legacy_map (source_system, source_type, source_id, subject_id) SELECT 'live', 'user', '42', subject_id FROM users WHERE id = 7 ON CONFLICT DO NOTHING").run();
    r = await post('/internal/identity/resolve-batch', { system: 'live', type: 'user', ids: ['42', '43'] }, { authorization: `Bearer ${mediaResolve}` });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.match(r.body.results['42'].subject.id, /^usr_/); assert.strictEqual(r.body.results['43'], null);
    r = await post('/internal/coins/credit', credit(), { authorization: `Bearer ${mediaResolve}` });
    assert.strictEqual(r.status, 403, 'Media holds no coin capability');
    const media = await token({ client_id: 'community', client_secret: 'community-secret', audience: 'openvibe.media' });
    assert.strictEqual(media.body.scope, 'media.object.upload', 'community may upload screenshot bytes to Media');
    for (const audience of ['openvibe.media', 'openvibe.vip', 'openvibe.events']) {
        const response = await token({ client_id: 'space', client_secret: 'space-secret', audience });
        assert.strictEqual(response.status, 400, `Space holds no ${audience} grant`);
    }
    const cm = await token({ client_id: 'live', client_secret: 'live-secret', audience: 'openvibe.community' });
    assert.deepStrictEqual(cm.body.scope.split(' '), ['community.comment.moderate', 'community.comment.write', 'community.paste.create', 'community.paste.moderate', 'community.paste.write', 'community.pulse.write']);
    const tl = await token({ client_id: 'live', client_secret: 'live-secret', audience: 'openvibe.tools' });
    assert.deepStrictEqual(tl.body.scope.split(' '), ['tools.job.read', 'tools.tool.run'], 'Live runs Tools on the service tier, never probes');
    await db.prepare("UPDATE oauth_clients SET client_secret = 'tools-secret' WHERE client_id = 'tools'").run();
    const ts = await token({ client_id: 'tools', client_secret: 'tools-secret', audience: 'openvibe.search' });
    assert.strictEqual(ts.body.scope, 'search.document.write', 'Tools indexes its tools in Search');
    const tb = await token({ client_id: 'tools', client_secret: 'tools-secret', audience: 'openvibe.billing' });
    assert.strictEqual(tb.body.scope, 'billing.usage.record', 'Tools posts usage readings to Billing and holds no money capability');
    // Plan T5 step 14: Network's own usage producers post platform.usage-sample@1 to Billing with their
    // own token; usage recording only, never a money capability.
    for (const [client, secret] of [['ai', 'ai-secret'], ['events', 'events-secret'], ['media', 'media-secret']]) {
        const ub = await token({ client_id: client, client_secret: secret, audience: 'openvibe.billing' });
        assert.strictEqual(ub.status, 200, `${client}: ${JSON.stringify(ub.body)}`);
        assert.strictEqual(ub.body.scope, 'billing.usage.record', `${client} records usage on Billing and holds no money capability`);
    }
    // Plan T15: Bot mints its own OpenRestream token for the robots' streams, sessions, outputs and toggles; nothing beyond OpenRestream's
    // stream, key, session-read and output capabilities (never openre.session.end).
    const bn = await token({ client_id: 'bot', client_secret: 'bot-secret', audience: 'openvibe.network', scope: 'identity.subject.resolve' });
    assert.strictEqual(bn.status, 200, JSON.stringify(bn.body));
    assert.strictEqual(bn.body.scope, 'identity.subject.resolve', 'Bot resolves an operator\'s @username');
    const bo = await token({ client_id: 'bot', client_secret: 'bot-secret', audience: 'openvibe.openre' });
    assert.strictEqual(bo.status, 200, JSON.stringify(bo.body));
    assert.deepStrictEqual(bo.body.scope.split(' ').sort(), ['openre.key.rotate', 'openre.output.read', 'openre.output.write', 'openre.session.read', 'openre.stream.read', 'openre.stream.write'], "Bot runs its robots' OpenRestream streams");
    // Coupons subscribes to its Events sources with its own token (OpenVibe.Coupons scripts/subscribe.js).
    await db.prepare("UPDATE oauth_clients SET client_secret = 'coupons-secret' WHERE client_id = 'coupons'").run();
    const cps = await token({ client_id: 'coupons', client_secret: 'coupons-secret', audience: 'openvibe.events', scope: 'events.subscription.manage' });
    assert.strictEqual(cps.status, 200, JSON.stringify(cps.body));
    assert.strictEqual(cps.body.scope, 'events.subscription.manage', 'Coupons manages its Events subscriptions');
    // Plan T5 (Wave 9): Tips' chat adapter mints a token for 'chat.message.send chat.event.publish' on
    // openvibe.chat with its own service token (OpenVibe.Tips server/delivery/chat.js); without both rows
    // TIPS_CHAT_ADAPTER=chat can never deliver a paid effect.
    const tc = await token({ client_id: 'tips', client_secret: 'tips-secret', audience: 'openvibe.chat' });
    assert.strictEqual(tc.status, 200, JSON.stringify(tc.body));
    assert.deepStrictEqual(tc.body.scope.split(' '), ['chat.event.publish', 'chat.message.send'], "Tips delivers paid chat effects through Chat's ingress");
    const tipsClaims = serviceAuth.verifyServiceToken(tc.body.access_token, { publicKey: keys.publicKey, issuer: ISSUER, audience: 'openvibe.chat' });
    assert.ok(tipsClaims.ok, tipsClaims.reason);
    assert.strictEqual(tipsClaims.claims.sub, 'svc:tips');
    assert.deepStrictEqual(tipsClaims.claims.cap, ['chat.event.publish', 'chat.message.send']);

    // Go-live fan-out accepts Live's token (network.notifications.push); a narrower token is refused.
    r = await post('/internal/events/stream-live', {}, { authorization: `Bearer ${full}` });
    assert.strictEqual(r.status, 400, 'guard passed, handler validated the body');
    r = await post('/internal/events/stream-live', {}, { authorization: `Bearer ${creditOnly}` });
    assert.strictEqual(r.status, 403);

    // ── The routes Live called with the key (register C-50/C-52) take its token, and only that ──
    const get = (p, headers) => fetch(base + p, { headers }).then(async x => ({ status: x.status, body: await x.json() }));
    const KEY = { 'x-internal-key': 'legacy-key' };
    const LIVE = { authorization: `Bearer ${full}` };
    r = await get('/internal/url-registry/resolved', LIVE);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body)); assert.strictEqual(r.body.ok, true);
    assert.strictEqual((await get('/internal/url-registry/resolved', { authorization: `Bearer ${creditOnly}` })).status, 403, 'needs network.registry.read');
    r = await get('/internal/coins/stats', LIVE);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body)); assert.ok(Number.isFinite(r.body.earned) && r.body.recent);
    assert.strictEqual((await get('/internal/coins/stats', { authorization: `Bearer ${mediaResolve}` })).status, 403, 'needs network.coins.read');
    r = await post('/internal/resolve-anon', { ip: '203.0.113.9' }, LIVE);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body)); assert.ok(r.body.anon_number >= 1);
    assert.strictEqual((await post('/internal/resolve-anon', { ip: '203.0.113.9' }, { authorization: `Bearer ${creditOnly}` })).status, 403);
    r = await post('/internal/identity/legacy-map', { entries: [{ network_user_id: 7, source_system: 'live', source_type: 'user', source_id: '900' }] }, LIVE);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    r = await post('/internal/identity/legacy-map', { entries: [{ network_user_id: 7, source_system: 'games', source_type: 'user', source_id: '900' }] }, LIVE);
    assert.strictEqual(r.status, 403); assert.strictEqual(r.body.code, 'capability.owner_denied', 'a token maps only its own system\'s ids');
    r = await post('/internal/identity/legacy-map', { entries: [{ network_user_id: 7, source_system: 'live', source_id: '901' }] }, { authorization: `Bearer ${creditOnly}` });
    assert.strictEqual(r.status, 403);
    r = await post('/internal/link-account', { user_id: 7, service: 'live', service_user_id: '4242' }, LIVE);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual((await db.prepare("SELECT service_user_id FROM linked_accounts WHERE user_id = 7 AND service = 'live'").get()).service_user_id, '4242');
    r = await post('/internal/link-account', { user_id: 7, service: 'games', service_user_id: '4242' }, LIVE);
    assert.strictEqual(r.status, 403); assert.strictEqual(r.body.code, 'capability.owner_denied', 'a token links accounts only for its own service');
    // The key is refused on all five with token.missing: the gate asks for a Bearer and nothing else.
    for (const p of ['/internal/url-registry/resolved', '/internal/coins/stats']) {
        const k = await get(p, KEY);
        assert.strictEqual(k.status, 401, `${p}: the retired key`); assert.strictEqual(k.body.code, 'token.missing');
    }
    for (const [p, body] of [['/internal/resolve-anon', { ip: '203.0.113.10' }], ['/internal/identity/legacy-map', { entries: [{ network_user_id: 8, source_system: 'games', source_id: '77' }] }], ['/internal/link-account', { user_id: 8, service: 'games', service_user_id: '77' }]]) {
        const k = await post(p, body, KEY);
        assert.strictEqual(k.status, 401, `${p}: the retired key`); assert.strictEqual(k.body.code, 'token.missing');
    }
    for (const p of ['/internal/url-registry/resolved', '/internal/coins/stats']) {
        const none = await get(p, {});
        assert.strictEqual(none.status, 401, `${p}: no key, no token`); assert.strictEqual(none.body.code, 'token.missing');
    }
    // What the key never had to answer for is now a matter of ownership: a Games token maps its own system's
    // ids, and Live's token still may not (the token-based equivalent of the key's no-ownership-rule note).
    await db.prepare("UPDATE oauth_clients SET client_secret = 'games-secret' WHERE client_id = 'games'").run();
    const GAMES = { authorization: `Bearer ${(await token({ client_id: 'games', client_secret: 'games-secret', audience: 'openvibe.network' })).body.access_token}` };
    assert.strictEqual((await post('/internal/identity/legacy-map', { entries: [{ network_user_id: 8, source_system: 'games', source_id: '77' }] }, GAMES)).status, 200, 'a Games token maps its own ids');
    assert.strictEqual((await post('/internal/link-account', { user_id: 8, service: 'games', service_user_id: '77' }, GAMES)).status, 200, 'and links its own accounts');
    const decided = (await db.prepare("SELECT route FROM principal_usage WHERE principal = 'svc:live' AND allowed = 1").all()).map(x => x.route);
    for (const route of ['GET /internal/url-registry/resolved', 'GET /internal/coins/stats', 'POST /internal/resolve-anon', 'POST /internal/identity/legacy-map', 'POST /internal/link-account']) {
        assert.ok(decided.includes(route), `token use of ${route} is recorded`);
    }

    // ── The key is gone: refused at the gate, on every route, with and without a Bearer ──
    // A syntactically valid service token from a stranger, signed with a key Network does not trust: the
    // equivalent token-based check for the old "wrong internal key" assertion.
    const notAKey = serviceAuth.signServiceToken({ iss: ISSUER, sub: 'svc:live', actor_type: 'service', aud: ['openvibe.network'], cap: ['network.coins.credit'], iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, jti: 'tok_stranger000' }, crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey);
    r = await post('/internal/coins/credit', credit(), { 'x-internal-key': 'legacy-key' });
    assert.strictEqual(r.status, 401); assert.strictEqual(r.body.code, 'token.missing');
    r = await post('/internal/coins/credit', credit(), {});
    assert.strictEqual(r.status, 401); assert.strictEqual(r.body.code, 'token.missing');
    r = await post('/internal/coins/credit', credit(), { 'x-internal-key': 'legacy-key', authorization: `Bearer ${notAKey}` });
    assert.strictEqual(r.status, 401, 'a header cannot lift a bearer that is not a service token');
    assert.strictEqual(r.body.code, 'token.bad_signature');
    // The retired key leaves no trace in the usage audit: only service principals are recorded there now.
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepStrictEqual(await db.prepare("SELECT DISTINCT principal FROM principal_usage WHERE principal NOT LIKE 'svc:%' AND principal <> 'unknown'").all(), [], 'no principal outside the svc: namespace is audited (a refused stranger is "unknown")');

    // ── Revocation: new tokens stop carrying a revoked grant ──
    await db.prepare("UPDATE principal_grants SET revoked_at = ov_now() WHERE client_id = 'live' AND capability = 'network.coins.debit'").run();
    t = await token({ client_id: 'live', client_secret: 'live-secret', audience: 'openvibe.network' });
    assert.ok(!t.body.scope.split(' ').includes('network.coins.debit'));

    // ── Usage audit ──
    const usage = await db.prepare('SELECT principal, route, auth, allowed, code, count FROM principal_usage ORDER BY principal, route, allowed').all();
    assert.ok(usage.some(u => u.principal === 'svc:live' && u.route === 'POST /internal/coins/credit' && u.allowed === 1 && u.count === 1));
    assert.ok(usage.some(u => u.auth === 'service-token' && u.allowed === 1), 'every allow is a service token');
    assert.ok(!usage.some(u => u.auth === 'internal-key' || u.principal === 'legacy-key'), 'the retired key is not an auth path any more');
    assert.ok(usage.some(u => u.code === 'capability.denied' && u.allowed === 0));
    assert.ok(usage.some(u => u.code === 'capability.owner_denied' && u.allowed === 0), 'ownership denials are audited as denials');
    assert.ok(usage.some(u => u.code === 'token.bad_signature'));

    server.close(); db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('principals: all checks passed');
})().catch(err => { console.error(err); process.exit(1); });
})().catch(err => { console.error(err); process.exit(1); });
