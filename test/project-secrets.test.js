'use strict';
// Project secrets (ADR-056, server/developer/secrets.js): admins write a value once and nobody reads it back; members
// and staff see metadata (version, a keyed fingerprint, grants); a service uses a secret only through
// POST /internal/secrets/use with network.secret.use AND the project's grant of that secret to it, to sign (HMAC, the
// value never leaves) or to reveal it for a listed origin; every refusal past validation is the same 404; values are
// stored only encrypted, bound to their row; archiving shreds them; nothing secret reaches the audit.
//   node test/project-secrets.test.js
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { serviceAuth, validate } = require('openvibe-contracts');
const { getDb } = require('../server/db/database');
const subjects = require('../server/identity/subjects');

(async () => {
    const quiet = console.log;
    console.log = () => {};
    const db = getDb();
    await db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES
        (10, 'owner', 'x', 'user'), (11, 'admin', 'x', 'user'), (12, 'dev', 'x', 'user'), (13, 'stranger', 'x', 'user'), (14, 'staff', 'x', 'admin')`).run();
    const sid = async (id) => await subjects.ensureUserSubject(db, await db.prepare('SELECT * FROM users WHERE id = ?').get(id));

    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    const ISSUER = 'https://openvibe.network';
    const KEY = crypto.randomBytes(32).toString('base64');
    const app = express();
    app.locals.db = db;
    app.locals.config = { baseUrl: ISSUER, jwt: { issuer: ISSUER, accessTokenExpiry: '1h' }, developer: { sandboxAllowance: '' }, secrets: { key: KEY } };
    app.locals.privateKey = keys.privateKey;
    app.locals.publicKey = keys.publicKey;
    app.use('/api/v1/projects', require('../server/developer/routes').router());
    app.use('/internal', require('../server/internal/routes'));
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const userToken = (id) => jwt.sign({ sub: id, id }, keys.privateKey, { algorithm: 'RS256', issuer: ISSUER, expiresIn: '1h' });
    const T = { owner: userToken(10), admin: userToken(11), dev: userToken(12), stranger: userToken(13), staff: userToken(14) };
    const now = Math.floor(Date.now() / 1000);
    const svc = (id, cap = ['network.secret.use']) => serviceAuth.signServiceToken({ iss: ISSUER, sub: `svc:${id}`, actor_type: 'service', aud: ['openvibe.network'], cap, iat: now, exp: now + 300, jti: `tok_${id}_${crypto.randomBytes(4).toString('hex')}` }, keys.privateKey);
    const api = async (who, method, p, body) => {
        const r = await fetch(`${base}/api/v1/projects${p}`, { method, headers: { authorization: `Bearer ${T[who]}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
        const text = await r.text();
        return { status: r.status, body: text ? JSON.parse(text) : null, text };
    };
    const use = async (token, body) => {
        const r = await fetch(`${base}/internal/secrets/use`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const text = await r.text();
        return { status: r.status, body: text ? JSON.parse(text) : null, cache: r.headers.get('cache-control') };
    };
    let failures = 0;
    const check = async (name, fn) => { try { await fn(); quiet('  ✓', name); } catch (e) { failures++; quiet('  ✗', name, '\n     ', (e.stack || String(e)).split('\n').slice(0, 6).join('\n      ')); } };

    try {
        const P = (await api('owner', 'POST', '/', { name: 'Secrets probe' })).body.id;
        assert.ok(/^prj_/.test(P), 'project created');
        assert.strictEqual((await api('owner', 'POST', `/${P}/members`, { subject_id: await sid(11), role: 'admin' })).status, 201);
        assert.strictEqual((await api('owner', 'POST', `/${P}/members`, { subject_id: await sid(12), role: 'developer' })).status, 201);
        const VALUE = `whk_${crypto.randomBytes(24).toString('hex')}`;
        const VALUE2 = `whk_${crypto.randomBytes(24).toString('hex')}`;
        const TOKEN = 't'.repeat(48);

        await check('an admin sets a value; the answer is metadata only, and members and staff read it, strangers do not', async () => {
            const r = await api('admin', 'PUT', `/${P}/secrets/production/webhook-signing`, { value: VALUE });
            assert.strictEqual(r.status, 200, r.text);
            assert.ok(!r.text.includes(VALUE), 'the value is never answered');
            assert.strictEqual(r.body.version, 1);
            assert.match(r.body.fingerprint, /^[0-9a-f]{12}$/);
            assert.strictEqual(validate('network.project-secret@1', r.body).valid, true, JSON.stringify(validate('network.project-secret@1', r.body).errors));
            const list = await api('dev', 'GET', `/${P}/secrets`);
            assert.strictEqual(list.status, 200);
            assert.deepStrictEqual(list.body.secrets.map((s) => [s.environment, s.name, s.version]), [['production', 'webhook-signing', 1]]);
            assert.ok(!list.text.includes(VALUE));
            assert.strictEqual((await api('staff', 'GET', `/${P}/secrets`)).status, 200, 'staff read the metadata');
            assert.strictEqual((await api('stranger', 'GET', `/${P}/secrets`)).status, 404, 'a stranger learns nothing');
        });

        await check('only admins and owners write: a developer and staff are refused; bad names, environments and sizes too', async () => {
            assert.strictEqual((await api('dev', 'PUT', `/${P}/secrets/production/x`, { value: 'v' })).status, 403);
            assert.strictEqual((await api('staff', 'PUT', `/${P}/secrets/production/x`, { value: 'v' })).status, 403, 'staff read metadata but never write a value');
            assert.strictEqual((await api('owner', 'PUT', `/${P}/secrets/production/Upper`, { value: 'v' })).status, 422);
            assert.strictEqual((await api('owner', 'PUT', `/${P}/secrets/staging/x`, { value: 'v' })).status, 422);
            assert.strictEqual((await api('owner', 'PUT', `/${P}/secrets/production/x`, { value: '' })).status, 422);
            assert.strictEqual((await api('owner', 'PUT', `/${P}/secrets/production/x`, { value: 'v'.repeat(8193) })).body.code, 'secret.too_large');
        });

        await check('stored only encrypted: no plaintext in the table nor the audit', async () => {
            const row = await db.prepare("SELECT * FROM dev_project_secrets WHERE project_id = ? AND name = 'webhook-signing'").get(P);
            assert.ok(row.ciphertext && row.iv && row.tag, 'sealed');
            const dump = JSON.stringify(await db.prepare('SELECT * FROM dev_project_secrets').all());
            assert.ok(!dump.includes(VALUE) && !dump.includes(Buffer.from(VALUE).toString('base64')), 'no plaintext, nor its base64');
            const audit = JSON.stringify(await db.prepare('SELECT * FROM dev_audit WHERE project_id = ?').all(P));
            assert.ok(!audit.includes(VALUE), 'the audit holds no value');
            assert.ok(audit.includes('secret.created'), 'the set is audited');
        });

        await check('a service without the project\'s grant gets 404, as for a secret that does not exist', async () => {
            const sign = { project_id: P, environment: 'production', name: 'webhook-signing', purpose: 'sign', message: '1760504400.{"state":"succeeded"}' };
            const a = await use(svc('actor'), sign);
            assert.deepStrictEqual([a.status, a.body.code], [404, 'secret.not_found']);
            const b = await use(svc('actor'), { ...sign, name: 'no-such-secret' });
            assert.deepStrictEqual([b.status, b.body.code], [404, 'secret.not_found'], 'indistinguishable');
            assert.strictEqual((await use(svc('actor', ['identity.subject.resolve']), sign)).status, 403, 'the capability is the door');
        });

        await check('granted for sign: the signature is HMAC-SHA256 under the value, which never leaves; reveal stays refused', async () => {
            const g = await api('admin', 'PUT', `/${P}/secrets/production/webhook-signing/grants/actor`, { purposes: ['sign'] });
            assert.strictEqual(g.status, 200, g.text);
            assert.deepStrictEqual(g.body.grants.map((x) => [x.service, x.purposes, x.origins]), [['actor', ['sign'], []]]);
            const message = '1760504400.{"state":"succeeded"}';
            const r = await use(svc('actor'), { project_id: P, environment: 'production', name: 'webhook-signing', purpose: 'sign', message });
            assert.strictEqual(r.status, 200, JSON.stringify(r.body));
            assert.strictEqual(r.cache, 'no-store');
            assert.strictEqual(r.body.signature, crypto.createHmac('sha256', VALUE).update(message).digest('hex'));
            assert.ok(!JSON.stringify(r.body).includes(VALUE));
            assert.strictEqual(validate('network.secret-use-result@1', r.body).valid, true);
            const rev = await use(svc('actor'), { project_id: P, environment: 'production', name: 'webhook-signing', purpose: 'reveal', origin: 'https://hooks.example.com' });
            assert.strictEqual(rev.status, 404, 'sign does not imply reveal');
            assert.strictEqual((await use(svc('watch'), { project_id: P, environment: 'production', name: 'webhook-signing', purpose: 'sign', message })).status, 404, 'another service');
            assert.strictEqual((await use(svc('actor'), { project_id: P, environment: 'sandbox', name: 'webhook-signing', purpose: 'sign', message })).status, 404, 'another environment');
            assert.ok((await api('dev', 'GET', `/${P}/secrets`)).body.secrets[0].grants[0].last_used_at, 'the grant records its use');
        });

        await check('reveal only for an origin the grant lists; a grant for reveal must name origins', async () => {
            assert.strictEqual((await api('admin', 'PUT', `/${P}/secrets/sandbox/api_token`, { value: TOKEN })).status, 200);
            assert.strictEqual((await api('admin', 'PUT', `/${P}/secrets/sandbox/api_token/grants/watch`, { purposes: ['reveal'] })).status, 422, 'no origins');
            assert.strictEqual((await api('admin', 'PUT', `/${P}/secrets/sandbox/api_token/grants/watch`, { purposes: ['reveal'], origins: ['http://api.example.com'] })).status, 422, 'https only');
            assert.strictEqual((await api('admin', 'PUT', `/${P}/secrets/sandbox/api_token/grants/watch`, { purposes: ['reveal'], origins: ['https://API.example.com/'] })).status, 200);
            const ok = await use(svc('watch'), { project_id: P, environment: 'sandbox', name: 'api_token', purpose: 'reveal', origin: 'https://api.example.com' });
            assert.deepStrictEqual([ok.status, ok.body.value], [200, TOKEN]);
            const other = await use(svc('watch'), { project_id: P, environment: 'sandbox', name: 'api_token', purpose: 'reveal', origin: 'https://evil.example.com' });
            assert.strictEqual(other.status, 404, 'an origin the grant does not list');
            const mixed = await use(svc('watch'), { project_id: P, environment: 'sandbox', name: 'api_token', purpose: 'reveal', origin: 'https://api.example.com', message: 'x' });
            assert.strictEqual(mixed.status, 400, 'the request schema refuses a reveal with a message');
            // A ciphertext copied onto another row does not open there: the row's identity is the authenticated data.
            assert.strictEqual((await api('admin', 'PUT', `/${P}/secrets/sandbox/moved`, { value: 'other' })).status, 200);
            assert.strictEqual((await api('admin', 'PUT', `/${P}/secrets/sandbox/moved/grants/watch`, { purposes: ['reveal'], origins: ['https://api.example.com'] })).status, 200);
            const src = await db.prepare("SELECT iv, tag, ciphertext FROM dev_project_secrets WHERE project_id = ? AND name = 'api_token'").get(P);
            await db.prepare("UPDATE dev_project_secrets SET iv = ?, tag = ?, ciphertext = ? WHERE project_id = ? AND name = 'moved'").run(src.iv, src.tag, src.ciphertext, P);
            const moved = await use(svc('watch'), { project_id: P, environment: 'sandbox', name: 'moved', purpose: 'reveal', origin: 'https://api.example.com' });
            assert.deepStrictEqual([moved.status, moved.body.code], [503, 'secrets.unavailable'], 'a moved ciphertext is refused, never revealed');
            assert.strictEqual((await api('admin', 'DELETE', `/${P}/secrets/sandbox/moved`)).status, 204);
        });

        await check('replacing a value bumps the version and the fingerprint; signatures follow the new value', async () => {
            const before = (await api('dev', 'GET', `/${P}/secrets?environment=production`)).body.secrets[0];
            const r = await api('owner', 'PUT', `/${P}/secrets/production/webhook-signing`, { value: VALUE2 });
            assert.strictEqual(r.body.version, 2);
            assert.notStrictEqual(r.body.fingerprint, before.fingerprint);
            assert.deepStrictEqual(r.body.grants.map((x) => x.service), ['actor'], 'grants survive a replacement');
            const s = await use(svc('actor'), { project_id: P, environment: 'production', name: 'webhook-signing', purpose: 'sign', message: 'm' });
            assert.deepStrictEqual([s.body.version, s.body.signature], [2, crypto.createHmac('sha256', VALUE2).update('m').digest('hex')]);
            const same = await api('owner', 'PUT', `/${P}/secrets/sandbox/again`, { value: VALUE2 });
            assert.strictEqual(same.body.fingerprint, r.body.fingerprint, 'equal values, equal fingerprints');
        });

        await check('revoking the grant stops the service; deleting the secret removes it and its grants', async () => {
            assert.strictEqual((await api('admin', 'DELETE', `/${P}/secrets/production/webhook-signing/grants/actor`)).status, 204);
            assert.strictEqual((await use(svc('actor'), { project_id: P, environment: 'production', name: 'webhook-signing', purpose: 'sign', message: 'm' })).status, 404);
            assert.strictEqual((await api('admin', 'DELETE', `/${P}/secrets/sandbox/again`)).status, 204);
            assert.deepStrictEqual((await api('dev', 'GET', `/${P}/secrets`)).body.secrets.map((s) => s.name).sort(), ['api_token', 'webhook-signing']);
        });

        await check('archiving the project shreds its secrets: no ciphertext remains and no service can use them', async () => {
            assert.strictEqual((await api('owner', 'POST', `/${P}/archive`)).status, 200);
            const rows = await db.prepare('SELECT ciphertext, iv, tag FROM dev_project_secrets WHERE project_id = ?').all(P);
            assert.ok(rows.length && rows.every((r) => r.ciphertext === null && r.iv === null && r.tag === null), 'shredded');
            assert.strictEqual((await use(svc('watch'), { project_id: P, environment: 'sandbox', name: 'api_token', purpose: 'reveal', origin: 'https://api.example.com' })).status, 404);
            assert.strictEqual((await api('dev', 'GET', `/${P}/secrets`)).status, 200, 'the metadata stays readable');
        });

        await check('without NETWORK_SECRETS_KEY the feature is off (503), never plaintext', async () => {
            const P2 = (await api('owner', 'POST', '/', { name: 'No key' })).body.id;
            app.locals.config.secrets.key = '';
            const r = await api('owner', 'PUT', `/${P2}/secrets/production/x`, { value: 'v' });
            app.locals.config.secrets.key = KEY;
            assert.deepStrictEqual([r.status, r.body.code], [503, 'secrets.unavailable']);
            assert.strictEqual((await db.prepare('SELECT COUNT(*) AS c FROM dev_project_secrets WHERE project_id = ?').get(P2)).c * 1, 0);
        });
    } finally {
        server.close();
        console.log = quiet;
    }
    console.log(failures ? `\n${failures} failed` : '\nproject secrets: all checks passed');
    process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
