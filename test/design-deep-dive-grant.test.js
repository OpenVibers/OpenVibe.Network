/**
 * OpenVibe.Design starts a deep dive (AI workflow design.deep_dive) for /create's Research first, with its own
 * client-credentials token on openvibe.ai. The grant names the workflow, and the changed-default entry moves a
 * production row seeded before it. Exchange keeps its own allowance; this is Design's.
 */
'use strict';
const assert = require('assert');
const principals = require('../server/identity/principals');

const AUDIENCE = 'openvibe.ai';
const grant = principals.DEFAULT_GRANTS.find(([client, cap, aud]) => client === 'design' && cap === 'ai.run.create' && aud === AUDIENCE);
assert.ok(grant, 'Design holds ai.run.create on openvibe.ai');
assert.ok(grant[3].includes('ai.generate'), 'its frames still run ai.generate');
assert.ok(grant[3].includes('ai.chat'), 'a frame with a preference still runs ai.chat');
assert.ok(grant[3].includes('design.deep_dive'), 'Research first can start a deep dive');
const changed = principals.CHANGED_DEFAULT_NAMESPACES.find(([client, cap, aud, was, now]) =>
    client === 'design' && cap === 'ai.run.create' && aud === AUDIENCE &&
    was.includes('ai.generate') && was.includes('ai.chat') && !was.includes('design.deep_dive') &&
    now.includes('design.deep_dive'));
assert.ok(changed, 'a production row seeded at ai.generate/ai.chat is moved to name the deep dive');
console.log('design deep dive grant: ok');
