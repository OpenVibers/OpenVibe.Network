'use strict';
/**
 * D11: a secret-class value copied into site_settings is blanked at boot once the sealed config journal holds it.
 * A provider secret managed by server/secrets.js is environment-only and is never moved or blanked. Readers get
 * the journal's value, and no summary or log carries the plaintext.
 *
 *   node --import ./test/helpers/pg-preload.mjs test/legacy-secrets-kek.test.js
 */
const assert = require('assert');
process.env.NODE_ENV = 'test';
process.env.OV_CONFIG_KEKS = `k1:${Buffer.alloc(32, 9).toString('base64')}`;
process.env.OV_CONFIG_KEK_CURRENT = 'k1';
for (const n of ['NET_IPINFO_TOKEN', 'NET_GLOBALPING_TOKEN', 'DISCORD_BOT_TOKEN']) delete process.env[n];

const SECRET = 'sentinel-not-a-secret-ipinfo';
const PROVIDER = 'sentinel-not-a-secret-provider-token';
const logs = [];
const real = { log: console.log, warn: console.warn, error: console.error };
console.log = (...a) => logs.push(a.map(String).join(' '));
console.warn = (...a) => logs.push(a.map(String).join(' '));
console.error = (...a) => logs.push(a.map(String).join(' '));

(async () => {
    const db = await require('../server/db/database').getDb();
    const set = db.prepare('INSERT INTO site_settings (key, value, type) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, type = excluded.type');
    await set.run('net.ipinfo_token', SECRET, 'secret');
    await set.run('discord_bot_token', PROVIDER, 'secret');
    await set.run('platform_name', 'OpenVibe', 'string');
    // The VAPID public key (served to browsers) has an old 'secret' row type: it is not configuration, not counted.
    await set.run('vapid_public_key', 'sentinel-vapid-public', 'secret');

    const siteConfig = require('../server/admin/site-config');
    const report = await siteConfig.init(db);
    const journal = await siteConfig.forDb(db);
    assert.strictEqual(journal.store.sealed, true);
    assert.strictEqual(report.blanked, 1, 'the non-provider secret row was blanked');
    assert.strictEqual(report.differs, 0, 'an equal value is not counted as differing');
    assert.strictEqual(report.checked, 1, 'a non-configuration row (vapid_public_key) is not a candidate');

    const raw = async (k) => (await db.prepare('SELECT value, type FROM site_settings WHERE key = ?').get(k));
    assert.strictEqual((await raw('net.ipinfo_token')).value, '', 'no secret-class value remains in site_settings');
    assert.strictEqual((await raw('net.ipinfo_token')).type, 'secret', 'the typed slot stays for the settings page');
    assert.strictEqual((await raw('discord_bot_token')).value, PROVIDER, 'a provider secret is never moved or blanked');
    assert.strictEqual((await raw('platform_name')).value, 'OpenVibe', 'a non-secret row is untouched');
    assert.strictEqual((await raw('vapid_public_key')).value, 'sentinel-vapid-public', 'the VAPID public key is untouched');

    assert.strictEqual(await db.getSetting('net.ipinfo_token'), SECRET, 'the reader gets the journal value');
    assert.strictEqual(await db.getSetting('discord_bot_token'), null, 'a provider secret is still environment-only');

    const summary = JSON.stringify(await journal.store.summary());
    assert.ok(!summary.includes(SECRET), 'the summary carries no value');
    const stored = await db.prepare("SELECT values_json FROM config_snapshots WHERE namespace = 'network.site_settings' AND state = 'active'").get();
    assert.ok(!stored.values_json.includes(SECRET), 'values_json holds no plaintext');
    assert.ok(stored.values_json.includes('\"v1:'), 'the secret is stored as an envelope');
    assert.ok(!logs.join('\n').includes(SECRET) && !logs.join('\n').includes(PROVIDER), 'no log line carries a value');

    await journal.change({ set: { 'net.globalping_token': 'sentinel-rotated' }, types: { 'net.globalping_token': 'secret' } }, { reason: 'rotate' });
    assert.strictEqual((await raw('net.globalping_token')).value, '', 'a new token is not written to the legacy row');
    assert.strictEqual(await db.getSetting('net.globalping_token'), 'sentinel-rotated', 'the rotated token is read from the journal');

    // A legacy row newer than the journal is kept, not blanked: the journal does not hold this value.
    await journal.change({ set: { 'net.globalping_token': 'store-side-token' }, types: { 'net.globalping_token': 'secret' } }, { reason: 'store side' });
    await set.run('net.globalping_token', 'legacy-side-token', 'secret');
    // A secret row the journal does not hold at all is kept too.
    await set.run('ses_secret_access_key', 'legacy-only-secret', 'string');
    const kept = await siteConfig.migrateLegacySecrets(db, journal);
    assert.strictEqual(kept.blanked, 0, 'a differing value is never blanked');
    assert.strictEqual(kept.differs, 2, 'one unequal value and one the journal does not hold');
    assert.strictEqual((await raw('net.globalping_token')).value, 'legacy-side-token', 'the newer legacy value is kept');
    assert.strictEqual((await raw('ses_secret_access_key')).value, 'legacy-only-secret', 'the only copy is kept');
    assert.strictEqual(await db.getSetting('net.globalping_token'), 'store-side-token', 'the reader keeps the journal value');
    assert.ok(!logs.join('\n').includes('store-side-token') && !logs.join('\n').includes('legacy-side-token') && !logs.join('\n').includes('legacy-only-secret'), 'no log line carries either side');

    real.log('legacy secrets (KEK): all checks passed');
    process.exit(0);
})().catch((err) => { real.error(err); process.exit(1); });
