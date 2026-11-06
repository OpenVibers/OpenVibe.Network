'use strict';
const crypto = require('crypto');
const express = require('express');
const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const service = (app, external) => app === 'slack' ? `chat:slack:${String(external).split(':')[0]}` : `chat:${app}`;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const validIdentity = (app, id) => app === 'slack' ? /^T[A-Z0-9]+:[UW][A-Z0-9]+$/.test(id)
    : ['telegram', 'discord'].includes(app) && /^[0-9]{1,24}$/.test(id);
const escape = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fail = (status, message) => Object.assign(new Error(message), { status });

function store(db, now = () => Date.now()) {
    const iso = () => new Date(now()).toISOString();
    return {
        async register(b) {
            if (!TOKEN.test(b.token || '') || !validIdentity(b.app, String(b.service_user_id || ''))) throw fail(400, 'Invalid link');
            const exp = Date.parse(b.expires_at);
            if (!Number.isFinite(exp) || exp <= now() || exp > now() + 10 * 60_000) throw fail(400, 'Invalid expiry');
            await db.prepare('DELETE FROM chat_app_pending_links WHERE expires_at < ?').run(iso());
            await db.prepare(`INSERT INTO chat_app_pending_links (token_hash, app, external_id, label, expires_at)
                VALUES (?, ?, ?, ?, ?) ON CONFLICT (token_hash) DO NOTHING`).run(hash(b.token), b.app, b.service_user_id, String(b.service_username || '').slice(0, 80), new Date(exp).toISOString());
        },
        async pending(token) {
            if (!TOKEN.test(token || '')) return null;
            return db.prepare(`SELECT p.*, u.subject_id FROM chat_app_pending_links p LEFT JOIN users u ON u.id = p.confirmed_by
                WHERE token_hash = ? AND expires_at > ?`).get(hash(token), iso());
        },
        async confirm(token, userId) {
            if (!TOKEN.test(token || '')) throw fail(400, 'Invalid link');
            return db.tx(async t => {
                const p = await t.prepare('SELECT * FROM chat_app_pending_links WHERE token_hash = ? FOR UPDATE').get(hash(token));
                if (!p || p.confirmed_at || p.expires_at <= iso()) throw fail(410, 'This link expired or was already used');
                // A different signed-in account cannot steal an existing identity, even with a fresh link.
                const key = service(p.app, p.external_id);
                // Serialize changes by owner as well as external identity. Never silently replace another chat account.
                await t.prepare('SELECT id FROM users WHERE id = ? FOR UPDATE').get(userId);
                const existing = await t.prepare('SELECT * FROM linked_accounts WHERE user_id = ? AND service = ?').get(userId, key);
                if (existing && existing.service_user_id !== p.external_id) throw fail(409, 'Unlink the previous chat account first');
                const row = await t.prepare(`INSERT INTO linked_accounts (service, service_user_id, user_id, service_username, linked_at)
                    VALUES (?, ?, ?, ?, ov_now()) ON CONFLICT DO NOTHING RETURNING user_id`).get(key, p.external_id, userId, p.label);
                if (!row && !existing) throw fail(409, 'This chat account is already linked');
                await t.prepare('UPDATE chat_app_pending_links SET confirmed_by = ?, confirmed_at = ? WHERE token_hash = ?').run(userId, iso(), hash(token));
                return p;
            });
        },
        async resolve(app, externalId) {
            return db.prepare(`SELECT u.subject_id FROM linked_accounts l JOIN users u ON u.id = l.user_id
                WHERE l.service = ? AND l.service_user_id = ? AND u.deleted_at IS NULL AND u.merged_into IS NULL AND u.is_banned = 0`).get(service(app, externalId), externalId);
        },
        async unlink(app, externalId) {
            await db.tx(async t => {
                await t.prepare('DELETE FROM linked_accounts WHERE service = ? AND service_user_id = ?').run(service(app, externalId), externalId);
                await t.prepare('DELETE FROM chat_app_pending_links WHERE app = ? AND external_id = ?').run(app, externalId);
            });
        },
    };
}
function internalRouter() {
    const r = express.Router();
    r.use((req, res, next) => req.principal && req.principal.sub === 'svc:chat'
        ? next() : res.status(403).json({ error: 'Chat service only' }));
    r.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    const wrap = fn => async (req, res) => { try { await fn(req, res, store(req.app.locals.db)); } catch (e) { res.status(e.status || 503).json({ error: e.status ? e.message : 'Link service unavailable' }); } };
    r.post('/', wrap(async (req, res, s) => { await s.register(req.body || {}); res.json({ ok: true }); }));
    r.get('/', wrap(async (req, res, s) => {
        const p = await s.pending(req.query.t);
        res.json(p ? { state: p.confirmed_at ? 'confirmed' : 'pending', subject: p.subject_id || null } : { state: 'unknown' });
    }));
    r.get('/resolve', wrap(async (req, res, s) => res.json(await s.resolve(req.query.app, req.query.id) || { subject_id: null })));
    r.post('/unlink', wrap(async (req, res, s) => {
        if (!validIdentity(req.body.app, String(req.body.service_user_id || ''))) throw fail(400, 'Invalid identity');
        await s.unlink(req.body.app, req.body.service_user_id); res.json({ ok: true });
    }));
    return r;
}
function pageRouter(requireAuth) {
    const r = express.Router();
    r.use((req, res, next) => { res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); next(); });
    r.use((req, res, next) => {
        if (req.method === 'GET' && !req.cookies?.ov_token && !req.get('authorization')) return res.redirect('/login?return=' + encodeURIComponent(req.originalUrl));
        return requireAuth(req, res, next);
    });
    r.get('/link', async (req, res) => {
        try {
            const p = await store(req.app.locals.db).pending(req.query.t);
            if (!p || p.confirmed_at) return res.status(410).send('This link expired or was already used. Send /link again.');
            res.type('html').send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Link your chat account</title><main><h1>Link your ${escape(p.app)} account</h1><p>Confirm only if you just sent /link from ${escape(p.label || p.external_id)}. Anyone with that chat account will be able to ask your agent to work for you.</p><form method="post" action="/chat-apps/link"><input type="hidden" name="t" value="${escape(req.query.t)}"><button>Confirm account link</button></form></main></html>`);
        } catch { res.status(503).send('Link service unavailable'); }
    });
    r.post('/link', async (req, res) => {
        const origin = new URL(req.app.locals.config.baseUrl).origin;
        if (req.get('origin') !== origin) return res.status(403).send('Confirm on OpenVibe.Network');
        try { await store(req.app.locals.db).confirm(req.body.t, req.user.id); res.send('Account linked. Return to your chat and ask your agent.'); }
        catch (e) { res.status(e.status || 503).send(e.status ? e.message : 'Link service unavailable'); }
    });
    return r;
}
module.exports = { store, internalRouter, pageRouter, validIdentity };
