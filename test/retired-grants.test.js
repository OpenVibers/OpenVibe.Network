'use strict';
// Retired grants stay retired: the Live read mirror was removed on both sides (Chat #25, Live), so Chat's
// live.chat_mirror.write grant is revoked at every boot and no default hands it out again.
const assert = require('assert');
const { getDb } = require('../server/db/database');

(async () => {
const log = console.log; console.log = () => {};
const db = await getDb();
console.log = log;
const principals = require('../server/identity/principals');
await db.prepare("INSERT INTO oauth_clients (client_id, client_secret, name, redirect_uris, is_first_party) VALUES ('chat', 'x', 'chat', '[]', 1) ON CONFLICT DO NOTHING").run();
const grant = async (cap) => (await principals.grantsFor(db, 'chat', 'openvibe.live')).find((g) => g.capability === cap);

// A database as an older release left it: Chat still holds the mirror grant.
await principals.ensureSchema(db);
await db.prepare("INSERT INTO principal_grants (client_id, capability, audience, namespaces, granted_by) VALUES ('chat', 'live.chat_mirror.write', 'openvibe.live', '[]', 'default') ON CONFLICT (client_id, capability, audience) DO UPDATE SET revoked_at = NULL").run();
assert.ok(await grant('live.chat_mirror.write'), 'the old mirror grant is there before the boot');

await principals.ensureSchema(db); // the next boot
assert.strictEqual(await grant('live.chat_mirror.write'), undefined, 'the mirror grant is revoked at boot');
assert.ok(await grant('live.chat_effects.write'), 'Chat keeps its effects grant');
assert.ok(!principals.DEFAULT_GRANTS.some(([c, cap]) => c === 'chat' && cap === 'live.chat_mirror.write'), 'no default hands it out');

console.log('retired grants: all checks passed');
})().catch(err => { console.error(err); process.exit(1); });
