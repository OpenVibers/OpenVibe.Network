/**
 * OpenVibe.Tours' grants for its place guides (Tours #106): it uploads licensed place photos into its own Media
 * tenant only, and runs OpenVibe.AI's ai.summarize workflow only. Each is a capability the pinned contracts offer,
 * active.
 *
 *   node test/tours-grants.test.js
 */
'use strict';
const assert = require('assert');
const contracts = require('openvibe-contracts');
const principals = require('../server/identity/principals');

const tours = principals.DEFAULT_GRANTS.filter((g) => g[0] === 'tours');
const media = tours.filter((g) => g[2] === 'openvibe.media');
assert.deepStrictEqual(media.map((g) => [g[1], g[3]]), [['media.object.upload', ['tours']]], 'Tours uploads into its own tenant, nothing else of Media');
const ai = tours.filter((g) => g[2] === 'openvibe.ai');
assert.deepStrictEqual(ai.map((g) => [g[1], g[3]]).sort(), [['ai.run.create', ['ai.summarize']], ['ai.run.read', ['ai.summarize']]], 'Tours runs and reads only ai.summarize');
for (const g of [...media, ...ai]) {
    const cap = contracts.capabilities.get(g[1]);
    assert.ok(cap && cap.status === 'active', `${g[1]} is an active capability`);
}
console.log('Tours grants: its own Media tenant and ai.summarize only');
