'use strict';
// A signed-out visitor is never bounced into a history entry: openvibe.my stays on the hub with a sign-in card (and
// the way to sign out everywhere), while Network's own signed-out path uses location.replace, so Back does not land
// on a page that bounces again and the cross-document view transition the sign-in page cannot finish is skipped.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'my', 'profile.js'), 'utf8');
assert.match(src, /if \(!authToken && !anonToken\) \{\s*if \(MY_HOST\) \{ showSignedOutHub\(\); return; \}\s*window\.location\.replace\('\/login'\);\s*return;\s*\}/);
assert.match(src, /window\.location\.replace\('\/login\?return=' \+ encodeURIComponent\(window\.location\.pathname\)\);/);
assert.ok(!/window\.location\.href = '\/login'/.test(src), 'no signed-out bounce adds a history entry');
console.log('sign-in bounce: all checks passed');
