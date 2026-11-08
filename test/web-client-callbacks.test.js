'use strict';
const assert = require('node:assert/strict');
const { getDb, seedDb } = require('../server/db/database');
(async () => {
    const db = await getDb();
    const clients = [['run', 'openvibe.run'], ['events', 'openvibe.events'], ['search', 'search.openvibe.network']];
    for (const [id] of clients) {
        const existing = await db.prepare('SELECT client_id FROM oauth_clients WHERE client_id = ?').get(id);
        assert.ok(!existing, 'boot does not provision a service principal');
        await db.prepare('INSERT INTO oauth_clients (client_id, client_secret, name, redirect_uris, is_first_party) VALUES (?, ?, ?, ?, 1)')
            .run(id, `test-${id}`, id, '["https://existing.example/callback"]');
    }
    const log = { log() {}, warn() {}, error() {} };
    await seedDb(db, { log }); await seedDb(db, { log });
    for (const [id, host] of clients) {
        const row = await db.prepare('SELECT client_secret, redirect_uris FROM oauth_clients WHERE client_id = ?').get(id);
        assert.equal(row.client_secret, `test-${id}`, 'the service keeps its credential');
        assert.deepEqual(JSON.parse(row.redirect_uris), ['https://existing.example/callback', `https://${host}/auth/callback`], 'idempotent exact callback union');
    }
    const rent = await db.prepare("SELECT redirect_uris FROM oauth_clients WHERE client_id = 'rent'").get();
    assert.ok(JSON.parse(rent.redirect_uris).includes('https://openvibe.homes/auth/callback'));
    const web = await db.prepare("SELECT is_public, redirect_uris FROM oauth_clients WHERE client_id = 'link-web'").get();
    assert.equal(Number(web.is_public || 0), 0);
    assert.deepEqual(JSON.parse(web.redirect_uris), ['https://openvibe.link/auth/callback']);
    const mobile = await db.prepare("SELECT redirect_uris FROM oauth_clients WHERE client_id = 'link'").get();
    assert.ok(!JSON.parse(mobile.redirect_uris).includes('https://openvibe.link/auth/callback'), 'mobile client stays separate');
    console.log('web client callbacks: exact URIs, idempotence and credential preservation passed');
})().catch(err => { console.error(err); process.exitCode = 1; });
