'use strict';
// A site's OAuth client created first as a service principal (server/setup/service-principal.js names it
// "OpenVibe.<id> (service)") gets the site's name from the seed, so the sign-in page says "OpenVibe.Food"; a name someone
// chose is left alone.
const assert = require('assert');
const { getDb, seedDb } = require('../server/db/database');

(async () => {
    const db = getDb();
    const log = { log() {}, warn() {}, error() {} };
    const quiet = console.log; console.log = () => {};
    await seedDb(db, { log });

    await db.prepare("UPDATE oauth_clients SET name = 'OpenVibe.food (service)' WHERE client_id = 'food'").run();
    await db.prepare("UPDATE oauth_clients SET name = 'Our own name' WHERE client_id = 'help'").run();
    await seedDb(db, { log });
    console.log = quiet;

    const name = async (id) => (await db.prepare('SELECT name FROM oauth_clients WHERE client_id = ?').get(id)).name;
    assert.strictEqual(await name('food'), 'OpenVibe.Food', 'the placeholder name becomes the site name');
    assert.strictEqual(await name('help'), 'Our own name', 'a chosen name stays');
    assert.strictEqual(await name('work'), 'OpenVibe.Work', 'a seeded client has its name');
    assert.strictEqual(await name('mail'), 'OpenVibe.Email', 'the mail site client carries the site name, not the service name');
    const mail = await db.prepare('SELECT redirect_uris, is_first_party FROM oauth_clients WHERE client_id = ?').get('mail');
    assert.deepStrictEqual(JSON.parse(mail.redirect_uris), ['https://openvibe.email/auth/callback'], 'the only callback is openvibe.email');
    assert.strictEqual(mail.is_first_party, 1, 'the site client is first-party');
    const git = await db.prepare('SELECT name, redirect_uris, is_first_party FROM oauth_clients WHERE client_id = ?').get('git');
    assert.strictEqual(git.name, 'OpenVibe Git', 'the new site signs people in with OpenVibe');
    assert.deepStrictEqual(JSON.parse(git.redirect_uris), ['https://git.openvibe.codes/auth/callback'], 'one callback on git.openvibe.codes');
    assert.strictEqual(git.is_first_party, 1);
    assert.ok(await db.prepare('SELECT 1 AS one FROM oauth_clients WHERE client_id = ?').get('forgejo'), 'Forgejo\'s client stays until the cut-over');
    const uris = async () => JSON.parse((await db.prepare('SELECT redirect_uris FROM oauth_clients WHERE client_id = ?').get('inventory')).redirect_uris);
    assert.ok((await uris()).includes('https://openvibe.my/inventory/auth/callback'));
    await db.prepare('UPDATE oauth_clients SET redirect_uris = ? WHERE client_id = ?')
        .run(JSON.stringify(['https://inventory.openvibe.network/auth/callback', 'https://inventory.openvibe.network/extra']), 'inventory');
    console.log = () => {};
    await seedDb(db, { log });
    console.log = quiet;
    assert.ok((await uris()).includes('https://openvibe.my/inventory/auth/callback'), 'existing clients gain the callback');
    assert.ok((await uris()).includes('https://inventory.openvibe.network/extra'), 'custom callbacks survive');
    console.log('client-names: ok');
})().catch((err) => { console.error(err); process.exit(1); });
