'use strict';
/**
 * Label preferences (L1, labels and choices, 2026-10-31; contracts 0.257.0 network.label-prefs@1).
 *
 * The labels themselves are not a ban: a creator labels a stream, VOD, clip, picture or post, and each viewer
 * chooses what to do with that label on every OpenVibe site. The choice is one value per label — show, blur
 * (until tapped) or hide — and it lives in the person's existing site prefs (migration 0029's `site_prefs`),
 * so the site switcher and these prefs share one row without either dropping the other's keys.
 *
 *   mine(actor)          → { prefs: { <label>: 'show'|'blur'|'hide' } } (network.label-prefs@1)
 *   save(actor, prefs)   → the same shape, after replacing the person's choices
 *
 * The web default is show for every label; a person who never chose gets all six at show. Only the signed-in
 * person reads or writes their own prefs: the id comes from the session, never from the request.
 */
const express = require('express');
const { http } = require('openvibe-contracts');

const CONTRACT = 'network.label-prefs@1';

// The one label list (contracts 0.257.0 common.content-labels@1). Kept here until the pin round to 0.257.0,
// where it moves to `require('openvibe-contracts').labels`; test/label-prefs.test.js holds it to the plan.
const LABELS = Object.freeze(['nudity', 'language', 'graphic', '18+', 'flashing', 'spoilers']);
const CHOICES = Object.freeze(['show', 'blur', 'hide']);
const DEFAULT = 'show';
const KEY = 'labels';   // the key inside user_preferences.site_prefs

/** The plain words the account page shows. The API carries the choices; this is the copy a page needs. */
const INFO = Object.freeze([
    Object.freeze({ id: 'nudity', title: 'Nudity', description: 'Nudity and sexual content.' }),
    Object.freeze({ id: 'language', title: 'Strong language', description: 'Swearing and strong language.' }),
    Object.freeze({ id: 'graphic', title: 'Graphic violence', description: 'Graphic violence or injury.' }),
    Object.freeze({ id: '18+', title: '18+', description: 'For adults only.' }),
    Object.freeze({ id: 'flashing', title: 'Flashing lights', description: 'Flashing lights or rapid motion.' }),
    Object.freeze({ id: 'spoilers', title: 'Spoilers', description: 'Gives away a story.' }),
]);

const defaults = () => Object.fromEntries(LABELS.map((label) => [label, DEFAULT]));

/** The contract's shape: exactly the six labels, each one of the three choices. */
function parsePrefs(body) {
    const prefs = body && typeof body === 'object' && !Array.isArray(body) ? body.prefs : null;
    if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) return { ok: false, error: 'prefs must be an object with every label' };
    const keys = Object.keys(prefs);
    const extra = keys.filter((k) => !LABELS.includes(k));
    const missing = LABELS.filter((k) => !keys.includes(k));
    if (extra.length) return { ok: false, error: `unknown label: ${extra.join(', ')}` };
    if (missing.length) return { ok: false, error: `missing label: ${missing.join(', ')}` };
    const clean = {};
    for (const label of LABELS) {
        if (!CHOICES.includes(prefs[label])) return { ok: false, error: `${label} must be show, blur or hide` };
        clean[label] = prefs[label];
    }
    return { ok: true, prefs: clean };
}

/** The site_prefs JSON, whatever else it holds. A bad value is treated as unset, never an error page. */
const sitePrefsOf = (raw) => {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
    if (typeof raw !== 'string') return {};
    try { const v = JSON.parse(raw); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; }
};

function createLabelPrefs({ db }) {
    async function read(userId) {
        const row = await db.prepare('SELECT site_prefs FROM user_preferences WHERE user_id = ?').get(userId);
        return sitePrefsOf(row && row.site_prefs);
    }

    /** network.label-prefs@1: all six, filling a missing (or older, unknown) value with the web default. */
    async function mine(userId) {
        const stored = sitePrefsOf((await read(userId))[KEY]);
        const prefs = defaults();
        for (const label of LABELS) if (CHOICES.includes(stored[label])) prefs[label] = stored[label];
        return { prefs };
    }

    /** Replace the person's choices; every other key in site_prefs (pinned and recent sites) stays. */
    async function save(userId, prefs) {
        const current = await read(userId);
        const next = { ...current, [KEY]: { ...prefs } };
        await db.prepare(`INSERT INTO user_preferences (user_id, site_prefs, updated_at) VALUES (?, ?, ov_now())
            ON CONFLICT(user_id) DO UPDATE SET site_prefs = excluded.site_prefs, updated_at = ov_now()`).run(userId, JSON.stringify(next));
        return { prefs: { ...prefs } };
    }

    return { mine, save, _read: read };
}

/** The person's own routes, behind Network's session check, and never cached. */
function router({ labelPrefs, requireAuth }) {
    const r = express.Router();
    r.use(http.middleware());
    r.use(express.json({ limit: '4kb' }));
    r.use((req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
    const userIdOf = (req) => req.user.sub || req.user.id;

    r.get('/', requireAuth, async (req, res) => {
        try {
            res.json(await labelPrefs.mine(userIdOf(req)));
        } catch (err) {
            console.error('[Labels] read:', err);
            http.sendProblem(res, 500, 'label-prefs.error', { detail: 'could not read your label choices', ctx: req.ov });
        }
    });

    r.put('/', requireAuth, async (req, res) => {
        const parsed = parsePrefs(req.body);
        if (!parsed.ok) return http.sendProblem(res, 422, 'label-prefs.invalid', { detail: parsed.error, ctx: req.ov });
        try {
            res.json(await labelPrefs.save(userIdOf(req), parsed.prefs));
        } catch (err) {
            console.error('[Labels] save:', err);
            http.sendProblem(res, 500, 'label-prefs.error', { detail: 'could not save your label choices', ctx: req.ov });
        }
    });

    return r;
}

module.exports = { CONTRACT, LABELS, CHOICES, DEFAULT, INFO, defaults, parsePrefs, sitePrefsOf, createLabelPrefs, router };
