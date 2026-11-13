/**
 * Every AI call measured (contracts 0.421.0, ai-metrics.md): the products that make model calls without OpenVibe.AI
 * report them to AI's POST /api/v1/usage/calls with ai.usage.report on audience openvibe.ai. Only those four hold it,
 * and AI itself does not (it publishes its own calls).
 *
 *   node test/ai-usage-report-grant.test.js
 */
'use strict';
const assert = require('assert');
const contracts = require('openvibe-contracts');
const principals = require('../server/identity/principals');

const holders = principals.DEFAULT_GRANTS.filter((g) => g[1] === 'ai.usage.report').map((g) => [g[0], g[2]]);
assert.deepStrictEqual(holders, [['actor', 'openvibe.ai'], ['bot', 'openvibe.ai'], ['codes', 'openvibe.ai'], ['chat', 'openvibe.ai']]);
const cap = contracts.capabilities.get('ai.usage.report');
assert.ok(cap && cap.status === 'active' && cap.owner === 'ai', 'ai.usage.report is an active AI capability in the pinned contracts');
console.log('ai usage report grant: ok');
