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

function aiSetupStepById(id) {
    return (aiSetupState && aiSetupState.steps || []).find((s) => s.id === id) || null;
}

function aiSetupSelected(step) {
    const chosen = aiSetupChoice[step.id];
    if (chosen) {
        const all = [step.recommended, ...(step.alternatives || [])];
        const hit = all.find((o) => o.provider === chosen.provider && o.model === chosen.model);
        if (hit) return hit;
    }
    return step.recommended;
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
        if (!aiSetupState.steps.some((s) => s.id === aiSetupStep) && ![AI_SETUP_DEFAULT, AI_SETUP_START, AI_SETUP_DONE].includes(aiSetupStep)) aiSetupStep = AI_SETUP_START;
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
    </button>`;
    const rows = aiSetupState.steps.map((s, i) => {
        const active = aiSetupStep === s.id;
        const state = s.ready ? 'ready' : s.state;
        return `<button class="setup-step ${esc(state)} ${active ? 'active' : ''}" onclick="selectAiSetupStep('${esc(s.id)}')" aria-current="${active ? 'step' : 'false'}">
            <span class="setup-step-dot" aria-hidden="true">${s.ready ? '<i class="fa-solid fa-check"></i>' : (i + 1)}</span>
            <span class="setup-step-text"><span class="setup-step-name">${esc(s.name)}</span><span class="setup-step-state">${esc(AI_SETUP_STATE_WORD[state] || state)}</span></span>
        </button>`;
    });
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
    const offer = step && [step.recommended, ...(step.alternatives || [])].find((o) => o.provider === provider && o.model === model);
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
    const selected = aiSetupSelected(step);
    const index = aiSetupState.steps.findIndex((s) => s.id === step.id);
    const state = step.ready ? 'ready' : step.state;
    const page = aiSetupKeyPage(selected);
    const keyless = selected.keyless || (selected.provider === 'stt' || selected.provider === 'local' || selected.provider === 'whisper');
    const hint = (step.key_hint && step.key_hint.last4) || (selected.key_hint && selected.key_hint.last4);
    const configured = selected.configured;
    const alternatives = (step.alternatives || []).filter((o) => !aiSetupIsChoice(step, o));

    main.innerHTML = `
        <article class="setup-card" aria-labelledby="setup-step-title">
            <header class="setup-card-head">
                <div>
                    <span class="setup-kicker">Step ${index + 1} of ${aiSetupState.steps.length}</span>
                    <h3 id="setup-step-title">${esc(step.name)}</h3>
                    <p class="setup-what">${esc(step.what)}</p>
                    <p class="setup-uses"><i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i> ${esc(step.uses)}</p>
                </div>
                <span class="setup-badge ${AI_SETUP_STATE_CLASS[state] || 'todo'}">${esc(AI_SETUP_STATE_WORD[state] || state)}</span>
            </header>

            <section class="setup-rec" aria-label="Recommended provider">
                <div class="setup-rec-main">
                    <div class="setup-rec-top"><span class="setup-rec-flag"><i class="fa-solid fa-star" aria-hidden="true"></i> ${aiSetupIsChoice(step, step.recommended) ? 'Recommended' : 'Chosen'}</span>
                        ${selected.configured ? '<span class="setup-pill ok"><i class="fa-solid fa-check" aria-hidden="true"></i> Key saved</span>' : '<span class="setup-pill todo">Key needed</span>'}</div>
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
                        <li><strong>ChatGPT Pro</strong> includes $100, $200 or $500 of OpenAI API credit a month. Check ChatGPT → Settings → Billing → API credits. The plan must be at least seven days old, and the same email must own it and the API organization. <a href="${AI_SETUP_LINKS.openaiCredits}" target="_blank" rel="noopener">How it works</a></li>
                        <li><strong>An Anthropic allowance</strong> or any plan with monthly API credit works the same way.</li>
                        <li>Record each as <strong>Monthly credits</strong> on <a href="${AI_SETUP_LINKS.credits}" target="_blank" rel="noopener">Exchange → Console → Providers</a>. OpenVibe then spends them first, and nothing carries over at the end of a cycle.</li>
                    </ul>
                </div>
                <div class="setup-start-card">
                    <h3><i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i> One tap</h3>
                    <p class="muted">Fills every job with its recommended model. You still paste each provider's key once, in its step.</p>
                    <button class="btn btn-outline btn-sm" onclick="applyAiSetupRecommended()">Use the recommended set</button>
                </div>
            </section>
            <footer class="setup-card-foot">
                <button class="btn btn-primary" onclick="selectAiSetupStep('${esc(first.id)}')">Start with ${esc(first.name)} <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></button>
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
