/**
 * Run sessions' grants (contracts 0.223.0, the Desks plan's D6): OpenVibe.Run holds bot.desk.session on OpenVibe.Bot (a
 * desk leased per session, for its person) and nothing else of Bot's computer control; OpenVibe.Actor holds the three
 * session capabilities on Run, to work in a browser session for the person it acts for.
 *
 *   node test/run-session-grants.test.js
 */
'use strict';
const assert = require('assert');
const contracts = require('openvibe-contracts');
const principals = require('../server/identity/principals');

const of = (svc, aud) => principals.DEFAULT_GRANTS.filter((g) => g[0] === svc && g[2] === aud).map((g) => g[1]).sort();
assert.deepStrictEqual(of('run', 'openvibe.bot'), ['bot.desk.session', 'bot.job.dispatch'], 'run dispatches jobs and leases desks on Bot, and holds no computer control there');
assert.deepStrictEqual(of('actor', 'openvibe.run'), ['run.session.control', 'run.session.create', 'run.session.read'], 'actor uses Run sessions');
const ids = ['bot.desk.session', 'run.session.create', 'run.session.read', 'run.session.control'];
const missing = ids.filter((id) => { const cap = contracts.capabilities.get(id); return !(cap && cap.status === 'active'); });
assert.deepStrictEqual(missing, [], 'every one is an active capability in the pinned contracts');
console.log('run session grants: ok');
