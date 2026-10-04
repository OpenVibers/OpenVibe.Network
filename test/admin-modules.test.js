'use strict';
// T2 step 1: the admin panel (/admin) runs from classic deferred scripts in public/js/admin/, not one inline
// monolith. admin.html loads exactly the module files, boot.js last; no function is declared in two modules.
//   node test/admin-modules.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const pub = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(pub, 'admin.html'), 'utf8');
for (const [, body] of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) assert.ok(body.length <= 5000, 'admin.html keeps no inline script over 5000 characters');

const files = fs.readdirSync(path.join(pub, 'js', 'admin')).filter((f) => f.endsWith('.js')).sort();
// The module map, in load order (public/js/admin/…).
const modules = ['core.js', 'dashboard.js', 'users.js', 'moderation.js', 'settings.js', 'payments.js', 'ai.js', 'content.js', 'analytics.js', 'deploy.js', 'boot.js'];
assert.deepStrictEqual(files, [...modules].sort(), 'each module file exists and there is no other');
const tags = [...html.matchAll(/<script\b([^>]*)\bsrc="\/js\/admin\/([^"]+)"([^>]*)><\/script>/g)];
const loaded = tags.map((m) => m[2]);
assert.deepStrictEqual(loaded, modules, 'the loader list is the module files, in order, each once');
assert.strictEqual(loaded.at(-1), 'boot.js', 'boot.js is the last /js/admin/ script');
for (const m of tags) assert.ok(/\bdefer\b/.test(m[1] + m[3]) && !/\btype=/.test(m[1] + m[3]), `${m[2]} is a classic deferred script`);

const owner = new Map();
const src = {};
for (const f of files) {
    src[f] = fs.readFileSync(path.join(pub, 'js', 'admin', f), 'utf8');
    for (const [, name] of src[f].matchAll(/^(?:async\s+)?function\s+([\w$]+)\s*\(/gm)) {
        assert.ok(!owner.has(name), `${name} is declared in both ${owner.get(name)} and ${f}`);
        owner.set(name, f);
    }
}
assert.ok(owner.size > 100, 'the modules declare the panel functions');
for (const name of ['esc', 'toast', 'api', 'fmtBytes', 'showTab', 'routeFromUrl']) assert.strictEqual(owner.get(name), 'core.js', `${name} lives in core.js`);
// tabLoaders names every loader, so it is evaluated after all of them; init() starts the panel last.
assert.ok(src['boot.js'].includes('const tabLoaders = {'), 'tabLoaders lives in boot.js');
assert.match(src['boot.js'], /\ninit\(\);\s*$/, 'boot.js ends by calling init()');

console.log('admin-modules: all checks passed');
