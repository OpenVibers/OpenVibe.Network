'use strict';
/**
 * The composer's Model sheet (composer-post-ask-do.md, R1): GET /api/frame/choices?task=chat|agent|code|image|research.
 *
 * AI owns which model answers a task (GET /api/v1/choices?task=, its openvibe/keys/machines groups and the resolved
 * choice). Exchange owns what each OpenVibe model is: its maker, its price per million tokens in and out, its measured
 * speed and its page. Report's public leaderboard is where a rating exists. Network joins the three here so a site's
 * composer makes one request, with the person's own token forwarded (AI answers as them; signed out it answers as
 * anyone) and the same CORS and caching rules as GET /api/frame/query:
 *
 *   signed in   private, no-store, asked fresh every time
 *   signed out  public, max-age=60, the whole answer held 60 s
 *
 * The shape is the one the composer's chip renders:
 *
 *   { task, recommended, choice, adult,
 *     groups: [{ id: 'openvibe'|'keys'|'machines'|'plans', title, rows: [...], note? }] }
 *
 * A row is { model, source, machine?, name, maker, price: { in, out, unit } | null, free, speed?, score?, url? }.
 * Signed out only the OpenVibe group is named (AI's keys and machines need a person); signed in all four are, and
 * plans is empty with a note until Codes exposes a person's own signed-in harnesses (today its harness catalogue is
 * public and says nothing about who is signed in).
 */
const { URL } = require('url');

// research picks the model that reads and writes the answer; the searching itself is the Search Fabric's deep
// ladder in POST /api/frame/ask. AI's own research.gather task is a search engine choice, not a chat model.
const AI_TASK = { chat: 'chat.reply', agent: 'chat.reply', code: 'design.icon', image: 'image.picture', research: 'chat.reply' };
const GROUPS = [
    { id: 'openvibe', title: 'OpenVibe' },
    { id: 'keys', title: 'Your keys' },
    { id: 'machines', title: 'Your computers' },
    { id: 'plans', title: 'Your plans' },
];
const TOKEN_RE = /^[A-Za-z0-9._~+/=-]{20,4096}$/;
const MODEL_RE = /^[A-Za-z0-9._:/@+-]{1,200}$/;
const SOURCE = new Set(['openvibe', 'keys', 'machines']);
const DAY = 60_000;

const titleOf = (id) => String(id || '').split('/').filter(Boolean).pop() || String(id || '');
const makerOf = (id, ex) => (ex && (ex.provider_name || ex.provider)) || String(id || '').split('/')[0] || null;
const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 1e6) / 1e6);
const hostOf = (u) => { try { return new URL(String(u)).hostname.toLowerCase(); } catch { return null; } };
const pageUrl = (base, id) => `${String(base || 'https://openvibe.exchange').replace(/\/+$/, '')}/models/${encodeURIComponent(id)}`;

/** One model choice as the composer remembers it: the model, where it comes from, and the machine when it is one. */
function choiceOf(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.model !== 'string' || !MODEL_RE.test(value.model)) return null;
    const source = SOURCE.has(value.source) ? value.source : 'openvibe';
    return { model: value.model, source, ...(source === 'machines' && value.machine ? { machine: String(value.machine) } : {}) };
}

function createFrameChoices({ aiUrl = 'http://127.0.0.1:4700', exchangeUrl = 'http://127.0.0.1:5150', reportUrl = 'http://127.0.0.1:5080', exchangePageBase = 'https://openvibe.exchange', fetchImpl = globalThis.fetch, now = Date.now, log = console } = {}) {
    const aiBase = String(aiUrl || '').replace(/\/+$/, '');
    const exchangeBase = String(exchangeUrl || '').replace(/\/+$/, '');
    const reportBase = String(reportUrl || '').replace(/\/+$/, '');
    let exchangeCache = null, exchangeAt = 0, exchangeInflight = null;
    let reportCache = null, reportAt = 0, reportInflight = null;
    const held = new Map();   // signed-out answer, by task

    async function getJson(url, { token = '', timeoutMs = 6000 } = {}) {
        if (typeof fetchImpl !== 'function') return null;
        const headers = { Accept: 'application/json' };
        if (token && TOKEN_RE.test(token)) headers.Authorization = `Bearer ${token}`;
        try {
            const r = await fetchImpl(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
            if (!r || !r.ok) return null;
            return await r.json();
        } catch (err) {
            if (log && log.warn) log.warn(`[FrameChoices] ${url}: ${String((err && err.message) || err).slice(0, 160)}`);
            return null;
        }
    }

    /** Exchange's directory, held a minute: the same model prices every composer on the network. */
    async function exchangeModels() {
        if (exchangeCache && now() - exchangeAt < DAY) return exchangeCache;
        exchangeInflight = exchangeInflight || getJson(`${exchangeBase}/api/v1/models`).then((d) => (d && Array.isArray(d.models) ? d.models : [])).finally(() => { exchangeInflight = null; });
        const models = await exchangeInflight;
        if (models.length) { exchangeCache = models; exchangeAt = now(); }
        return models;
    }

    /** Report's public leaderboard: a rating (or Bench's benchmark) where one exists, never invented. */
    async function reportRatings() {
        if (reportCache && now() - reportAt < 2 * DAY) return reportCache;
        reportInflight = reportInflight || getJson(`${reportBase}/api/v1/ai/leaderboard?limit=1000`).then((d) => (d && Array.isArray(d.rows) ? d.rows : [])).finally(() => { reportInflight = null; });
        const rows = await reportInflight;
        const map = new Map();
        for (const row of rows) {
            const id = String(row && row.id || '').toLowerCase();
            if (!id) continue;
            const rating = row.rating && Number.isFinite(Number(row.rating.value)) ? Number(row.rating.value) : null;
            const bench = row.benchmark && Number.isFinite(Number(row.benchmark.value)) ? Number(row.benchmark.value) : null;
            map.set(id, { score: rating != null ? rating : bench, adult: row.uncensored === true });
        }
        if (map.size) { reportCache = map; reportAt = now(); }
        return map;
    }

    /** id / provider/model / model tables, preferring a routed, available, priced row when a name has several. */
    function indexExchange(models) {
        const map = new Map();
        const rank = (m) => (m.routing_enabled ? 0 : 2) + (m.status === 'available' ? 0 : 1) + (m.price && Number.isFinite(Number(m.price.output_per_million)) ? 0 : 1);
        for (const m of models) {
            if (!m || typeof m.id !== 'string') continue;
            const keys = new Set([m.id, m.model].filter(Boolean).map((k) => String(k).toLowerCase()));
            for (const k of [...keys]) { const parts = k.split('/'); if (parts.length > 1) keys.add(parts.slice(1).join('/')); }
            for (const k of keys) {
                const old = map.get(k);
                if (!old || rank(m) < rank(old)) map.set(k, m);
            }
        }
        return map;
    }

    function exchangeRow(ex, ratings) {
        const price = ex && ex.price ? ex.price : {};
        const offers = ex && Array.isArray(ex.offers) ? ex.offers : [];
        const inPrice = num(price.input_per_million) ?? num(offers.map((o) => o && o.price && o.price.in).find((v) => v != null));
        const outPrice = num(price.output_per_million) ?? num(offers.map((o) => o && o.price && o.price.out).find((v) => v != null));
        const speeds = offers.map((o) => o && o.speed && o.speed.p50_ms).filter((v) => Number.isFinite(Number(v))).map(Number).sort((a, b) => a - b);
        const rated = ratings && ex && ratings.get(String(ex.id || '').toLowerCase());
        return {
            in: inPrice, out: outPrice,
            speed: speeds.length ? speeds[0] : null,
            score: rated && rated.score != null ? rated.score : null,
            adult: Boolean(rated && rated.adult),
        };
    }

    function priceOf(i, o) {
        if (i == null && o == null) return null;
        return { in: i == null ? null : i, out: o == null ? null : o, unit: 'USD per 1M tokens' };
    }

    /** One AI option (or one Exchange directory row when AI is unreachable) as the chip's row. */
    function rowFor(option, { source, exMap, ratings }) {
        const model = String(option.model);
        const ex = exMap.get(model.toLowerCase()) || exMap.get((model.split('/').slice(1).join('/')).toLowerCase()) || null;
        const x = exchangeRow(ex, ratings);
        const price = priceOf(x.in, x.out);
        const speed = x.speed != null ? x.speed : (Number.isFinite(Number(option.speed_ms)) ? Number(option.speed_ms) : null);
        const score = x.score != null ? x.score : (Number.isFinite(Number(option.quality)) ? Number(option.quality) : null);
        return {
            model,
            source,
            ...(source === 'machines' && option.machine ? { machine: String(option.machine) } : {}),
            name: String(option.name || (ex && ex.name) || titleOf(model)),
            maker: option.maker || makerOf(model, ex),
            price: price && (price.in != null || price.out != null) ? price : null,
            free: source !== 'openvibe' ? true : Boolean(price && price.in === 0 && price.out === 0),
            ...(speed != null ? { speed } : {}),
            ...(score != null ? { score } : {}),
            ...(ex && ex.id ? { url: pageUrl(exchangePageBase, ex.id) } : {}),
            ...(x.adult || option.adult === true ? { adult: true } : {}),
        };
    }

    /** AI unreachable: Exchange's own directory, the same row shape, enough for a signed-out sheet to work. */
    function fromExchange(task, models, ratings) {
        const image = task === 'image';
        const rows = [];
        for (const m of models) {
            if (!m || typeof m.id !== 'string') continue;
            if (image ? m.type !== 'image' : m.type === 'image') continue;
            if (!['available', 'preview'].includes(String(m.status || 'available'))) continue;
            const x = exchangeRow(m, ratings);
            if (x.adult) continue;
            const price = priceOf(x.in, x.out);
            rows.push({
                model: m.id, source: 'openvibe', name: m.name || titleOf(m.id), maker: makerOf(m.id, m),
                price: price && (price.in != null || price.out != null) ? price : null,
                free: Boolean(price && price.in === 0 && price.out === 0),
                ...(x.speed != null ? { speed: x.speed } : {}),
                ...(x.score != null ? { score: x.score } : {}),
                url: pageUrl(exchangePageBase, m.id),
            });
        }
        rows.sort((a, b) => (a.price && b.price ? (a.price.out ?? Infinity) - (b.price.out ?? Infinity) : a.price ? -1 : b.price ? 1 : a.name.localeCompare(b.name)));
        return rows.slice(0, 80);
    }

    async function read(task, { token = '', signedIn = false } = {}) {
        if (!Object.prototype.hasOwnProperty.call(AI_TASK, task)) return null;
        const [ai, exchange, ratings] = await Promise.all([
            getJson(`${aiBase}/api/v1/choices?task=${encodeURIComponent(AI_TASK[task])}`, { token: signedIn ? token : '', timeoutMs: 8000 }),
            exchangeModels(),
            reportRatings(),
        ]);
        const exMap = indexExchange(exchange);
        const adultAllowed = Boolean(ai && ai.adult);
        const groups = [];
        const add = (id, rows) => {
            const def = GROUPS.find((g) => g.id === id);
            groups.push({ id, title: def.title, rows });
        };
        const options = ai && ai.options && typeof ai.options === 'object' ? ai.options : {};
        const openvibe = (Array.isArray(options.openvibe) ? options.openvibe : [])
            .filter((o) => o && typeof o.model === 'string' && MODEL_RE.test(o.model))
            .map((o) => rowFor(o, { source: 'openvibe', exMap, ratings }))
            .filter((r) => !r.adult || adultAllowed);
        if (openvibe.length) add('openvibe', openvibe);
        else {
            const fallback = fromExchange(task, exchange, ratings);
            add('openvibe', fallback);
            const note = !ai ? 'The model directory from Exchange. AI did not answer its task choices; only OpenVibe models are listed.'
                : !fallback.length ? 'No model is listed for this task right now.' : undefined;
            if (note) groups[groups.length - 1].note = note;
        }
        if (signedIn) {
            const keys = (Array.isArray(options.keys) ? options.keys : []).filter((o) => o && typeof o.model === 'string').map((o) => rowFor(o, { source: 'keys', exMap, ratings }));
            const machines = (Array.isArray(options.machines) ? options.machines : []).filter((o) => o && typeof o.model === 'string').map((o) => rowFor(o, { source: 'machines', exMap, ratings }));
            add('keys', keys);
            if (!ai) groups[groups.length - 1].note = 'Your keys could not be read right now; OpenVibe models still answer.';
            add('machines', machines);
            if (!ai) groups[groups.length - 1].note = 'Your computers could not be read right now; OpenVibe models still answer.';
            add('plans', []);
            groups[groups.length - 1].note = 'OpenVibe.Codes runs a plan with your signed-in harnesses; it does not list them for Ask yet.';
        }
        const recommended = choiceOf(ai && ai.recommended) || choiceOf(ai && ai.choice) || { model: 'openvibe/auto', source: 'openvibe' };
        const chosen = choiceOf(ai && ai.choice) || recommended;
        return { body: { task, recommended, choice: chosen, adult: adultAllowed, groups }, ai: Boolean(ai) };
    }

    /** GET /api/frame/choices: the body plus whether it may be cached (signed out only) and the person's token. */
    async function get(task, { token = '', signedIn = false } = {}) {
        if (!Object.prototype.hasOwnProperty.call(AI_TASK, task)) return { error: 'task', detail: 'task is chat, agent, code, image or research' };
        const clean = String(token || '');
        const valid = TOKEN_RE.test(clean);
        const person = Boolean(signedIn && valid);
        if (person) { const got = await read(task, { token: clean, signedIn: true }); return { ...got, cache: false }; }
        const hit = held.get(task);
        if (hit && now() - hit.at < DAY) return { body: hit.body, ai: hit.ai, cache: true };
        const got = await read(task, { signedIn: false });
        held.set(task, { at: now(), body: got.body, ai: got.ai });
        if (held.size > 100) held.clear();
        return { ...got, cache: true };
    }

    return { get, read, _state: () => ({ held: held.size }) };
}

module.exports = { createFrameChoices, AI_TASK, GROUPS, choiceOf };
