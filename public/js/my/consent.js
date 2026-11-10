/* ═══════════════════════════════════════════════════════════════
   OpenVibe.Network — account hub (/my): "Your data choices" (L24, 2026-10-31).
   One kit fold row per purpose (the words from network.me-consent-result@1), off until the person turns it on.
   Nothing is pre-ticked; On and Off are equal-weight buttons; the 18+ confirmation sits inside the row, never in a
   modal. Classic script, global scope: it uses my/core.js's apiFetch/API and my/boot.js starts the page.
   ═══════════════════════════════════════════════════════════════ */
let consentDoc = null;
let consentAppsDoc = null;

const CONSENT_KIND_LABEL = {
    streams: 'Streams', vods: 'VODs', clips: 'Clips', voice: 'Voice', chat: 'Chat',
    posts: 'Posts', pictures: 'Pictures', code: 'Code',
};
const CONSENT_BY_LABEL = {
    person: 'you', app_revoked: 'the app revoked', merge: 'an earlier account action', deletion: 'account deletion', import: 'an import',
};

function consentEsc(value) {
    return String(value === null || value === undefined ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function consentWhen(at) {
    const d = new Date(at);
    return Number.isNaN(d.getTime()) ? String(at) : d.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * The active rows of one purpose, newest first: OpenVibe's own choice. An app's grant of the purpose (C4) is under
 * "Apps you allowed"; app.data is every app's row, since this row is where every app is turned off.
 */
function consentActive(purposeId) {
    return (consentDoc && consentDoc.consents ? consentDoc.consents : [])
        .filter((c) => c.purpose === purposeId && c.on && (purposeId === 'app.data' || !c.client));
}

/** One line of history, never HTML from the server. */
function consentHistoryList(purposeId) {
    const rows = (consentDoc && consentDoc.history ? consentDoc.history : []).filter((h) => h.purpose === purposeId).slice(0, 8);
    if (!rows.length) return '<p class="ovk-muted consent-empty">No changes yet: this purpose has never been on.</p>';
    return `<ul class="consent-history">${rows.map((h) => {
        const action = h.action === 'granted' ? 'On' : h.action === 'expired' ? 'Expired' : 'Off';
        const who = CONSENT_BY_LABEL[h.by] || h.by;
        const client = h.client ? ` · ${consentEsc(h.client)}` : '';
        return `<li><b>${action}</b> · ${consentEsc(consentWhen(h.at))} · ${consentEsc(who)}${client}</li>`;
    }).join('')}</ul>`;
}

/**
 * The apps that still hold this purpose from a sign-in (C4). This row's Off is OpenVibe's own choice only, so the row
 * must say when an app still has it: nobody should read "Off" and believe every app stopped.
 */
function consentAppHolders(purposeId) {
    if (purposeId === 'app.data') return [];
    const clients = [...new Set((consentDoc && consentDoc.consents ? consentDoc.consents : [])
        .filter((c) => c.purpose === purposeId && c.on && c.client).map((c) => c.client))];
    const named = (consentAppsDoc && consentAppsDoc.apps) || [];
    return clients.map((client) => { const a = named.find((x) => x.client === client); return a ? a.name : client; });
}

/** One kit fold row for one purpose. */
function consentRow(purpose) {
    const active = consentActive(purpose.id);
    const current = active[0] || null;
    const holders = consentAppHolders(purpose.id);
    const appsLabel = holders.length ? ` · ${holders.length === 1 ? '1 app' : `${holders.length} apps`} allowed` : '';
    const state = (active.length ? 'On for OpenVibe' : holders.length ? 'Off for OpenVibe' : 'Off by default') + appsLabel;
    const holdersNote = holders.length ? `<p class="consent-note consent-holders"><b>Still allowed for ${consentEsc(holders.join(', '))}.</b>
        These buttons are OpenVibe's own choice. Turn an app off under <a href="#consent-apps">Apps you allowed</a>.</p>` : '';
    const kinds = purpose.kinds.length ? `<div class="consent-kinds"><span class="consent-label">Which content</span>
        <div class="consent-kind-grid">${purpose.kinds.map((kind) => {
            const checked = current ? current.kinds.includes(kind) : false;
            return `<label class="consent-kind"><input type="checkbox" class="consent-kind-box" value="${kind}"${checked ? ' checked' : ''}> ${consentEsc(CONSENT_KIND_LABEL[kind] || kind)}</label>`;
        }).join('')}</div>
        <p class="ovk-muted consent-hint">No kind ticked means every kind this purpose applies to.</p></div>` : '';
    const licence = purpose.id === 'data.public' ? `<div class="consent-licence-field"><label for="consent-licence-${purpose.id}">Licence</label>
        <select id="consent-licence-${purpose.id}" class="consent-licence">
            <option value="">Choose a licence…</option>
            <option value="cc-by-4.0"${current && current.options && current.options.licence === 'cc-by-4.0' ? ' selected' : ''}>CC BY 4.0 (credit OpenVibe)</option>
            <option value="cc0-1.0"${current && current.options && current.options.licence === 'cc0-1.0' ? ' selected' : ''}>CC0 1.0 (public domain)</option>
        </select></div>` : '';
    const vision = purpose.id === 'face.recognize' ? '<p class="ovk-muted consent-note"><b>The features are chosen in OpenVibe.Vision:</b> verify, find, cast and library. This choice only allows recognition; Vision still asks which ones.</p>' : '';
    const appNote = purpose.id === 'app.data' ? '<p class="ovk-muted consent-note"><b>An app asks on its own consent screen</b> when you connect one. This row is where you turn every app off again.</p>' : '';
    const adult = purpose.adults_only ? `<label class="consent-adult"><input type="checkbox" class="consent-adult-box"> I am 18 or older.</label>` : '';
    const onDisabled = purpose.id === 'app.data' ? ' disabled title="An app asks on its own consent screen"' : '';
    return `<details class="ovk-fold consent-fold" data-consent-row="${consentEsc(purpose.id)}">
        <summary><span>${consentEsc(purpose.title)} <span class="ovk-muted">· ${state}</span></span>
            <svg class="ovk-i" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg></summary>
        <div class="ovk-fold-body">
            <p>${consentEsc(purpose.allows)}</p>
            <p class="consent-off"><b>Off:</b> ${consentEsc(purpose.off)}</p>
            ${purpose.cannot_undo ? `<p class="ovk-muted"><b>What turning it off cannot undo:</b> ${consentEsc(purpose.cannot_undo)}</p>` : ''}
            ${holdersNote}${kinds}${licence}${vision}${appNote}${adult}
            <div class="consent-actions">
                <button type="button" class="btn consent-on" data-consent-on aria-pressed="${active.length ? 'true' : 'false'}"${onDisabled}>On</button>
                <button type="button" class="btn consent-off-btn" data-consent-off aria-pressed="${active.length ? 'false' : 'true'}">Off</button>
            </div>
            ${consentHistoryList(purpose.id)}
        </div>
    </details>`;
}

function renderConsent() {
    const box = document.getElementById('consent-choices');
    if (!box) return;
    if (!consentDoc) { box.innerHTML = '<div class="loading-spinner"><span class="ov-mark" data-state="busy" data-size="32" aria-hidden="true"></span></div>'; return; }
    // A re-render (a save, or the apps arriving) keeps the folds the person had open.
    const open = new Set([...box.querySelectorAll('details[open][data-consent-row]')].map((d) => d.getAttribute('data-consent-row')));
    box.innerHTML = (consentDoc.purposes || []).map(consentRow).join('');
    open.forEach((id) => { const d = box.querySelector(`details[data-consent-row="${CSS.escape(id)}"]`); if (d) d.open = true; });
    box.querySelectorAll('[data-consent-on]').forEach((btn) => btn.addEventListener('click', () => saveConsent(btn, true)));
    box.querySelectorAll('[data-consent-off]').forEach((btn) => btn.addEventListener('click', () => saveConsent(btn, false)));
}

function consentStatus(text, bad) {
    const el = document.getElementById('consent-status');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('consent-error', !!bad);
}

/** Turn one purpose on or off. On sends the wording it showed, the kinds, the licence or the features, and the 18+. */
async function saveConsent(btn, on) {
    const row = btn.closest('[data-consent-row]');
    if (!row || !consentDoc) return;
    const purpose = (consentDoc.purposes || []).find((p) => p.id === row.getAttribute('data-consent-row'));
    if (!purpose) return;
    const body = { on };
    if (on) {
        body.text_version = purpose.text_version;
        body.kinds = [...row.querySelectorAll('.consent-kind-box:checked')].map((i) => i.value);
        const current = consentActive(purpose.id)[0];
        if (purpose.id === 'data.public') {
            const licence = row.querySelector('.consent-licence');
            if (!licence || !licence.value) { consentStatus('Choose a licence for the open dataset first.', true); return; }
            body.options = { licence: licence.value };
        } else if (purpose.id === 'face.recognize') {
            // The features are Vision's; turning the purpose on again must never wipe them.
            body.options = { features: (current && current.options && current.options.features) || [] };
        }
        if (purpose.adults_only) body.adult = !!(row.querySelector('.consent-adult-box') || {}).checked;
    }
    row.querySelectorAll('button, input, select').forEach((el) => { el.disabled = true; });
    consentStatus(on ? 'Turning it on…' : 'Turning it off…', false);
    try {
        const data = await apiFetch('/api/v1/me/consent/' + encodeURIComponent(purpose.id), { method: 'PUT', body: JSON.stringify(body) });
        consentDoc = data;
        renderConsent();
        consentStatus(on ? `${purpose.title}: on.` : `${purpose.title}: off.`, false);
    } catch (err) {
        row.querySelectorAll('button, input, select').forEach((el) => { el.disabled = false; });
        consentStatus('Could not save that choice (' + (err && err.status ? 'HTTP ' + err.status : 'network error') + '). Nothing was turned on.', true);
    }
}

// ── Apps you allowed (C4) ───────────────────────────────────
// What each app asked for when you signed in to it (consent:<purpose>): the purposes it was given, each with its own
// Turn off, and the ones you said no to in the last 30 days, which that app does not ask for again until then unless
// you press "Ask me next time". Built from DOM nodes; the app's name comes from its developer.

function consentNode(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== null && text !== undefined) n.textContent = text;
    return n;
}

function consentDay(at) {
    const d = new Date(at);
    return Number.isNaN(d.getTime()) ? String(at) : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** One purpose line of one app: its title, what it means, and its one button. */
function consentAppRow(app, purposeId, line, buttonText, onPress) {
    const words = ((consentAppsDoc && consentAppsDoc.purposes) || []).find((p) => p.id === purposeId) || { title: purposeId, allows: '' };
    const row = consentNode('li', 'consent-app-row');
    const text = consentNode('div', 'consent-app-text');
    text.append(consentNode('b', null, words.title), consentNode('span', 'ovk-muted', line));
    const btn = consentNode('button', 'btn btn-outline consent-app-btn', buttonText);
    btn.type = 'button';
    btn.setAttribute('aria-label', `${buttonText}: ${words.title}, ${app.name}`);
    btn.addEventListener('click', () => onPress(btn));
    row.append(text, btn);
    return row;
}

function renderConsentApps() {
    const box = document.getElementById('consent-apps');
    if (!box) return;
    box.replaceChildren();
    if (!consentAppsDoc) { const wait = consentNode('div', 'loading-spinner', null); wait.innerHTML = '<span class="ov-mark" data-state="busy" data-size="32" aria-hidden="true"></span>'; box.append(wait); return; }
    const apps = consentAppsDoc.apps || [];
    if (!apps.length) {
        box.append(consentNode('p', 'ovk-muted consent-empty', 'No app has asked you for anything yet. An app asks when you sign in to it, and what you allow shows here.'));
        return;
    }
    for (const app of apps) {
        const card = consentNode('div', 'consent-app');
        const head = consentNode('p', 'consent-app-name');
        head.append(consentNode('b', null, app.name));
        if (app.third_party) head.append(consentNode('span', 'ovk-muted', ' · third-party app'));
        const list = consentNode('ul', 'consent-app-list');
        for (const g of app.granted || []) {
            list.append(consentAppRow(app, g.purpose, `Allowed on ${consentDay(g.granted_at)}`, 'Turn off',
                (btn) => saveConsentApp(btn, `/api/v1/me/consent/${encodeURIComponent(g.purpose)}/${encodeURIComponent(app.client)}`, `${app.name} can no longer do that.`)));
        }
        for (const q of app.quiet || []) {
            list.append(consentAppRow(app, q.purpose, `You said no. It won't ask again until ${consentDay(q.quiet_until)}.`, 'Ask me next time',
                (btn) => saveConsentApp(btn, `/api/v1/me/consent/${encodeURIComponent(q.purpose)}/${encodeURIComponent(app.client)}/refusal`, `${app.name} will ask the next time you sign in to it.`)));
        }
        card.append(head, list);
        box.append(card);
    }
}

/** Turn one app's purpose off, or end a refusal's quiet days. The answer is the new "Apps you allowed". */
async function saveConsentApp(btn, path, done) {
    btn.disabled = true;
    consentStatus('Saving…', false);
    try {
        consentAppsDoc = await apiFetch(path, { method: 'DELETE' });
        renderConsentApps();
        consentStatus(done, false);
        loadConsent();   // the history shows the change
    } catch (err) {
        btn.disabled = false;
        consentStatus('Could not save that (' + (err && err.status ? 'HTTP ' + err.status : 'network error') + '). Nothing changed.', true);
    }
}

async function loadConsentApps() {
    try {
        consentAppsDoc = await apiFetch('/api/v1/me/consent/apps');
        renderConsentApps();
        if (consentDoc) renderConsent();   // the rows name the apps that still hold a purpose
    } catch (err) {
        consentAppsDoc = null;
        const box = document.getElementById('consent-apps');
        if (box) box.replaceChildren(consentNode('p', 'muted', 'Your apps could not be loaded. Nothing an app asked for is on unless you allowed it.'));
    }
}

async function loadConsent() {
    const box = document.getElementById('consent-choices');
    if (!box) return;
    consentStatus('', false);
    try {
        consentDoc = await apiFetch('/api/v1/me/consent');
        renderConsent();
        if (!consentAppsDoc) loadConsentApps();
    } catch (err) {
        consentDoc = null;
        box.innerHTML = '<p class="muted">Your data choices could not be loaded. Nothing here is on until it loads and you turn it on.</p>';
        consentStatus('Could not load your choices' + (err && err.status ? ' (HTTP ' + err.status + ')' : '') + '.', true);
    }
}
