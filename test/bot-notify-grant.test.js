/**
 * OpenVibe.Bot's notification grant (11-23, LOOI viewer turns): Bot tells a person their turn on a robot has started,
 * one notification as app bot, and holds nothing else of Network's notifications.
 *
 *   node test/bot-notify-grant.test.js
 */
'use strict';
const assert = require('assert');
const contracts = require('openvibe-contracts');
const principals = require('../server/identity/principals');

const rows = principals.DEFAULT_GRANTS.filter((g) => g[0] === 'bot' && g[2] === principals.SELF_AUDIENCE && /^network\.notifications\./.test(g[1]));
assert.deepStrictEqual(rows.map((g) => [g[1], g[3]]), [['network.notifications.push', ['bot']]], 'bot pushes as its own app only, and holds nothing else of Network\'s notifications');
const cap = contracts.capabilities.get('network.notifications.push');
assert.ok(cap && cap.status === 'active', 'an active capability');
console.log('bot notify grant: ok');
