/* ═══════════════════════════════════════════════════════════════
   OpenVibe.Network — account hub (/my): "Your data choices" (L24, 2026-10-31).
   One kit fold row per purpose (the words from network.me-consent-result@1), off until the person turns it on.
   Nothing is pre-ticked; On and Off are equal-weight buttons; the 18+ confirmation sits inside the row, never in a
   modal. Classic script, global scope: it uses my/core.js's apiFetch/API and my/boot.js starts the page.
   ═══════════════════════════════════════════════════════════════ */
let consentDoc = null;

const CONSENT_KIND_LABEL = {
    streams: 'Streams', vods: 'VODs', clips: 'Clips', voice: 'Voice', chat: 'Chat',
    posts: 'Posts', pictures: 'Pictures', code: 'Code',
};
const CONSENT_BY_LABEL = {
    person: 'you', app_revoked: 'the app revoked', merge: 'an account merge', deletion: 'account deletion', import: 'an import',
};

function consentEsc(value) {
    return String(value === null || value === undefined ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function consentWhen(at) {
    const d = new Date(at);
    return Number.isNaN(d.getTime()) ? String(at) : d.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** The active rows of one purpose, newest first. */
function consentActive(purposeId) {
    return (consentDoc && consentDoc.consents ? consentDoc.consents : []).filter((c) => c.purpose === purposeId && c.on);
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

/** One kit fold row for one purpose. */
function consentRow(purpose) {
    const active = consentActive(purpose.id);
    const current = active[0] || null;
    const state = active.length ? 'On' : 'Off by default';
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
            ${kinds}${licence}${vision}${appNote}${adult}
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
    if (!consentDoc) { box.innerHTML = '<div class="loading-spinner">Loading your choices…</div>'; return; }
    box.innerHTML = (consentDoc.purposes || []).map(consentRow).join('');
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

async function loadConsent() {
    const box = document.getElementById('consent-choices');
    if (!box) return;
    consentStatus('', false);
    try {
        consentDoc = await apiFetch('/api/v1/me/consent');
        renderConsent();
    } catch (err) {
        consentDoc = null;
        box.innerHTML = '<p class="muted">Your data choices could not be loaded. Nothing here is on until it loads and you turn it on.</p>';
        consentStatus('Could not load your choices' + (err && err.status ? ' (HTTP ' + err.status + ')' : '') + '.', true);
    }
}
