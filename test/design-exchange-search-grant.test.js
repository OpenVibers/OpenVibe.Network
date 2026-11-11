/**
 * OpenVibe.Design's Exchange icon-search grant (contracts 0.407.0): Design asks OpenVibe.AI's Exchange platform API
 * for the icon references beside a glyph draft, with its own client-credentials token (audience openvibe.ai), and
 * reaches only POST /v1/search/icons. No Exchange key is needed anywhere.
 *
 *   node test/design-exchange-search-grant.test.js
 */
'use strict';
const assert = require('assert');
const contracts = require('openvibe-contracts');
const principals = require('../server/identity/principals');

const CAP = 'exchange.search.icons';
const AUDIENCE = 'openvibe.ai';
const grant = principals.DEFAULT_GRANTS.find(([client, cap, aud]) => client === 'design' && cap === CAP && aud === AUDIENCE);
assert.ok(grant, 'Design holds exchange.search.icons on openvibe.ai');
assert.deepStrictEqual(grant[3], [], 'the grant needs no namespace: the route names none');
assert.ok(!principals.DEFAULT_GRANTS.some(([client, cap]) => cap === CAP && client !== 'design'), 'Design alone holds it');
assert.ok(!principals.RESTORED_GRANTS.some(([client, cap]) => client === 'design' && cap === CAP), 'new grant: no RESTORED_GRANTS entry');
const cap = contracts.capabilities.get(CAP);
assert.ok(cap && cap.status === 'active', 'exchange.search.icons is active in the pinned contracts');
assert.strictEqual(cap.owner, 'ai', 'OpenVibe.AI serves the Exchange platform API');
assert.strictEqual(cap.visibility, 'first-party');
assert.deepStrictEqual(cap.implementedBy, ['POST /v1/search/icons'], 'it opens the icons route only');
console.log('design exchange search grant: ok');
