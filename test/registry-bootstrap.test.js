const assert = require('assert');
const Database = require('better-sqlite3');
const urlRegistry = require('../server/url-registry');

const db = new Database(':memory:');
urlRegistry.initializeUrlRegistry(db);
urlRegistry.seedBootstrapRegistry(db, { OV_LIVE_URL: 'https://bootstrap.example.com', OV_NETWORK_URL: 'https://openvibe.network' }, 'local-dev');
const resolved = urlRegistry.getResolvedRegistry(db, {});
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

const storedExtra = db.prepare('SELECT key, value, type FROM url_registry WHERE key = ?').get('ALLOWED_EXTRA_ORIGINS');
assert.strictEqual(storedExtra.type, 'json_array');
assert.strictEqual(storedExtra.value, '[]');
assert.deepStrictEqual(urlRegistry.getAllRegistryEntries(db).find(e => e.key === 'ALLOWED_EXTRA_ORIGINS').value, []);

const updated = urlRegistry.setRegistryEntry(db, 'ALLOWED_EXTRA_ORIGINS', ['https://cdn.example.com'], null);
assert.deepStrictEqual(updated.value, ['https://cdn.example.com']);
assert.deepStrictEqual(urlRegistry.getAllRegistryEntries(db).find(e => e.key === 'ALLOWED_EXTRA_ORIGINS').value, ['https://cdn.example.com']);

const scalarUpdated = urlRegistry.setRegistryEntry(db, 'NETWORK_NAME', 'CoolTools', null);
assert.strictEqual(scalarUpdated.value, 'CoolTools');
assert.strictEqual(urlRegistry.getAllRegistryEntries(db).find(e => e.key === 'NETWORK_NAME').value, 'CoolTools');

const overrides = urlRegistry.loadOverrides(db);
assert.deepStrictEqual(overrides.ALLOWED_EXTRA_ORIGINS, ['https://cdn.example.com']);
assert.strictEqual(overrides.NETWORK_NAME, 'CoolTools');

console.log('✅ openvibe-network registry bootstrap test passed');
