'use strict';
// Every /shared script on a public page is deferred: the look renders from look-boot, and the
// navbar/footer run after the document parses, not before the first paint.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

for (const name of ['index.html', 'my.html', 'wallet.html', 'pay.html', 'verify-email.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', name), 'utf8');
    for (const m of html.matchAll(/<script\b[^>]*>/gi)) {
        const tag = m[0];
        if (!/\ssrc\s*=\s*"\/shared\//.test(tag)) continue;
        const type = /type\s*=\s*"module"/.test(tag);
        assert.ok(/\bdefer\b|\basync\b/.test(tag) || type, `${name}: ${tag.slice(0, 90)} is blocking`);
    }
    assert.ok(html.includes('<script src="/shared/navbar.js" defer></script>') || !html.includes('/shared/navbar.js'), `${name}: navbar deferred`);
    assert.ok(html.includes('<script src="/shared/theme-loader.js" defer></script>') || !html.includes('/shared/theme-loader.js'), `${name}: theme-loader deferred`);
}
console.log('defer shared: no blocking /shared script on public pages');
