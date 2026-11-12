/* ── Machine access and agents on openvibe.link/machines (Link #157, Network #849/#853, Bot #407) ──────────────────
   One machine asks another for access; its owner answers here (or in the Link tray) and can take it back at any time.
   Agents on any of the person's machines (and on Actor or Codes) talk to each other in threads the owner can stop.

   The routes (all the signed-in person's own rows, named by server/link/names.js):
     GET  /api/v1/me/nodes/access-requests            asked of you (side "in"), asked by you ("out"), between yours ("own")
     POST /api/v1/me/nodes/access-requests/:id/answer { approve, scopes?, duration_seconds? }: only narrower or shorter
     GET  /api/v1/me/nodes/access-grants               POST …/:id/revoke
     GET  /api/v1/me/nodes/access-audit                each use of a grant
     GET/PUT /api/v1/me/nodes/:principal/access-settings  the three switches on a machine's card
     GET  /api/v1/me/agents   PUT …/:id/allow-others   GET /api/v1/me/agent-threads   POST …/:id/stop
   Uses mcEl, mcIcon, mcAgo and mcSay from machines.js. Every name is a text node. */

const MA_SCOPE = {
    agent: ['fa-robot', 'Talk to your agents'],
    send: ['fa-paper-plane', 'Send you files'],
    screen: ['fa-display', 'Watch the screen'],
    desk: ['fa-window-maximize', 'Use a desk'],
    computer: ['fa-computer-mouse', 'Control the computer'],
    worker: ['fa-microchip', 'Run jobs on it'],
};
const MA_TIMES = [[600, '10 minutes'], [3600, '1 hour'], [4 * 3600, '4 hours'], [86400, '1 day'], [7 * 86400, '1 week'], [30 * 86400, '30 days']];

const maPerson = (p) => (p && (p.display_name || p.username)) || 'Someone';
/** "Jo's laptop" for someone else's machine, "your laptop" for your own. */
function maMachine(row, end) {
    const m = row[`${end}_machine`] || {};
    const mine = row.side === 'own' || (row.side === 'in' ? end === 'to' : end === 'from');
    return mine ? `your ${m.name || 'machine'}` : `${maPerson(row[`${end}_person`])}'s ${m.name || 'machine'}`;
}
const maCap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
function maFor(seconds) {
    if (seconds == null) return 'until you take it back';
    const hit = MA_TIMES.find(([n]) => n === Number(seconds));
    if (hit) return `for ${hit[1]}`;
    const m = Math.round(Number(seconds) / 60);
    return m < 120 ? `for ${m} minutes` : m < 2880 ? `for ${Math.round(m / 60)} hours` : `for ${Math.round(m / 1440)} days`;
}
function maLeft(expiresAt) {
    if (!expiresAt) return 'until you take it back';
    const ms = Date.parse(expiresAt) - Date.now();
    if (!(ms > 0)) return 'ended';
    const min = Math.round(ms / 60000);
    return min < 60 ? `${min} min left` : min < 2880 ? `${Math.floor(min / 60)} h ${min % 60} min left` : `${Math.round(min / 1440)} days left`;
}
const maLive = (g) => !g.revoked_at && (!g.expires_at || Date.parse(g.expires_at) > Date.now());
function maScopes(scopes) {
    return mcEl('ul', 'ma-scopes', (scopes || []).map((s) => mcEl('li', '', [mcIcon((MA_SCOPE[s] || [])[0] || 'fa-key'), ' ', (MA_SCOPE[s] || [])[1] || s])));
}
const maScopeWords = (scopes) => (scopes || []).map((s) => (MA_SCOPE[s] || [])[1] || s).join(', ');

async function maPost(path, body) {
    return apiFetch(path, { method: 'POST', body: JSON.stringify(body || {}) });
}

/** A request asked of you: who, from which machine, to which of yours, what, how long, why; Allow, Allow less, Deny. */
function maAskCard(r) {
    const card = mcEl('article', 'ma-ask');
    const title = mcEl('p', 'ma-ask-title', [mcEl('b', '', [maCap(maMachine(r, 'from'))]), ` asks for access to ${maMachine(r, 'to')}`]);
    const when = mcEl('p', 'ma-ask-when', [`${maCap(maFor(r.duration_seconds))} · asked ${mcAgo(r.asked_at)}`]);
    card.append(title, maScopes(r.scopes), when);
    if (r.reason) card.append(mcEl('blockquote', 'ma-reason', [r.reason]));
    const say = mcEl('p', 'ma-say', [], { role: 'status' });
    const answer = async (body, btns) => {
        btns.forEach((b) => { b.disabled = true; });
        try {
            await maPost(`/api/v1/me/nodes/access-requests/${encodeURIComponent(r.id)}/answer`, body);
            mcSay(body.approve ? `Allowed: ${maMachine(r, 'from')} may ${maScopeWords(body.scopes || r.scopes).toLowerCase()}.` : 'Denied. They can ask again tomorrow.');
            loadMachineAccess();
        } catch (e) {
            say.textContent = e.status === 410 ? 'This request waited too long and has ended.' : (e.message || 'The answer could not be saved.');
            btns.forEach((b) => { b.disabled = false; });
        }
    };
    const allow = mcEl('button', 'btn btn-primary btn-small', [mcIcon('fa-check'), ' Allow'], { type: 'button' });
    const deny = mcEl('button', 'btn btn-outline btn-small', [mcIcon('fa-xmark'), ' Deny'], { type: 'button' });
    const less = mcEl('details', 'ma-less');
    less.append(mcEl('summary', '', ['Allow less…']));
    // Narrower only: the asked scopes, each on by default, and times no longer than asked.
    const boxes = (r.scopes || []).map((s) => {
        const box = mcEl('input', '', [], { type: 'checkbox', value: s });
        box.checked = true;
        return mcEl('label', 'ma-less-scope', [box, ' ', (MA_SCOPE[s] || [])[1] || s]);
    });
    const times = MA_TIMES.filter(([n]) => r.duration_seconds == null || n <= Number(r.duration_seconds));
    const sel = mcEl('select', '', [
        ...(r.duration_seconds == null ? [mcEl('option', '', ['Until I take it back'], { value: '' })] : []),
        ...times.map(([n, label]) => mcEl('option', '', [label], { value: String(n) })),
    ], { 'aria-label': 'For how long' });
    if (r.duration_seconds != null) sel.value = String(times.length ? times[times.length - 1][0] : r.duration_seconds);
    const allowLess = mcEl('button', 'btn btn-primary btn-small', ['Allow this much'], { type: 'button' });
    less.append(mcEl('div', 'ma-less-body', [...boxes, mcEl('label', 'ma-less-time', ['For ', sel]), allowLess]));
    const btns = [allow, deny, allowLess];
    allow.addEventListener('click', () => answer({ approve: true }, btns));
    deny.addEventListener('click', () => answer({ approve: false }, btns));
    allowLess.addEventListener('click', () => {
        const scopes = boxes.map((l) => l.querySelector('input')).filter((b) => b.checked).map((b) => b.value);
        if (!scopes.length) { say.textContent = 'Choose at least one thing to allow, or press Deny.'; return; }
        answer({ approve: true, scopes, ...(sel.value ? { duration_seconds: Number(sel.value) } : {}) }, btns);
    });
    card.append(mcEl('div', 'ma-ask-acts', [allow, deny]), less, say);
    return card;
}

/** An allowed grant: from → to, what, how long is left; Take back. */
function maGrantRow(g) {
    const row = mcEl('li', 'ma-grant');
    const text = mcEl('div', 'ma-grant-t', [
        mcEl('b', '', [`${maCap(maMachine(g, 'from'))} → ${maMachine(g, 'to')}`]),
        mcEl('small', '', [`${maScopeWords(g.scopes)} · ${maLeft(g.expires_at)}`]),
    ]);
    const back = mcEl('button', 'btn btn-outline btn-small', [mcIcon('fa-hand'), ' Take back'], { type: 'button' });
    back.addEventListener('click', async () => {
        back.disabled = true;
        try {
            await maPost(`/api/v1/me/nodes/access-grants/${encodeURIComponent(g.id)}/revoke`);
            mcSay('Taken back. It ends now, on both machines.');
            loadMachineAccess();
        } catch (e) { back.disabled = false; mcSay(e.message || 'It could not be taken back.', true); }
    });
    row.append(mcIcon('fa-key'), text, back);
    return row;
}

function maSection(title, note, kids) {
    return mcEl('section', 'ma-sec', [mcEl('h4', '', [title]), ...(note ? [mcEl('p', 'muted ma-note', [note])] : []), ...kids]);
}

async function loadMachineAccess() {
    const box = document.getElementById('mc-access');
    if (!box) return;
    const [req, gr, au] = await Promise.all([
        apiFetch('/api/v1/me/nodes/access-requests').catch(() => null),
        apiFetch('/api/v1/me/nodes/access-grants').catch(() => null),
        apiFetch('/api/v1/me/nodes/access-audit').catch(() => null),
    ]);
    if (!req && !gr) { box.replaceChildren(); box.hidden = true; return; }
    const requests = (req && req.requests) || [];
    const grants = (gr && gr.grants) || [];
    const audit = ((au && au.audit) || []).slice(0, 20);
    const asking = requests.filter((r) => r.status === 'pending' && (r.side === 'in' || r.side === 'own'));
    const waiting = requests.filter((r) => r.status === 'pending' && r.side === 'out');
    const live = grants.filter(maLive);
    const ended = [...requests.filter((r) => r.status === 'denied' || r.status === 'expired'), ...grants.filter((g) => !maLive(g))]
        .sort((a, b) => Date.parse(b.answered_at || b.revoked_at || b.expires_at || 0) - Date.parse(a.answered_at || a.revoked_at || a.expires_at || 0)).slice(0, 10);
    const parts = [mcEl('h3', 'ma-h', [mcEl('span', 'icon', [mcIcon('fa-key')]), ' Access between machines'])];
    parts.push(mcEl('p', 'muted ma-note', ['A machine can ask another for access: to send files, talk to its agents, watch its screen. Each owner answers, and can take it back at any time. People can only ask if they follow you and the machine allows it (on its card above).']));
    if (asking.length) parts.push(maSection(`Asking you (${asking.length})`, '', asking.map(maAskCard)));
    if (live.length) parts.push(maSection('Allowed now', '', [mcEl('ul', 'ma-grants', live.map(maGrantRow))]));
    if (waiting.length) {
        parts.push(maSection('Waiting for an answer', '', [mcEl('ul', 'ma-list', waiting.map((r) => mcEl('li', '', [
            mcEl('b', '', [maCap(maMachine(r, 'to'))]), ` · ${maScopeWords(r.scopes)} · ${maFor(r.duration_seconds)} · asked ${mcAgo(r.asked_at)}`])))]));
    }
    if (!asking.length && !live.length && !waiting.length) {
        parts.push(mcEl('div', 'mc-empty ma-empty', [mcIcon('fa-key'), mcEl('p', '', [mcEl('b', '', ['Nothing asked or allowed yet.']), ' From a machine, run ', mcEl('code', '', ['openvibe-link access request @person/machine send']), ', or let an agent ask. The answer shows here and in the Link tray.'])]));
    }
    if (audit.length) {
        const used = mcEl('details', 'ma-fold');
        used.append(mcEl('summary', '', [`What was used (${audit.length})`]),
            mcEl('ul', 'ma-list', audit.map((a) => mcEl('li', '', [
                mcEl('time', '', [mcAgo(a.at)], { datetime: a.at }), ' · ', maCap(maMachine(a, 'from')), ` used “${(MA_SCOPE[a.scope] || [])[1] || a.scope}” on ${maMachine(a, 'to')}`, a.action ? ` (${a.action})` : '']))));
        parts.push(used);
    }
    if (ended.length) {
        const old = mcEl('details', 'ma-fold');
        old.append(mcEl('summary', '', [`Ended (${ended.length})`]),
            mcEl('ul', 'ma-list', ended.map((x) => mcEl('li', '', [maCap(maMachine(x, 'from')), ` → ${maMachine(x, 'to')} · ${maScopeWords(x.scopes)} · `,
                x.status === 'denied' ? 'denied' : x.status === 'expired' ? 'no answer in time' : x.revoked_at ? 'taken back' : 'time ran out']))));
        parts.push(old);
    }
    box.replaceChildren(...parts);
    box.hidden = false;
    loadMachineAgents();
}

/* ── Agents ── */
const MA_THREAD_STATE = (t) => (t.stopped_at ? 'Stopped' : Date.parse(t.closes_at) <= Date.now() ? 'Ended (a day quiet)' : 'Open');
const maTaskText = (m) => {
    const parts = (m && Array.isArray(m.parts)) ? m.parts : [];
    return parts.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join(' ').trim().slice(0, 240);
};
function maAgentLabel(a) {
    if (!a) return 'An agent';
    const where = a.machine ? (a.mine ? `your ${a.machine.name}` : `${maPerson(a.person)}'s ${a.machine.name}`) : a.service ? `OpenVibe.${maCap(a.service)}` : (a.mine ? 'yours' : maPerson(a.person));
    return `${a.name} on ${where}`;
}

async function loadMachineAgents() {
    const box = document.getElementById('mc-agents');
    if (!box) return;
    const [ag, th] = await Promise.all([
        apiFetch('/api/v1/me/agents').catch(() => null),
        apiFetch('/api/v1/me/agent-threads').catch(() => null),
    ]);
    if (!ag && !th) { box.replaceChildren(); box.hidden = true; return; }
    const agents = (ag && ag.agents) || [];
    const threads = (th && th.threads) || [];
    const parts = [mcEl('h3', 'ma-h', [mcEl('span', 'icon', [mcIcon('fa-robot')]), ' Your agents'])];
    if (!agents.length) {
        parts.push(mcEl('div', 'mc-empty ma-empty', [mcIcon('fa-robot'), mcEl('p', '', [mcEl('b', '', ['No agents yet.']), ' Run the Link on a computer with an AI coding app (Codex, Claude Code, Muse …): each one shows up here and can talk to your other agents.'])]));
    } else {
        parts.push(mcEl('ul', 'ma-agents', agents.map((a) => {
            const id = `ma-agent-${String(a.id).replace(/\W/g, '-')}`;
            const box2 = mcEl('input', '', [], { type: 'checkbox', id });
            box2.checked = !!a.allow_others;
            box2.addEventListener('change', async () => {
                box2.disabled = true;
                try {
                    await apiFetch(`/api/v1/me/agents/${encodeURIComponent(a.id)}/allow-others`, { method: 'PUT', body: JSON.stringify({ allow_others: box2.checked }) });
                    mcSay(box2.checked ? `${a.name}: other people's agents may ask it now (each one still needs a machine's permission).` : `${a.name} answers only your own agents.`);
                } catch (e) { box2.checked = !box2.checked; mcSay(e.message || 'That could not be saved.', true); }
                finally { box2.disabled = false; }
            });
            const where = a.machine ? `on ${a.machine.name}` : a.service ? `on OpenVibe.${maCap(a.service)}` : '';
            return mcEl('li', 'ma-agent', [
                mcEl('span', `mc-dot ${a.status === 'online' ? 'is-on' : ''}`, [], { 'aria-hidden': 'true' }),
                mcEl('div', 'ma-agent-t', [mcEl('b', '', [a.name]), mcEl('small', '', [[/^(link-local|actor|codes)$/.test(String(a.kind)) ? '' : a.kind, where, a.status === 'online' ? 'online' : 'offline'].filter(Boolean).join(' · ')])]),
                mcEl('label', 'ma-agent-sw', [box2, mcEl('span', '', ["Others' agents may ask it"])], { for: id }),
            ]);
        })));
    }
    if (threads.length) {
        parts.push(mcEl('h4', 'ma-sub', ['Conversations between agents']));
        parts.push(mcEl('ul', 'ma-threads', threads.slice(0, 20).map((t) => {
            const state = MA_THREAD_STATE(t);
            const head = mcEl('p', 'ma-thread-h', [mcEl('b', '', [maAgentLabel(t.from_agent)]), ' ↔ ', mcEl('b', '', [maAgentLabel(t.to_agent)]), mcEl('span', `ma-state is-${state === 'Open' ? 'open' : 'closed'}`, [state])]);
            const tasks = mcEl('ol', 'ma-tasks', (t.tasks || []).slice(-6).map((k) => mcEl('li', `is-${k.status}`, [
                mcEl('span', 'ma-task-msg', [maTaskText(k.message) || 'A task']),
                mcEl('small', '', [k.status === 'completed' && maTaskText(k.result) ? `→ ${maTaskText(k.result)}` : k.status]),
            ])));
            const li = mcEl('li', 'ma-thread', [head, tasks]);
            if (state === 'Open') {
                const stop = mcEl('button', 'btn btn-outline btn-small', [mcIcon('fa-stop'), ' Stop this conversation'], { type: 'button' });
                stop.addEventListener('click', async () => {
                    stop.disabled = true;
                    try { await maPost(`/api/v1/me/agent-threads/${encodeURIComponent(t.id)}/stop`); mcSay('Stopped. Its open tasks are cancelled.'); loadMachineAgents(); }
                    catch (e) { stop.disabled = false; mcSay(e.message || 'It could not be stopped.', true); }
                });
                li.append(stop);
            }
            return li;
        })));
    }
    box.replaceChildren(...parts);
    box.hidden = false;
}

/** The three access switches on a paired machine's card, read when the card is drawn. */
function mcAccessSwitches(m) {
    if (!m.principal_id) return null;
    const field = mcEl('fieldset', 'mc-roles mc-switches ma-switches', [mcEl('legend', '', ['Other machines and agents'])]);
    const rows = [
        ['others_may_ask', 'Others may ask for access', 'People you follow can ask this machine for access; you answer each time. Off: nobody else can ask.', 'fa-user-group'],
        ['auto_agent_send', 'My machines need no answer', 'Your own machines may talk to its agents and send it files without asking you first.', 'fa-laptop'],
        ['agents_talk', 'Its agents may talk to other agents', 'Agents here may send tasks to your other agents, and to others where they are allowed.', 'fa-robot'],
    ];
    const boxes = {};
    for (const [key, label, note, icon] of rows) {
        const id = `mc-${m.id}-${key}`;
        const box = mcEl('input', '', [], { type: 'checkbox', id, disabled: '' });
        boxes[key] = box;
        box.addEventListener('change', async () => {
            box.disabled = true;
            try {
                await apiFetch(`/api/v1/me/nodes/${encodeURIComponent(m.principal_id)}/access-settings`, { method: 'PUT', body: JSON.stringify({ [key]: box.checked }) });
                mcSay(`Saved. ${m.name || 'The machine'}: ${label.toLowerCase()} ${box.checked ? 'on' : 'off'}.`);
            } catch (e) { box.checked = !box.checked; mcSay(e.message || 'The switch could not be saved.', true); }
            finally { box.disabled = false; }
        });
        field.append(mcEl('label', 'mc-role', [box, mcEl('span', 'mc-role-ic', [mcIcon(icon)]), mcEl('span', 'mc-role-t', [mcEl('b', '', [label]), mcEl('small', '', [note])])], { for: id }));
    }
    apiFetch(`/api/v1/me/nodes/${encodeURIComponent(m.principal_id)}/access-settings`).then((out) => {
        const s = (out && out.settings) || {};
        for (const [key, box] of Object.entries(boxes)) { box.checked = s[key] === true; box.disabled = false; }
    }).catch(() => { field.append(mcEl('p', 'muted', ['These switches could not be read just now.'])); });
    return field;
}
