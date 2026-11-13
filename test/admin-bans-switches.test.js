'use strict';
// The admin panel, 2026-11-13 (the owner's phone): bans are cards that show who (a name that opens their card), the
// reason and who banned them, and only the owner sees "Allow access again"; every on/off is the network's switch, never
// a checkbox stretched to a text field's height.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const mod = read('public/js/admin/moderation.js');
assert.ok(/const owner = !!\(typeof currentUser !== 'undefined' && currentUser && currentUser\.is_owner\);/.test(mod), 'the owner is known on the page');
assert.ok(/<li class="ban-card">/.test(mod) && /data-ov-user="\$\{esc\(u\)\}"/.test(mod), 'each ban is a card with a name that opens the person\'s card');
assert.ok(/No reason was written\./.test(mod), 'a ban without a reason says so');
assert.ok(/\$\{owner\s*\?\s*`<button[^`]*unbanStreamer/.test(mod) && /Only the owner can lift it/.test(mod), 'only the owner gets the button');

const core = read('public/js/admin/core.js');
assert.ok(/function adminSwitches\(\)/.test(core) && /c\.setAttribute\('role', 'switch'\)/.test(core) && /c\.closest\('table, \[data-ov-native\]'\)/.test(core), 'a lone checkbox becomes the switch; a table\'s stays a checkbox');
const css = read('public/css/admin.css');
assert.ok(css.includes('.admin-clarity :is(input:not([type=checkbox]):not([type=radio]),select,textarea) { max-width:100%; min-height:44px;'), 'the field height is for fields only');
assert.ok(css.includes('.admin-clarity input[type=checkbox], .admin-clarity input[type=radio], #platform-ai input[type=checkbox] { min-height:0; }'), 'and never for a switch');
// Email: every admin sees the delivery numbers; the settings, the recent messages (addresses) and changes are the owner's.
const routes = read('server/admin/routes.js');
assert.ok(/router\.get\('\/email', async \(req, res\) => \{[\s\S]{0,300}if \(!isOwner\(req\.user\)\) \{[\s\S]{0,300}can_edit: false/.test(routes), 'an admin reads the numbers only');
assert.ok(/router\.put\('\/email', requireOwner/.test(routes) && /router\.post\('\/broadcast', requireOwner/.test(routes), 'changing email and broadcasting are the owner\'s');
const content = read('public/js/admin/content.js');
assert.ok(/data\.can_edit === false \? '<p class="muted email-view-only">/.test(content), 'the page says it is read-only');
assert.ok(/OWNER_ONLY_TABS = new Set\(\[[^\]]*'notifications'/.test(core) && !/OWNER_ONLY_TABS = new Set\(\[[^\]]*'email'/.test(core), 'Notifications is the owner\'s tab; Email is open to read');
console.log('admin-bans-switches: bans as cards with who and why, unban for the owner only, every on/off a switch');
