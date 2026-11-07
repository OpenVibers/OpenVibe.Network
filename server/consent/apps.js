'use strict';
/**
 * Apps ask for consent per purpose at sign-in (the consent plan's C4, 2026-11-07; Contracts 0.307.0
 * network.consent-claim@1).
 *
 * An app adds one scope `consent:<purpose>` per purpose to /oauth/authorize, beside its other scopes. It may ask only
 * for a purpose the Contracts consent family defines (network.consent@1) AND that has words for the app screen here;
 * the retired ai.looks has none. Any other `consent:` scope is refused with invalid_scope.
 *
 * The sign-in screen lists each purpose the person has not answered yet, nothing ticked. A ticked purpose becomes a
 * `consents` row for (person, purpose, app) with source oauth (server/consent/index.js decideApp). A purpose left
 * unticked is a refusal in `consent_refusals`, and that app does not ask for it again for 30 days, unless the person
 * asks for it again on their account page ("Apps you allowed").
 *
 * The token claim (`consent`) holds the purposes the sign-in asked for that the person granted to THAT app and that are
 * active when the token is issued. It is worked out again for every token, so a purpose turned off is gone from the
 * next one. An app's grant never counts for OpenVibe itself or for another app: every query here names the client.
 */
const contracts = require('openvibe-contracts');

const SCOPE_PREFIX = 'consent:';
const APP_TEXT_VERSION = '2026-11-07.1';
const QUIET_DAYS = 30;
const QUIET_MS = QUIET_DAYS * 24 * 60 * 60 * 1000;
const CLIENT_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/;

/**
 * The words the app consent screen shows, in network.consent@1's order. "It" is the app, named in the screen's heading.
 * Plain words for anyone: what ticking it lets the app do, and what turning it off later cannot undo.
 */
const WORDS = [
    {
        id: 'ai.train',
        title: 'Train AI on your content',
        allows: 'It may use your streams, videos, voice, chat, posts, pictures and code to train or improve its AI.',
        cannot_undo: 'A model it already trained keeps what it learned.',
        adults_only: true,
    },
    {
        id: 'data.public',
        title: 'Put your content in an open dataset',
        allows: 'It may publish your content in a dataset that anyone can download and use.',
        cannot_undo: 'Copies people already downloaded stay out there.',
        adults_only: true,
    },
    {
        id: 'face.recognize',
        title: 'Recognise your face',
        allows: 'It may learn your face and recognise you in pictures and videos.',
        cannot_undo: 'A match it already made cannot be unmade.',
        adults_only: true,
    },
    {
        id: 'app.data',
        title: 'Use your content',
        allows: 'It may read and use your streams, videos, posts and other content for its own features.',
        cannot_undo: 'A copy it already made stays with the app.',
        adults_only: false,
    },
];

/** The purposes the pinned Contracts consent family defines. Nothing when the contract cannot be read (fail closed). */
function familyPurposes() {
    try {
        const s = contracts.schema('network.consent@1');
        return new Set((s && s.properties && s.properties.purpose && s.properties.purpose.enum) || []);
    } catch { return new Set(); }
}

const FAMILY = familyPurposes();
const APP_PURPOSES = Object.freeze(WORDS.filter((w) => FAMILY.has(w.id)).map((w) => Object.freeze({ ...w, text_version: APP_TEXT_VERSION })));
const APP_PURPOSE_IDS = Object.freeze(APP_PURPOSES.map((p) => p.id));
const BY_ID = new Map(APP_PURPOSES.map((p) => [p.id, p]));

const inOrder = (ids) => APP_PURPOSE_IDS.filter((id) => ids.includes(id));
const iso = (v) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

/**
 * Split a scope string into the consent purposes it asks for (known, deduplicated, in the family's order), the
 * `consent:` scopes nobody defines (unknown: the request is refused with invalid_scope), and the rest, untouched.
 */
function parseScope(scope) {
    const purposes = []; const unknown = []; const rest = [];
    for (const token of String(scope == null ? '' : scope).split(/\s+/).filter(Boolean)) {
        if (token.slice(0, SCOPE_PREFIX.length).toLowerCase() !== SCOPE_PREFIX) { rest.push(token); continue; }
        const id = token.slice(SCOPE_PREFIX.length);
        if (BY_ID.has(id)) { if (!purposes.includes(id)) purposes.push(id); } else unknown.push(token.slice(0, 64));
    }
    return { purposes: inOrder(purposes), unknown, rest: rest.join(' ') };
}

/** `base` plus one consent:<purpose> per purpose. */
function joinScope(base, purposes) {
    return [String(base || '').trim(), ...inOrder(purposes || []).map((id) => SCOPE_PREFIX + id)].filter(Boolean).join(' ');
}

/** The screen's words for these purposes (copies, in the family's order). */
function wordsFor(ids) {
    return inOrder(ids || []).map((id) => ({ ...BY_ID.get(id) }));
}

/**
 * The claim: of `purposes`, the ones this person has granted to this app and that are active at `at`. One query, and
 * it always names the client: another app's grant, or OpenVibe's own (client null), never counts.
 */
async function grantedFor(db, { subject, client, purposes, at = Date.now() }) {
    const wanted = inOrder(purposes || []);
    if (!subject || !client || !wanted.length) return [];
    const rows = await db.prepare(`SELECT DISTINCT purpose FROM consents
        WHERE subject = ? AND client = ? AND purpose = ANY(?) AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`)
        .all(String(subject), String(client), wanted, new Date(at).toISOString());
    return inOrder(rows.map((r) => r.purpose));
}

/**
 * Where this person stands with this app for each purpose it asks for: granted, quiet (refused in the last 30 days)
 * or to ask. Only the person's own sign-in sees it; the app sees the claim, which names granted purposes only.
 */
async function stepFor(db, { subject, client, purposes, at = Date.now() }) {
    const wanted = inOrder(purposes || []);
    if (!wanted.length) return { granted: [], quiet: [], ask: [] };
    const granted = await grantedFor(db, { subject, client, purposes: wanted, at });
    const quietRows = await db.prepare(`SELECT purpose FROM consent_refusals
        WHERE subject = ? AND client = ? AND purpose = ANY(?) AND quiet_until > ?`)
        .all(String(subject), String(client), wanted, new Date(at).toISOString());
    const quiet = inOrder(quietRows.map((r) => r.purpose).filter((id) => !granted.includes(id)));
    const ask = wanted.filter((id) => !granted.includes(id) && !quiet.includes(id));
    return { granted, quiet, ask };
}

/** The apps' names for "Apps you allowed": a developer's app by its client id, an OpenVibe site by its OAuth client. */
async function appNames(db, clients) {
    const names = new Map();
    if (!clients.length) return names;
    const dev = clients.filter((c) => /^app_/.test(c));
    if (dev.length) {
        for (const r of await db.prepare('SELECT oauth_client_id, name FROM dev_apps WHERE oauth_client_id = ANY(?)').all(dev)) {
            names.set(r.oauth_client_id, { name: r.name, third_party: true });
        }
    }
    const firstParty = clients.filter((c) => !names.has(c));
    if (firstParty.length) {
        for (const r of await db.prepare('SELECT client_id, name FROM oauth_clients WHERE client_id = ANY(?)').all(firstParty)) {
            names.set(r.client_id, { name: r.name, third_party: false });
        }
    }
    return names;
}

/**
 * "Apps you allowed" → network.me-consent-apps-result@1: every app with an active grant or a quiet refusal, apps with
 * a grant first, then by name. Only the person's own session reaches it.
 */
async function appsOf(db, subject, { at = Date.now() } = {}) {
    const atText = new Date(at).toISOString();
    const grants = await db.prepare(`SELECT id, purpose, client, granted_at, text_version FROM consents
        WHERE subject = ? AND client IS NOT NULL AND purpose = ANY(?) AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
        ORDER BY granted_at, id`).all(String(subject), [...APP_PURPOSE_IDS], atText);
    const quiet = await db.prepare(`SELECT client, purpose, refused_at, quiet_until FROM consent_refusals
        WHERE subject = ? AND quiet_until > ? ORDER BY refused_at, purpose`).all(String(subject), atText);
    const byClient = new Map();
    const entry = (client) => {
        if (!byClient.has(client)) byClient.set(client, { client, name: client, third_party: /^app_/.test(client), granted: [], quiet: [] });
        return byClient.get(client);
    };
    for (const g of grants) {
        if (!CLIENT_RE.test(String(g.client)) || !BY_ID.has(g.purpose)) continue;
        entry(g.client).granted.push({ consent_id: g.id, purpose: g.purpose, granted_at: iso(g.granted_at), text_version: g.text_version });
    }
    for (const q of quiet) {
        if (!CLIENT_RE.test(String(q.client)) || !BY_ID.has(q.purpose)) continue;
        const e = entry(q.client);
        if (e.granted.some((g) => g.purpose === q.purpose)) continue;
        e.quiet.push({ purpose: q.purpose, refused_at: iso(q.refused_at), quiet_until: iso(q.quiet_until) });
    }
    const names = await appNames(db, [...byClient.keys()]);
    const apps = [...byClient.values()].map((e) => {
        const known = names.get(e.client);
        const name = String((known && known.name) || e.client).trim().slice(0, 120) || e.client;
        const sort = (list) => list.sort((a, b) => APP_PURPOSE_IDS.indexOf(a.purpose) - APP_PURPOSE_IDS.indexOf(b.purpose));
        return { ...e, name, third_party: known ? known.third_party : e.third_party, granted: sort(e.granted).slice(0, 4), quiet: sort(e.quiet).slice(0, 4) };
    });
    apps.sort((a, b) => (b.granted.length > 0) - (a.granted.length > 0) || a.name.localeCompare(b.name) || a.client.localeCompare(b.client));
    return { purposes: APP_PURPOSES.map((p) => ({ ...p })), apps: apps.slice(0, 200) };
}

module.exports = {
    SCOPE_PREFIX, APP_TEXT_VERSION, QUIET_DAYS, QUIET_MS, CLIENT_RE, APP_PURPOSES, APP_PURPOSE_IDS, BY_ID,
    parseScope, joinScope, wordsFor, grantedFor, stepFor, appsOf,
};
