'use strict';
// A site's full name (server/frame/sites.js fullName): OpenRestream is a brand of its own, never "OpenVibe.OpenRestream"
// (the owner's screenshot of the home page's cards, 2026-10-28); the others are OpenVibe.<name>.
const assert = require('assert');
const { SITES, fullName } = require('../server/frame/sites');

assert.strictEqual(fullName({ name: 'OpenRestream' }), 'OpenRestream');
assert.strictEqual(fullName({ name: 'Live' }), 'OpenVibe.Live');
assert.strictEqual(fullName({ name: 'VIP' }), 'OpenVibe.VIP');
const names = SITES.map(fullName);
assert.ok(names.includes('OpenRestream'), 'the catalog has OpenRestream');
assert.ok(!names.some((n) => /^OpenVibe\.Open/.test(n)), `no doubled brand: ${names.filter((n) => /^OpenVibe\.Open/.test(n))}`);
console.log('site-names: OpenRestream is its own name, the rest OpenVibe.<name> ok');
