/**
 * OpenVibe.Design starts a deep dive (AI workflow design.deep_dive) for /create's Research first, with its own
 * client-credentials token on openvibe.ai. The grant names the workflow, and the changed-default entry moves a
 * production row seeded before it. Exchange keeps its own allowance; this is Design's.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const principals = require('../server/identity/principals');

const AUDIENCE = 'openvibe.ai';
const grant = principals.DEFAULT_GRANTS.find(([client, cap, aud]) => client === 'design' && cap === 'ai.run.create' && aud === AUDIENCE);
assert.ok(grant, 'Design holds ai.run.create on openvibe.ai');
assert.ok(grant[3].includes('ai.generate'), 'its frames still run ai.generate');
assert.ok(grant[3].includes('ai.chat'), 'a frame with a preference still runs ai.chat');
assert.ok(grant[3].includes('design.deep_dive'), 'Research first can start a deep dive');
// The list itself is deliberately not exported (session-report-grants.test.js checks that). Read the entry.
const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'identity', 'principals.js'), 'utf8');
assert.match(source, /\['design', 'ai\.run\.create', 'openvibe\.ai', \['ai\.generate', 'ai\.chat'\], \['ai\.generate', 'ai\.chat', 'design\.deep_dive'\]\]/, 'a production row seeded at ai.generate/ai.chat is moved to name the deep dive');
console.log('design deep dive grant: ok');
