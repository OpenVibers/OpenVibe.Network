'use strict';
// The admin panel on a phone (2026-11-14, the owner's phone): every admin table is a card under 700 px, the
// filters are one bar with one hint, the fields take the theme, the email kinds are words, the checklist reads
// the status the status service actually answers, and the storage tab reads the cloud scan from Network.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const css = read('public/css/admin.css');
const core = read('public/js/admin/core.js');
const html = read('public/admin.html');
const content = read('public/js/admin/content.js');
const moderation = read('public/js/admin/moderation.js');

// 1. One shared pattern: the tables become cards under 700 px.
assert.ok(css.includes('.admin-cards .admin-table'), 'the card pattern is scoped to the admin tables');
assert.ok(/@media\(max-width:700px\)\{[\s\S]*\.admin-cards \.admin-table tr\{[^}]*border-radius:12px/.test(css), 'a row becomes a card');
assert.ok(css.includes('.admin-cards .admin-table td.admin-cell-title'), 'the main column is the card title');
assert.ok(css.includes('.admin-cards .admin-table td.admin-cell-check'), 'a row checkbox has its own place');
assert.ok(/\.admin-cards \.admin-table td\.admin-cell-check input\[type=checkbox\]\{width:24px!important/.test(css), 'the checkbox is a 24 px box');
assert.ok(css.includes('.admin-cards .admin-table td.admin-cell-title{order:-1}'), 'the title comes first in the card');
assert.ok(/function adminTableCards\(root\)/.test(core), 'the helper marks the cells');
assert.ok(/td\.dataset\.label = heads\[i\]/.test(core) || /if \(!td\.dataset\.label && heads\[i\]\) td\.dataset\.label = heads\[i\]/.test(core), 'the label comes from the table header');
assert.ok(core.includes("td.classList.add('admin-cell-title')") && core.includes("td.classList.add('admin-cell-check')"), 'the title and the checkbox cell are marked');
for (const sec of ['users', 'bans', 'storage', 'email', 'audit', 'modlog']) {
  assert.ok(html.includes('class="section admin-clarity admin-cards" id="sec-' + sec + '"'), sec + ' uses the shared card pattern');
}

// 2. Filters: one bar, one hint, and fields that take the theme.
assert.ok(html.includes('class="admin-filter-bar"'), 'the filters sit in one bar');
assert.ok(html.includes('id="help-modlog-filters"'), 'the moderation log has one hint for its filters');
assert.ok(!/help-modlog-action/.test(html) && !/help-modlog-actor/.test(html), 'no help paragraph under each filter field');
assert.ok(css.includes('.admin-filter-hint'), 'the hint has its own rule');
assert.ok(css.includes('.admin-clarity .admin-field :is(input:not([type=checkbox]):not([type=radio]),select,textarea)'), 'the fields take the theme');
assert.ok(/background:var\(--bg-input\)/.test(css), 'a field has the panel background, not the browser grey');

// 3. Email: the kinds are words and the status is a short chip.
assert.ok(content.includes('function emailKindWords(type)'), 'the kinds are words');
assert.ok(content.includes("'Notification: ' + adminHumanWords"), 'a notification kind reads Notification: <words>');
assert.ok(content.includes('function emailStatusChip(status)'), 'the status is a chip');
assert.ok(content.includes('admin-chip is-'), 'the chip has a tone');
assert.ok(content.includes('title="${esc(s.long)}"'), 'the long sentence is the chip tooltip');

// 4. The checklist reads the status the status service answers (up, not ready).
assert.ok(moderation.includes('const CHECKLIST_STATUS = {'), 'the status words are named');
for (const word of ['up:', 'degraded:', 'down:', "'not-running':", 'unknown:']) assert.ok(moderation.includes(word), 'the checklist knows ' + word);
assert.ok(!/ready:'Ready to use/.test(moderation), 'the panel does not wait for a word no service answers');
assert.ok(moderation.includes('it.status_reason'), 'a row that was not checked says why');
const checklist = read('server/admin/operator-checklist.js');
assert.ok(checklist.includes('status_reason: reason'), 'the route answers with the reason');

// 5. Storage: the cloud scan is Network's own call, and the recording shows its owner.
assert.ok(content.includes("api('/api/admin/storage/cloud'"), 'the tab asks Network for the cloud scan');
assert.ok(!content.includes('Failed to scan buckets'), 'the raw refusal is no longer shown to the owner');
assert.ok(content.includes('liveUserNames'), 'the recording shows the name behind its owner id');
const storage = read('server/admin/storage.js');
assert.ok(storage.includes("selfToken(MEDIA_AUDIENCE, [MEDIA_CAPABILITY])"), 'Network mints its own service token');
assert.ok(storage.includes("'x-ov-subject': subject"), "the owner's usr_ travels in X-OV-Subject");
assert.ok(storage.includes('/api/v1/'), 'Media is asked on its own tenant route');
assert.ok(storage.includes('ok: false'), 'a refused scan answers with words, not a raw provider error');

console.log('admin-phone-cards: tables as cards, filters as one bar, fields in the theme, email kinds in words, the checklist reads the real status, the cloud scan is Network own call');
