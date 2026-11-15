'use strict';
/**
 * OpenVibe.Git (G1, 2026-11-09): Codes holds git.repo.read and git.repo.write for the audience openvibe.git, so it
 * can make a repository for the person signed in, list theirs and mint their clone token, acting as that person
 * (X-OV-Subject). The capability names are OpenVibe.Git's own. They arrive with the Contracts version that defines
 * them; until the pin moves, the grants are absent rather than unknown to the catalog, and this test holds the two
 * to each other.
 */
const assert = require('assert');
const { capabilities } = require('openvibe-contracts');
const principals = require('../server/identity/principals');

const CAPS = ['git.repo.read', 'git.repo.write'];
const grant = (client, cap) => principals.DEFAULT_GRANTS.find((g) => g[0] === client && g[1] === cap && g[2] === 'openvibe.git');

for (const cap of CAPS) {
    const known = !!(capabilities.get(cap) && capabilities.get(cap).owner === 'git');
    const g = grant('codes', cap);
    assert.strictEqual(!!grant('actor', cap), known, `Actor may ${cap} on OpenVibe Git when Contracts knows it`);
    assert.strictEqual(!!g, known, known ? `codes may ${cap} on OpenVibe Git` : `${cap} is not in this Contracts yet, so no grant names it`);
    if (!known) continue;
    assert.deepStrictEqual(g[3], [], `${cap} carries no namespace`);
    assert.ok(!principals.DEFAULT_GRANTS.some((row) => row[1] === cap && row[2] !== 'openvibe.git'),
        `${cap} is granted for OpenVibe Git and for no other audience`);
}
assert.deepStrictEqual(principals.DEFAULT_GRANTS.filter((g) => g[2] === 'openvibe.git').map((g) => [g[0], g[1]]),
    CAPS.every((c) => capabilities.get(c)) ? [['codes', 'git.repo.read'], ['codes', 'git.repo.write'], ['actor', 'git.repo.read'], ['actor', 'git.repo.write'], ['space', 'git.repo.read'], ['space', 'git.repo.write']] : [],
    'Codes, a person\'s Actor (plan §AD.10 step 1: its git_* tools act as the person) and Space (step 2: publishing from a repository)');
// Plan §AD.10 step 2: Git deploys a person's site on Space as them, and does nothing else on Space.
assert.deepStrictEqual(principals.DEFAULT_GRANTS.filter((g) => g[0] === 'git').map((g) => [g[1], g[2], g[3]]), [['space.deploy.create', 'openvibe.space', []]], 'Git may deploy a person\'s Space site, and only that');
console.log('git grants: ok');
