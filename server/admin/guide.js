'use strict';
/**
 * The owner's guided setup (/admin/guide, 2026-11-12): what the guide remembers between visits. The steps themselves
 * are worked out each time from the live state (public/js/admin/guide-rules.js over the Setup checklist, the AI setup
 * and the owner's computers), and "Use recommended" goes through the routes the rest of the panel already uses, so
 * the only thing kept here is which steps the owner skipped and which they have seen.
 *
 *   GET  /api/admin/guide            { skipped, seen }
 *   PUT  /api/admin/guide            { skipped?, seen? } the whole lists (step ids)
 *
 * Owner only. Kept in Network's own namespace network.guide (openvibe-shared/config), so a change is a revision with
 * its actor and history like any other setting.
 */
const express = require('express');
const config = require('openvibe-shared/config');
const { requireOwner } = require('../auth/owner-guard');
const siteConfig = require('./site-config');

const NAMESPACE = 'network.guide';
const STEP = /^[a-z][a-z0-9-]{0,40}$/;
const IDS = { type: 'array', maxItems: 60, uniqueItems: true, items: { type: 'string', pattern: STEP.source } };
const SCHEMA = Object.freeze({
    type: 'object',
    additionalProperties: false,
    properties: {
        skipped: { ...IDS, title: 'Skipped steps', description: 'The guided setup’s steps the owner chose to skip for now.' },
        seen: { ...IDS, title: 'Seen steps', description: 'The guided setup’s steps the owner has opened.' },
    },
});

const byDb = new Map();
async function store(db, log = console) {
    if (byDb.has(db)) return byDb.get(db);
    const ready = config.createConfigStore({
        db, service: 'network', namespace: NAMESPACE, schema: SCHEMA,
        log: { info: () => {}, warn: (m) => (log.warn || log.log || (() => {})).call(log, `[Guide] ${m}`), error: (m) => (log.error || log.warn || (() => {})).call(log, `[Guide] ${m}`) },
    });
    byDb.set(db, ready);
    try { return await ready; } catch (err) { byDb.delete(db); throw err; }
}

const clean = (v) => (Array.isArray(v) ? [...new Set(v.map(String).filter((id) => STEP.test(id)))].slice(0, 60) : null);

function createGuideRoutes(opts = {}) {
    const r = express.Router();
    const log = opts.log || console;
    r.use(requireOwner);
    const dbOf = (req) => opts.db || req.app.locals.db;
    const send = (res, status, body) => { res.set('Cache-Control', 'no-store'); return res.status(status).json(body); };

    r.get('/', async (req, res) => {
        try {
            const s = await store(dbOf(req), log);
            const v = s.get() || {};
            send(res, 200, { ok: true, skipped: v.skipped || [], seen: v.seen || [] });
        } catch (err) {
            log.error(`[Guide] ${err && err.message ? String(err.message).slice(0, 200) : 'failed'}`);
            send(res, 500, { ok: false, error: 'The guide could not be read', code: 'guide.internal' });
        }
    });

    r.put('/', async (req, res) => {
        try {
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            const next = {};
            for (const key of ['skipped', 'seen']) {
                if (body[key] === undefined) continue;
                const ids = clean(body[key]);
                if (!ids) return send(res, 400, { ok: false, error: `${key} is a list of step ids`, code: 'guide.bad_request' });
                next[key] = ids;
            }
            if (!Object.keys(next).length) return send(res, 400, { ok: false, error: 'Send skipped or seen', code: 'guide.bad_request' });
            const s = await store(dbOf(req), log);
            await s.apply(next, { merge: true, actor: siteConfig.actorOf(req.user), reason: 'Guided setup progress' });
            const v = s.get() || {};
            send(res, 200, { ok: true, skipped: v.skipped || [], seen: v.seen || [] });
        } catch (err) {
            log.error(`[Guide] ${err && err.message ? String(err.message).slice(0, 200) : 'failed'}`);
            send(res, 500, { ok: false, error: 'The guide could not be saved', code: 'guide.internal' });
        }
    });

    return r;
}

module.exports = { createGuideRoutes, SCHEMA, NAMESPACE };
