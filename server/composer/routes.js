'use strict';
/**
 * The shared composer's server half on OpenVibe.Network.
 *
 *   GET  /api/v1/me/composer        composer.prefs@1 (rev + the person's settings), signed-in only
 *   PUT  /api/v1/me/composer        composer.prefs@1 in, the new document out; a stale `rev` is 409 with `current`
 *   GET  /api/v1/mentions           composer.mention@1 entries: people the person follows first, then public
 *                                   people; repositories from OpenVibe Git the person can see; first-party sites.
 *                                   Signed-in only, at most 8 entries.
 *
 * The CORS allow-list is the app-wide one (server/public-cors.js: every first-party manifest origin; a foreign
 * origin is refused with 403 before the route). The bytes a post attaches come from Media, not here.
 *
 * composer.prefs@1 is normalised here rather than through `contracts.validate`, so Network keeps working with the
 * contracts release it pins; the shape is the contract's, field for field.
 */
const express = require('express');
const contracts = require('openvibe-contracts');

const MAX_MENTIONS = 8;
const Q_MAX = 100;
const SEND_KEYS = ['enter', 'mod-enter'];
const DENSITIES = ['comfy', 'compact'];
const TRIGGER_RE = /^\/[a-z0-9][a-z0-9_-]{0,31}$/;
const TOOL_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
const KINDS = ['person', 'repo', 'site', 'file'];
const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

const DEFAULTS = Object.freeze({ send_key: 'enter', tools: [], density: 'comfy', voice: true, snippets: [] });
const clone = (v) => JSON.parse(JSON.stringify(v));

/** The stored document, or the defaults at rev 0. */
function parseRow(row) {
    if (!row) return { rev: 0, ...clone(DEFAULTS) };
    let prefs = null;
    try { prefs = row.composer_prefs ? JSON.parse(row.composer_prefs) : null; } catch { prefs = null; }
    const rev = Math.max(0, Number(row.composer_rev) || 0);
    return { rev, ...clone(DEFAULTS), ...(prefs && typeof prefs === 'object' ? prefs : {}) };
}

/** Normalise a PUT body (composer.prefs@1) without its rev. -> { value } or { error }. */
function cleanPrefs(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'the body must be a composer.prefs@1 object' };
    const known = new Set(['rev', 'send_key', 'tools', 'density', 'voice', 'snippets']);
    for (const k of Object.keys(body)) if (!known.has(k)) return { error: `unknown field ${k}` };
    if (!Number.isInteger(body.rev) || body.rev < 0) return { error: 'rev must be an integer >= 0' };
    if (!SEND_KEYS.includes(body.send_key)) return { error: `send_key must be one of ${SEND_KEYS.join(', ')}` };
    if (!DENSITIES.includes(body.density)) return { error: `density must be one of ${DENSITIES.join(', ')}` };
    if (typeof body.voice !== 'boolean') return { error: 'voice must be a boolean' };
    if (!Array.isArray(body.tools) || body.tools.length > 100) return { error: 'tools must be an array of at most 100 entries' };
    const tools = [];
    for (const t of body.tools) {
        if (!t || typeof t !== 'object' || Array.isArray(t)) return { error: 'each tool must be an object' };
        for (const k of Object.keys(t)) if (!['id', 'hidden'].includes(k)) return { error: `unknown tool field ${k}` };
        if (typeof t.id !== 'string' || !TOOL_ID_RE.test(t.id) || t.id.length > 40) return { error: 'each tool needs an id of lower-case letters, digits, . _ -' };
        if (typeof t.hidden !== 'boolean') return { error: 'each tool needs hidden: true or false' };
        tools.push({ id: t.id, hidden: t.hidden });
    }
    if (!Array.isArray(body.snippets) || body.snippets.length > 50) return { error: 'snippets must be an array of at most 50 entries' };
    const snippets = [];
    for (const s of body.snippets) {
        if (!s || typeof s !== 'object' || Array.isArray(s)) return { error: 'each snippet must be an object' };
        for (const k of Object.keys(s)) if (!['trigger', 'label', 'text'].includes(k)) return { error: `unknown snippet field ${k}` };
        if (typeof s.trigger !== 'string' || !TRIGGER_RE.test(s.trigger)) return { error: 'a trigger is a slash word such as /sig' };
        if (typeof s.label !== 'string' || !s.label.length || s.label.length > 80) return { error: 'a snippet label is 1 to 80 characters' };
        if (typeof s.text !== 'string' || !s.text.length || s.text.length > 4000) return { error: 'a snippet text is 1 to 4000 characters' };
        snippets.push({ trigger: s.trigger, label: s.label, text: s.text });
    }
    return { value: { send_key: body.send_key, tools, density: body.density, voice: body.voice, snippets } };
}

function createRouter({ db, requireAuth, selfToken = () => null, config, fetchImpl = (...a) => fetch(...a), log = console } = {}) {
    if (!db || !requireAuth) throw new TypeError('createRouter needs db and requireAuth');
    const router = express.Router();
    const handle = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
    const base = String((config && config.baseUrl) || 'https://openvibe.network').replace(/\/+$/, '');
    const avatarOf = (u) => {
        const a = u && u.avatar_url ? String(u.avatar_url) : '';
        if (!a) return `${base}/avatar/${encodeURIComponent(u.username)}?s=64`;
        return /^https?:\/\//.test(a) ? a : `${base}${a.startsWith('/') ? '' : '/'}${a}`;
    };
    const mentionPerson = (u) => ({
        kind: 'person',
        id: u.subject_id,
        label: u.display_name || u.username,
        handle: u.username,
        avatar: avatarOf(u),
        url: `${base}/@${encodeURIComponent(u.username)}`,
    });
    const storedRow = (userId) => db.prepare('SELECT composer_rev, composer_prefs FROM user_preferences WHERE user_id = ?').get(userId);
    const conflict = (res, current) => res.status(409).json({ status: 409, error: 'the composer settings changed in another tab', code: 'composer.rev_conflict', current });

    // ── The person's composer settings, revision-checked ─────
    router.get('/me/composer', requireAuth, handle(async (req, res) => {
        res.set('Cache-Control', 'no-store').json(parseRow(await storedRow(req.user.id)));
    }));

    router.put('/me/composer', requireAuth, handle(async (req, res) => {
        const userId = req.user.id;
        const cleaned = cleanPrefs(req.body);
        if (cleaned.error) return res.status(422).json({ error: cleaned.error, code: 'composer.invalid_prefs' });
        const row = await storedRow(userId);
        const current = parseRow(row);
        if (req.body.rev !== current.rev) return conflict(res, current);
        const next = { rev: current.rev + 1, ...cleaned.value };
        const json = JSON.stringify(cleaned.value);
        if (!row) {
            try {
                await db.prepare('INSERT INTO user_preferences (user_id, composer_prefs, composer_rev, updated_at) VALUES (?, ?, ?, ov_now())').run(userId, json, next.rev);
            } catch {
                return conflict(res, parseRow(await storedRow(userId)));   // another tab inserted first
            }
        } else {
            const r = await db.prepare('UPDATE user_preferences SET composer_prefs = ?, composer_rev = ?, updated_at = ov_now() WHERE user_id = ? AND composer_rev = ?').run(json, next.rev, userId, current.rev);
            if (!r.changes) return conflict(res, parseRow(await storedRow(userId)));
        }
        res.set('Cache-Control', 'no-store').json(next);
    }));

    // ── The @ menu ────────────────────────────────────────────
    router.get('/mentions', requireAuth, handle(async (req, res) => {
        const q = String(req.query.q || '').trim().slice(0, Q_MAX);
        const asked = String(req.query.kinds || '').split(',').map((k) => k.trim()).filter(Boolean);
        const kinds = asked.length ? asked.filter((k) => KINDS.includes(k)) : KINDS.slice();
        if (!kinds.length) return res.status(422).json({ error: `kinds must be among ${KINDS.join(', ')}`, code: 'mentions.invalid_kinds' });
        const out = [];
        const room = () => MAX_MENTIONS - out.length;

        if (kinds.includes('person') && room() > 0) {
            const params = [req.user.id, req.user.id];
            let where = `u.is_anon = 0 AND COALESCE(u.is_banned, 0) = 0 AND u.merged_into IS NULL AND u.deleted_at IS NULL AND u.subject_id IS NOT NULL AND u.id <> ?`;
            if (q) {
                where += ` AND (position(lower(?) in lower(u.username)) > 0 OR position(lower(?) in lower(coalesce(u.display_name, ''))) > 0)`;
                params.push(q, q);
            }
            const rows = await db.prepare(`SELECT u.id, u.subject_id, u.username, u.display_name, u.avatar_url,
                    EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = ? AND f.followed_id = u.id) AS followed
                FROM users u WHERE ${where}
                ORDER BY followed DESC, u.username ASC LIMIT ?`).all(...params, room());
            for (const u of rows) if (SUBJECT_RE.test(String(u.subject_id || ''))) out.push(mentionPerson(u));
        }

        if (kinds.includes('repo') && room() > 0) {
            const token = selfToken('openvibe.git', ['git.repo.read']);
            const gitUrl = (config && config.services && config.services.git && config.services.git.internalUrl) || '';
            if (token && gitUrl) {
                try {
                    const r = await fetchImpl(`${String(gitUrl).replace(/\/+$/, '')}/api/v1/repos?q=${encodeURIComponent(q)}&limit=${room()}`, {
                        headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, ...(SUBJECT_RE.test(String(req.user.subject_id || '')) ? { 'X-OV-Subject': req.user.subject_id } : {}) },
                        signal: AbortSignal.timeout(2500),
                    });
                    const j = r.ok ? await r.json() : null;
                    for (const repo of (j && j.repositories) || []) {
                        if (out.length >= MAX_MENTIONS) break;
                        if (!repo || !repo.full_name) continue;
                        out.push({ kind: 'repo', id: repo.full_name, label: repo.full_name, url: repo.html_url });
                    }
                } catch (err) { log.warn(`[Mentions] git unreachable: ${err.message}`); }
            }
        }

        if (kinds.includes('site') && room() > 0) {
            for (const m of (contracts.services && contracts.services.manifests) || []) {
                if (out.length >= MAX_MENTIONS) break;
                if (!m.domains || !m.domains.length || !m.id) continue;
                const name = (m.site && m.site.name) || m.name || m.id;
                const host = String(m.domains[0]);
                if (q && !`${m.id} ${name} ${m.domains.join(' ')}`.toLowerCase().includes(q.toLowerCase())) continue;
                out.push({ kind: 'site', id: m.id, label: name, handle: m.id, avatar: null, url: `https://${host}/` });
            }
        }

        // `file` mentions are the message's own context (an attachment, a repository file); there is no global file
        // index to search, so asking for that kind alone answers with an empty list.
        res.set('Cache-Control', 'no-store').json({ mentions: out.slice(0, MAX_MENTIONS) });
    }));

    router.cleanPrefs = cleanPrefs;
    router.parseRow = parseRow;
    return router;
}

module.exports = { createRouter, cleanPrefs, parseRow, DEFAULTS, MAX_MENTIONS, KINDS };
