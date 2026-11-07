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
    } catch (err) {
        root.innerHTML = setupHead('') + '<p class="pai-error">Setup could not be read: ' + esc(err.message || 'the request failed') + '</p>';
    } finally {
        SETUP.loading = false;
    }
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
    root.onclick = setupClick;
    if (window.OVForms && window.OVForms.enhance) window.OVForms.enhance(root);
}

function setupRowHtml(row) {
    const st = SETUP_STATE[row.state] || SETUP_STATE.optional;
    const stateLabel = row.kind === 'task' && row.state === 'connected' ? 'Done' : st.label;
    const where = row.get_it_at
        ? '<p class="setup-where"><a href="' + esc(row.get_it_at) + '" target="_blank" rel="noopener noreferrer">' + (row.kind === 'task' ? 'Where to do it' : 'Where to get it') + ' <i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i></a>' + (row.get_it_how ? ' <span>' + esc(row.get_it_how) + '</span>' : '') + '</p>'
        : (row.get_it_how ? '<p class="setup-where"><span>' + esc(row.get_it_how) + '</span></p>' : '');
    const what = row.description || row.unlocks || '';
    const from = row.kind === 'task'
        ? 'Kept by OpenVibe.Network'
        : esc(row.service_name) + ' <code>' + esc(row.namespace) + '</code> <code>' + esc(row.key) + '</code>';
    return '<li class="setup-row is-' + esc(row.state) + '" data-setup-row data-id="' + esc(row.id) + '">'
        + '<div class="setup-row-main">'
        + '<div class="setup-row-title"><strong>' + esc(row.title) + '</strong> <span class="setup-state is-' + st.tone + '">' + esc(stateLabel) + '</span>'
        + (row.danger ? ' <span class="pai-chip-danger">Money</span>' : '') + '</div>'
        + (what ? '<p class="setup-what">' + esc(what) + '</p>' : '')
        + '<p class="setup-state-line is-' + st.tone + '">' + esc(setupStateLine(row)) + '</p>'
        + where
        + '<p class="setup-from">' + from + '</p>'
        + '</div>'
        + '<div class="setup-row-actions" data-setup-actions></div>'
        + '<p class="setup-result" data-setup-result role="status" hidden></p>'
        + '</li>';
}

function setupRowOf(el) {
    const li = el.closest('[data-setup-row]');
    const row = li && SETUP.data ? SETUP.data.rows.find((r) => r.id === li.dataset.id) : null;
    return { li, row };
}

function setupButton(text, act, cls) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn ' + (cls || 'pai-quiet');
    b.dataset.act = act;
    b.textContent = text;
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
    if (more.childNodes.length) box.append(more);
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
