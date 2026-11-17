'use strict';
/**
 * Plan §AD.22 (2026-11-17): a person's Codes conductor hands desktop and browser work to their Actor, acting as them
 * (X-OV-Subject). Codes holds exactly actor.task.create and actor.task.read for the audience openvibe.actor: it can start
 * a task for the person and follow it, and nothing else of Actor's (no cancel of someone's other tasks, no skills).
 * The way back, Actor's codes.task.* on openvibe.codes, is unchanged.
 */
const assert = require('assert');
const principals = require('../server/identity/principals');

const toActor = principals.DEFAULT_GRANTS.filter((g) => g[0] === 'codes' && g[2] === 'openvibe.actor').map((g) => g[1]).sort();
assert.deepStrictEqual(toActor, ['actor.task.create', 'actor.task.read'], `Codes' grants on openvibe.actor: ${toActor.join(', ')}`);
for (const cap of ['actor.task.create', 'actor.task.read']) {
    const row = principals.DEFAULT_GRANTS.find((g) => g[0] === 'codes' && g[1] === cap);
    assert.deepStrictEqual(row[3], [], `${cap} carries no extra scopes`);
}
const back = principals.DEFAULT_GRANTS.filter((g) => g[0] === 'actor' && g[2] === 'openvibe.codes').map((g) => g[1]).sort();
assert.deepStrictEqual(back, ['codes.task.cancel', 'codes.task.read', 'codes.task.start'], 'Actor to Codes is unchanged');
console.log('codes-actor grants: Codes may start and read a person\'s Actor tasks, nothing more; Actor to Codes unchanged');
