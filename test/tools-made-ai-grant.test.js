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
// Agents run made tools as the person (Contracts 0.437.0): Actor and Codes only.
const run = principals.DEFAULT_GRANTS.filter(([, cap]) => cap === 'tools.made.run');
assert.deepStrictEqual(run.map(([client, , aud]) => [client, aud]).sort(), [['actor', 'openvibe.tools'], ['codes', 'openvibe.tools']], 'Actor and Codes run made tools, on openvibe.tools only');
// And make tools for the person (Contracts 0.439.0 tools.made.write): Actor and Codes only, once the pinned Contracts has it.
const { capabilities } = require('openvibe-contracts');
const write = principals.DEFAULT_GRANTS.filter(([, cap]) => cap === 'tools.made.write');
if (capabilities.get('tools.made.write')) {
    assert.deepStrictEqual(write.map(([client, , aud]) => [client, aud]).sort(), [['actor', 'openvibe.tools'], ['codes', 'openvibe.tools']], 'Actor and Codes make tools for people, on openvibe.tools only');
} else {
    assert.deepStrictEqual(write, [], 'no grant for a capability the pinned Contracts does not have');
}
// A scheduled tool's answer goes to its owner as a notification (Tools #378): push, as service 'tools' only.
const push = principals.DEFAULT_GRANTS.filter(([client, cap]) => client === 'tools' && cap === 'network.notifications.push');
assert.strictEqual(push.length, 1, 'Tools pushes notifications');
assert.deepStrictEqual(push[0][3], ['tools'], 'as service tools only');
// Code tools run as Run function jobs (§AD.13 (2)): Tools submits and reads, nothing else of Run's.
const runJobs = principals.DEFAULT_GRANTS.filter(([client, , aud]) => client === 'tools' && aud === 'openvibe.run').map(([, cap]) => cap).sort();
assert.deepStrictEqual(runJobs, ['run.job.read', 'run.job.submit'], 'Tools submits and reads Run jobs, nothing else');
console.log('tools made-tool grants: ok');
