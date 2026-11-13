/**
 * The evaluation loop (Contracts 0.422.0): Codes records its races and Run the Arena's race plays as bench.match@1 at
 * Bench's POST /api/v1/matches, which takes bench.judgement.cast on audience openvibe.bench.
 *
 *   node test/bench-matches-grant.test.js
 */
'use strict';
const assert = require('assert');
const contracts = require('openvibe-contracts');
const principals = require('../server/identity/principals');

const has = (svc, cap, aud) => principals.DEFAULT_GRANTS.some((g) => g[0] === svc && g[1] === cap && g[2] === aud);
for (const svc of ['codes', 'run']) assert.ok(has(svc, 'bench.judgement.cast', 'openvibe.bench'), `${svc} records matches on Bench`);
const cap = contracts.capabilities.get('bench.judgement.cast');
assert.ok(cap && cap.status === 'active' && cap.owner === 'bench', 'bench.judgement.cast is an active Bench capability');
console.log('bench matches grant: ok');
