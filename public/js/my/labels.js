/* ═══════════════════════════════════════════════════════════
   OpenVibe.Network — account hub (/my): "What you see" (L1, labels and choices, 2026-11-02).
   One row per content label, three equal choices (Show, Blur until tapped, Hide), saved at once with
   PUT /api/v1/me/label-prefs (network.label-prefs@1, all six each time). Every OpenVibe site reads the same choice
   (openvibe-shared ov-labels.js). Classic script, global scope: my/core.js's apiFetch; profile.js starts it.
   ═══════════════════════════════════════════════════════════ */
const LABEL_ROWS = [
    ['nudity', 'Nudity', 'Nudity or sexual content.'],
    ['language', 'Strong language', 'Swearing and slurs.'],
    ['graphic', 'Graphic', 'Graphic violence or injury.'],
    ['18+', '18+', 'Adults only.'],
    ['flashing', 'Flashing lights', 'Flashing lights or rapid motion.'],
    ['spoilers', 'Spoilers', 'It gives away a story.'],
];
const LABEL_CHOICES = [['show', 'Show'], ['blur', 'Blur'], ['hide', 'Hide']];
let labelPrefs = null;

function labelPrefsStatus(text, bad) {
    const el = document.getElementById('label-prefs-status');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('is-bad', !!bad);
}

function renderLabelPrefs() {
    const box = document.getElementById('label-prefs');
    if (!box || !labelPrefs) return;
    box.replaceChildren(...LABEL_ROWS.map(([id, name, what]) => {
        const row = document.createElement('div');
        row.className = 'label-pref';
        const text = document.createElement('div');
        text.className = 'label-pref-text';
        const b = document.createElement('b'); b.textContent = name;
        const s = document.createElement('span'); s.textContent = what;
        text.append(b, s);
        const seg = document.createElement('div');
        seg.className = 'label-pref-seg';
        seg.setAttribute('role', 'radiogroup');
        seg.setAttribute('aria-label', name);
        for (const [value, label] of LABEL_CHOICES) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = label;
            btn.setAttribute('role', 'radio');
            const on = labelPrefs[id] === value;
            btn.setAttribute('aria-checked', String(on));
            if (on) btn.className = 'is-on';
            btn.addEventListener('click', () => saveLabelPref(id, value));
            seg.append(btn);
        }
        row.append(text, seg);
        return row;
    }));
}

async function saveLabelPref(id, value) {
    if (!labelPrefs || labelPrefs[id] === value) return;
    const before = { ...labelPrefs };
    labelPrefs = { ...labelPrefs, [id]: value };
    renderLabelPrefs();
    labelPrefsStatus('Saving…', false);
    try {
        const data = await apiFetch('/api/v1/me/label-prefs', { method: 'PUT', body: JSON.stringify({ prefs: labelPrefs }) });
        if (data && data.prefs) labelPrefs = data.prefs;
        renderLabelPrefs();
        const name = (LABEL_ROWS.find(([k]) => k === id) || [id, id])[1];
        labelPrefsStatus(`${name}: ${value === 'show' ? 'shown' : value === 'blur' ? 'blurred until you tap' : 'hidden'}, on every OpenVibe site.`, false);
        try { sessionStorage.removeItem('ov_label_prefs'); } catch { /* the sites read it again on their next page */ }
    } catch (err) {
        labelPrefs = before;
        renderLabelPrefs();
        labelPrefsStatus('Could not save that choice (' + (err && err.status ? 'HTTP ' + err.status : 'network error') + '). Nothing changed.', true);
    }
}

async function loadLabelPrefs() {
    const box = document.getElementById('label-prefs');
    if (!box) return;
    try {
        const data = await apiFetch('/api/v1/me/label-prefs');
        labelPrefs = data && data.prefs ? data.prefs : null;
        if (!labelPrefs) throw new Error('no prefs');
        renderLabelPrefs();
    } catch (err) {
        box.innerHTML = '<p class="muted">Your choices could not be loaded. Until they load, everything shows.</p>';
        labelPrefsStatus('Could not load your choices' + (err && err.status ? ' (HTTP ' + err.status + ')' : '') + '.', true);
    }
}
