'use strict';
// A signed-out visitor on the account hub is sent to sign-in with location.replace: Back does not land on a page that
// bounces again, and a replace navigation skips the cross-document view transition the sign-in page cannot finish.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'my', 'profile.js'), 'utf8');
assert.match(src, /if \(!authToken && !anonToken\) \{ window\.location\.replace\('\/login'\); return; \}/);
assert.match(src, /window\.location\.replace\('\/login\?return=' \+ encodeURIComponent\(window\.location\.pathname\)\);/);
assert.ok(!/window\.location\.href = '\/login'/.test(src), 'no signed-out bounce adds a history entry');
console.log('sign-in bounce: all checks passed');
