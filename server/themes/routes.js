'use strict';

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
function ensureReview(db) {
    if (reviewReady) return;
    for (const col of ["review_status TEXT NOT NULL DEFAULT 'approved'", 'reviewed_by INTEGER', 'reviewed_at DATETIME', 'review_note TEXT']) {
        try { db.exec(`ALTER TABLE themes ADD COLUMN ${col}`); } catch { /* already there */ }
    }
    reviewReady = true;
}
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

function optionalAuth(req, res, next) {
    // Sliding sessions (server/auth/session.js): renewable tokens count, and get renewed.
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : req.cookies?.ov_token;
    if (!token) return next();
    try {
        const { verifySession, COOKIE } = require('../auth/session');
        const out = verifySession(token, { db: getDb(req), publicKey: req.app.locals.publicKey, config: req.app.locals.config });
        if (out.error) return next();
        // Routes here read both req.user.sub (JWT shape) and req.user.id (row shape) — give them both.
        req.user = { ...out.decoded, ...out.user, sub: out.user.id, id: out.user.id }; req.token = token;
        if (out.renew) {
            try { const fresh = require('../auth/routes').signToken(out.user, req.app.locals.privateKey, req.app.locals.config); res.cookie('ov_token', fresh, COOKIE); res.set('X-OV-Token', fresh); res.set('Access-Control-Expose-Headers', 'X-OV-Token'); } catch { /* */ }
        }
    } catch { /* treat as anonymous */ }
    next();
}

function requireAuth(req, res, next) {
    optionalAuth(req, res, () => {
        if (!req.user) return res.status(401).json({ error: 'Authentication required' });
        next();
    });
}

// ── List Themes ──────────────────────────────────────────────
router.get('/', (req, res) => {
    const db = getDb(req);
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

    const themes = db.prepare(sql).all(...params);
    for (const t of themes) {
        try { t.variables = JSON.parse(t.variables); } catch { t.variables = {}; }
        try { t.preview_colors = JSON.parse(t.preview_colors); } catch { t.preview_colors = null; }
        try { t.tags = JSON.parse(t.tags); } catch { t.tags = []; }
    }
    res.json({ themes });
});

// ── Get User's Active Theme ──────────────────────────────────
// A request with no credentials at all is a guest asking "do I have a theme?": answer "no" with
// a 200 so every page view by a guest does not log a failed request in the console.
router.get('/me/active', (req, res, next) => {
    const hasAuth = /^Bearer\s+\S/.test(req.headers.authorization || '') || /(?:^|;\s*)ov_token=/.test(req.headers.cookie || '');
    if (!hasAuth) return res.set('Cache-Control', 'no-store').json({ theme_id: null, guest: true });
    next();
}, requireAuth, (req, res) => {
    const db = getDb(req);
    const userId = req.user.sub || req.user.id;
    const prefs = db.prepare('SELECT theme_id, custom_theme_variables FROM user_preferences WHERE user_id = ?').get(userId);
    if (!prefs) return res.json({ theme_id: 'vibe', custom_variables: null });

    let custom = null;
    try { custom = prefs.custom_theme_variables ? JSON.parse(prefs.custom_theme_variables) : null; } catch {}
    let display = null;
    try { const d = db.prepare('SELECT display_prefs FROM user_preferences WHERE user_id = ?').get(userId); display = cleanDisplay(d && d.display_prefs ? JSON.parse(d.display_prefs) : null); } catch { /* column arrives with the migration */ }
    res.json({ theme_id: prefs.theme_id, custom_variables: custom, display });
});

// ── Display preferences (motion, text size) — follow the account to every site ──
const DISPLAY = { motion: ['auto', 'reduced'], text: ['100', '112', '125'] };
function cleanDisplay(d) {
    if (!d || typeof d !== 'object') return null;
    const out = {};
    for (const k of Object.keys(DISPLAY)) if (DISPLAY[k].includes(String(d[k]))) out[k] = String(d[k]);
    return Object.keys(out).length ? out : null;
}
router.put('/me/display', requireAuth, (req, res) => {
    const db = getDb(req);
    const userId = req.user.sub || req.user.id;
    const display = cleanDisplay(req.body) || {};
    db.prepare(`INSERT INTO user_preferences (user_id, display_prefs, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id) DO UPDATE SET display_prefs = excluded.display_prefs, updated_at = CURRENT_TIMESTAMP`).run(userId, JSON.stringify(display));
    res.json({ ok: true, display });
});

// ── Your submissions, with their review status ────────────────
router.get('/me/submissions', requireAuth, (req, res) => {
    const db = getDb(req);
    ensureReview(db);
    const userId = req.user.sub || req.user.id;
    const themes = db.prepare('SELECT id, name, slug, description, mode, variables, tags, review_status, review_note, reviewed_at, created_at FROM themes WHERE author_id = ? AND is_builtin = 0 ORDER BY created_at DESC LIMIT 50').all(userId).map(parseTheme);
    res.set('Cache-Control', 'private, no-store').json({ themes });
});

// ── Get Theme by ID or Slug (approved themes; your own at any status) ──
router.get('/:idOrSlug', optionalAuth, (req, res) => {
    const db = getDb(req);
    ensureReview(db);
    const theme = db.prepare('SELECT * FROM themes WHERE id = ? OR slug = ?').get(req.params.idOrSlug, req.params.idOrSlug);
    if (!visibleTo(theme, req.user && (req.user.sub || req.user.id))) return res.status(404).json({ error: 'Theme not found' });
    res.json({ theme: parseTheme(theme) });
});

// ── Export a theme as a file (import it elsewhere, or submit an edited copy) ──
router.get('/:idOrSlug/export', optionalAuth, (req, res) => {
    const db = getDb(req);
    ensureReview(db);
    const t = db.prepare('SELECT * FROM themes WHERE id = ? OR slug = ?').get(req.params.idOrSlug, req.params.idOrSlug);
    if (!visibleTo(t, req.user && (req.user.sub || req.user.id))) return res.status(404).json({ error: 'Theme not found' });
    parseTheme(t);
    const file = { format: EXPORT_FORMAT, name: t.name, slug: t.slug, description: t.description || '', mode: t.mode, variables: t.variables, tags: t.tags };
    res.set('Content-Disposition', `attachment; filename="${t.slug}.openvibe-theme.json"`).json(file);
});

// ── Set User's Active Theme ──────────────────────────────────
router.put('/me', requireAuth, (req, res) => {
    const db = getDb(req);
    const userId = req.user.sub || req.user.id;
    const { theme_id, custom_variables } = req.body;

    ensureReview(db);
    if (theme_id) {
        const theme = db.prepare('SELECT id, author_id, is_public, review_status FROM themes WHERE id = ? OR slug = ?').get(theme_id, theme_id);
        if (!visibleTo(theme, userId)) return res.status(404).json({ error: 'Theme not found' });
    }
    if (custom_variables) {
        const v = cleanVariables(custom_variables);
        if (!v.ok) return res.status(422).json({ error: 'Custom colours rejected', code: 'theme.invalid_variables', errors: v.errors });
        req.body.custom_variables = v.variables;
    }

    db.prepare(`
        INSERT INTO user_preferences (user_id, theme_id, custom_theme_variables, updated_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id) DO UPDATE SET
            theme_id = COALESCE(?, theme_id),
            custom_theme_variables = ?,
            updated_at = CURRENT_TIMESTAMP
    `).run(
        userId,
        theme_id || 'vibe',
        req.body.custom_variables ? JSON.stringify(req.body.custom_variables) : null,
        theme_id || null,
        req.body.custom_variables ? JSON.stringify(req.body.custom_variables) : null
    );

    res.json({ success: true, theme_id, custom_variables: req.body.custom_variables || null });
});

// ── Submit a community theme (pending review) ─────────────────
function submitTheme(db, userId, body) {
    ensureReview(db);
    const { name, slug, description, mode, variables, tags } = body || {};
    if (!name || !slug || !variables) return [400, { error: 'name, slug, and variables required' }];
    if (typeof name !== 'string' || name.trim().length < 2 || name.length > 60) return [400, { error: 'name is 2 to 60 characters' }];
    if (typeof slug !== 'string' || !/^[a-z0-9-]{2,48}$/.test(slug)) return [400, { error: 'slug must be lowercase alphanumeric with hyphens' }];
    if (mode && mode !== 'dark' && mode !== 'light') return [400, { error: 'mode is dark or light' }];
    const v = cleanVariables(variables);
    if (!v.ok) return [422, { error: 'Theme rejected', code: 'theme.invalid_variables', errors: v.errors }];
    const cleanTags = Array.isArray(tags) ? tags.filter((t) => typeof t === 'string' && /^[a-z0-9-]{1,24}$/.test(t)).slice(0, 8) : [];
    if (db.prepare('SELECT id FROM themes WHERE slug = ?').get(slug)) return [409, { error: 'A theme with that slug already exists' }];
    const pending = db.prepare("SELECT COUNT(*) AS n FROM themes WHERE author_id = ? AND review_status = 'pending'").get(userId).n;
    if (pending >= MAX_PENDING) return [429, { error: `You have ${pending} themes waiting for review; wait for those first`, code: 'theme.too_many_pending' }];
    const id = `community-${slug}`;
    db.prepare(`INSERT INTO themes (id, name, slug, author_id, description, mode, variables, is_builtin, is_public, tags, review_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 'pending')`)
        .run(id, name.trim(), slug, userId, String(description || '').slice(0, 300), mode || 'dark', JSON.stringify(v.variables), JSON.stringify(cleanTags));
    return [201, { theme: parseTheme(db.prepare('SELECT * FROM themes WHERE id = ?').get(id)), review: 'pending', note: 'Submitted themes are reviewed before anyone else sees them. You can use yours right away.' }];
}

router.post('/', requireAuth, (req, res) => {
    const [status, body] = submitTheme(getDb(req), req.user.sub || req.user.id, req.body);
    res.status(status).json(body);
});

// ── Import a theme file (openvibe-theme@1, as /:id/export writes it): a submission like any other ──
router.post('/import', requireAuth, (req, res) => {
    const file = req.body || {};
    if (file.format !== EXPORT_FORMAT) return res.status(400).json({ error: `Not an ${EXPORT_FORMAT} file`, code: 'theme.bad_format' });
    const [status, body] = submitTheme(getDb(req), req.user.sub || req.user.id, file);
    res.status(status).json(body);
});

// ── Review queue (admins; mounted at /api/admin/themes behind requireAuth + requireAdmin) ──
function reviewRouter() {
    const r = express.Router();
    r.get('/', (req, res) => {
        const db = getDb(req);
        ensureReview(db);
        const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
        const themes = db.prepare(`SELECT t.id, t.name, t.slug, t.description, t.mode, t.variables, t.tags, t.review_status, t.review_note, t.reviewed_at, t.created_at, u.username AS author
            FROM themes t LEFT JOIN users u ON u.id = t.author_id WHERE t.is_builtin = 0 AND t.review_status = ? ORDER BY t.created_at ASC LIMIT 200`).all(status).map(parseTheme);
        res.set('Cache-Control', 'private, no-store').json({ status, themes });
    });
    r.post('/:id/review', (req, res) => {
        const db = getDb(req);
        ensureReview(db);
        const decision = req.body && req.body.decision;
        if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ error: 'decision is approve or reject' });
        const note = String((req.body && req.body.note) || '').slice(0, 300) || null;
        if (decision === 'reject' && !note) return res.status(400).json({ error: 'Say why it is rejected (note)', code: 'theme.note_required' });
        const t = db.prepare('SELECT id, is_builtin FROM themes WHERE id = ?').get(req.params.id);
        if (!t || t.is_builtin) return res.status(404).json({ error: 'No such community theme' });
        db.prepare("UPDATE themes SET review_status = ?, is_public = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP, review_note = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
            .run(decision === 'approve' ? 'approved' : 'rejected', decision === 'approve' ? 1 : 0, req.user.id || req.user.sub, note, t.id);
        res.json({ theme: parseTheme(db.prepare('SELECT * FROM themes WHERE id = ?').get(t.id)) });
    });
    return r;
}

module.exports = router;
module.exports.reviewRouter = reviewRouter;
module.exports.submitTheme = submitTheme;
