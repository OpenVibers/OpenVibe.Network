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
    console.log('client-names: ok');
})().catch((err) => { console.error(err); process.exit(1); });
