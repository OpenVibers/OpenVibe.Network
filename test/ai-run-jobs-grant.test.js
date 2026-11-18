'use strict';
// Plan §AD.21b item 6: AI sends its VOD and clip transcripts (10 s Parakeet pieces) to OpenVibe.Run as a job on
// the shared node instead of decoding it on production's four cores. AI holds run.job.submit and run.job.read on
// openvibe.run, and nothing wider of Run's: no listing, cancelling, streaming or admin.
//   node test/ai-run-jobs-grant.test.js
const assert = require('assert');
const { capabilities } = require('openvibe-contracts');
const { DEFAULT_GRANTS } = require('../server/identity/principals');

assert.ok(capabilities.get('run.job.submit'), 'the pinned openvibe-contracts knows run.job.submit');
assert.ok(capabilities.get('run.job.read'), 'the pinned openvibe-contracts knows run.job.read');
const aiRun = DEFAULT_GRANTS.filter((g) => g[0] === 'ai' && g[2] === 'openvibe.run').map((g) => g[1]).sort();
assert.deepStrictEqual(aiRun, ['run.job.read', 'run.job.submit'], 'submit and read only');
console.log('ai run jobs grant: all checks passed');
