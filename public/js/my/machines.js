/* ═══════════════════════════════════════════════════════════════
   OpenVibe.Network — account hub (/my#machines, /machines): your machines (plan L34, the machines hub).
   Each machine you paired: whether it is online, what it runs, the roles it plays for you (Codes jobs, desks, your
   own models, a robot), a new name, and revoking it. "Pair a machine" shows a one-time code and the command to run,
   then watches for the machine to arrive. Pairing and roles only ever come from your own session (Network refuses an
   app's token there). Classic script, global scope: my/core.js's apiFetch and showSection; built from DOM nodes.
   ═══════════════════════════════════════════════════════════════ */
let mcRoles = null;        // the catalogue: [{ id, name, installs, shows }]
let mcWatch = 0;           // the timer that watches for a newly paired machine

function mcEl(tag, cls, kids, attrs) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    for (const k in attrs || {}) n.setAttribute(k, attrs[k]);
    (kids || []).forEach((c) => { if (c != null) n.append(c); });
    return n;
}
const mcIcon = (name) => mcEl('i', `fa-solid ${name}`, [], { 'aria-hidden': 'true' });
function mcAgo(at) {
    const t = Date.parse(at);
    if (!Number.isFinite(t)) return '';
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 90) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} d ago`;
}
const MC_KIND = { onboard: 'This computer', bridge: 'A bridge', server: 'A server' };
const MC_ROLE_ICON = { 'codes.worker': 'fa-code', 'desks.host': 'fa-display', 'ai.host': 'fa-microchip', 'bot.robot': 'fa-robot' };

function mcSay(text, bad) {
    const s = document.getElementById('mc-status');
    if (!s) return;
    s.textContent = text || '';
    s.classList.toggle('is-bad', !!bad);
}

/** One machine: its state, what it runs, its roles as switches, and Rename / Revoke. */
function mcCard(m) {
    const card = mcEl('article', 'mc-card', [], { 'data-machine': m.id });
    const dot = mcEl('span', `mc-dot ${m.online ? 'is-on' : ''}`, [], { 'aria-hidden': 'true' });
    const name = mcEl('h4', 'mc-name', [m.name || MC_KIND[m.kind] || 'A machine']);
    const state = mcEl('span', 'mc-state', [m.online ? 'Online' : (m.last_seen_at ? `Offline · seen ${mcAgo(m.last_seen_at)}` : 'Offline')]);
    const meta = mcEl('p', 'mc-meta', [[MC_KIND[m.kind], m.os, m.node_version ? `Node ${m.node_version}` : ''].filter(Boolean).join(' · ')]);
    const head = mcEl('div', 'mc-head', [dot, mcEl('div', 'mc-title', [name, state]), meta]);
    card.append(head);
    (m.pools || []).forEach((pool) => card.append(mcPoolBlock(pool)));

    if (Array.isArray(m.running) && m.running.length) {
        card.append(mcEl('ul', 'mc-running', m.running.slice(0, 6).map((r) => mcEl('li', '', [String((r && (r.title || r.kind || r.id)) || r)]))));
    }

    // The roles: a switch each; a change saves the whole set at once.
    const roles = mcEl('fieldset', 'mc-roles', [mcEl('legend', '', ['What it does for you'])]);
    (mcRoles || []).forEach((role) => {
        const id = `mc-${m.id}-${role.id.replace(/\W/g, '-')}`;
        const box = mcEl('input', '', [], { type: 'checkbox', id, value: role.id });
        box.checked = (m.roles || []).includes(role.id);
        box.addEventListener('change', () => mcSaveRoles(card, m));
        roles.append(mcEl('label', 'mc-role', [box, mcEl('span', 'mc-role-ic', [mcIcon(MC_ROLE_ICON[role.id] || 'fa-gear')]), mcEl('span', 'mc-role-t', [mcEl('b', '', [role.name]), mcEl('small', '', [role.shows || ''])])], { for: id }));
    });
    card.append(roles);

    const acts = mcEl('div', 'mc-acts');
    const rename = mcEl('button', 'btn btn-outline btn-small', [mcIcon('fa-pen'), ' Rename'], { type: 'button' });
    rename.addEventListener('click', () => mcRename(card, m, name));
    const revoke = mcEl('button', 'btn btn-small mc-revoke', [mcIcon('fa-link-slash'), ' Revoke'], { type: 'button' });
    revoke.addEventListener('click', () => mcConfirmRevoke(acts, m));
    acts.append(rename, revoke);
    card.append(acts);
    return card;
}

async function mcSaveRoles(card, m) {
    const roles = [...card.querySelectorAll('.mc-role input')].filter((b) => b.checked).map((b) => b.value);
    card.querySelectorAll('.mc-role input').forEach((b) => { b.disabled = true; });
    try {
        const out = await apiFetch(`/api/v1/machines/${encodeURIComponent(m.id)}/roles`, { method: 'PUT', body: JSON.stringify({ roles }) });
        m.roles = (out && out.machine && out.machine.roles) || roles;
        mcSay(`Saved. ${m.name || 'The machine'} picks this up at its next check-in.`);
    } catch (e) {
        mcSay(e.message || 'The roles could not be saved.', true);
        card.querySelectorAll('.mc-role input').forEach((b) => { b.checked = (m.roles || []).includes(b.value); });
    } finally {
        card.querySelectorAll('.mc-role input').forEach((b) => { b.disabled = false; });
    }
}

function mcRename(card, m, nameEl) {
    const input = mcEl('input', 'mc-rename', [], { type: 'text', maxlength: '80', 'aria-label': 'New name' });
    input.value = m.name || '';
    const save = async () => {
        const v = input.value.trim();
        if (!v || v === m.name) { input.replaceWith(nameEl); return; }
        try {
            const out = await apiFetch(`/api/v1/machines/${encodeURIComponent(m.id)}`, { method: 'PATCH', body: JSON.stringify({ name: v }) });
            m.name = (out && out.machine && out.machine.name) || v;
            nameEl.textContent = m.name;
            mcSay('Renamed.');
        } catch (e) { mcSay(e.message || 'The name could not be saved.', true); }
        input.replaceWith(nameEl);
    };
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') save(); if (ev.key === 'Escape') input.replaceWith(nameEl); });
    input.addEventListener('blur', save);
    nameEl.replaceWith(input);
    input.focus(); input.select();
}

/** Revoking is for good: a second, explicit press, in the page. */
function mcConfirmRevoke(acts, m) {
    const keep = [...acts.childNodes];
    const sure = mcEl('button', 'btn btn-small mc-revoke is-sure', ['Revoke for good'], { type: 'button' });
    const back = mcEl('button', 'btn btn-outline btn-small', ['Keep it'], { type: 'button' });
    const note = mcEl('span', 'mc-confirm', ['It stops working for you at once; pairing it again needs a new code.']);
    back.addEventListener('click', () => acts.replaceChildren(...keep));
    sure.addEventListener('click', async () => {
        sure.disabled = true;
        try {
            await apiFetch(`/api/v1/machines/${encodeURIComponent(m.id)}/revoke`, { method: 'POST', body: '{}' });
            mcSay(`${m.name || 'The machine'} is revoked.`);
            loadMachines();
        } catch (e) { mcSay(e.message || 'It could not be revoked.', true); sure.disabled = false; }
    });
    acts.replaceChildren(note, sure, back);
    back.focus();
}

/** A one-time code and the command to run, then watch for the machine to arrive. */
async function mcPair() {
    const box = document.getElementById('mc-pair');
    const btn = document.getElementById('mc-pair-btn');
    if (!box) return;
    btn.disabled = true;
    try {
        const before = new Set([...document.querySelectorAll('[data-machine]')].map((c) => c.getAttribute('data-machine')));
        const out = await apiFetch('/api/v1/machines/pairings', { method: 'POST', body: '{}' });
        const p = (out && out.pairing) || {};
        const code = mcEl('p', 'mc-code', [String(p.code || '')]);
        const cmd = mcEl('pre', 'mc-cmd', [mcEl('code', '', [String(p.installer || '')])]);
        const copy = mcEl('button', 'btn btn-outline btn-small', [mcIcon('fa-copy'), ' Copy the command'], { type: 'button' });
        copy.addEventListener('click', () => navigator.clipboard.writeText(String(p.installer || '')).then(() => mcSay('Copied. Run it on the machine.')));
        const until = p.expires_at ? mcEl('span', 'mc-until', [`The code works until ${new Date(p.expires_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`]) : null;
        const wait = mcEl('p', 'mc-wait', [mcEl('span', 'mc-wait-dot', [], { 'aria-hidden': 'true' }), 'Waiting for your machine…'], { role: 'status' });
        box.replaceChildren(mcEl('h4', '', ['Run this on the machine']), mcEl('p', 'muted', ['It installs OpenVibe Node and pairs it with your account. Or type the code into Node yourself:']), code, cmd, mcEl('div', 'mc-pair-acts', [copy, until]), wait);
        box.hidden = false;
        clearInterval(mcWatch);
        const t0 = Date.now();
        mcWatch = setInterval(async () => {
            if (Date.now() - t0 > 15 * 60000) { clearInterval(mcWatch); wait.textContent = 'No machine yet. Pair again for a new code.'; return; }
            const list = await apiFetch('/api/v1/machines').catch(() => null);
            const fresh = ((list && list.machines) || []).find((m) => !before.has(m.id));
            if (!fresh) return;
            clearInterval(mcWatch);
            box.hidden = true;
            mcSay(`${fresh.name || 'Your machine'} is paired. Choose what it does for you below.`);
            loadMachines();
        }, 5000);
    } catch (e) {
        mcSay(e.message || 'A code could not be made.', true);
    } finally { btn.disabled = false; }
}

async function loadMachines() {
    const list = document.getElementById('mc-list');
    if (!list) return;
    try {
        if (!mcRoles) mcRoles = ((await apiFetch('/api/v1/machines/roles').catch(() => null)) || {}).roles || [];
        const out = await apiFetch('/api/v1/machines');
        const machines = (out && out.machines) || [];
        machines.sort((a, b) => (b.online === true) - (a.online === true));
        if (!machines.length) {
            list.replaceChildren(mcEl('div', 'mc-empty', [mcIcon('fa-laptop'), mcEl('p', '', [mcEl('b', '', ['No machines yet.']), ' Pair your computer and it can run your Codes jobs, host your desks and serve your own models, under your account.'])]));
            return;
        }
        // Pools are an extra: when they cannot be read, the machines still show.
        const pools = (await apiFetch('/api/v1/machine-pools').catch(() => null)) || { pools: [], candidates: [] };
        mcNames = new Map(machines.map((m) => [m.id, m.name || MC_KIND[m.kind] || 'A machine']));
        for (const m of machines) m.pools = (pools.pools || []).filter((p) => p.machines.some((x) => x.id === m.id));
        list.replaceChildren(...machines.map(mcCard), ...mcPoolPickers(pools.candidates || []));
    } catch (e) {
        list.replaceChildren(mcEl('p', 'muted', [e.status === 401 ? 'Sign in to see your machines.' : 'Your machines could not be read just now.']));
    }
}

/* ── Pooled machines (bot.machine-pool@1): several of your machines on one local network serving one model together.
   The page proposes and stops a pool; each machine approves it on itself (in Node), never from here. ── */
let mcNames = new Map();     // machine id → the name its card shows
const mcName = (id) => mcNames.get(id) || 'A machine';
const mcGB = (mb) => `${(Number(mb) / 1024).toFixed(mb >= 10240 ? 0 : 1)} GB`;

/** A pool on a member's card: who is the head, who has approved on itself, each machine's share, and Stop pool. */
function mcPoolBlock(pool) {
    const ready = pool.machines.every((x) => x.approved && x.ready);
    const waiting = pool.machines.filter((x) => !x.approved).length;
    const block = mcEl('fieldset', 'mc-roles mc-pool', [mcEl('legend', '', [`Pool of ${pool.machines.length} machines`])]);
    for (const x of pool.machines) {
        const state = !x.approved ? 'Waiting for approval on that machine' : x.ready ? 'Approved · ready' : 'Approved · paused or offline';
        block.append(mcEl('div', 'mc-role', [
            mcEl('span', 'mc-role-ic', [mcIcon(x.id === pool.head ? 'fa-crown' : 'fa-microchip')]),
            mcEl('span', 'mc-role-t', [mcEl('b', '', [mcName(x.id) + (x.id === pool.head ? ' (head)' : '')]),
                mcEl('small', '', [`${state} · ${Math.round(x.vram_share * 100)}% of the pool's VRAM and credits`])]),
        ]));
    }
    const note = waiting
        ? `${waiting} machine${waiting === 1 ? '' : 's'} still to approve this pool on itself, in Node (pool ${pool.id}).`
        : ready ? 'Serving as one offer. The head sees prompts; the others only receive tensors.' : 'Paused: a machine is in use, offline or outside its hours.';
    const stop = mcEl('button', 'btn btn-outline btn-small', [mcIcon('fa-stop'), ' Stop pool'], { type: 'button' });
    stop.addEventListener('click', async () => {
        stop.disabled = true;
        try {
            await apiFetch(`/api/v1/machine-pools/${encodeURIComponent(pool.id)}/revoke`, { method: 'POST', body: '{}' });
            mcSay('The pool is stopped. Each machine drops its private link and key at its next check.');
            loadMachines();
        } catch (e) { mcSay(e.message || 'The pool could not be stopped.', true); stop.disabled = false; }
    });
    block.append(mcEl('p', 'mc-confirm', [note]), mcEl('div', 'mc-acts', [stop]));
    return block;
}

/** "Pool these machines": one picker per local network with two or more of your machines that checked in lately. */
function mcPoolPickers(candidates) {
    const groups = new Map();
    for (const c of candidates) {
        if (!c.network) continue;
        if (!groups.has(c.network)) groups.set(c.network, []);
        groups.get(c.network).push(c);
    }
    return [...groups.values()].filter((g) => g.length >= 2).map((group) => {
        const panel = mcEl('fieldset', 'mc-roles mc-pool mc-card', [mcEl('legend', '', ['Pool these machines'])]);
        const boxes = group.map((c) => {
            const id = `mc-pool-${c.id}`;
            const box = mcEl('input', '', [], { type: 'checkbox', id, value: c.id });
            panel.append(mcEl('label', 'mc-role', [box, mcEl('span', 'mc-role-ic', [mcIcon('fa-microchip')]), mcEl('span', 'mc-role-t', [
                mcEl('b', '', [mcName(c.id)]), mcEl('small', '', [`${mcGB(c.free_vram)} free VRAM · ${mcGB(c.free_ram)} free RAM · ${c.hardware}`])])], { for: id }));
            return box;
        });
        const head = mcEl('select', 'mc-rename', [mcEl('option', '', ['Head: the most free VRAM'], { value: '' })], { 'aria-label': 'Which machine is the head' });
        group.forEach((c) => head.append(mcEl('option', '', [`Head: ${mcName(c.id)}`], { value: c.id })));
        const create = mcEl('button', 'btn btn-outline btn-small', [mcIcon('fa-layer-group'), ' Pool them'], { type: 'button' });
        create.addEventListener('click', async () => {
            const machines = boxes.filter((b) => b.checked).map((b) => b.value);
            if (machines.length < 2) { mcSay('Choose at least two machines.', true); return; }
            create.disabled = true;
            try {
                await apiFetch('/api/v1/machine-pools', { method: 'POST', body: JSON.stringify({ machines, ...(head.value ? { head: head.value } : {}) }) });
                mcSay('Pool proposed. Approve it on each machine; Node measures the links before it serves.');
                loadMachines();
            } catch (e) { mcSay(e.message || 'The pool could not be made.', true); create.disabled = false; }
        });
        panel.append(mcEl('p', 'mc-confirm', ['These machines checked in from the same local network. The head runs the model and sees prompts; the others lend their memory and only receive tensors. One price for the pool, and credits split by the VRAM each machine serves.']),
            mcEl('div', 'mc-acts', [head, create]));
        return panel;
    });
}
