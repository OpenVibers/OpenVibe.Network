'use strict';
// The Setup tab's words and the glossary in the browser scripts (public/js/admin/setup.js, public/js/admin/glossary.js;
// OWNER-SETUP-AND-ADMIN-CLARITY-DESIGN, 2026-11-07): the counted summary, each state as a sentence, the glossary's
// words with their "What does this mean?" links, and the owner-only tab in public/js/admin/core.js.
//   node test/admin-setup-ui.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dir = path.join(__dirname, '..', 'public', 'js', 'admin');
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
const ctx = {
    esc: (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    timeAgo: () => '5m ago', currentUser: null, console,
    document: { addEventListener() {} }, location: { hash: '' },
};
vm.createContext(ctx);
// glossary.js, ai.js (paiUsd) and setup.js in their load order, as admin.html loads them.
vm.runInContext(read('glossary.js') + '\n' + read('ai.js') + '\n' + read('setup.js')
    + '\n;globalThis.__s = { setupSummary, setupStateLine, setupFor, glossaryLink, GLOSSARY };', ctx);
const S = ctx.__s;

// ── The counted summary, in the design's words ──
assert.strictEqual(S.setupSummary({ needed: 6, not_working: 2, connected: 31, optional: 0 }), '6 things need you · 2 not working · 31 connected');
assert.strictEqual(S.setupSummary({ needed: 1, not_working: 0, connected: 4, optional: 3 }), '1 thing needs you · 0 not working · 4 connected · 3 optional');

// ── Each state is a sentence ──
const key = { kind: 'key', secret: true, testable: true };
assert.strictEqual(S.setupStateLine({ ...key, state: 'needed', required_for: 'Card payments' }), 'Needed for card payments.');
assert.strictEqual(S.setupStateLine({ ...key, state: 'needed', required_for: 'GPUs for rent' }), 'Needed for GPUs for rent.', 'an acronym keeps its capitals');
assert.strictEqual(S.setupStateLine({ ...key, state: 'optional' }), 'Not set. Nothing waits on it.');
assert.strictEqual(S.setupStateLine({ ...key, state: 'not_working', set: true, hint: 'WXYZ', set_at: '2026-11-07', last_test: { passed: false, message: 'Telegram answered 401', at: 'x' } }),
    'Entered here, locked · ••••WXYZ · set 2026-11-07; the last test failed 5m ago: Telegram answered 401.');
assert.strictEqual(S.setupStateLine({ ...key, state: 'connected', set: true, hint: 'a1b2', last_test: null }), 'Entered here, locked · ••••a1b2; not tested yet.');
assert.strictEqual(S.setupStateLine({ kind: 'key', state: 'connected', set: true, pinned: true, pin_env: 'NPM_TOKEN', secret: true, last_test: null }), 'From the server\'s settings file (NPM_TOKEN).');
assert.strictEqual(S.setupStateLine({ kind: 'key', state: 'connected', set: true, value: false, type: 'boolean' }), 'Off.', 'a switch says on or off, not true or false');
assert.strictEqual(S.setupStateLine({ kind: 'key', state: 'connected', set: true, value: 2500000000, unit: 'nano_usd' }), 'Set to $2.5.');
assert.strictEqual(S.setupStateLine({ kind: 'task', state: 'connected', done: { at: '2026-11-07', by: 'goosely' } }), 'Done on 2026-11-07 by @goosely.');
assert.strictEqual(S.setupStateLine({ kind: 'task', state: 'needed', required_for: 'Safe harbour for what people upload' }), 'Needed for safe harbour for what people upload.');
assert.ok(!/undefined|null|true|false/.test(S.setupStateLine({ ...key, state: 'connected', set: true, last_test: { passed: true, at: 'x', message: 'ok' } })));

// ── The glossary: the words the design names, each with a line, and the link next to a word ──
const ids = S.GLOSSARY.map((g) => g.id);
for (const id of ['credits', 'byok', 'resale', 'cache', 'quota', 'workflow']) assert.ok(ids.includes(id), `the glossary explains ${id}`);
// A machine word may appear only quoted, as the name the owner will meet elsewhere ("KEK" in the env file).
for (const g of S.GLOSSARY) assert.ok(g.word && g.text.length >= 60 && !/\b(KEK|circuit|stub|Mtok)\b/.test(g.text.replace(/"[^"]*"/g, '')), `${g.id} is explained in plain words`);
assert.strictEqual(new Set(ids).size, ids.length, 'each word once');
assert.strictEqual(S.glossaryLink('credits'), '<a class="ov-what" href="#" role="button" data-glossary="credits">What does this mean?</a>');
assert.strictEqual(S.glossaryLink('nope'), '', 'no link for a word the glossary does not have');

// ── Setup is an owner-only tab (public/js/admin/core.js) ──
const core = read('core.js');
assert.match(core.match(/const OWNER_ONLY_TABS = new Set\(\[[^\]]*\]\)/)[0], /'setup'/);
assert.ok(!/OWNER_ONLY_TABS = new Set\(\[[^\]]*'glossary'/.test(core), 'the glossary is for every admin');
// A key's input is built as a DOM node, never in an HTML string, and is cleared after a save.
const setup = read('setup.js');
assert.ok(!/<input[^>]*type="password"/.test(setup), 'no password input in an HTML string');
assert.match(setup, /if \(isSecret\) input\.value = '';/, 'the key is cleared whatever happened');
console.log('admin-setup-ui: the summary, the states, the glossary and the owner-only tab read as designed');
