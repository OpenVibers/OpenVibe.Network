'use strict';
/**
 * OpenVibe.Git (G1, 2026-11-09): Codes holds git.read and git.write for the audience openvibe.git, so it can make a
 * repository for the person signed in, list theirs and mint their clone token, acting as that person (X-OV-Subject).
 * The capability names are OpenVibe.Git's own; no other service holds them yet, and no other audience does.
 */
const assert = require('assert');
const principals = require('../server/identity/principals');

const grant = (client, cap) => principals.DEFAULT_GRANTS.find((g) => g[0] === client && g[1] === cap && g[2] === 'openvibe.git');
for (const cap of ['git.read', 'git.write']) {
    const g = grant('codes', cap);
    assert.ok(g, `codes may ${cap} on OpenVibe Git`);
    assert.deepStrictEqual(g[3], [], `${cap} carries no namespace`);
    assert.ok(!principals.DEFAULT_GRANTS.some((row) => row[1] === cap && row[2] !== 'openvibe.git'),
        `${cap} is granted for OpenVibe Git and for no other audience`);
}
assert.deepStrictEqual(principals.DEFAULT_GRANTS.filter((g) => g[2] === 'openvibe.git').map((g) => [g[0], g[1]]),
    [['codes', 'git.read'], ['codes', 'git.write']], 'Codes alone, as the first service that calls it');
console.log('git grants: ok');
