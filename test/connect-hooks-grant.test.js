/**
 * OpenVibe Connect's Events grants (CON-15, hooks that wait for your computer): Connect manages its own subscriptions
 * and publishes its own events (connect.hook.received, contracts 0.282.0), and holds nothing else of Events.
 *
 *   node test/connect-hooks-grant.test.js
 */
'use strict';
const assert = require('assert');
const contracts = require('openvibe-contracts');
const principals = require('../server/identity/principals');

const rows = principals.DEFAULT_GRANTS.filter((g) => g[0] === 'connect' && g[2] === 'openvibe.events');
assert.deepStrictEqual(rows.map((g) => [g[1], g[3]]).sort(), [['events.event.publish', []], ['events.subscription.manage', []]], 'publish and its own subscriptions; never delivery admin or another service\'s reads');
const cap = contracts.capabilities.get('events.event.publish');
assert.ok(cap && cap.status === 'active', 'an active capability');
console.log('connect hooks grant: ok');
