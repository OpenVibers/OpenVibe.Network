/**
 * Live's Bench grants (item 151, Bench #105): Live submits its AI clip picks to the private kind live.clip, and casts
 * no judgements of its own (people judge them blind). Its entries carry `rec:vod_*`: Bench #111 refuses an entry for a
 * recording the token is not granted (item 151 C19).
 *
 *   node test/live-bench-grant.test.js
 */
'use strict';
const assert = require('assert');
const contracts = require('openvibe-contracts');
const principals = require('../server/identity/principals');

const rows = principals.DEFAULT_GRANTS.filter((g) => g[0] === 'live' && g[2] === 'openvibe.bench');
assert.deepStrictEqual(rows.map((g) => g[1]).sort(), ['bench.entry.create', 'bench.round.create', 'bench.task.create'], 'tasks, rounds and entries; never a judgement');
for (const g of rows) {
    // An entry names its recording, and Bench refuses a recording the token is not granted (C19, Bench #111): Live's
    // entries carry its own VODs' namespace; tasks and rounds name no recording.
    assert.deepStrictEqual(g[3], g[1] === 'bench.entry.create' ? ['rec:vod_*'] : [], `${g[1]} namespaces`);
    const cap = contracts.capabilities.get(g[1]);
    assert.ok(cap, `${g[1]} is a capability`);
}
console.log('live bench grant: ok');
