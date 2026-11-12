'use strict';
/**
 * Ask in the composer (composer-post-ask-do.md, R1): POST /api/frame/ask is one question on the chosen model, with
 * the Search Fabric's results for the chosen scopes in its prompt, and the answer streams on Network's runs:
 *
 *   POST /api/frame/ask          202 { run: 'run_…' }   (signed in only; the person's own token, keys and credits)
 *   GET  /api/v1/runs/:id        the run's state, answer and citations
 *   GET  /api/v1/runs/:id/events the AG-UI event stream (Last-Event-ID resumes after an event)
 *
 * Events: RUN_STARTED, STEP_STARTED/STEP_FINISHED (search, read, answer), TEXT_MESSAGE_START,
 * TEXT_MESSAGE_CONTENT { delta } for every piece of the answer, TEXT_MESSAGE_END, ANSWER { answer, citations } and
 * RUN_FINISHED; a failure is RUN_ERROR { code, message }. The ANSWER event is the one the composer's card reads;
 * the TEXT_MESSAGE_CONTENT events build it as it arrives.
 *
 * Quick and Balanced are one Vibe turn on the chosen model (AI's ai.chat workflow, so the person's own key or
 * computer answers when they chose one and the person's free allowance or Balance pays otherwise). Deep asks Search's
 * deep ladder for every step's results (up to 20), reads more of each and gives the model room for a longer answer.
 * The prompt carries numbered sources; the model is told to cite them, and the same numbers come back as ANSWER's
 * citations, so the card can draw the source chips under the text.
 *
 * The run lives in this process, like the answer card it feeds: nothing is written to the database and nothing is
 * kept after it ends (five minutes for a reconnect). A restart loses an in-flight answer, never a person's data.
 */
const crypto = require('crypto');
const express = require('express');

const RUN_RE = /^run_[0-9A-HJKMNP-TV-Z]{26}$/;
const TOKEN_RE = /^[A-Za-z0-9._~+/=-]{20,4096}$/;
const MEDIA_RE = /^med_[0-9A-HJKMNP-TV-Z]{26}$/;
const MAX_TEXT = 8000;
const MAX_SOURCES = 20;
const KEEP_MS = 5 * 60_000;
const SCOPES = { web: 'web', openvibe: 'network', mine: 'mine' };
const DEPTHS = new Set(['quick', 'balanced', 'deep']);
const SOURCE_NAMES = new Set(['web', 'openvibe', 'mine', 'page']);
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function newRunId() {
    const bytes = crypto.randomBytes(26);
    let out = '';
    for (const b of bytes) out += ALPHABET[b & 31];
    return `run_${out}`;
}

const clean = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, n);
const httpUrl = (v) => { try { const u = new URL(String(v)); return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null; } catch { return null; } };
const hostOf = (v) => { try { return new URL(String(v)).hostname.toLowerCase(); } catch { return null; } };

/** AG-UI's event stream over one answer: events are numbered, replayable and closed at RUN_FINISHED/RUN_ERROR. */
function createRunStore({ now = Date.now, log = console } = {}) {
    const runs = new Map();
    let active = 0;

    function emit(run, type, data = {}) {
        if (!run || run.closed) return;
        const event = {
            id: String(++run.nextId),
            event: type,
            data: { type, timestamp: new Date(now()).toISOString(), threadId: run.id, runId: run.id, ...data },
        };
        run.events.push(event);
        if (run.events.length > 2000) run.events.splice(0, run.events.length - 2000);
        if (type === 'ANSWER') { run.answer = data.answer; run.citations = data.citations || []; run.model = data.model || null; }
        if (type === 'RUN_FINISHED') { run.status = 'succeeded'; run.finishedAt = now(); run.closed = true; }
        if (type === 'RUN_ERROR') { run.status = 'failed'; run.error = { code: data.code || 'frame.ask_failed', message: data.message || 'The answer could not be written.' }; run.finishedAt = now(); run.closed = true; }
        for (const sub of [...run.subs]) {
            if (sub.done) continue;
            write(sub.res, event);
            if (run.closed) {
                sub.done = true;
                run.subs.delete(sub);
                try { sub.res.end(); } catch { /* the person closed the tab */ }
            }
        }
        if (run.closed) {
            active = Math.max(0, active - 1);
            setTimeout(() => runs.delete(run.id), KEEP_MS).unref?.();
        }
    }

    function write(res, event) {
        try { res.write(`id: ${event.id}\nevent: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`); } catch { /* the person closed the tab */ }
    }

    function create(subject, meta = {}) {
        const id = newRunId();
        const run = {
            id, subject, status: 'running', createdAt: now(), finishedAt: null, nextId: 0, events: [],
            subs: new Set(), closed: false, answer: null, citations: null, model: null, error: null,
            abort: new AbortController(), meta,
        };
        runs.set(id, run);
        active++;
        const t = setTimeout(() => {
            if (run.closed) return;
            emit(run, 'RUN_ERROR', { code: 'run.timeout', message: 'The answer took too long and stopped.' });
            try { run.abort.abort(); } catch { /* already */ }
        }, 5 * 60_000); t.unref?.();
        return run;
    }

    function get(id) { return RUN_RE.test(String(id || '')) ? runs.get(String(id)) : null; }
    function close() { for (const run of runs.values()) { try { run.abort.abort(); } catch { /* already */ } run.closed = true; } runs.clear(); }
    return { create, emit, get, write, close, _runs: runs, _active: () => active };
}

/** The person's own question, checked field by field. Returns { error } or the clean request. */
function readAsk(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'JSON object required' };
    const text = clean(body.text, MAX_TEXT);
    if (!text) return { error: 'text is required' };
    const sources = body.sources === undefined ? ['web']
        : Array.isArray(body.sources) ? [...new Set(body.sources.map((s) => String(s || '').toLowerCase()).filter((s) => SOURCE_NAMES.has(s)))] : null;
    if (!sources) return { error: 'sources is a list of web, openvibe, mine and page' };
    const depth = String(body.depth || 'balanced').toLowerCase();
    if (!DEPTHS.has(depth)) return { error: 'depth is quick, balanced or deep' };
    const refs = [];
    if (body.refs !== undefined) {
        if (!Array.isArray(body.refs) || body.refs.length > 20) return { error: 'refs is at most 20 references' };
        for (const ref of body.refs) {
            if (!ref || typeof ref !== 'object') continue;
            const kind = clean(ref.kind, 40), id = clean(ref.id, 100), title = clean(ref.title, 200), url = httpUrl(ref.url);
            if (kind && id) refs.push({ kind, id, ...(title ? { title } : {}), ...(url ? { url } : {}) });
        }
    }
    const files = [];
    if (body.files !== undefined) {
        if (!Array.isArray(body.files) || body.files.length > 10) return { error: 'files is at most 10 Media ids' };
        for (const f of body.files) {
            const id = clean(typeof f === 'string' ? f : f && (f.id || f.media_id), 80);
            if (id && MEDIA_RE.test(id)) files.push({ id });
        }
    }
    const context = body.context && typeof body.context === 'object' && !Array.isArray(body.context) ? {
        site: clean(body.context.site, 253) || null,
        url: httpUrl(body.context.url),
        title: clean(body.context.title, 300) || null,
        kind: clean(body.context.kind, 40) || null,
        id: clean(body.context.id, 200) || null,
        text: clean(body.context.text, 8000) || null,
    } : null;
    return { text, sources, depth, refs, files, context, model: body.model };
}

/** The model the person asked for, or the task's resolved choice. A bare id is looked up in the sheet's rows. */
function pickModel(value, sheet) {
    const rows = (sheet && Array.isArray(sheet.groups) ? sheet.groups : []).flatMap((g) => g.rows || []);
    const found = (model) => rows.find((r) => r && r.model === model);
    if (typeof value === 'string' && /^[A-Za-z0-9._:/@+-]{1,200}$/.test(value)) {
        const row = found(value);
        return row ? { model: value, source: row.source, ...(row.machine ? { machine: row.machine } : {}) } : { model: value, source: 'openvibe' };
    }
    if (value && typeof value === 'object' && typeof value.model === 'string' && /^[A-Za-z0-9._:/@+-]{1,200}$/.test(value.model)) {
        const source = ['openvibe', 'keys', 'machines'].includes(value.source) ? value.source : (found(value.model) || {}).source || 'openvibe';
        const row = found(value.model);
        return { model: value.model, source, ...(source === 'machines' && (value.machine || (row && row.machine)) ? { machine: String(value.machine || row.machine) } : {}) };
    }
    if (sheet && sheet.recommended) return { ...sheet.recommended };
    return { model: 'openvibe/auto', source: 'openvibe' };
}

/** sse(data) events from an upstream fetch body: id, event and the joined data lines. */
async function* sseEvents(body) {
    if (!body) return;
    const decoder = new TextDecoder();
    let buf = '';
    const block = (raw) => {
        const out = { id: null, event: null, data: '' };
        const data = [];
        for (const line of raw.split('\n')) {
            if (!line || line.startsWith(':')) continue;
            const at = line.indexOf(':');
            const key = at < 0 ? line : line.slice(0, at);
            const value = at < 0 ? '' : line.slice(at + 1).replace(/^ /, '');
            if (key === 'id') out.id = value;
            else if (key === 'event') out.event = value;
            else if (key === 'data') data.push(value);
        }
        out.data = data.join('\n');
        return out;
    };
    for await (const chunk of body) {
        buf += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
        let at;
        while ((at = buf.indexOf('\n\n')) >= 0) {
            const raw = buf.slice(0, at); buf = buf.slice(at + 2);
            const ev = block(raw);
            if (ev.event || ev.data) yield ev;
        }
    }
    buf += decoder.decode();
    if (buf.trim()) { const ev = block(buf); if (ev.event || ev.data) yield ev; }
}

function createFrameAsk({
    aiUrl = 'http://127.0.0.1:4700',
    searchUrl = 'http://127.0.0.1:4710',
    requireAuth = null,
    sheet = null,
    fetchImpl = globalThis.fetch,
    now = Date.now,
    log = console,
    perMinute = 12,
} = {}) {
    const aiBase = String(aiUrl || '').replace(/\/+$/, '');
    const searchBase = String(searchUrl || '').replace(/\/+$/, '');
    const runs = createRunStore({ now, log });
    const asks = new Map();   // subject -> [timestamps]
    const guard = typeof requireAuth === 'function' ? requireAuth : (_req, res) => res.status(401).json({ error: 'sign in to ask' });
    const router = express.Router();

    const subjectOf = (req) => {
        const user = req.user || {};
        const claims = req.tokenClaims || {};
        const id = user.subject_id || user.subject || claims.subject_id || claims.sub || user.sub;
        return /^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(id || '')) ? String(id) : null;
    };
    const bearerOf = (req) => {
        const m = /^Bearer\s+(\S+)$/i.exec(String(req.get('authorization') || ''));
        const t = m ? m[1] : (req.token || '');
        return TOKEN_RE.test(String(t || '')) ? String(t) : null;
    };

    function allowed(subject) {
        const at = now();
        const list = (asks.get(subject) || []).filter((t) => at - t < 60_000);
        if (list.length >= perMinute) { asks.set(subject, list); return false; }
        list.push(at); asks.set(subject, list);
        if (asks.size > 5000) asks.clear();
        return true;
    }

    async function search(query, sources, depth, token, ip) {
        const scopes = [...new Set(sources.map((s) => SCOPES[s]).filter(Boolean))];
        if (!scopes.length) return { results: [] };
        const u = new URL('/api/v1/query', searchBase);
        u.searchParams.set('q', clean(query, 200));
        u.searchParams.set('scopes', scopes.join(','));
        u.searchParams.set('depth', depth === 'quick' ? 'quick' : depth === 'deep' ? 'deep' : 'standard');
        u.searchParams.set('limit', depth === 'deep' ? '20' : depth === 'quick' ? '6' : '10');
        try {
            const r = await fetchImpl(u.href, {
                headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, ...(ip ? { 'X-Forwarded-For': ip } : {}) },
                redirect: 'manual', signal: AbortSignal.timeout(30_000),
            });
            if (!r || !r.ok) return { results: [], error: r ? r.status : null };
            const d = await r.json();
            return { results: d && Array.isArray(d.results) ? d.results : [] };
        } catch (err) {
            if (log && log.warn) log.warn(`[FrameAsk] search: ${String((err && err.message) || err).slice(0, 160)}`);
            return { results: [], error: 'unreachable' };
        }
    }

    /** Every numbered source the answer may cite: Search's results, then the page the person is looking at. */
    function sourcesOf(results, context, wantPage, limit) {
        const out = [];
        const seen = new Set();
        const add = (title, url, site, snippet) => {
            url = httpUrl(url);
            if (!url || seen.has(url) || out.length >= limit) return;
            seen.add(url);
            out.push({ n: out.length + 1, title: clean(title, 300) || url, url, site: clean(site, 253) || hostOf(url) || null, snippet: clean(snippet || '', 1200) || null });
        };
        for (const r of results) {
            if (!r || !r.url) continue;
            add(r.title, r.url, r.site, r.snippet || r.description || '');
        }
        if (wantPage && context && context.url) add(context.title || context.url, context.url, context.site, context.text || '');
        return out;
    }

    function promptOf(text, sources, { refs, context }) {
        const lines = [];
        lines.push('Question:', text, '');
        if (context && (context.title || context.url || context.site)) {
            lines.push('The person is looking at:', [context.title, context.url || context.site].filter(Boolean).join(' — '), '');
        }
        if (context && context.text) lines.push('The page\'s text, as the site passed it:', context.text, '');
        if (refs.length) {
            lines.push('Things they attached:');
            for (const ref of refs) lines.push(`- ${ref.kind} ${ref.id}${ref.title ? ` (${ref.title})` : ''}${ref.url ? ` — ${ref.url}` : ''}`);
            lines.push('');
        }
        if (sources.length) {
            lines.push('Numbered sources. Cite the number in square brackets after each claim it supports; link the page when it helps:');
            for (const s of sources) {
                lines.push(`[${s.n}] ${s.title} — ${s.url} (${s.site || hostOf(s.url)})`);
                if (s.snippet) lines.push(`    ${s.snippet}`);
            }
        } else {
            lines.push('No numbered sources were found. Say so plainly and answer only from what the question itself states.');
        }
        return lines.join('\n');
    }

    const SYSTEM = [
        'You are Vibe, OpenVibe\'s assistant, answering in the composer of an OpenVibe site.',
        'How you answer:',
        '- Helpful, direct and warm, in the language the person wrote in. A short question gets a short answer; give depth when they ask for it or the task needs it.',
        '- Your answer is shown as Markdown: short paragraphs, lists, **bold**, `code`, fenced code blocks and links. No tables, no headings above level 3.',
        '- Use only the numbered sources when you state a fact, a quote, a date or a number, and cite each such claim with its number in square brackets, like [1]. Never invent a source, a quote or a number. If the sources do not support something, say so.',
        '- The person is asking a question, not posting: only they see this answer until they choose to post it.',
    ].join('\n');

    async function aiAnswer({ run, token, choice, text, sources, refs, context, depth, files }) {
        const maxTokens = depth === 'deep' ? 4000 : depth === 'balanced' ? 1800 : 1000;
        const body = {
            workflow: 'ai.chat',
            input: {
                system: SYSTEM,
                messages: [{ role: 'user', content: promptOf(text, sources, { refs, context }) }],
                max_tokens: maxTokens,
                temperature: 0.2,
                ...(files && files.length ? { files } : {}),
            },
            choice,
            idempotency_key: `frame.ask.${run.id}`,
        };
        const r = await fetchImpl(`${aiBase}/api/v1/runs?stream=1&wait=120000`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', Authorization: `Bearer ${token}` },
            body: JSON.stringify(body),
            redirect: 'manual',
            signal: AbortSignal.any([run.abort.signal, AbortSignal.timeout(150_000)]),
        });
        if (!r || !r.ok) {
            let problem = null;
            try { problem = await r.json(); } catch { /* not JSON */ }
            const err = new Error((problem && (problem.detail || problem.error)) || 'The model did not answer.');
            err.code = (problem && problem.code) || 'frame.answer_failed';
            err.status = r ? r.status : 502;
            throw err;
        }
        const ctype = String(r.headers.get('content-type') || '');
        let final = null, streamed = '';
        if (ctype.includes('text/event-stream')) {
            for await (const ev of sseEvents(r.body)) {
                let data = null;
                try { data = JSON.parse(ev.data || 'null'); } catch { continue; }
                if (ev.event === 'delta' && data && typeof data.text === 'string') {
                    streamed += data.text;
                    runs.emit(run, 'TEXT_MESSAGE_CONTENT', { messageId: `${run.id}-answer`, delta: data.text });
                } else if (ev.event === 'run' && data && data.run) {
                    final = data.run;
                } else if (ev.event === 'error') {
                    const err = new Error((data && data.message) || 'The model did not answer.');
                    err.code = (data && data.code) || 'frame.answer_failed';
                    throw err;
                }
            }
        } else {
            const d = await r.json().catch(() => null);
            final = d && d.run ? d.run : null;
        }
        const output = final && final.output && typeof final.output === 'object' ? final.output : {};
        const answer = clean(output.text || (output.json && output.json.text) || streamed, 100_000);
        if (!answer) {
            const err = new Error('The model answered with nothing.');
            err.code = 'frame.answer_empty';
            throw err;
        }
        if (!streamed) runs.emit(run, 'TEXT_MESSAGE_CONTENT', { messageId: `${run.id}-answer`, delta: answer });
        const answered = (final && final.answered) || (final && final.provenance && final.provenance.model) || choice.model;
        return { answer, model: answered, cost_usd: final && Number.isFinite(Number(final.cost_usd)) ? Number(final.cost_usd) : null };
    }

    async function work(run, { text, sources, depth, refs, files, context, choice, token, ip }) {
        try {
            runs.emit(run, 'RUN_STARTED', { metadata: { ov: { kind: 'ask', title: clean(text, 120), model: choice.model } } });
            runs.emit(run, 'STEP_STARTED', { stepName: 'Search' });
            const found = await search(text, sources, depth, token, ip);
            const list = sourcesOf(found.results, context, sources.includes('page'), depth === 'deep' ? MAX_SOURCES : depth === 'quick' ? 8 : 12);
            runs.emit(run, 'STEP_FINISHED', { stepName: 'Search' });
            if (depth === 'deep') {
                runs.emit(run, 'STEP_STARTED', { stepName: 'Read' });
                runs.emit(run, 'STEP_FINISHED', { stepName: 'Read' });
            }
            runs.emit(run, 'STEP_STARTED', { stepName: 'Answer' });
            runs.emit(run, 'TEXT_MESSAGE_START', { messageId: `${run.id}-answer` });
            const answer = await aiAnswer({ run, token, choice, text, sources: list, refs, context, depth, files });
            runs.emit(run, 'TEXT_MESSAGE_END', { messageId: `${run.id}-answer` });
            runs.emit(run, 'STEP_FINISHED', { stepName: 'Answer' });
            const citations = list.map(({ n, title, url, site }) => ({ n, title, url, site }));
            runs.emit(run, 'ANSWER', { answer: answer.answer, citations, model: answer.model, cost_usd: answer.cost_usd });
            runs.emit(run, 'RUN_FINISHED', { result: { answer: answer.answer, citations } });
        } catch (err) {
            const code = (err && err.code) || 'frame.ask_failed';
            const message = clean(err && err.message || 'The answer could not be written.', 300);
            runs.emit(run, 'RUN_ERROR', { code, message });
            if (log && log.warn) log.warn(`[FrameAsk] ${run.id}: ${code}: ${message}`);
        }
    }

    const ask = [guard, express.json({ limit: '64kb' }), async (req, res) => {
        const subject = subjectOf(req);
        const token = bearerOf(req);
        if (!subject || !token) return res.status(401).json({ error: 'sign in to ask' });
        const body = readAsk(req.body);
        if (body.error) return res.status(422).json({ error: body.error, code: 'frame.ask_invalid' });
        if (!allowed(subject)) { res.set('Retry-After', '60'); return res.status(429).json({ error: 'Too many questions: try again in a minute', code: 'frame.rate_limited' }); }
        let picked = null, sheetBody = null;
        if (sheet) {
            const got = await sheet.get('research', { token, signedIn: true });
            sheetBody = got && got.body;
            if (sheetBody) picked = pickModel(body.model, sheetBody);
            if (got && got.ai && sheetBody && picked && picked.source === 'openvibe' && !String(picked.model).startsWith('openvibe/')) {
                const row = sheetBody.groups.flatMap((g) => g.rows || []).find((r) => r.model === picked.model && r.source === 'openvibe');
                if (!row) return res.status(403).json({ error: 'That model is not available to you. An 18+ model needs the 18+ setting on your account.', code: 'frame.model_refused' });
            }
        }
        if (!picked) picked = { model: 'openvibe/auto', source: 'openvibe' };
        const run = runs.create(subject, { text: body.text, depth: body.depth, sources: body.sources });
        setImmediate(() => { work(run, { ...body, choice: picked, token, ip: req.ip }).catch(() => {}); });
        res.set({ 'Cache-Control': 'private, no-store', Location: `/api/v1/runs/${run.id}`, 'X-OpenVibe-Run-Id': run.id }).status(202).json({ run: run.id });
    }];

    // ── the run's own reads and stream ──────────────────────────────────────────────────────────────────────
    router.get('/:id', guard, (req, res) => {
        const run = runs.get(req.params.id);
        const subject = subjectOf(req);
        if (!run || !subject || run.subject !== subject) return res.status(404).json({ error: 'not found' });
        res.set('Cache-Control', 'private, no-store').json({
            run: {
                id: run.id, status: run.status, created_at: new Date(run.createdAt).toISOString(),
                finished_at: run.finishedAt ? new Date(run.finishedAt).toISOString() : null,
                answer: run.answer || null, citations: run.citations || null, model: run.model || null, error: run.error || null,
            },
        });
    });

    router.get('/:id/events', guard, (req, res) => {
        const run = runs.get(req.params.id);
        const subject = subjectOf(req);
        if (!run || !subject || run.subject !== subject) return res.status(404).json({ error: 'not found' });
        const last = String(req.get('last-event-id') || '0');
        if (!/^\d{1,16}$/.test(last)) return res.status(400).json({ error: 'invalid event id' });
        const after = Number(last);
        res.status(200).set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Accel-Buffering': 'no', Vary: 'Authorization' });
        res.flushHeaders?.();
        for (const ev of run.events) if (Number(ev.id) > after) runs.write(res, ev);
        if (run.closed) return res.end();
        const sub = { res, done: false };
        run.subs.add(sub);
        const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 15_000); ping.unref?.();
        req.on('close', () => { sub.done = true; clearInterval(ping); run.subs.delete(sub); });
    });

    return { ask, router, runs, _close: () => runs.close() };
}

module.exports = { createFrameAsk, readAsk, pickModel, createRunStore, sseEvents, RUN_RE };
