'use strict';
// Loyalty is never money (ADR-012, roadmap WS-K task 9), on Network's side: nobody holds the OpenCoins
// transfer grant (rule 5; revoked again at every boot, even if a row comes back), no default grant hands
// it out, and Live may write its private live.loyalty summary (contracts 0.56.0), a row seeded under an
// older default gaining it at boot. The summary namespace is private: its values never leave publicly.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { modules } = require('openvibe-contracts');
const { initDb } = require('../server/db/database');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-loyalty-'));
const log = console.log; console.log = () => {};
const db = initDb(path.join(dir, 'network.db'));
console.log = log;
const principals = require('../server/identity/principals');
db.prepare("INSERT OR IGNORE INTO oauth_clients (client_id, client_secret, name, redirect_uris, is_first_party) VALUES ('live', 'x', 'live', '[]', 1)").run();
const aud = principals.SELF_AUDIENCE;
const grant = (cap) => principals.grantsFor(db, 'live', aud).find((g) => g.capability === cap);

// A database as an older release left it: Live's module grants without live.loyalty, and a transfer grant.
principals.ensureSchema(db);
db.prepare("UPDATE principal_grants SET namespaces = ? WHERE client_id = 'live' AND capability IN ('network.modules.read', 'network.modules.write')").run(JSON.stringify(['live.profile', 'live.stats']));
db.prepare("INSERT OR REPLACE INTO principal_grants (client_id, capability, audience, namespaces, granted_by) VALUES ('live', 'network.coins.transfer', ?, '[\"live\"]', 'default')").run(aud);
assert.ok(grant('network.coins.transfer'), 'the old transfer grant is there before the boot');

principals.ensureSchema(db); // the next boot
assert.strictEqual(grant('network.coins.transfer'), undefined, 'the transfer grant is revoked at boot');
assert.ok(principals.REVOKED_GRANTS.some(([c, cap]) => c === 'live' && cap === 'network.coins.transfer'));
assert.ok(!principals.DEFAULT_GRANTS.some(([, cap]) => cap === 'network.coins.transfer'), 'no default hands out the transfer grant');
for (const cap of ['network.modules.read', 'network.modules.write']) {
    assert.deepStrictEqual(grant(cap).namespaces, ['live.profile', 'live.stats', 'live.loyalty'], `${cap} gained live.loyalty`);
}

// live.loyalty is private: nothing of it appears in a public view.
const ns = modules.get('live.loyalty');
assert.ok(ns, 'openvibe-contracts declares live.loyalty');
assert.deepStrictEqual(ns.publicFields, []);
const record = { channel_points_total: 1200, channels: [{ channel: 'someone', points: 1200 }], arena_level: 3, arena_xp: 450 };
assert.deepStrictEqual(modules.publicView('live.loyalty', record), {}, 'no loyalty value is public');
assert.ok(modules.validateData('live.loyalty', record).valid, 'a real summary validates');
assert.ok(!modules.validateData('live.loyalty', { ...record, cashout_usd: 12 }).valid, 'a money field is refused');

fs.rmSync(dir, { recursive: true, force: true });
console.log('loyalty policy: all checks passed');
