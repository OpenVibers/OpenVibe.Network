'use strict';
/**
 * The composer's slash commands (composer-post-ask-do.md, R3): GET /api/frame/commands?site=<host>&q=.
 *
 * Every site offers the network's four: /ask (Vibe answers with sources), /do (Actor does it), /remind
 * (Today remembers it) and /timer (the Dock's focus timer). A site adds its own from its manifest's
 * `site.commands` block when it has one, and a signed-in person's saved composer snippets are their
 * own commands. A row is `{ name, hint, insert, kind, needs_sign_in }`:
 *
 *   name           the word after the slash, lower-case, no slash
 *   hint           one line the popover shows beside it
 *   insert         the text a pick puts in the box (the word, a space, ready for its arguments)
 *   kind           network | site | mine
 *   needs_sign_in  the command acts for a person, so a signed-out box may offer it and then sign in
 *
 * Site commands come first (the box shows the ones that fit its site first), then the network's, then
 * the person's own. A name appears once: a site may replace a network command of the same name.
 */
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const MAX_COMMANDS = 50;
const MAX_SITE_COMMANDS = 12;

// The four every box offers. Their hints are the composer's own words, not product names.
const DEFAULTS = Object.freeze([
    { name: 'ask', hint: 'Ask Vibe: an answer with its sources', insert: '/ask ', kind: 'network', needs_sign_in: true },
    { name: 'do', hint: 'Hand it to your agent: Actor plans and runs it', insert: '/do ', kind: 'network', needs_sign_in: true },
    { name: 'remind', hint: 'Have Today remind you', insert: '/remind ', kind: 'network', needs_sign_in: true },
    { name: 'timer', hint: 'Start a focus timer in the Dock', insert: '/timer ', kind: 'network', needs_sign_in: true },
]);

const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const nameOf = (v) => String(v == null ? '' : v).trim().replace(/^\/+/, '').toLowerCase();

/** One row from a manifest command or a saved snippet, or null when it is not a command we can offer. */
function rowOf(raw, kind) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const name = nameOf(raw.name != null ? raw.name : raw.trigger);
    if (!NAME_RE.test(name)) return null;
    const hint = clean(raw.hint != null ? raw.hint : (raw.summary != null ? raw.summary : raw.label), 120);
    const insert = String(raw.insert != null ? raw.insert : raw.text != null ? raw.text : `/${name} `)
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
        .slice(0, 4000);
    return { name, hint, insert, kind, needs_sign_in: raw.needs_sign_in === true || raw.needsSignIn === true };
}

/** The site's own commands from its Frame manifest entry (`site.commands`), at most twelve. */
function siteRows(site) {
    const out = [];
    for (const raw of Array.isArray(site && site.commands) ? site.commands.slice(0, MAX_SITE_COMMANDS) : []) {
        const row = rowOf(raw, 'site');
        if (row) out.push(row);
    }
    return out;
}

/** A person's saved composer snippets (composer.prefs@1 `snippets`) as their own commands. */
function savedRows(prefs) {
    let snippets = null;
    try { snippets = prefs ? JSON.parse(prefs) : null; } catch { snippets = null; }
    const list = snippets && Array.isArray(snippets.snippets) ? snippets.snippets : [];
    const out = [];
    for (const s of list.slice(0, MAX_COMMANDS)) {
        const row = rowOf(s, 'mine');
        if (row) out.push(row);
    }
    return out;
}

/** The site an asking composer means: a hostname, a URL or a site id (the icon name). */
function siteOf(value, sites, siteForHost) {
    const raw = String(value == null ? '' : value).trim().toLowerCase();
    if (!raw) return null;
    let host = raw;
    try { if (raw.includes('://')) host = new URL(raw).hostname; } catch { /* a bare host or id */ }
    host = host.replace(/:\d+$/, '').replace(/^www\./, '').replace(/\/.*$/, '');
    const listed = (sites || []).find((s) => s && (s.id === host || s.id === raw || s.host === host));
    if (listed) return listed;
    return typeof siteForHost === 'function' ? siteForHost(host) : null;
}

/**
 * The body of GET /api/frame/commands.
 * `signedIn` adds the person's saved snippets (`prefs` is their stored composer_prefs JSON).
 */
function read({ site = '', q = '', signedIn = false, prefs = null, sites = [], siteForHost = null } = {}) {
    const found = siteOf(site, sites, siteForHost);
    const query = String(q == null ? '' : q).trim().toLowerCase().slice(0, 50);
    const rows = [];
    const seen = new Set();
    const add = (row) => {
        if (!row || seen.has(row.name) || rows.length >= MAX_COMMANDS) return;
        seen.add(row.name);
        rows.push(row);
    };
    for (const row of siteRows(found)) add(row);
    for (const row of DEFAULTS) add(row);
    if (signedIn) for (const row of savedRows(prefs)) add(row);
    const commands = query
        ? rows.filter((r) => r.name.startsWith(query) || r.hint.toLowerCase().includes(query))
        : rows;
    return {
        site: found ? { id: found.id, name: found.name, host: found.host } : null,
        commands,
    };
}

module.exports = { read, rowOf, siteOf, savedRows, siteRows, DEFAULTS, NAME_RE, MAX_COMMANDS, MAX_SITE_COMMANDS };
