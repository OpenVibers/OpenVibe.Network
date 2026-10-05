#!/usr/bin/env node
/**
 * Runs every test in test/ — the files named *.test.js — each in its own process, and fails if any
 * of them fails (openvibe-shared/test-runner). PostgreSQL runs two at a time to fit the suite deadline.
 *
 *   npm test                   # everything
 *   npm test -- usernames follows   # only files whose name contains one of the words
 *   npm test -- --strict       # a skipped test fails the run too
 *
 * Each test gets a migrated PostgreSQL database of its own (PGlite; the containers under npm run test:pg) and
 * local servers on random ports. A test that cannot run something prints `<label>: skipped (<why>)` and is
 * listed with ○, not counted as passed.
 */
'use strict';
const { pathToFileURL } = require('url');
// Every test process starts with a migrated database of its own (test/helpers/pg-preload.mjs; plan T2, ADR-035).
const preload = pathToFileURL(require('path').join(__dirname, 'helpers', 'pg-preload.mjs')).href;
require('openvibe-shared/test-runner').main({ dir: __dirname, timeoutMs: 300000, pad: 40, parallel: 'auto', hide: /^\[DB\] /, nodeArgs: ['--import', preload] });
