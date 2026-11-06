'use strict';
const crypto = require('crypto');
const express = require('express');
const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const service = (app, external) => app === 'slack' ? `chat:slack:${String(external).split(':')[0]}` : `chat:${app}`;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const CODE = /^[0-9]{6}$/;
const CODE_TTL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 3;
const validIdentity = (app, id) => app === 'slack' ? /^T[A-Z0-9]+:[UW][A-Z0-9]+$/.test(id)
    : ['telegram', 'discord'].includes(app) && /^[0-9]{1,24}$/.test(id);
const escape = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fail = (status, message) => Object.assign(new Error(message), { status });
const same = (a, b) => {
    const x = Buffer.from(String(a == null ? '' : a));
    const y = Buffer.from(String(b == null ? '' : b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
};
/** The code is bound to the chat identity that asked for the link, so it cannot finish another one. */
const codeHash = (app, externalId, code) => hash(`chat-app-code:${app}:${externalId}:${code}`);

function store(db, now = () => Date.now()) {
    const iso = () => new Date(now()).toISOString();
    return {
        async register(b) {
            if (!TOKEN.test(b.token || '') || !validIdentity(b.app, String(b.service_user_id || ''))) throw fail(400, 'Invalid link');
            const exp = Date.parse(b.expires_at);
            if (!Number.isFinite(exp) || exp <= now() || exp > now() + 10 * 60_000) throw fail(400, 'Invalid expiry');
            await db.prepare('DELETE FROM chat_app_pending_links WHERE expires_at < ?').run(iso());
            await db.prepare(`INSERT INTO chat_app_pending_links (token_hash, app, external_id, label, bot_handle, expires_at)
                VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (token_hash) DO NOTHING`)
                .run(hash(b.token), b.app, b.service_user_id, String(b.service_username || '').slice(0, 80),
                    String(b.bot_handle || '').slice(0, 64) || null, new Date(exp).toISOString());
        },
        async pending(token) {
            if (!TOKEN.test(token || '')) return null;
            return db.prepare(`SELECT p.*, u.subject_id FROM chat_app_pending_links p LEFT JOIN users u ON u.id = p.confirmed_by
                WHERE token_hash = ? AND expires_at > ?`).get(hash(token), iso());
        },
        /**
         * Half of the link: the signed-in person says yes and gets a 6-digit code (only its hash is
         * kept). Nothing is linked until the same chat account sends that code to the bot (finish).
         * Confirming again rotates the code; confirming alone never links.
         */
        async confirm(token, userId) {
            if (!TOKEN.test(token || '')) throw fail(400, 'Invalid link');
            return db.tx(async t => {
                const p = await t.prepare('SELECT * FROM chat_app_pending_links WHERE token_hash = ? FOR UPDATE').get(hash(token));
                if (!p || p.finished_at || p.cancelled_at || p.expires_at <= iso()) throw fail(410, 'This link expired or was already used');
                // Once one signed-in person has confirmed, another account cannot rotate (or take) it.
                if (p.confirmed_by && Number(p.confirmed_by) !== Number(userId)) throw fail(409, 'This link was already confirmed by another account');
                const user = await t.prepare('SELECT id FROM users WHERE id = ? AND deleted_at IS NULL AND merged_into IS NULL AND is_banned = 0 FOR UPDATE').get(userId);
                if (!user) throw fail(403, 'This account cannot be linked');
                // Refuse before showing a code that could never be used: an identity is one person, and a
                // service account belongs to one chat account.
                const key = service(p.app, p.external_id);
                const mine = await t.prepare('SELECT * FROM linked_accounts WHERE user_id = ? AND service = ?').get(userId, key);
                if (mine && mine.service_user_id !== p.external_id) throw fail(409, 'Unlink the previous chat account first');
                const other = await t.prepare('SELECT user_id FROM linked_accounts WHERE service = ? AND service_user_id = ?').get(key, p.external_id);
                if (other && other.user_id !== userId) throw fail(409, 'This chat account is already linked');
                const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
                const codeExpires = new Date(Math.min(Date.parse(p.expires_at), now() + CODE_TTL_MS)).toISOString();
                await t.prepare(`UPDATE chat_app_pending_links SET confirmed_by = ?, confirmed_at = ?, code_hash = ?, code_expires_at = ?, attempts = 0, cancelled_at = NULL
                    WHERE token_hash = ?`).run(userId, iso(), codeHash(p.app, p.external_id, code), codeExpires, p.token_hash);
                return { code, row: p };
            });
        },
        /**
         * The other half: the chat account that started /link sends the code to the bot. Three wrong
         * codes cancel the pending link, an expired code cannot be used, and only now is the account
         * link written.
         */
        async finish(b) {
            if (!validIdentity(b.app, String(b.service_user_id || ''))) throw fail(400, 'Invalid identity');
            if (!CODE.test(String(b.code || ''))) return { ok: false, error: 'code', attemptsLeft: MAX_ATTEMPTS };
            return db.tx(async t => {
                const p = await t.prepare(`SELECT * FROM chat_app_pending_links
                    WHERE app = ? AND external_id = ? AND confirmed_by IS NOT NULL AND finished_at IS NULL AND cancelled_at IS NULL AND expires_at > ?
                    ORDER BY confirmed_at DESC LIMIT 1 FOR UPDATE`).get(b.app, b.service_user_id, iso());
                if (!p) return { ok: false, error: 'no_link' };
                if (!p.code_expires_at || p.code_expires_at <= iso()) {
                    await t.prepare('UPDATE chat_app_pending_links SET cancelled_at = ? WHERE token_hash = ?').run(iso(), p.token_hash);
                    return { ok: false, error: 'expired' };
                }
                if (!same(p.code_hash, codeHash(p.app, p.external_id, b.code))) {
                    const attempts = Number(p.attempts || 0) + 1;
                    if (attempts >= MAX_ATTEMPTS) {
                        await t.prepare('UPDATE chat_app_pending_links SET attempts = ?, cancelled_at = ?, code_hash = NULL WHERE token_hash = ?').run(attempts, iso(), p.token_hash);
                    } else {
                        await t.prepare('UPDATE chat_app_pending_links SET attempts = ? WHERE token_hash = ?').run(attempts, p.token_hash);
                    }
                    return { ok: false, error: 'code', attemptsLeft: Math.max(0, MAX_ATTEMPTS - attempts) };
                }
                const user = await t.prepare('SELECT id, subject_id FROM users WHERE id = ? AND deleted_at IS NULL AND merged_into IS NULL AND is_banned = 0').get(p.confirmed_by);
                if (!user) throw fail(409, 'This account cannot be linked');
                const key = service(p.app, p.external_id);
                const mine = await t.prepare('SELECT * FROM linked_accounts WHERE user_id = ? AND service = ?').get(user.id, key);
                if (mine && mine.service_user_id !== p.external_id) throw fail(409, 'Unlink the previous chat account first');
                const other = await t.prepare('SELECT user_id FROM linked_accounts WHERE service = ? AND service_user_id = ?').get(key, p.external_id);
                if (other && other.user_id !== user.id) throw fail(409, 'This chat account is already linked');
                const row = await t.prepare(`INSERT INTO linked_accounts (service, service_user_id, user_id, service_username, linked_at)
                    VALUES (?, ?, ?, ?, ov_now()) ON CONFLICT DO NOTHING RETURNING user_id`).get(key, p.external_id, user.id, p.label);
                if (!row && !mine) throw fail(409, 'This chat account is already linked');
                await t.prepare('UPDATE chat_app_pending_links SET finished_at = ?, code_hash = NULL WHERE token_hash = ?').run(iso(), p.token_hash);
                return { ok: true, subject: user.subject_id, app: p.app };
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
        const state = !p ? 'unknown' : p.finished_at ? 'finished' : p.cancelled_at ? 'cancelled' : p.confirmed_at ? 'confirmed' : 'pending';
        res.json({ state, subject: p && p.subject_id ? p.subject_id : null });
    }));
    r.post('/finish', wrap(async (req, res, s) => {
        const out = await s.finish(req.body || {});
        // A wrong or expired code is a normal answer (the bot says how many tries are left), not a
        // transport error; only "no link was started by this chat account" is a 404.
        res.status(out.ok || out.error !== 'no_link' ? 200 : 404).json(out);
    }));
    r.get('/resolve', wrap(async (req, res, s) => res.json(await s.resolve(req.query.app, req.query.id) || { subject_id: null })));
    r.post('/unlink', wrap(async (req, res, s) => {
        if (!validIdentity(req.body.app, String(req.body.service_user_id || ''))) throw fail(400, 'Invalid identity');
        await s.unlink(req.body.app, req.body.service_user_id); res.json({ ok: true });
    }));
    return r;
}
/**
 * The signed-in person's own chat-app accounts (the website's account page): what is linked, and
 * the way to remove one without going back to the chat. No token or hash is ever returned.
 */
function userRouter(requireAuth) {
    const r = express.Router();
    r.use(requireAuth);
    r.get('/', async (req, res) => {
        try {
            const rows = await req.app.locals.db.prepare(`SELECT service, service_user_id, service_username, linked_at FROM linked_accounts
                WHERE user_id = ? AND service LIKE 'chat:%' ORDER BY linked_at DESC`).all(req.user.id);
            res.set('Cache-Control', 'no-store').json({ items: rows.map((l) => {
                const [, app, workspace] = l.service.split(':');
                return { app, workspace: workspace || null, service_user_id: l.service_user_id, service_username: l.service_username || null, linked_at: l.linked_at };
            }) });
        } catch { res.status(503).json({ error: 'Link service unavailable' }); }
    });
    r.delete('/:app', async (req, res) => {
        const app = String(req.params.app || '');
        try {
            const rows = await req.app.locals.db.prepare("DELETE FROM linked_accounts WHERE user_id = ? AND service LIKE ? RETURNING service, service_user_id")
                .all(req.user.id, app === 'slack' ? 'chat:slack:%' : `chat:${app}`);
            if (!rows.length) return res.status(404).json({ error: 'Not linked' });
            for (const row of rows) await req.app.locals.db.prepare('DELETE FROM chat_app_pending_links WHERE app = ? AND external_id = ?').run(app, row.service_user_id);
            res.set('Cache-Control', 'no-store').json({ ok: true, removed: rows.length });
        } catch { res.status(503).json({ error: 'Link service unavailable' }); }
    });
    return r;
}

const page = (title, body) => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:38rem;margin:3rem auto;padding:0 1rem;color:#111}code{font-size:2rem;letter-spacing:.35rem;display:inline-block;padding:.6rem 1rem;border:1px solid #111;border-radius:.4rem}button{font:inherit;padding:.6rem 1rem}</style>${body}</html>`;

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
            if (!p || p.finished_at || p.cancelled_at) return res.status(410).send('This link expired or was already used. Send /link again.');
            const label = p.label || p.external_id;
            res.type('html').send(page('Link your chat account', `<main><h1>Link your ${escape(p.app)} account</h1>
<p><strong>This ${escape(p.app)} account (@${escape(label)}) will talk to your OpenVibe agent and approve its steps.</strong></p>
<p>Confirm only if you started /link from that chat account yourself. The next page shows a 6-digit code: send it to the bot in that same chat to finish. Until you do, nothing is linked.</p>
<form method="post" action="/chat-apps/link"><input type="hidden" name="t" value="${escape(req.query.t)}"><button>Yes, this is my chat account</button></form></main>`));
        } catch { res.status(503).send('Link service unavailable'); }
    });
    r.post('/link', async (req, res) => {
        const origin = new URL(req.app.locals.config.baseUrl).origin;
        if (req.get('origin') !== origin) return res.status(403).send('Confirm on OpenVibe.Network');
        try {
            const { code, row } = await store(req.app.locals.db).confirm(req.body.t, req.user.id);
            const label = row.label || row.external_id;
            const bot = row.bot_handle ? `@${row.bot_handle}` : 'the OpenVibe bot';
            res.type('html').send(page('Send the code to your bot', `<main><h1>One more step</h1>
<p>Send this code to <strong>${escape(bot)}</strong> from ${escape(row.app)} @${escape(label)} to finish:</p>
<p><code>${escape(code)}</code></p>
<p>It works once, for 10 minutes. This is what keeps a link forwarded to somebody else from working: only this chat account can finish it.</p>
<p>This ${escape(row.app)} account will talk to your OpenVibe agent and approve its steps. If you did not start this, do nothing: the link stays unfinished.</p></main>`));
        } catch (e) { res.status(e.status || 503).send(e.status ? e.message : 'Link service unavailable'); }
    });
    return r;
}
module.exports = { store, internalRouter, pageRouter, userRouter, validIdentity };
