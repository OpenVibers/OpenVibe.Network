'use strict';
// WCAG 2.1 AA: the intent chip's label was accent-light on a 14% accent wash (4.2:1 on Daylight).
// It now mixes the accent 60% into the theme text colour; the intent icon keeps its accent-light tone.
//   node test/contrast.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const rule = html.match(/\.intent-n\{[^}]*\}/);
assert.ok(rule, 'the .intent-n rule is present');
assert.ok(
    rule[0].includes('color:color-mix(in srgb,var(--accent) 60%,var(--text-primary));background:color-mix(in srgb,var(--accent) 14%,transparent)}'),
    'the intent label mixes the accent into the text colour and keeps its wash'
);
assert.ok(rule[0].includes('color:color-mix(in srgb,var(--accent) 60%,var(--text-primary))'), 'the label never falls back to accent-light');
console.log('contrast: the intent label reads on Daylight');
