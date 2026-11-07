'use strict';
// The account page's purpose rows (public/js/my/consent.js) and app grants from sign-in (C4, 2026-11-07).
// A row's On/Off is OpenVibe's own choice; an app's grant of the same purpose is turned off under "Apps you allowed".
// So a row must never read plain "Off" while an app still holds the purpose. What this proves:
//   - with only an app's grant, the row reads "Off for OpenVibe · 1 app allowed" and names the app (escaped);
//   - with no grant at all it still reads "Off by default" and carries no app note;
//   - app.data is unchanged: its row is every app's, so it never shows the note;
//   - a revoked (off) app row does not count.
//   node test/consent-account-holders.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'my', 'consent.js'), 'utf8');
const ctx = { document: { getElementById: () => null }, CSS: { escape: (s) => s }, apiFetch: async () => ({}), console };
vm.createContext(ctx);
vm.runInContext(`${source}
;globalThis.__t = { consentRow, consentAppHolders, set(doc, apps) { consentDoc = doc; consentAppsDoc = apps; } };`, ctx);
const t = ctx.__t;

const purpose = (id, extra = {}) => ({ id, title: id, allows: 'a', off: 'o', cannot_undo: '', kinds: [], adults_only: false, text_version: 'v', ...extra });
const row = (p, client, on = true) => ({ purpose: p, client, on, kinds: [], options: {} });

let n = 0;
const check = (name, fn) => { fn(); n++; console.log(`  ✓ ${name}`); };

check('an app still holding a purpose is named on the row, and the row does not read plain Off', () => {
    t.set({ purposes: [], consents: [row('ai.train', 'app_01')], history: [] },
        { apps: [{ client: 'app_01', name: 'Clip <Bot>' }] });
    assert.deepStrictEqual([...t.consentAppHolders('ai.train')], ['Clip <Bot>']);
    const html = t.consentRow(purpose('ai.train'));
    assert.match(html, /Off for OpenVibe · 1 app allowed/);
    assert.doesNotMatch(html, /Off by default/);
    assert.match(html, /Still allowed for Clip &lt;Bot&gt;\./);
    assert.match(html, /href="#consent-apps"/);
});

check('OpenVibe on plus two apps says both', () => {
    t.set({ purposes: [], consents: [row('ai.train', null), row('ai.train', 'app_01'), row('ai.train', 'app_02')], history: [] }, null);
    const html = t.consentRow(purpose('ai.train'));
    assert.match(html, /On for OpenVibe · 2 apps allowed/);
    assert.match(html, /Still allowed for app_01, app_02\./, 'before the app names load, the client ids stand in');
});

check('no grant anywhere still reads "Off by default" with no app note', () => {
    t.set({ purposes: [], consents: [row('ai.train', 'app_01', false)], history: [] }, null);
    const html = t.consentRow(purpose('ai.train'));
    assert.match(html, /Off by default/);
    assert.doesNotMatch(html, /Still allowed/);
});

check('app.data keeps its own row for every app and never shows the note', () => {
    t.set({ purposes: [], consents: [row('app.data', 'app_01')], history: [] }, null);
    assert.deepStrictEqual([...t.consentAppHolders('app.data')], []);
    assert.doesNotMatch(t.consentRow(purpose('app.data')), /Still allowed/);
});

console.log(`consent-account-holders: ${n} passed`);
