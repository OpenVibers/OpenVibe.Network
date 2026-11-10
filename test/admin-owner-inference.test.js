'use strict';
// "Who answers, and what it costs" on the Platform AI page (public/js/admin/inference.js; the owner, 2026-11-10:
// cheapest inference "configurable in admin panel by owner"). Pure checks in a vm, as admin-ai-clarity does:
//   - the six kinds of work, each a row whose summary says its choice as a sentence;
//   - the uncensored kind shows its two locks and offers no switch for them;
//   - "My order" offers only models of the right type from providers that are on, uncensored ones only for that kind;
//   - Save posts routing and economy for that kind, with the order, the ceiling, the never-use list and the limits;
//   - a spending limit posts dollars for that provider; a bad number is refused in words, nothing is sent;
//   - nothing secret-looking is ever drawn.
//   node test/admin-owner-inference.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'admin', 'inference.js'), 'utf8');
const posts = [];
const toasts = [];
const ctx = {
    console,
    esc: (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    toast: (m, t) => toasts.push([m, t]),
    paiFriendly: (s, e) => e.message,
    paiApi: async (p, o) => { if (o && o.method === 'POST') { posts.push([p, o.body]); return { ok: true }; } return { config: ctx.__data }; },
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => ctx.__nodes || [] },
};
vm.createContext(ctx);
vm.runInContext(src + '\n;globalThis.__oin = { OIN, OIN_KINDS, oinKindCard, oinSentence, oinModels, oinLimits, oinStrip, oinCosts, oinSaveKind, oinSaveCap, oinProviderCards, oinRules, oinCompute, oinPricebook, oinSaveProvider, oinSaveRules, oinSaveEndpoint, oinProposePrices, oinDraft, oinState };', ctx);
const O = ctx.__oin;

const P = (key, status, extra = {}) => ({ key, display_name: key.toUpperCase(), status, capabilities: ['chat'], key_state: 'configured', ...extra });
ctx.__data = {
    providers: [P('deepinfra', 'active', { spend_cap: { daily_usd: 5, monthly_usd: 100 }, spend: { spent_today: 4.31, spent_month: 61.2 } }), P('venice', 'active', { uncensored: true }), P('parasail', 'disabled')],
    models: [
        { provider_key: 'deepinfra', model_key: 'gpt-oss-120b', type: 'chat', cost_out_per_mtok: 0.19, content_tier: 'standard' },
        { provider_key: 'deepinfra', model_key: 'bge-m3', type: 'embedding', cost_out_per_mtok: 0, content_tier: 'standard' },
        { provider_key: 'venice', model_key: 'glm-heretic', type: 'chat', cost_out_per_mtok: 0.4, content_tier: 'uncensored' },
        { provider_key: 'parasail', model_key: 'kimi-k2.6', type: 'chat', cost_out_per_mtok: 3, content_tier: 'standard' },
    ],
    routing: [{ capability: 'chat', strategy: 'cheapest', ceiling: 2, denylist: ['venice'], choices: [], enabled: true }],
    economy: [{ capability: 'chat', small_first: true, output_limit: 4000 }],
    costs_24h: { by_provider: [{ provider: 'deepinfra', calls: 10, cost: 0.5, tokens_in: 100, tokens_out: 10, failures: 1, by_model: [{ model: 'gpt-oss-120b', calls: 10, cost: 0.5, tokens_in: 100, tokens_out: 10 }] }] },
    costs_7d: { by_provider: [] },
    kinds: { chat: { savings: { batches: { runs: 2, saved_usd: 0.25 }, prompt_cache: { cached_tokens: 1000 }, answer_cache: { cached_runs: 3 } } } },
    controls: [
        { key: 'iteracompute', display_name: 'IteraCompute', enabled: false, tier: null, traits: { latency_classes: ['background', 'batch'], concurrency: 1, payment: 'none', free_allowance: { tokens: 30000000, ends_at: '2026-11-24T08:00:00Z' }, source: 'https://iteracompute.com/free/', checked: '2026-11-10' }, allowance: { tokens: 30000000, left: 30000000, ends_at: '2026-11-24T08:00:00Z' }, data_policy: { trains: null, retention: null } },
        { key: 'inception', display_name: 'Inception Labs', enabled: false, tier: null, traits: { latency_classes: ['interactive', 'background', 'batch'], source: 'https://docs.inceptionlabs.ai/resources/faq', checked: '2026-11-10' }, data_policy: { trains: true, retention: 'standard' } },
    ],
    rules: { private_training: false, flex_interactive: false, latency_limited_interactive: false, free_allowance_first: true },
    compute: { providers: [
        { key: 'runpod', display_name: 'Runpod', billing: 'per second', source: 'https://www.runpod.io/pricing', checked: '2026-11-10', pods: [{ gpu: 'RTX 3090 24GB', hourly_usd: 0.5 }], credits: { starter_usd: 1000, starter_eligibility: 'raised under $1M' } },
    ], endpoint: null },
    pricebook: { confirmed: [{ provider_key: 'sable', model_key: 'deepseek-v4.1-flash-1017-uncensored', in_per_mtok: 0.15, out_per_mtok: 0.6, source: 'https://sableapi.com/models', checked_at: '2026-11-10' }] },
};
O.OIN.data = ctx.__data;

(async () => {
    // Six kinds, each a row that says its choice.
    assert.strictEqual(O.OIN_KINDS.map((k) => k.id).join(' '), 'chat uncensored embed image transcribe batch');
    const chat = O.oinKindCard(O.OIN_KINDS[0]);
    assert.match(chat, /^<details class="oin-kind" data-kind="chat">/);
    assert.match(chat, /<span class="oin-now">The cheapest answers first · at most \$2\.00 per million output tokens · 1 never used · 2 ways of paying less<\/span>/);
    assert.strictEqual(O.oinSentence('embed', O.oinState('embed')), 'OpenVibe.AI chooses', 'nothing set reads as the default');

    // The uncensored kind: both locks, and no control for either.
    const unc = O.oinKindCard(O.OIN_KINDS[1]);
    assert.match(unc, /Adults only\.<\/b> The 18\+ check runs before every call\. Always on\./);
    assert.match(unc, /Nothing sexual involving a minor\.<\/b> Blocked in front of every provider and model\. Always on\./);
    assert.ok(!/data-oin="(adult|minor|floor|gate)/i.test(unc), 'no switch for the locks');

    // My order: the right type, providers that are on, uncensored only for its own kind.
    assert.strictEqual(O.oinModels('chat').map((m) => m.model).join(' '), 'gpt-oss-120b');
    assert.strictEqual(O.oinModels('uncensored').map((m) => m.model).join(' '), 'glm-heretic');
    assert.strictEqual(O.oinModels('embed').map((m) => m.model).join(' '), 'bge-m3');

    // Save: routing then economy, for that kind.
    const d = O.oinDraft('chat');
    d.strategy = 'fixed'; d.choices.push({ provider: 'deepinfra', model: 'gpt-oss-120b' }); d.ceiling = '1.5'; d.output_limit = '2000'; d.batches = true;
    await O.oinSaveKind('chat', { disabled: false });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(posts)), [
        ['/owner-inference/routing', { capability: 'chat', strategy: 'fixed', enabled: true, ceiling_usd_per_mtok_out: 1.5, denylist: ['venice'], choices: [{ provider: 'deepinfra', model: 'gpt-oss-120b' }] }],
        ['/owner-inference/economy', { capability: 'chat', small_first: true, batches: true, prompt_cache: false, answer_cache: false, output_limit: 2000 }],
    ]);
    posts.length = 0;
    // An empty order is refused in words; nothing is sent.
    const e = O.oinDraft('embed'); e.strategy = 'fixed';
    await O.oinSaveKind('embed', { disabled: false });
    assert.strictEqual(posts.length, 0);
    assert.match(toasts[toasts.length - 1][0], /Add at least one model to your order/);
    const bad = O.oinDraft('image'); bad.output_limit = '-4';
    await O.oinSaveKind('image', { disabled: false });
    assert.strictEqual(posts.length, 0);
    assert.match(toasts[toasts.length - 1][0], /^Longest answer: a whole number above 0/);

    // A spending limit: dollars for that provider; blank is no limit.
    const row = { dataset: { provider: 'deepinfra' }, querySelector: (s) => ({ value: s.includes('daily') ? '7' : '' }) };
    await O.oinSaveCap(row, { disabled: false });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(posts)), [['/owner-inference/spend-caps', { provider_key: 'deepinfra', daily_usd: 7, monthly_usd: null }]]);

    // The limits, the strip and the costs; nothing secret-looking anywhere.
    const limits = O.oinLimits();
    assert.match(limits, /\$4\.31 <span class="muted">of \$5\.00<\/span>/);
    assert.match(limits, /Providers that are off \(1\)/);
    const strip = O.oinStrip();
    assert.match(strip, /Saved this week<\/span><b>\$0\.25<\/b>/);
    // The provider wave: each provider's traits and source, the rules at safe values, the rented capacity
    // and the confirmed prices.
    const providers = O.oinProviderCards();
    assert.match(providers, /IteraCompute/);
    assert.match(providers, /answers background, batch \u00b7 1 at a time/);
    assert.match(providers, /30M free tokens left of 30M/);
    assert.match(providers, /not stated/);
    assert.match(providers, /training: <span class="oin-bad">yes<\/span>/);
    const rules = O.oinRules();
    for (const key of ['private_training', 'flex_interactive', 'latency_limited_interactive', 'free_allowance_first']) assert.ok(rules.includes('data-oin-rule="' + key + '"'), key + ' switch');
    assert.match(O.oinCompute(), /\$0\.50/);
    assert.match(O.oinCompute(), /startup credits/);
    assert.match(O.oinPricebook(), /1 readings/);
    // Saving a provider posts its on/off and its tier.
    const pRow = { dataset: { oinProvider: 'iteracompute' }, querySelector: (spec) => (spec.includes('provider-on') ? { checked: true } : { value: 'flex' }) };
    await O.oinSaveProvider(pRow, { disabled: false });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(posts.pop())), ['/owner-inference/providers', { provider_key: 'iteracompute', enabled: true, tier: 'flex' }]);
    // The rules all travel together.
    ctx.__nodes = [{ dataset: { oinRule: 'private_training' }, checked: false }, { dataset: { oinRule: 'free_allowance_first' }, checked: true }];
    await O.oinSaveRules({ disabled: false });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(posts.pop())), ['/owner-inference/rules', { private_training: false, free_allowance_first: true }]);
    ctx.__nodes = [];
    await O.oinProposePrices({ disabled: false });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(posts.pop())), ['/owner-inference/pricebook/propose', { proposals: ctx.__data.pricebook.confirmed }]);
    const all = chat + unc + limits + strip + O.oinCosts() + providers + rules + O.oinCompute() + O.oinPricebook();
    assert.ok(!/api_key|secret|sk-[a-z0-9]/i.test(all), 'no key or secret is drawn');
    console.log('admin-owner-inference: six kinds as sentences, the locks shown and never switchable, the order by type, saves and limits posted, bad numbers refused, no secret drawn');
})().catch((err) => { console.error(err); process.exit(1); });
