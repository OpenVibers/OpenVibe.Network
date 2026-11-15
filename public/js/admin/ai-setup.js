/* ═══════════════════════════════════════════════════════════════
   OpenVibe.Network — admin panel (/admin/ai/setup): the guided AI setup.
   One stepper (left on a computer, across the top on a phone), one card per job the estate
   needs, and a last Defaults step for every task kind's model, estimated spend and monthly cap.
   The API is /api/admin/ai/setup (server/admin/ai-setup.js) → OpenVibe.AI's own setup API.
   Classic script, global scope: it relies on admin/core.js's api(), esc() and toast().
   ═══════════════════════════════════════════════════════════════ */
let aiSetupState = null;
let aiSetupStep = 'start';
let aiSetupChoice = {};      // step id -> { provider, model }
let aiSetupBusy = false;
let aiSetupModels = null;    // the models that can answer a decision (OpenVibe.AI's list)

const AI_SETUP_DEFAULT = 'defaults';
// 2026-11-12 (the owner: "finish the guided easy step by step setup for owners"): the setup opens on a Start page (what
// it does, what is free, the credits you already get, one tap for the recommended set) and ends on a Finish page (what
// is ready, what is left, a test of every ready job).
const AI_SETUP_START = 'start';
const AI_SETUP_DONE = 'done';
const AI_SETUP_LINKS = {
    altare: 'https://altare.gg/console', gemini: 'https://aistudio.google.com/api-keys', machines: 'https://openvibe.link/machines',
    openaiCredits: 'https://developers.openai.com/api/docs/guides/chatgpt-api-credits', credits: 'https://openvibe.exchange/console/providers',
};
const AI_SETUP_STATE_WORD = { ready: 'Ready', not_set: 'Not set', failing: 'Failing' };
const AI_SETUP_STATE_CLASS = { ready: 'ok', not_set: 'todo', failing: 'bad' };

function aiSetupMoney(n) {
    const v = Number(n) || 0;
    if (!v) return 'free';
    return v < 0.01 ? '$' + v.toFixed(4) : '$' + v.toFixed(2);
}

function aiSetupShortPrice(price) {
    if (!price) return 'price not published';
    return price.text || 'price not published';
}

/** The kinds of decision the owner may set a model for (OpenVibe.AI names them). */
const AI_SETUP_DECISION_NAMES = {
    routing: 'Routing a request',
    moderation: 'Checking a post or a message',
    grading: 'Grading an answer',
    tool_choice: 'Choosing the next tool',
    other: 'Any other question',
};

/** One model in a sentence: its name, its price, its measured speed and whether its answers are calibrated. */
function aiSetupModelLabel(m) {
    const price = m.price_in_per_mtok == null
        ? 'free'
        : '$' + Number(m.price_in_per_mtok).toFixed(4) + ' in · $' + Number(m.price_out_per_mtok == null ? 0 : m.price_out_per_mtok).toFixed(4) + ' out per 1M tokens';
    const speed = m.speed_p50_ms == null ? 'speed not measured yet' : Math.round(Number(m.speed_p50_ms)) + ' ms';
    return (m.name || m.id) + ' · ' + price + ' · ' + speed + ' · ' + (m.calibrated ? 'calibrated' : 'estimated');
}

/** The models that can answer a decision, read once from OpenVibe.AI. */
async function loadAiSetupModels() {
    if (aiSetupModels) return aiSetupModels;
    try {
        const out = await api('/api/admin/ai/setup/decisions/models');
        aiSetupModels = (out && out.models) || [];
    } catch (err) { aiSetupModels = []; }
    return aiSetupModels;
}


function aiSetupStepById(id) {
    return (aiSetupState && aiSetupState.steps || []).find((s) => s.id === id) || null;
}

function aiSetupSelected(step) {
    const chosen = aiSetupChoice[step.id];
    if (chosen) {
        const all = [step.recommended, ...(step.alternatives || []), ...(step.options || [])];
        const hit = all.find((o) => o.provider === chosen.provider && o.model === chosen.model);
        if (hit) return hit;
    }
    return step.recommended;
}

/** The Decisions step's own table: the model that answers each kind, the one to ask when unsure, and how sure is enough. */
function aiSetupDecisionsHtml() {
    const values = (aiSetupState && aiSetupState.decisions) || {};
    const kinds = (aiSetupState && aiSetupState.decision_kinds) || Object.keys(AI_SETUP_DECISION_NAMES);
    const models = aiSetupModels || [];
    const options = (current) => {
        const auto = '<option value="" ' + (!current ? 'selected' : '') + '>OpenVibe picks the best offer</option>';
        return auto + models.map((m) => '<option value="' + esc(m.id) + '" ' + (current === m.id ? 'selected' : '') + '>' + esc(aiSetupModelLabel(m)) + (m.available ? '' : ' — not available now') + '</option>').join('');
    };
    const rows = kinds.map((kind) => {
        const v = values[kind] || {};
        const ladder = (v.ladder || [])[0] || '';
        const threshold = Number(v.threshold == null ? 0.75 : v.threshold);
        return '<tr>'
            + '<td data-label="Kind"><strong>' + esc(AI_SETUP_DECISION_NAMES[kind] || kind) + '</strong><div class="muted setup-route">' + esc(kind) + '</div></td>'
            + '<td data-label="The model that answers"><select aria-label="The model that answers ' + esc(kind) + '" onchange="saveAiSetupDecision(\'' + esc(kind) + '\',\'default_model\',this.value)">' + options(v.default_model || '') + '</select></td>'
            + '<td data-label="Asked when unsure"><select aria-label="The model asked when the answer is unsure for ' + esc(kind) + '" onchange="saveAiSetupDecision(\'' + esc(kind) + '\',\'ladder\',this.value)">' + options(ladder) + '</select></td>'
            + '<td data-label="How sure is enough"><input type="number" min="0" max="1" step="0.05" value="' + threshold + '" aria-label="How sure an answer must be for ' + esc(kind) + '" onchange="saveAiSetupDecision(\'' + esc(kind) + '\',\'threshold\',this.value)"></td>'
            + '</tr>';
    }).join('');
    if (!rows) return '';
    return '<section class="setup-decisions" aria-label="Which model answers a decision">'
        + '<h4>Which model answers</h4>'
        + '<p class="muted">One model per kind of question, with its price, its measured speed and whether its answers are calibrated. A model whose answer is not sure enough is asked again of the next one.</p>'
        + '<div class="setup-table-wrap"><table class="setup-table"><thead><tr><th>Kind</th><th>The model that answers</th><th>Asked when unsure</th><th>How sure is enough</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
        + '<p class="setup-help">“OpenVibe picks” is today’s order: Google’s Decisions API first when its key is there, the cheapest structured model after it. The confidence runs from 0 to 1; 0.75 is the default.</p>'
        + '</section>';
}

/** Save one kind's decision setting: the model, the model to ask when unsure, or the confidence. */
async function saveAiSetupDecision(kind, field, value) {
    const body = {};
    if (field === 'default_model') body.default_model = value || null;
    else if (field === 'ladder') body.ladder = value ? [value] : [];
    else if (field === 'threshold') {
        const t = Number(value);
        if (!Number.isFinite(t) || t < 0 || t > 1) { toast('The confidence is a number from 0 to 1', 'error'); return; }
        body.threshold = t;
    } else return;
    try {
        await api('/api/admin/ai/setup/decisions/' + encodeURIComponent(kind), { method: 'PUT', body });
        toast('Saved for ' + (AI_SETUP_DECISION_NAMES[kind] || kind));
        aiSetupState = null;
        await loadAiSetup(true);
    } catch (err) { toast(err.message || 'The setting was not saved', 'error'); }
}

function aiSetupIsChoice(step, offer) {
    const selected = aiSetupSelected(step);
    return selected.provider === offer.provider && selected.model === offer.model;
}

async function loadAiSetup(force) {
    const main = document.getElementById('setup-main');
    if (!main) return;
    if (!force && aiSetupState) { renderAiSetup(); return; }
    main.innerHTML = '<div class="loading">Loading the setup…</div>';
    try {
        aiSetupState = await api('/api/admin/ai/setup');
        if (!aiSetupState || !Array.isArray(aiSetupState.steps)) throw new Error('OpenVibe.AI did not answer with the setup');
        if (!aiSetupState.steps.some((s) => s.id === aiSetupStep) && ![AI_SETUP_DEFAULT, AI_SETUP_START, AI_SETUP_DONE, AI_SETUP_PROVIDERS, AI_SETUP_FREE].includes(aiSetupStep)) aiSetupStep = AI_SETUP_START;
        renderAiSetup();
    } catch (err) {
        main.innerHTML = `<div class="setup-error"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
            <div><strong>The setup could not be read.</strong><p class="muted">${esc(err.message || 'OpenVibe.AI did not answer')}</p>
            <button class="btn btn-outline btn-sm" onclick="loadAiSetup(true)">Try again</button></div></div>`;
    }
}

function renderAiSetup() {
    if (!aiSetupState) return;
    renderAiSetupStepper();
    renderAiSetupProgress();
    if (aiSetupStep === AI_SETUP_DEFAULT) renderAiSetupDefaults();
    else if (aiSetupStep === AI_SETUP_PROVIDERS) renderAiSetupProviders();
    else if (aiSetupStep === AI_SETUP_FREE) renderAiSetupFree();
    else if (aiSetupStep === AI_SETUP_START) renderAiSetupStart();
    else if (aiSetupStep === AI_SETUP_DONE) renderAiSetupDone();
    else renderAiSetupStep();
}

function renderAiSetupStepper() {
    const nav = document.getElementById('setup-steps');
    if (!nav) return;
    const start = `<button class="setup-step defaults ${aiSetupStep === AI_SETUP_START ? 'active' : ''}" onclick="selectAiSetupStep('${AI_SETUP_START}')" aria-current="${aiSetupStep === AI_SETUP_START ? 'step' : 'false'}">
        <span class="setup-step-dot" aria-hidden="true"><i class="fa-solid fa-flag"></i></span>
        <span class="setup-step-text"><span class="setup-step-name">Start</span><span class="setup-step-state">Free and granted first</span></span>
    </button>
    <button class="setup-step defaults ${aiSetupStep === AI_SETUP_PROVIDERS ? 'active' : ''}" onclick="selectAiSetupStep('${AI_SETUP_PROVIDERS}')" aria-current="${aiSetupStep === AI_SETUP_PROVIDERS ? 'step' : 'false'}">
        <span class="setup-step-dot" aria-hidden="true"><i class="fa-solid fa-key"></i></span>
        <span class="setup-step-text"><span class="setup-step-name">Providers and keys</span><span class="setup-step-state">${aiSetupProviderList ? aiSetupProviderList.filter((p) => p.status === 'active').length + ' of ' + aiSetupProviderList.length + ' on' : 'Every provider'}</span></span>
    </button>`;
    const rows = aiSetupState.steps.map((s, i) => {
        const active = aiSetupStep === s.id;
        const state = s.ready ? 'ready' : s.state;
        return `<button class="setup-step ${esc(state)} ${active ? 'active' : ''}" onclick="selectAiSetupStep('${esc(s.id)}')" aria-current="${active ? 'step' : 'false'}">
            <span class="setup-step-dot" aria-hidden="true">${s.ready ? '<i class="fa-solid fa-check"></i>' : (i + 1)}</span>
            <span class="setup-step-text"><span class="setup-step-name">${esc(aiSetupStepName(s))}</span><span class="setup-step-state">${esc(AI_SETUP_STATE_WORD[state] || state)}</span></span>
        </button>`;
    });
    rows.push(`<button class="setup-step defaults ${aiSetupStep === AI_SETUP_FREE ? 'active' : ''}" onclick="selectAiSetupStep('${AI_SETUP_FREE}')" aria-current="${aiSetupStep === AI_SETUP_FREE ? 'step' : 'false'}">
        <span class="setup-step-dot" aria-hidden="true"><i class="fa-solid fa-gift"></i></span>
        <span class="setup-step-text"><span class="setup-step-name">Free use and budgets</span><span class="setup-step-state">What people get free</span></span>
    </button>`);
    rows.push(`<button class="setup-step defaults ${aiSetupStep === AI_SETUP_DEFAULT ? 'active' : ''}" onclick="selectAiSetupStep('${AI_SETUP_DEFAULT}')" aria-current="${aiSetupStep === AI_SETUP_DEFAULT ? 'step' : 'false'}">
        <span class="setup-step-dot" aria-hidden="true"><i class="fa-solid fa-sliders"></i></span>
        <span class="setup-step-text"><span class="setup-step-name">Defaults</span><span class="setup-step-state">Models, spend and caps</span></span>
    </button>`);
    const done = aiSetupState.summary.ready === aiSetupState.summary.total;
    rows.push(`<button class="setup-step ${done ? 'ready' : 'todo'} ${aiSetupStep === AI_SETUP_DONE ? 'active' : ''}" onclick="selectAiSetupStep('${AI_SETUP_DONE}')" aria-current="${aiSetupStep === AI_SETUP_DONE ? 'step' : 'false'}">
        <span class="setup-step-dot" aria-hidden="true"><i class="fa-solid ${done ? 'fa-check' : 'fa-flag-checkered'}"></i></span>
        <span class="setup-step-text"><span class="setup-step-name">Finish</span><span class="setup-step-state">${done ? 'Everything is set' : 'What is left'}</span></span>
    </button>`);
    nav.innerHTML = start + rows.join('');
}

function renderAiSetupProgress() {
    const el = document.getElementById('setup-progress');
    if (!el) return;
    const total = aiSetupState.summary.total;
    const ready = aiSetupState.summary.ready;
    const pct = total ? Math.round((ready / total) * 100) : 0;
    el.innerHTML = `<div class="setup-progress-top"><span><strong>${ready} of ${total}</strong> ready</span>
        <button class="btn btn-primary btn-sm" onclick="nextAiSetupNotReady()">${ready === total ? 'Review defaults' : 'Continue setup'} <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></button></div>
        <div class="setup-bar" role="progressbar" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${ready}"><span style="width:${pct}%"></span></div>`;
}

function selectAiSetupStep(id) {
    aiSetupStep = id;
    renderAiSetup();
    const main = document.getElementById('setup-main');
    if (main && window.matchMedia && window.matchMedia('(max-width: 800px)').matches) main.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function nextAiSetupNotReady() {
    if (!aiSetupState) return;
    const ids = aiSetupState.steps.map((s) => s.id);
    const from = ids.indexOf(aiSetupStep);
    const order = from >= 0 ? [...ids.slice(from + 1), ...ids.slice(0, from + 1)] : ids;
    const next = order.find((id) => { const s = aiSetupStepById(id); return s && !s.ready; });
    selectAiSetupStep(next || (aiSetupStep === AI_SETUP_DEFAULT ? AI_SETUP_DONE : AI_SETUP_DEFAULT));
}

function skipAiSetupStep() {
    const step = aiSetupStepById(aiSetupStep);
    if (step) toast(`Skipped ${step.name}. ${step.uses} will not work until it is set.`, 'warning');
    nextAiSetupNotReady();
}

async function aiSetupChoose(stepId, provider, model) {
    aiSetupChoice[stepId] = { provider, model };
    const step = aiSetupStepById(stepId);
    const offer = step && [step.recommended, ...(step.alternatives || []), ...(step.options || [])].find((o) => o.provider === provider && o.model === model);
    renderAiSetup();
    const card = document.getElementById('setup-main');
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (step && step.route && offer && offer.configured) {
        try {
            await api(`/api/admin/ai/setup/routes/${encodeURIComponent(step.id)}`, { method: 'PUT', body: { provider, model } });
            toast('Route saved for ' + step.name);
            aiSetupState = null;
            await loadAiSetup(true);
        } catch (err) { toast(err.message || 'The route was not saved', 'error'); }
    }
}

function aiSetupKeyPage(offer) {
    if (offer && offer.key_page && offer.key_page.url) return offer.key_page;
    return null;
}

function renderAiSetupStep() {
    const step = aiSetupStepById(aiSetupStep) || (aiSetupState.steps[0] || null);
    const main = document.getElementById('setup-main');
    if (!step || !main) return;
    // The Decisions step picks a model out of the list of the models that can answer one: it is read once.
    if (step.id === 'decide' && !aiSetupModels) {
        main.innerHTML = '<div class="loading">Loading the models that can answer…</div>';
        loadAiSetupModels().then(() => renderAiSetup());
        return;
    }
    const selected = aiSetupSelected(step);
    const index = aiSetupState.steps.findIndex((s) => s.id === step.id);
    const state = step.ready ? 'ready' : step.state;
    const page = aiSetupKeyPage(selected);
    const keyless = selected.keyless || ['stt', 'local', 'whisper', 'openvibe', 'searxng', 'shared'].includes(selected.provider);
    const hint = (step.key_hint && step.key_hint.last4) || (selected.key_hint && selected.key_hint.last4);
    const configured = selected.configured;
    const alternatives = (step.alternatives || []).filter((o) => !aiSetupIsChoice(step, o));
    // Coding agents: every harness and the computers coding runs on, read once.
    if (step.id === 'code' && !aiSetupAgents) loadAiSetupAgents().then(() => { if (aiSetupStep === 'code') renderAiSetup(); });

    main.innerHTML = `
        <article class="setup-card" aria-labelledby="setup-step-title">
            <header class="setup-card-head">
                <div>
                    <span class="setup-kicker">Step ${index + 1} of ${aiSetupState.steps.length}</span>
                    <h3 id="setup-step-title">${esc(aiSetupStepName(step))}</h3>
                    <p class="setup-what">${esc(step.what)}</p>
                    <p class="setup-uses"><i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i> ${esc(step.uses)}</p>
                </div>
                <span class="setup-badge ${AI_SETUP_STATE_CLASS[state] || 'todo'}">${esc(AI_SETUP_STATE_WORD[state] || state)}</span>
            </header>

            <section class="setup-rec" aria-label="Recommended provider">
                <div class="setup-rec-main">
                    <div class="setup-rec-top"><span class="setup-rec-flag"><i class="fa-solid fa-star" aria-hidden="true"></i> ${aiSetupIsChoice(step, step.recommended) ? 'Recommended' : 'Chosen'}</span>
                        ${keyless ? '<span class="setup-pill ok">No key needed</span>' : selected.configured ? '<span class="setup-pill ok"><i class="fa-solid fa-check" aria-hidden="true"></i> Key saved</span>' : '<span class="setup-pill todo">Key needed</span>'}</div>
                    <h4>${esc(selected.provider_name)}<span class="setup-model"> · ${esc(selected.label || selected.model)}</span></h4>
                    <p class="setup-why">${esc(step.recommended.why || selected.why || '')}</p>
                    ${selected.note ? `<p class="setup-note">${esc(selected.note)}</p>` : ''}
                </div>
                <div class="setup-rec-price">
                    <span class="setup-price-label">Price</span>
                    <strong>${esc(aiSetupShortPrice(selected.price))}</strong>
                    ${selected.source ? `<a href="${esc(selected.source)}" target="_blank" rel="noopener noreferrer">seen ${esc(selected.checked || 'today')}</a>` : ''}
                </div>
            </section>

            ${alternatives.length ? `<details class="setup-others">
                <summary><i class="fa-solid fa-chevron-right" aria-hidden="true"></i> Other choices</summary>
                <div class="setup-other-list">
                    ${alternatives.map((o) => `<div class="setup-other">
                        <div><strong>${esc(o.provider_name)}</strong> <span class="muted">· ${esc(o.label || o.model)}</span>
                            <div class="setup-other-price">${esc(aiSetupShortPrice(o.price))}</div></div>
                        <div class="setup-other-actions">
                            ${o.key_page && o.key_page.url ? `<a class="btn btn-outline btn-sm" href="${esc(o.key_page.url)}" target="_blank" rel="noopener noreferrer">Get a key</a>` : ''}
                            <button class="btn btn-outline btn-sm" onclick="aiSetupChoose('${esc(step.id)}','${esc(o.provider)}','${esc(o.model)}')">Choose</button>
                        </div>
                    </div>`).join('')}
                </div>
            </details>` : ''}

            ${aiSetupEveryModelHtml(step)}

            ${step.id === 'code' ? aiSetupAgentsHtml() : ''}

            ${step.id === 'decide' ? aiSetupDecisionsHtml() : ''}

            <section class="setup-do">
                <div class="setup-do-head"><span class="setup-num">1</span><div><h4>Get a key</h4>
                    ${keyless ? '<p class="muted">No key needed: this runs on our own machine or the network\'s own index.</p>'
                        : page ? `<p class="muted">Open ${esc(selected.provider_name)}'s key page, sign in, and create a key.</p>
                            <p><a class="btn btn-primary" href="${esc(page.url)}" target="_blank" rel="noopener noreferrer"><i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i> Open ${esc(selected.provider_name)}'s key page</a></p>
                            <p class="setup-how">${esc(page.how || '')}</p>`
                        : '<p class="muted">This provider has no key page; paste the key its owner gave you.</p>'}
                </div></div>

                ${keyless ? '' : `<div class="setup-do-head"><span class="setup-num">2</span><div><h4>Paste it</h4>
                    ${hint && configured ? `<p class="setup-saved">Saved, ending in <strong>${esc(hint)}</strong>. It is never shown in full again.</p>` : ''}
                    <div class="setup-key-row">
                        <input id="setup-key-input" type="password" autocomplete="off" spellcheck="false" aria-label="${esc(selected.provider_name)} API key" placeholder="${configured ? 'Paste a new key to replace it' : 'Paste the key here'}" ${aiSetupBusy ? 'disabled' : ''}>
                        <button class="btn btn-primary" onclick="saveAiSetupKey('${esc(step.id)}')" ${aiSetupBusy ? 'disabled' : ''}><i class="fa-solid fa-lock" aria-hidden="true"></i> Save</button>
                    </div>
                    <p class="setup-help">The key goes straight to OpenVibe.AI, is sealed there, and is never logged or shown again. Only the last four characters stay visible.</p>
                </div></div>`}

                <div class="setup-do-head"><span class="setup-num">${keyless ? 2 : 3}</span><div><h4>Test</h4>
                    <p class="muted">${step.id === 'image' ? 'Makes one small picture, shows it at 256 px, and reports what it cost.' : step.id === 'stt' ? 'Transcribes a built-in two-second clip and reports what it cost.' : step.id === 'speech' ? 'Speaks one short sentence and reports what it cost.' : step.id === 'embedding' ? 'Embeds one short sentence and reports what it cost.' : step.id === 'search' ? 'Runs one small web search and reports what it cost.' : 'Asks one tiny real question through the route and reports what it cost.'}</p>
                    <div class="setup-test-row">
                        <button class="btn btn-outline" onclick="runAiSetupTest('${esc(step.id)}')" ${aiSetupBusy ? 'disabled' : ''}><i class="fa-solid fa-play" aria-hidden="true"></i> Run the test</button>
                        <span class="muted" id="setup-test-status"></span>
                    </div>
                    <div id="setup-test-out" class="setup-test-out" hidden></div>
                </div></div>
            </section>

            <footer class="setup-card-foot">
                <button class="btn btn-outline" onclick="selectAiSetupStep('${AI_SETUP_DEFAULT}')">Defaults</button>
                <div class="setup-foot-next">
                    <button class="btn btn-outline" onclick="skipAiSetupStep()">Skip</button>
                    <button class="btn btn-primary" onclick="nextAiSetupNotReady()">Next <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></button>
                </div>
            </footer>
        </article>`;
}

async function saveAiSetupKey(stepId) {
    if (aiSetupBusy) return;
    const step = aiSetupStepById(stepId);
    const selected = step && aiSetupSelected(step);
    const input = document.getElementById('setup-key-input');
    if (!step || !selected || !input) return;
    const key = String(input.value || '').trim();
    if (key.length < 8) { toast('Paste the whole key first', 'error'); input.focus(); return; }
    aiSetupBusy = true; input.disabled = true;
    const status = document.getElementById('setup-test-status');
    if (status) status.textContent = 'Saving…';
    try {
        await api(`/api/admin/ai/setup/providers/${encodeURIComponent(selected.provider)}/key`, { method: 'PUT', body: { key } });
        input.value = '';
        if (step.route) {
            await api(`/api/admin/ai/setup/routes/${encodeURIComponent(step.id)}`, { method: 'PUT', body: { provider: selected.provider, model: selected.model } });
        }
        toast('Key saved. It will never be shown in full again.');
        aiSetupBusy = false;
        await loadAiSetup(true);
    } catch (err) {
        aiSetupBusy = false; input.disabled = false;
        if (status) status.textContent = '';
        toast(err.message || 'The key was not saved', 'error');
    }
}

function aiSetupTestHtml(step, out) {
    const a = out.answer || {};
    let answer = '';
    if (a.image) answer = `<img class="setup-picture" src="${esc(a.image)}" width="256" height="256" alt="The picture the test made">`;
    else if (a.text) answer = `<blockquote>${esc(a.text)}</blockquote>`;
    else if (a.title) answer = `<p><a href="${esc(a.url || '#')}" target="_blank" rel="noopener noreferrer">${esc(a.title)}</a> <span class="muted">· ${Number(a.count) || 0} results</span></p>`;
    else if (step.id === 'embedding') answer = `<p class="setup-vector">${Number(a.dimensions) || 0} numbers: ${(a.sample || []).map((n) => Number(n).toFixed(3)).join(', ')} …</p>`;
    else if (step.id === 'speech') answer = `<p>${Number(a.characters) || 0} characters spoken (${esc(a.mime_type || 'audio')}).</p>`;
    return `<div class="setup-result">
        <div class="setup-result-head"><strong>It works</strong>
            <span>${esc(out.provider)}${out.model ? ' · ' + esc(out.model) : ''}</span>
            <span class="setup-cost">${aiSetupMoney(out.cost_usd)}</span>
            <span class="muted">${Number(out.latency_ms) || 0} ms</span>
            ${out.synthetic ? '<span class="setup-pill todo">stub answer</span>' : ''}
        </div>
        <div class="setup-result-body">${answer || '<p class="muted">The test answered.</p>'}</div>
    </div>`;
}

async function runAiSetupTest(stepId) {
    if (aiSetupBusy) return;
    const step = aiSetupStepById(stepId);
    const selected = step && aiSetupSelected(step);
    const out = document.getElementById('setup-test-out');
    const status = document.getElementById('setup-test-status');
    if (!step || !selected || !out) return;
    aiSetupBusy = true;
    out.hidden = true; out.innerHTML = '';
    if (status) status.textContent = 'Running one tiny request…';
    document.querySelectorAll('#sev-ai-setup button, #sec-ai-setup button').forEach((b) => { if (b.textContent.includes('Run the test') || b.textContent.includes('Save')) b.disabled = true; });
    try {
        const body = { provider: selected.provider };
        if (step.route) body.model = selected.model;
        const result = await api(`/api/admin/ai/setup/test/${encodeURIComponent(step.id)}`, { method: 'POST', body });
        out.innerHTML = aiSetupTestHtml(step, result);
        out.hidden = false;
        if (status) status.textContent = '';
        toast('The test answered');
        aiSetupState = null;
        await loadAiSetup(true);
        const freshOut = document.getElementById('setup-test-out');
        if (freshOut) { freshOut.innerHTML = aiSetupTestHtml(step, result); freshOut.hidden = false; }
    } catch (err) {
        if (status) status.textContent = '';
        out.innerHTML = `<div class="setup-result bad"><div class="setup-result-head"><strong>It did not work</strong></div><div class="setup-result-body"><p>${esc(err.message || 'The test did not answer')}</p><p class="muted">Check the key, that the provider has the model, and that the route can reach it.</p></div></div>`;
        out.hidden = false;
    } finally {
        aiSetupBusy = false;
        document.querySelectorAll('#sec-ai-setup button').forEach((b) => { b.disabled = false; });
    }
}

/** Start: what the setup does, what costs nothing, the credits you already get, and one tap for the recommended set. */
function renderAiSetupStart() {
    const main = document.getElementById('setup-main');
    if (!main || !aiSetupState) return;
    const first = (aiSetupState.steps.find((s) => !s.ready) || aiSetupState.steps[0] || { id: 'chat', name: 'Chat and writing' });
    const total = aiSetupState.summary.total;
    main.innerHTML = `
        <article class="setup-card" aria-labelledby="setup-start-title">
            <header class="setup-card-head">
                <div><p class="setup-kicker">Start</p><h2 id="setup-start-title">Set up OpenVibe's AI</h2>
                <p class="muted">${total} jobs, one at a time. Each one asks for a key, recommends a model with its price and runs one tiny test. Free and already-paid options come first.</p></div>
            </header>
            <section class="setup-start-grid">
                <div class="setup-start-card">
                    <h3><i class="fa-solid fa-gift" aria-hidden="true"></i> Start with what's free</h3>
                    <ul class="setup-start-list">
                        <li><strong>Altare Inference</strong>: free until December 1, then $100 of usage a month on its free plan. 60 requests a minute, 30 for its flagship models. <a href="${AI_SETUP_LINKS.altare}" target="_blank" rel="noopener">Get a key</a></li>
                        <li><strong>Gemini API free tier</strong>: Decisions (routing and checks) and pictures. The free tier may use what it reads to improve Google's products, so send public data only. <a href="${AI_SETUP_LINKS.gemini}" target="_blank" rel="noopener">Get a key</a></li>
                        <li><strong>Your own computer</strong>: a model on a machine you paired answers your own work, at no cost. <a href="${AI_SETUP_LINKS.machines}" target="_blank" rel="noopener">Your machines</a></li>
                    </ul>
                </div>
                <div class="setup-start-card">
                    <h3><i class="fa-solid fa-ticket" aria-hidden="true"></i> Credits you already pay for</h3>
                    <ul class="setup-start-list">
                        <li><strong>ChatGPT Pro</strong> includes $100, $200 or $500 of OpenAI API credit a month. Check ChatGPT, then Settings, then Billing, then API credits. The plan must be at least seven days old, and the same email must own it and the API organization. <a href="${AI_SETUP_LINKS.openaiCredits}" target="_blank" rel="noopener">How it works</a></li>
                        <li><strong>An Anthropic allowance</strong> or any plan with monthly API credit works the same way.</li>
                        <li>Record each as <strong>Monthly credits</strong> on <a href="${AI_SETUP_LINKS.credits}" target="_blank" rel="noopener">Exchange, then Console, then Providers</a>. OpenVibe then spends them first, and nothing carries over at the end of a cycle.</li>
                    </ul>
                </div>
                <div class="setup-start-card">
                    <h3><i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i> One tap</h3>
                    <p class="muted">Fills every job with its recommended model. You still paste each provider's key once, in its step.</p>
                    <button class="btn btn-outline btn-sm" onclick="applyAiSetupRecommended()">Use the recommended set</button>
                </div>
            </section>
            <footer class="setup-card-foot">
                <button class="btn btn-outline" onclick="selectAiSetupStep('${esc(first.id)}')">Start with ${esc(aiSetupStepName(first))}</button>
                <button class="btn btn-primary" onclick="selectAiSetupStep('${AI_SETUP_PROVIDERS}')">Providers and keys <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></button>
            </footer>
        </article>`;
}

/** Finish: what is ready, what is left with a way to it, and one test of every ready job. */
function renderAiSetupDone() {
    const main = document.getElementById('setup-main');
    if (!main || !aiSetupState) return;
    const steps = aiSetupState.steps;
    const ready = steps.filter((s) => s.ready);
    const left = steps.filter((s) => !s.ready);
    const row = (s) => `<li class="setup-done-row ${s.ready ? 'ok' : 'todo'}" data-step="${esc(s.id)}">
        <span class="setup-step-dot" aria-hidden="true">${s.ready ? '<i class="fa-solid fa-check"></i>' : '<i class="fa-solid fa-minus"></i>'}</span>
        <span class="setup-done-name"><strong>${esc(s.name)}</strong><span class="muted">${s.ready ? esc((aiSetupSelected(s) || {}).label || 'Ready') : esc(s.what || '')}</span></span>
        <span class="setup-done-out" id="setup-done-${esc(s.id)}"></span>
        ${s.ready ? '' : `<button class="btn btn-outline btn-sm" onclick="selectAiSetupStep('${esc(s.id)}')">Set it</button>`}
    </li>`;
    main.innerHTML = `
        <article class="setup-card" aria-labelledby="setup-done-title">
            <header class="setup-card-head">
                <div><p class="setup-kicker">Finish</p><h2 id="setup-done-title">${left.length ? `${ready.length} of ${steps.length} ready` : 'Everything is set'}</h2>
                <p class="muted">${left.length ? `${left.length} ${left.length === 1 ? 'job is' : 'jobs are'} left. What depends on ${left.length === 1 ? 'it' : 'them'} waits until ${left.length === 1 ? 'it is' : 'they are'} set.` : 'Every job has a model that answered its test. Caps and models are on Defaults.'}</p></div>
            </header>
            <ul class="setup-done-list">${[...left, ...ready].map(row).join('')}</ul>
            <footer class="setup-card-foot">
                ${ready.length ? `<button class="btn btn-primary" id="setup-test-all" onclick="testAllAiSetup()">Test every ready job</button>` : ''}
                <button class="btn btn-outline" onclick="selectAiSetupStep('${AI_SETUP_DEFAULT}')">Defaults and caps</button>
                <a class="btn btn-outline" href="${AI_SETUP_LINKS.credits}" target="_blank" rel="noopener">Monthly credits</a>
            </footer>
        </article>`;
}

/** One tiny test per ready job, one after another, each answer beside its row. */
async function testAllAiSetup() {
    if (aiSetupBusy || !aiSetupState) return;
    aiSetupBusy = true;
    const btn = document.getElementById('setup-test-all');
    if (btn) btn.disabled = true;
    let passed = 0, failed = 0;
    try {
        for (const step of aiSetupState.steps.filter((s) => s.ready)) {
            const out = document.getElementById(`setup-done-${step.id}`);
            if (out) out.textContent = 'Testing…';
            const selected = aiSetupSelected(step);
            try {
                const body = { provider: selected.provider };
                if (step.route) body.model = selected.model;
                const r = await api(`/api/admin/ai/setup/test/${encodeURIComponent(step.id)}`, { method: 'POST', body });
                passed++;
                if (out) { out.textContent = `Answered${r.latency_ms ? ` in ${Math.round(r.latency_ms)} ms` : ''}`; out.className = 'setup-done-out ok'; }
            } catch (err) {
                failed++;
                if (out) { out.textContent = err.message || 'Failed'; out.className = 'setup-done-out bad'; }
            }
        }
        toast(failed ? `${passed} answered, ${failed} failed` : `All ${passed} ready jobs answered`, failed ? 'warning' : undefined);
    } finally {
        aiSetupBusy = false;
        if (btn) btn.disabled = false;
    }
}

function renderAiSetupDefaults() {
    const main = document.getElementById('setup-main');
    if (!main || !aiSetupState) return;
    const rows = (aiSetupState.defaults || []).map((d) => {
        const options = (d.options || []).map((o) => {
            const value = `${o.provider}|${o.model}`;
            const selected = d.current && d.current.provider === o.provider && d.current.model === o.model;
            return `<option value="${esc(value)}" ${selected ? 'selected' : ''}>${esc(o.provider_name)} · ${esc(o.label || o.model)}${o.recommended ? ' (recommended)' : ''}${o.configured ? '' : ' — key needed'}</option>`;
        }).join('');
        const auto = `<option value="" ${!d.current || !d.current.model ? 'selected' : ''}>OpenVibe picks the best offer</option>`;
        return `<tr>
            <td data-label="Task kind"><strong>${esc(d.name)}</strong>${d.route ? `<div class="muted setup-route">${esc(d.route)}</div>` : '<div class="muted setup-route">OpenVibe.Search</div>'}</td>
            <td data-label="Model"><select aria-label="Model for ${esc(d.name)}" onchange="saveAiSetupRoute('${esc(d.id)}', this.value)">${auto}${options}</select></td>
            <td data-label="Calls (30 days)">${Number(d.calls_30d) || 0}</td>
            <td data-label="Est. monthly">${aiSetupMoney(d.estimated_month_usd)}</td>
            <td data-label="This month">${aiSetupMoney(d.month_usd)}</td>
            <td data-label="Monthly cap"><div class="setup-cap"><span>$</span><input type="number" min="0" max="100000" step="0.01" value="${Number(d.cap_usd) || 0}" aria-label="Monthly cap for ${esc(d.name)}" onchange="saveAiSetupCap('${esc(d.id)}', this.value)"></div><div class="setup-cap-note">${Number(d.cap_usd) ? 'Refuses above the cap' : 'No cap'}</div></td>
        </tr>`;
    }).join('');
    main.innerHTML = `<article class="setup-card">
        <header class="setup-card-head">
            <div><span class="setup-kicker">Last step</span><h3>Defaults</h3>
                <p class="setup-what">Every task kind, the model it uses, and what it has cost.</p>
                <p class="setup-uses"><i class="fa-solid fa-coins" aria-hidden="true"></i> Estimated monthly is the last 30 days of real calls at their own prices; spend this month is what has been used so far.</p></div>
            <button class="btn btn-primary" onclick="applyAiSetupRecommended()"><i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i> Use the recommended set</button>
        </header>
        <div class="setup-table-wrap">
            <table class="setup-table">
                <thead><tr><th>Task kind</th><th>Model</th><th>Calls (30d)</th><th>Est. monthly</th><th>This month</th><th>Monthly cap</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
        <p class="setup-help">A model listed with “key needed” still works after its step's key is saved. “OpenVibe picks” lets the route choose the best offer by price and health.</p>
        <footer class="setup-card-foot">
            <button class="btn btn-outline" onclick="selectAiSetupStep('chat')"><i class="fa-solid fa-arrow-left" aria-hidden="true"></i> Back to the steps</button>
            <div class="setup-foot-next"><button class="btn btn-primary" onclick="nextAiSetupNotReady()">Next <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></button></div>
        </footer>
    </article>`;
}

async function saveAiSetupRoute(kind, value) {
    const [provider, model] = String(value || '').split('|');
    try {
        await api(`/api/admin/ai/setup/routes/${encodeURIComponent(kind)}`, { method: 'PUT', body: provider ? { provider, model } : { provider: null, model: null } });
        toast(provider ? 'Model saved for ' + kind : 'The route picks for itself again');
        aiSetupState = null;
        await loadAiSetup(true);
    } catch (err) {
        toast(err.message || 'The model was not saved', 'error');
    }
}

async function saveAiSetupCap(kind, value) {
    const cap = Number(value);
    if (!Number.isFinite(cap) || cap < 0) { toast('The cap is 0 or more', 'error'); return; }
    try {
        await api(`/api/admin/ai/setup/caps/${encodeURIComponent(kind)}`, { method: 'PUT', body: { cap_usd: cap } });
        toast(cap ? 'Cap saved for ' + kind : 'Cap removed for ' + kind);
        aiSetupState = null;
        await loadAiSetup(true);
    } catch (err) {
        toast(err.message || 'The cap was not saved', 'error');
    }
}

async function applyAiSetupRecommended() {
    if (aiSetupBusy) return;
    aiSetupBusy = true;
    try {
        const out = await api('/api/admin/ai/setup/recommended', { method: 'POST', body: {} });
        const ok = (out.applied || []).filter((x) => x.ok).length;
        const bad = (out.applied || []).filter((x) => !x.ok);
        toast(bad.length ? `Recommended set saved for ${ok}; ${bad.length} needs a key first` : `Recommended set saved for all ${ok} task kinds`);
        aiSetupState = null;
        await loadAiSetup(true);
    } catch (err) {
        toast(err.message || 'The recommended set was not saved', 'error');
    } finally { aiSetupBusy = false; }
}

/* ═══════════════════════════════════════════════════════════════
   The AI control room's own parts (2026-11-15, plan §AD.9; the owner, step by step: "missing tons of models … can't
   even see configuring OpenRouter key and all the other keys", "you forgot all types of models … hella platforms",
   "missing configuration for our tons of providers and different methods", "missing all the different agents … the
   shared … node", "needs all to be configured with OpenVibe.exchange as well"):
     · Providers and keys: every provider OpenVibe.AI knows, grouped, with how it is reached, its key, a test, on/off,
       what it can do, its models and the same provider on Exchange;
     · every job lists every model that can do it, searchable, not two or three picked by hand;
     · coding agents: every harness Codes runs, the key it runs on, and the computers coding runs on (lent to
       everyone, never OpenVibe's own server).
   ═══════════════════════════════════════════════════════════════ */
const AI_SETUP_PROVIDERS = 'providers';
const AI_SETUP_FREE = 'free';
let aiSetupFree = null;               // { ns } AI's ai.exchange namespace, or { error }

/** Free use and budgets (2026-11-15, plan §AD.9 step 4; the owner: "free usage for people"): the free AI each person
 *  gets a day (AI's ai.exchange free_daily_tokens), what the server spends at most a month (the jobs' caps, changed
 *  under Defaults), and what happens past the free part (their own key, or Credits when they are on). */
async function loadAiSetupFree(force) {
    if (aiSetupFree && !force) return aiSetupFree;
    try { aiSetupFree = { ns: await api('/api/admin/ai/config/ai/ai.exchange') }; }
    catch (err) { aiSetupFree = { error: (err && err.message) || 'OpenVibe.AI did not answer' }; }
    return aiSetupFree;
}
function renderAiSetupFree() {
    const main = document.getElementById('setup-main');
    if (!main || !aiSetupState) return;
    if (!aiSetupFree) { main.innerHTML = '<div class="loading">Reading what people get free…</div>'; loadAiSetupFree().then(() => { if (aiSetupStep === AI_SETUP_FREE) renderAiSetup(); }); return; }
    const ns = aiSetupFree.ns || {};
    const field = ns.schema && ns.schema.properties && ns.schema.properties.free_daily_tokens;
    const pinned = Array.isArray(ns.pins) && ns.pins.includes('free_daily_tokens');
    const tokens = ns.values && Number.isFinite(Number(ns.values.free_daily_tokens)) ? Number(ns.values.free_daily_tokens) : Number((field && field['x-example']) || 20000);
    const credits = !!(ns.values && ns.values.credits);
    const caps = (aiSetupState.defaults || []).filter((d) => Number(d.cap_usd) > 0);
    const total = caps.reduce((n, d) => n + Number(d.cap_usd), 0);
    const words = (n) => (n > 0 ? `about ${Math.round(n * 0.75).toLocaleString()} words` : 'free AI is off');
    const free = aiSetupFree.error ? `<p class="setup-note bad">${esc(aiSetupFree.error)}</p>`
        : !field ? '<p class="setup-note">OpenVibe.AI\'s next release adds this setting; until then the free amount is set in its settings file.</p>'
            : `<div class="setup-free">
                <label for="setup-free-tokens"><strong>Each person, each day</strong><span class="muted">${esc(field.description || '')}</span></label>
                <div class="setup-free-row"><input id="setup-free-tokens" type="number" min="0" max="10000000" step="1000" value="${tokens}" ${pinned ? 'disabled' : ''} oninput="document.getElementById('setup-free-words').textContent = aiSetupFreeWords(this.value)">
                    <span class="muted">tokens · <span id="setup-free-words">${esc(words(tokens))}</span></span>
                    ${pinned ? '<span class="setup-pill">Set in the server\'s settings file</span>' : '<button class="btn btn-primary btn-sm" onclick="saveAiSetupFree()">Save</button>'}</div>
            </div>`;
    main.innerHTML = `<article class="setup-card">
        <header class="setup-card-head"><div><span class="setup-kicker">For everyone</span><h3 id="setup-step-title">Free use and budgets</h3>
            <p class="setup-what">What people get free, what the server spends at most, and what happens past it.</p></div></header>
        <section class="setup-free-sec"><h4>Free AI</h4>${free}</section>
        <section class="setup-free-sec"><h4>Most the server spends a month</h4>
            <p>${caps.length ? `<strong>${aiSetupMoney(total)}</strong> across ${caps.length} job${caps.length === 1 ? '' : 's'} with a cap.` : 'No job has a cap yet: the server spends what the jobs use.'}</p>
            <button class="btn btn-outline btn-sm" onclick="selectAiSetupStep('${AI_SETUP_DEFAULT}')">Change each job's cap</button></section>
        <section class="setup-free-sec"><h4>Past the free part</h4>
            <p>People use their own key${credits ? ', or their Credits (Credits are on).' : '. Credits are off, so nothing is charged.'}</p></section>
    </article>`;
}
function aiSetupFreeWords(v) { const n = Math.max(0, Number(v) || 0); return n > 0 ? `about ${Math.round(n * 0.75).toLocaleString()} words` : 'free AI is off'; }
async function saveAiSetupFree() {
    const input = document.getElementById('setup-free-tokens');
    const n = Math.max(0, Math.min(10000000, Math.round(Number(input && input.value) || 0)));
    try {
        await api('/api/admin/ai/config/ai/ai.exchange', { method: 'POST', body: { values: { free_daily_tokens: n }, reason: 'free AI per person per day' } });
        toast(n > 0 ? `Each person gets ${n.toLocaleString()} tokens free a day` : 'Free AI is off');
    } catch (err) { toast((err && err.message) || 'That did not save', 'error'); }
    await loadAiSetupFree(true);
    if (aiSetupStep === AI_SETUP_FREE) renderAiSetup();
}
const AI_SETUP_EXCHANGE = 'https://openvibe.exchange/console/providers';
let aiSetupProviderList = null;      // OpenVibe.AI's registry, as the owner sees it
let aiSetupProviderError = '';
let aiSetupProviderQuery = '';
let aiSetupProviderFilter = 'all';
let aiSetupProviderOpen = '';
let aiSetupModelQuery = {};          // step id -> the words in its "every model" search
let aiSetupModelShown = {};          // step id -> how many rows are showing
let aiSetupAgents = null;            // { harnesses, machines, error }

/** What a job is called on the page: plain words, never a route or a codename. */
const AI_SETUP_STEP_NAMES = { code: 'Coding agents', decide: 'Decisions', stt: 'Speech to text', speech: 'Voices', image: 'Pictures' };
const aiSetupStepName = (s) => (s && (AI_SETUP_STEP_NAMES[s.id] || s.name)) || '';

/** The groups providers are shown in, in order; each provider lands in the first group it fits. */
const AI_SETUP_PROVIDER_GROUPS = [
    { id: 'one', name: 'One key for everything', line: 'Hundreds of models from every lab through one account.', has: (p) => ['openrouter', 'nanogpt'].includes(p.key) },
    { id: 'own', name: 'Your own machines and the shared OpenVibe computers', line: 'Models on computers you run: free per answer, private to the network.', has: (p) => ['local', 'local2', 'shared', 'whisper', 'runpod-vllm'].includes(p.key) || /^https?:\/\/(127\.|localhost|10\.|192\.168\.)/.test(String(p.base_url || '')) },
    { id: 'labs', name: 'The labs', line: 'The companies that make the models, straight from the source.', has: (p) => ['openai', 'anthropic', 'gemini', 'xai', 'mistral', 'deepseek', 'meta', 'qwen', 'kimi', 'glm', 'minimax', 'cohere', 'perplexity', 'inception'].includes(p.key) },
    { id: 'uncensored', name: 'Uncensored', line: 'For the adults-only tier: answers the others refuse.', has: (p) => ['refuseless', 'abliteration', 'abliteratedmodels', 'venice'].includes(p.key) },
    { id: 'pictures', name: 'Pictures and video', line: 'Makes pictures, icons and video from words.', has: (p) => aiSetupCaps(p).some((c) => c === 'image' || c === 'video') && !aiSetupCaps(p).includes('chat') },
    { id: 'voice', name: 'Voices and speech', line: 'Reads text aloud and writes down what people say.', has: (p) => aiSetupCaps(p).some((c) => ['speak', 'speech', 'transcribe'].includes(c)) && !aiSetupCaps(p).includes('chat') },
    { id: 'search', name: 'Search', line: 'The current web and pictures, for answers that need today.', has: (p) => aiSetupCaps(p).some((c) => c === 'web-search' || c === 'image-search') && !aiSetupCaps(p).includes('chat') },
    { id: 'embed', name: 'Embeddings and reranking', line: 'Finds what is alike: search, memory and recommendations.', has: (p) => aiSetupCaps(p).some((c) => c === 'embed' || c === 'rerank') && !aiSetupCaps(p).includes('chat') },
    { id: 'fast', name: 'Fast and cheap hosts', line: 'Open models (Llama, Qwen, DeepSeek, Kimi …) served fast, often for less.', has: () => true },
];
/** What a provider can do, in the words the filters use. */
const AI_SETUP_CAN = [
    ['chat', 'Chat', (c) => c.includes('chat')], ['vision', 'Vision', (c) => c.includes('vision')],
    ['image', 'Pictures', (c) => c.includes('image')], ['video', 'Video', (c) => c.includes('video')],
    ['voice', 'Voices', (c) => c.includes('speak') || c.includes('speech')], ['stt', 'Speech to text', (c) => c.includes('transcribe')],
    ['embed', 'Embeddings', (c) => c.includes('embed') || c.includes('rerank')], ['search', 'Search', (c) => c.includes('web-search') || c.includes('image-search')],
    ['tools', 'Tools', (c) => c.includes('tools')],
];
const aiSetupProvName = (p) => String((p && (p.display_name || p.key)) || '').replace(/\s*\([^)]*\)\s*$/, '') || String(p && p.key || '');
function aiSetupCaps(p) {
    let c = p && p.capabilities;
    if (typeof c === 'string') { try { c = JSON.parse(c); } catch (e) { c = []; } }
    return Array.isArray(c) ? c.map(String) : [];
}
function aiSetupCanWords(p) {
    const c = aiSetupCaps(p);
    return AI_SETUP_CAN.filter(([, , has]) => has(c)).map(([id, word]) => ({ id, word }));
}
/** How a provider is reached, in a word: the methods the registry records. */
function aiSetupMethod(p) {
    const access = String(p.provider_access || '').toUpperCase();
    if (p.billing_profile === 'subscription') return { id: 'session', word: 'Your plan (signed in)', line: 'Uses a monthly plan you are signed in to, like Claude Max or ChatGPT Pro.' };
    if (['local', 'local2', 'shared', 'whisper', 'runpod-vllm'].includes(p.key) || /^https?:\/\/(127\.|localhost|10\.|192\.168\.)/.test(String(p.base_url || ''))) return { id: 'own', word: 'Your machine', line: 'Runs on a computer you control: no key, nothing to pay per answer.' };
    if (p.auth_mode === 'none' || p.credentials === 'not_required') return { id: 'free', word: 'No key needed', line: 'Answers without a key.' };
    if (access === 'AUTHORIZED_WHOLESALE') return { id: 'wholesale', word: 'Wholesale credits', line: 'Bought in bulk and resold at cost.' };
    return { id: 'key', word: 'API key', line: 'A key from the provider\'s own site.' };
}
function aiSetupKeyed(p) {
    if (p.auth_mode === 'none' || p.credentials === 'not_required') return true;
    const ref = String(p.secret_ref || '');
    if (p.credentials === 'missing') return false;
    return ref.startsWith('vault:') || ref.startsWith('env:') || p.credentials === 'present' || !!(p.key_hint || p.hint);
}
/** Where a provider's key is made: the jobs' own key pages first, then the provider's site. */
function aiSetupProviderKeyPage(key) {
    for (const s of (aiSetupState && aiSetupState.steps) || []) {
        for (const o of [s.recommended, ...(s.alternatives || []), ...(s.options || [])]) {
            if (o && o.provider === key && o.key_page && o.key_page.url) return o.key_page;
        }
    }
    return null;
}
/** How many models a provider has, by the jobs' lists (every registry model is in one). */
function aiSetupProviderModels(key) {
    const seen = new Set();
    for (const s of (aiSetupState && aiSetupState.steps) || []) for (const o of s.options || []) if (o.provider === key) seen.add(o.model);
    return seen.size;
}

async function loadAiSetupProviders(force) {
    if (aiSetupProviderList && !force) return aiSetupProviderList;
    try {
        const out = await api('/api/admin/ai/config/providers');
        aiSetupProviderList = ((out && out.providers) || []).filter((p) => p && p.key && p.key !== 'stub');
        aiSetupProviderError = '';
    } catch (err) {
        aiSetupProviderList = aiSetupProviderList || [];
        aiSetupProviderError = (err && err.message) || 'OpenVibe.AI did not answer';
    }
    return aiSetupProviderList;
}

function aiSetupProviderMatches(p) {
    const q = aiSetupProviderQuery.trim().toLowerCase();
    if (q && !`${p.display_name || ''} ${p.key} ${aiSetupCanWords(p).map((c) => c.word).join(' ')}`.toLowerCase().includes(q)) return false;
    const f = aiSetupProviderFilter;
    if (f === 'all') return true;
    if (f === 'on') return p.status === 'active';
    if (f === 'needs-key') return !aiSetupKeyed(p);
    return aiSetupCanWords(p).some((c) => c.id === f);
}

function aiSetupProviderRow(p) {
    const on = p.status === 'active';
    const keyed = aiSetupKeyed(p);
    const method = aiSetupMethod(p);
    const hint = p.key_hint || p.hint || '';
    const can = aiSetupCanWords(p);
    const models = aiSetupProviderModels(p.key);
    const open = aiSetupProviderOpen === p.key;
    const state = on ? (keyed ? `<span class="setup-pill ok">On${hint ? ' · ••••' + esc(hint) : ''}</span>` : '<span class="setup-pill bad">On, key missing</span>')
        : keyed ? '<span class="setup-pill">Off · key saved</span>' : '<span class="setup-pill todo">Key needed</span>';
    const initial = esc(String(aiSetupProvName(p)).replace(/[^A-Za-z0-9]/g, '').slice(0, 1).toUpperCase() || '?');
    const page = aiSetupProviderKeyPage(p.key);
    const keyless = method.id === 'free' || method.id === 'own';
    return `<li class="setup-prov ${on ? 'is-on' : ''} ${open ? 'is-open' : ''}" data-provider="${esc(p.key)}">
        <button type="button" class="setup-prov-head" aria-expanded="${open}" onclick="toggleAiSetupProvider('${esc(p.key)}')">
            <span class="setup-prov-mark" aria-hidden="true">${initial}</span>
            <span class="setup-prov-text"><strong>${esc(aiSetupProvName(p))}</strong>
                <span class="setup-prov-can">${can.map((c) => esc(c.word)).join(' · ') || 'Models'}${models ? ` · ${models} model${models === 1 ? '' : 's'}` : ''}</span></span>
            <span class="setup-prov-state">${state}</span>
        </button>
        ${open ? `<div class="setup-prov-body">
            <p class="setup-prov-method"><span class="setup-pill">${esc(method.word)}</span> ${esc(method.line)}</p>
            ${keyless ? '' : `<div class="setup-key-row">
                <input id="setup-prov-key" type="password" autocomplete="off" spellcheck="false" aria-label="${esc(p.display_name || p.key)} API key" placeholder="${keyed ? 'Paste a new key to replace it' : 'Paste the key here'}">
                <button class="btn btn-primary" onclick="saveAiSetupProviderKey('${esc(p.key)}')"><i class="fa-solid fa-lock" aria-hidden="true"></i> Save</button>
            </div>
            <p class="setup-help">${hint ? `Saved, ending in <strong>${esc(hint)}</strong>. ` : ''}The key is sealed in OpenVibe.AI and never shown again.${page ? ` <a href="${esc(page.url)}" target="_blank" rel="noopener noreferrer">Get a key</a>${page.how ? ': ' + esc(page.how) : ''}` : ''}</p>`}
            <div class="setup-prov-acts">
                <label class="pai-switch"><input type="checkbox" role="switch" data-ov-native ${on ? 'checked' : ''} onchange="switchAiSetupProvider('${esc(p.key)}', this.checked)"><span class="pai-track" aria-hidden="true"><span class="pai-knob"></span></span><span class="pai-switch-text">${on ? 'On: OpenVibe may use it' : 'Off'}</span></label>
                <button class="btn btn-outline btn-sm" onclick="testAiSetupProvider('${esc(p.key)}')"><i class="fa-solid fa-play" aria-hidden="true"></i> Test</button>
                <a class="btn btn-outline btn-sm" href="${AI_SETUP_EXCHANGE}#${encodeURIComponent(p.key)}" target="_blank" rel="noopener">On OpenVibe.Exchange</a>
                ${p.base_url ? `<code class="setup-prov-host">${esc(String(p.base_url).replace(/^https?:\/\//, '').replace(/\/.*$/, ''))}</code>` : ''}
            </div>
            <p class="muted" id="setup-prov-out"></p>
        </div>` : ''}
    </li>`;
}

function renderAiSetupProviders() {
    const main = document.getElementById('setup-main');
    if (!main) return;
    if (!aiSetupProviderList) {
        main.innerHTML = '<div class="loading">Reading every provider…</div>';
        loadAiSetupProviders().then(() => { if (aiSetupStep === AI_SETUP_PROVIDERS) renderAiSetup(); });
        return;
    }
    const list = aiSetupProviderList;
    const on = list.filter((p) => p.status === 'active').length;
    const filters = [['all', 'All'], ['on', 'On'], ['needs-key', 'Key needed'], ['chat', 'Chat'], ['vision', 'Vision'], ['image', 'Pictures'], ['video', 'Video'], ['voice', 'Voices'], ['stt', 'Speech to text'], ['embed', 'Embeddings'], ['search', 'Search']];
    const shown = list.filter(aiSetupProviderMatches);
    const groups = AI_SETUP_PROVIDER_GROUPS.map((g) => ({ g, items: [] }));
    for (const p of shown) { const hit = groups.find((x) => x.g.has(p)); if (hit) hit.items.push(p); }
    const order = (a, b) => (b.status === 'active') - (a.status === 'active') || String(a.display_name || a.key).localeCompare(String(b.display_name || b.key));
    main.innerHTML = `
        <article class="setup-card" aria-labelledby="setup-prov-title">
            <header class="setup-card-head">
                <div><span class="setup-kicker">Providers and keys</span>
                    <h3 id="setup-prov-title">Every AI provider OpenVibe can use</h3>
                    <p class="setup-what">${list.length} providers, ${on} on. Turn one on with its key, and every job below can use its models.</p>
                    <p class="setup-uses"><i class="fa-solid fa-store" aria-hidden="true"></i> <span>The same providers, with their prices and monthly credits, are on <a href="${AI_SETUP_EXCHANGE}" target="_blank" rel="noopener">OpenVibe.Exchange</a>.</span></p></div>
            </header>
            ${aiSetupProviderError ? `<p class="setup-note bad">${esc(aiSetupProviderError)}</p>` : ''}
            <div class="setup-prov-tools">
                <input type="search" class="setup-search" placeholder="Search providers" aria-label="Search providers" value="${esc(aiSetupProviderQuery)}" oninput="aiSetupProviderQuery=this.value; renderAiSetupProviderList()">
                <div class="setup-chips" role="tablist" aria-label="Show">${filters.map(([id, word]) => `<button type="button" role="tab" class="setup-chip ${aiSetupProviderFilter === id ? 'is-on' : ''}" aria-selected="${aiSetupProviderFilter === id}" onclick="aiSetupProviderFilter='${id}'; renderAiSetupProviders()">${esc(word)}</button>`).join('')}</div>
            </div>
            <div id="setup-prov-list">${groups.filter((x) => x.items.length).map((x) => `<section class="setup-prov-group" aria-label="${esc(x.g.name)}">
                <h4>${esc(x.g.name)} <span class="muted">${x.items.length}</span></h4><p class="muted setup-prov-gline">${esc(x.g.line)}</p>
                <ul class="setup-prov-list">${x.items.sort(order).map(aiSetupProviderRow).join('')}</ul></section>`).join('') || '<p class="muted">No provider matches.</p>'}</div>
            <footer class="setup-card-foot">
                <button class="btn btn-outline" onclick="selectAiSetupStep('${AI_SETUP_START}')"><i class="fa-solid fa-arrow-left" aria-hidden="true"></i> Start</button>
                <div class="setup-foot-next"><button class="btn btn-primary" onclick="nextAiSetupNotReady()">Next: the jobs <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></button></div>
            </footer>
        </article>`;
}
/** Typing in the search redraws the list only, so the field keeps its focus. */
function renderAiSetupProviderList() {
    const at = document.activeElement;
    const pos = at && at.selectionStart;
    renderAiSetupProviders();
    const field = document.querySelector('#setup-main .setup-search');
    if (field) { field.focus(); try { field.setSelectionRange(pos, pos); } catch (e) { /* not a text field */ } }
}
function toggleAiSetupProvider(key) {
    aiSetupProviderOpen = aiSetupProviderOpen === key ? '' : key;
    renderAiSetupProviders();
    const row = document.querySelector(`#setup-main .setup-prov[data-provider="${CSS.escape(key)}"]`);
    if (row && aiSetupProviderOpen) { const k = row.querySelector('#setup-prov-key'); if (k) k.focus({ preventScroll: true }); }
}
async function saveAiSetupProviderKey(key) {
    const input = document.getElementById('setup-prov-key');
    const value = String((input && input.value) || '').trim();
    if (value.length < 8) { toast('Paste the whole key first', 'error'); if (input) input.focus(); return; }
    try {
        await api(`/api/admin/ai/setup/providers/${encodeURIComponent(key)}/key`, { method: 'PUT', body: { key: value } });
        if (input) input.value = '';
        toast('Key saved and turned on. It will never be shown in full again.');
        await loadAiSetupProviders(true);
        aiSetupState = null;
        await loadAiSetup(true);
    } catch (err) { toast(err.message || 'The key was not saved', 'error'); }
}
async function switchAiSetupProvider(key, on) {
    try {
        await api(`/api/admin/ai/config/providers/${encodeURIComponent(key)}`, { method: 'PATCH', body: { status: on ? 'active' : 'disabled' } });
        toast(on ? 'On: OpenVibe may use it' : 'Off: OpenVibe will not use it');
        await loadAiSetupProviders(true);
        renderAiSetupProviders();
    } catch (err) {
        if (err && err.status === 403 && err.body && err.body.sign_in_url) { toast('Confirm it is you, then turn it on again', 'warning'); location.href = err.body.sign_in_url; return; }
        toast(err.message || 'That did not change', 'error');
        renderAiSetupProviders();
    }
}
async function testAiSetupProvider(key) {
    const out = document.getElementById('setup-prov-out');
    if (out) out.textContent = 'Asking it one tiny thing…';
    try {
        const r = await api(`/api/admin/ai/setup/providers/${encodeURIComponent(key)}/test`, { method: 'POST', body: {} });
        if (out) out.textContent = `It answered${r.model ? ' with ' + r.model : ''}${r.latency_ms ? ` in ${Math.round(r.latency_ms)} ms` : ''}${r.cost_usd != null ? `, for ${aiSetupMoney(r.cost_usd)}` : ''}.`;
    } catch (err) { if (out) out.textContent = 'It did not answer: ' + ((err && err.message) || 'no answer'); }
}

/** Every model that can do a job, searchable: the curated choices first, then the whole registry's. */
function aiSetupEveryModelHtml(step) {
    const all = (step.options || []).filter((o) => o && o.provider && o.model);
    if (all.length <= (step.alternatives || []).length + 1) return '';
    const q = String(aiSetupModelQuery[step.id] || '').trim().toLowerCase();
    const hits = all.filter((o) => !q || `${o.label || ''} ${o.model} ${o.provider_name || ''} ${o.provider}`.toLowerCase().includes(q))
        .sort((a, b) => (b.configured - a.configured) || String(a.provider_name).localeCompare(String(b.provider_name)) || String(a.label || a.model).localeCompare(String(b.label || b.model)));
    const n = aiSetupModelShown[step.id] || 40;
    const rows = hits.slice(0, n).map((o) => `<li class="setup-model-row ${aiSetupIsChoice(step, o) ? 'is-chosen' : ''}">
        <span class="setup-model-text"><strong>${esc(o.label || o.model)}</strong><span class="muted">${esc(aiSetupProvName({ display_name: o.provider_name, key: o.provider }))} · ${esc(aiSetupShortPrice(o.price))}</span></span>
        ${o.configured ? '<span class="setup-pill ok">Ready</span>' : o.keyless ? '<span class="setup-pill">No key needed</span>' : '<span class="setup-pill todo">Key needed</span>'}
        <button class="btn btn-outline btn-sm" onclick="aiSetupChoose('${esc(step.id)}','${esc(o.provider)}','${esc(o.model)}')">${aiSetupIsChoice(step, o) ? 'Chosen' : 'Choose'}</button>
    </li>`).join('');
    return `<details class="setup-others setup-every" ${q ? 'open' : ''}>
        <summary><i class="fa-solid fa-chevron-right" aria-hidden="true"></i> Every model that can do this <span class="muted">${all.length}</span></summary>
        <input type="search" class="setup-search" placeholder="Search ${all.length} models" aria-label="Search the models for ${esc(aiSetupStepName(step))}" value="${esc(aiSetupModelQuery[step.id] || '')}"
            oninput="aiSetupModelQuery['${esc(step.id)}']=this.value; aiSetupModelShown['${esc(step.id)}']=40; renderAiSetupKeepFocus('.setup-every .setup-search')">
        <ul class="setup-model-list">${rows || '<li class="muted">No model matches.</li>'}</ul>
        ${hits.length > n ? `<button class="btn btn-outline btn-sm" onclick="aiSetupModelShown['${esc(step.id)}']=${n + 80}; renderAiSetupKeepFocus(null, true)">Show ${Math.min(80, hits.length - n)} more of ${hits.length}</button>` : ''}
        <p class="setup-help">A model whose provider has no key yet is ready once its key is saved under Providers and keys.</p>
    </details>`;
}
function renderAiSetupKeepFocus(selector, keepOpen) {
    const at = document.activeElement;
    const pos = at && at.selectionStart;
    renderAiSetup();
    const every = document.querySelector('#setup-main .setup-every');
    if (every && keepOpen) every.open = true;
    if (selector) { const f = document.querySelector('#setup-main ' + selector); if (f) { if (every) every.open = true; f.focus(); try { f.setSelectionRange(pos, pos); } catch (e) { /* not text */ } } }
}

/** Coding agents: every harness Codes runs and the key it needs, and the computers coding runs on. */
async function loadAiSetupAgents(force) {
    if (aiSetupAgents && !force) return aiSetupAgents;
    const [h, m] = await Promise.all([
        api('/api/admin/ai/setup/agents').catch((err) => ({ error: (err && err.message) || 'Codes did not answer' })),
        api('/api/v1/machines').catch(() => ({ machines: [] })),
    ]);
    if (!aiSetupProviderList) await loadAiSetupProviders();
    aiSetupAgents = { harnesses: (h && h.harnesses) || [], error: h && h.error, machines: (m && m.machines) || [] };
    return aiSetupAgents;
}
/** The provider a harness's maker answers through, in OpenVibe.AI's registry. */
const AI_SETUP_HARNESS_PROVIDER = { anthropic: 'anthropic', openai: 'openai', google: 'gemini', alibaba: 'qwen', moonshot: 'kimi', xai: 'xai', deepseek: 'deepseek', minimax: 'minimax', zhipu: 'glm', meta: 'meta', 'opencode-go': 'openrouter', aider: 'openrouter', cline: 'openrouter', kilocode: 'openrouter', langchain: 'openrouter', 'self-hosted': 'local', custom: 'openrouter' };
function aiSetupAgentsHtml() {
    const a = aiSetupAgents;
    if (!a) return '<section class="setup-agents"><div class="loading">Reading the coding agents and your computers…</div></section>';
    const provs = new Map((aiSetupProviderList || []).map((p) => [p.key, p]));
    const seen = new Set();
    const rows = a.harnesses.filter((h) => h && h.id && h.id !== 'openvibe-ai' && !seen.has(h.name) && seen.add(h.name)).map((h) => {
        const pk = AI_SETUP_HARNESS_PROVIDER[h.provider] || null;
        const p = pk ? provs.get(pk) : null;
        const ready = p && p.status === 'active' && aiSetupKeyed(p);
        const runsOn = p ? `${esc(p.display_name || p.key)}` : 'its maker\'s sign-in on the computer';
        // 2026-11-15 (§AD.9 step 3): People can use it (Codes' codes.harnesses `off`), and the model it runs when nobody
        // picks, as chips when it has more than one (`defaults`).
        // 2026-11-15: every model the agent runs (the owner: "there's like tons"); the one it runs when nobody picks is
        // chosen from a list with a search, its own default first.
        const agentsOf = Array.isArray(h.models) && h.models.length ? h.models : [];
        const cur = agentsOf.find((m) => m.id === h.default_model);
        const models = agentsOf.length > 1 ? `<button type="button" class="setup-agent-model" aria-expanded="${aiSetupAgentOpen === h.id ? 'true' : 'false'}" onclick="toggleAiSetupAgentModels('${esc(h.id)}')">${esc(agentsOf.length)} models · <strong>${cur ? esc(cur.name || cur.id) : 'its own default'}</strong> when nobody picks</button>${aiSetupAgentOpen === h.id ? aiSetupAgentModelsHtml(h) : ''}` : '';
        const onSwitch = `<label class="pai-switch" title="People can use it"><input type="checkbox" role="switch" data-ov-native ${h.off ? '' : 'checked'} aria-label="${esc(h.name)}: people can use it" onchange="setAiSetupAgent('${esc(h.id)}', this.checked)"><span class="pai-track" aria-hidden="true"><span class="pai-knob"></span></span></label>`;
        return `<li class="setup-model-row${h.off ? ' is-off' : ''}"><span class="setup-model-text"><strong>${esc(h.name)}</strong><span class="muted">${h.off ? 'Turned off · ' : ''}Runs on ${runsOn}${agentsOf.length === 1 ? ' · ' + esc(agentsOf[0].name || agentsOf[0].id) : ''}${h.price && h.price.text ? ' · ' + esc(h.price.text) : ''}</span>${models}</span>${onSwitch}
            ${p ? (ready ? '<span class="setup-pill ok">Ready</span>' : `<button class="btn btn-outline btn-sm" onclick="aiSetupProviderOpen='${esc(pk)}'; selectAiSetupStep('${AI_SETUP_PROVIDERS}')">Add the ${esc(p.display_name || pk)} key</button>`) : '<span class="setup-pill">Signs in on the computer</span>'}</li>`;
    }).join('');
    const machines = a.machines.map((m) => {
        const lent = !!(m.controls && m.controls.shared_jobs);
        const canLend = !!(m.controls && m.controls.worker && m.controls.worker.serve_others);
        return `<li class="setup-model-row"><span class="setup-model-text"><strong>${esc(m.name || m.id)}</strong><span class="muted">${m.online ? 'Online' : 'Offline'}${m.specs_words ? ' · ' + esc(m.specs_words) : ''}</span></span>
            <label class="pai-switch"><input type="checkbox" role="switch" data-ov-native ${lent ? 'checked' : ''} ${canLend || lent ? '' : 'disabled'} onchange="lendAiSetupMachine('${esc(m.id)}', this.checked)"><span class="pai-track" aria-hidden="true"><span class="pai-knob"></span></span><span class="pai-switch-text">${lent ? 'Shared with everyone' : canLend ? 'Yours only' : 'Yours only (update Link to share)'}</span></label></li>`;
    }).join('');
    return `<section class="setup-agents" aria-label="Coding agents">
        <h4>Where coding runs</h4>
        <p class="muted">Never on OpenVibe's own server: on a shared OpenVibe computer (one lent to everyone's coding) or on the person's own computer through OpenVibe Link.</p>
        <ul class="setup-model-list">${machines || '<li class="muted">No computer is paired yet.</li>'}</ul>
        <p><a class="btn btn-outline btn-sm" href="https://openvibe.link/machines" target="_blank" rel="noopener">Add a computer</a></p>
        <h4>The coding agents people can pick <span class="muted">${seen.size}</span></h4>
        ${a.error ? `<p class="setup-note bad">${esc(a.error)}</p>` : ''}
        <ul class="setup-model-list">${rows}</ul>
        <p class="setup-help">An agent runs on its maker's models: add that provider's key once under Providers and keys, or use OpenRouter for the open ones. The model below plans the work and writes code when no agent is picked.</p>
    </section>`;
}
/** A model id in words ("claude-sonnet-5-5" → "Claude Sonnet 5.5"); the catalogue's own id when it has no shape. */
function aiSetupModelWords(m) {
    const s = String(m || '');
    if (!/^[a-z0-9-]+$/.test(s)) return s;
    const UP = { gpt: 'GPT', glm: 'GLM', ai: 'AI', oss: 'OSS' };
    return s.split('-').map((w, i, all) => UP[w] ? `${UP[w]} ` : (/^\d+$/.test(w) && /^\d+$/.test(all[i + 1] || '') ? `${w}.` : /^\d+$/.test(w) && /^\d+$/.test(all[i - 1] || '') ? `${w} ` : `${w.charAt(0).toUpperCase()}${w.slice(1)} `)).join('').replace(/\. /g, '.').replace(/\s+/g, ' ').trim();
}
/** Codes' codes.harnesses as the page holds it: { off, defaults }. */
function aiSetupAgentValues() {
    const hs = (aiSetupAgents && aiSetupAgents.harnesses) || [];
    const defaults = {};
    for (const h of hs) if (h.default_model) defaults[h.id] = h.default_model;
    return { off: hs.filter((h) => h.off).map((h) => h.id), defaults };
}
let aiSetupAgentOpen = null;          // the coding agent whose model list is open
let aiSetupAgentQuery = '';
function toggleAiSetupAgentModels(id) { aiSetupAgentOpen = aiSetupAgentOpen === id ? null : id; aiSetupAgentQuery = ''; renderAiSetup(); }
/** The agent's models: a search, its own default, then every model it runs (newest first, as Codes lists them). */
function aiSetupAgentModelsHtml(h) {
    const q = aiSetupAgentQuery.trim().toLowerCase();
    const list = (h.models || []).filter((m) => !q || `${m.name} ${m.id} ${m.note}`.toLowerCase().includes(q));
    const row = (id, name, note) => `<li><button type="button" class="setup-agent-pick" role="radio" aria-checked="${(h.default_model || '') === id ? 'true' : 'false'}" onclick="setAiSetupAgentModel('${esc(h.id)}', '${esc(id)}')"><strong>${esc(name)}</strong>${note ? `<span class="muted">${esc(note)}</span>` : ''}</button></li>`;
    return `<div class="setup-agent-models">
        <input type="search" class="setup-agent-find" placeholder="Search ${esc(h.models.length)} models" value="${esc(aiSetupAgentQuery)}" aria-label="Search the models ${esc(h.name)} runs" oninput="aiSetupAgentQuery = this.value; const at = this.selectionStart; renderAiSetup(); const f = document.querySelector('.setup-agent-find'); if (f) { f.focus(); try { f.setSelectionRange(at, at); } catch (e) { /* */ } }">
        <ul class="setup-agent-list" role="radiogroup" aria-label="${esc(h.name)}: the model when nobody picks">
            ${q ? '' : row('', 'Its own default', 'the model the agent picks for itself')}
            ${list.slice(0, 120).map((m) => row(m.id, m.name || m.id, m.note || m.id)).join('')}
            ${list.length > 120 ? `<li class="muted">${esc(list.length - 120)} more: search to find them</li>` : ''}
            ${q && !list.length ? `<li class="muted">No model matches “${esc(aiSetupAgentQuery)}”</li>` : ''}
        </ul></div>`;
}
async function saveAiSetupAgents(values, words) {
    try {
        await api('/api/admin/ai/config/codes/codes.harnesses', { method: 'POST', body: { values, reason: words } });
        toast(words);
    } catch (err) { toast((err && err.message) || 'That did not change', 'error'); }
    await loadAiSetupAgents(true);
    renderAiSetup();
}
/** People can use this coding agent, or not (Codes refuses new work on one turned off). */
async function setAiSetupAgent(id, on) {
    const h = ((aiSetupAgents && aiSetupAgents.harnesses) || []).find((x) => x.id === id);
    if (!h) return;
    h.off = !on;
    const v = aiSetupAgentValues();
    await saveAiSetupAgents({ off: v.off }, on ? `${h.name} is on for everyone` : `${h.name} is turned off`);
}
/** The model a coding agent runs when nobody picks one ('' = its own default). */
async function setAiSetupAgentModel(id, modelId) {
    const h = ((aiSetupAgents && aiSetupAgents.harnesses) || []).find((x) => x.id === id);
    if (!h || (modelId && !(h.models || []).some((m) => m.id === modelId))) return;
    h.default_model = modelId || null;
    const m = (h.models || []).find((x) => x.id === modelId);
    aiSetupAgentOpen = null;
    await saveAiSetupAgents({ defaults: aiSetupAgentValues().defaults }, modelId ? `${h.name} runs ${m.name || m.id} when nobody picks` : `${h.name} picks its own model`);
}
async function lendAiSetupMachine(id, on) {
    try {
        await api(`/api/v1/machines/${encodeURIComponent(id)}/shared-jobs`, { method: 'POST', body: { on: !!on } });
        toast(on ? 'Shared: it runs everyone\'s coding' : 'Yours only again');
    } catch (err) { toast(err.message || 'That did not change', 'error'); }
    await loadAiSetupAgents(true);
    renderAiSetup();
}
