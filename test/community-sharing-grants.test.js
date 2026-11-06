/**
 * OpenVibe.Community's sharing grants (the pilot, 2026-11-06): a paste's screenshot is a private Media object that only
 * Community's checked proxy reads, the old unlisted copy is deleted after the move, and share notices go through the
 * inbox. Each is scoped to Community's own namespace, and each is an active capability the pinned contracts offer.
 *
 *   node test/community-sharing-grants.test.js
 */
'use strict';
const assert = require('assert');
const contracts = require('openvibe-contracts');
const principals = require('../server/identity/principals');

const grant = (cap, audience) => principals.DEFAULT_GRANTS.find((g) => g[0] === 'community' && g[1] === cap && g[2] === audience);
['media.object.upload', 'media.object.read', 'media.object.delete'].forEach((cap) => {
    const g = grant(cap, 'openvibe.media');
    assert.ok(g, `community holds ${cap} on openvibe.media`);
    assert.deepStrictEqual(g[3], ['community'], `${cap} is scoped to the community namespace only`);
});
const push = grant('network.notifications.push', principals.SELF_AUDIENCE);
assert.ok(push, 'community pushes share notices');
assert.deepStrictEqual(push[3], ['community'], 'as its own app only');
['media.object.read', 'media.object.delete', 'network.notifications.push'].forEach((cap) => {
    const c = contracts.capabilities.get(cap);
    assert.ok(c && c.status === 'active', `${cap} is an active capability`);
});
assert.ok(!grant('media.object.list', 'openvibe.media'), 'no list: Community names its objects, it never browses Media');
console.log('community sharing grants: upload, read, delete (community namespace) and push');
