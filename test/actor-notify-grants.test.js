/**
 * OpenVibe.Actor's notification grants (Desks plan D4, "hand it to me"): when an agent needs its person for a step on
 * its desk, Actor resolves the task's owner and pushes them a notification as app 'actor', and holds nothing else of
 * Network's notifications. Each is a capability the pinned contracts offer, active.
 *
 *   node test/actor-notify-grants.test.js
 */
'use strict';
const assert = require('assert');
const contracts = require('openvibe-contracts');
const principals = require('../server/identity/principals');

const rows = principals.DEFAULT_GRANTS.filter((g) => g[0] === 'actor' && g[2] === principals.SELF_AUDIENCE);
const held = new Map(rows.map((g) => [g[1], g[3]]));
assert.ok(held.has('identity.subject.resolve'), 'actor resolves the task owner');
assert.deepStrictEqual(held.get('network.notifications.push'), ['actor'], 'actor pushes as its own app only');
for (const g of rows) {
    const cap = contracts.capabilities.get(g[1]);
    assert.ok(cap && cap.status === 'active', `${g[1]} is an active capability`);
}
console.log(`actor notify grants: ${rows.length}`);
