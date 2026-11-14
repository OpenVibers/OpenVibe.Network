/* ═══════════════════════════════════════════════════════════════
   OpenVibe.Network — admin panel (/admin/guide): set up everything, one step at a time.
   It reads the live state (the Setup checklist, the AI setup, your computers and their access), works out each step and
   the setting we recommend (js/admin/guide-rules.js), and applies "Use recommended" through the routes the rest of the
   panel already uses. Progress (skipped and seen steps) is kept by /api/admin/guide (server/admin/guide.js).
   Classic script, global scope: admin/core.js's api() and toast(); built from DOM nodes.
   ═══════════════════════════════════════════════════════════════ */
let guideData = null;      // { setup, ai, machines, access, progress }
let guideModel = null;     // OVGuideRules.build(...)
let guideAt = 'welcome';
let guideBusy = false;

const GUIDE_STATE = {
    done: ['Done', 'ok', 'fa-circle-check'], todo: ['To do', 'todo', 'fa-circle-dot'], needs_you: ['Needs you', 'you', 'fa-hand'],
    optional: ['Optional', 'opt', 'fa-circle'], skipped: ['Skipped', 'opt', 'fa-forward'], unknown: ['Could not read', 'bad', 'fa-triangle-exclamation'],
};
const GUIDE_SWITCH_ROUTE = { agent_computer: 'agent-computer', ai_models: 'ai-models', watch_probe: 'watch-probe', shared_desks: 'shared-desks' };

function gEl(tag, cls, kids, attrs) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    for (const k in attrs || {}) n.setAttribute(k, attrs[k]);
    (kids || []).forEach((c) => { if (c != null && c !== false) n.append(c); });
    return n;
}
const gIcon = (name) => gEl('i', `fa-solid ${name}`, [], { 'aria-hidden': 'true' });

async function guideRead() {
    const quiet = (p) => p.catch(() => null);
    const [setup, ai, machinesOut, progress] = await Promise.all([
        quiet(api('/api/admin/setup')), quiet(api('/api/admin/ai/setup')), quiet(api('/api/v1/machines')), quiet(api('/api/admin/guide')),
    ]);
    const machines = machinesOut && Array.isArray(machinesOut.machines) ? machinesOut.machines : null;
    const access = {};
    await Promise.all((machines || []).filter((m) => m.principal_id).map(async (m) => {
        const out = await quiet(api(`/api/v1/me/nodes/${encodeURIComponent(m.principal_id)}/access-settings`));
        if (out && out.settings) access[m.principal_id] = out.settings;
    }));
    guideData = { setup, ai, machines, access, progress: progress || { skipped: [], seen: [] } };
    guideModel = OVGuideRules.build(guideData);
}

async function loadGuide() {
    const box = document.getElementById('guide-content');
    if (!box) return;
    box.replaceChildren(gEl('p', 'muted', ['Reading what is set up…']));
    try { await guideRead(); } catch (e) { box.replaceChildren(gEl('p', 'guide-bad', [e.message || 'The guide could not read the live state.'])); return; }
    const want = (location.hash || '').replace(/^#/, '');
    guideAt = guideModel.steps.some((s) => s.id === want) ? want : (guideData.progress.seen || []).includes('welcome') ? guideModel.next : 'welcome';
    guideDraw();
}

/**
 * A key step's rows, drawn by the Setup tab (js/admin/setup.js): each with its field, Save, Test and "Where to get it"
 * (11-14, the owner: the steps were lists of links that "don't bring you to where you need to configure this"). The
 * fields of one provider (Polly's id, secret and region) sit together under its name; the optional ones fold under
 * Later, what is set under Set.
 */
function guideRows(s) {
    const box = gEl('div', 'guide-setup');
    if (typeof setupRowsInto !== 'function' || !guideData.setup) return box;
    if (typeof SETUP !== 'undefined') SETUP.data = guideData.setup;
    const byId = new Map((guideData.setup.rows || []).map((r) => [r.id, r]));
    const rows = s.rows.map((id) => byId.get(id)).filter(Boolean);
    const part = (rs) => {
        const groups = new Map();
        for (const r of rs) { const k = r.required_for || r.id; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
        const wrap = gEl('div', 'guide-setup-part');
        for (const [k, g] of groups) {
            const ol = gEl('ol', 'setup-rows guide-setup-rows');
            setupRowsInto(ol, g);
            wrap.append(g.length > 1 ? gEl('section', 'guide-provider', [gEl('h4', '', [k]), ol]) : ol);
        }
        return wrap;
    };
    const waiting = rows.filter((r) => r.state === 'needed' || r.state === 'not_working');
    const later = rows.filter((r) => r.state === 'optional');
    const set = rows.filter((r) => r.state === 'connected');
    if (waiting.length) box.append(part(waiting));
    if (later.length) {
        const d = gEl('details', 'guide-later', [gEl('summary', '', [`Later · ${later.length}: add them when you want what they unlock`]), part(later)]);
        if (!waiting.length) d.open = true;
        box.append(d);
    }
    if (set.length) box.append(gEl('details', 'guide-later', [gEl('summary', '', [`Set · ${set.length}`]), part(set)]));
    for (const li of box.querySelectorAll('[data-setup-row]')) setupAttachControls(li);
    box.onclick = setupClick;
    if (window.OVForms && window.OVForms.enhance) window.OVForms.enhance(box);
    return box;
}

/** Read everything again and stay on the same step (after a save here or on the Setup tab, or "Read again"). */
async function guideReread(button) {
    if (guideBusy) return;
    guideBusy = true;
    if (button) button.disabled = true;
    try { await guideRead(); guideDraw(); } catch { /* the step on screen stays */ } finally { guideBusy = false; if (button) button.disabled = false; }
}
document.addEventListener('ov-setup-changed', () => { if (guideModel && document.getElementById('guide-content')) guideReread(null); });

async function guideSaveProgress(change) {
    const p = guideData.progress;
    const next = { skipped: change.skipped || p.skipped || [], seen: change.seen || p.seen || [] };
    try { guideData.progress = { ...p, ...(await api('/api/admin/guide', { method: 'PUT', body: next })) }; } catch { guideData.progress = { ...p, ...next }; }
}

function guideGo(id) {
    guideAt = id;
    try { history.replaceState(history.state, '', `/admin/guide#${id}`); } catch { /* */ }
    const seen = new Set(guideData.progress.seen || []);
    if (!seen.has(id)) { seen.add(id); guideSaveProgress({ seen: [...seen] }); }
    guideDraw();
    const card = document.querySelector('.guide-card');
    if (card && card.focus) card.focus();
}

function guideDraw() {
    const box = document.getElementById('guide-content');
    const steps = guideModel.steps;
    const i = Math.max(0, steps.findIndex((s) => s.id === guideAt));
    const s = steps[i];
    const pct = guideModel.total ? Math.round((guideModel.done / guideModel.total) * 100) : 0;

    const head = gEl('header', 'guide-head', [
        gEl('div', 'guide-head-t', [gEl('h2', '', ['Set up OpenVibe']), gEl('p', 'muted', [`${guideModel.done} of ${guideModel.total} steps done`])]),
        gEl('div', 'guide-bar', [gEl('span', '', [], { style: `width:${pct}%` })], { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct), 'aria-label': 'Setup progress' }),
    ]);

    // Every step, by area: a rail on a computer, a fold on a phone.
    const rail = gEl('nav', 'guide-rail', [], { 'aria-label': 'Every step' });
    let area = null; let ul = null;
    for (const st of steps) {
        if (st.area !== area) { area = st.area; ul = gEl('ul'); rail.append(gEl('p', 'guide-area', [area]), ul); }
        const [word, cls] = GUIDE_STATE[st.state] || GUIDE_STATE.todo;
        const a = gEl('a', `guide-rail-step is-${cls}${st.id === s.id ? ' is-here' : ''}`, [gEl('span', 'guide-dot', [], { 'aria-hidden': 'true' }), gEl('span', '', [st.title])], { href: `#${st.id}`, title: word, ...(st.id === s.id ? { 'aria-current': 'step' } : {}) });
        a.addEventListener('click', (e) => { e.preventDefault(); guideGo(st.id); });
        ul.append(gEl('li', '', [a]));
    }
    const fold = gEl('details', 'guide-fold', [gEl('summary', '', [`Step ${i + 1} of ${steps.length}: every step`]), rail]);

    const [word, cls, icon] = GUIDE_STATE[s.state] || GUIDE_STATE.todo;
    const card = gEl('section', 'guide-card', [], { tabindex: '-1', 'aria-labelledby': 'guide-title' });
    card.append(gEl('p', 'guide-eyebrow', [s.area]), gEl('h3', '', [s.title], { id: 'guide-title' }), gEl('span', `guide-state is-${cls}`, [gIcon(icon), ' ', word]), gEl('p', 'guide-plain', [s.plain]));
    if (s.why) card.append(gEl('p', 'guide-why', [s.why]));
    if (s.items && s.items.length) {
        card.append(gEl('ul', 'guide-items', s.items.map((it) => {
            const li = gEl('li', `is-${(GUIDE_STATE[it.state] || GUIDE_STATE.todo)[1]}`, []);
            if (it.step) { const a = gEl('a', '', [it.text], { href: `#${it.step}` }); a.addEventListener('click', (e) => { e.preventDefault(); guideGo(it.step); }); li.append(a); }
            else if (it.href) li.append(gEl('a', '', [it.text, ' ', gIcon('fa-arrow-up-right-from-square')], { href: it.href, target: '_blank', rel: 'noopener' }));
            else li.append(it.text);
            if (it.why) li.append(gEl('small', '', [it.why]));
            return li;
        })));
    }
    if (s.rows && s.rows.length) card.append(guideRows(s));
    if (s.reread) {
        const again = gEl('button', 'btn btn-outline guide-reread', [gIcon('fa-rotate'), ' Read again'], { type: 'button' });
        again.addEventListener('click', () => guideReread(again));
        card.append(gEl('div', 'guide-acts', [again]));
    }
    if (s.recommended) {
        const rec = gEl('div', 'guide-rec', [gEl('p', 'guide-rec-h', [gIcon('fa-wand-magic-sparkles'), ' We recommend']), gEl('p', 'guide-rec-l', [s.recommended.label])]);
        if (s.recommended.detail && s.recommended.detail.length) rec.append(gEl('ul', '', s.recommended.detail.map((d) => gEl('li', '', [d]))));
        if (s.recommended.apply) {
            const b = gEl('button', 'btn btn-primary guide-apply', [gIcon('fa-check'), ' Use recommended'], { type: 'button' });
            b.addEventListener('click', () => guideApply(s, b));
            rec.append(b);
        }
        card.append(rec);
    }
    const acts = gEl('div', 'guide-acts');
    if (s.open) acts.append(gEl('a', 'btn btn-outline', [s.open.label, ' ', gIcon(s.open.href.startsWith('http') ? 'fa-arrow-up-right-from-square' : 'fa-arrow-right')], { href: s.open.href, ...(s.open.href.startsWith('http') ? { target: '_blank', rel: 'noopener' } : {}) }));
    card.append(acts);

    const nav = gEl('div', 'guide-nav');
    const back = gEl('button', 'btn btn-outline', [gIcon('fa-arrow-left'), ' Back'], { type: 'button' });
    back.disabled = i === 0;
    back.addEventListener('click', () => guideGo(steps[i - 1].id));
    nav.append(back);
    if (s.id !== 'welcome' && s.id !== 'finish' && s.state !== 'done') {
        const skip = gEl('button', 'btn btn-quiet', [s.state === 'skipped' ? 'Unskip' : 'Skip for now'], { type: 'button' });
        skip.addEventListener('click', async () => {
            const set = new Set(guideData.progress.skipped || []);
            if (set.has(s.id)) set.delete(s.id); else set.add(s.id);
            await guideSaveProgress({ skipped: [...set] });
            guideModel = OVGuideRules.build(guideData);
            if (set.has(s.id) && i < steps.length - 1) guideGo(steps[i + 1].id); else guideDraw();
        });
        nav.append(skip);
    }
    if (i < steps.length - 1) {
        const next = gEl('button', 'btn btn-primary', [s.id === 'welcome' ? 'Start' : 'Next', ' ', gIcon('fa-arrow-right')], { type: 'button' });
        next.addEventListener('click', () => guideGo(steps[i + 1].id));
        nav.append(next);
    } else {
        const again = gEl('button', 'btn btn-outline', [gIcon('fa-rotate'), ' Read everything again'], { type: 'button' });
        again.addEventListener('click', () => loadGuide());
        nav.append(again);
    }
    card.append(nav);
    box.replaceChildren(head, gEl('div', 'guide-body', [fold, card]));
}

/** "Use recommended": one step's setting, through the routes the rest of the panel uses; then everything is read again. */
async function guideApply(s, button) {
    if (guideBusy) return;
    guideBusy = true;
    button.disabled = true;
    const a = s.recommended.apply;
    const failed = [];
    try {
        if (a.type === 'ai-recommended') await api('/api/admin/ai/setup/recommended', { method: 'POST', body: {} });
        else if (a.type === 'ai-test') await api(`/api/admin/ai/setup/test/${encodeURIComponent(a.step)}`, { method: 'POST', body: {} });
        else if (a.type === 'ai-caps') {
            for (const [kind, usd] of Object.entries(a.caps || {})) {
                try { await api(`/api/admin/ai/setup/caps/${encodeURIComponent(kind)}`, { method: 'PUT', body: { cap_usd: usd } }); } catch (e) { failed.push(`${kind}: ${e.message}`); }
            }
        } else if (a.type === 'machines') {
            for (const ch of a.changes || []) {
                try {
                    await api(`/api/v1/machines/${encodeURIComponent(ch.id)}/roles`, { method: 'PUT', body: { roles: ch.roles } });
                    for (const key of Object.keys(ch.switches || {})) {
                        const route = GUIDE_SWITCH_ROUTE[key];
                        if (!route) continue;
                        try { await api(`/api/v1/machines/${encodeURIComponent(ch.id)}/${route}`, { method: 'POST', body: { on: true } }); } catch (e) { failed.push(`${ch.name}: ${e.message}`); }
                    }
                } catch (e) { failed.push(`${ch.name}: ${e.message}`); }
            }
        } else if (a.type === 'access') {
            for (const ch of a.changes || []) {
                try { await api(`/api/v1/me/nodes/${encodeURIComponent(ch.principal)}/access-settings`, { method: 'PUT', body: ch.settings }); } catch (e) { failed.push(`${ch.name}: ${e.message}`); }
            }
        }
        if (typeof toast === 'function') toast(failed.length ? `Partly saved. ${failed.join('; ')}` : 'Saved. The recommended setting is on.', failed.length ? 'error' : 'success');
    } catch (e) {
        if (typeof toast === 'function') toast(e.message || 'That could not be saved.', 'error');
    } finally {
        guideBusy = false;
        await guideRead().catch(() => {});
        guideDraw();
    }
}
