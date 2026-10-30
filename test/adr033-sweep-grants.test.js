/**
 * The ADR-033 sweep (2026-10-30): the services whose account-data module landed in the sweep answer for what they
 * keep about a person, so Network waits for them: each holds network.account.export.contribute (it pushes its export
 * part) and network.account.deletion.confirm (it confirms what it erased) on the network audience.
 *
 * The three that subscribe to the two account topics themselves, through openvibe-sdk/account-data (startSubscriptions
 * creates the subscription on the bus), also hold events.subscription.manage on openvibe.events: Run (its jobs and
 * runs), Sources (its items and feeds) and Events (the bus itself keeps the events a person caused).
 *
 *   node test/adr033-sweep-grants.test.js
 */
'use strict';
const assert = require('assert');
const principals = require('../server/identity/principals');

const holds = (svc, cap, aud) => principals.DEFAULT_GRANTS.some((g) => g[0] === svc && g[1] === cap && g[2] === aud);

for (const svc of ['ai', 'coupons', 'news', 'run', 'search', 'sources', 'events']) {
    assert.ok(holds(svc, 'network.account.export.contribute', principals.SELF_AUDIENCE), `${svc} answers the account export`);
    assert.ok(holds(svc, 'network.account.deletion.confirm', principals.SELF_AUDIENCE), `${svc} confirms the account deletion`);
}

for (const svc of ['run', 'sources', 'events']) {
    assert.ok(holds(svc, 'events.subscription.manage', 'openvibe.events'), `${svc} subscribes to the two account topics`);
}

console.log('adr033 sweep grants: ok');
