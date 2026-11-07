/**
 * Space's builder as the person's one agent (plan 2026-10-22 §Z stage Z1): the grants that let the two services
 * work for the person.
 *
 *   Space  → OpenVibe.Actor   actor.task.create, actor.task.read   the task is the person's (X-OV-Subject)
 *   Actor  → OpenVibe.Space   space.build.read|create|write|publish  the agent works on the person's own spaces
 *
 * Each capability is one the pinned contracts offer, and it is active: a grant for a capability nobody knows
 * would be a grant that cannot be checked.
 *
 *   node test/space-builder-grants.test.js
 */
'use strict';
const assert = require('assert');
const contracts = require('openvibe-contracts');
const principals = require('../server/identity/principals');

const grants = principals.DEFAULT_GRANTS;

// Space asks Actor for a task on the person's behalf, and reads it back to follow it.
for (const cap of ['actor.task.create', 'actor.task.read']) {
    const row = grants.find((g) => g[0] === 'space' && g[1] === cap && g[2] === 'openvibe.actor');
    assert.ok(row, `space holds ${cap} on openvibe.actor`);
    assert.deepStrictEqual(row[3], [], 'no namespace: the task is the person\'s, not a project\'s');
    const known = contracts.capabilities.get(cap);
    assert.ok(known && known.status === 'active', `${cap} is an active capability`);
}

// The agent works on the person's own spaces through Space's builder API.
for (const cap of ['space.build.read', 'space.build.create', 'space.build.write', 'space.build.publish']) {
    const row = grants.find((g) => g[0] === 'actor' && g[1] === cap && g[2] === 'openvibe.space');
    assert.ok(row, `actor holds ${cap} on openvibe.space`);
    assert.deepStrictEqual(row[3], [], 'no namespace: the spaces are the person\'s own');
    const known = contracts.capabilities.get(cap);
    assert.ok(known && known.status === 'active', `${cap} is an active capability`);
    assert.strictEqual(known.owner, 'space', `${cap} belongs to space`);
}

console.log('space builder grants: the task is the person\'s, the spaces are the person\'s own');
