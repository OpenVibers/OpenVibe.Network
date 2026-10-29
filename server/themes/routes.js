'use strict';
const cache = require('openvibe-shared/cache-policy');

// ═══════════════════════════════════════════════════════════════
// openvibe.network — Theme API Routes
// Central theme catalog accessible by all OpenVibe services.
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const jwt = require('jsonwebtoken');
const { cleanVariables } = require('./validate');
const router = express.Router();

// Community themes are reviewed before anyone else sees them (roadmap WS-E task 2): a submission is
// pending and private to its author until an admin approves it (GET/POST /api/admin/themes, reviewRouter
// below). Built-in themes and anything that existed before the review columns count as approved.
const EXPORT_FORMAT = 'openvibe-theme@1';
const MAX_PENDING = 5;
let reviewReady = false;
function ensureReview(db) { /* the schema is migrations/NNNN_*.sql (plan T2); nothing is created at runtime */ }
const parseTheme = (t) => {
    if (!t) return t;
    try { t.variables = JSON.parse(t.variables); } catch { t.variables = {}; }
    try { t.tags = JSON.parse(t.tags); } catch { t.tags = []; }
    try { t.preview_colors = t.preview_colors ? JSON.parse(t.preview_colors) : null; } catch { t.preview_colors = null; }
    return t;
};
const visibleTo = (t, userId) => t && ((t.is_public === 1 && t.review_status === 'approved') || (userId != null && String(t.author_id) === String(userId)));

function getDb(req) { return req.app.locals.db; }
function getConfig(req) { return req.app.locals.config; }

async function optionalAuth(req, res, next) {
    // Sliding sessions (server/auth/session.js): renewable tokens count, and get renewed.
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : req.cookies?.ov_token;
    if (!token) return next();
    try {
        const { verifySession, COOKIE } = require('../auth/session');
        const out = await verifySession(token, { db: await getDb(req), publicKey: req.app.locals.publicKey, config: req.app.locals.config });
        if (out.error) return next();
        // Routes here read both req.user.sub (JWT shape) and req.user.id (row shape) — give them both.
        req.user = { ...out.decoded, ...out.user, sub: out.user.id, id: out.user.id }; req.token = token;
        if (out.renew) {
            try { const fresh = require('../auth/routes').signToken(out.user, req.app.locals.privateKey, req.app.locals.config, { renew: out.decoded }); res.cookie('ov_token', fresh, COOKIE); res.set('X-OV-Token', fresh); res.set('Access-Control-Expose-Headers', 'X-OV-Token'); } catch { /* */ }
        }
    } catch { /* treat as anonymous */ }
    next();
}

async function requireAuth(req, res, next) {
    await optionalAuth(req, res, () => {
        if (!req.user) return res.status(401).json({ error: 'Authentication required' });
        next();
    });
}

// ── List Themes ──────────────────────────────────────────────
router.get('/', async (req, res) => {
    const db = await getDb(req);
    ensureReview(db);
    const { mode, search, sort, limit } = req.query;

    let sql = "SELECT id, name, slug, description, mode, variables, preview_colors, is_builtin, downloads, rating_sum, rating_count, tags FROM themes WHERE is_public = 1 AND review_status = 'approved'";
    const params = [];

    if (mode && (mode === 'dark' || mode === 'light')) {
        sql += ' AND mode = ?';
        params.push(mode);
    }
    if (search) {
        sql += ' AND (name LIKE ? OR description LIKE ?)';
        params.push(`%${search}%`, `%${search}%`);
    }

    const sortBy = sort === 'downloads' ? 'downloads DESC' : sort === 'rating' ? '(CAST(rating_sum AS REAL) / MAX(rating_count, 1)) DESC' : 'is_builtin DESC, name ASC';
    sql += ` ORDER BY ${sortBy}`;
    sql += ` LIMIT ?`;
    params.push(Math.min(parseInt(limit, 10) || 100, 500));

    const themes = await db.prepare(sql).all(...params);
    const seasonOf = new Map(seasonList().map((s) => [s.theme, s]));
    for (const t of themes) {
        try { t.variables = JSON.parse(t.variables); } catch { t.variables = {}; }
        try { t.preview_colors = JSON.parse(t.preview_colors); } catch { t.preview_colors = null; }
        try { t.tags = JSON.parse(t.tags); } catch { t.tags = []; }
        const s = seasonOf.get(t.id) || seasonOf.get(t.slug);
        if (s) t.season = { id: s.id, name: s.name, from: s.from, to: s.to };
    }
    res.json({ themes });
});

// ── Seasons: which theme stands in for the default theme when (openvibe-shared builtin-themes SEASONS) ──
// GET /api/themes/seasons[?date=YYYY-MM-DD] → { seasons: [{ id, name, theme, light?, from, to }], now: { id, name, theme, light? } | null }
// (theme: the dark half; light: its light half, from openvibe-shared 4.12)
// from/to are MM-DD, both days included, in the visitor's own calendar (the browser decides; `now` here is for the date
// given, else today in UTC). Anyone on the default theme who has not turned seasonal themes off (display `seasonal`) sees
// the season's theme, and every OpenVibe mark wears the season (theme-loader.js, ov-mark.js).
function seasonList() { return (require('openvibe-shared/builtin-themes').SEASONS || []).map((s) => ({ id: s.id, name: s.name, theme: s.theme, ...(s.light ? { light: s.light } : {}), from: s.from, to: s.to })); }
function seasonOn(md, list) { return list.find((s) => (s.from <= s.to ? md >= s.from && md <= s.to : md >= s.from || md <= s.to)) || null; }
router.get('/seasons', (req, res) => {
    const list = seasonList();
    const asked = /^\d{4}-(\d{2})-(\d{2})$/.exec(String(req.query.date || ''));
    const md = asked ? `${asked[1]}-${asked[2]}` : new Date().toISOString().slice(5, 10);
    const now = seasonOn(md, list);
    res.set('Cache-Control', 'public, max-age=3600').json({ seasons: list, now: now ? { id: now.id, name: now.name, theme: now.theme, ...(now.light ? { light: now.light } : {}) } : null });
});

// ── Per-site theme overrides (the design overhaul, pillar A) ──
// One theme follows a person to every site; an override is their exception for one service ("Games in Neon Tokyo",
// "Live in Daylight"). The service id is the one the sites use: lower case, digits and hyphens.
const SERVICE_ID = /^[a-z][a-z0-9-]{1,31}$/;
const MAX_OVERRIDES = 50;
const serviceId = (s) => (typeof s === 'string' && SERVICE_ID.test(s) ? s : null);
/** A theme's custom variables as they are stored: jsonb in the overrides, text everywhere else. */
const varsOf = (v) => {
    if (v == null) return null;
    if (typeof v === 'string') { try { return JSON.parse(v); } catch { return null; } }
    return v;
};
/** The person's override for one service, or null. */
async function overrideOf(db, userId, service) {
    try {
        return await db.prepare('SELECT theme_id, custom_variables FROM user_theme_site_overrides WHERE user_id = ? AND service = ?').get(userId, service) || null;
    } catch { return null; /* the table arrives with migration 0028 */ }
}

// ── Get User's Active Theme ──────────────────────────────────
// A request with no credentials at all is a guest asking "do I have a theme?": answer "no" with
// a 200 so every page view by a guest does not log a failed request in the console.
router.get('/me/active', (req, res, next) => {
    const hasAuth = /^Bearer\s+\S/.test(req.headers.authorization || '') || /(?:^|;\s*)ov_token=/.test(req.headers.cookie || '');
    if (!hasAuth) return res.set('Cache-Control', 'no-store').json({ theme_id: null, guest: true });
    next();
}, requireAuth, async (req, res) => {
    const db = await getDb(req);
    const userId = req.user.sub || req.user.id;
    // A site asks for its own look ("Games in Neon Tokyo"): the person's override for that service, when they have one.
    // A missing or unknown service answers exactly as it always did.
    const service = serviceId(req.query.service);
    const override = service ? await overrideOf(db, userId, service) : null;

    const prefs = await db.prepare('SELECT theme_id, custom_theme_variables FROM user_preferences WHERE user_id = ?').get(userId);
    let display = null;
    try { const d = await db.prepare('SELECT display_prefs FROM user_preferences WHERE user_id = ?').get(userId); display = cleanDisplay(d && d.display_prefs ? JSON.parse(d.display_prefs) : null); } catch { /* column arrives with the migration */ }
    if (override) return res.json({ theme_id: override.theme_id, custom_variables: varsOf(override.custom_variables), display, override: true, service });
    if (!prefs) return res.json({ theme_id: 'vibe', custom_variables: null, override: false });

    let custom = null;
    try { custom = prefs.custom_theme_variables ? JSON.parse(prefs.custom_theme_variables) : null; } catch {}
    res.json({ theme_id: prefs.theme_id, custom_variables: custom, display, override: false });
});

// ── Display preferences — follow the account to every site ──
// seasonal: the season's theme (openvibe-shared theme-loader Seasons: Pumpkin Night in October, Frost in December) in place
// of the default theme, unless 'off' (the owner, 2026-10-24: "users can opt out … and just want their normal default").
// scheme: 'manual' (the picked theme as it is) or 'auto' (its light or dark half, as the device is set; openvibe-shared
// theme-loader Light / Dark / Auto, 2026-10-25).
// contrast: increase contrast for easier reading.
// font: use the readable typeface across sites.
// colors: choose colors designed to be safe for color blindness.
// oled: use pure black backgrounds on OLED displays.
const DISPLAY = { motion: ['auto', 'reduced'], text: ['100', '112', '125'], seasonal: ['on', 'off'], scheme: ['manual', 'auto'], contrast: ['normal', 'more'], font: ['default', 'readable'], colors: ['default', 'cb-safe'], oled: ['off', 'on'] };
function cleanDisplay(d) {
    if (!d || typeof d !== 'object') return null;
    const out = {};
    for (const k of Object.keys(DISPLAY)) if (DISPLAY[k].includes(String(d[k]))) out[k] = String(d[k]);
    return Object.keys(out).length ? out : null;
}
router.put('/me/display', requireAuth, async (req, res) => {
    const db = await getDb(req);
    const userId = req.user.sub || req.user.id;
    const display = cleanDisplay(req.body) || {};
    await db.prepare(`INSERT INTO user_preferences (user_id, display_prefs, updated_at) VALUES (?, ?, ov_now())
        ON CONFLICT(user_id) DO UPDATE SET display_prefs = excluded.display_prefs, updated_at = ov_now()`).run(userId, JSON.stringify(display));
    res.json({ ok: true, display });
});

// ── Your submissions, with their review status ────────────────
router.get('/me/submissions', requireAuth, async (req, res) => {
    const db = await getDb(req);
    ensureReview(db);
    const userId = req.user.sub || req.user.id;
    const themes = (await db.prepare('SELECT id, name, slug, description, mode, variables, tags, review_status, review_note, reviewed_at, created_at FROM themes WHERE author_id = ? AND is_builtin = 0 ORDER BY created_at DESC LIMIT 50').all(userId)).map(parseTheme);
    res.set('Cache-Control', cache.htmlHeaders({ private: true })).json({ themes });
});

// Themes that no longer exist but are still named in old preferences or cached pages, and the built-in each became.
// 'campfire' came from the August import of Live's theme system and was never a Network theme (59 people had it,
// 2026-10-15; migrations/0024 moves their preferences): a request for it lands on 'ember' instead of a 404 on every page.
const RETIRED_THEMES = Object.freeze({ campfire: 'ember' });

// ── Get Theme by ID or Slug (approved themes; your own at any status) ──
router.get('/:idOrSlug', optionalAuth, async (req, res) => {
    const db = await getDb(req);
    ensureReview(db);
    if (Object.hasOwn(RETIRED_THEMES, req.params.idOrSlug)) return res.redirect(301, `${req.baseUrl}/${RETIRED_THEMES[req.params.idOrSlug]}`);
    const theme = await db.prepare('SELECT * FROM themes WHERE id = ? OR slug = ?').get(req.params.idOrSlug, req.params.idOrSlug);
    if (!visibleTo(theme, req.user && (req.user.sub || req.user.id))) return res.status(404).json({ error: 'Theme not found' });
    res.json({ theme: parseTheme(theme) });
});

// ── Export a theme as a file (import it elsewhere, or submit an edited copy) ──
router.get('/:idOrSlug/export', optionalAuth, async (req, res) => {
    const db = await getDb(req);
    ensureReview(db);
    const t = await db.prepare('SELECT * FROM themes WHERE id = ? OR slug = ?').get(req.params.idOrSlug, req.params.idOrSlug);
    if (!visibleTo(t, req.user && (req.user.sub || req.user.id))) return res.status(404).json({ error: 'Theme not found' });
    parseTheme(t);
    const file = { format: EXPORT_FORMAT, name: t.name, slug: t.slug, description: t.description || '', mode: t.mode, variables: t.variables, tags: t.tags };
    res.set('Content-Disposition', `attachment; filename="${t.slug}.openvibe-theme.json"`).json(file);
});

// ── Set User's Active Theme ──────────────────────────────────
router.put('/me', requireAuth, async (req, res) => {
    const db = await getDb(req);
    const userId = req.user.sub || req.user.id;
    const { theme_id, custom_variables } = req.body;

    ensureReview(db);
    if (theme_id) {
        const theme = await db.prepare('SELECT id, author_id, is_public, review_status FROM themes WHERE id = ? OR slug = ?').get(theme_id, theme_id);
        if (!visibleTo(theme, userId)) return res.status(404).json({ error: 'Theme not found' });
    }
    if (custom_variables) {
        const v = cleanVariables(custom_variables);
        if (!v.ok) return res.status(422).json({ error: 'Custom colours rejected', code: 'theme.invalid_variables', errors: v.errors });
        req.body.custom_variables = v.variables;
    }

    // Keep what this change replaces, so the person can go back to it (the Design studio's history and rollback).
    await keepHistory(db, userId, req.body && req.body.source, { theme_id: theme_id || null, custom: req.body.custom_variables ? JSON.stringify(req.body.custom_variables) : null });

    await db.prepare(`
        INSERT INTO user_preferences (user_id, theme_id, custom_theme_variables, updated_at)
        VALUES (?, ?, ?, ov_now())
        ON CONFLICT(user_id) DO UPDATE SET
            theme_id = COALESCE(?, user_preferences.theme_id),
            custom_theme_variables = ?,
            updated_at = ov_now()
    `).run(
        userId,
        theme_id || 'vibe',
        req.body.custom_variables ? JSON.stringify(req.body.custom_variables) : null,
        theme_id || null,
        req.body.custom_variables ? JSON.stringify(req.body.custom_variables) : null
    );

    res.json({ success: true, theme_id, custom_variables: req.body.custom_variables || null });
});

// ── Per-site theme overrides ─────────────────────────────────
// The person's own list, one theme per service. A site asks for its service id (GET /me/active?service=games) and
// gets that theme; every other site, and every service without an override, keeps the person's global theme.
router.get('/me/overrides', requireAuth, async (req, res) => {
    const db = await getDb(req);
    const userId = req.user.sub || req.user.id;
    const rows = await db.prepare('SELECT service, theme_id, custom_variables, updated_at FROM user_theme_site_overrides WHERE user_id = ? ORDER BY service').all(userId);
    const names = new Map();
    for (const id of [...new Set(rows.map((r) => r.theme_id))]) { const t = await db.prepare('SELECT name FROM themes WHERE id = ?').get(id); if (t) names.set(id, t.name); }
    res.set('Cache-Control', 'private, no-store').json({
        overrides: rows.map((r) => ({ service: r.service, theme_id: r.theme_id, theme_name: names.get(r.theme_id) || null, custom_variables: varsOf(r.custom_variables), updated_at: r.updated_at })),
    });
});

// Set one site's theme. The theme is validated exactly as PUT /me does it: a theme the person may not see is a 404,
// and custom colours are the same allow-list.
router.put('/me/overrides/:service', requireAuth, async (req, res) => {
    const db = await getDb(req);
    const userId = req.user.sub || req.user.id;
    const service = serviceId(req.params.service);
    if (!service) return res.status(400).json({ error: 'service must be a service id like live or games', code: 'theme.bad_service' });
    const { theme_id, custom_variables } = req.body || {};
    if (!theme_id) return res.status(400).json({ error: 'theme_id is required', code: 'theme.missing_theme' });

    ensureReview(db);
    const theme = await db.prepare('SELECT id, author_id, is_public, review_status FROM themes WHERE id = ? OR slug = ?').get(theme_id, theme_id);
    if (!visibleTo(theme, userId)) return res.status(404).json({ error: 'Theme not found' });
    let vars = null;
    if (custom_variables) {
        const v = cleanVariables(custom_variables);
        if (!v.ok) return res.status(422).json({ error: 'Custom colours rejected', code: 'theme.invalid_variables', errors: v.errors });
        vars = v.variables;
    }

    const existing = await db.prepare('SELECT theme_id, custom_variables FROM user_theme_site_overrides WHERE user_id = ? AND service = ?').get(userId, service);
    if (!existing) {
        const n = (await db.prepare('SELECT COUNT(*) AS n FROM user_theme_site_overrides WHERE user_id = ?').get(userId)).n;
        if (n >= MAX_OVERRIDES) return res.status(429).json({ error: `You have ${n} site overrides; at most ${MAX_OVERRIDES} are kept`, code: 'theme.too_many_overrides' });
    }

    // Keep what this change replaces for that site, as every other theme change does, with the service recorded.
    const replaced = existing || (await db.prepare('SELECT theme_id, custom_theme_variables FROM user_preferences WHERE user_id = ?').get(userId));
    if (replaced && replaced.theme_id) await recordHistory(db, userId, { theme_id: replaced.theme_id, custom: existing ? existing.custom_variables : replaced.custom_theme_variables }, service);

    await db.prepare(`INSERT INTO user_theme_site_overrides (user_id, service, theme_id, custom_variables, updated_at)
        VALUES (?, ?, ?, ?::jsonb, ov_now())
        ON CONFLICT(user_id, service) DO UPDATE SET theme_id = excluded.theme_id, custom_variables = excluded.custom_variables, updated_at = ov_now()`)
        .run(userId, service, theme_id, vars ? JSON.stringify(vars) : null);
    res.json({ success: true, service, theme_id, custom_variables: vars, override: true });
});

// Remove one site's override: that site falls back to the person's global theme again.
router.delete('/me/overrides/:service', requireAuth, async (req, res) => {
    const db = await getDb(req);
    const userId = req.user.sub || req.user.id;
    const service = serviceId(req.params.service);
    if (!service) return res.status(400).json({ error: 'service must be a service id like live or games', code: 'theme.bad_service' });
    const existing = await db.prepare('SELECT theme_id, custom_variables FROM user_theme_site_overrides WHERE user_id = ? AND service = ?').get(userId, service);
    if (!existing) return res.status(404).json({ error: 'No override for that service', code: 'theme.override_not_found' });
    // The override that is gone is kept in the history, with the service recorded, like any other theme change.
    await recordHistory(db, userId, { theme_id: existing.theme_id, custom: existing.custom_variables }, service);
    await db.prepare('DELETE FROM user_theme_site_overrides WHERE user_id = ? AND service = ?').run(userId, service);
    res.json({ success: true, service, deleted: true });
});

// ── History and rollback (plan 2026-10-28 §5.2) ───────────────
// Every change through PUT /me keeps the setting it replaced (the last 50 per person); a restore is itself a change, so
// it can be undone the same way. Nothing here is public: a person reads only their own history.
const HISTORY_KEEP = 50;
/** Keep the last HISTORY_KEEP changes of one person. */
async function trimHistory(db, userId) {
    await db.prepare(`DELETE FROM user_theme_history WHERE user_id = ? AND id NOT IN (
        SELECT id FROM user_theme_history WHERE user_id = ? ORDER BY id DESC LIMIT ${HISTORY_KEEP})`).run(userId, userId);
}
/** Keep the current setting before `next` replaces it ({ theme_id (null: unchanged), custom }); nothing when nothing changes. */
async function keepHistory(db, userId, source, next) {
    const cur = await db.prepare('SELECT theme_id, custom_theme_variables FROM user_preferences WHERE user_id = ?').get(userId);
    if (!cur || !cur.theme_id) return;
    if ((next.theme_id || cur.theme_id) === cur.theme_id && (next.custom || null) === (cur.custom_theme_variables || null)) return;
    const src = typeof source === 'string' && /^[a-z][a-z0-9-]{0,23}$/.test(source) ? source : null;
    await db.prepare('INSERT INTO user_theme_history (user_id, theme_id, custom_theme_variables, source) VALUES (?, ?, ?, ?)').run(userId, cur.theme_id, cur.custom_theme_variables || null, src);
    await trimHistory(db, userId);
}
/** Keep what a change replaces in the history, with the service it applies to as the source (a site override). */
async function recordHistory(db, userId, { theme_id, custom }, source) {
    if (!theme_id) return;
    const vars = custom == null ? null : (typeof custom === 'string' ? custom : JSON.stringify(custom));
    await db.prepare('INSERT INTO user_theme_history (user_id, theme_id, custom_theme_variables, source) VALUES (?, ?, ?, ?)').run(userId, theme_id, vars, source);
    await trimHistory(db, userId);
}
const historyRow = (r, names) => {
    let vars = null;
    try { vars = r.custom_theme_variables ? JSON.parse(r.custom_theme_variables) : null; } catch { vars = null; }
    return { id: Number(r.id), theme_id: r.theme_id, theme_name: names.get(r.theme_id) || null, custom_variables: vars, source: r.source || null, created_at: r.created_at };
};

router.get('/me/history', requireAuth, async (req, res) => {
    const db = await getDb(req);
    const userId = req.user.sub || req.user.id;
    const rows = await db.prepare(`SELECT id, theme_id, custom_theme_variables, source, created_at FROM user_theme_history WHERE user_id = ? ORDER BY id DESC LIMIT ${HISTORY_KEEP}`).all(userId);
    const ids = [...new Set(rows.map((r) => r.theme_id))];
    const names = new Map();
    for (const id of ids) { const t = await db.prepare('SELECT name FROM themes WHERE id = ?').get(id); if (t) names.set(id, t.name); }
    res.set('Cache-Control', 'private, no-store').json({ history: rows.map((r) => historyRow(r, names)) });
});

router.post('/me/history/:id/restore', requireAuth, async (req, res) => {
    const db = await getDb(req);
    const userId = req.user.sub || req.user.id;
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Bad history id', code: 'theme.bad_history' });
    const row = await db.prepare('SELECT theme_id, custom_theme_variables FROM user_theme_history WHERE id = ? AND user_id = ?').get(id, userId);
    if (!row) return res.status(404).json({ error: 'No such change in your history', code: 'theme.history_not_found' });
    const theme = await db.prepare('SELECT id, author_id, is_public, review_status FROM themes WHERE id = ?').get(row.theme_id);
    if (!visibleTo(theme, userId)) return res.status(409).json({ error: 'That theme is no longer available', code: 'theme.gone' });
    await keepHistory(db, userId, 'restore', { theme_id: row.theme_id, custom: row.custom_theme_variables || null });
    await db.prepare(`INSERT INTO user_preferences (user_id, theme_id, custom_theme_variables, updated_at) VALUES (?, ?, ?, ov_now())
        ON CONFLICT(user_id) DO UPDATE SET theme_id = ?, custom_theme_variables = ?, updated_at = ov_now()`)
        .run(userId, row.theme_id, row.custom_theme_variables || null, row.theme_id, row.custom_theme_variables || null);
    let vars = null; try { vars = row.custom_theme_variables ? JSON.parse(row.custom_theme_variables) : null; } catch { vars = null; }
    res.json({ success: true, theme_id: row.theme_id, custom_variables: vars });
});

// ── Submit a community theme (pending review) ─────────────────
async function submitTheme(db, userId, body) {
    ensureReview(db);
    const { name, slug, description, mode, variables, tags } = body || {};
    if (!name || !slug || !variables) return [400, { error: 'name, slug, and variables required' }];
    if (typeof name !== 'string' || name.trim().length < 2 || name.length > 60) return [400, { error: 'name is 2 to 60 characters' }];
    if (typeof slug !== 'string' || !/^[a-z0-9-]{2,48}$/.test(slug)) return [400, { error: 'slug must be lowercase alphanumeric with hyphens' }];
    if (mode && mode !== 'dark' && mode !== 'light') return [400, { error: 'mode is dark or light' }];
    const v = cleanVariables(variables);
    if (!v.ok) return [422, { error: 'Theme rejected', code: 'theme.invalid_variables', errors: v.errors }];
    const cleanTags = Array.isArray(tags) ? tags.filter((t) => typeof t === 'string' && /^[a-z0-9-]{1,24}$/.test(t)).slice(0, 8) : [];
    if (await db.prepare('SELECT id FROM themes WHERE slug = ?').get(slug)) return [409, { error: 'A theme with that slug already exists' }];
    const pending = (await db.prepare("SELECT COUNT(*) AS n FROM themes WHERE author_id = ? AND review_status = 'pending'").get(userId)).n;
    if (pending >= MAX_PENDING) return [429, { error: `You have ${pending} themes waiting for review; wait for those first`, code: 'theme.too_many_pending' }];
    const id = `community-${slug}`;
    await db.prepare(`INSERT INTO themes (id, name, slug, author_id, description, mode, variables, is_builtin, is_public, tags, review_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 'pending')`)
        .run(id, name.trim(), slug, userId, String(description || '').slice(0, 300), mode || 'dark', JSON.stringify(v.variables), JSON.stringify(cleanTags));
    return [201, { theme: parseTheme(await db.prepare('SELECT * FROM themes WHERE id = ?').get(id)), review: 'pending', note: 'Submitted themes are reviewed before anyone else sees them. You can use yours right away.' }];
}

router.post('/', requireAuth, async (req, res) => {
    const [status, body] = await submitTheme(await getDb(req), req.user.sub || req.user.id, req.body);
    res.status(status).json(body);
});

// ── Import a theme file (openvibe-theme@1, as /:id/export writes it): a submission like any other ──
router.post('/import', requireAuth, async (req, res) => {
    const file = req.body || {};
    if (file.format !== EXPORT_FORMAT) return res.status(400).json({ error: `Not an ${EXPORT_FORMAT} file`, code: 'theme.bad_format' });
    const [status, body] = await submitTheme(await getDb(req), req.user.sub || req.user.id, file);
    res.status(status).json(body);
});

// ── Review queue (admins; mounted at /api/admin/themes behind requireAuth + requireAdmin) ──
function reviewRouter() {
    const r = express.Router();
    r.get('/', async (req, res) => {
        const db = await getDb(req);
        ensureReview(db);
        const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
        const themes = (await db.prepare(`SELECT t.id, t.name, t.slug, t.description, t.mode, t.variables, t.tags, t.review_status, t.review_note, t.reviewed_at, t.created_at, u.username AS author
            FROM themes t LEFT JOIN users u ON u.id = t.author_id WHERE t.is_builtin = 0 AND t.review_status = ? ORDER BY t.created_at ASC LIMIT 200`).all(status)).map(parseTheme);
        res.set('Cache-Control', cache.htmlHeaders({ private: true })).json({ status, themes });
    });
    r.post('/:id/review', async (req, res) => {
        const db = await getDb(req);
        ensureReview(db);
        const decision = req.body && req.body.decision;
        if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ error: 'decision is approve or reject' });
        const note = String((req.body && req.body.note) || '').slice(0, 300) || null;
        if (decision === 'reject' && !note) return res.status(400).json({ error: 'Say why it is rejected (note)', code: 'theme.note_required' });
        const t = await db.prepare('SELECT id, is_builtin FROM themes WHERE id = ?').get(req.params.id);
        if (!t || t.is_builtin) return res.status(404).json({ error: 'No such community theme' });
        await db.prepare("UPDATE themes SET review_status = ?, is_public = ?, reviewed_by = ?, reviewed_at = ov_now(), review_note = ?, updated_at = ov_now() WHERE id = ?")
            .run(decision === 'approve' ? 'approved' : 'rejected', decision === 'approve' ? 1 : 0, req.user.id || req.user.sub, note, t.id);
        res.json({ theme: parseTheme(await db.prepare('SELECT * FROM themes WHERE id = ?').get(t.id)) });
    });
    return r;
}

module.exports = router;
module.exports.reviewRouter = reviewRouter;
module.exports.submitTheme = submitTheme;
