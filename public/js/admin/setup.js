/* ═══════════════════════════════════════════════════════════════
   OpenVibe.Network — admin panel (/admin): the owner's Setup tab (/admin#setup).
   One checklist of everything only the owner can give the network (OWNER-SETUP-AND-ADMIN-CLARITY-DESIGN, 2026-11-07,
   section 1). The rows come from GET /api/admin/setup (server/admin/setup.js); saving, removing and testing a key go
   through the owner settings proxy (/api/admin/ai/config, server/admin/ai-config-proxy.js), with its fresh sign-in,
   vault, audit and alerts. A key is only ever written: its input is built as a DOM node, cleared and removed after
   saving, and never filled from anything the server sends.
   Classic script, global scope: it relies on admin/core.js (api, esc, toast, timeAgo, currentUser), glossary.js
   (glossaryLink) and ai.js (paiConfirm, paiUsd, paiParseUsd). No ES modules.
   ═══════════════════════════════════════════════════════════════ */
const SETUP = { data: null, loading: false };
const SETUP_STATE = {
    needed: { label: 'Needed', tone: 'bad' },
    not_working: { label: 'Not working', tone: 'warn' },
    connected: { label: 'Connected', tone: 'ok' },
    optional: { label: 'Optional', tone: 'muted' },
};
const SETUP_SIGN_IN = '/login?reauth=1&return=%2Fadmin%23setup';

function setupPlural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

/** "6 things need you · 2 not working · 31 connected · 4 optional" */
function setupSummary(c) {
    const parts = [
        c.needed === 1 ? '1 thing needs you' : c.needed + ' things need you',
        c.not_working + ' not working',
        c.connected + ' connected',
    ];
    if (c.optional) parts.push(c.optional + ' optional');
    return parts.join(' · ');
}

/** "Card payments" → "card payments", "GPUs" stays: the feature after "Needed for". */
function setupFor(text) {
    const t = String(text || '');
    return /^[A-Z][a-z]/.test(t) ? t.charAt(0).toLowerCase() + t.slice(1) : t;
}

function setupWhen(iso) {
    if (!iso) return '';
    try { return timeAgo(iso); } catch { return ''; }
}

/** The state line in words: what waits, what failed, what is set. */
function setupStateLine(row) {
    if (row.kind === 'task') {
        if (row.done) return 'Done' + (row.done.at ? ' on ' + row.done.at : '') + (row.done.by ? ' by @' + row.done.by : '') + '.';
        return row.required_for ? 'Needed for ' + setupFor(row.required_for) + '.' : 'Nothing waits on it; do it when you can.';
    }
    if (row.state === 'needed') return 'Needed for ' + setupFor(row.required_for) + '.';
    if (row.state === 'optional') return 'Not set. Nothing waits on it.';
    const parts = [];
    if (row.pinned) parts.push('From the server\'s settings file' + (row.pin_env ? ' (' + row.pin_env + ')' : ''));
    else if (row.secret) parts.push('Entered here, locked' + (row.hint ? ' · ••••' + row.hint : '') + (row.set_at ? ' · set ' + row.set_at : ''));
    else if (typeof row.value === 'boolean') parts.push(row.value ? 'On' : 'Off');
    else if (row.value !== null && row.value !== undefined) parts.push('Set to ' + (row.unit === 'nano_usd' ? '$' + paiUsd(row.value) : String(row.value)));
    else parts.push('Set');
    if (row.state === 'not_working' && row.last_test) parts.push('the last test failed ' + setupWhen(row.last_test.at) + ': ' + row.last_test.message);
    else if (row.last_test && row.last_test.passed) parts.push('the last test passed ' + setupWhen(row.last_test.at));
    else if (row.testable) parts.push('not tested yet');
    return parts.join('; ') + '.';
}

async function loadSetup() {
    const root = document.getElementById('setup-content');
    if (!root) return;
    if (!currentUser || !currentUser.is_owner) { root.innerHTML = ''; return; }
    if (SETUP.loading) return;
    SETUP.loading = true;
    if (!SETUP.data) root.innerHTML = '<div class="loading">Asking every service what it needs from you…</div>';
    try {
        SETUP.data = await api('/api/admin/setup');
        setupRender(root);
        // The guided setup draws these rows too: it reads again when one changes (js/admin/guide.js).
        document.dispatchEvent(new CustomEvent('ov-setup-changed'));
    } catch (err) {
        root.innerHTML = setupHead('') + '<p class="pai-error">Setup could not be read: ' + esc(err.message || 'the request failed') + '</p>';
    } finally {
        SETUP.loading = false;
    }
}

/**
 * What is left on each AI provider account (plan §AB.21: "the gift credits on all the providers need to be detectable"),
 * read live by OpenVibe.AI with your keys: a line under the head, "DeepSeek $12.50 (gift $10.00) · OpenRouter $12.75 ·
 * Moonshot (Kimi): no key yet". Read once a page; nothing is shown when AI does not answer.
 */
async function setupBalances(root) {
    let box = root.querySelector('#setup-balances');
    if (!box) {
        box = document.createElement('p');
        box.id = 'setup-balances'; box.className = 'setup-balances muted';
        const head = root.querySelector('.setup-head');
        if (!head) return;
        head.appendChild(box);
    }
    try {
        if (!SETUP.balances) SETUP.balances = await api('/api/admin/ai/config/balances');
    } catch { box.remove(); return; }
    const rows = (SETUP.balances && SETUP.balances.providers) || [];
    if (!rows.length) { box.remove(); return; }
    const money = (n, cur) => { try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur || 'USD' }).format(n); } catch { return '$' + Number(n).toFixed(2); } };
    box.textContent = '';
    const lead = document.createElement('strong'); lead.textContent = 'Left on your accounts: '; box.appendChild(lead);
    rows.forEach((r, i) => {
        if (i) box.appendChild(document.createTextNode(' · '));
        const s = document.createElement('span');
        s.className = 'setup-bal is-' + (r.state === 'read' ? (r.balance != null && r.balance < 1 ? 'low' : 'ok') : 'none');
        s.textContent = r.state === 'read' && r.balance != null
            ? r.name + ' ' + money(r.balance, r.currency) + (r.gift ? ' (gift ' + money(r.gift, r.currency) + ')' : '')
            : r.name + ': ' + String(r.note || 'not read').replace(/^./, (c) => c.toLowerCase());
        if (r.note && r.state === 'read') s.title = r.note;
        box.appendChild(s);
    });
}

function setupHead(summary) {
    return '<header class="setup-head">'
        + '<h2><i class="fa-solid fa-list-check" aria-hidden="true"></i> Setup</h2>'
        + '<p class="muted">Everything only you can give OpenVibe: keys, accounts, limits and a few registrations, from every part of the network. Come here when something says it needs you, or when you change a key or an account.</p>'
        + (summary ? '<p class="setup-summary" role="status">' + summary + '</p>' : '')
        + '<p class="setup-help muted">Keys are written once and locked; nothing here can show one again. ' + glossaryLink('setup-states', 'What do Needed, Not working, Connected and Optional mean?') + '</p>'
        + '<div id="setup-fresh" class="pai-fresh" hidden><i class="fa-solid fa-lock" aria-hidden="true"></i> <span>Confirm it\'s you to change keys and money settings.</span> <a class="btn btn-primary" href="' + SETUP_SIGN_IN + '">Sign in again</a> ' + glossaryLink('fresh-sign-in') + '</div>'
        + '</header>';
}

function setupRender(root) {
    const d = SETUP.data;
    const c = d.counts;
    const summary = '<strong>' + esc(c.needed === 1 ? '1 thing needs you' : c.needed + ' things need you') + '</strong> · ' + esc(setupSummary(c).split(' · ').slice(1).join(' · '));
    const groups = d.groups.map((g) => {
        const counts = [];
        if (g.counts.needed) counts.push('<span class="setup-count is-bad">' + setupPlural(g.counts.needed, 'needs you', 'need you') + '</span>');
        if (g.counts.not_working) counts.push('<span class="setup-count is-warn">' + g.counts.not_working + ' not working</span>');
        return '<section class="setup-group" id="setup-group-' + esc(g.id) + '" aria-labelledby="setup-group-h-' + esc(g.id) + '">'
            + '<h3 id="setup-group-h-' + esc(g.id) + '">' + esc(g.label) + ' ' + counts.join(' ') + '</h3>'
            + '<ol class="setup-rows">' + g.rows.map(setupRowHtml).join('') + '</ol></section>';
    }).join('');
    const empty = d.empty_groups && d.empty_groups.length
        ? '<p class="setup-empty muted">Nothing listed yet for ' + esc(d.empty_groups.map((g) => g.label).join(', ')) + ': the services that hold these have not published their settings yet.</p>'
        : '';
    const quiet = (d.services || []).filter((s) => s.note);
    const reach = quiet.length
        ? '<details class="pai-more setup-services"><summary>Services that ask nothing yet (' + quiet.length + ')</summary><ul>' + quiet.map((s) => '<li>' + esc(s.note) + '</li>').join('') + '</ul></details>'
        : '';
    root.innerHTML = setupHead(summary)
        + (d.rows.length ? groups : '<p class="muted">No service asks anything of you yet. When one publishes its settings, its keys appear here.</p>')
        + empty + reach
        + '<p class="setup-foot muted">Network\'s own email and Discord keys are on the <a href="/admin/settings">Settings</a> tab; the AI providers\' keys are also on the <a href="/admin/ai">AI</a> tab.</p>';
    for (const li of root.querySelectorAll('[data-setup-row]')) setupAttachControls(li);
    setupBalances(root);
    root.onclick = setupClick;
    if (window.OVForms && window.OVForms.enhance) window.OVForms.enhance(root);
}

function setupRowHtml(row) {
    const st = SETUP_STATE[row.state] || SETUP_STATE.optional;
    // A task is Done; a key or account is Connected; a plain setting (a switch, a cap, an id) is only Set: a switch
    // that is Off is not "connected" to anything.
    const stateLabel = row.state !== 'connected' ? st.label : row.kind === 'task' ? 'Done' : row.secret ? st.label : 'Set';
    const where = row.get_it_at
        ? '<p class="setup-where"><a href="' + esc(row.get_it_at) + '" target="_blank" rel="noopener noreferrer">' + (row.kind === 'task' ? 'Where to do it' : 'Where to get it') + ' <i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i></a>' + (row.get_it_how ? ' <span>' + esc(row.get_it_how) + '</span>' : '') + '</p>'
        : (row.get_it_how ? '<p class="setup-where"><span>' + esc(row.get_it_how) + '</span></p>' : '');
    // What it does first, then why (the state line says what waits on it), then the details (11-14, the owner: "way
    // better descriptions on what the purpose is, what it does, why I should set it up").
    const purpose = row.unlocks || row.description || '';
    const about = row.unlocks && row.description && row.description !== row.unlocks ? row.description : '';
    const from = row.kind === 'task'
        ? 'Kept by OpenVibe.Network'
        : esc(row.service_name) + ' <code>' + esc(row.namespace) + '</code> <code>' + esc(row.key) + '</code>';
    return '<li class="setup-row is-' + esc(row.state) + '" data-setup-row data-id="' + esc(row.id) + '">'
        + '<div class="setup-row-main">'
        + '<div class="setup-row-title"><strong>' + esc(row.title) + '</strong> <span class="setup-state is-' + st.tone + '">' + esc(stateLabel) + '</span>'
        + (row.danger ? ' <span class="pai-chip-danger">Money</span>' : '') + '</div>'
        + (purpose ? '<p class="setup-purpose"><span class="setup-label">' + (row.kind === 'task' ? 'Why' : 'What it does') + '</span>' + esc(purpose) + '</p>' : '')
        + '<p class="setup-state-line is-' + st.tone + '">' + esc(setupStateLine(row)) + '</p>'
        + (about ? '<p class="setup-what">' + esc(about) + '</p>' : '')
        + where
        + '<p class="setup-from">' + from + '</p>'
        + '</div>'
        + '<div class="setup-row-actions" data-setup-actions></div>'
        + '<p class="setup-result" data-setup-result role="status" hidden></p>'
        + '</li>';
}

/** Rows drawn into a list somewhere else (the guided setup's key steps, js/admin/guide.js); every value escaped. */
function setupRowsInto(list, rows) {
    list.innerHTML = rows.map(setupRowHtml).join('');
}

function setupRowOf(el) {
    const li = el.closest('[data-setup-row]');
    const row = li && SETUP.data ? SETUP.data.rows.find((r) => r.id === li.dataset.id) : null;
    return { li, row };
}

/** The icon each action wears (plan §Z.1.4: every action in the admin panel wears one). */
const SETUP_BUTTON_ICONS = { 'Let my agent do it': 'fa-wand-magic-sparkles', 'Mark done': 'fa-check', 'Mark not done': 'fa-rotate', 'Test': 'fa-flask', 'Save': 'fa-floppy-disk', 'Remove': 'fa-trash' };

function setupButton(text, act, cls) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn ' + (cls || 'pai-quiet');
    b.dataset.act = act;
    const icon = SETUP_BUTTON_ICONS[text];
    b.innerHTML = (icon ? '<i class="fa-solid ' + icon + '"></i> ' : '') + text;
    return b;
}

/** The input and buttons of one row, as DOM nodes: a key's input is never part of an HTML string. */
function setupAttachControls(li) {
    const { row } = setupRowOf(li);
    const box = li.querySelector('[data-setup-actions]');
    if (!row || !box) return;
    box.textContent = '';
    if (row.kind === 'task') {
        box.append(row.done ? setupButton('Mark not done', 'undo') : setupButton('Mark done', 'done', 'btn-primary'));
        return;
    }
    if (row.pinned) {
        const note = document.createElement('p');
        note.className = 'setup-pinned muted';
        note.textContent = 'Change it in the server\'s settings file.';
        box.append(note);
        if (row.testable && row.set) box.append(setupButton('Test', 'test'));
        return;
    }
    const form = document.createElement('form');
    form.className = 'setup-input';
    form.dataset.setupForm = '1';
    const label = document.createElement('label');
    const inputId = 'setup-in-' + row.id.replace(/[^a-z0-9]/gi, '-');
    label.htmlFor = inputId;
    label.className = 'setup-input-label';
    const input = document.createElement('input');
    input.id = inputId;
    input.autocomplete = 'off';
    input.spellcheck = false;
    if (row.secret) {
        input.type = 'password';
        label.textContent = row.set ? 'Replace it (write-only)' : 'Paste it here (write-only)';
        input.placeholder = row.set ? 'A new value replaces the old one' : 'Paste the value';
    } else if (row.type === 'boolean') {
        input.type = 'checkbox';
        input.checked = row.value === true;
        label.textContent = 'On';
    } else if (row.unit === 'nano_usd') {
        input.type = 'text';
        input.inputMode = 'decimal';
        label.textContent = 'Amount in dollars';
        input.value = row.value != null ? paiUsd(row.value) : '';
        input.placeholder = '0.00';
    } else if (row.type === 'integer' || row.type === 'number') {
        input.type = 'number';
        input.step = row.type === 'integer' ? '1' : 'any';
        label.textContent = 'Value' + (row.unit ? ' (' + ({ ms: 'milliseconds', seconds: 'seconds', bps: 'bits per second' }[row.unit] || row.unit) + ')' : '');
        input.value = row.value != null ? String(row.value) : '';
    } else {
        input.type = 'text';
        label.textContent = row.set ? 'Change it' : 'Enter it here';
        input.value = row.value != null ? String(row.value) : '';
        if (row.example != null) input.placeholder = String(row.example);
    }
    input.dataset.setupInput = '1';
    const save = setupButton(row.set ? 'Save' : 'Save', 'save', 'btn-primary');
    save.type = 'submit';
    form.append(label, input, save);
    form.addEventListener('submit', (ev) => { ev.preventDefault(); setupSave(li, row, input, save); });
    box.append(form);
    const more = document.createElement('div');
    more.className = 'setup-more-actions';
    if (row.testable && row.set) more.append(setupButton('Test', 'test'));
    if (row.set) more.append(setupButton('Remove', 'remove', 'pai-quiet pai-quiet-danger'));
    // Plan §AB.44: your own agent opens the provider's page on a desk, hands it to you to sign in, makes the key and
    // saves it here (a one-time grant for this row; the key never reaches the agent's words).
    if (setupAgentProvider(row)) more.append(setupButton('Let my agent do it', 'agent'));
    if (more.childNodes.length) box.append(more);
}

// The providers whose new keys OpenVibe.Actor can read from their page (Network server/admin/setup-grants.js).
const SETUP_AGENT_PROVIDERS = ['openai', 'anthropic', 'deepseek', 'openrouter', 'groq', 'gemini', 'kimi', 'xai', 'fireworks', 'resend', 'stripe'];
const SETUP_AGENT_ALIASES = { moonshot: 'kimi', 'google ai': 'gemini', claude: 'anthropic', grok: 'xai' };
/** The provider a key row is for, when the agent can make its key; else null. */
function setupAgentProvider(row) {
    if (!row || !row.secret || !row.get_it_at || row.pinned || row.kind === 'task') return null;
    const hay = (String(row.key || '') + ' ' + String(row.namespace || '') + ' ' + String(row.title || '')).toLowerCase();
    for (const p of SETUP_AGENT_PROVIDERS) if (hay.includes(p)) return p;
    for (const [a, p] of Object.entries(SETUP_AGENT_ALIASES)) if (hay.includes(a)) return p;
    return null;
}

async function setupAgent(li, row, button) {
    button.disabled = true;
    try {
        const out = await api('/api/admin/setup/grants', { method: 'POST', body: {
            service: row.service, namespace: row.namespace, keys: [row.key], provider: setupAgentProvider(row), label: row.title, get_it_at: row.get_it_at, start: true,
        } });
        setupAgentNotice(li, row, out.grant);
    } catch (err) {
        button.disabled = false;
        if (setupFresh(err)) return;
        setupShowResult(li, (err && err.message) || 'Your agent could not start. Paste the key yourself.', 'bad');
    }
}

/** The row while the agent works: what it does, where to watch it, Stop; it turns Connected when the key is saved. */
function setupAgentNotice(li, row, grant) {
    const box = li.querySelector('[data-setup-actions]');
    if (!box || !grant) return;
    const note = document.createElement('div');
    note.className = 'setup-agent';
    note.setAttribute('role', 'status');
    const text = document.createElement('p');
    text.textContent = 'Your agent is making the key. When the page asks you to sign in or confirm, it hands you its screen: take it, then give it back.';
    // Its screen opens beside the step (plan §AB.44); its own page stays one tap away for taking over.
    const watch = document.createElement('button');
    watch.type = 'button';
    watch.className = 'btn btn-primary btn-sm';
    watch.innerHTML = '<i class="fa-solid fa-eye"></i> Watch it work';
    watch.addEventListener('click', () => setupDeskOpen(row, grant));
    const stop = document.createElement('button');
    stop.type = 'button'; stop.className = 'btn btn-secondary btn-sm';
    stop.innerHTML = '<i class="fa-solid fa-xmark"></i> Stop';
    let timer = 0;
    const until = Date.now() + 30 * 60 * 1000;
    const end = (words, tone) => { clearInterval(timer); note.remove(); setupDeskClose(); setupShowResult(li, words, tone); };
    // Stop says what really happened (11-14 review): it used to say "Stopped" even when the request failed.
    stop.addEventListener('click', async () => {
        stop.disabled = true;
        const task = grant.task && grant.task.id ? '?task=' + encodeURIComponent(grant.task.id) : '';
        let out;
        try { out = await api('/api/admin/setup/grants/' + encodeURIComponent(grant.ref) + task, { method: 'DELETE' }); } catch (err) {
            stop.disabled = false;
            setupShowResult(li, 'It could not be stopped' + (err && err.message ? ': ' + err.message : '') + '. Try again.', 'bad');
            return;
        }
        // 11-15: "saved" only once the key is written, and "stopped" only once Actor says the task ended.
        const taskWords = !task ? '' : out && out.task_state === 'stopping' ? ' Its task is stopping: it finishes the step it is on.'
            : out && out.task_stopped === false ? ' Its task did not stop from here: open it and stop it there.' : ' Its task is stopped.';
        if (out && (out.state === 'spent' || out.state === 'saving')) {
            end((out.state === 'spent' ? 'Your agent had already saved the key. It stays in Setup: remove it there if you do not want it.'
                : 'Your agent is saving the key right now. Look at Setup in a moment: remove it there if you do not want it.') + taskWords, 'muted');
            try { SETUP.data = await api('/api/admin/setup'); setupRender(document.getElementById('setup-content')); } catch { /* the next load shows it */ }
            return;
        }
        if (out && out.state === 'save_failed') {
            end('Your agent tried to save the key and the save failed, so nothing new is in Setup.' + taskWords, 'muted');
            return;
        }
        end('Stopped: your agent can no longer save this key.' + taskWords, 'muted');
    });
    const actions = document.createElement('p');
    actions.className = 'setup-agent-actions';
    actions.append(watch, stop);
    note.append(text, actions);
    box.prepend(note);
    // Saved when the row says so (the agent's save is the owner's own, through the same path).
    timer = setInterval(async () => {
        if (!li.isConnected || Date.now() > until) { clearInterval(timer); return; }
        try {
            const data = await api('/api/admin/setup');
            const now = (data.rows || []).find((r) => r.id === row.id);
            if (now && now.set && now.state === 'connected') { SETUP.data = data; end('Saved by your agent.', 'ok'); setupRender(document.getElementById('setup-content')); }
        } catch { /* try again */ }
    }, 10000);
}

function setupFresh(err) {
    if (!(err && err.status === 403 && err.body && err.body.code === 'config.fresh_required')) return false;
    const el = document.getElementById('setup-fresh');
    if (el) {
        const link = el.querySelector('a.btn');
        // The proxy's link returns to the AI tab; Setup's returns here.
        if (link && err.body.sign_in_url) link.href = String(err.body.sign_in_url).replace(/%2Fadmin%23ai$/i, '%2Fadmin%23setup');
        el.hidden = false;
        el.scrollIntoView({ block: 'nearest' });
    }
    return true;
}

function setupShowResult(li, text, tone) {
    const p = li.querySelector('[data-setup-result]');
    if (!p) return;
    p.textContent = text;
    p.className = 'setup-result is-' + tone;
    p.hidden = false;
}

const setupConfigPath = (row) => '/api/admin/ai/config/' + encodeURIComponent(row.service) + '/' + encodeURIComponent(row.namespace);

async function setupSave(li, row, input, button) {
    const isSecret = input.type === 'password';
    let body;
    if (isSecret) {
        if (!input.value) { input.focus(); return; }
    } else if (input.type === 'checkbox') {
        body = { values: { [row.key]: input.checked }, merge: true, reason: 'Set on Setup' };
    } else if (row.unit === 'nano_usd') {
        const parsed = paiParseUsd(input.value);
        if (parsed.error) return setupShowResult(li, parsed.error, 'bad');
        body = { values: { [row.key]: parsed.nano }, merge: true, reason: 'Set on Setup' };
    } else if (input.type === 'number') {
        const n = Number(input.value);
        if (input.value === '' || !Number.isFinite(n) || (row.type === 'integer' && !Number.isInteger(n))) return setupShowResult(li, row.type === 'integer' ? 'Enter a whole number.' : 'Enter a number.', 'bad');
        body = { values: { [row.key]: n }, merge: true, reason: 'Set on Setup' };
    } else {
        if (!input.value.trim()) { input.focus(); return; }
        body = { values: { [row.key]: input.value.trim() }, merge: true, reason: 'Set on Setup' };
    }
    if (row.danger) {
        const ok = await paiConfirm('Save ' + row.title + '?', [(row.unlocks || row.description || 'This takes effect at once.'), 'It takes effect at once. To undo it, change it back here or roll back its version on the AI tab.']);
        if (!ok) { if (isSecret) input.value = ''; return; }
    }
    button.disabled = true;
    const was = button.textContent;
    button.textContent = 'Saving…';
    try {
        if (isSecret) {
            const value = input.value;
            input.value = '';
            await api(setupConfigPath(row) + '/secrets/' + encodeURIComponent(row.key), { method: 'PUT', body: { value, reason: 'Entered on Setup' } });
        } else {
            await api(setupConfigPath(row), { method: 'POST', body });
        }
        toast(row.title + ' saved', 'success');
        await loadSetup();
    } catch (err) {
        if (!setupFresh(err)) setupShowResult(li, err.message || 'It was not saved.', 'bad');
        button.disabled = false;
        button.textContent = was;
    } finally {
        // A key must not stay in the page, whatever happened.
        if (isSecret) input.value = '';
    }
}

async function setupClick(ev) {
    const button = ev.target.closest('button[data-act]');
    if (!button || button.type === 'submit') return;
    const { li, row } = setupRowOf(button);
    if (!row) return;
    const act = button.dataset.act;
    if (act === 'test') return setupTest(li, row, button);
    if (act === 'remove') return setupRemove(li, row, button);
    if (act === 'done' || act === 'undo') return setupTask(li, row, button, act === 'done');
    if (act === 'agent') return setupAgent(li, row, button);
}

async function setupTest(li, row, button) {
    button.disabled = true;
    button.textContent = 'Testing…';
    setupShowResult(li, 'Asking ' + row.service_name + ' to try it…', 'muted');
    try {
        const r = await api(setupConfigPath(row) + '/test/' + encodeURIComponent(row.key), { method: 'POST', body: {} });
        setupShowResult(li, (r.passed ? 'It works: ' : 'It did not work: ') + r.message, r.passed ? 'ok' : 'bad');
        // Keep the answer on screen while the row's state catches up.
        const keep = li.querySelector('[data-setup-result]').textContent;
        await loadSetup();
        const again = document.querySelector('[data-setup-row][data-id="' + CSS.escape(row.id) + '"]');
        if (again) setupShowResult(again, keep, r.passed ? 'ok' : 'bad');
    } catch (err) {
        const msg = err && err.body && err.body.code === 'config.test_not_available'
            ? row.service_name + ' cannot test this yet.'
            : (err.message || 'The test did not run.');
        setupShowResult(li, msg, 'bad');
        button.disabled = false;
        button.textContent = 'Test';
    }
}

async function setupRemove(li, row, button) {
    const stops = row.required_for ? row.required_for + ' stops working until a new value is entered.' : 'Nothing waits on it; it can be entered again at any time.';
    const ok = await paiConfirm('Remove ' + row.title + '?', [stops, row.secret ? 'The key is deleted from ' + row.service_name + '. It cannot be shown again, so keep a copy where you got it.' : 'Its earlier value stays in the history, where it can be rolled back.']);
    if (!ok) return;
    button.disabled = true;
    try {
        if (row.secret) await api(setupConfigPath(row) + '/secrets/' + encodeURIComponent(row.key), { method: 'DELETE', body: { reason: 'Removed on Setup' } });
        else await api(setupConfigPath(row), { method: 'POST', body: { values: {}, unset: [row.key], merge: true, reason: 'Removed on Setup' } });
        toast(row.title + ' removed', 'success');
        await loadSetup();
    } catch (err) {
        if (!setupFresh(err)) setupShowResult(li, err.message || 'It was not removed.', 'bad');
        button.disabled = false;
    }
}

async function setupTask(li, row, button, done) {
    button.disabled = true;
    try {
        await api('/api/admin/setup/tasks/' + encodeURIComponent(row.key), { method: 'POST', body: { done } });
        toast(done ? row.title + ': done' : row.title + ': not done', 'success');
        await loadSetup();
    } catch (err) {
        setupShowResult(li, err.message || 'It was not saved.', 'bad');
        button.disabled = false;
    }
}


// ── The agent's screen beside the step (plan §AB.44) ──
// A panel at the side (a sheet from the bottom on a phone) with the desk's latest picture, what the agent is doing and
// what it needs from you, read every two seconds through Network (GET /api/admin/setup/grants/agent/:task, /still).
// Taking over (signing in, a code, a payment) happens on the agent's own page, which can drive its desk.
let setupDesk = null;
function setupDeskClose() {
    if (!setupDesk) return;
    clearTimeout(setupDesk.timer);
    if (setupDesk.url) URL.revokeObjectURL(setupDesk.url);
    setupDesk.box.remove();
    if (setupDesk.from && setupDesk.from.isConnected) setupDesk.from.focus();
    setupDesk = null;
}
function setupDeskOpen(row, grant) {
    const task = grant && grant.task && grant.task.id;
    if (!task) return;
    if (setupDesk && setupDesk.task === task) { setupDesk.box.querySelector('button').focus(); return; }
    setupDeskClose();
    const box = document.createElement('aside');
    box.className = 'setup-desk';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'Your agent at work on ' + (row.title || 'this step'));
    const head = document.createElement('header');
    const title = document.createElement('b');
    title.textContent = 'Your agent · ' + (row.title || 'Setup');
    const close = document.createElement('button');
    close.type = 'button'; close.className = 'setup-desk-close'; close.setAttribute('aria-label', 'Close'); close.textContent = '×';
    close.addEventListener('click', setupDeskClose);
    head.append(title, close);
    const screen = document.createElement('div');
    screen.className = 'setup-desk-screen';
    const img = document.createElement('img');
    img.alt = 'Your agent\'s screen';
    img.hidden = true;
    const wait = document.createElement('p');
    wait.textContent = 'Its screen shows here when it opens one.';
    screen.append(img, wait);
    const state = document.createElement('p');
    state.className = 'setup-desk-state';
    state.setAttribute('aria-live', 'polite');
    state.textContent = 'Starting…';
    const needs = document.createElement('p');
    needs.className = 'setup-desk-needs';
    needs.hidden = true;
    const actions = document.createElement('p');
    actions.className = 'setup-desk-actions';
    const page = document.createElement('a');
    page.className = 'btn btn-secondary btn-sm';
    page.href = grant.task.url || '#'; page.target = '_blank'; page.rel = 'noopener';
    page.textContent = 'Take over on its page';
    actions.append(page);
    box.append(head, screen, state, needs, actions);
    document.body.append(box);
    setupDesk = { box, task, timer: 0, url: '', from: document.activeElement };
    close.focus();
    box.addEventListener('keydown', (e) => { if (e.key === 'Escape') setupDeskClose(); });
    const WORDS = { queued: 'Waiting for a desk…', running: 'Working…', waiting: 'Waiting for you', succeeded: 'Done', failed: 'It stopped', cancelled: 'Stopped' };
    const tick = async () => {
        if (!setupDesk || setupDesk.task !== task) return;
        let view = null;
        try { view = (await api('/api/admin/setup/grants/agent/' + encodeURIComponent(task))).agent; } catch { view = null; }
        if (!setupDesk || setupDesk.task !== task) return;
        if (view) {
            state.textContent = view.error ? 'It stopped: ' + view.error : view.needs_you ? WORDS.waiting : (WORDS[view.state] || view.state || 'Working…');
            needs.hidden = !view.needs_you;
            needs.textContent = view.needs_you ? 'It needs you: ' + view.needs_you.what : '';
            box.classList.toggle('needs-you', Boolean(view.needs_you));
            // When it waits for you, taking over is the one thing to do.
            page.className = 'btn btn-sm ' + (view.needs_you ? 'btn-primary' : 'btn-secondary');
            if (view.desk) {
                try {
                    const res = await fetch(API + '/api/admin/setup/grants/agent/' + encodeURIComponent(task) + '/still', { headers: token ? { Authorization: 'Bearer ' + token } : {}, credentials: 'include' });
                    if (res.ok && setupDesk && setupDesk.task === task) {
                        const url = URL.createObjectURL(await res.blob());
                        if (setupDesk.url) URL.revokeObjectURL(setupDesk.url);
                        setupDesk.url = url; img.src = url; img.hidden = false; wait.hidden = true;
                    }
                } catch { /* the next tick tries again */ }
            }
            if (view.ended) return;
        }
        if (setupDesk && setupDesk.task === task) setupDesk.timer = setTimeout(tick, 2000);
    };
    tick();
}
