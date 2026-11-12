'use strict';
// A page that loads the shared navbar.js with defer sets the bar up only once the page is parsed (2026-11-12: the home and
// the email check page called OpenVibeNavbar.init at once; navbar.js had not run yet, so a signed-out visitor got the plain
// server row of links, unstyled and wider than a phone). Each such page's setup waits for DOMContentLoaded or readyState.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'public');
const pages = fs.readdirSync(dir).filter((f) => f.endsWith('.html'));
let checked = 0;
pages.forEach((f) => {
    const html = fs.readFileSync(path.join(dir, f), 'utf8');
    if (!/<script src="\/shared\/navbar\.js" defer><\/script>/.test(html)) return;
    const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((js) => js.includes('OpenVibeNavbar.init('));
    inline.forEach((js) => {
        checked += 1;
        assert.ok(/DOMContentLoaded/.test(js) && /readyState/.test(js), `${f}: the bar's setup waits until navbar.js (deferred) has run`);
    });
});
assert.ok(checked >= 2, `the home and the email check page are among the pages checked (${checked})`);
console.log(`navbar-init-after-defer: ${checked} page setups wait for the deferred navbar.js`);
