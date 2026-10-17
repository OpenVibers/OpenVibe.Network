'use strict';
// The general /api/ limit per address matches nginx's (600 a minute): a person clicking through their account pages
// (each asks ~20 things at once) while other OpenVibe tabs poll their navbar must not be locked out. At 120 the fifth
// account page within 20 s answered 429 (2026-10-17). The sensitive routes keep their stricter limits.
//
//   node test/api-rate-limit.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '../server/index.js'), 'utf8');
assert.ok(src.includes("app.use('/api/', rateLimit({ windowMs: 60_000, max: 600 }));"), 'general API: 600 a minute per address');
assert.ok(src.includes("app.use('/api/auth/', rateLimit({ windowMs: 15 * 60_000, max: 30, skipSuccessfulRequests: true }));"), 'failed sign-ins stay at 30 per 15 minutes');
assert.ok(src.includes("app.use('/api/v1/node-pairing', rateLimit({ windowMs: 60_000, max: 10 })"), 'pairing stays at 10 a minute');
const conf = fs.readFileSync(path.join(__dirname, '../deploy/nginx/openvibe.network.conf'), 'utf8');
assert.ok(/zone=openvibenetwork_api:10m rate=10r\/s/.test(conf), "nginx's /api/ zone is the 10 r/s the app now matches");
console.log('api rate limit: all checks passed');
