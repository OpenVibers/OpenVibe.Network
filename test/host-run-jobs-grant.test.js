'use strict';
// Plan §AD.21 item 6: ovhost browser-watch submits the release browser check to OpenVibe.Run (a job on the shared node,
// not a Chrome on production) and reads its report. Host holds run.job.submit and run.job.read on openvibe.run, and
// nothing wider of Run's: no listing, cancelling, streaming or admin.
//   node test/host-run-jobs-grant.test.js
const assert = require('assert');
const { capabilities } = require('openvibe-contracts');
const { DEFAULT_GRANTS } = require('../server/identity/principals');

for (const cap of ['run.job.submit', 'run.job.read']) assert.ok(capabilities.get(cap), `the pinned openvibe-contracts knows ${cap}`);
const hostRun = DEFAULT_GRANTS.filter((g) => g[0] === 'host' && g[2] === 'openvibe.run').map((g) => g[1]).sort();
assert.deepStrictEqual(hostRun, ['run.job.read', 'run.job.submit'], 'submit and read only');
console.log('host run jobs grant: all checks passed');
