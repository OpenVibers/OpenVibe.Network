/**
 * OpenVibe.Codes keeps a person's pictures in Media as private objects (task screenshots, 10-30). Media takes no app
 * keys (C-71), so Codes reaches it with its own Network service token: upload and read, on its own tenant only, and
 * nothing else of Media's. Actor holds no Media grant: its artifacts live in its own database, owner-only (Actor V2-4).
 * Were it granted one, the agents it hosts would still not reach its tenant (agent-tokens.test.js).
 *
 *   node test/media-private-grants.test.js
 */
'use strict';
const assert = require('assert');
const contracts = require('openvibe-contracts');
const principals = require('../server/identity/principals');

for (const svc of ['codes']) {
    const rows = principals.DEFAULT_GRANTS.filter((g) => g[0] === svc && g[2] === 'openvibe.media');
    const held = new Map(rows.map((g) => [g[1], g[3]]));
    assert.deepStrictEqual([...held.keys()].sort(), ['media.object.read', 'media.object.upload'], `${svc} uploads and reads, nothing more`);
    for (const [cap, ns] of held) {
        assert.deepStrictEqual(ns, [svc], `${svc}'s ${cap} is on its own tenant only`);
        const c = contracts.capabilities.get(cap);
        assert.ok(c && c.status === 'active', `${cap} is an active capability`);
    }
}
assert.strictEqual(principals.DEFAULT_GRANTS.filter((g) => g[0] === 'actor' && g[2] === 'openvibe.media').length, 0, 'the agent host holds no Media grant');
console.log('media private grants: codes on its own tenant; none for the agent host');
