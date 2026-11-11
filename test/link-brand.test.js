'use strict';
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const oldName = ['OpenVibe[ .-]No' + 'de', 'openvibe-' + 'node', 'no' + 'd_', 'node[.]openvibe[.]network', 'node:lnk_', 'openvibe[.](bot|my|network)/mach' + 'ines', 'platform[.]node-capabilities', 'network[.]node[.@]', 'platform[.]node[.@]'].join('|');
const result = spawnSync('git', ['grep', '-n', '-I', '-i', '-E', oldName, '--', '.', ':!migrations/**', ':!test/link-brand.test.js'], { cwd: root, encoding: 'utf8' });
assert.ok(result.status === 0 || result.status === 1, result.stderr || 'git grep failed');
// The retired host is kept only as an arrival redirect to the Machines hub.
const hits = (result.stdout || '').split('\n').filter(Boolean).filter(line =>
    !/^server\/index\.js:\d+:\s+if \(getRequestHost\(req\) === 'node\.openvibe\.network'\) return res\.redirect\(302, 'https:\/\/openvibe\.link\/machines'\);$/.test(line));
assert.deepEqual(hits, [], `Old Link brand or principal returned:\n${hits.slice(0, 10).join('\n')}`);
console.log('  ok  old Link brand and principal IDs are absent');
