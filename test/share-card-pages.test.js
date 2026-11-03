'use strict';
// SEO-21: the network's share card on the five pages that had none (11-03 check: /login, /machines, /themes, /updates
// and /status answered 200 without og:image, so a link pasted in chat showed no picture). The home, legal, sites and
// stats pages already carry it.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

for (const f of ['public/login.html', 'public/my.html']) {
    const html = read(f);
    assert.match(html, /<meta property="og:image" content="https:\/\/openvibe\.network\/shared\/social\/network\.jpg">/, `${f}: the card`);
    assert.match(html, /<meta name="twitter:card" content="summary_large_image">/, `${f}: the large card`);
    assert.strictEqual((html.match(/property="og:image"/g) || []).length, 1, `${f}: once`);
}
assert.match(read('public/login.html'), /<meta property="og:title" content="Sign in to OpenVibe">/);
for (const f of ['server/updates/routes.js', 'server/status/routes.js']) {
    const src = read(f);
    assert.match(src, /const SHARE_CARD = require\('openvibe-shared\/social'\)\.url\('network', 'https:\/\/openvibe\.network\/shared'\);/, `${f}: the card's hashed URL`);
    assert.match(src, /<meta property="og:image" content="\$\{SHARE_CARD\}">/, `${f}: in the head`);
}
const card = require('openvibe-shared/social').url('network', 'https://openvibe.network/shared');
assert.match(card, /^https:\/\/openvibe\.network\/shared\/social\/network\.jpg/, 'the card resolves');
console.log('share card pages: ok');
