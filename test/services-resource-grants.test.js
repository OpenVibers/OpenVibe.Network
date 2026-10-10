/**
 * OpenVibe.Services merges every authority's resource index (ADR-048, plan T13 step 8): it reads each one's
 * GET /api/v1/resources under that authority's `<id>.resource.read`, with a token for `openvibe.<id>`. Every
 * capability of that form that the pinned contracts release has made active must therefore be granted to the
 * `services` principal here, or Services lists that authority as partial forever. Planned ones may be granted
 * ahead (their indexes ship before the capability turns active).
 *
 *   node test/services-resource-grants.test.js
 */
'use strict';
const assert = require('assert');
const contracts = require('openvibe-contracts');
const principals = require('../server/identity/principals');

const RESOURCE_READ = /^([a-z][a-z0-9-]{0,31})\.resource\.read$/;
const granted = new Map(principals.DEFAULT_GRANTS.filter((g) => g[0] === 'services' && RESOURCE_READ.test(g[1])).map((g) => [g[1], g[2]]));
const revoked = new Set((principals.REVOKED_GRANTS || []).filter((g) => g[0] === 'services').map((g) => g[1]));

let checked = 0;
for (const m of contracts.services.manifests) {
    if (!m || m.id === 'services' || m.status === 'retired' || m.status === 'placeholder') continue;
    const id = `${m.id}.resource.read`;
    const cap = contracts.capabilities.get(id);
    if (!cap || !(m.capabilities || []).includes(id)) continue;
    if (cap.status === 'active') {
        const audience = m.id === 'network' ? principals.SELF_AUDIENCE : `openvibe.${m.id}`;
        assert.strictEqual(granted.get(id), audience, `services is granted ${id} for ${audience}`);
        checked++;
    }
}
for (const [id] of granted) {
    const cap = contracts.capabilities.get(id);
    assert.ok(cap && cap.status !== 'retired', `services holds ${id}, which the contracts do not offer`);
    assert.ok(!revoked.has(id), `${id} is both granted and revoked`);
}
assert.ok(checked >= 4, `at least Network, Media, Events and Host are active authorities (${checked})`);
console.log(`services resource grants: ${checked} active authorities granted, ${granted.size} grants in all`);
