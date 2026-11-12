'use strict';
/**
 * The composer's @ menu (composer-post-ask-do.md, R3): GET /api/frame/mentions?q=&site=.
 *
 * One list for every site, the network's own:
 *
 *   person   a Network account: its public username, display name and, only when it is an OpenVibe.Media
 *            picture, its avatar. Never an email, a numeric id, a role or any other account field.
 *   agent    one of the person's agents from Network's agent directory (signed in only).
 *   site     an open OpenVibe place, from the Frame's site list (signed in only).
 *   channel  a public live channel on OpenVibe.Live (signed in only; Live's public list, never a private row).
 *
 * At most eight rows, people first, then the person's agents, then places. Signed out answers public
 * people only. Signed in, people the person follows and an exact username match come first.
 *
 * The read is rate-limited per actor in this process (a subject when signed in, a hash of the address
 * when not): `/api/frame` already has its per-address limit; this one keeps one person's type-ahead
 * from spending everyone else's.
 */
const crypto = require('crypto');

const MAX = 8;
const Q_MAX = 50;
const MINUTE = 60_000;
const CHANNELS_MS = 30_000;
const MEDIA_HOST = /(^|\.)openvibe\.media$/i;
const USERNAME_RE = /^[A-Za-z0-9_]{1,40}$/;

const text = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** An avatar is a public OpenVibe.Media picture, or none: never a Network-served, private or third-party URL. */
function avatarOf(value) {
    const raw = String(value == null ? '' : value);
    if (!raw || raw.length > 500) return null;
    try {
        const u = new URL(raw);
        if (u.protocol !== 'https:' || u.username || u.password) return null;
        return MEDIA_HOST.test(u.hostname) ? raw : null;
    } catch { return null; }
}

/** The row a person gets: their canonical subject id, public handle, display name and public picture. */
function personRow(u) {
    if (!u || !USERNAME_RE.test(String(u.username || '')) || !/^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(u.subject_id || ''))) return null;
    const avatar = avatarOf(u.avatar_url);
    return {
        kind: 'person',
        id: String(u.subject_id),
        label: text(u.display_name, 120) || u.username,
        handle: u.username,
        ...(avatar ? { avatar } : {}),
        url: `https://openvibe.network/@${encodeURIComponent(u.username)}`,
    };
}

function agentRow(a) {
    if (!a || !/^agt_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(a.id || ''))) return null;
    const kind = text(a.kind, 20);
    const status = text(a.status, 20);
    return {
        kind: 'agent',
        id: String(a.id),
        label: text(a.name, 120) || 'An agent',
        ...(kind || status ? { sub: [kind, status].filter(Boolean).join(' · ') } : {}),
    };
}

function siteRow(s, { fullName = (x) => x.name } = {}) {
    if (!s || !s.id || s.status !== 'open' || !s.host) return null;
    return {
        kind: 'site',
        id: String(s.id),
        label: text(s.of ? s.name : fullName(s), 120),
        handle: String(s.id),
        url: `https://${s.host}/`,
    };
}

function channelRow(st) {
    if (!st || !USERNAME_RE.test(String(st.username || ''))) return null;
    const avatar = avatarOf(st.avatar_url);
    return {
        kind: 'channel',
        id: String(st.username),
        label: text(st.display_name || st.username, 120) || st.username,
        handle: String(st.username),
        ...(avatar ? { avatar } : {}),
        url: `https://openvibe.live/@${encodeURIComponent(st.username)}`,
    };
}

/** Public Live streams only: a row the site marks unlisted/private never reaches a mention list. */
function publicLive(st) {
    if (!st || typeof st !== 'object') return false;
    if (st.visibility && String(st.visibility).toLowerCase() !== 'public') return false;
    if (st.is_public === false || st.unlisted === true || st.is_unlisted === true || st.listed === false) return false;
    return true;
}

function createFrameMentions({
    db,
    sites = [],
    siteForHost = null,
    fullName = (s) => s.name,
    liveUrl = '',
    fetchImpl = globalThis.fetch,
    now = Date.now,
    log = console,
    perMinute = 120,
} = {}) {
    const liveBase = String(liveUrl || '').replace(/\/+$/, '');
    const held = new Map();       // signed-out answer, by q
    const hits = new Map();       // actor -> { n, reset }
    let channels = null, channelsAt = 0, channelsInflight = null;

    async function getJson(url, timeoutMs) {
        if (typeof fetchImpl !== 'function') return null;
        try {
            const r = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
            return r && r.ok ? await r.json() : null;
        } catch (err) {
            if (log && log.warn) log.warn(`[FrameMentions] ${url}: ${String((err && err.message) || err).slice(0, 160)}`);
            return null;
        }
    }

    /** The public live channels, held 30 s: Live's list is public, its private rows are not our business. */
    async function liveChannels() {
        if (channels && now() - channelsAt < CHANNELS_MS) return channels;
        if (!liveBase) return [];
        channelsInflight = channelsInflight || getJson(`${liveBase}/api/streams`, 2500).then((d) => {
            const streams = d && Array.isArray(d.streams) ? d.streams.filter(publicLive) : [];
            return streams.map(channelRow).filter(Boolean).slice(0, 20);
        }).finally(() => { channelsInflight = null; });
        const rows = await channelsInflight;
        if (rows.length) { channels = rows; channelsAt = now(); }
        return rows;
    }

    /** The current site, from a hostname, a URL or a site id; null when the composer names none. */
    function siteOf(value) {
        const raw = String(value == null ? '' : value).trim().toLowerCase();
        if (!raw) return null;
        let host = raw;
        try { if (raw.includes('://')) host = new URL(raw).hostname; } catch { /* a bare host or id */ }
        host = host.replace(/:\d+$/, '').replace(/^www\./, '').replace(/\/.*$/, '');
        const listed = (sites || []).find((s) => s && (s.id === host || s.id === raw || s.host === host));
        if (listed) return listed;
        return typeof siteForHost === 'function' ? siteForHost(host) : null;
    }

    /** At most eight; people first, then this person's agents, then places. */
    async function get({ q = '', site = '', user = null } = {}) {
        const query = text(q, Q_MAX).toLowerCase();
        const signedIn = Boolean(user && (user.id != null || user.subject_id));
        const current = siteOf(site);
        if (!signedIn) {
            const hit = held.get(query);
            if (hit && now() - hit.at < MINUTE) return { body: hit.body, cached: true };
            const people = await peopleRows(query, null);
            const body = { mentions: people.slice(0, MAX) };
            if (held.size >= 500) held.clear();
            held.set(query, { at: now(), body });
            return { body, cached: false };
        }

        const out = [];
        const room = () => MAX - out.length;
        for (const row of await peopleRows(query, user)) { if (out.length >= MAX) break; out.push(row); }
        if (room() > 0) for (const row of await agentRows(query, user)) { if (out.length >= MAX) break; out.push(row); }
        if (room() > 0) {
            for (const s of sites) {
                if (out.length >= MAX) break;
                if (!s || s.status !== 'open' || (current && s.id === current.id)) continue;
                if (query && !`${s.id} ${s.name} ${s.host} ${s.tagline || ''}`.toLowerCase().includes(query)) continue;
                const row = siteRow(s, { fullName });
                if (row) out.push(row);
            }
        }
        if (room() > 0) {
            for (const row of await liveChannels()) {
                if (out.length >= MAX) break;
                if (query && !`${row.id} ${row.label}`.toLowerCase().includes(query)) continue;
                out.push(row);
            }
        }
        return { body: { mentions: out.slice(0, MAX) }, cached: false };
    }

    async function peopleRows(query, user) {
        if (!db) return [];
        const signedIn = Boolean(user && (user.id != null || user.subject_id));
        const params = [];
        let sql = 'SELECT u.id, u.subject_id, u.username, u.display_name, u.avatar_url';
        if (signedIn) {
            sql += ', EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = ? AND f.followed_id = u.id) AS followed';
            params.push(user.id);
        }
        sql += ` FROM users u WHERE u.is_anon = 0 AND COALESCE(u.is_banned, 0) = 0 AND u.merged_into IS NULL
            AND u.deleted_at IS NULL AND u.subject_id IS NOT NULL`;
        if (signedIn) { sql += ' AND u.id <> ?'; params.push(user.id); }
        else sql += ' AND u.profile_public = 1';
        if (query) {
            sql += " AND (position(lower(?) in lower(u.username)) > 0 OR position(lower(?) in lower(coalesce(u.display_name, ''))) > 0)";
            params.push(query, query);
        }
        const order = [];
        if (query) { order.push('(lower(u.username) = lower(?)) DESC'); params.push(query); }
        if (signedIn) order.push('followed DESC');
        order.push('u.username ASC');
        sql += ` ORDER BY ${order.join(', ')} LIMIT ?`;
        params.push(MAX);
        try {
            const rows = await db.prepare(sql).all(...params);
            return rows.map(personRow).filter(Boolean).slice(0, MAX);
        } catch (err) {
            if (log && log.warn) log.warn(`[FrameMentions] people: ${String((err && err.message) || err).slice(0, 160)}`);
            return [];
        }
    }

    async function agentRows(query, user) {
        if (!db || !user) return [];
        let subject = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(user.subject_id || '')) ? String(user.subject_id) : '';
        if (!subject && user.id != null) {
            try { const row = await db.prepare('SELECT subject_id FROM users WHERE id = ?').get(user.id); subject = (row && row.subject_id) || ''; } catch { subject = ''; }
        }
        if (!subject) return [];
        const params = [subject];
        let sql = 'SELECT id, kind, name, service, machine_id, status FROM agent_directory WHERE owner_subject = ?';
        if (query) { sql += ' AND position(lower(?) in lower(name)) > 0'; params.push(query); }
        sql += " ORDER BY CASE status WHEN 'online' THEN 0 WHEN 'busy' THEN 1 ELSE 2 END, updated_at DESC, id ASC LIMIT ?";
        params.push(MAX);
        try {
            const rows = await db.prepare(sql).all(...params);
            return rows.map(agentRow).filter(Boolean).slice(0, MAX);
        } catch (err) {
            if (log && log.warn) log.warn(`[FrameMentions] agents: ${String((err && err.message) || err).slice(0, 160)}`);
            return [];
        }
    }

    /** The per-actor window: 120 a minute for one person, one hashed address when signed out. */
    function allow(actor) {
        const at = now();
        const key = String(actor || '');
        if (!key) return { ok: true };
        let w = hits.get(key);
        if (!w || at >= w.reset) { w = { n: 0, reset: at + MINUTE }; hits.set(key, w); }
        if (w.n >= perMinute) return { ok: false, retryAfter: Math.max(1, Math.ceil((w.reset - at) / 1000)) };
        w.n++;
        if (hits.size > 20_000) for (const [k, v] of hits) if (at >= v.reset) hits.delete(k);
        return { ok: true };
    }

    /** The address a signed-out request is counted by: a short hash in memory, never the address itself. */
    function actorKey(req, user) {
        if (user && (user.subject_id || user.id != null)) return `user:${user.subject_id || user.id}`;
        const ip = String((req && req.ip) || '');
        return `ip:${crypto.createHash('sha256').update(ip).digest('hex').slice(0, 20)}`;
    }

    return { get, allow, actorKey, siteOf, _state: () => ({ held: held.size, hits: hits.size }) };
}

module.exports = { createFrameMentions, avatarOf, personRow, agentRow, siteRow, channelRow, publicLive, MAX, MINUTE };
