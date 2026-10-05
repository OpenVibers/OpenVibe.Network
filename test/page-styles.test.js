'use strict';
// T2 step 1: the three pages' inline <style> monoliths moved to public/css/<page>.css, linked exactly once.
// The theme-flash guard stays inline on /admin and /my: a stylesheet would load too late to stop the flash.
//   node test/page-styles.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const pub = path.join(__dirname, '..', 'public');
for (const [page, css] of [['admin.html', 'admin.css'], ['my.html', 'my.css'], ['login.html', 'login.css']]) {
    const html = fs.readFileSync(path.join(pub, page), 'utf8');
    const links = [...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="\/css\/([^"]+)"/g)].map((m) => m[1]);
    assert.deepStrictEqual(links, [css], `${page} links /css/${css} exactly once`);
    assert.ok(!/<style\b/.test(html), `${page} keeps no inline <style> block`);
    const body = fs.readFileSync(path.join(pub, 'css', css), 'utf8');
    assert.ok(body.length > 1000, `public/css/${css} carries the page styles`);
}
for (const page of ['admin.html', 'my.html']) {
    const html = fs.readFileSync(path.join(pub, page), 'utf8');
    assert.match(html, /localStorage\.getItem\('ov_theme'\)/, `${page} keeps the inline theme bootstrap`);
}
console.log('page styles: all checks passed');
