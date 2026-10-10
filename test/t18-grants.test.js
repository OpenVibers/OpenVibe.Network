/**
 * OpenVibe.Watch's grants (plan T18): it publishes its events, resolves a watch's owner and pushes them a notification
 * (step 4), and gives Actor a task for the owner (step 6, audience openvibe.actor). Each capability it holds is one
 * the pinned contracts offer, active.
 *
 *   node test/t18-grants.test.js
 */
'use strict';
const assert = require('assert');
const contracts = require('openvibe-contracts');
const principals = require('../server/identity/principals');

const rows = principals.DEFAULT_GRANTS.filter((g) => g[0] === 'watch');
const held = new Set(rows.map((g) => `${g[1]}@${g[2]}`));
for (const want of [
    'actor.task.create@openvibe.actor',
    'events.event.publish@openvibe.events',
    `identity.subject.resolve@${principals.SELF_AUDIENCE}`,
    `network.notifications.push@${principals.SELF_AUDIENCE}`,
]) assert.ok(held.has(want), `watch holds ${want}`);
for (const g of rows) {
    const cap = contracts.capabilities.get(g[1]);
    assert.ok(cap && cap.status === 'active', `${g[1]} is an active capability`);
}
console.log(`t18 grants: ${rows.length}`);
