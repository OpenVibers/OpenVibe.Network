/**
 * OpenVibe.Bench's notification grant (Bench B10, the model watch): when a followed score moves beyond its interval,
 * or a model overtakes the one someone follows, Bench pushes that person one notification through Network as app
 * 'bench'. It is the one grant Bench holds for notifications, and each is a capability the pinned contracts offer,
 * active.
 *
 *   node test/bench-notify-grants.test.js
 */
'use strict';
const assert = require('assert');
const contracts = require('openvibe-contracts');
const principals = require('../server/identity/principals');

const rows = principals.DEFAULT_GRANTS.filter((g) => g[0] === 'bench' && g[2] === principals.SELF_AUDIENCE);
const held = new Map(rows.map((g) => [g[1], g[3]]));

assert.deepStrictEqual(held.get('network.notifications.push'), ['bench'], 'bench pushes as its own app only');
assert.strictEqual(rows.filter((g) => g[1] === 'network.notifications.push').length, 1, 'exactly one push grant');

for (const g of rows) {
    const cap = contracts.capabilities.get(g[1]);
    assert.ok(cap && cap.status === 'active', `${g[1]} is an active capability`);
}

console.log(`bench notify grants: ${rows.length}`);
