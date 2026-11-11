/**
 * Codes keeps task pictures in Media; Actor keeps scanned sandbox skill code there. Each uses its own Network service
 * token to upload and read private objects on its own tenant only. Actor's hosted agents do not inherit its tenant
 * grant (agent-tokens.test.js).
 *
 *   node test/media-private-grants.test.js
 */
'use strict';
const assert = require('assert');
const contracts = require('openvibe-contracts');
const principals = require('../server/identity/principals');

for (const svc of ['codes', 'actor']) {
    const rows = principals.DEFAULT_GRANTS.filter((g) => g[0] === svc && g[2] === 'openvibe.media');
    const held = new Map(rows.map((g) => [g[1], g[3]]));
    assert.deepStrictEqual([...held.keys()].sort(), ['media.object.read', 'media.object.upload'], `${svc} uploads and reads, nothing more`);
    for (const [cap, ns] of held) {
        assert.deepStrictEqual(ns, [svc], `${svc}'s ${cap} is on its own tenant only`);
        const c = contracts.capabilities.get(cap);
        assert.ok(c && c.status === 'active', `${cap} is an active capability`);
    }
}
console.log('media private grants: codes and actor on their own tenants only');
