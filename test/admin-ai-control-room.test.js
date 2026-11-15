'use strict';
// The AI control room's own parts (public/js/admin/ai-setup.js, 2026-11-15, plan §AD.9; the owner: "missing tons of
// models … can't even see configuring OpenRouter key", "missing configuration for our tons of providers", "missing all
// the different agents … the shared … node", "confusing and not worded properly"):
//   · Providers and keys lists every provider OpenVibe.AI knows, grouped, with its state, and opens one in place;
//   · a job lists every model that can do it, searchable, not only the hand-picked ones;
//   · the coding agents step lists Codes' harnesses with the key they run on, and the computers coding runs on;
//   · a keyless choice never says "Key needed"; jobs have plain names.
//   node test/admin-ai-control-room.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const els = {};
const el = (id) => (els[id] ||= { id, innerHTML: '', textContent: '', className: '', disabled: false, scrollIntoView() {} });
['setup-main', 'setup-steps', 'setup-progress'].forEach(el);
const calls = [];
const PROVIDERS = [
    { key: 'openrouter', display_name: 'OpenRouter (the last fallback)', status: 'disabled', auth_mode: 'bearer', credentials: 'missing', capabilities: ['chat', 'tools'], base_url: 'https://openrouter.ai/api/v1' },
    { key: 'deepseek', display_name: 'DeepSeek', status: 'active', auth_mode: 'bearer', secret_ref: 'vault:deepseek', key_hint: '9f2a', capabilities: '["chat","vision"]', base_url: 'https://api.deepseek.com/v1' },
    { key: 'anthropic', display_name: 'Anthropic', status: 'disabled', auth_mode: 'bearer', credentials: 'missing', capabilities: ['chat', 'vision', 'tools'], base_url: 'https://api.anthropic.com/v1' },
    { key: 'local', display_name: 'Local model (OpenAI-compatible server on this host)', status: 'active', auth_mode: 'none', capabilities: ['chat', 'embed'], base_url: 'http://127.0.0.1:8090/v1' },
    { key: 'exa', display_name: 'Exa', status: 'disabled', auth_mode: 'bearer', credentials: 'missing', capabilities: ['web-search'], base_url: 'https://api.exa.ai' },
    { key: 'fal', display_name: 'fal', status: 'disabled', auth_mode: 'bearer', credentials: 'missing', capabilities: ['image'], base_url: 'https://fal.run' },
    { key: 'stub', display_name: 'Stub', status: 'active', auth_mode: 'none', capabilities: ['chat'] },
];
const ctx = {
    esc: (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    toast() {}, console, window: {}, CSS: { escape: (s) => s }, location: {},
    api: async (p, o = {}) => {
        calls.push([o.method || 'GET', p, o.body || null]);
        if (p === '/api/admin/ai/config/providers') return { providers: PROVIDERS };
        if (p === '/api/admin/ai/setup/agents') return { harnesses: [{ id: 'claude-code', name: 'Claude Code', provider: 'anthropic' }, { id: 'opencode', name: 'OpenCode', provider: 'opencode-go' }, { id: 'openvibe-ai', name: 'OpenVibe.AI', provider: 'openvibe' }] };
        if (p === '/api/v1/machines') return { machines: [{ id: 'dev_1', name: 'ov-node-01', online: true, controls: { shared_jobs: true, worker: { serve_others: true } } }] };
        return {};
    },
    document: { getElementById: (id) => els[id] || null, querySelectorAll: () => [], querySelector: () => null, activeElement: null },
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'admin', 'ai-setup.js'), 'utf8')
    + '\n;globalThis.__s = { set: (s) => { aiSetupState = s; }, go: (id) => { aiSetupStep = id; }, render: renderAiSetup, providers: loadAiSetupProviders, agents: loadAiSetupAgents,'
    + ' query: (q) => { aiSetupModelQuery.chat = q; }, filter: (f) => { aiSetupProviderFilter = f; }, open: (k) => { aiSetupProviderOpen = k; } };', ctx);
const S = ctx.__s;
const offer = (provider, model, label, extra = {}) => ({ provider, provider_name: provider, model, label, price: { text: '$1 in · $2 out per 1M tokens' }, ...extra });
const many = Array.from({ length: 60 }, (_, i) => offer('openrouter', `vendor/model-${i}`, `Model ${i}`, { provider_name: 'OpenRouter (the last fallback)' }));
S.set({
    steps: [
        { id: 'chat', name: 'Chat and writing', what: 'Turns text into an answer.', uses: 'Everything.', ready: true, state: 'ready', route: 'default.chat',
            recommended: offer('deepseek', 'deepseek-flash', 'DeepSeek Flash', { configured: true }), alternatives: [offer('openai', 'gpt-5-mini', 'GPT-5 mini')],
            options: [offer('deepseek', 'deepseek-flash', 'DeepSeek Flash', { configured: true }), offer('openai', 'gpt-5-mini', 'GPT-5 mini'), ...many, offer('anthropic', 'claude-opus-5-5', 'Claude Opus 5.5')] },
        { id: 'search', name: 'Web search', what: 'Looks up the web.', uses: 'Deep dives.', ready: true, state: 'ready', route: null,
            recommended: offer('openvibe', 'openvibe-search', 'OpenVibe Search', { keyless: true }), alternatives: [], options: [] },
        { id: 'code', name: 'Code agents (plans)', what: 'Plans work.', uses: 'Codes.', ready: true, state: 'ready', route: 'space.build',
            recommended: offer('deepseek', 'deepseek-chat', 'DeepSeek Chat', { configured: true }), alternatives: [], options: [] },
    ],
    summary: { total: 3, ready: 3 }, defaults: [],
});

(async () => {
    // Providers and keys: every provider but the stub, grouped, the on ones first in a group, names without notes.
    await S.providers(true);
    S.go('providers'); S.render();
    let main = els['setup-main'].innerHTML;
    assert.match(main, /Every AI provider OpenVibe can use/);
    assert.match(main, /6 providers, 2 on/, 'the count, the stub left out');
    assert.ok(!/>Stub</.test(main), 'the stub is not a provider people set up');
    for (const g of ['One key for everything', 'Your own machines and the shared OpenVibe computers', 'The labs', 'Pictures and video', 'Search']) assert.ok(main.includes(g), `group ${g}`);
    assert.ok(main.indexOf('OpenRouter') < main.indexOf('Local model'), 'one key for everything comes first');
    assert.ok(!/OpenRouter \(the last fallback\)/.test(main), 'the registry\'s note stays out of the name');
    assert.match(main, /On · ••••9f2a/, 'a provider in use shows its last four');
    assert.match(main, /Key needed/, 'and one without a key says so');
    assert.match(els['setup-steps'].innerHTML, /Providers and keys/, 'the stepper has the step');
    // Filters and opening one in place.
    S.filter('search'); S.render();
    main = els['setup-main'].innerHTML;
    assert.ok(main.includes('Exa') && !main.includes('DeepSeek'), 'the Search filter shows search providers only');
    S.filter('all'); S.open('openrouter'); S.render();
    main = els['setup-main'].innerHTML;
    assert.match(main, /id="setup-prov-key"/, 'the open provider takes its key here');
    assert.match(main, /role="switch"/, 'and has its on/off switch');
    assert.match(main, /openvibe\.exchange\/console\/providers#openrouter/, 'and the same provider on Exchange');

    // A job: every model that can do it, searchable; the first 40 shown, then more on request.
    S.open(''); S.go('chat'); S.render();
    main = els['setup-main'].innerHTML;
    assert.match(main, /Every model that can do this <span class="muted">63<\/span>/, 'all 63, not the two hand-picked');
    assert.equal((main.match(/class="setup-model-row/g) || []).length, 40, 'forty at first');
    assert.match(main, /Show 23 more of 63/);
    S.query('opus'); S.render();
    main = els['setup-main'].innerHTML;
    assert.equal((main.match(/class="setup-model-row/g) || []).length, 1, 'the search finds Claude Opus 5.5');
    assert.match(main, /Claude Opus 5\.5/);

    // A keyless choice never says "Key needed".
    S.go('search'); S.render();
    main = els['setup-main'].innerHTML;
    assert.match(main, /No key needed/);
    assert.ok(!/setup-pill todo">Key needed/.test(main), 'OpenVibe Search needs no key');

    // Coding agents: plain name, the harnesses with the key they run on, the computers coding runs on.
    await S.agents(true);
    S.go('code'); S.render();
    main = els['setup-main'].innerHTML;
    assert.match(main, /<h3 id="setup-step-title">Coding agents<\/h3>/, 'a plain name, not "Code agents (plans)"');
    assert.match(main, /Where coding runs/);
    assert.match(main, /Never on OpenVibe's own server/);
    assert.match(main, /ov-node-01/);
    assert.match(main, /Shared with everyone/);
    assert.match(main, /Claude Code/);
    assert.match(main, /Add the Anthropic key/, 'an agent whose provider has no key says which key to add');
    assert.match(main, /OpenCode<\/strong><span class="muted">Runs on OpenRouter/, 'an open agent runs on OpenRouter');
    assert.ok(!/OpenVibe\.AI<\/strong>/.test(main), 'OpenVibe.AI itself is not a coding agent people pick');
    assert.ok(calls.some(([m, p]) => m === 'GET' && p === '/api/admin/ai/setup/agents'));
    console.log('admin-ai-control-room: providers and keys, every model per job, keyless says so, coding agents and their computers');
})().catch((err) => { console.error(err); process.exit(1); });
