'use strict';
// Plan L55 C1b: Actor holds bot.machine.watch_link on openvibe.bot (a chat turn shows the agent's desk, live), a
// capability the pinned contracts know, and nothing wider than it: the machines hub (bot.machine.manage) stays Network's.
//   node test/actor-watch-link-grant.test.js
const assert = require('assert');
const { capabilities } = require('openvibe-contracts');
const { DEFAULT_GRANTS } = require('../server/identity/principals');

const has = (client, cap, aud) => DEFAULT_GRANTS.some((g) => g[0] === client && g[1] === cap && g[2] === aud);
assert.ok(capabilities.get('bot.machine.watch_link'), 'the pinned openvibe-contracts knows the capability');
assert.ok(has('actor', 'bot.machine.watch_link', 'openvibe.bot'), 'Actor may ask Bot for a watch link');
assert.ok(has('actor', 'bot.computer.control', 'openvibe.bot'), 'beside the computer control it already had');
assert.ok(!has('actor', 'bot.machine.manage', 'openvibe.bot'), 'the machines hub is not Actor\'s');
assert.ok(!DEFAULT_GRANTS.some((g) => g[0] !== 'actor' && g[1] === 'bot.machine.watch_link'), 'no other client holds it');
console.log('actor watch-link grant: all checks passed');
