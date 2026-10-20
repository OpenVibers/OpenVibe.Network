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
// /oauth/authorize (every site's sign-in and silent check, no password) has its own zone: under the password
// endpoints' 5 a minute it refused 304 sign-ins from 15 visitors on 2026-10-20. Sign-in and registration keep 5.
assert.ok(/zone=openvibenetwork_authorize:10m rate=60r\/m;/.test(conf), 'authorize: 60 a minute per address');
const block = (re) => { const m = re.exec(conf); assert.ok(m, String(re)); return conf.slice(m.index, conf.indexOf('}', m.index)); };
assert.match(block(/location = \/oauth\/authorize \{/), /limit_req zone=openvibenetwork_authorize burst=60 nodelay;/);
const strict = /location ~ (\S+) \{\s*limit_req zone=openvibenetwork_auth burst=5 nodelay;/.exec(conf);
assert.ok(strict && /register\|login/.test(strict[1]) && !/authorize/.test(strict[1]), 'the strict zone covers sign-in and registration, not authorize');
assert.ok(/zone=openvibenetwork_auth:10m rate=5r\/m;/.test(conf));
console.log('api rate limit: all checks passed');
