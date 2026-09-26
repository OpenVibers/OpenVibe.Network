'use strict';
// Operator parity checklist (WS-D task 5): every item names at least one place; every tab it opens
// exists on the admin page (a button and a loader); every console is an OpenVibe https origin; every
// service is in the registry; items without a tab or console are marked as gaps, not hidden.
//   node test/operator-checklist.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { services } = require('openvibe-contracts');
const { AREAS, checklist } = require('../server/admin/operator-checklist');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');
const buttons = new Set([...html.matchAll(/showTab\('([a-z-]+)'/g)].map((m) => m[1]));
const block = html.slice(html.indexOf('const tabLoaders = {'), html.indexOf('};', html.indexOf('const tabLoaders = {')));
const loaders = new Set([...block.matchAll(/^\s{4}'?([a-z-]+)'?:/gm)].map((m) => m[1]));
const ids = new Set(services.manifests.map((m) => m.id));
const plan = ['users', 'search', 'roles', 'bans', 'settings', 'email', 'announcements', 'health', 'storage', 'media', 'queues', 'moderation', 'billing', 'loyalty', 'migration', 'compatibility', 'deploy', 'certificates'];
const text = JSON.stringify(AREAS).toLowerCase();
for (const word of plan) assert.ok(text.includes(word.replace('queues', 'dead letters').replace('announcements', 'announcements')), `the checklist covers ${word}`);

let items = 0;
for (const a of AREAS) for (const it of a.items) {
    items++;
    assert.ok(it.where.length, `${it.item}: somewhere to do it`);
    if (it.service) assert.ok(ids.has(it.service), `${it.item}: ${it.service} is a registry service`);
    for (const w of it.where) {
        if (w.kind === 'tab') { assert.ok(buttons.has(w.tab), `${it.item}: tab ${w.tab} has a button`); assert.ok(loaders.has(w.tab), `${it.item}: tab ${w.tab} has a loader`); }
        else if (w.kind === 'url') assert.match(w.url, /^https:\/\/([a-z0-9-]+\.)*openvibe\.[a-z]+(\/|$)/, `${it.item}: ${w.url} is an OpenVibe origin`);
        else assert.ok(['api', 'cli'].includes(w.kind) && (w.api || w.cli), `${it.item}: ${w.kind}`);
    }
}
assert.ok(items >= 20);
const out = checklist([{ id: 'billing', status: 'ready' }]);
const pay = out.flatMap((a) => a.items).find((i) => /Payments/.test(i.item));
assert.deepStrictEqual([pay.status, pay.console], ['ready', true]);
const community = out.flatMap((a) => a.items).find((i) => /Community moderation/.test(i.item));
assert.deepStrictEqual([community.status, community.console], ['unknown', false], 'a gap is shown as a gap');
console.log(`operator checklist: all checks passed (${items} items)`);
