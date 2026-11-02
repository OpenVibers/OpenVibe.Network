'use strict';
// "What you see" on /my (L1): a card beside "Your data choices", a row per content label with three equal choices,
// saved at once with all six (network.label-prefs@1), and a failed save puts the old choice back.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'my.html'), 'utf8');
const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'my', 'labels.js'), 'utf8');
const profile = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'my', 'profile.js'), 'utf8');

assert.ok(html.includes('<div class="card" id="labels-card">') && html.includes('What you see'), 'the card');
assert.ok(html.indexOf('id="consent-card"') < html.indexOf('id="labels-card"'), 'beside Your data choices');
assert.ok(html.includes('<script src="/js/my/labels.js" defer></script>'), 'its script');
assert.ok(profile.includes('loadLabelPrefs();'), 'started with the page');

for (const id of ['nudity', 'language', 'graphic', '18+', 'flashing', 'spoilers']) assert.ok(js.includes(`['${id}', `), id);
assert.ok(js.includes("[['show', 'Show'], ['blur', 'Blur'], ['hide', 'Hide']]"), 'three equal choices');
assert.ok(js.includes("setAttribute('role', 'radio')") && js.includes("setAttribute('aria-checked'"), 'a radio group a screen reader can read');
assert.ok(js.includes("apiFetch('/api/v1/me/label-prefs', { method: 'PUT', body: JSON.stringify({ prefs: labelPrefs }) })"), 'all six, saved at once');
assert.ok(/catch \(err\) \{\s*labelPrefs = before;/.test(js), 'a failed save puts the old choice back');
assert.ok(js.includes('Until they load, everything shows.'), 'says what happens when it cannot load');

console.log('my-labels-ui: all passed');
