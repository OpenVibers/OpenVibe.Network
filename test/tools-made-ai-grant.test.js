/**
 * Tools people make (plan 2026-11-13 §AD.7 step 2, Tools #364): a prompt tool runs through OpenVibe.AI's ai.complete
 * as the person who runs it, with Tools' own client-credentials token (audience openvibe.ai). Tools reaches that one
 * workflow and nothing else of AI's.
 *
 *   node test/tools-made-ai-grant.test.js
 */
'use strict';
const assert = require('assert');
const principals = require('../server/identity/principals');

const ai = principals.DEFAULT_GRANTS.filter(([client, , aud]) => client === 'tools' && aud === 'openvibe.ai');
assert.deepStrictEqual(ai, [['tools', 'ai.run.create', 'openvibe.ai', ['ai.complete']]], 'Tools holds ai.run.create on openvibe.ai for ai.complete only');
assert.ok(!principals.RESTORED_GRANTS.some(([client, cap]) => client === 'tools' && cap === 'ai.run.create'), 'new grant: no RESTORED_GRANTS entry');
console.log('tools made-tool AI grant: ok');
