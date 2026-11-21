'use strict';
/**
 * Group conversations: people and agents in one thread (plan §AD.19; the owner, 2026-11-17: "use .actor and .codes in a
 * group conversation mode … admin and owner ranks should be able to use that via admin panel and it has a shared space
 * and files/download/media interconnected", then "multi user and multi agent like you can have different actors using
 * different harnesses and also other openvibe users per chat").
 *
 *   GET    /api/frame/groups                    the groups you are in → { groups }
 *   GET    /api/frame/groups/presets            the agents a group can have (Actor's engines, Codes' harnesses)
 *   POST   /api/frame/groups                    start one (admin and owner ranks) { title, people: [username], agents: [agent] }
 *   GET    /api/frame/groups/:id?after=         the group, its members, its messages after a seq, its shared space
 *   POST   /api/frame/groups/:id/messages       say something { text, files: [ai.file@1] } → 202 (agents answer after)
 *   POST   /api/frame/groups/:id/members        add a person { username } or an agent { agent } (admin and owner ranks)
 *   DELETE /api/frame/groups/:id/members/:mid   remove one (admin and owner ranks; never the last person)
 *
 * Who answers is openvibe-sdk/agents/group (@mentions, else the coder for plainly coding words, else the lead; handoffs by
 * @mention; three agent turns, $0.50 or DONE close a round). Reviewers (plan §AD.25; the owner, 11-17: "have claude
 * code work on the code and interface and then have muse and codex or API analyze and review the gui and critique it …
 * a Design bot as a default next to Actor and Codes"): when a builder ends with DONE, every reviewer looks at once (their
 * turns run in parallel here), each ends with APPROVED or a CHANGES list, and the builder fixes until all approve or two
 * reviews have run (SDK 0.181.0). A group starts with Actor (the lead), Codes (the coder) and Design (a reviewer: Actor's
 * loop with openvibe.design's brief, rules and tools, the `design` specialist). An agent is a role: Actor with an engine (its own agent loop,
 * one model, a harness such as Codex or Claude Code …) or Codes with a harness. Its turn runs through the Frame's own
 * runs API (server/frame/runs.js) on the account of the person whose message started the round: their allowance, their
 * keys, their computers; nobody's turn ever spends another person's. So each agent keeps one run per person
 * (frame_group_runs), and is told what the others said since it last spoke (agents/group `transcript`).
 *
 * The shared space is every file in the thread: what people attach (uploaded to Media through POST
 * /api/frame/runs/files, as themselves) and what agents hand back, each with its link.
 *
 * A group is also a run (`group:<id>`, kind `group`) in the Frame's one runs list (server/frame/runs.js `extra`), so
 * every site's session surface lists it beside chats, tasks and coding runs, reads its thread as steps (each step names
 * who said it) and says something to it the same way (the owner, 11-17: "the same agentic shared universal system
 * across all sites from groups to chats to codes").
 */
const crypto = require('crypto');
const express = require('express');
const group = require('openvibe-sdk/agents/group');

const ID = /^grp_[0-9a-f]{20}$/;
const HANDLE = /^[a-z][a-z0-9_-]{1,23}$/;
const AGENT_ID = /^agt_[0-9A-HJKMNP-TV-Z]{26}$/;
const USERNAME = /^[A-Za-z0-9_.-]{2,40}$/;
const BEARER = /^Bearer [A-Za-z0-9._~+/=-]{10,4096}$/;
// a2a (11-19, plan §AD.19 "A2A for outside agents"): an outside agent at its https address, through Actor's a2a engine,
// with the key of the person whose message started the round when they connected that agent on openvibe.actor.
const ACTOR_ENGINES = ['agent', 'model', 'harness', 'openai-agent', 'open-model', 'decisions', 'a2a'];
const HARNESSES = ['claude-code', 'codex', 'opencode', 'gemini', 'hermes', 'dsh', 'codebuddy-code', 'muse'];
const SPECIALISTS = ['design'];
const MAX_AGENTS = 8;
const MAX_PEOPLE = 50;
const clip = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, n);
const httpsUrl = (v) => { try { const u = new URL(String(v)); return u.protocol === 'https:' ? u.toString() : null; } catch { return null; } };
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });

/** The agents a group starts with, and the ones the UI offers. */
const PRESETS = [
    { handle: 'actor', name: 'Actor', product: 'actor', lead: true, default: true, line: 'Your Actor: its own agent loop, tools and memory' },
    { handle: 'codes', name: 'Codes', product: 'codes', coder: true, default: true, line: 'The coding agent: picks the harness itself' },
    // Design (plan §AD.25): Actor's loop with openvibe.design's brief, rules and tools; it reviews what a builder made.
    { handle: 'design', name: 'Design', product: 'actor', engine: { kind: 'agent', specialist: 'design' }, reviewer: true, default: true,
        line: 'Looks at screens as a phone and a desktop see them, holds them to openvibe.design\'s rules; makes icons, themes and fonts' },
    { handle: 'codex', name: 'Actor · Codex', product: 'actor', engine: { kind: 'harness', harness: 'codex' }, line: 'Actor working through the Codex harness' },
    { handle: 'claude', name: 'Actor · Claude Code', product: 'actor', engine: { kind: 'harness', harness: 'claude-code' }, line: 'Actor working through Claude Code' },
    { handle: 'oneshot', name: 'Actor · one model', product: 'actor', engine: { kind: 'model' }, line: 'One model, one answer: fast and cheap' },
    { handle: 'opencode', name: 'Codes · OpenCode', product: 'codes', harness: 'opencode', coder: true, line: 'Codes on the OpenCode harness' },
    // WorkBuddy's agent (2026-11-17): CodeBuddy Code on the person's own WorkBuddy login, where Tencent's Hy4 flash is free
    // to 30 November 2026 (OpenVibe.Codes #539).
    { handle: 'workbuddy', name: 'Codes · CodeBuddy (WorkBuddy)', product: 'codes', harness: 'codebuddy-code', coder: true, line: 'WorkBuddy\'s agent on Tencent\'s Hy4, on your own login' },
    // Critics from other families (plan §AD.25): different models miss different things. Each looks at a builder's work
    // and ends with APPROVED or CHANGES; it never fixes the work itself.
    { handle: 'codex-review', name: 'Codex · review', product: 'actor', engine: { kind: 'harness', harness: 'codex' }, reviewer: true, line: 'Codex reads the change and critiques it' },
    { handle: 'muse-review', name: 'Muse · review', product: 'actor', engine: { kind: 'harness', harness: 'muse' }, reviewer: true, line: 'Muse, Meta\'s coding agent, looks at the work and critiques it' },
    { handle: 'claude-review', name: 'Claude Code · review', product: 'actor', engine: { kind: 'harness', harness: 'claude-code' }, reviewer: true, line: 'Claude Code critiques the change' },
    { handle: 'model-review', name: 'A model · review', product: 'actor', engine: { kind: 'model' }, reviewer: true, line: 'One model reads it and critiques it: fast and cheap' },
];

/** An agent's stored role from what a client sent: the product, then only the settings that product reads. */
function agentOf(a) {
    if (!a || typeof a !== 'object') throw fail(422, 'groups.agent_invalid', 'An agent needs a product (actor or codes)');
    const product = a.product === 'codes' ? 'codes' : a.product === 'actor' ? 'actor' : null;
    if (!product) throw fail(422, 'groups.agent_invalid', 'An agent is Actor or Codes ({ product })');
    const handle = clip(a.handle, 24).toLowerCase();
    if (!HANDLE.test(handle)) throw fail(422, 'groups.handle_invalid', 'A handle is 2–24 letters, digits, - or _, starting with a letter (it is how people @mention it)');
    const name = clip(a.name, 60) || handle;
    const config = { product, ...(a.lead ? { lead: true } : {}), ...(a.coder || product === 'codes' ? { coder: true } : {}), ...(a.reviewer && product === 'actor' ? { reviewer: true } : {}) };
    // Your own Actor agent (an agt_ id, 11-17: "different actors using different harnesses"): its own instructions,
    // memory and engine come with it, so no engine is stored here.
    if (product === 'actor' && a.agent != null) {
        if (!AGENT_ID.test(String(a.agent))) throw fail(422, 'groups.agent_id_invalid', 'Your own agent is named by its agt_ id');
        config.agent = String(a.agent);
    } else if (product === 'actor' && a.engine) {
        const kind = typeof a.engine === 'string' ? a.engine : a.engine.kind;
        if (!ACTOR_ENGINES.includes(kind)) throw fail(422, 'groups.engine_invalid', `Actor's engine is one of ${ACTOR_ENGINES.join(', ')}`);
        const harness = typeof a.engine === 'object' && a.engine.harness ? String(a.engine.harness) : null;
        if (kind === 'harness' && !HARNESSES.includes(harness)) throw fail(422, 'groups.harness_invalid', `A harness is one of ${HARNESSES.join(', ')}`);
        const model = typeof a.engine === 'object' && typeof a.engine.model === 'string' ? clip(a.engine.model, 120) : null;
        const specialist = typeof a.engine === 'object' && a.engine.specialist != null ? String(a.engine.specialist) : null;
        const rawUrl = typeof a.engine === 'object' && a.engine.url != null ? String(a.engine.url) : '';
        const url = kind === 'a2a' && rawUrl.length <= 2048 ? httpsUrl(rawUrl) : null;
        if (kind === 'a2a' && (!url || /^https:\/\/[^/]*@/.test(url))) throw fail(422, 'groups.agent_url_invalid', 'An outside agent needs its https address (its base, or its /.well-known/agent-card.json)');
        if (kind !== 'a2a' && rawUrl) throw fail(422, 'groups.agent_url_invalid', 'Only an outside agent (the a2a engine) takes an address');
        if (specialist && (kind !== 'agent' || !SPECIALISTS.includes(specialist))) throw fail(422, 'groups.specialist_invalid', `A specialist is one of ${SPECIALISTS.join(', ')}, on Actor's agent engine`);
        config.engine = { kind, ...(harness ? { harness } : {}), ...(model ? { model } : {}), ...(specialist ? { specialist } : {}), ...(url ? { url } : {}) };
    }
    if (product === 'codes') {
        if (a.harness && a.harness !== 'auto' && !HARNESSES.includes(a.harness)) throw fail(422, 'groups.harness_invalid', `A harness is auto or one of ${HARNESSES.join(', ')}`);
        if (a.harness && a.harness !== 'auto') config.harness = a.harness;
        if (typeof a.model === 'string' && a.model.trim()) config.model = clip(a.model, 120);
    }
    return { handle, name, config };
}

// A Codes builder in a room with reviewers works on a computer with OpenVibe Link (the person's, or a cloud desk), so a
// page it built can be shown as a preview (Link v0.80, `openvibe-link preview`, plan §AD.25): owner-only, and the room's
// check opens it as the person (room-check.js). Without it a builder hands over a dev server's localhost or nothing.
const PREVIEW_HINT = 'To show a page or app you built: build it, then run `openvibe-link preview <the built folder> --detach` (dist, build or out) on the computer you work on. It prints an https address that only this room\'s person, and the room\'s check, can open, for two hours: put it in your hand-over. A localhost address or a dev server is not one. If that Link has no preview command yet, hand over the files.';

/** The words for one agent's turn: the transcript, and for a Codes builder with reviewers, how to show a page. */
function turnWords(words, member, team) {
    let c = {};
    try { c = typeof member.config === 'string' ? JSON.parse(member.config || '{}') : member.config || {}; } catch { c = {}; }
    if (c.product !== 'codes' || !(team || []).some((m) => m.reviewer && m.id !== member.member_id)) return words;
    return `${words}\n${PREVIEW_HINT}`;
}

/** What the Frame's run start reads for this agent (agents.run-start@1 as server/frame/runs.js takes it). */
function startBody(config, text) {
    if (config.product === 'codes') {
        return { text, kind: 'code', agent: config.harness || 'codes', ...(config.model ? { model: { id: config.model } } : {}) };
    }
    if (config.agent) return { text, kind: 'task', agent: config.agent };
    return { text, kind: 'task', agent: 'actor', ...(config.engine ? { engine: config.engine } : {}) };
}

function createFrameGroups({ db, frameUrl, personOf, fetchImpl = globalThis.fetch, now = Date.now, log = console, pollMs = 3000, turnTimeoutMs = 10 * 60 * 1000, check = null } = {}) {
    const iso = () => new Date(now()).toISOString();
    const queues = new Map();   // group id → [{ seq, subject, auth }] waiting to be answered, and whether a round runs

    async function frame(path, { auth, method = 'GET', body } = {}) {
        const r = await fetchImpl(`${frameUrl}${path}`, {
            method, headers: { Accept: 'application/json', Authorization: auth, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(method === 'POST' && path === '/runs' ? { 'Idempotency-Key': crypto.randomUUID() } : {}) },
            body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw fail(r.status, j.code || 'groups.frame_failed', j.error || j.message || `the run answered ${r.status}`);
        return j;
    }

    const members = (id) => db.prepare('SELECT member_id, kind, name, handle, subject, config, added_at FROM frame_group_members WHERE group_id = ? ORDER BY kind DESC, added_at, member_id').all(id);
    const configOf = (row) => (typeof row.config === 'string' ? JSON.parse(row.config || '{}') : row.config || {});
    const sdkMembers = (rows) => rows.map((r) => { const c = configOf(r); return { id: r.member_id, kind: r.kind, name: r.name, handle: r.handle, lead: !!c.lead, coder: !!c.coder, reviewer: !!c.reviewer }; });
    const filesOf = (row) => { const f = typeof row.files === 'string' ? JSON.parse(row.files || '[]') : row.files; return Array.isArray(f) ? f : []; };
    async function messages(id, after = 0, limit = 500) {
        return db.prepare(`SELECT seq, from_id, from_kind, by_subject, text, files, state, why, run_ref, usd, created_at, updated_at FROM frame_group_messages
            WHERE group_id = ? AND seq > ? ORDER BY seq LIMIT ?`).all(id, Number(after) || 0, limit);
    }
    const historyOf = (rows) => rows.filter((m) => m.state !== 'working').map((m) => ({ from: m.from_id, fromKind: m.from_kind, text: m.text, usd: m.usd == null ? 0 : Number(m.usd) }));
    const spaceOf = (rows) => {
        const seen = new Set();
        const out = [];
        for (const m of rows) for (const f of filesOf(m)) {
            const key = f.id || f.url; if (!key || seen.has(key)) continue; seen.add(key);
            out.push({ id: f.id || null, name: clip(f.name, 200) || 'A file', url: httpsUrl(f.url), type: clip(f.type || f.mime, 100) || null, size: Number(f.size) || null, from: m.from_id, seq: m.seq });
        }
        return out;
    };
    async function insertMessage(id, m) {
        const at = iso();
        for (let i = 0; i < 3; i++) {
            try {
                const row = await db.prepare(`INSERT INTO frame_group_messages (group_id, seq, from_id, from_kind, by_subject, text, files, state, why, run_ref, usd, created_at, updated_at)
                    VALUES (?, COALESCE((SELECT max(seq) FROM frame_group_messages WHERE group_id = ?), 0) + 1, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?, ?) RETURNING seq`)
                    .get(id, id, m.from, m.kind, m.subject || null, m.text || '', JSON.stringify(m.files || []), m.state || 'done', m.why || null, m.run || null, m.usd == null ? null : m.usd, at, at);
                await db.prepare('UPDATE frame_groups SET updated_at = ? WHERE id = ?').run(at, id);
                return Number(row.seq);
            } catch (err) { if (!/duplicate key|unique/i.test(String(err && err.message)) || i === 2) throw err; }
        }
        return null;
    }
    const updateMessage = (id, seq, m) => db.prepare(`UPDATE frame_group_messages SET text = ?, files = ?::jsonb, state = ?, run_ref = ?, usd = ?, updated_at = ? WHERE group_id = ? AND seq = ?`)
        .run(m.text || '', JSON.stringify(m.files || []), m.state, m.run || null, m.usd == null ? null : m.usd, iso(), id, seq);

    /** One agent turn on the person's own account: start or continue its run, wait for its answer. */
    async function turn(id, member, subject, auth, words) {
        const config = configOf(member);
        if (config.agent && config.owner !== subject) throw fail(403, 'groups.own_agent', 'this is someone\'s own agent: it answers only the person who added it');
        const known = await db.prepare('SELECT run_ref, seen_seq FROM frame_group_runs WHERE group_id = ? AND member_id = ? AND subject = ?').get(id, member.member_id, subject);
        let ref = known && known.run_ref;
        let seen = known ? Number(known.seen_seq) || 0 : 0;
        if (ref) await frame(`/runs/${encodeURIComponent(ref)}/messages`, { auth, method: 'POST', body: { text: words } });
        else {
            const run = await frame('/runs', { auth, method: 'POST', body: startBody(config, words) });
            ref = run.ref || run.id;
            if (!ref) throw fail(502, 'groups.no_run', 'The agent did not start');
            await db.prepare(`INSERT INTO frame_group_runs (group_id, member_id, subject, run_ref, seen_seq) VALUES (?, ?, ?, ?, 0)
                ON CONFLICT (group_id, member_id, subject) DO UPDATE SET run_ref = EXCLUDED.run_ref, seen_seq = 0`).run(id, member.member_id, subject, ref);
            seen = 0;
        }
        const end = now() + turnTimeoutMs;
        let answer = null;
        let run = null;
        // The answer is an agent step after what it was just told, once the run is no longer working.
        while (now() < end) {
            await new Promise((r) => setTimeout(r, pollMs));
            run = await frame(`/runs/${encodeURIComponent(ref)}`, { auth }).catch(() => null);
            const page = await frame(`/runs/${encodeURIComponent(ref)}/steps?after=${seen}&limit=200`, { auth }).catch(() => ({ steps: [] }));
            const steps = Array.isArray(page.steps) ? page.steps : [];
            const lastPerson = steps.reduce((n, s) => (s && s.from === 'person' ? Math.max(n, Number(s.seq) || 0) : n), 0);
            const agentSteps = steps.filter((s) => s && s.from !== 'person' && (Number(s.seq) || 0) > lastPerson && clip(s.text, 1));
            const working = run && ['running', 'planning'].includes(run.status);
            if (agentSteps.length && !working) {
                const said = agentSteps.filter((s) => s.kind === 'message');
                const pick = (said.length ? said : agentSteps).slice(-1)[0];
                const files = agentSteps.flatMap((s) => (Array.isArray(s.files) ? s.files : Array.isArray(s.attachments) ? s.attachments : []))
                    .filter((f) => f && (f.id || httpsUrl(f.url))).slice(0, 20);
                answer = { text: clip(pick.text, 16000), files };
                seen = Math.max(seen, ...steps.map((s) => Number(s && s.seq) || 0));
                break;
            }
            if (run && ['failed', 'stopped'].includes(run.status)) throw fail(502, 'groups.run_failed', clip(run.error && (run.error.message || run.error.detail), 400) || `The run ${run.status}`);
        }
        await db.prepare('UPDATE frame_group_runs SET seen_seq = ? WHERE group_id = ? AND member_id = ? AND subject = ?').run(seen, id, member.member_id, subject);
        if (!answer) throw fail(504, 'groups.turn_timeout', 'No answer in time; the agent may still be working in its own run');
        const usd = run && run.cost && Number.isFinite(Number(run.cost.usd)) ? Number(run.cost.usd) : null;
        return { ...answer, run: ref, usd };
    }

    /** Answer the queued person messages of a group, one round at a time. */
    async function work(id) {
        const q = queues.get(id);
        if (!q || q.running) return;
        q.running = true;
        try {
            while (q.items.length) {
                const { seq, subject, auth } = q.items.shift();
                const rows = await members(id);
                const team = sdkMembers(rows);
                // The check before the reviewers (plan §AD.25, server/frame/room-check.js) is free: on wherever Design is.
                const policy = { gate: !!(check && check.enabled), ...((await db.prepare('SELECT policy FROM frame_groups WHERE id = ?').get(id) || {}).policy || {}) };
                const all = await messages(id);
                const start = all.find((m) => Number(m.seq) === Number(seq));
                if (!start) continue;
                const first = group.next({ message: { from: start.from_id, fromKind: 'person', text: start.text }, members: team, history: historyOf(all), policy });
                const queue = first.speakers.map((s) => ({ id: s, why: first.why, parallel: !!first.parallel }));
                while (queue.length) {
                    const hist = historyOf(await messages(id));
                    if (!group.limits({ history: hist, members: team, policy }).ok) break;
                    // A review's speakers answer at once (agents/group `parallel`): every queued speaker marked so, in
                    // order; anyone else answers alone. Their messages are written one by one (each takes the next
                    // seq), then their turns run together.
                    let n = 1;
                    if (queue[0].parallel) { n = queue.findIndex((x) => !x.parallel); if (n < 0) n = queue.length; }
                    const batch = [];
                    for (const { id: speaker, why } of queue.splice(0, n)) {
                        const member = rows.find((r) => r.member_id === speaker && r.kind === 'agent');
                        if (!member) continue;
                        batch.push({ speaker, member, mseq: await insertMessage(id, { from: speaker, kind: 'agent', subject, state: 'working', why }) });
                    }
                    const files = spaceOf(await messages(id));
                    const outs = await Promise.all(batch.map(async ({ speaker, member, mseq }) => {
                        const words = turnWords(group.transcript({ history: hist, member: speaker, members: team, files }), member, team);
                        try {
                            const out = await turn(id, member, subject, auth, words);
                            await updateMessage(id, mseq, { text: out.text, files: out.files, state: 'done', run: out.run, usd: out.usd });
                            return { speaker, out };
                        } catch (err) {
                            await updateMessage(id, mseq, { text: `Could not answer: ${clip(err && err.message, 300)}`, state: 'failed' });
                            if (log.warn) log.warn(`[groups] ${id} ${speaker}: ${err && (err.code || err.message)}`);
                            return null;
                        }
                    }));
                    const after = historyOf(await messages(id));
                    for (const done of outs) {
                        if (!done) continue;
                        let nx = group.next({ message: { from: done.speaker, fromKind: 'agent', text: done.out.text }, members: team, history: after, policy });
                        if (nx.gate) nx = await checkFirst(id, subject, done.out.text, nx, team, policy);
                        for (const s of nx.speakers) if (!queue.some((x) => x.id === s)) queue.push({ id: s, why: nx.why, parallel: !!nx.parallel });
                    }
                }
            }
        } finally { q.running = false; if (q.items.length) setImmediate(() => work(id)); else queues.delete(id); }
    }

    /**
     * A builder said DONE in a room with reviewers: the free check runs first (openvibe-sdk/agents/group 0.185.0). Its
     * message is posted from `gate` when it found something to say; with nothing to check (no page link, Design not
     * there) it passes without a message and the reviewers look.
     */
    async function checkFirst(id, subject, doneText, nx, team, policy) {
        let said = null;
        try { said = check ? await check.run(doneText, { mayBlock: nx.mayBlock !== false, owner: subject }) : null; } catch (err) {
            if (log.warn) log.warn(`[groups] ${id} check: ${err && (err.code || err.message)}`);
        }
        if (said && said.text) await insertMessage(id, { from: 'gate', kind: 'gate', subject, text: said.text, state: 'done', why: said.blocked ? 'the check found faults' : 'the check before the reviewers' });
        const text = said && said.text ? said.text : '';
        return group.next({ message: { from: 'gate', fromKind: 'gate', text }, members: team, history: historyOf(await messages(id)), policy });
    }

    const staffOf = async (subject) => {
        const u = await db.prepare('SELECT role FROM users WHERE subject_id = ?').get(subject);
        return !!(u && u.role === 'admin');
    };
    async function listFor(subject, limit = 100) {
        return db.prepare(`SELECT g.id, g.title, g.created_at, g.updated_at, (SELECT COUNT(*)::int FROM frame_group_members x WHERE x.group_id = g.id) AS members,
                (SELECT text FROM frame_group_messages t WHERE t.group_id = g.id ORDER BY seq DESC LIMIT 1) AS last_text
            FROM frame_groups g JOIN frame_group_members m ON m.group_id = g.id AND m.kind = 'person' AND m.subject = ? ORDER BY g.updated_at DESC LIMIT ?`).all(subject, limit);
    }
    async function create(subject, person, b = {}) {
        if (!(await staffOf(subject))) throw fail(403, 'groups.staff_only', 'Admins and the owner start groups for now');
        const title = clip(b.title || (b.text ? String(b.text).split('\n')[0] : ''), 120) || 'A group';
        const id = `grp_${crypto.randomBytes(10).toString('hex')}`;
        const at = iso();
        const me = person || await db.prepare('SELECT username, display_name FROM users WHERE subject_id = ?').get(subject) || {};
        await db.prepare('INSERT INTO frame_groups (id, title, created_by, policy, created_at, updated_at) VALUES (?, ?, ?, ?::jsonb, ?, ?)').run(id, title, subject, JSON.stringify({}), at, at);
        await db.prepare(`INSERT INTO frame_group_members (group_id, member_id, kind, name, handle, subject, config, added_by, added_at) VALUES (?, ?, 'person', ?, ?, ?, '{}'::jsonb, ?, ?)`)
            .run(id, `usr:${String(me.username || subject).toLowerCase()}`, clip(me.display_name || me.username, 60) || 'You', String(me.username || 'you').toLowerCase().slice(0, 24), subject, subject, at);
        const agents = Array.isArray(b.agents) && b.agents.length ? b.agents : PRESETS.filter((p) => p.default);
        for (const a of agents.slice(0, MAX_AGENTS)) await addAgent(id, a, subject);
        for (const u of (Array.isArray(b.people) ? b.people : []).slice(0, MAX_PEOPLE)) await addPerson(id, u, subject);
        return { id, title };
    }
    async function say(id, subject, auth, b = {}) {
        const g = await mine(id, subject);
        const text = clip(b.text, 16000);
        const files = (Array.isArray(b.files) ? b.files : Array.isArray(b.attachments) ? b.attachments : [])
            .filter((f) => f && typeof f === 'object' && /^med_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(f.id || ''))).slice(0, 10)
            .map((f) => ({ id: f.id, name: clip(f.name, 200), url: httpsUrl(f.url), type: clip(f.type || f.mime, 100) || null, size: Number(f.size) || null }));
        if (!text && !files.length) throw fail(422, 'groups.empty', 'Say something or attach a file');
        const me = (await members(g.id)).find((r) => r.kind === 'person' && r.subject === subject);
        const seq = await insertMessage(g.id, { from: me ? me.member_id : `usr:${subject}`, kind: 'person', subject, text, files });
        if (auth) {
            const q = queues.get(g.id) || { items: [], running: false };
            q.items.push({ seq, subject, auth });
            queues.set(g.id, q);
            setImmediate(() => work(g.id).catch((err) => log.error && log.error(`[groups] ${g.id}: ${err && err.message}`)));
        }
        return { seq, text, files, from: me ? me.member_id : null };
    }
    async function view(id, subject, after = 0) {
        const g = await mine(id, subject);
        const all = await messages(g.id);
        const q = queues.get(g.id);
        return {
            group: { id: g.id, title: g.title, created_at: g.created_at, updated_at: g.updated_at },
            members: (await members(g.id)).map(memberOut),
            messages: all.filter((m) => Number(m.seq) > after || m.state === 'working').map((m) => messageOut(m, subject)),
            space: spaceOf(all),
            busy: !!(q && (q.running || q.items.length)) || all.some((m) => m.state === 'working'),
        };
    }

    async function who(req) {
        const person = await personOf(req);
        if (!person || !person.subject_id) throw fail(401, 'auth.required', 'Sign in');
        const header = String(req.headers.authorization || '');
        let auth = BEARER.test(header) ? header : '';
        if (!auth) { try { const t = require('../auth/session').sessionToken(req); if (t) auth = `Bearer ${t}`; } catch { /* no session token */ } }
        return { person, subject: person.subject_id, auth, staff: person.role === 'admin' };
    }
    async function mine(id, subject) {
        if (!ID.test(String(id))) throw fail(404, 'groups.not_found', 'No such group');
        const g = await db.prepare('SELECT id, title, created_by, policy, created_at, updated_at FROM frame_groups WHERE id = ?').get(id);
        const ok = g && await db.prepare("SELECT 1 AS ok FROM frame_group_members WHERE group_id = ? AND kind = 'person' AND subject = ?").get(id, subject);
        if (!ok) throw fail(404, 'groups.not_found', 'No such group, or you are not in it');
        return g;
    }
    // Someone's own agent says whose it is by name (the person who added it, while they are in the group).
    const memberOut = (r, _i, all) => { const c = configOf(r); return { id: r.member_id, kind: r.kind, name: r.name, handle: r.handle, ...(r.kind === 'agent' ? { product: c.product, engine: c.engine || null, harness: c.harness || null, lead: !!c.lead, coder: !!c.coder, reviewer: !!c.reviewer, ...(c.agent ? { personal: true, owner_name: ((all || []).find((x) => x.kind === 'person' && x.subject === c.owner) || {}).name || null } : {}) } : {}) }; };
    const messageOut = (m, subject) => ({ seq: Number(m.seq), from: m.from_id, kind: m.from_kind, ...(m.from_kind === 'person' ? { you: m.by_subject === subject } : {}), text: m.text, files: filesOf(m), state: m.state, why: m.why || null, usd: m.usd == null ? null : Number(m.usd), at: m.created_at });
    async function addPerson(id, username, by) {
        if (!USERNAME.test(String(username || ''))) throw fail(422, 'groups.username_invalid', 'Name a person by their username');
        const u = await db.prepare('SELECT subject_id, username, display_name FROM users WHERE lower(username) = lower(?) AND subject_id IS NOT NULL AND COALESCE(is_banned, 0) = 0').get(String(username));
        if (!u) throw fail(404, 'groups.person_not_found', `Nobody is called ${clip(username, 40)} on OpenVibe`);
        const n = await db.prepare("SELECT COUNT(*)::int AS n FROM frame_group_members WHERE group_id = ? AND kind = 'person'").get(id);
        if (n && n.n >= MAX_PEOPLE) throw fail(422, 'groups.full', `A group has at most ${MAX_PEOPLE} people`);
        await db.prepare(`INSERT INTO frame_group_members (group_id, member_id, kind, name, handle, subject, config, added_by, added_at) VALUES (?, ?, 'person', ?, ?, ?, '{}'::jsonb, ?, ?)
            ON CONFLICT (group_id, member_id) DO NOTHING`).run(id, `usr:${u.username.toLowerCase()}`, clip(u.display_name || u.username, 60), u.username.toLowerCase().slice(0, 24), u.subject_id, by, iso());
    }
    async function addAgent(id, a, by, auth) {
        const { handle, name, config } = agentOf(a);
        if (config.agent) {
            // Yours only: the agent's sheet answers its owner (Actor checks), so a stranger's id is refused here.
            const sheet = await frame(`/agents/${encodeURIComponent(config.agent)}/sheet`, { auth }).catch(() => null);
            if (!sheet) throw fail(403, 'groups.agent_not_yours', 'Only your own agents join a group');
            config.owner = by;
        }
        const rows = await members(id);
        if (rows.filter((r) => r.kind === 'agent').length >= MAX_AGENTS) throw fail(422, 'groups.too_many_agents', `A group has at most ${MAX_AGENTS} agents`);
        if (rows.some((r) => r.handle === handle)) throw fail(409, 'groups.handle_taken', `@${handle} is already in this group`);
        await db.prepare(`INSERT INTO frame_group_members (group_id, member_id, kind, name, handle, subject, config, added_by, added_at) VALUES (?, ?, 'agent', ?, ?, NULL, ?::jsonb, ?, ?)`)
            .run(id, `agent:${handle}`, name, handle, JSON.stringify(config), by, iso());
    }

    const router = express.Router();
    const json = express.json({ limit: '64kb' });
    const handle = (fn) => async (req, res) => {
        res.set('Cache-Control', 'private, no-store');
        try { await fn(req, res); } catch (err) {
            const status = Number.isInteger(err && err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
            if (status === 500 && log.error) log.error(`[groups] ${err && err.stack || err}`);
            res.status(status).json({ error: status === 500 ? 'Something went wrong' : err.message, code: err.code || 'groups.error' });
        }
    };
    router.get('/presets', handle(async (req, res) => { await who(req); res.json({ agents: PRESETS, engines: ACTOR_ENGINES, harnesses: HARNESSES, policy: group.POLICY }); }));
    router.get('/', handle(async (req, res) => {
        const { subject, staff } = await who(req);
        const rows = await listFor(subject);
        res.json({ groups: rows.map((g) => ({ id: g.id, title: g.title, updated_at: g.updated_at, members: g.members })), can_start: staff });
    }));
    router.post('/', json, handle(async (req, res) => {
        const { person, subject } = await who(req);
        res.status(201).json(await create(subject, person, req.body || {}));
    }));
    router.get('/:id', handle(async (req, res) => {
        const { subject } = await who(req);
        res.json(await view(req.params.id, subject, Number(req.query.after) || 0));
    }));
    router.post('/:id/messages', json, handle(async (req, res) => {
        const { subject, auth } = await who(req);
        const out = await say(req.params.id, subject, auth, req.body || {});
        res.status(202).json({ seq: out.seq, answering: !!auth });
    }));
    router.post('/:id/members', json, handle(async (req, res) => {
        const { subject, staff } = await who(req);
        const g = await mine(req.params.id, subject);
        if (!staff) throw fail(403, 'groups.staff_only', 'Admins and the owner add members for now');
        const b = req.body || {};
        if (b.username) await addPerson(g.id, b.username, subject);
        else if (b.agent) await addAgent(g.id, b.agent, subject, req.get('authorization'));
        else throw fail(422, 'groups.member_invalid', 'Add a person { username } or an agent { agent }');
        res.status(201).json({ members: (await members(g.id)).map(memberOut) });
    }));
    router.delete('/:id/members/:mid', handle(async (req, res) => {
        const { subject, staff } = await who(req);
        const g = await mine(req.params.id, subject);
        if (!staff) throw fail(403, 'groups.staff_only', 'Admins and the owner remove members for now');
        const rows = await members(g.id);
        const target = rows.find((r) => r.member_id === String(req.params.mid));
        if (!target) throw fail(404, 'groups.member_not_found', 'No such member');
        if (target.kind === 'person' && rows.filter((r) => r.kind === 'person').length <= 1) throw fail(422, 'groups.last_person', 'A group keeps at least one person');
        await db.prepare('DELETE FROM frame_group_members WHERE group_id = ? AND member_id = ?').run(g.id, target.member_id);
        await db.prepare('DELETE FROM frame_group_runs WHERE group_id = ? AND member_id = ?').run(g.id, target.member_id);
        res.json({ members: (await members(g.id)).map(memberOut) });
    }));

    // ── A group as a run (server/frame/runs.js `extra`): the one list, the thread as steps, say the same way ──
    const authorOf = (rows, id) => { const r = rows.find((x) => x.member_id === id); return r ? { id: r.member_id, kind: r.kind, name: r.name, handle: r.handle } : { id, kind: 'person', name: id }; };
    const asRun = (g, owner, extra = {}) => ({
        id: g.id, ref: `group:${g.id}`, kind: 'group', title: g.title, owner,
        agent: { id: 'group', name: g.title, product: 'group', glyph: 'members' },
        status: extra.busy ? 'running' : 'waiting', ...(extra.busy ? {} : { waiting: { for: 'message' } }),
        created_at: g.created_at, updated_at: g.updated_at,
        ...(g.last_text ? { preview: { text: clip(g.last_text, 200) } } : {}),
        ...(extra.members ? { members: extra.members } : {}),
    });
    const adapter = {
        product: 'group',
        kinds: ['group'],
        async list(auth, owner, { limit = 30 } = {}) {
            return (await listFor(owner.id, limit)).map((g) => asRun(g, owner));
        },
        /**
         * The runs an agent works a group's turns in, on this person's account (frame_group_runs): they are the group's,
         * so the one runs list leaves them out and the group's thread links each answer to its run (the owner, 11-21:
         * "it spawns sub-agents, but … it's not indicated in the main chat … confusing"; the menu listed "You are Design
         * in a group conversation…" as a session of its own).
         */
        async hidden(owner) {
            const rows = await db.prepare('SELECT run_ref FROM frame_group_runs WHERE subject = ?').all(owner.id);
            return new Set(rows.map((r) => String(r.run_ref || '')).filter(Boolean));
        },
        async get(auth, owner, id) {
            const v = await view(id, owner.id, Number.MAX_SAFE_INTEGER);
            return asRun(v.group, owner, { busy: v.busy, members: v.members });
        },
        async steps(auth, owner, id, { after = 0, limit = 200 } = {}) {
            await mine(id, owner.id);
            const rows = await members(id);
            const all = (await messages(id, after, limit)).map((m) => ({
                run_id: id, seq: Number(m.seq), kind: 'message', from: m.from_kind === 'person' ? 'person' : 'agent',
                author: m.from_kind === 'gate' ? { id: 'gate', kind: 'check', name: 'The check', handle: 'check' }
                    : { ...authorOf(rows, m.from_id), ...(m.from_kind === 'person' ? { you: m.by_subject === owner.id } : {}) },
                text: m.text || null, files: filesOf(m), attachments: filesOf(m),
                status: m.state === 'working' ? 'running' : m.state === 'failed' ? 'failed' : 'done', started_at: m.created_at,
                // The agent's own run for this answer (its steps, tools and model): the thread links to it.
                ...(m.from_kind === 'agent' && m.run_ref && /^[a-z][a-z0-9-]{0,30}:[A-Za-z0-9_:.-]{1,120}$/.test(String(m.run_ref)) ? { run_ref: String(m.run_ref) } : {}),
                ...(m.why ? { why: m.why } : {}), ...(m.usd != null ? { cost: { usd: Number(m.usd) } } : {}),
            }));
            return { steps: all, next: null };
        },
        async say(auth, owner, id, msg) {
            const out = await say(id, owner.id, auth, { text: msg.text, attachments: msg.attachments });
            return { run_id: id, seq: out.seq, kind: 'message', from: 'person', status: 'done', text: out.text, files: out.files, started_at: iso() };
        },
        async start(auth, owner, body) {
            const made = await create(owner.id, null, { title: body.title, text: body.text, agents: body.agents, people: body.people });
            if (body.text) await say(made.id, owner.id, auth, { text: body.text, attachments: body.attachments });
            const v = await view(made.id, owner.id, Number.MAX_SAFE_INTEGER);
            return asRun(v.group, owner, { busy: v.busy, members: v.members });
        },
        async stop(auth, owner, id) { const v = await view(id, owner.id, Number.MAX_SAFE_INTEGER); queues.delete(id); return asRun(v.group, owner, { busy: false }); },
    };

    return { router, adapter, work, turn, agentOf, startBody, PRESETS };
}

module.exports = { createFrameGroups, agentOf, startBody, turnWords, PREVIEW_HINT, PRESETS, HARNESSES, ACTOR_ENGINES };
