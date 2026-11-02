/**
 * OpenVibe Connect's notification grant (CON-17, "tell me when it's back"): Connect pushes one notification as app
 * connect to a person who asked, and holds nothing else of Network's notifications.
 *
 *   node test/connect-notify-grant.test.js
 */
'use strict';
const assert = require('assert');
const contracts = require('openvibe-contracts');
const principals = require('../server/identity/principals');

const rows = principals.DEFAULT_GRANTS.filter((g) => g[0] === 'connect' && g[2] === principals.SELF_AUDIENCE && /^network\.notifications\./.test(g[1]));
assert.deepStrictEqual(rows.map((g) => [g[1], g[3]]), [['network.notifications.push', ['connect']]], 'connect pushes as its own app only, and holds nothing else of Network\'s notifications');
const cap = contracts.capabilities.get('network.notifications.push');
assert.ok(cap && cap.status === 'active', 'an active capability');
console.log('connect notify grant: ok');
