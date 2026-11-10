'use strict';

// Link Send's relay stores only Locker envelopes. A sender and recipient are resolved from node tokens, and both
// principals must still belong to the same user. Nothing in this module opens or inspects an envelope.
//
// A large envelope can be uploaded in parts: start an upload, PUT each part in order, then finish. A dropped
// connection resumes from the last part the relay acknowledged (`GET /upload/:id`), and finishing twice returns the
// same item rather than making a second one. The sender can read its own outbox to see whether the receiving machine
// accepted, declined or saved the item.
const crypto = require('crypto');
const express = require('express');
const { http } = require('openvibe-contracts');
const { ensureUserSubject } = require('../identity/subjects');

const MAX_ENVELOPE = 32 * 1024 * 1024;
const MAX_OWNER_ITEMS = 100;
const MAX_OWNER_BYTES = 128 * 1024 * 1024;
const MAX_CHUNK = 2 * 1024 * 1024;
const MAX_LAN = 4;
const TTL_MS = 24 * 60 * 60 * 1000;
const UPLOAD_TTL_MS = 60 * 60 * 1000;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const MACHINE = /^lnk_[0-9A-HJKMNP-TV-Z]{26}$/;
const ITEM = /^snd_[a-f0-9]{32}$/;
const UPLOAD = /^upl_[a-f0-9]{32}$/;
const id = () => `snd_${crypto.randomBytes(16).toString('hex')}`;
const uploadId = () => `upl_${crypto.randomBytes(16).toString('hex')}`;
const bad = (status, code, message) => Object.assign(new Error(message), { status, code });

async function principal(db, req) {
    const sub = String(req.principal?.sub || '');
    if (!sub.startsWith('link:')) throw bad(403, 'send.machine_required', 'only a paired machine can use this route');
    const row = await db.prepare("SELECT id, owner_subject, owner_kind, status FROM platform_node_principals WHERE id = ?").get(sub.slice(5));
    if (!row || row.status !== 'active' || row.owner_kind !== 'user' || !row.owner_subject) {
        throw bad(401, 'send.machine_unavailable', 'this machine is no longer paired to an account');
    }
    return row;
}

/** Who is acting: a paired machine (sender_node set) or the signed-in person on openvibe.link (sender_node null). */
async function selfActor(db, req) {
    const machine = await principal(db, req);
    return { owner: machine.owner_subject, sender: machine.id };
}

async function webActor(db, req) {
    if (!req.user) throw bad(401, 'send.sign_in', 'sign in on openvibe.link to send to a machine');
    const owner = await ensureUserSubject(db, req.user);
    return { owner, sender: null };
}

/** One of the actor's own active machines, never itself. */
async function targetFor(db, owner, targetId, sender) {
    if (!MACHINE.test(targetId)) throw bad(400, 'send.bad_target', 'choose one of your paired machines');
    const target = await db.prepare(`SELECT id, name FROM platform_node_principals
        WHERE id = ? AND status = 'active' AND owner_kind = 'user' AND owner_subject = ?`).get(targetId, owner);
    if (!target || target.id === sender) throw bad(404, 'send.target_unavailable', 'that machine is not available on your account');
    return target;
}

function lanList(value) {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > MAX_LAN) throw bad(400, 'send.bad_lan', 'Link sent too many local addresses');
    return value.map((raw) => {
        let url;
        try { url = new URL(String(raw)); } catch { throw bad(400, 'send.bad_lan', 'Link sent an address that is not a URL'); }
        if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname || url.username || url.password) {
            throw bad(400, 'send.bad_lan', 'Link sent an address that is not a local HTTP endpoint');
        }
        if (url.pathname !== '/' && url.pathname !== '') throw bad(400, 'send.bad_lan', 'Link sent an address with a path');
        if (String(raw).length > 200) throw bad(400, 'send.bad_lan', 'Link sent an address that is too long');
        return `${url.protocol}//${url.host}`;
    });
}

function lanOf(value) {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') { try { return JSON.parse(value); } catch { return []; } }
    return [];
}

function validEnvelope(envelope) {
    return typeof envelope === 'string' && envelope.length > 0
        && Buffer.byteLength(envelope) <= MAX_ENVELOPE && BASE64.test(envelope);
}

function uploadState(row, seq) {
    return {
        id: row.id, bytes: Number(row.bytes), received: Number(row.received), seq,
        item_id: row.item_id || null, expires_at: row.expires_at,
    };
}

/**
 * The resumable upload routes. `actor` says whether the caller is a machine or the signed-in person; the same
 * routes then live under /api/v1/link/self/send/upload and /api/v1/me/nodes/send/upload.
 */
function uploadRoutes(actor) {
    const r = express.Router();

    r.post('/', express.json({ limit: '4kb' }), async (req, res) => {
        try {
            const db = req.app.locals.db;
            const { owner, sender } = await actor(db, req);
            const target = await targetFor(db, owner, String(req.body?.target_node || ''), sender);
            const bytes = Number(req.body?.bytes);
            if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > MAX_ENVELOPE) {
                throw bad(400, 'send.bad_size', 'the encrypted item is missing or too large');
            }
            const quota = await db.prepare(`SELECT COUNT(*) AS items, COALESCE(SUM(octet_length(envelope)), 0) AS bytes
                FROM link_send_items WHERE owner_subject = ? AND state <> 'declined' AND completed_at IS NULL AND expires_at > now()`).get(owner);
            if (Number(quota.items) >= MAX_OWNER_ITEMS || Number(quota.bytes) + bytes > MAX_OWNER_BYTES) {
                throw bad(429, 'send.queue_full', 'your transfer queue is full; accept or decline a waiting item first');
            }
            const row = { id: uploadId(), owner, sender, target: target.id, bytes };
            await db.prepare(`INSERT INTO link_send_uploads (id, owner_subject, sender_node, target_node, bytes, expires_at)
                VALUES (?, ?, ?, ?, ?, ?)`).run(row.id, owner, sender, target.id, bytes, new Date(Date.now() + UPLOAD_TTL_MS).toISOString());
            res.set('Cache-Control', 'no-store').status(201).json({ id: row.id, bytes, received: 0, seq: 0, target_node: target.id });
        } catch (e) { return sendError(res, e); }
    });

    r.get('/:id', async (req, res) => {
        try {
            const db = req.app.locals.db;
            const { owner, sender } = await actor(db, req);
            if (!UPLOAD.test(req.params.id)) throw bad(404, 'send.upload_unavailable', 'that transfer is no longer available');
            const row = await db.prepare(`SELECT id, bytes, received, item_id, expires_at FROM link_send_uploads
                WHERE id = ? AND owner_subject = ? AND sender_node IS NOT DISTINCT FROM ? AND expires_at > now()`)
                .get(req.params.id, owner, sender);
            if (!row) throw bad(404, 'send.upload_unavailable', 'that transfer is no longer available');
            const count = await db.prepare('SELECT COUNT(*) AS n FROM link_send_chunks WHERE upload_id = ?').get(row.id);
            res.set('Cache-Control', 'no-store').json(uploadState(row, Number(count.n) || 0));
        } catch (e) { return sendError(res, e); }
    });

    r.put('/:id/:seq', express.json({ limit: '4mb' }), async (req, res) => {
        try {
            const db = req.app.locals.db;
            const { owner, sender } = await actor(db, req);
            if (!UPLOAD.test(req.params.id)) throw bad(404, 'send.upload_unavailable', 'that transfer is no longer available');
            const seq = Number(req.params.seq);
            const chunk = req.body?.chunk;
            if (!Number.isSafeInteger(seq) || seq < 0 || seq > 10000) throw bad(400, 'send.bad_part', 'that part is not one this transfer can take');
            if (typeof chunk !== 'string' || !chunk || Buffer.byteLength(chunk) > MAX_CHUNK || !BASE64.test(chunk)) {
                throw bad(400, 'send.bad_part', 'that part of the encrypted item is missing or too large');
            }
            const state = await db.tx(async (t) => {
                const row = await t.prepare(`SELECT id, bytes, received, item_id FROM link_send_uploads
                    WHERE id = ? AND owner_subject = ? AND sender_node IS NOT DISTINCT FROM ? AND expires_at > now() FOR UPDATE`)
                    .get(req.params.id, owner, sender);
                if (!row) throw bad(404, 'send.upload_unavailable', 'that transfer is no longer available');
                if (row.item_id) throw bad(409, 'send.already_finished', 'that item was already sent');
                const count = Number((await t.prepare('SELECT COUNT(*) AS n FROM link_send_chunks WHERE upload_id = ?').get(row.id)).n) || 0;
                if (seq < count) {
                    const old = await t.prepare('SELECT body FROM link_send_chunks WHERE upload_id = ? AND seq = ?').get(row.id, seq);
                    if (old && old.body === chunk) return { id: row.id, bytes: Number(row.bytes), received: Number(row.received), seq: count, item_id: null, expires_at: null };
                    throw bad(409, 'send.part_conflict', 'that part was already received with different bytes');
                }
                if (seq !== count) throw bad(409, 'send.part_missing', `the relay is waiting for part ${count}`);
                const next = Number(row.received) + Buffer.byteLength(chunk);
                if (next > Number(row.bytes)) throw bad(400, 'send.too_much', 'the parts add up to more than the encrypted item');
                await t.prepare('INSERT INTO link_send_chunks (upload_id, seq, body, bytes) VALUES (?, ?, ?, ?)')
                    .run(row.id, seq, chunk, Buffer.byteLength(chunk));
                await t.prepare('UPDATE link_send_uploads SET received = ? WHERE id = ?').run(next, row.id);
                return { id: row.id, bytes: Number(row.bytes), received: next, seq: count + 1, item_id: null, expires_at: null };
            });
            res.set('Cache-Control', 'no-store').json({ id: state.id, bytes: state.bytes, received: state.received, seq: state.seq });
        } catch (e) { return sendError(res, e); }
    });

    r.post('/:id/finish', express.json({ limit: '4kb' }), async (req, res) => {
        try {
            const db = req.app.locals.db;
            const { owner, sender } = await actor(db, req);
            if (!UPLOAD.test(req.params.id)) throw bad(404, 'send.upload_unavailable', 'that transfer is no longer available');
            const done = await db.tx(async (t) => {
                const row = await t.prepare(`SELECT id, bytes, received, item_id, target_node FROM link_send_uploads
                    WHERE id = ? AND owner_subject = ? AND sender_node IS NOT DISTINCT FROM ? AND expires_at > now() FOR UPDATE`)
                    .get(req.params.id, owner, sender);
                if (!row) throw bad(404, 'send.upload_unavailable', 'that transfer is no longer available');
                if (row.item_id) {
                    const item = await t.prepare('SELECT expires_at FROM link_send_items WHERE id = ?').get(row.item_id);
                    return { id: row.item_id, expires_at: item?.expires_at || null };
                }
                const parts = await t.prepare('SELECT seq, body, bytes FROM link_send_chunks WHERE upload_id = ? ORDER BY seq').all(row.id);
                const received = parts.reduce((n, p) => n + Number(p.bytes), 0);
                if (!parts.length || received !== Number(row.bytes) || received !== Number(row.received)) {
                    throw bad(409, 'send.upload_incomplete', 'the encrypted item did not arrive in full');
                }
                if (parts.some((p, i) => Number(p.seq) !== i)) throw bad(409, 'send.upload_incomplete', 'the encrypted item did not arrive in order');
                const envelope = parts.map((p) => p.body).join('');
                await assertQuota(t, owner, Buffer.byteLength(envelope));
                const item = id(), expires = new Date(Date.now() + TTL_MS).toISOString();
                await t.prepare(`INSERT INTO link_send_items (id, owner_subject, sender_node, target_node, envelope, expires_at)
                    VALUES (?, ?, ?, ?, ?, ?)`).run(item, owner, sender, row.target_node, envelope, expires);
                await t.prepare('UPDATE link_send_uploads SET item_id = ? WHERE id = ?').run(item, row.id);
                return { id: item, expires_at: expires };
            });
            res.set('Cache-Control', 'no-store').status(201).json(done);
        } catch (e) { return sendError(res, e); }
    });

    return r;
}

/** What the sender's own list calls each row, in plain words. */
function deliveryState(row) {
    if (row.completed_at) return 'saved';
    if (row.state === 'declined') return 'declined';
    if (row.accepted_at) return 'accepted';
    if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) return 'expired';
    return 'pending';
}

function outboxRow(row) {
    return {
        id: row.id, target_node: row.target_node, target_name: row.target_name || 'Link machine',
        bytes: Number(row.bytes) || 0, state: deliveryState(row),
        created_at: row.created_at, accepted_at: row.accepted_at || null,
        decided_at: row.decided_at || null, completed_at: row.completed_at || null, expires_at: row.expires_at,
    };
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
            const lan = lanList(req.body?.lan);
            let thumbprint;
            try {
                crypto.createPublicKey({ key: jwk, format: 'jwk' });
                thumbprint = crypto.createHash('sha256').update(JSON.stringify({ crv: 'P-256', kty: 'EC', x: jwk.x, y: jwk.y })).digest('base64url');
            } catch { throw bad(400, 'send.bad_key', 'Link needs a valid public P-256 receive key'); }
            await db.prepare(`INSERT INTO link_send_keys (node_id, public_key, key_thumbprint, lan, updated_at) VALUES (?, ?::jsonb, ?, ?::jsonb, now())
                ON CONFLICT (node_id) DO UPDATE SET public_key = EXCLUDED.public_key, key_thumbprint = EXCLUDED.key_thumbprint,
                    lan = EXCLUDED.lan, updated_at = now()`)
                .run(machine.id, JSON.stringify(jwk), thumbprint, JSON.stringify(lan));
            res.set('Cache-Control', 'no-store').json({ node_id: machine.id, key_thumbprint: thumbprint, lan });
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
                WHERE i.target_node = ? AND i.state = 'pending' AND i.completed_at IS NULL AND i.expires_at > now() ORDER BY i.created_at`).all(target.id);
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
            const rows = await db.prepare(`SELECT n.id, n.name, n.last_seen_at, k.public_key, k.lan
                FROM platform_node_principals n JOIN link_send_keys k ON k.node_id = n.id
                WHERE n.owner_kind = 'user' AND n.owner_subject = ? AND n.status = 'active' AND n.id <> ?
                ORDER BY n.created_at DESC, n.id`).all(sender.owner_subject, sender.id);
            res.set('Cache-Control', 'no-store').json({ machines: rows.map((r) => ({
                id: r.id, name: r.name || 'Link machine', online: r.last_seen_at && Date.now() - Date.parse(r.last_seen_at) < 5 * 60_000,
                public_key: r.public_key, lan: lanOf(r.lan),
            })) });
        } catch (e) { return sendError(res, e); }
    });
    self.get('/outbox', async (req, res) => {
        try {
            const db = req.app.locals.db;
            const sender = await principal(db, req);
            const rows = await db.prepare(`SELECT i.id, i.target_node, n.name AS target_name, octet_length(i.envelope) AS bytes,
                    i.state, i.created_at, i.accepted_at, i.decided_at, i.completed_at, i.expires_at
                FROM link_send_items i LEFT JOIN platform_node_principals n ON n.id = i.target_node
                WHERE i.owner_subject = ? AND i.sender_node = ? AND i.expires_at > now()
                ORDER BY i.created_at DESC LIMIT 50`).all(sender.owner_subject, sender.id);
            res.set('Cache-Control', 'no-store').json({ items: rows.map(outboxRow) });
        } catch (e) { return sendError(res, e); }
    });
    self.get('/lan-key', async (req, res) => {
        try {
            const db = req.app.locals.db;
            const machine = await principal(db, req);
            const created = crypto.randomBytes(32).toString('base64url');
            await db.prepare(`INSERT INTO link_send_owner_secrets (owner_subject, secret) VALUES (?, ?)
                ON CONFLICT (owner_subject) DO NOTHING`).run(machine.owner_subject, created);
            const row = await db.prepare('SELECT secret FROM link_send_owner_secrets WHERE owner_subject = ?').get(machine.owner_subject);
            res.set('Cache-Control', 'no-store').json({ key: row.secret });
        } catch (e) { return sendError(res, e); }
    });
    self.post('/', express.json({ limit: MAX_ENVELOPE }), async (req, res) => {
        try {
            const db = req.app.locals.db;
            const sender = await principal(db, req);
            const targetId = String(req.body?.target_node || '');
            const envelope = req.body?.envelope;
            if (!MACHINE.test(targetId)) throw bad(400, 'send.bad_target', 'choose one of your paired machines');
            if (!validEnvelope(envelope)) throw bad(400, 'send.bad_envelope', 'the encrypted file is missing or too large');
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
    self.use('/upload', uploadRoutes(selfActor));
    self.post('/:id/:decision', async (req, res) => {
        try {
            const db = req.app.locals.db;
            const target = await principal(db, req);
            if (!ITEM.test(req.params.id)) throw bad(404, 'send.item_unavailable', 'that item is no longer waiting');
            const decision = req.params.decision;
            if (!['accept', 'decline', 'complete'].includes(decision)) throw bad(400, 'send.bad_decision', 'choose accept, decline or complete');
            if (decision === 'accept') {
                // Accept keeps the ciphertext until the receiver says it finished opening it, so an interrupted
                // download can be retried. A second accept is therefore allowed.
                const row = await db.prepare(`SELECT id, envelope FROM link_send_items
                    WHERE id = ? AND target_node = ? AND state = 'pending' AND completed_at IS NULL AND expires_at > now()`)
                    .get(req.params.id, target.id);
                if (!row) throw bad(404, 'send.item_unavailable', 'that item is no longer waiting');
                await db.prepare('UPDATE link_send_items SET accepted_at = COALESCE(accepted_at, now()) WHERE id = ? AND target_node = ?')
                    .run(row.id, target.id);
                return res.set('Cache-Control', 'no-store').json({ id: row.id, envelope: row.envelope });
            }
            if (decision === 'decline') {
                const done = await db.prepare(`UPDATE link_send_items SET state = 'declined', decided_at = now()
                    WHERE id = ? AND target_node = ? AND state = 'pending'`).run(req.params.id, target.id);
                if (!done.changes) throw bad(404, 'send.item_unavailable', 'that item is no longer waiting');
                return res.status(204).end();
            }
            const done = await db.prepare(`UPDATE link_send_items SET completed_at = now(), decided_at = now()
                WHERE id = ? AND target_node = ? AND accepted_at IS NOT NULL AND completed_at IS NULL`).run(req.params.id, target.id);
            if (!done.changes) {
                const finished = await db.prepare('SELECT completed_at FROM link_send_items WHERE id = ? AND target_node = ?').get(req.params.id, target.id);
                if (!finished?.completed_at) throw bad(404, 'send.item_unavailable', 'that item is no longer waiting');
            }
            return res.status(204).end();
        } catch (e) { return sendError(res, e); }
    });

    const keys = express.Router();
    keys.use(http.middleware(), requireAuth);
    keys.get('/', async (req, res) => {
        try {
            const db = req.app.locals.db;
            const me = await ensureUserSubject(db, req.user);
            const rows = await db.prepare(`SELECT n.id, n.name, n.status, n.last_seen_at, k.public_key, k.lan
                FROM platform_node_principals n LEFT JOIN link_send_keys k ON k.node_id = n.id
                WHERE n.owner_kind = 'user' AND n.owner_subject = ? AND n.status = 'active'
                ORDER BY n.created_at DESC, n.id`).all(me);
            res.set('Cache-Control', 'private, no-store').json({ machines: rows.map((r) => ({
                id: r.id, name: r.name || 'Link machine', online: r.last_seen_at && Date.now() - Date.parse(r.last_seen_at) < 5 * 60_000,
                public_key: r.public_key || null, lan: lanOf(r.lan),
            })) });
        } catch (e) { return sendError(res, e); }
    });
    // The browser sender on openvibe.link: POST /api/v1/me/nodes/send, as the signed-in person.
    const web = express.Router();
    web.use(http.middleware(), requireAuth);
    web.get('/', async (req, res) => {
        try {
            const db = req.app.locals.db;
            const owner = await ensureUserSubject(db, req.user);
            const rows = await db.prepare(`SELECT i.id, i.target_node, n.name AS target_name, octet_length(i.envelope) AS bytes,
                    i.state, i.created_at, i.accepted_at, i.decided_at, i.completed_at, i.expires_at
                FROM link_send_items i LEFT JOIN platform_node_principals n ON n.id = i.target_node
                WHERE i.owner_subject = ? AND i.sender_node IS NULL AND i.expires_at > now()
                ORDER BY i.created_at DESC LIMIT 50`).all(owner);
            res.set('Cache-Control', 'private, no-store').json({ items: rows.map(outboxRow) });
        } catch (e) { return sendError(res, e); }
    });
    web.post('/', express.json({ limit: MAX_ENVELOPE }), async (req, res) => {
        try {
            const db = req.app.locals.db;
            const owner = await ensureUserSubject(db, req.user);
            const targetId = String(req.body?.target_node || '');
            const envelope = req.body?.envelope;
            if (!MACHINE.test(targetId)) throw bad(400, 'send.bad_target', 'choose one of your paired machines');
            if (!validEnvelope(envelope)) throw bad(400, 'send.bad_envelope', 'the encrypted file is missing or too large');
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
    web.use('/upload', uploadRoutes(webActor));
    const cleanup = setInterval(() => {
        if (db) cleanupExpired(db).catch((e) => console.error('[Link Send] relay expiry cleanup failed:', e.message));
    }, 15 * 60_000);
    cleanup.unref?.();
    if (db) cleanupExpired(db).catch((e) => console.error('[Link Send] relay expiry cleanup failed:', e.message));
    return { self, keys, web };
}

async function assertQuota(db, owner, adding) {
    const quota = await db.prepare(`SELECT COUNT(*) AS items, COALESCE(SUM(octet_length(envelope)), 0) AS bytes
        FROM link_send_items WHERE owner_subject = ? AND state <> 'declined' AND completed_at IS NULL AND expires_at > now()`).get(owner);
    if (Number(quota.items) >= MAX_OWNER_ITEMS || Number(quota.bytes) + adding > MAX_OWNER_BYTES) {
        throw bad(429, 'send.queue_full', 'your transfer queue is full; accept or decline a waiting item first');
    }
}

async function cleanupExpired(db) {
    await db.prepare('DELETE FROM link_send_uploads WHERE expires_at <= now()').run();
    await db.prepare('DELETE FROM link_send_items WHERE expires_at <= now()').run();
}

function sendError(res, e) {
    const status = Number(e.status) || 500;
    const code = e.code || 'send.failed';
    const message = status < 500 ? e.message : 'Link could not complete that transfer';
    return http.sendProblem(res, status, code, { detail: message });
}

module.exports = { router, principal, MAX_ENVELOPE, MAX_CHUNK, MAX_OWNER_ITEMS, MAX_OWNER_BYTES, TTL_MS, UPLOAD_TTL_MS, assertQuota, cleanupExpired, deliveryState };
