'use strict';
// The broadcast's icon (2026-11-16; the owner: item and button icons as emoji become art, emoji in chat stay): the admin
// picks one of OpenVibe's glyphs from a row of chips instead of typing an emoji in a box. The value sent is the
// matching emoji, because the email leads with it and an email cannot load the glyph font.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'admin.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'public', 'js', 'admin', 'content.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'css', 'admin.css'), 'utf8');

assert.ok(!/Icon \(emoji\)/.test(html), 'no "Icon (emoji)" box');
assert.match(html, /<input type="hidden" id="broadcast-icon" value="📢">/, 'the value sent stays an emoji, the announcement by default');
const group = /<span class="bc-icons" role="radiogroup"[^>]*>([\s\S]*?)<\/span>/.exec(html);
assert.ok(group, 'the icons are a radio group');
const chips = [...group[1].matchAll(/<button type="button" role="radio" aria-checked="(true|false)" tabindex="(-?\d)" data-emoji="([^"]+)" title="([^"]+)" aria-label="[^"]+"><i data-ov-icon="([a-z-]+)" aria-hidden="true"><\/i><\/button>/g)];
assert.ok(chips.length >= 8, `a choice of glyphs (${chips.length})`);
assert.strictEqual(chips.filter((c) => c[1] === 'true').length, 1, 'one is picked');
assert.strictEqual(chips[0][3], '📢', 'the announcement is first and picked');
assert.strictEqual(chips.filter((c) => c[2] === '0').length, 1, 'one tab stop for the group');
const glyphs = require('openvibe-shared/glyphs');
chips.forEach((c) => assert.ok(glyphs.NAMES.includes(c[5]), `${c[5]} is one of the set's glyphs`));
assert.match(css, /\.bc-icons \[role="radio"\] \{[^}]*width: 44px; height: 44px;/, '44 px targets');

// Picking: a click marks the chip and sets the emoji; the arrow keys move the pick round the group.
const buttons = chips.map((c, i) => {
    const attrs = { 'aria-checked': c[1] };
    return { dataset: { emoji: c[3] }, tabIndex: Number(c[2]), i, focused: false,
        setAttribute(k, v) { attrs[k] = v; }, getAttribute(k) { return attrs[k]; }, focus() { this.focused = true; },
        closest(sel) { return sel === '.bc-icons' ? groupEl : sel.includes('[role="radio"]') ? this : null; } };
});
const groupEl = { querySelectorAll: () => buttons };
const input = { value: '📢' };
const listeners = {};
const ctx = {
    document: { addEventListener: (type, fn) => { listeners[type] = fn; }, getElementById: (id) => (id === 'broadcast-icon' ? input : null) },
    window: {}, console,
};
vm.createContext(ctx);
vm.runInContext(js, ctx);
listeners.click({ target: buttons[2] });
assert.strictEqual(input.value, chips[2][3], 'a click sends that chip\'s emoji');
assert.strictEqual(buttons[2].getAttribute('aria-checked'), 'true');
assert.strictEqual(buttons[0].getAttribute('aria-checked'), 'false');
assert.strictEqual(buttons[2].tabIndex, 0);
let prevented = false;
listeners.keydown({ target: buttons[2], key: 'ArrowRight', preventDefault() { prevented = true; } });
assert.ok(prevented && buttons[3].focused, 'ArrowRight moves to the next');
assert.strictEqual(input.value, chips[3][3]);
listeners.keydown({ target: buttons[0], key: 'ArrowLeft', preventDefault() {} });
assert.strictEqual(input.value, chips[chips.length - 1][3], 'ArrowLeft from the first wraps to the last');
console.log(`admin-broadcast-icon: ${chips.length} glyphs to pick; the value sent is the emoji the email leads with`);
