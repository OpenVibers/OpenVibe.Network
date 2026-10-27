/**
 * OpenVibe.AI's grant on OpenVibe.Bot for AI on your own machines (contracts 0.219.0): it runs a model on a person's
 * own machine for that person (bot.machine.ai, audience openvibe.bot), and nothing else of Bot's computer control.
 *
 *   node test/ai-machine-grant.test.js
 */
'use strict';
const assert = require('assert');
const contracts = require('openvibe-contracts');
const principals = require('../server/identity/principals');

const onBot = principals.DEFAULT_GRANTS.filter((g) => g[0] === 'ai' && g[2] === 'openvibe.bot').map((g) => g[1]);
assert.deepStrictEqual(onBot, ['bot.machine.ai'], 'ai holds bot.machine.ai on Bot, and no computer control');
const cap = contracts.capabilities.get('bot.machine.ai');
assert.ok(cap && cap.status === 'active', 'bot.machine.ai is an active capability in the pinned contracts');
console.log('ai machine grant: ok');
