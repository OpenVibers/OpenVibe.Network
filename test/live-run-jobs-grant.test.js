'use strict';
// Plan §AD.21b item 6: Live sends its live-lane speech-to-text (a 10 s segment, Parakeet) to OpenVibe.Run as a job on
// the shared node instead of decoding it on production's four cores. Live holds run.job.submit and run.job.read on
// openvibe.run, and nothing wider of Run's: no listing, cancelling, streaming or admin.
//   node test/live-run-jobs-grant.test.js
const assert = require('assert');
const { capabilities } = require('openvibe-contracts');
const { DEFAULT_GRANTS } = require('../server/identity/principals');

assert.ok(capabilities.get('run.job.submit'), 'the pinned openvibe-contracts knows run.job.submit');
assert.ok(capabilities.get('run.job.read'), 'the pinned openvibe-contracts knows run.job.read');
const liveRun = DEFAULT_GRANTS.filter((g) => g[0] === 'live' && g[2] === 'openvibe.run').map((g) => g[1]).sort();
assert.deepStrictEqual(liveRun, ['run.job.read', 'run.job.submit'], 'submit and read only');
console.log('live run jobs grant: all checks passed');
