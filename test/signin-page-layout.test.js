'use strict';
// The sign-in card's provider block (the 11-14 design review, plan §AB.49): one provider is one full-width "Sign in with
// Steam"; two or more sit two to a row by name with the full words for screen readers; an "or use a username" divider
// belongs to the block; every glyph a provider names exists in Shared; the passkey button is never mistaken for the
// guest button; the providers show only beside the sign-in and new-account forms; no Font Awesome tags are left.
//   ov test test/signin-page-layout.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const page = require('../server/auth/providers/page');
const { PROVIDERS } = require('../server/auth/providers/presets');
const glyphs = require('openvibe-shared/glyphs');

const ROOT = path.join(__dirname, '..');
const LOGIN_JS = fs.readFileSync(path.join(ROOT, 'public/js/login.js'), 'utf8');
const LOGIN_HTML = fs.readFileSync(path.join(ROOT, 'public/login.html'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'public/css/login.css'), 'utf8');
const byId = (id) => PROVIDERS.find((p) => p.id === id);

// One provider says the whole thing.
const one = page.section([byId('steam')]);
assert.ok(one.includes('<span>Sign in with Steam</span>'), 'one provider: the whole sentence on its button');
assert.ok(!one.includes('aria-label='), 'and no aria-label is needed');

// Two or more: names on the buttons, the full words for screen readers, the sentence above names them all.
const three = page.section(['google', 'discord', 'steam'].map(byId));
assert.ok(three.includes('Sign in to OpenVibe with Google, Discord and Steam'), 'the sentence names them all');
assert.ok(three.includes('aria-label="Sign in with Google"') && three.includes('<span>Google</span>'), 'a name on the button, the words for screen readers');
assert.ok(!three.includes('<span>Sign in with Google</span>'), 'the button does not repeat the sentence');
assert.ok(/<div class="divider providers-or"><span>or use a username<\/span><\/div><\/section>$/.test(three), 'the "or" before the username form is the block\'s own');
assert.strictEqual(page.section([]), '', 'no providers, no block (and no "or")');

// The browser renders the same markup.
for (const bit of ['aria-label="Sign in with ${escapeHtml(p.name)}"', "many ? '' : 'Sign in with '", '<div class="divider providers-or"><span>or use a username</span></div>']) {
    assert.ok(LOGIN_JS.includes(bit), `login.js renders the same block: ${bit}`);
}

// Every glyph a provider names is one Shared draws (Roblox named "gamepad", which is not a glyph: an empty box).
const drawn = (name) => (glyphs.svg(name, { size: 16 }) || '').length > 0;
for (const p of PROVIDERS) {
    if (p.icon && p.icon.icon) assert.ok(drawn(p.icon.icon), `${p.id}: the glyph "${p.icon.icon}" exists`);
}
const jsGlyphs = [...LOGIN_JS.matchAll(/(\w+): \{ icon: '([\w-]+)' \}/g)];
assert.ok(jsGlyphs.length >= 2, 'login.js names its stand-in glyphs');
for (const [, id, name] of jsGlyphs) assert.ok(drawn(name), `login.js ${id}: the glyph "${name}" exists`);
for (const [, name] of LOGIN_HTML.matchAll(/data-ov-icon="([\w-]+)"/g)) {
    if (name !== 'network') assert.ok(drawn(name), `login.html: the glyph "${name}" exists`);
}

// The passkey button wears .anon-btn too and comes first: the guest button is found by its id, never by class.
assert.ok(!/querySelector\('\.anon-btn'\)/.test(LOGIN_JS), 'no class lookup for the guest button');
assert.ok(/const anonBtn = document\.getElementById\('anon-btn'\)/.test(LOGIN_JS), 'the guest button by its id');

// The providers show beside the sign-in and new-account forms only.
assert.ok(/providers\.hidden = !\(panelId === 'panel-login' \|\| panelId === 'panel-register'\)/.test(LOGIN_JS), 'hidden on every other panel');
assert.ok(/\.providers\[hidden\]\{display:none\}/.test(CSS), 'and the hidden attribute wins over the block\'s CSS');

// The row is filled: no two-column grid that leaves one button half-width beside a gap.
assert.ok(/\.provider-list\{display:flex;flex-wrap:wrap;gap:8px\}/.test(CSS), 'buttons wrap and grow');
assert.ok(/\.provider-btn\{\s*flex:1 1 calc\(50% - 4px\);min-width:0/.test(CSS), 'two to a row, an odd last one the whole row');
assert.ok(!/grid-template-columns:1fr 1fr/.test(CSS), 'the old half-width grid is gone');

// No Font Awesome tags (ov-glyphs drew them through a fallback map; the page names glyphs now).
assert.ok(!/fa-(solid|regular|brands)|class="fa-/.test(LOGIN_HTML), 'login.html names glyphs, not Font Awesome classes');
assert.ok(!/fa-solid/.test(LOGIN_JS), 'and so does login.js');

console.log('signin-page-layout.test.js: all assertions passed');
