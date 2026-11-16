'use strict';
// "Set this up for me" on /admin/ai/setup (2026-11-16, plan §AD.15: "guided setup that saves defaults … proposes and
// saves defaults (keys stay with the person)"): from the keys already saved it proposes a model for every task kind
// and a safe monthly cap for each kind with none; nothing is saved until "Use these", which saves exactly that.
//   node test/admin-ai-setup-plan.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const els = {};
const el = (id) => (els[id] ||= { id, innerHTML: '', textContent: '', className: '', disabled: false, scrollIntoView() {} });
['setup-main', 'setup-steps', 'setup-progress', 'setup-plan-apply'].forEach(el);
const calls = [];
const toasts = [];
const ctx = {
    esc: (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    toast: (m, kind) => toasts.push([m, kind]),
    api: async (url, o) => { calls.push([o && o.method || 'GET', url, o && o.body]); if (url === '/api/admin/ai/setup') return STATE(); return {}; },
    console, window: {},
    document: { getElementById: (id) => els[id] || null, querySelectorAll: () => [] },
};
const opt = (provider, model, o = {}) => ({ provider, provider_name: provider[0].toUpperCase() + provider.slice(1), model, label: model, ...o });
const STATE = () => ({
    steps: [{ id: 'chat', name: 'Chat and writing', ready: true, state: 'ready' }],
    summary: { total: 1, ready: 1 },
    defaults: [
        // The recommended provider has a key: it is chosen; no cap yet, $3.40 in 30 days → $7.
        { id: 'chat', name: 'Chat and writing', options: [opt('deepseek', 'deepseek-flash', { recommended: true, configured: true }), opt('openai', 'gpt-5-mini', { configured: true })], current: null, cap_usd: 0, estimated_month_usd: 3.4 },
        // The recommended provider has no key, another one does: that one is chosen; its own cap is kept.
        { id: 'images', name: 'Pictures', options: [opt('gemini', 'imagen-4', { recommended: true, configured: false }), opt('openai', 'gpt-image-1', { configured: true })], current: null, cap_usd: 40, estimated_month_usd: 12 },
        // No provider has a key: the recommended one waits for it (not saved); a safe cap at the $5 floor.
        { id: 'speech', name: 'Speech', options: [opt('elevenlabs', 'eleven-v3', { recommended: true, configured: false })], current: null, cap_usd: 0, estimated_month_usd: 0 },
        // Already on its pick, with a cap: nothing to change.
        { id: 'decide', name: 'Decisions', options: [opt('gemini', 'gemini-decision-1', { recommended: true, configured: true })], current: { provider: 'gemini', model: 'gemini-decision-1' }, cap_usd: 10, estimated_month_usd: 1 },
    ],
});
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'admin', 'ai-setup.js'), 'utf8')
    + '\n;globalThis.__s = { set: (s) => { aiSetupState = s; }, step: () => aiSetupStep, plan: aiSetupPlan, renderAiSetup, selectAiSetupStep, apply: applyAiSetupPlan };', ctx);
const S = ctx.__s;

(async () => {
    S.set(STATE());
    // Start offers it first; the recommended set is still there.
    S.renderAiSetup();
    assert.match(els['setup-main'].innerHTML, /Set this up for me/);
    assert.match(els['setup-main'].innerHTML, /Use the recommended set/);

    const plan = S.plan().map((x) => [x.kind, x.pick && x.pick.model, x.keyNeeded, x.saveModel, x.cap, x.capKept]);
    assert.deepStrictEqual(plan, [
        ['chat', 'deepseek-flash', false, true, 7, false],
        ['images', 'gpt-image-1', false, true, 40, true],
        ['speech', 'eleven-v3', true, false, 5, false],
        ['decide', 'gemini-decision-1', false, false, 10, true],
    ], 'the recommended model with a key, else one with a key, else the recommended one waiting; caps kept or made safe');

    // The proposal says it all before anything is saved.
    S.selectAiSetupStep('plan');
    const page = els['setup-main'].innerHTML;
    assert.match(page, /Here is what I would set/);
    assert.match(page, /Needs a key from Elevenlabs/);
    assert.match(page, /\$40\.00 <span class="muted">\(yours, kept\)/);
    assert.match(page, /\$7\.00 <span class="muted">\(new; about \$3\.40 a month now\)/);
    assert.match(page, /One job waits for a provider/);
    assert.match(page, />Use these</);
    assert.strictEqual(calls.filter(([m]) => m !== 'GET').length, 0, 'nothing is saved by looking');

    // Use these: exactly the proposed models and new caps; the key-less model is not pinned.
    await S.apply();
    const saved = calls.filter(([m]) => m === 'PUT').map(([, u, b]) => `${u} ${JSON.stringify(b)}`);
    assert.deepStrictEqual(saved, [
        '/api/admin/ai/setup/routes/chat {"provider":"deepseek","model":"deepseek-flash"}',
        '/api/admin/ai/setup/caps/chat {"cap_usd":7}',
        '/api/admin/ai/setup/routes/images {"provider":"openai","model":"gpt-image-1"}',
        '/api/admin/ai/setup/caps/speech {"cap_usd":5}',
    ]);
    assert.match(toasts.at(-1)[0], /^2 models and 2 caps saved; 1 waits for a key$/);
    assert.strictEqual(S.step(), 'providers', 'a job waiting for a key leads to Providers and keys');
    console.log('admin-ai-setup-plan: proposes from saved keys with safe caps, saves nothing by looking, Use these saves exactly that');
})().catch((e) => { console.error(e); process.exit(1); });
