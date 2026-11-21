/* ═══════════════════════════════════════════════════════════════
   OpenVibe.Network — account hub (/my#machines): spare usage (plan 2026-11-13 §AD.37; the owner, 11-21: "if the
   weekly reset's coming up and there's still usage available … a task list … every ounce of your usage across all your
   code harnesses … configurable through network or my or openvibe.codes or actor").
   What each of your coding agents has left before its plan resets, and the list your agents work through with what
   would otherwise be lost. The list is OpenVibe.Codes' own (GET/PUT /api/v1/me/spare, POST /api/v1/me/spare/tasks):
   called with your own token, the same list openvibe.codes/settings/spare and Actor show. Classic script, global
   scope (my/core.js's getAuthToken); built from DOM nodes.
   ═══════════════════════════════════════════════════════════════ */
const SP_CODES = 'https://openvibe.codes';
function spEl(tag, cls, kids, attrs) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    for (const k in attrs || {}) n.setAttribute(k, attrs[k]);
    (kids || []).forEach((c) => { if (c != null) n.append(c); });
    return n;
}
function spIn(at) {
    const ms = Date.parse(at || '') - Date.now();
    if (!Number.isFinite(ms)) return '';
    if (ms <= 0) return 'now';
    const min = Math.round(ms / 60000);
    if (min < 90) return `in ${min} min`;
    const h = Math.round(min / 60);
    return h < 48 ? `in ${h} h` : `in ${Math.round(h / 24)} days`;
}
async function spCall(path, opts = {}) {
    const token = typeof getAuthToken === 'function' ? getAuthToken() : null;
    if (!token) throw Object.assign(new Error('Sign in to see your spare usage.'), { status: 401 });
    const res = await fetch(SP_CODES + path, {
        ...opts,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
    });
    if (res.status === 204) return null;
    const body = await res.json().catch(() => null);
    if (!res.ok) throw Object.assign(new Error((body && (body.detail || body.title)) || `OpenVibe.Codes answered ${res.status}`), { status: res.status });
    return body;
}
function spMeter(a) {
    const li = spEl('li', `sp-agent${a.take ? ' is-taking' : ''}`, [spEl('div', 'sp-ahead', [spEl('b', '', [a.name || a.agent]), a.take ? spEl('span', 'sp-chip', ['Takes the next task']) : null])]);
    for (const w of a.windows || []) {
        const used = w.used_pct == null ? null : Math.max(0, Math.min(100, w.used_pct));
        const bar = spEl('div', 'sp-bar', [spEl('span', '', [], { style: `width:${used == null ? 0 : used}%` })], { role: 'meter', 'aria-label': `${a.name || a.agent} ${w.name}`, 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(used == null ? 0 : Math.round(used)) });
        li.append(spEl('div', `sp-window${used != null && used >= 95 ? ' is-full' : used != null && used >= 80 ? ' is-low' : ''}`, [
            spEl('div', 'sp-wline', [spEl('span', '', [w.name]), spEl('span', '', [`${used == null ? 'unknown' : `${100 - Math.round(used)}% left`}${w.resets_at ? ` · resets ${spIn(w.resets_at)}` : ''}`])]),
            bar,
        ]));
    }
    if (a.why) li.append(spEl('p', 'sp-why', [a.why]));
    return li;
}
async function loadSpare() {
    const box = document.getElementById('mc-spare');
    if (!box) return;
    let v;
    try { v = await spCall('/api/v1/me/spare'); } catch (e) {
        box.hidden = e.status === 401;
        box.replaceChildren(spEl('h4', '', ['Spare usage']), spEl('p', 'muted', ['Your coding agents’ usage could not be read just now.']));
        return;
    }
    box.hidden = false;
    const queued = v.tasks.filter((t) => t.state === 'queued').length;
    const sw = spEl('input', '', [], { type: 'checkbox', role: 'switch', id: 'sp-enabled', 'aria-describedby': 'sp-lede' });
    sw.checked = !!v.settings.enabled;
    sw.addEventListener('change', async () => {
        sw.disabled = true;
        try { await spCall('/api/v1/me/spare', { method: 'PUT', body: JSON.stringify({ enabled: sw.checked }) }); } catch (e) { sw.checked = !sw.checked; say(e.message); } finally { sw.disabled = false; }
    });
    const status = spEl('p', 'sp-status', [], { role: 'status' });
    const say = (t) => { status.textContent = t || ''; };
    const prompt = spEl('textarea', '', [], { rows: '2', maxlength: '8000', required: '', placeholder: 'Add tests for the module nobody tested yet.', 'aria-label': 'What to do' });
    const repo = spEl('input', '', [], { maxlength: '300', required: '', placeholder: 'owner/name', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Repository' });
    const add = spEl('form', 'sp-add', [prompt, repo, spEl('button', 'btn btn-primary btn-small', ['Add to the list'], { type: 'submit' })]);
    add.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
            await spCall('/api/v1/me/spare/tasks', { method: 'POST', body: JSON.stringify({ prompt: prompt.value, repo: repo.value }) });
            prompt.value = ''; say('Added.');
            loadSpare();
        } catch (err) { say(err.message); }
    });
    const list = spEl('ul', 'sp-tasks', [], { role: 'list' });
    for (const t of v.tasks.slice(0, 6)) list.append(spEl('li', `sp-task is-${t.state}`, [spEl('b', '', [t.title]), spEl('span', 'muted', [` ${({ queued: 'waiting', running: 'running', done: 'done', failed: 'did not finish', paused: 'paused' })[t.state] || t.state}`])]));
    box.replaceChildren(
        spEl('div', 'sp-head', [
            spEl('h4', '', ['Spare usage']),
            spEl('label', 'sp-switch', [sw, spEl('span', '', ['Use it on my list'])], { for: 'sp-enabled' }),
        ]),
        spEl('p', 'muted', [`Your plans reset on their own clock, and what is left is lost. With this on, an agent that resets within ${v.settings.reset_within_hours} h with ${v.settings.min_left_pct}% or more left, and is not busy, works through your list (${queued} waiting).`], { id: 'sp-lede' }),
        v.agents.length ? spEl('ul', 'sp-agents', v.agents.map(spMeter), { role: 'list' }) : spEl('p', 'muted', ['No coding agent has reported yet: turn on “Run my coding tasks” on a machine above.']),
        v.tasks.length ? list : null,
        add,
        status,
        spEl('a', 'sp-more', ['The whole list and its settings on OpenVibe Codes'], { href: `${SP_CODES}/settings/spare` }),
    );
}
document.addEventListener('DOMContentLoaded', () => { loadSpare().catch(() => {}); });
