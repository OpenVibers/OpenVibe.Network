'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { capabilities } = require('openvibe-contracts');
const { DEFAULT_GRANTS, SELF_AUDIENCE } = require('../server/identity/principals');

test('Mail can read trust and check only the owner of a verified account email', () => {
    for (const cap of ['identity.trust.read', 'identity.emails.read']) {
        assert.ok(capabilities.get(cap), `${cap} must be defined by the pinned Contracts release`);
        assert.deepEqual(DEFAULT_GRANTS.find(([client, name, audience]) => client === 'mail' && name === cap && audience === SELF_AUDIENCE),
            ['mail', cap, SELF_AUDIENCE, []]);
    }
});
