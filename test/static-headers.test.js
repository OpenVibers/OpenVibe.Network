'use strict';
// Brand assets are readable from every OpenVibe site (the placeholders' logo was blocked by CORP).
const assert = require('assert');
const { publicStaticHeaders } = require('../server/static-headers');
const res = () => { const h = {}; return { h, setHeader: (k, v) => { h[k] = v; } }; };
let r = res(); publicStaticHeaders(r, '/opt/openvibe.network/public/assets/logo.svg');
assert.strictEqual(r.h['Cross-Origin-Resource-Policy'], 'cross-origin');
assert.strictEqual(r.h['Cache-Control'], 'public, max-age=86400');
r = res(); publicStaticHeaders(r, '/opt/openvibe.network/public/js/app.js');
assert.strictEqual(r.h['Cache-Control'], 'no-cache');
assert.strictEqual(r.h['Cross-Origin-Resource-Policy'], undefined, 'only brand assets are cross-origin');
r = res(); publicStaticHeaders(r, '/opt/openvibe.network/public/index.html');
assert.deepStrictEqual(r.h, {});
console.log('static headers: all checks passed');
