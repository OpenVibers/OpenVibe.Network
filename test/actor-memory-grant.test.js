/**
 * One memory (plan §V.1, 11-23): Actor writes a person's notes to OpenVibe.AI's store and recalls from it, on that
 * person's behalf; it holds no other memory capability and no other service gains one.
 *
 *   node test/actor-memory-grant.test.js
 */
'use strict';
const assert = require('assert');
const contracts = require('openvibe-contracts');
const principals = require('../server/identity/principals');

const rows = principals.DEFAULT_GRANTS.filter((g) => /^ai\.memory\./.test(g[1]));
assert.deepStrictEqual(rows.map((g) => [g[0], g[1], g[2], g[3]]).sort(), [
    ['actor', 'ai.memory.read', 'openvibe.ai', []],
    ['actor', 'ai.memory.write', 'openvibe.ai', []],
], 'Actor reads and writes AI memory; nobody else holds a memory grant');
for (const cap of ['ai.memory.read', 'ai.memory.write']) {
    const c = contracts.capabilities.get(cap);
    assert.ok(c && c.status === 'active', `${cap} is an active capability`);
}
console.log('actor memory grant: ok');
