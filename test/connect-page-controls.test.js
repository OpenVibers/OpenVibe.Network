'use strict';
/**
 * The Apps page's own controls (11-18): the grants are three chips per caller and app (Off, Read, Read and write), not a
 * browser drop-down; Revoke asks in place ("Tap again …"), not with a browser confirm; a refusal is a line under the
 * control, not a browser alert. The panel names each app as the catalogue does, not by its key.
 *   node test/connect-page-controls.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const js = fs.readFileSync(path.join(__dirname, '../public/js/connect.js'), 'utf8');
const page = fs.readFileSync(path.join(__dirname, '../server/connect/page.js'), 'utf8');
const registry = require('../server/connect/apps');

assert.ok(!/window\.(alert|confirm|prompt)\s*\(/.test(js), 'no browser alert, confirm or prompt: errors and questions stay in the page');
assert.ok(!/el\('select'/.test(js) && !/createElement\('select'\)/.test(js), 'no browser drop-down for a grant');
assert.match(js, /role: 'radiogroup'/, 'the grant is a group of chips');
assert.match(js, /role: 'radio'/);
assert.match(js, /\['', 'Off'\], \['read', 'Read'\], \['write', 'Read and write'\]/, 'the three levels, in words');
assert.match(js, /askTwice\(btn, 'Tap again/, 'Revoke asks in place');
assert.match(js, /\.catch\(function \(e\) \{ level = was; paint\(level\); sayNear\(row, e\.message\); \}\)/, 'a refused grant turns back and says why');

// el() takes its children as a list: a call that passes them one by one throws (the live approvals rows did, 11-18).
const calls = js.match(/\bel\('[a-z]+', \{[^{}]*\}, (?!\[)[^)]/g) || [];
assert.deepStrictEqual(calls, [], `el() with children not in a list: ${calls.join(' | ')}`);

// The names the panel shows come from the catalogue.
assert.match(page, /data-ovk-app-names="\$\{esc\(JSON\.stringify\(Object\.fromEntries\(registry\.all\(\)\.map\(\(d\) => \[d\.key, d\.name\]\)\)\)\)\}"/);
assert.ok(registry.all().every((d) => typeof d.name === 'string' && d.name && /^[a-z][a-z0-9_]*$/.test(d.key)), 'every app has a key and a name');
// The chips are at least 40 px tall, 44 px on a phone.
assert.match(page, /\.ovk-seg-b\{min-height:40px/);
assert.match(page, /@media \(max-width:480px\)\{\n\.ovk-connect \.ovk-grant-row\{grid-template-columns:minmax\(0,1fr\)\}\n\.ovk-connect \.ovk-seg\{display:flex\}\n\.ovk-connect \.ovk-seg-b\{flex:1 1 0;min-height:44px/);

console.log('connect-page-controls: grants as chips, Revoke asks in place, refusals in the page, apps by name');
