'use strict';
// The URL registry seeds its bootstrap values on first boot and resolves them; the process database
// already migrated (test/helpers/pg-preload.mjs). Only the bootstrap rows are added here.
const assert = require('assert');
const urlRegistry = require('../server/url-registry');
const { getDb } = require('../server/db/database');

(async () => {
const db = await getDb();
urlRegistry.initializeUrlRegistry(db);
await urlRegistry.seedBootstrapRegistry(db, { OV_LIVE_URL: 'https://bootstrap.example.com', OV_NETWORK_URL: 'https://openvibe.network' }, 'local-dev');
const resolved = await urlRegistry.getResolvedRegistry(db, {});
assert.strictEqual(resolved.OV_LIVE_URL.value, 'https://bootstrap.example.com');
assert.strictEqual(resolved.OV_LIVE_URL.source, 'bootstrap');
assert.strictEqual(resolved.OV_NETWORK_URL.value, 'https://openvibe.network');
assert.strictEqual(resolved.OV_NETWORK_URL.source, 'bootstrap');
assert.strictEqual(resolved.WHIP_PUBLIC_URL.value, 'http://localhost:3000');
assert.strictEqual(resolved.WHIP_PUBLIC_URL.source, 'bootstrap');
assert.strictEqual(resolved.OV_NETWORK_INTERNAL_URL.value, 'http://127.0.0.1:4000');
assert.strictEqual(resolved.OV_MEDIA_INTERNAL_URL.value, 'http://127.0.0.1:4100');
assert.strictEqual(resolved.OV_LIVE_INTERNAL_URL.value, 'http://127.0.0.1:3000');
assert.strictEqual(resolved.OV_LIVE_INTERNAL_URL.source, 'bootstrap');

const storedExtra = await db.prepare('SELECT key, value, type FROM url_registry WHERE key = ?').get('ALLOWED_EXTRA_ORIGINS');
assert.strictEqual(storedExtra.type, 'json_array');
assert.strictEqual(storedExtra.value, '[]');
assert.deepStrictEqual((await urlRegistry.getAllRegistryEntries(db)).find(e => e.key === 'ALLOWED_EXTRA_ORIGINS').value, []);

const updated = await urlRegistry.setRegistryEntry(db, 'ALLOWED_EXTRA_ORIGINS', ['https://cdn.example.com'], null);
assert.deepStrictEqual(updated.value, ['https://cdn.example.com']);
assert.deepStrictEqual((await urlRegistry.getAllRegistryEntries(db)).find(e => e.key === 'ALLOWED_EXTRA_ORIGINS').value, ['https://cdn.example.com']);

const scalarUpdated = await urlRegistry.setRegistryEntry(db, 'NETWORK_NAME', 'CoolTools', null);
assert.strictEqual(scalarUpdated.value, 'CoolTools');
assert.strictEqual((await urlRegistry.getAllRegistryEntries(db)).find(e => e.key === 'NETWORK_NAME').value, 'CoolTools');

const overrides = await urlRegistry.loadOverrides(db);
assert.deepStrictEqual(overrides.ALLOWED_EXTRA_ORIGINS, ['https://cdn.example.com']);
assert.strictEqual(overrides.NETWORK_NAME, 'CoolTools');

console.log('✅ openvibe-network registry bootstrap test passed');
})().catch(err => { console.error(err); process.exit(1); });
