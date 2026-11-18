'use strict';
// Plan §AD.25 (Design's eyes): Actor holds vision.model.compare on openvibe.vision, so a page Link drew for the Design
// bot (computer_page_check) is judged by Vision's review panel (several models on Design's rules, their agreement
// counted). A capability the pinned contracts know, and nothing wider: Vision's faces, media and moderation stay out.
//   node test/actor-vision-review-grant.test.js
const assert = require('assert');
const { capabilities } = require('openvibe-contracts');
const { DEFAULT_GRANTS } = require('../server/identity/principals');

const has = (client, cap, aud) => DEFAULT_GRANTS.some((g) => g[0] === client && g[1] === cap && g[2] === aud);
assert.ok(capabilities.get('vision.model.compare'), 'the pinned openvibe-contracts knows the capability');
assert.ok(has('actor', 'vision.model.compare', 'openvibe.vision'), 'Actor may ask Vision for a review panel');
const actorVision = DEFAULT_GRANTS.filter((g) => g[0] === 'actor' && g[2] === 'openvibe.vision').map((g) => g[1]);
assert.deepStrictEqual(actorVision, ['vision.model.compare'], 'nothing else of Vision\'s: no faces, media or moderation');
console.log('actor vision review grant: all checks passed');
