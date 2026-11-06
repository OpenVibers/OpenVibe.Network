'use strict';
// The vault (Compute plan E7, server/connect/vault.js): a credential is sealed at rest under Network's
// KEK, with the person's subject and the app as the authenticated data; a wrong subject cannot decrypt
// it; a credential the test call refuses is never stored; the export lists the apps and never the
// secrets; the deletion erases them; without the key the feature is off.
//   node test/connect-vault.test.js
const assert = require('assert');
const crypto = require('crypto');
const { getDb } = require('../server/db/database');
const subjects = require('../server/identity/subjects');
const vault = require('../server/connect/vault');
const { startApp, json } = require('./helpers/connect-app');

(async () => {
    const quiet = console.log;
    console.log = () => {};
    const db = getDb();
    await db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES
        (10, 'owner', 'x', 'user'), (11, 'other', 'x', 'user')`).run();
    const owner = await subjects.ensureUserSubject(db, await db.prepare('SELECT * FROM users WHERE id = 10').get());
    const other = await subjects.ensureUserSubject(db, await db.prepare('SELECT * FROM users WHERE id = 11').get());

    const KEY = crypto.randomBytes(32).toString('base64');
    const config = { secrets: { key: KEY } };
    const SECRET = 'github_pat_' + crypto.randomBytes(20).toString('hex');

    let failures = 0;
    const check = async (name, fn) => { try { await fn(); quiet('  ✓', name); } catch (e) { failures++; quiet('  ✗', name, '\n     ', (e.stack || String(e)).split('\n').slice(0, 6).join('\n      ')); } };

    try {
        await check('a credential is sealed at rest: the row holds ciphertext, never the secret', async () => {
            const view = await vault.store(db, owner, 'github', 'default', SECRET, { scopes: ['Issues: read and write'], config });
            assert.strictEqual(view.app, 'github');
            assert.strictEqual(view.label, 'default');
            assert.deepStrictEqual(view.scopes, ['Issues: read and write']);
            assert.ok(!('value' in view) && !('ciphertext' in view), 'the view is metadata only');
            const row = await db.prepare('SELECT * FROM connect_credentials WHERE subject = ? AND app = ?').get(owner, 'github');
            assert.ok(row.ciphertext && row.iv && row.tag, 'sealed');
            assert.ok(!JSON.stringify(row).includes(SECRET), 'the secret is nowhere in the row');
            const opened = await vault.open(db, owner, 'github', 'default', { config });
            assert.strictEqual(opened, SECRET, 'the gateway can open it');
        });

        await check('a wrong subject cannot decrypt it, and a ciphertext copied onto another row does not open', async () => {
            const row = await db.prepare('SELECT * FROM connect_credentials WHERE subject = ? AND app = ?').get(owner, 'github');
            const kr = vault.keyring(config);
            assert.strictEqual(vault.openSealed(kr, row), SECRET, 'the right row opens');
            assert.strictEqual(vault.openSealed(kr, { ...row, subject: other }), null, 'another person\'s row does not open');
            assert.strictEqual(vault.openSealed(kr, { ...row, app: 'slack' }), null, 'another app\'s row does not open');
            assert.strictEqual(await vault.open(db, other, 'github', 'default', { config }), null, 'another person gets nothing');
        });

        await check('a refused test call stores nothing', async () => {
            const app = await startApp((req, res) => {
                res.writeHead(401, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ message: 'Bad credentials' }));
            });
            try {
                const def = { key: 'github', name: 'GitHub', apiHost: app.host, auth: { kind: 'token', fields: [{ name: 'default', label: 'Token', where: 'header', header: 'Authorization', scheme: 'Bearer' }] }, test: { method: 'GET', path: '/user' }, actions: [] };
                const { createGateway } = require('../server/connect/gateway');
                const gateway = createGateway({ db, config, defs: [def] });
                let refused = null;
                try {
                    await gateway.test({ subject: owner, appKey: 'github', credential: 'wrong-token', requestOptions: app.options });
                } catch (e) { refused = e; }
                assert.ok(refused, 'the refused test call throws');
                assert.strictEqual(refused.status, 400);
                const rows = await db.prepare('SELECT COUNT(*) AS c FROM connect_credentials WHERE subject = ? AND app = ?').get(owner, 'github');
                assert.strictEqual(Number(rows.c), 1, 'only the credential stored before is there');
            } finally { await app.stop(); }
        });

        await check('the export lists the apps, never the secrets', async () => {
            await vault.store(db, owner, 'slack', 'default', 'xoxb-' + crypto.randomBytes(8).toString('hex'), { config });
            const apps = await vault.exportFor(db, owner);
            assert.deepStrictEqual(apps.sort(), ['github', 'slack']);
            const text = JSON.stringify(apps);
            assert.ok(!text.includes(SECRET) && !text.includes('xoxb-'), 'no secret in the export');
        });

        await check('the deletion erases the credentials', async () => {
            const out = await vault.eraseFor(db, owner);
            assert.ok(out.erased >= 2, 'the credentials are gone');
            assert.deepStrictEqual(await vault.list(db, owner), []);
            assert.deepStrictEqual(await vault.exportFor(db, owner), []);
            const rows = await db.prepare('SELECT COUNT(*) AS c FROM connect_credentials WHERE subject = ?').get(owner);
            assert.strictEqual(Number(rows.c), 0, 'the rows are gone, not just hidden');
        });

        await check('without the key the feature is off (503), never plaintext', async () => {
            const noKey = { secrets: { key: '' } };
            let err = null;
            try { await vault.store(db, owner, 'github', 'default', SECRET, { config: noKey }); } catch (e) { err = e; }
            assert.ok(err && err.status === 503 && err.code === 'connect.vault_unavailable', 'the vault is off');
            const rows = await db.prepare('SELECT COUNT(*) AS c FROM connect_credentials WHERE subject = ? AND app = ?').get(owner, 'github');
            assert.strictEqual(Number(rows.c), 0, 'nothing was stored');
        });

        await check('a credential is listed with its app, label, scopes and times', async () => {
            await vault.store(db, owner, 'github', 'default', SECRET, { scopes: ['Issues: read'], config });
            const list = await vault.list(db, owner);
            assert.strictEqual(list.length, 1);
            assert.strictEqual(list[0].app, 'github');
            assert.strictEqual(list[0].label, 'default');
            assert.deepStrictEqual(list[0].scopes, ['Issues: read']);
            assert.ok(list[0].created_at, 'when it was added');
            assert.strictEqual(list[0].last_used_at, null, 'not used yet');
            await vault.touch(db, list[0].id);
            const after = await vault.list(db, owner);
            assert.ok(after[0].last_used_at, 'when it was last used');
        });
    } finally {
        console.log = quiet;
    }
    console.log(failures ? `\n${failures} failed` : '\nconnect vault: all checks passed');
    process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
