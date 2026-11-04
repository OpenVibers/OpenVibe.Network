'use strict';
/**
 * D11: without a KEK the config journal is not sealed and NO legacy secret value is blanked. Readers still get
 * the value from the journal (as before), and a provider secret stays environment-only.
 *
 *   node --import ./test/helpers/pg-preload.mjs test/legacy-secrets-nokek.test.js
 */
const assert = require('assert');
process.env.NODE_ENV = 'test';
delete process.env.OV_CONFIG_KEKS;
delete process.env.OV_CONFIG_KEK_CURRENT;
delete process.env.NET_IPINFO_TOKEN;

const SECRET = 'sentinel-not-a-secret-no-kek';
const real = { log: console.log, error: console.error };
console.log = () => {}; console.warn = () => {}; console.error = () => {};

(async () => {
    const db = await require('../server/db/database').getDb();
    await db.prepare('INSERT INTO site_settings (key, value, type) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, type = excluded.type').run('net.ipinfo_token', SECRET, 'secret');

    const siteConfig = require('../server/admin/site-config');
    const report = await siteConfig.init(db);
    const journal = await siteConfig.forDb(db);
    assert.strictEqual(journal.store.sealed, false, 'the journal is not sealed without a KEK');
    assert.strictEqual(report.blanked, 0, 'nothing is blanked without a sealed journal');

    const row = await db.prepare('SELECT value FROM site_settings WHERE key = ?').get('net.ipinfo_token');
    assert.strictEqual(row.value, SECRET, 'the only copy is still the legacy row');
    assert.strictEqual(await db.getSetting('net.ipinfo_token'), SECRET, 'the reader still gets its value');

    real.log('legacy secrets (no KEK): all checks passed');
    process.exit(0);
})().catch((err) => { real.error(err); process.exit(1); });
