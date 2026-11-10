/* ═══════════════════════════════════════════════════════════════
   OpenVibe.Network — admin panel, Platform AI: "Who answers, and what it costs" (owner only).

   The owner, 2026-11-10: "implement stuff like [Parasail] or anything else you can find for cheapest inference, and
   also other methods, and make it all configurable in admin panel by owner." OpenVibe.AI keeps the configuration
   (server/owner-config.js); Network's proxy is /api/admin/ai/config/owner-inference (owner only, audited, no key ever
   in it). This file draws one section of the Platform AI page (admin/ai.js calls oinLoad() after it renders):
     - the spend strip: the last day and the last week, and what batches saved;
     - one card per kind of work: who answers first (automatic, cheapest, fastest or the owner's own order), the most
       a million output tokens may cost, providers never to use, and the ways of paying less;
     - the uncensored kind carries its two locks, shown and never switchable;
     - spending limits per provider (a day, a month), with what was spent;
     - what it cost, per provider and model, for the last day or week.
   Classic script, global scope: it uses admin/core.js (api, esc, toast) and admin/ai.js (paiApi, paiFriendly).
   ═══════════════════════════════════════════════════════════════ */
const OIN_KINDS = [
    { id: 'chat', name: 'Chat and agents', icon: 'fa-comments', what: 'Vibe, Actor, Codes and every conversation on the sites.' },
    { id: 'uncensored', name: 'Uncensored (adults only)', icon: 'fa-lock-open', what: 'The 18+ tier: abliterated and uncensored models.' },
    { id: 'embed', name: 'Search and memory', icon: 'fa-magnifying-glass', what: 'Embeddings: what search, memory and recommendations read.' },
    { id: 'image', name: 'Pictures', icon: 'fa-image', what: 'Generated pictures, thumbnails and goal art.' },
    { id: 'transcribe', name: 'Speech to text', icon: 'fa-microphone-lines', what: 'Transcripts of streams, recordings and voice messages.' },
    { id: 'batch', name: 'Work that can wait', icon: 'fa-hourglass-half', what: 'Summaries, backfills and anything not in front of a person.' },
];
const OIN_STRATEGIES = [
    ['auto', 'Automatic', 'OpenVibe.AI weighs price, speed and health'],
    ['cheapest', 'Cheapest', 'The lowest price that passes the floors below'],
    ['fastest', 'Fastest', 'The quickest answer, at any price under the ceiling'],
    ['fixed', 'My order', 'Your list, top first; the next one when it fails'],
];
// The ways of paying less. `acts`: whether the switch changes calls today (OpenVibe.AI #445: the output limit and the
// small model first do; the other three are recorded and their savings measured, but do not yet rewire the calls).
const OIN_ECONOMY = [
    ['small_first', 'Try a small model first', 'A large one answers only when the small one cannot.', true],
    ['batches', 'Send it to a batch when it can wait', 'About half price; the answer comes within a day.', false],
    ['prompt_cache', 'Keep repeated prompts cached', 'The same opening is paid once, then at a fraction.', false],
    ['answer_cache', 'Reuse an identical answer', 'Only for the same person asking the same thing.', false],
];
const OIN = { data: null, window: '24h', busy: false, drafts: {} };

const oinMoney = (v) => {
    const n = Number(v) || 0;
    if (n === 0) return '$0';
    if (n < 0.01) return '$' + n.toFixed(4).replace(/0+$/, '');
    if (n < 100) return '$' + n.toFixed(2);
    return '$' + Math.round(n).toLocaleString('en-US');
};
const oinCount = (v) => {
    const n = Number(v) || 0;
    if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1e4) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
    return n.toLocaleString('en-US');
};
const oinProvider = (key) => ((OIN.data && OIN.data.providers) || []).find((p) => p.key === key);
const oinProviderName = (key) => { const p = oinProvider(key); return (p && p.display_name) || key; };

async function oinLoad() {
    const box = document.getElementById('oin-body');
    if (!box) return;
    try {
        const r = await paiApi('/owner-inference');
        OIN.data = r.config || {};
        OIN.drafts = {};
        oinRender();
    } catch (err) {
        box.innerHTML = '<p class="pai-error">' + esc(paiFriendly('ai', err)) + '</p>';
    }
}

function oinRender() {
    const box = document.getElementById('oin-body');
    if (!box || !OIN.data) return;
    box.innerHTML = oinStrip()
        + '<h4 class="pai-subhead">Each kind of work</h4><div class="oin-kinds">' + OIN_KINDS.map(oinKindCard).join('') + '</div>'
        + '<h4 class="pai-subhead" id="oin-limits">Spending limits</h4><p class="muted oin-lead">The most each provider may cost in a day and in a month. Past a limit it is skipped until the day or the month turns, and the next one in line answers. Turn providers on and add their keys in AI providers above.</p>'
        + oinLimits()
        + '<h4 class="pai-subhead">What it cost</h4>' + oinCosts();
    if (!box.dataset.wired) {
        box.dataset.wired = '1';
        box.addEventListener('click', oinClick);
        box.addEventListener('change', oinChange);
        box.addEventListener('input', oinInput);
    }
}

// ── The strip: the last day, the last week, what was saved ──────────────────────────────────────────────────────
function oinTotals(c) {
    const t = { cost: 0, calls: 0, failures: 0, tokens: 0 };
    for (const p of (c && c.by_provider) || []) { t.cost += Number(p.cost) || 0; t.calls += Number(p.calls) || 0; t.failures += Number(p.failures) || 0; t.tokens += (Number(p.tokens_in) || 0) + (Number(p.tokens_out) || 0); }
    return t;
}
function oinStrip() {
    const day = oinTotals(OIN.data.costs_24h), week = oinTotals(OIN.data.costs_7d);
    const s = (OIN.data.kinds && OIN.data.kinds.chat && OIN.data.kinds.chat.savings) || {};
    const batch = s.batches || {}, cache = s.prompt_cache || {}, answers = s.answer_cache || {};
    const tile = (label, big, sub, tone = '') => '<div class="oin-tile' + (tone ? ' is-' + tone : '') + '"><span class="oin-tile-k">' + label + '</span><b>' + big + '</b><span class="oin-tile-sub">' + sub + '</span></div>';
    const failed = (t) => t.failures ? ' · <span class="oin-bad">' + oinCount(t.failures) + ' failed</span>' : '';
    const saved = batch.saved_usd != null ? oinMoney(batch.saved_usd) : '—';
    return '<div class="oin-strip">'
        + tile('Last 24 hours', oinMoney(day.cost), oinCount(day.calls) + ' calls · ' + oinCount(day.tokens) + ' tokens' + failed(day))
        + tile('Last 7 days', oinMoney(week.cost), oinCount(week.calls) + ' calls · ' + oinCount(week.tokens) + ' tokens' + failed(week))
        + tile('Saved this week', saved, (batch.runs ? oinCount(batch.runs) + ' batch runs' : 'no batch runs yet') + ' · ' + oinCount(cache.cached_tokens) + ' cached tokens · ' + oinCount(answers.cached_runs) + ' reused answers', batch.saved_usd > 0 ? 'good' : '')
        + '</div>';
}

// ── One card per kind of work ────────────────────────────────────────────────────────────────────────────────────
function oinState(kind) {
    if (OIN.drafts[kind]) return OIN.drafts[kind];
    const r = ((OIN.data.routing || []).find((x) => x.capability === kind)) || {};
    const e = ((OIN.data.economy || []).find((x) => x.capability === kind)) || {};
    return {
        strategy: r.enabled === false || !r.strategy ? 'auto' : r.strategy,
        ceiling: r.ceiling == null ? '' : String(r.ceiling),
        denylist: Array.isArray(r.denylist) ? r.denylist.slice() : [],
        choices: Array.isArray(r.choices) ? r.choices.map((c) => ({ provider: c.provider, model: c.model })) : [],
        small_first: !!e.small_first, batches: !!e.batches, prompt_cache: !!e.prompt_cache, answer_cache: !!e.answer_cache,
        output_limit: e.output_limit == null ? '' : String(e.output_limit),
    };
}
function oinDraft(kind) { if (!OIN.drafts[kind]) OIN.drafts[kind] = oinState(kind); return OIN.drafts[kind]; }

/** The card's state as one sentence, so the owner reads the choice before the controls. */
function oinSentence(kind, st) {
    const how = { auto: 'OpenVibe.AI chooses', cheapest: 'The cheapest answers first', fastest: 'The fastest answers first', fixed: 'Your order' }[st.strategy] || 'OpenVibe.AI chooses';
    const bits = [how + (st.strategy === 'fixed' && st.choices.length ? ' (' + st.choices.length + ')' : '')];
    if (st.ceiling !== '') bits.push('at most ' + oinMoney(st.ceiling) + ' per million output tokens');
    if (st.denylist.length) bits.push(st.denylist.length + ' never used');
    const on = OIN_ECONOMY.filter(([k]) => st[k]).length + (st.output_limit !== '' ? 1 : 0);
    if (on) bits.push(on + ' way' + (on === 1 ? '' : 's') + ' of paying less');
    return bits.join(' · ');
}

/** The models this kind may pick from, for "My order": registered models of providers that are on (for uncensored,
 *  uncensored models only), cheapest output first. */
function oinModels(kind) {
    const out = [];
    for (const m of (OIN.data.models || [])) {
        const p = oinProvider(m.provider_key || m.provider);
        if (!p || p.status !== 'active') continue;
        if (kind === 'uncensored' ? m.content_tier !== 'uncensored' : m.content_tier === 'uncensored') continue;
        // The model's own type (OpenVibe.AI models.type: chat | vision | embedding | stt | image) decides the kind.
        const type = String(m.type || 'chat');
        const fits = kind === 'embed' ? type === 'embedding' : kind === 'transcribe' ? type === 'stt' : kind === 'image' ? /image/.test(type) : type === 'chat' || type === 'vision';
        if (!fits) continue;
        out.push({ provider: p.key, model: m.model_key || m.model, label: (p.display_name || p.key) + ' · ' + (m.display_name || m.model_key || m.model), out: Number(m.cost_out_per_mtok) });
    }
    return out.sort((a, b) => (Number.isFinite(a.out) ? a.out : 1e9) - (Number.isFinite(b.out) ? b.out : 1e9));
}

function oinKindCard(k) {
    const st = oinState(k.id);
    const dirty = !!OIN.drafts[k.id];
    const radios = OIN_STRATEGIES.map(([id, label, hint]) => '<label class="oin-seg-opt" title="' + esc(hint) + '"><input type="radio" name="oin-strategy-' + k.id + '" value="' + id + '" data-oin="strategy" data-ov-native' + (st.strategy === id ? ' checked' : '') + '><span>' + label + '</span></label>').join('');
    const hint = (OIN_STRATEGIES.find(([id]) => id === st.strategy) || [])[2] || '';
    const models = st.strategy === 'fixed' ? oinModels(k.id) : [];
    const order = st.strategy !== 'fixed' ? ''
        : '<div class="oin-order">'
            + (st.choices.length ? '<ol class="oin-order-list">' + st.choices.map((c, i) => '<li><span class="oin-order-n">' + (i + 1) + '</span><span class="oin-order-name">' + esc(oinProviderName(c.provider)) + ' <code>' + esc(c.model || 'its default') + '</code></span>'
                + '<button type="button" class="oin-icon" data-oin-act="up" data-i="' + i + '" aria-label="Move up"' + (i === 0 ? ' disabled' : '') + '><i class="fa-solid fa-arrow-up" aria-hidden="true"></i></button>'
                + '<button type="button" class="oin-icon" data-oin-act="down" data-i="' + i + '" aria-label="Move down"' + (i === st.choices.length - 1 ? ' disabled' : '') + '><i class="fa-solid fa-arrow-down" aria-hidden="true"></i></button>'
                + '<button type="button" class="oin-icon is-x" data-oin-act="drop" data-i="' + i + '" aria-label="Remove"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button></li>').join('') + '</ol>'
                : '<p class="muted oin-note">Nothing in your order yet: until you add one, OpenVibe.AI chooses.</p>')
            + (models.length ? '<div class="oin-add"><select data-oin="pick" aria-label="Add a model to the order"><option value="">Add a model…</option>' + models.filter((m) => !st.choices.some((c) => c.provider === m.provider && c.model === m.model)).map((m) => '<option value="' + esc(JSON.stringify([m.provider, m.model])) + '">' + esc(m.label) + (Number.isFinite(m.out) ? ' · ' + oinMoney(m.out) + ' out' : '') + '</option>').join('') + '</select></div>'
                : '<p class="muted oin-note">No provider that is on offers this kind yet.</p>')
            + '</div>';
    const deny = '<div class="pai-chips">' + st.denylist.map((key) => '<span class="pai-chip"><span>' + esc(oinProviderName(key)) + '</span><button type="button" data-oin-act="undeny" data-key="' + esc(key) + '" aria-label="Allow ' + esc(oinProviderName(key)) + ' again">×</button></span>').join('')
        + '<select class="oin-deny-add" data-oin="deny" aria-label="Never use a provider"><option value="">' + (st.denylist.length ? 'Add another…' : 'None. Add one…') + '</option>' + ((OIN.data.providers || []).filter((p) => !st.denylist.includes(p.key)).map((p) => '<option value="' + esc(p.key) + '">' + esc(p.display_name || p.key) + '</option>').join('')) + '</select></div>';
    const economy = OIN_ECONOMY.map(([key, label, desc, acts]) => '<label class="oin-way"><span class="pai-switch"><input type="checkbox" role="switch" data-oin="' + key + '" data-ov-native' + (st[key] ? ' checked' : '') + '><span class="pai-track" aria-hidden="true"><span class="pai-knob"></span></span></span>'
        + '<span class="oin-way-text"><b>' + label + '</b><span class="muted">' + desc + (acts ? '' : ' <span class="oin-soon">Recorded; not changing calls yet</span>') + '</span></span></label>').join('')
        + '<label class="oin-way oin-way-num"><span class="oin-way-text"><b>Longest answer</b><span class="muted">Tokens; blank is the model\'s own limit.</span></span><input type="number" min="1" step="1" inputmode="numeric" data-oin="output_limit" value="' + esc(st.output_limit) + '" placeholder="No limit" aria-label="Longest answer in tokens"></label>';
    const locks = k.id !== 'uncensored' ? '' : '<div class="oin-locks">'
        + '<div class="oin-lock"><i class="fa-solid fa-lock" aria-hidden="true"></i><span><b>Adults only.</b> The 18+ check runs before every call. Always on.</span></div>'
        + '<div class="oin-lock"><i class="fa-solid fa-lock" aria-hidden="true"></i><span><b>Nothing sexual involving a minor.</b> Blocked in front of every provider and model. Always on.</span></div></div>';
    // A row that reads as a sentence; it opens to change it (the six kinds fit one screen, nothing is hidden: the
    // choice is in the row itself).
    return '<details class="oin-kind' + (dirty ? ' is-dirty' : '') + '" data-kind="' + k.id + '"' + (dirty ? ' open' : '') + '>'
        + '<summary class="oin-kind-head"><span class="oin-kind-ic"><i class="fa-solid ' + k.icon + '" aria-hidden="true"></i></span><span class="oin-kind-t"><b>' + esc(k.name) + '</b><span class="oin-now">' + esc(oinSentence(k.id, st)) + '</span></span><i class="fa-solid fa-chevron-down oin-chev" aria-hidden="true"></i></summary>'
        + '<div class="oin-kind-body"><p class="muted oin-what">' + esc(k.what) + '</p>' + locks
        + '<div class="oin-row"><span class="oin-label" id="oin-who-' + k.id + '">Who answers first</span><div class="oin-seg" role="radiogroup" aria-labelledby="oin-who-' + k.id + '">' + radios + '</div><p class="muted oin-note">' + esc(hint) + '</p>' + order + '</div>'
        + '<div class="oin-row oin-two"><label class="oin-money"><span class="oin-label">Price ceiling, per million tokens out</span><span class="pai-prefix">$</span><input type="number" min="0" step="0.01" inputmode="decimal" data-oin="ceiling" value="' + esc(st.ceiling) + '" placeholder="No ceiling"></label>'
        + '<div><span class="oin-label">Never use</span>' + deny + '</div></div>'
        + '<details class="oin-ways"' + (OIN_ECONOMY.some(([key]) => st[key]) || st.output_limit !== '' ? ' open' : '') + '><summary>Ways of paying less</summary><div class="oin-ways-list">' + economy + '</div></details>'
        + '<footer class="oin-kind-foot"><span class="oin-dirty-note" aria-live="polite">' + (dirty ? 'Not saved yet' : '') + '</span>'
        + '<button type="button" class="btn btn-sm pai-quiet" data-oin-act="reset"' + (dirty ? '' : ' hidden') + '>Undo</button>'
        + '<button type="button" class="btn btn-sm btn-primary" data-oin-act="save"' + (dirty ? '' : ' disabled') + '>Save</button></footer>'
        + '</div></details>';
}

// ── Spending limits ──────────────────────────────────────────────────────────────────────────────────────────────
function oinLimitRow(p) {
    const cap = p.spend_cap || {}, spend = p.spend || {};
    const on = p.status === 'active';
    const key = p.key_state === 'missing' ? '<span class="oin-bad">No key</span>' : p.key_state === 'not_required' ? 'No key needed' : 'Key set';
    const used = (spent, limit) => oinMoney(spent) + (limit != null && limit !== '' ? ' <span class="muted">of ' + oinMoney(limit) + '</span>' : '');
    const pct = (spent, limit) => (limit ? Math.min(100, Math.round((Number(spent) || 0) / Number(limit) * 100)) : 0);
    const meter = (spent, limit) => (limit ? '<span class="oin-meter' + (pct(spent, limit) >= 100 ? ' is-over' : pct(spent, limit) >= 80 ? ' is-near' : '') + '" aria-hidden="true"><span style="width:' + pct(spent, limit) + '%"></span></span>' : '');
    return '<div class="oin-limit' + (on ? '' : ' is-off') + '" data-provider="' + esc(p.key) + '">'
        + '<div class="oin-limit-name"><b>' + esc(p.display_name || p.key) + '</b><span class="muted">' + (on ? 'On' : 'Off') + ' · ' + key + (p.uncensored ? ' · 18+' : '') + '</span></div>'
        + '<div class="oin-limit-use"><span class="oin-label">Today</span><span>' + used(spend.spent_today, cap.daily_usd) + '</span>' + meter(spend.spent_today, cap.daily_usd) + '</div>'
        + '<div class="oin-limit-use"><span class="oin-label">This month</span><span>' + used(spend.spent_month, cap.monthly_usd) + '</span>' + meter(spend.spent_month, cap.monthly_usd) + '</div>'
        + '<div class="oin-limit-set"><label><span class="oin-label">A day</span><span class="pai-prefix">$</span><input type="number" min="0" step="1" inputmode="decimal" data-oin-cap="daily_usd" value="' + esc(cap.daily_usd == null ? '' : cap.daily_usd) + '" placeholder="None"></label>'
        + '<label><span class="oin-label">A month</span><span class="pai-prefix">$</span><input type="number" min="0" step="1" inputmode="decimal" data-oin-cap="monthly_usd" value="' + esc(cap.monthly_usd == null ? '' : cap.monthly_usd) + '" placeholder="None"></label>'
        + '<button type="button" class="btn btn-sm pai-quiet" data-oin-act="cap">Save</button></div>'
        + '</div>';
}
function oinLimits() {
    const all = (OIN.data.providers || []).slice();
    const used = (p) => (p.spend && (Number(p.spend.spent_month) || 0)) || 0;
    const first = all.filter((p) => p.status === 'active' || p.spend_cap).sort((a, b) => used(b) - used(a));
    const rest = all.filter((p) => !first.includes(p));
    if (!all.length) return '<p class="muted">No providers yet.</p>';
    return '<div class="oin-limits">' + first.map(oinLimitRow).join('') + '</div>'
        + (rest.length ? '<details class="pai-more"><summary>Providers that are off (' + rest.length + ')</summary><div class="oin-limits">' + rest.map(oinLimitRow).join('') + '</div></details>' : '');
}

// ── What it cost ─────────────────────────────────────────────────────────────────────────────────────────────────
function oinCosts() {
    const c = OIN.window === '7d' ? OIN.data.costs_7d : OIN.data.costs_24h;
    const rows = ((c && c.by_provider) || []).slice().sort((a, b) => (Number(b.cost) || 0) - (Number(a.cost) || 0));
    const seg = '<div class="oin-seg oin-seg-sm" role="radiogroup" aria-label="Which days">' + [['24h', 'Last 24 hours'], ['7d', 'Last 7 days']].map(([id, label]) => '<label class="oin-seg-opt"><input type="radio" name="oin-window" value="' + id + '" data-oin="window" data-ov-native' + (OIN.window === id ? ' checked' : '') + '><span>' + label + '</span></label>').join('') + '</div>';
    if (!rows.length) return seg + '<p class="muted oin-note">No calls in this window.</p>';
    const max = Math.max(...rows.map((r) => Number(r.cost) || 0), 0.000001);
    const row = (r) => '<details class="oin-cost"><summary><span class="oin-cost-name">' + esc(oinProviderName(r.provider)) + '</span>'
        + '<span class="oin-cost-bar" aria-hidden="true"><span style="width:' + Math.max(2, Math.round((Number(r.cost) || 0) / max * 100)) + '%"></span></span>'
        + '<span class="oin-cost-n"><b>' + oinMoney(r.cost) + '</b> <span class="muted">' + oinCount(r.calls) + ' calls' + (r.failures ? ' · <span class="oin-bad">' + oinCount(r.failures) + ' failed</span>' : '') + '</span></span></summary>'
        + '<table class="pai-table oin-models"><thead><tr><th>Model</th><th>Calls</th><th>Tokens in</th><th>Tokens out</th><th>Cost</th></tr></thead><tbody>'
        + (r.by_model || []).map((m) => '<tr><td><code>' + esc(m.model) + '</code></td><td>' + oinCount(m.calls) + (m.failures ? ' <span class="oin-bad">(' + oinCount(m.failures) + ' failed)</span>' : '') + '</td><td>' + oinCount(m.tokens_in) + '</td><td>' + oinCount(m.tokens_out) + '</td><td>' + oinMoney(m.cost) + '</td></tr>').join('')
        + '</tbody></table></details>';
    return seg + '<div class="oin-costs">' + rows.map(row).join('') + '</div>';
}

// ── Changes ──────────────────────────────────────────────────────────────────────────────────────────────────────
function oinRepaint(kind) {
    const old = document.querySelector('#oin-body .oin-kind[data-kind="' + kind + '"]');
    const k = OIN_KINDS.find((x) => x.id === kind);
    if (!old || !k) return;
    const open = old.querySelector('.oin-ways') && old.querySelector('.oin-ways').open;
    const t = document.createElement('template');
    t.innerHTML = oinKindCard(k);
    const fresh = t.content.firstElementChild;
    fresh.open = old.open || fresh.open;
    if (open && fresh.querySelector('.oin-ways')) fresh.querySelector('.oin-ways').open = true;
    old.replaceWith(fresh);
}
function oinMarkDirty(card) {
    if (!card) return;
    card.classList.add('is-dirty');
    const save = card.querySelector('[data-oin-act="save"]'), undo = card.querySelector('[data-oin-act="reset"]'), note = card.querySelector('.oin-dirty-note');
    if (save) save.disabled = false;
    if (undo) undo.hidden = false;
    if (note) note.textContent = 'Not saved yet';
    const now = card.querySelector('.oin-now');
    if (now) now.textContent = oinSentence(card.dataset.kind, oinDraft(card.dataset.kind));
}
function oinInput(ev) {
    const el = ev.target.closest('[data-oin="ceiling"], [data-oin="output_limit"]');
    const card = el && el.closest('.oin-kind');
    if (!card) return;
    oinDraft(card.dataset.kind)[el.dataset.oin] = el.value.trim();
    oinMarkDirty(card);
}
function oinChange(ev) {
    const el = ev.target;
    if (el.dataset.oin === 'window') { OIN.window = el.value; oinRender(); return; }
    const card = el.closest('.oin-kind');
    if (!card) return;
    const kind = card.dataset.kind, d = oinDraft(kind);
    if (el.dataset.oin === 'strategy') { d.strategy = el.value; oinRepaint(kind); return; }
    if (el.dataset.oin === 'pick' && el.value) { try { const [provider, model] = JSON.parse(el.value); d.choices.push({ provider, model }); } catch { /* not a choice */ } oinRepaint(kind); return; }
    if (el.dataset.oin === 'deny' && el.value) { if (!d.denylist.includes(el.value)) d.denylist.push(el.value); oinRepaint(kind); return; }
    if (OIN_ECONOMY.some(([key]) => key === el.dataset.oin)) { d[el.dataset.oin] = el.checked; oinMarkDirty(card); }
}
async function oinClick(ev) {
    const btn = ev.target.closest('[data-oin-act]');
    if (!btn || btn.disabled) return;
    const act = btn.dataset.oinAct;
    if (act === 'cap') return oinSaveCap(btn.closest('.oin-limit'), btn);
    const card = btn.closest('.oin-kind');
    if (!card) return;
    const kind = card.dataset.kind, d = oinDraft(kind), i = Number(btn.dataset.i);
    if (act === 'up' && i > 0) { [d.choices[i - 1], d.choices[i]] = [d.choices[i], d.choices[i - 1]]; return oinRepaint(kind); }
    if (act === 'down' && i < d.choices.length - 1) { [d.choices[i + 1], d.choices[i]] = [d.choices[i], d.choices[i + 1]]; return oinRepaint(kind); }
    if (act === 'drop') { d.choices.splice(i, 1); return oinRepaint(kind); }
    if (act === 'undeny') { d.denylist = d.denylist.filter((k) => k !== btn.dataset.key); return oinRepaint(kind); }
    if (act === 'reset') { delete OIN.drafts[kind]; return oinRepaint(kind); }
    if (act === 'save') return oinSaveKind(kind, btn);
}
function oinNumber(text, { integer = false } = {}) {
    if (text === '' || text == null) return { value: null };
    const n = Number(text);
    if (!Number.isFinite(n) || n < 0 || (integer && (!Number.isInteger(n) || n < 1))) return { error: integer ? 'a whole number above 0' : 'a number of dollars, 0 or more' };
    return { value: n };
}
async function oinSaveKind(kind, btn) {
    const d = oinDraft(kind);
    const ceiling = oinNumber(d.ceiling), limit = oinNumber(d.output_limit, { integer: true });
    if (ceiling.error) return toast('Price ceiling: ' + ceiling.error, 'error');
    if (limit.error) return toast('Longest answer: ' + limit.error, 'error');
    if (d.strategy === 'fixed' && !d.choices.length) return toast('Add at least one model to your order, or choose Automatic.', 'error');
    btn.disabled = true;
    try {
        await paiApi('/owner-inference/routing', { method: 'POST', body: { capability: kind, strategy: d.strategy, enabled: d.strategy !== 'auto' || ceiling.value != null || d.denylist.length > 0, ceiling_usd_per_mtok_out: ceiling.value, denylist: d.denylist, choices: d.strategy === 'fixed' ? d.choices : [] } });
        await paiApi('/owner-inference/economy', { method: 'POST', body: { capability: kind, small_first: d.small_first, batches: d.batches, prompt_cache: d.prompt_cache, answer_cache: d.answer_cache, output_limit: limit.value } });
        toast((OIN_KINDS.find((k) => k.id === kind) || {}).name + ': saved', 'success');
        await oinLoad();
    } catch (err) {
        btn.disabled = false;
        toast(paiFriendly('ai', err), 'error');
    }
}
async function oinSaveCap(row, btn) {
    if (!row) return;
    const day = oinNumber(row.querySelector('[data-oin-cap="daily_usd"]').value.trim());
    const month = oinNumber(row.querySelector('[data-oin-cap="monthly_usd"]').value.trim());
    if (day.error || month.error) return toast('Spending limits are ' + (day.error || month.error), 'error');
    btn.disabled = true;
    try {
        await paiApi('/owner-inference/spend-caps', { method: 'POST', body: { provider_key: row.dataset.provider, daily_usd: day.value, monthly_usd: month.value } });
        toast(oinProviderName(row.dataset.provider) + ': limits saved', 'success');
        await oinLoad();
    } catch (err) {
        btn.disabled = false;
        toast(paiFriendly('ai', err), 'error');
    }
}
