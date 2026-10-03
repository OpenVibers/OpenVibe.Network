'use strict';
// Internal-secret leak (roadmap WS-R task 5). The real server boots with a throwaway RS256 pair, a
// generated VAPID pair and a fake low-entropy sentinel in every other secret it reads from the
// environment (test/security-world.js), plus database-held secrets: first-party OAuth client
// secrets, developer app credentials (two overlapping after a rotation) and their hashes, an export
// token, a refresh token and its hash, a session token, an anonymous identity's token, push keys,
// provider-secret copies in site_settings, password hashes and a verification key.
// Every GET route Express knows after boot (test/security-crawl.js walks the router, so a route added
// later is crawled without anyone listing it) is requested with seeded and nonsense ids, with and
// without a query string, plus probes for files that must never be served, as: anonymous, a user,
// a staff admin, the owner, a service principal (live), a developer app and a caller still sending the
// retired X-Internal-Key (which the server must keep refusing and must never answer).
// Then every write route is sent malformed JSON (and anonymous an empty body), and wrong credentials.
// No body or header may carry any secret (as is, URL-encoded or base64); the responses that show a
// secret once (token, credential and session creation) must be Cache-Control: no-store. The log, the
// event outbox and the audit tables written meanwhile must not carry one either. Also: a Network booted
// without its key files never publishes its ephemeral HS256 secret as a "public key".
//   node test/security-secrets.test.js
const assert = require('assert');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { buildWorld } = require('./security-world');
const { bootServer } = require('./helpers/boot-server');
const crawler = require('./security-crawl');

const out = (...a) => process.stdout.write(a.join(' ') + '\n');

(async () => {
    const t0 = Date.now();
    const w = await buildWorld({ label: 'secrets' });
    try {
        const { users, dev } = w;
        const values = (name) => ({
            project: [dev.PA.id, dev.PB.id, 'prj_00000000000000000000000000', '..%2f'],
            app: [dev.PA.app, dev.PB.app, 'app_00000000000000000000000000', 'x'],
            credential: [dev.PA.credential, dev.PB.credential, 'crd_x'],
            capability: ['media.object.upload', 'identity.subject.resolve', 'x'],
            subject: [users.alice.subject, users.bob.subject, 'usr_x'],
            target: [users.alice.subject, users.bob.subject, 'x'],
            type: ['user', 'channel', 'x'],
            creator: [users.alice.subject, 'alice', 'x'],
            id: [String(users.alice.id), String(users.owner.id), '1', '999999', 'x', '-1'],
            userId: [String(users.alice.id), String(users.bob.id), '999999'],
            username: ['alice', 'rootowner', 'nobody'],
            name: ['alice', 'live', 'network', 'nobody'],
            ns: ['ai.preferences', 'chat.tts_defaults', 'live.profile', 'x'],
            namespace: ['general', 'network', 'x'],
            key: ['DEPLOY_CLOUDFLARE_TOKEN', 'OV_LIVE_URL', 'x'],
            token: ['not-a-token', 'x'],
            idOrSlug: ['default', 'x'],
            serviceId: ['live', 'network', 'x'],
            domain: ['openvibe.live', 'x'],
            topic: ['live.stream.started', 'x'],
            category: ['system', 'x'],
        }[name] || ['1', 'x']);
        const extra = ['/api/nope', '/internal/nope', '/INTERNAL/users/1', '/.env', '/.git/config', '/package.json', '/server/config.js',
            '/data/network.db', '/data/keys/private.pem', '/keys/private.pem', '/private.pem', '/network.db', '/data/avatars/..%2fnetwork.db',
            '/data/avatars/%2e%2e/network.db', '/shared/..%2f..%2fpackage.json', '/node_modules/.package-lock.json', '/api/.well-known/jwks',
            '/.well-known/openid-configuration', '/oauth/.well-known/openid-configuration', '/api/ready', '/metrics', '/release.json', '/status',
            '/api/v1/status', '/api/admin/secrets', '/api/admin/settings', '/api/admin/config', '/api/admin/url-registry', '/api/admin/email',
            '/api/admin/discord/', '/api/admin/integrations/github/', '/api/admin/deploy/config', '/internal/url-registry/resolved',
            '/internal/integrations/github-token', '/api/setup/status', '/oauth/authorize?client_id=live&redirect_uri=https%3A%2F%2Fevil.test%2F&response_type=code',
            '/oauth/client-info?client_id=live', `/oauth/client-info?client_id=${dev.PA.app}`, '/api/auth/anon-identities', '/sso/check', '/fedcm/accounts'];
        const paths = crawler.pathsFor(w.routes, values, { method: 'get', query: 'limit=5&all=1&debug=1&include=secret', extra });
        const tokenOf = (h) => String((h && h.authorization) || '').replace(/^Bearer /, '');
        const people = { ...w.callers, key: { 'x-internal-key': 'retired-key' } };
        // What each caller must never see: every secret, plus every other caller's credential. Staff
        // admins and the owner list verification keys (they make them to hand out); nobody else sees one.
        const needlesFor = (who) => {
            const n = { ...w.secrets };
            for (const [other, h] of Object.entries(people)) if (other !== who && tokenOf(h)) n[`${other}'s bearer token`] = tokenOf(h);
            if (who !== 'admin' && who !== 'owner') n['verification key'] = w.verificationKey;
            return n;
        };

        // ── Every GET, as everyone ─────────────────────────────────────
        const gets = await crawler.crawl(w.srv.base, paths, people, needlesFor);
        out(`GET crawl: ${paths.length} paths x ${Object.keys(people).length} callers, ${JSON.stringify(gets.statuses)}`);
        // The one documented exception (server/auth/owner-guard.js): the owner, and only the owner,
        // reads provider secrets in the admin settings and the secret-typed registry values in clear,
        // to change them; staff admins get them masked. Those two reads must not be cached.
        const OWNER_READS = /^owner: GET \/api\/admin\/(settings|url-registry)(\?[^ ]*)? → 200 carries (db setting [a-z_.]+|env DEPLOY_CLOUDFLARE_TOKEN) in its body$/;
        const ownerReads = gets.found.filter((f) => OWNER_READS.test(f));
        assert.ok(ownerReads.length > 0, 'the owner exception is still exercised');
        for (const p of ['/api/admin/settings', '/api/admin/url-registry']) {
            const r = await w.call(people.owner, 'GET', p);
            assert.strictEqual(r.status, 200);
            assert.match(r.headers.get('cache-control') || '', /no-store/, `${p}: the owner's clear-text read is never cached`);
            const staff = await w.call(people.admin, 'GET', p);
            assert.ok(staff.status === 403 || (staff.status === 200 && crawler.leaks(staff, needlesFor('admin')).length === 0), `${p}: staff admins get it masked or not at all`);
        }
        const leaked = gets.found.filter((f) => !OWNER_READS.test(f));
        assert.deepStrictEqual(leaked, [], `secrets in GET responses:\n${leaked.join('\n')}`);
        assert.ok(paths.length >= 300 && gets.answered === paths.length * Object.keys(people).length, 'every request was answered');
        assert.ok((gets.statuses['2xx'] || 0) > 500, 'the crawl reached real pages, not only refusals');
        assert.strictEqual(Object.values(gets.byPath).filter((s) => s === 429).length, 0, 'no request was rate-limited away');
        // The crawl really was signed in: each caller reaches something only it can.
        const st = (who, p) => gets.byPath[`${who} GET ${p}`];
        assert.strictEqual(st('user', '/api/auth/me'), 200);
        assert.strictEqual(st('anonymous', '/api/auth/me'), 401);
        assert.strictEqual(st('admin', '/api/admin/url-registry'), 200);
        assert.strictEqual(st('admin', '/api/admin/settings'), 403, 'settings are the owner\'s');
        assert.strictEqual(st('user', '/api/admin/url-registry'), 403);
        assert.strictEqual(st('owner', '/api/admin/secrets'), 200);
        assert.strictEqual(st('owner', '/api/admin/settings'), 200);
        assert.strictEqual(st('service', '/internal/url-registry/resolved'), 200, 'live may read the resolved registry');
        assert.strictEqual(st('key', '/internal/url-registry/resolved'), 401, 'the retired X-Internal-Key opens nothing');
        assert.strictEqual(st('anonymous', '/internal/url-registry/resolved'), 401, 'and nobody without a service token gets in');

        // JWKS and OIDC discovery: the public key, never a private part.
        const jwks = await w.call(null, 'GET', '/api/.well-known/jwks');
        assert.strictEqual(jwks.status, 200);
        assert.ok(jwks.body.public_key.includes('BEGIN PUBLIC KEY') && jwks.body.keys.length === 1);
        for (const f of ['d', 'p', 'q', 'dp', 'dq', 'qi']) assert.ok(!(f in jwks.body.keys[0]), `JWKS has no private member ${f}`);
        // The configured key (decision 2, plan T2): the kid and modulus JWKS serves are the signing key's.
        const jwk = jwks.body.keys[0];
        assert.strictEqual(jwk.kty, 'RSA');
        assert.strictEqual(jwk.kid, 'ov-network-1', 'the kid /api/.well-known/jwks publishes');
        assert.strictEqual(jwk.n, crypto.createPublicKey(w.keys.publicKey).export({ format: 'jwk' }).n, 'the modulus is the configured key\'s');
        assert.ok(!/PRIVATE/.test(jwks.text));

        // ── Error paths: every write route, refused or malformed ─────────
        const writes = {};
        for (const m of ['post', 'put', 'patch', 'delete']) writes[m] = crawler.pathsFor(w.routes, values, { method: m });
        const found = [];
        let sent = 0;
        for (const [m, list] of Object.entries(writes)) {
            const M = m.toUpperCase();
            for (const [body, callers] of [
                ['{"broken": ', people],                                        // malformed JSON, everyone
                ['{}', { anonymous: {}, app: people.app || {} }],               // empty body without the right credential
            ]) {
                const r = await crawler.crawl(w.srv.base, list, callers, needlesFor, { method: M, body });
                sent += list.length * Object.keys(callers).length;
                found.push(...r.found);
            }
        }
        // Wrong credentials of every kind on the paths that take them.
        const wrong = {
            'retired internal key': { 'x-internal-key': 'retired-key' },
            'forged bearer': { authorization: `Bearer ${jwt.sign({ sub: users.owner.id, id: users.owner.id }, 'guess', { issuer: w.issuer })}` },
            'none alg bearer': { authorization: `Bearer ${jwt.sign({ sub: users.owner.id, id: users.owner.id }, null, { algorithm: 'none' })}` },
            'setup token guess': { 'x-setup-token': 'x', authorization: 'Bearer x' },
        };
        const wr = await crawler.crawl(w.srv.base, [...writes.post.filter((p) => /^\/(internal|oauth|api\/setup|api\/admin)/.test(p)), ...paths.filter((p) => /^\/(internal|api\/admin)/.test(p))], wrong, needlesFor, { method: 'GET' });
        found.push(...wr.found);
        for (const [grant, form] of [
            ['client_credentials', { client_id: 'live', client_secret: 'wrong' }],
            ['client_credentials', { client_id: dev.PA.clientId, client_secret: 'ovsec_wrong' }],
            ['authorization_code', { client_id: 'live', client_secret: w.clientSecrets.live, code: 'nope', redirect_uri: 'https://evil.test/' }],
            ['refresh_token', { client_id: 'live', client_secret: w.clientSecrets.live, refresh_token: 'f'.repeat(96) }],
        ]) {
            const r = await w.call(null, 'POST', '/oauth/token', new URLSearchParams({ grant_type: grant, ...form }));
            assert.ok(r.status >= 400, `${grant} with wrong material is refused`);
            for (const l of crawler.leaks(r, needlesFor('anonymous'))) found.push(`oauth ${grant} refusal carries ${l.label}`);
        }
        out(`write/error crawl: ${sent} requests`);
        assert.deepStrictEqual(found, [], `secrets in error responses:\n${found.join('\n')}`);

        // ── Shown once, never cached ─────────────────────────────────────
        for (const s of w.shownOnce.filter((x) => x.status >= 200 && x.status < 300)) assert.match(s.cache, /no-store/, `${s.what}: Cache-Control no-store`);
        assert.ok(w.shownOnce.filter((x) => x.status >= 200 && x.status < 300).length >= 6, 'the shown-once responses were made');
        // The other answers that carry a token: refresh, an anonymous session, the anonymous identities of this address.
        for (const [who, m, p, body] of [['alice', 'POST', '/api/auth/refresh', {}], [null, 'POST', '/api/auth/anon-session', {}], [null, 'GET', '/api/auth/anon-identities'], [null, 'POST', '/api/auth/login', { username: 'alice', password: 'wrong' }]]) {
            const r = await w.call(who, m, p, body);
            assert.match(r.headers.get('cache-control') || '', /no-store/, `${m} ${p} (${r.status}): Cache-Control no-store`);
        }

        // ── Logs, outbox and audit tables ────────────────────────────────
        const all = { ...needlesFor('nobody'), 'verification key': w.verificationKey };
        delete all['verification key'];   // stored in its own table by design; only its readers are checked above
        const logHits = crawler.leaks({ text: w.srv.logs(), headers: {} }, all).map((l) => l.label);
        assert.deepStrictEqual(logHits, [], 'nothing secret was logged');
        const tables = (await w.db.prepare("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND (table_name LIKE '%outbox%' OR table_name LIKE '%audit%' OR table_name LIKE '%log%' OR table_name LIKE '%usage%' OR table_name LIKE '%changes%' OR table_name LIKE '%alerts%' OR table_name LIKE '%revisions%' OR table_name = 'notifications')").all()).map((r) => r.name);
        assert.ok(tables.includes('network_event_outbox') && tables.includes('dev_audit') && tables.includes('audit_log'), tables.join(','));
        const rowHits = [];
        for (const t of tables) {
            const text = JSON.stringify(await w.db.prepare(`SELECT * FROM "${t}"`).all());
            for (const l of crawler.leaks({ text, headers: {} }, all)) rowHits.push(`${t}: ${l.label}`);
        }
        assert.deepStrictEqual(rowHits, [], 'no secret in the outbox, audit or log tables');
        assert.ok((await w.db.prepare('SELECT COUNT(*) AS n FROM network_event_outbox').get()).n > 0, 'the outbox was written meanwhile');
    } finally {
        await w.stop();
    }

    // ── Without key files: the ephemeral HS256 secret is never published (a child of its own, so its
    // database and process are not the seeded world's) ───
    const bare = await bootServer({ child: true });
    try {
        const r = await fetch(`${bare.base}/api/.well-known/jwks`);
        const body = await r.json();
        const k = body.public_key;
        if (k && !String(k).includes('BEGIN')) {
            // What the published "key" would let anyone do: sign a session for the first admin.
            const forged = jwt.sign({ sub: 1, id: 1, username: 'admin', role: 'admin' }, k, { algorithm: 'HS256', issuer: 'https://openvibe.network', expiresIn: '1h' });
            const me = await fetch(`${bare.base}/api/auth/me`, { headers: { authorization: `Bearer ${forged}` } });
            assert.notStrictEqual(me.status, 200, 'a session signed with the published HS256 secret is refused');
        }
        assert.ok(!k || String(k).includes('BEGIN PUBLIC KEY'), 'a keyless Network publishes no HS256 secret as its public key');
    } finally {
        await bare.stop();
    }
    out(`security secrets: all checks passed (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
})().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
