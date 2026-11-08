'use strict';

// Link Send's relay stores only Locker envelopes. A sender and recipient are resolved from node tokens, and both
// principals must still belong to the same user. Nothing in this module opens or inspects an envelope.
const crypto = require('crypto');
const express = require('express');
const { http } = require('openvibe-contracts');
const { ensureUserSubject } = require('../identity/subjects');

const MAX_ENVELOPE = 32 * 1024 * 1024;
const MAX_OWNER_ITEMS = 100;
const MAX_OWNER_BYTES = 128 * 1024 * 1024;
const TTL_MS = 24 * 60 * 60 * 1000;
const id = () => `snd_${crypto.randomBytes(16).toString('hex')}`;
const bad = (status, code, message) => Object.assign(new Error(message), { status, code });

async function principal(db, req) {
    const sub = String(req.principal?.sub || '');
    if (!sub.startsWith('node:')) throw bad(403, 'send.machine_required', 'only a paired machine can use this route');
    const row = await db.prepare("SELECT id, owner_subject, owner_kind, status FROM platform_node_principals WHERE id = ?").get(sub.slice(5));
    if (!row || row.status !== 'active' || row.owner_kind !== 'user' || !row.owner_subject) {
        throw bad(401, 'send.machine_unavailable', 'this machine is no longer paired to an account');
    }
    return row;
}

function router({ nodeGuard, requireAuth, db }) {
    const self = express.Router();
    self.use(http.middleware(), nodeGuard);
    self.put('/key', express.json({ limit: '4kb' }), async (req, res) => {
        try {
            const db = req.app.locals.db;
            const machine = await principal(db, req);
            const key = req.body?.public_key;
            if (!key || key.kty !== 'EC' || key.crv !== 'P-256' || typeof key.x !== 'string' || typeof key.y !== 'string' || Object.keys(key).some((k) => !['kty', 'crv', 'x', 'y', 'ext', 'key_ops'].includes(k))) {
                throw bad(400, 'send.bad_key', 'Link needs a public P-256 receive key');
            }
            const jwk = { kty: key.kty, crv: key.crv, x: key.x, y: key.y };
            let thumbprint;
            try {
                crypto.createPublicKey({ key: jwk, format: 'jwk' });
                thumbprint = crypto.createHash('sha256').update(JSON.stringify({ crv: 'P-256', kty: 'EC', x: jwk.x, y: jwk.y })).digest('base64url');
            } catch { throw bad(400, 'send.bad_key', 'Link needs a valid public P-256 receive key'); }
            await db.prepare(`INSERT INTO link_send_keys (node_id, public_key, key_thumbprint, updated_at) VALUES (?, ?::jsonb, ?, now())
                ON CONFLICT (node_id) DO UPDATE SET public_key = EXCLUDED.public_key, key_thumbprint = EXCLUDED.key_thumbprint, updated_at = now()`)
                .run(machine.id, JSON.stringify(jwk), thumbprint);
            res.set('Cache-Control', 'no-store').json({ node_id: machine.id, key_thumbprint: thumbprint });
        } catch (e) { return sendError(res, e); }
    });
    self.get('/inbox', async (req, res) => {
        try {
            const db = req.app.locals.db;
            const target = await principal(db, req);
            // The list is polled every few seconds while Link's window is open: names and sizes only. The ciphertext
            // is fetched once, by accept, when the person chooses to receive it.
            const rows = await db.prepare(`SELECT i.id, i.sender_node, s.name AS sender_name, octet_length(i.envelope) AS bytes,
                    i.created_at, i.expires_at
                FROM link_send_items i LEFT JOIN platform_node_principals s ON s.id = i.sender_node
                WHERE i.target_node = ? AND i.state = 'pending' AND i.expires_at > now() ORDER BY i.created_at`).all(target.id);
            res.set('Cache-Control', 'no-store').json({ items: rows.map((r) => ({
                id: r.id, sender_node: r.sender_node || null,
                sender_name: r.sender_node ? (r.sender_name || 'Link machine') : 'openvibe.link',
                bytes: Number(r.bytes) || 0, created_at: r.created_at, expires_at: r.expires_at,
            })) });
        } catch (e) { return sendError(res, e); }
    });
    self.get('/targets', async (req, res) => {
        try {
            const db = req.app.locals.db;
            const sender = await principal(db, req);
            const rows = await db.prepare(`SELECT n.id, n.name, n.last_seen_at, k.public_key
                FROM platform_node_principals n JOIN link_send_keys k ON k.node_id = n.id
                WHERE n.owner_kind = 'user' AND n.owner_subject = ? AND n.status = 'active' AND n.id <> ?
                ORDER BY n.created_at DESC, n.id`).all(sender.owner_subject, sender.id);
            res.set('Cache-Control', 'no-store').json({ machines: rows.map((r) => ({
                id: r.id, name: r.name || 'Link machine', online: r.last_seen_at && Date.now() - Date.parse(r.last_seen_at) < 5 * 60_000,
                public_key: r.public_key,
            })) });
        } catch (e) { return sendError(res, e); }
    });
    self.post('/', express.json({ limit: MAX_ENVELOPE }), async (req, res) => {
        try {
            const db = req.app.locals.db;
            const sender = await principal(db, req);
            const targetId = String(req.body?.target_node || '');
            const envelope = req.body?.envelope;
            if (!/^nod_[0-9A-HJKMNP-TV-Z]{26}$/.test(targetId)) throw bad(400, 'send.bad_target', 'choose one of your paired machines');
            if (typeof envelope !== 'string' || !envelope || Buffer.byteLength(envelope) > MAX_ENVELOPE || !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope)) {
                throw bad(400, 'send.bad_envelope', 'the encrypted file is missing or too large');
            }
            const target = await db.prepare("SELECT id FROM platform_node_principals WHERE id = ? AND status = 'active' AND owner_kind = 'user' AND owner_subject = ?").get(targetId, sender.owner_subject);
            if (!target || target.id === sender.id) throw bad(404, 'send.target_unavailable', 'that machine is not available on your account');
            await assertQuota(db, sender.owner_subject, Buffer.byteLength(envelope));
            const itemId = id();
            const expires = new Date(Date.now() + TTL_MS).toISOString();
            await db.prepare("INSERT INTO link_send_items (id, owner_subject, sender_node, target_node, envelope, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
                .run(itemId, sender.owner_subject, sender.id, target.id, envelope, expires);
            res.set('Cache-Control', 'no-store').status(201).json({ id: itemId, expires_at: expires });
        } catch (e) { return sendError(res, e); }
    });
    self.post('/:id/:decision', async (req, res) => {
        try {
            const db = req.app.locals.db;
            const target = await principal(db, req);
            const decision = req.params.decision;
            if (!['accept', 'decline', 'complete'].includes(decision)) throw bad(400, 'send.bad_decision', 'choose accept, decline or complete');
            const row = await db.prepare("SELECT id, envelope FROM link_send_items WHERE id = ? AND target_node = ? AND state = 'pending' AND expires_at > now()")
                .get(req.params.id, target.id);
            if (!row) throw bad(404, 'send.item_unavailable', 'that item is no longer waiting');
            if (decision === 'decline' || decision === 'complete') {
                await db.prepare("DELETE FROM link_send_items WHERE id = ? AND target_node = ?").run(row.id, target.id);
                return res.status(204).end();
            }
            res.set('Cache-Control', 'no-store').json({ id: row.id, envelope: row.envelope });
        } catch (e) { return sendError(res, e); }
    });

    const keys = express.Router();
    keys.use(http.middleware(), requireAuth);
    keys.get('/', async (req, res) => {
        try {
            const db = req.app.locals.db;
            const me = await ensureUserSubject(db, req.user);
            const rows = await db.prepare(`SELECT n.id, n.name, n.status, n.last_seen_at, k.public_key
                FROM platform_node_principals n LEFT JOIN link_send_keys k ON k.node_id = n.id
                WHERE n.owner_kind = 'user' AND n.owner_subject = ? AND n.status = 'active'
                ORDER BY n.created_at DESC, n.id`).all(me);
            res.set('Cache-Control', 'private, no-store').json({ machines: rows.map((r) => ({
                id: r.id, name: r.name || 'Link machine', online: r.last_seen_at && Date.now() - Date.parse(r.last_seen_at) < 5 * 60_000,
                public_key: r.public_key || null,
            })) });
        } catch (e) { return sendError(res, e); }
    });
    // The browser sender on openvibe.link: POST /api/v1/me/nodes/send, as the signed-in person.
    const web = express.Router();
    web.use(http.middleware(), requireAuth);
    web.post('/', express.json({ limit: MAX_ENVELOPE }), async (req, res) => {
        try {
            const db = req.app.locals.db;
            const owner = await ensureUserSubject(db, req.user);
            const targetId = String(req.body?.target_node || '');
            const envelope = req.body?.envelope;
            if (!/^nod_[0-9A-HJKMNP-TV-Z]{26}$/.test(targetId)) throw bad(400, 'send.bad_target', 'choose one of your paired machines');
            if (typeof envelope !== 'string' || !envelope || Buffer.byteLength(envelope) > MAX_ENVELOPE || !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope)) {
                throw bad(400, 'send.bad_envelope', 'the encrypted file is missing or too large');
            }
            const target = await db.prepare(`SELECT n.id FROM platform_node_principals n JOIN link_send_keys k ON k.node_id = n.id
                WHERE n.id = ? AND n.owner_kind = 'user' AND n.owner_subject = ? AND n.status = 'active'`).get(targetId, owner);
            if (!target) throw bad(404, 'send.target_unavailable', 'that machine is not available on your account');
            await assertQuota(db, owner, Buffer.byteLength(envelope));
            const itemId = id(), expires = new Date(Date.now() + TTL_MS).toISOString();
            await db.prepare("INSERT INTO link_send_items (id, owner_subject, sender_node, target_node, envelope, expires_at) VALUES (?, ?, NULL, ?, ?, ?)")
                .run(itemId, owner, target.id, envelope, expires);
            res.set('Cache-Control', 'no-store').status(201).json({ id: itemId, expires_at: expires });
        } catch (e) { return sendError(res, e); }
    });
    const cleanup = setInterval(() => {
        if (db) cleanupExpired(db).catch((e) => console.error('[Link Send] relay expiry cleanup failed:', e.message));
    }, 15 * 60_000);
    cleanup.unref?.();
    if (db) cleanupExpired(db).catch((e) => console.error('[Link Send] relay expiry cleanup failed:', e.message));
    return { self, keys, web };
}

async function assertQuota(db, owner, adding) {
    const quota = await db.prepare("SELECT COUNT(*) AS items, COALESCE(SUM(octet_length(envelope)), 0) AS bytes FROM link_send_items WHERE owner_subject = ? AND expires_at > now()").get(owner);
    if (Number(quota.items) >= MAX_OWNER_ITEMS || Number(quota.bytes) + adding > MAX_OWNER_BYTES) {
        throw bad(429, 'send.queue_full', 'your transfer queue is full; accept or decline a waiting item first');
    }
}

async function cleanupExpired(db) {
    await db.prepare("DELETE FROM link_send_items WHERE expires_at <= now()").run();
}

function sendError(res, e) {
    const status = Number(e.status) || 500;
    const code = e.code || 'send.failed';
    const message = status < 500 ? e.message : 'Link could not complete that transfer';
    return http.sendProblem(res, status, code, { detail: message });
}

module.exports = { router, principal, MAX_ENVELOPE, MAX_OWNER_ITEMS, MAX_OWNER_BYTES, TTL_MS, assertQuota, cleanupExpired };
