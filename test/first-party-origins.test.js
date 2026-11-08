'use strict';
// The CORS allow-list takes every first-party domain from the service manifests, so a new site's
// shared navbar can reach /api/auth/me (openvibe.blog once showed "Sign In" to signed-in people).
//   node test/first-party-origins.test.js
const assert = require('assert');
const { manifestOrigins } = require('../server/first-party-origins');

const o = manifestOrigins();
assert(o.has('https://openvibe.computer'), 'Computer is allowed for Network signed-in navbar calls before the Contracts pin lands');
for (const want of ['https://openvibe.blog', 'https://openvibe.wiki', 'https://openvibe.codes', 'https://search.openvibe.network', 'https://openvibe.live', 'https://my.openvibe.network', 'https://openvibe.party']) {
    assert.ok(o.has(want), `${want} is a first-party origin`);
}
for (const origin of o) assert.ok(/^https:\/\/[a-z0-9.-]+$/.test(origin), `${origin} is an exact https origin`);
assert.ok(![...o].some((x) => x.includes('*')), 'never a wildcard');
assert.ok(!o.has('https://evil.example'));
console.log('first-party-origins: all checks passed');
