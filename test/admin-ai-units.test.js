'use strict';
// The owner settings form's unit labels (public/js/admin/ai.js, Platform AI). An integer with
// x-unit "seconds" is shown in seconds with the label "s" (the same treatment as ms); a unit this
// page does not know is still a plain number, so a newer openvibe-shared schema renders before the
// pin moves.
//   node test/admin-ai-units.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'admin', 'ai.js'), 'utf8');
const ctx = {
    esc: (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    console,
};
vm.createContext(ctx);
vm.runInContext(src + '\n;globalThis.__paiField = paiField;', ctx);

const field = (unit) => ctx.__paiField(
    { values: { interval: 90 } }, 'interval',
    { type: 'integer', title: 'Interval', ...(unit ? { 'x-unit': unit } : {}) }, false, null,
);

{
    const html = field('seconds');
    assert.match(html, /data-type="integer"/);
    assert.match(html, /value="90"/, 'the input is in seconds');
    assert.match(html, /<span class="pai-unit">s<\/span>/, 'seconds is labelled "s"');
    assert.ok(!html.includes('>seconds<'), 'the raw unit name is not shown');
}
{
    const ms = field('ms');
    assert.match(ms, /<span class="pai-unit">ms<\/span>/, 'ms keeps its label');
    assert.match(ms, /value="90"/);
}
{
    const unknown = field('fortnights');
    assert.ok(!unknown.includes('pai-unit'), 'an unknown unit renders as a plain number');
    assert.match(unknown, /value="90"/);
}
console.log('admin-ai-units: seconds, ms and an unknown unit render as expected');
