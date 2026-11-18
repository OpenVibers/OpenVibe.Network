'use strict';

/**
 * The check before the reviewers (plan §AD.25; openvibe-sdk/agents/group 0.185.0 `policy.gate`; Stageshow's gate, the
 * owner sent it on 2026-11-17). When a builder in a room says DONE, the room runs this before any reviewer model is
 * paid. It runs OpenVibe.Design's page audit (openvibe_design_audit_page, Design #409: the markup against Design's
 * checklist and rules, no model, free) on the pages the hand-over links to.
 *
 *   createRoomCheck({ designUrl, fetchImpl?, timeoutMs? }) → { run(doneText, { mayBlock }), linksIn(text) }
 *   run → { text, blocked } to post as the check's message, or null when there is nothing to check (no page link, or
 *         Design did not answer). With mayBlock, high-severity findings or a page Design could not read become a
 *         CHANGES line and a numbered list, which sends the builder back. Otherwise every finding is for the reviewers
 *         to weigh.
 *
 * Network calls only the configured Design base (OV_DESIGN_URL, loopback in production). The page addresses come from
 * an agent's words and are handed to Design, whose guarded reader fetches them (https, public addresses, checked
 * redirects, capped); Network never fetches them itself.
 */
const MAX_LINKS = 2;
// Not pages a builder made: code hosts and media files. Auditing GitHub's own markup would judge GitHub.
const SKIP_HOSTS = /(^|\.)(github\.com|githubusercontent\.com|gitlab\.com|bitbucket\.org|git\.openvibe\.codes|openvibe\.media)$/i;
const FILE_PATH = /\.(png|jpe?g|gif|webp|svg|avif|ico|pdf|zip|tar|gz|tgz|json|txt|md|csv|mp4|webm|mov|mp3|wav|ogg|js|mjs|css|diff|patch)$/i;
const flat = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);

function linksIn(text) {
    const out = [];
    for (const m of String(text || '').matchAll(/https:\/\/[^\s<>()"'`\]\[]+/g)) {
        let u;
        try { u = new URL(m[0].replace(/[.,;:!?*_]+$/, '')); } catch { continue; }
        if (u.username || u.password || SKIP_HOSTS.test(u.hostname) || FILE_PATH.test(u.pathname)) continue;
        u.hash = '';
        const key = u.toString();
        if (!out.includes(key)) out.push(key);
        if (out.length >= MAX_LINKS) break;
    }
    return out;
}

function createRoomCheck({ designUrl, fetchImpl = globalThis.fetch, timeoutMs = 20_000 } = {}) {
    const base = String(designUrl || '').replace(/\/+$/, '');

    /** One page through Design's audit: { ok: true, result }, { ok: false, unreadable }, or null when Design is not there. */
    async function audit(url) {
        let r;
        try {
            r = await fetchImpl(`${base}/mcp`, {
                method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
                headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'openvibe_design_audit_page', arguments: { url } } }),
            });
        } catch { return null; }
        if (!r || !r.ok) return null;
        const raw = String(await r.text().catch(() => ''));
        let j = null;
        try { j = JSON.parse(/^\s*(event|data):/.test(raw) ? (raw.split('\n').find((l) => l.startsWith('data:')) || '').slice(5) : raw); } catch { return null; }
        const res = j && j.result;
        if (!res) return null;
        const said = res.content && res.content[0] && res.content[0].text;
        if (res.isError) return { ok: false, unreadable: flat(said, 200) || 'it did not answer' };
        let data = res.structuredContent || null;
        if (!data) { try { data = JSON.parse(said); } catch { data = null; } }
        return data && Array.isArray(data.findings) ? { ok: true, result: data } : null;
    }

    const lineOf = (f, url, many) => `${f.severity}: ${flat(f.says, 180)}${f.fix ? ` Fix: ${flat(f.fix, 140)}` : ''}${Number(f.count) > 1 ? ` (${Number(f.count)} places)` : ''}${f.rule && f.rule !== 'checklist' ? ` [${flat(f.rule, 40)}]` : ''}${many ? ` on ${url}` : ''}`;

    async function run(doneText, { mayBlock = true } = {}) {
        if (!base) return null;
        const links = linksIn(doneText);
        if (!links.length) return null;
        const seen = (await Promise.all(links.map(async (url) => ({ url, a: await audit(url) })))).filter((x) => x.a);
        if (!seen.length) return null;
        const many = seen.length > 1;
        const head = [], faults = [], notes = [];
        for (const { url, a } of seen) {
            if (!a.ok) { head.push(`Could not read ${url}: ${a.unreadable}.`); faults.push(`${url} does not open for a reviewer: ${a.unreadable}. Hand over a link that answers.`); continue; }
            const f = a.result.findings.filter((x) => x && typeof x === 'object');
            head.push(`Checked ${flat(a.result.url || url, 300)} with openvibe.design's audit (its markup, no model): ${f.length ? `${f.length} finding${f.length === 1 ? '' : 's'}` : 'nothing wrong in the markup'}.`);
            for (const x of f.filter((y) => y.severity === 'high')) faults.push(lineOf(x, url, many));
            for (const x of f.filter((y) => y.severity !== 'high').slice(0, 4)) notes.push(lineOf(x, url, many));
        }
        if (mayBlock && faults.length) {
            return { blocked: true, text: [...head, 'CHANGES', ...faults.slice(0, 8).map((t, i) => `${i + 1}. ${t}`), ...(notes.length ? ['Also worth a look:', ...notes.map((t) => `- ${t}`)] : [])].join('\n') };
        }
        const all = [...faults, ...notes].slice(0, 8);
        return { blocked: false, text: [...head, ...(all.length ? ['For the reviewers to weigh:', ...all.map((t) => `- ${t}`)] : [])].join('\n') };
    }

    return { run, linksIn, enabled: !!base };
}

module.exports = { createRoomCheck, linksIn };
