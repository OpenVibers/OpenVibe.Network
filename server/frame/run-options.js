'use strict';
/**
 * GET /api/frame/run-options — what an agent's box can pick (openvibe-shared 4.259.0, the run line under the words;
 * the owner, 11-15: "you need to be able to choose your harness, … configure your model, … interact with link, and you
 * can choose a node, … the shared node or your own"): who does a run and where it runs. The model is the Frame's own
 * /choices (task=agent). One request from any site, with the person's own token:
 *
 *   { agents: [{ id, name, line, kind }], places: [{ kind, id?, name, line, online?, disabled? }] }
 *
 * agents   Auto; your Actor (by its own name, from Actor as you); Codes; then each coding harness Codes runs (its
 *          public catalogue, kept five minutes), with its maker. An id is what agents.run-start@1's `agent` takes.
 * places   Auto; OpenVibe; your computers through Link (Bot's registry as you, online first): one that is offline, or
 *          that has not turned on running coding tasks or being your agent's computer, is listed and cannot be picked,
 *          with why. Computers shared with you join when sharing reaches runs (Link's compute list says so today).
 *          A place is what agents.run-start@1's `where` takes ({ kind: 'openvibe' | 'machine', id }).
 *
 * Signed out: the short lists (Auto, Actor, Codes; Auto, OpenVibe), public and kept a minute. A product that does not
 * answer leaves its part short; the lists never fail as a whole.
 */
const HARNESS_TTL_MS = 5 * 60_000;
const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const DEV = /^dev_[0-9A-HJKMNP-TV-Z]{26}$/;
const clip = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);

const BASE_AGENTS = [
    { id: 'auto', name: 'Auto', line: 'The right one for what you ask', kind: 'auto' },
    { id: 'actor', name: 'Actor', line: 'Your agent: answers, searches, does things for you', kind: 'actor' },
    { id: 'codes', name: 'Codes', line: 'Writes and changes code, on the best harness for it', kind: 'codes' },
];
const BASE_PLACES = [
    { kind: 'auto', name: 'Auto', line: 'Wherever it fits best' },
    { kind: 'openvibe', name: 'OpenVibe', line: "OpenVibe's own computers" },
];

// Codes names a harness's maker by a slug ("anthropic", "opencode-go", "custom"): the line says it as people do (11-17,
// Your AI on a phone read "A coding agent · commandcode").
const MAKERS = { anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google', meta: 'Meta', minimax: 'MiniMax', deepseek: 'DeepSeek',
    commandcode: 'Command Code', 'opencode-go': 'OpenCode', opencode: 'OpenCode', aider: 'Aider', openvibe: 'OpenVibe', xai: 'xAI',
    mistral: 'Mistral', qwen: 'Qwen', moonshot: 'Moonshot', zhipu: 'Zhipu', cursor: 'Cursor', github: 'GitHub', amazon: 'Amazon', sourcegraph: 'Sourcegraph' };
function makerLine(provider) {
    const slug = String(provider || '').trim();
    if (!slug) return 'A coding agent';
    if (/^custom$/i.test(slug)) return 'A coding agent on the provider you choose';
    if (/^self-?hosted$/i.test(slug)) return 'A coding agent on a model you host';
    const known = MAKERS[slug.toLowerCase()];
    const name = known || (/^[a-z0-9-]+$/.test(slug) ? slug.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') : slug);
    return `A coding agent by ${clip(name, 40)}`;
}

function createRunOptions({ svcUrl = (n, f) => f, fetchImpl = globalThis.fetch, bot = null, now = Date.now, log = console } = {}) {
    let harnessList = null, harnessAt = 0, harnessJob = null;
    async function harnesses() {
        if (harnessList && now() - harnessAt < HARNESS_TTL_MS) return harnessList;
        if (harnessJob) return harnessJob;
        harnessJob = (async () => {
            try {
                const r = await fetchImpl(new URL('/api/v1/harnesses', svcUrl('codes', 'http://127.0.0.1:4900')).href, { headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(3000) });
                const j = r.ok ? await r.json() : null;
                const list = (j && Array.isArray(j.harnesses) ? j.harnesses : []).filter((h) => h && ID.test(String(h.id || '')) && h.id !== 'openvibe-ai')
                    .map((h) => ({ id: String(h.id), name: clip(h.name || h.id, 60), line: makerLine(h.provider), kind: 'harness' }))
                    // One name once: Codes lists a harness and its ACP twin under the same name ("Codex", "Codex"); the
                    // first is the one a person picks.
                    .filter((h, i, all) => all.findIndex((x) => x.name.toLowerCase() === h.name.toLowerCase()) === i);
                harnessList = list; harnessAt = now();
            } catch (err) { if (log.warn) log.warn(`[run-options] Codes' harnesses: ${err && err.message}`); }
            harnessJob = null;
            return harnessList || [];
        })();
        return harnessJob;
    }
    async function actorName(auth) {
        try {
            const r = await fetchImpl(new URL('/api/v1/me/actor', svcUrl('actor', 'http://127.0.0.1:4950')).href, { headers: { Accept: 'application/json', Authorization: auth }, redirect: 'error', signal: AbortSignal.timeout(2500) });
            const j = r.ok ? await r.json() : null;
            const n = clip(j && j.name, 40);
            return n && !/^(my actor|vibe)$/i.test(n) ? n : 'Actor';
        } catch { return 'Actor'; }
    }
    async function machines(subject) {
        if (!bot || !subject) return [];
        try {
            const out = await bot.list(subject);
            return (out && Array.isArray(out.machines) ? out.machines : []).filter((m) => m && DEV.test(String(m.id || '')));
        } catch (err) { if (log.warn) log.warn(`[run-options] machines: ${err && err.message}`); return []; }
    }
    /** A computer of yours as a place: online and allowed to run something, or listed with why it cannot be picked. */
    function placeOf(m) {
        const roles = Array.isArray(m.roles) ? m.roles : [];
        const can = roles.includes('codes.worker') || roles.includes('agent.computer') || roles.includes('ai.host') || roles.includes('desks.host');
        const name = clip(m.name || m.id, 60);
        const what = clip(m.specs_words || m.os || '', 80);
        const place = { kind: 'machine', id: String(m.id), name, online: m.online === true, line: `Your computer${what ? ` · ${what}` : ''}${m.online === true ? '' : ' · offline'}` };
        if (m.online !== true) return { ...place, disabled: true, line: `${place.line}: open Link on it to use it` };
        if (!can) return { ...place, disabled: true, line: 'Your computer · turn on running tasks for it on openvibe.link/machines' };
        return place;
    }
    /** The person's computers as places, the ones that can run something first (also the resources' road reads it). */
    async function computers(subject) {
        return (await machines(subject)).map(placeOf).sort((x, y) => Number(!!x.disabled) - Number(!!y.disabled) || x.name.localeCompare(y.name));
    }
    async function get({ auth = '', subject = null } = {}) {
        if (!auth) return { body: { agents: BASE_AGENTS, places: BASE_PLACES }, cache: true };
        const [name, list, mine] = await Promise.all([actorName(auth), harnesses(), computers(subject)]);
        const agents = BASE_AGENTS.map((a) => (a.id === 'actor' ? { ...a, name } : a)).concat(list);
        return { body: { agents, places: BASE_PLACES.concat(mine) }, cache: false };
    }
    return { get, harnesses, computers, machines, BASE_AGENTS, BASE_PLACES };
}

module.exports = { createRunOptions, makerLine, BASE_AGENTS, BASE_PLACES };
