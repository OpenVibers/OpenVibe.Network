'use strict';
// T2 step 2: the account hub (/my and its sections) runs from classic deferred scripts in public/js/my/, not one
// inline monolith. my.html loads exactly the module files, boot.js last; no function is declared in two modules.
//   node test/my-modules.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const pub = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(pub, 'my.html'), 'utf8');
for (const [, body] of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) assert.ok(body.length <= 5000, 'my.html keeps no inline script over 5000 characters');

const files = fs.readdirSync(path.join(pub, 'js', 'my')).filter((f) => f.endsWith('.js')).sort();
// The module map, in load order (public/js/my/…).
const modules = ['core.js', 'tools.js', 'themes.js', 'profile.js', 'security.js', 'boot.js'];
assert.deepStrictEqual(files, [...modules].sort(), 'each module file exists and there is no other');
const tags = [...html.matchAll(/<script\b([^>]*)\bsrc="\/js\/my\/([^"]+)"([^>]*)><\/script>/g)];
const loaded = tags.map((m) => m[2]);
assert.deepStrictEqual(loaded, modules, 'the loader list is the module files, in order, each once');
assert.strictEqual(loaded.at(-1), 'boot.js', 'boot.js is the last /js/my/ script');
for (const m of tags) assert.ok(/\bdefer\b/.test(m[1] + m[3]) && !/\btype=/.test(m[1] + m[3]), `${m[2]} is a classic deferred script`);

const owner = new Map();
for (const f of files) {
    const src = fs.readFileSync(path.join(pub, 'js', 'my', f), 'utf8');
    for (const [, name] of src.matchAll(/^(?:async\s+)?function\s+([\w$]+)\s*\(/gm)) {
        assert.ok(!owner.has(name), `${name} is declared in both ${owner.get(name)} and ${f}`);
        owner.set(name, f);
    }
}
assert.ok(owner.size > 70, 'the modules declare the hub functions');
// Every section calls these, so they load first.
for (const name of ['_bootstrapFromCookie', 'getAuthToken', 'apiFetch', 'showSection']) assert.strictEqual(owner.get(name), 'core.js', `${name} lives in core.js`);

console.log('my-modules: all checks passed');
