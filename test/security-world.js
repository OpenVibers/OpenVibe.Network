'use strict';
/**
 * The world the security suites run against (roadmap WS-R task 5): the real server/index.js booted in
 * a child process (test/helpers/boot-server.js) on a scratch database, with a throwaway RS256 key
 * pair and VAPID pair generated here, an obviously fake low-entropy sentinel in every other secret
 * the server reads from its environment, and a seeded population:
 *   people   alice, bob (users), carol (a third user), staff (role admin, not the owner),
 *            owner (ADMIN_USERNAME, created by the server itself from ADMIN_PASSWORD; OWNER_USERNAME)
 *   developer projects: alice's PA (app AA, confidential sandbox, its credential rotated so two
 *            secrets overlap) and bob's PB (app AB); an export token minted for PA
 *   per-person data: alice's modules, blocks, follows, notifications, sessions, linked account,
 *            history, push subscription, refresh token (OAuth code flow); an anonymous identity;
 *            provider-secret copies in site_settings; a verification key; a closed old incident
 * `secrets` collects every secret value with a label, for the suites to look for in responses.
 * Not a test itself (no .test.js).
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const { bootServer } = require('./helpers/boot-server');
const crawler = require('./security-crawl');

const S = (name) => `sentinel-not-a-secret-${name}`;

/** Every secret-typed environment variable Network (or a module it loads) reads, with its sentinel. */
function sentinelEnv() {
    return {
        INTERNAL_API_KEY: S('internal-api-key'),
        SETUP_TOKEN: S('setup-token'),
        NETWORK_EVENTS_SECRET: S('network-events-secret'),
        OV_LIVE_WEBHOOK_SECRET: S('live-webhook-secret'),
        OV_GAMES_WEBHOOK_SECRET: S('games-webhook-secret'),
        ADMIN_PASSWORD: S('admin-password'),
        RESEND_API_KEY: S('resend-api-key'),
        RESEND_WEBHOOK_SECRET: S('resend-webhook-secret'),
        DISCORD_BOT_TOKEN: S('discord-bot-token'),
        DISCORD_OAUTH_CLIENT_SECRET: S('discord-oauth-client-secret'),
        GITHUB_TOKEN: S('github-token'),
        DEPLOY_CLOUDFLARE_TOKEN: S('deploy-cloudflare-token'),
        OV_OAUTH_CLIENT_SECRET: S('ov-oauth-client-secret'),
        NET_IPINFO_TOKEN: S('net-ipinfo-token'),
        NET_GLOBALPING_TOKEN: S('net-globalping-token'),
    };
}

/** Base64 runs of a PEM body worth looking for (each 64-char line, and the joined body). */
function pemChunks(pem) {
    const lines = String(pem).split('\n').filter((l) => l && !l.startsWith('-----'));
    return { lines, body: lines.join('') };
}

async function buildWorld({ label = 'sec', env: extraEnv = {} } = {}) {
    const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ov-${label}-`));
    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    fs.mkdirSync(path.join(dir, 'keys'));
    fs.writeFileSync(path.join(dir, 'keys', 'private.pem'), keys.privateKey);
    fs.writeFileSync(path.join(dir, 'keys', 'public.pem'), keys.publicKey);
    const vapid = require('web-push').generateVAPIDKeys();
    const sentinels = sentinelEnv();
    const dump = crawler.routeDumpEnv(dir);
    const ISSUER = 'https://openvibe.network';
    const srv = await bootServer({
        env: {
            ...sentinels,
            VAPID_PRIVATE_KEY: vapid.privateKey, VAPID_PUBLIC_KEY: vapid.publicKey,
            JWT_PRIVATE_KEY: path.join(dir, 'keys', 'private.pem'), JWT_PUBLIC_KEY: path.join(dir, 'keys', 'public.pem'),
            ADMIN_USERNAME: 'rootowner', OWNER_USERNAME: 'rootowner', BASE_URL: ISSUER, OV_NETWORK_URL: ISSUER,
            DEV_SANDBOX_AUDIENCES: 'openvibe.media,openvibe.network', DEV_CREDENTIAL_OVERLAP_S: '3600',
            ...dump, ...extraEnv,
        },
    });
    const routes = await crawler.readRoutes(dump.OV_ROUTE_DUMP);
    const db = new Database(path.join(srv.dir, 'network.db'));
    db.pragma('busy_timeout = 5000');

    // ── Secrets, by label ────────────────────────────────────────────
    const secrets = {};
    for (const [k, v] of Object.entries(sentinels)) secrets[`env ${k}`] = v;
    secrets['env VAPID_PRIVATE_KEY'] = vapid.privateKey;
    const priv = pemChunks(keys.privateKey);
    const pub = pemChunks(keys.publicKey);
    priv.lines.forEach((l, i) => { if (!pub.body.includes(l)) secrets[`signing key PEM line ${i}`] = l; });
    const jwk = crypto.createPrivateKey(keys.privateKey).export({ format: 'jwk' });
    for (const f of ['d', 'p', 'q', 'dp', 'dq', 'qi']) secrets[`signing key JWK ${f}`] = jwk[f];

    // ── People ───────────────────────────────────────────────────────
    const subjects = require('../server/identity/subjects');
    const hash = '$2a$10$' + 'x'.repeat(53);
    const addUser = (username, role = 'user', email = null) => {
        db.prepare('INSERT INTO users (username, email, password_hash, display_name, role) VALUES (?, ?, ?, ?, ?)').run(username, email, hash, username, role);
        const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
        subjects.ensureUserSubject(db, row);
        return db.prepare('SELECT * FROM users WHERE id = ?').get(row.id);
    };
    const rows = {
        alice: addUser('alice', 'user', 'alice-private@example.test'),
        bob: addUser('bob', 'user', 'bob-private@example.test'),
        carol: addUser('carol', 'user', 'carol-private@example.test'),
        staff: addUser('staffer', 'admin', 'staff-private@example.test'),
    };
    const ownerRow = db.prepare("SELECT * FROM users WHERE username = 'rootowner'").get();
    if (!ownerRow || ownerRow.role !== 'admin') throw new Error('the server did not create the ADMIN_USERNAME account');
    subjects.ensureUserSubject(db, ownerRow);
    rows.owner = db.prepare('SELECT * FROM users WHERE id = ?').get(ownerRow.id);
    secrets['owner password hash'] = rows.owner.password_hash;
    const sign = (u) => jwt.sign({ sub: u.id, id: u.id, username: u.username, role: u.role }, keys.privateKey, { algorithm: 'RS256', issuer: ISSUER, expiresIn: '2h' });
    const users = {};
    for (const [k, u] of Object.entries(rows)) users[k] = { id: u.id, username: u.username, subject: u.subject_id, email: u.email, token: sign(u) };

    // First-party OAuth clients get unique secrets (stored in clear in oauth_clients).
    const clientSecrets = {};
    for (const c of db.prepare('SELECT client_id FROM oauth_clients').all()) {
        clientSecrets[c.client_id] = `${S('client')}-${c.client_id}-${crypto.randomBytes(6).toString('hex')}`;
        db.prepare('UPDATE oauth_clients SET client_secret = ? WHERE client_id = ?').run(clientSecrets[c.client_id], c.client_id);
        secrets[`oauth client secret ${c.client_id}`] = clientSecrets[c.client_id];
    }

    // ── HTTP ─────────────────────────────────────────────────────────
    let ipn = 0;
    const nextIp = () => { ipn++; return `198.18.${(ipn >> 8) & 255}.${ipn & 255}`; };
    const who = (w) => (typeof w === 'string' ? (users[w] ? { authorization: `Bearer ${users[w].token}` } : {}) : (w || {}));
    async function call(w, method, p, body, headers = {}) {
        const h = { 'x-forwarded-for': nextIp(), ...who(w), ...headers };
        let b;
        if (body !== undefined && body !== null) {
            if (typeof body === 'string') b = body;
            else if (body instanceof URLSearchParams) { b = body.toString(); h['content-type'] = 'application/x-www-form-urlencoded'; } else { b = JSON.stringify(body); h['content-type'] = h['content-type'] || 'application/json'; }
        }
        const r = await fetch(srv.base + p, { method, headers: h, body: b, redirect: 'manual' });
        const text = await r.text();
        let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
        return { status: r.status, headers: r.headers, text, body: json };
    }
    const shownOnce = [];   // responses that legitimately carry a secret once (checked for no-store by the suites)
    const once = (what, r) => { shownOnce.push({ what, status: r.status, cache: r.headers.get('cache-control') || '' }); return r; };

    // Service principal tokens (client_credentials) and the legacy key.
    async function serviceToken(clientId, audience = 'openvibe.network') {
        const r = once(`service token ${clientId}`, await call(null, 'POST', '/oauth/token', new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecrets[clientId], audience })));
        if (r.status !== 200) throw new Error(`service token for ${clientId}: ${r.status} ${r.text}`);
        return r.body.access_token;
    }
    const liveToken = await serviceToken('live');
    const gamesToken = await serviceToken('games');

    // ── Developer projects ───────────────────────────────────────────
    const must = (r, status, what) => { if (r.status !== status) throw new Error(`${what}: ${r.status} ${r.text.slice(0, 300)}`); return r; };
    const dev = {};
    for (const [owner, name] of [['alice', 'PA'], ['bob', 'PB']]) {
        const p = must(await call(owner, 'POST', '/api/v1/projects', { name: `${owner}-private-project` }), 201, `${owner} project`).body;
        const a = once(`app creation ${name}`, must(await call(owner, 'POST', `/api/v1/projects/${p.id}/apps`, { name: `${owner}-private-app`, environment: 'sandbox', type: 'confidential' }), 201, `${owner} app`));
        dev[name] = { id: p.id, app: a.body.id, clientId: a.body.oauth_client_id || a.body.client_id || a.body.id, secret: a.body.credential.client_secret, credential: a.body.credential.id, owner };
        secrets[`dev credential ${name}`] = dev[name].secret;
    }
    // Rotation overlap: alice's old secret keeps working while the new one exists.
    const rot = once('credential rotation', must(await call('alice', 'POST', `/api/v1/projects/${dev.PA.id}/apps/${dev.PA.app}/credentials/rotate`, {}), 201, 'rotate'));
    dev.PA.secret2 = rot.body.credential.client_secret; dev.PA.credential2 = rot.body.credential.id;
    secrets['dev credential PA rotated'] = dev.PA.secret2;
    for (const c of db.prepare('SELECT id, secret_hash FROM dev_credentials').all()) secrets[`dev credential hash ${c.id}`] = c.secret_hash;
    // A grant request (pending) to have a grant row on each app.
    for (const P of ['PA', 'PB']) await call(dev[P].owner, 'POST', `/api/v1/projects/${dev[P].id}/apps/${dev[P].app}/grants`, { capability: 'media.object.upload' });
    const exp = once('export token', must(await call('alice', 'POST', `/api/v1/projects/${dev.PA.id}/export-tokens`, { audience: 'openvibe.media', env: 'sandbox' }), 201, 'export token'));
    secrets['export token PA'] = exp.body.access_token;
    // A developer app token (its project has no Network grant, so it is minted for Media; Network must refuse it everywhere).
    const appTok = once('app token', await call(null, 'POST', '/oauth/token', new URLSearchParams({ grant_type: 'client_credentials', client_id: dev.PA.clientId, client_secret: dev.PA.secret2, audience: 'openvibe.media' })));
    const appToken = appTok.status === 200 ? appTok.body.access_token : null;

    // ── Per-person data ──────────────────────────────────────────────
    await call('alice', 'PUT', '/api/modules/ai.preferences', { data: { style: 'casual', perspective: 'alice-private-perspective', history: false } }, { 'if-match': '0' });
    await call('alice', 'PUT', '/api/modules/chat.tts_defaults', { data: { send: true, volume: 37 } }, { 'if-match': '0' });
    await call('alice', 'PUT', `/api/v1/me/blocks/${users.carol.subject}`, {});
    await call('alice', 'PUT', `/api/v1/me/follows/channel/${users.bob.subject}`, {});
    await call({ authorization: `Bearer ${liveToken}` }, 'POST', '/internal/notifications/push', { user_id: users.alice.id, type: 'system', category: 'system', title: 'alice-private-notification', message: 'for alice only', service: 'live' });
    const sess = once('session creation', await call('alice', 'POST', '/api/auth/sessions', { device_name: 'alice-laptop' }));
    if (sess.body && sess.body.session_token) secrets['alice session token'] = sess.body.session_token;
    await call({ authorization: `Bearer ${gamesToken}` }, 'POST', '/internal/link-account', { user_id: users.alice.id, service: 'games', service_user_id: 'alice-games-771' });
    await call('alice', 'POST', '/api/history', { service: 'live', url: 'https://openvibe.live/@alice-private-history', title: 'alice-private-history' });
    const pushSub = { endpoint: 'https://push.services.mozilla.com/wpush/v2/alice-endpoint-capability-0001', keys: { p256dh: vapid.publicKey, auth: 'alice-push-auth-secret' } };
    await call('alice', 'POST', '/api/push/subscribe', { subscription: pushSub });
    secrets['alice push endpoint'] = pushSub.endpoint;
    secrets['alice push auth'] = pushSub.keys.auth;
    // A refresh token through the OAuth code flow (client 'live').
    const REDIRECT = (JSON.parse(db.prepare("SELECT redirect_uris FROM oauth_clients WHERE client_id = 'live'").get().redirect_uris) || [])[0];
    const conf = await call(null, 'POST', '/oauth/confirm', { token: users.alice.token, client_id: 'live', redirect_uri: REDIRECT });
    if (conf.status === 200 && conf.body && conf.body.redirect) {
        const code = new URL(conf.body.redirect).searchParams.get('code');
        const t = once('oauth code exchange', await call(null, 'POST', '/oauth/token', { grant_type: 'authorization_code', client_id: 'live', client_secret: clientSecrets.live, code, redirect_uri: REDIRECT }));
        if (t.body && t.body.refresh_token) secrets['alice refresh token'] = t.body.refresh_token;
    }
    for (const r of db.prepare('SELECT token FROM oauth_tokens').all()) secrets[`refresh token hash ${r.token.slice(0, 6)}`] = r.token;
    // An anonymous identity seen from another address.
    const anonToken = `anon-${crypto.randomBytes(12).toString('hex')}`;
    db.prepare('INSERT INTO anon_users (anon_number, session_token, ip) VALUES (?, ?, ?)').run(900001, anonToken, '192.0.2.77');
    secrets['anon session token'] = anonToken;
    // Provider-secret copies in the database (the environment wins, but the copies are secrets too).
    for (const k of ['resend_api_key', 'resend_webhook_secret', 'discord_bot_token', 'discord_oauth_client_secret', 'github_token', 'net.ipinfo_token', 'ses_secret_access_key']) {
        const v = S(`db-${k.replace(/[._]/g, '-')}`);
        db.prepare("INSERT OR REPLACE INTO site_settings (key, value, type) VALUES (?, ?, 'secret')").run(k, v);
        secrets[`db setting ${k}`] = v;
    }
    const vk = `VK-${crypto.randomBytes(8).toString('hex')}`;
    db.prepare('INSERT INTO verification_keys (key, target_username, created_by) VALUES (?, ?, ?)').run(vk, 'carol', rows.staff.id);
    // A per-user password hash is never shown to anyone.
    for (const u of ['alice', 'bob', 'staff']) { db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(`$2a$10$${u}${crypto.randomBytes(20).toString('hex')}`, users[u].id); secrets[`${u} password hash`] = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(users[u].id).password_hash; }

    const callers = {
        anonymous: {},
        user: { authorization: `Bearer ${users.bob.token}`, cookie: `ov_token=${users.bob.token}` },
        admin: { authorization: `Bearer ${users.staff.token}`, cookie: `ov_token=${users.staff.token}` },
        owner: { authorization: `Bearer ${users.owner.token}`, cookie: `ov_token=${users.owner.token}` },
        service: { authorization: `Bearer ${liveToken}` },
        ...(appToken ? { app: { authorization: `Bearer ${appToken}` } } : {}),
    };
    return {
        dir: srv.dir, srv, db, keys, vapid, issuer: ISSUER, routes, sentinels, secrets, users, dev, callers, clientSecrets,
        liveToken, appToken, anonToken, verificationKey: vk, pushSub, shownOnce, call, serviceToken, sign, S,
        // Every TCP connection the server made so far, as 'host port' lines (the preload logs them).
        connects: () => { try { return fs.readFileSync(dump.OV_CONNECT_LOG, 'utf8').split('\n').filter(Boolean); } catch { return []; } },
        stop: async () => { try { db.close(); } catch { /* */ } await srv.stop(); try { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(srv.dir, { recursive: true, force: true }); } catch { /* */ } },
    };
}

module.exports = { buildWorld, sentinelEnv, pemChunks, S };
