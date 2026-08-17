'use strict';

// ═══════════════════════════════════════════════════════════════
// openvibe.network — Theme API Routes
// Central theme catalog accessible by all OpenVibe services.
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();

function getDb(req) { return req.app.locals.db; }
function getConfig(req) { return req.app.locals.config; }

function optionalAuth(req, _res, next) {
    const token = req.headers.authorization?.startsWith('Bearer ')
        ? req.headers.authorization.slice(7)
        : req.cookies?.ov_token;
    if (token) {
        const config = getConfig(req);
        const publicKey = req.app.locals.publicKey;
        const algorithm = publicKey.includes('BEGIN') ? 'RS256' : 'HS256';
        try {
            const decoded = jwt.verify(token, publicKey, { algorithms: [algorithm], issuer: config.jwt.issuer });
            req.user = decoded;
        } catch { /* not authenticated, continue */ }
    }
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
    const { mode, search, sort, limit } = req.query;

    let sql = 'SELECT id, name, slug, description, mode, variables, preview_colors, is_builtin, downloads, rating_sum, rating_count, tags FROM themes WHERE is_public = 1';
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
router.get('/me/active', requireAuth, (req, res) => {
    const db = getDb(req);
    const userId = req.user.sub || req.user.id;
    const prefs = db.prepare('SELECT theme_id, custom_theme_variables FROM user_preferences WHERE user_id = ?').get(userId);
    if (!prefs) return res.json({ theme_id: 'vibe', custom_variables: null });

    let custom = null;
    try { custom = prefs.custom_theme_variables ? JSON.parse(prefs.custom_theme_variables) : null; } catch {}
    res.json({ theme_id: prefs.theme_id, custom_variables: custom });
});

// ── Get Theme by ID or Slug ──────────────────────────────────
router.get('/:idOrSlug', (req, res) => {
    const db = getDb(req);
    const theme = db.prepare('SELECT * FROM themes WHERE id = ? OR slug = ?').get(req.params.idOrSlug, req.params.idOrSlug);
    if (!theme) return res.status(404).json({ error: 'Theme not found' });
    try { theme.variables = JSON.parse(theme.variables); } catch { theme.variables = {}; }
    try { theme.tags = JSON.parse(theme.tags); } catch { theme.tags = []; }
    res.json({ theme });
});

// ── Set User's Active Theme ──────────────────────────────────
router.put('/me', requireAuth, (req, res) => {
    const db = getDb(req);
    const userId = req.user.sub || req.user.id;
    const { theme_id, custom_variables } = req.body;

    if (theme_id) {
        const theme = db.prepare('SELECT id FROM themes WHERE id = ? OR slug = ?').get(theme_id, theme_id);
        if (!theme) return res.status(404).json({ error: 'Theme not found' });
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
        custom_variables ? JSON.stringify(custom_variables) : null,
        theme_id || null,
        custom_variables ? JSON.stringify(custom_variables) : null
    );

    res.json({ success: true, theme_id, custom_variables });
});

// ── Submit Community Theme ───────────────────────────────────
router.post('/', requireAuth, (req, res) => {
    const db = getDb(req);
    const userId = req.user.sub || req.user.id;
    const { name, slug, description, mode, variables, tags } = req.body;

    if (!name || !slug || !variables) return res.status(400).json({ error: 'name, slug, and variables required' });
    if (typeof variables !== 'object') return res.status(400).json({ error: 'variables must be an object' });
    if (!/^[a-z0-9-]+$/.test(slug)) return res.status(400).json({ error: 'slug must be lowercase alphanumeric with hyphens' });

    const existing = db.prepare('SELECT id FROM themes WHERE slug = ?').get(slug);
    if (existing) return res.status(409).json({ error: 'A theme with that slug already exists' });

    const id = `community-${slug}`;
    db.prepare(`
        INSERT INTO themes (id, name, slug, author_id, description, mode, variables, is_builtin, is_public, tags)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, ?)
    `).run(id, name, slug, userId, description || '', mode || 'dark', JSON.stringify(variables), JSON.stringify(tags || []));

    const theme = db.prepare('SELECT * FROM themes WHERE id = ?').get(id);
    try { theme.variables = JSON.parse(theme.variables); } catch {}
    res.status(201).json({ theme });
});

module.exports = router;
