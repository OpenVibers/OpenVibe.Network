'use strict';
// The admin panel's Hosting tab (plan §AD.18): GET /api/admin/hosting-plan is admin only, and the plan it serves has
// today's facts, four phases each with its trigger, cost and the owner's part, and every price with a source and date.
//   node test/admin-hosting-plan.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { plan, CHECKED } = require('../server/admin/hosting-plan');

const p = plan();
assert.strictEqual(p.checked, CHECKED);
assert.ok(p.now.facts.length >= 4 && p.now.incidents.length >= 1, 'today, measured');
assert.strictEqual(p.phases.length, 4);
for (const ph of p.phases) assert.ok(ph.title && ph.when && ph.cost && ph.trigger && ph.owner && ph.steps.length, ph.id);
for (const row of [...p.compute, ...p.database, ...p.storage]) {
    assert.ok(row.src === null || /^https:\/\//.test(row.src), `${row.provider || row.option}: an https source`);
    assert.ok(row.read, `${row.provider || row.option}: the source's date`);
}
assert.ok(p.compute.length >= 5 && p.database.length >= 5 && p.storage.length >= 4, 'prices compared');
assert.ok(p.owner.length >= 1, 'what needs the owner');

const index = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
assert.match(index, /app\.use\('\/api\/admin\/hosting-plan', requireAuth, requireAdmin, require\('\.\/admin\/hosting-plan'\)\.router\(\)\)/, 'admin only');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');
assert.ok(html.includes("showTab('hosting',this)") && html.includes('id="sec-hosting"') && html.includes('/js/admin/hosting.js'), 'the tab, its section and its script');
const boot = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'admin', 'boot.js'), 'utf8');
assert.match(boot, /hosting: loadHosting/);
console.log('admin-hosting-plan: the Hosting tab serves today, the phases and every price with its source');
