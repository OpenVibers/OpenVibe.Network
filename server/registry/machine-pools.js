'use strict';
/**
 * Same-owner machine pools (bot.machine-pool@1; the pooled machines design, 2026-11-06). Several of one person's
 * machines on one local network serve one model together through llama.cpp RPC: `rpc-server` on the members and
 * `llama-server --rpc` on the head. This module holds the record and nothing that could run a model:
 *
 *   - a machine announces itself with its own node token (its private address and prefix, its link port, its free
 *     VRAM and RAM). Network takes the machine and the owner from the token and Bot, and the public address from the
 *     connection, never from the body;
 *   - the signed-in owner proposes a pool of two to eight of their machines seen in the last five minutes from one
 *     public address with private addresses in one subnet (the default head has the most free VRAM);
 *   - each machine approves it on itself (Node's local `approve`), uploading only its self-signed Ed25519 public
 *     certificate; an owner session cannot approve for a machine, and one machine cannot approve for another;
 *   - every member renews its readiness every two seconds; the offer is ready only while every member has approved,
 *     renewed in the last ten seconds and is still the owner's;
 *   - any change (a member removed from Bot, a different owner, a revoked node, a key change, a member leaving, the
 *     owner stopping it) revokes the whole pool: all machines approve a new one.
 *
 * The head's community AI offer (ai-offers.js) gets `pool: { machines, head }` (ai.offer-pool@1) from this record; a
 * member's own offer is left out while it is in a pool, so the same GPU is never sold twice.
 *
 *   GET  /api/v1/machine-pools               session   → { pools, candidates }  (no address or public IP)
 *   POST /api/v1/machine-pools               session   { machines, head? } → 201 { pool }
 *   POST /api/v1/machine-pools/:id/revoke    session   → { revoked }
 *   POST /api/v1/link/self/pools/announce    node      { address, port, free_vram, free_ram, hardware } → { machine }
 *   GET  /api/v1/link/self/pools/:id         node      → { pool }   (bot.machine-pool@1)
 *   POST /api/v1/link/self/pools/:id/approve node      { certificate } → { pool }
 *   POST /api/v1/link/self/pools/:id/status  node      { ready } → { ok, pool }
 *   POST /api/v1/link/self/pools/:id/leave   node      → { revoked }
 */
const express = require('express');
const crypto = require('node:crypto');
const net = require('node:net');
const { ids } = require('openvibe-contracts');

const CANDIDATE_TTL_MS = 5 * 60 * 1000;   // an announcement older than this is not offered for a new pool
const READY_WINDOW_MS = 10 * 1000;        // a member renews every 2 s; a missed window stops the pool's offer
const MAX_MB = 16 * 1024 * 1024;

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const iso = (now) => new Date(now).toISOString();
const ipv4 = (ip) => ip.split('.').reduce((n, x) => (n * 256 + Number(x)) >>> 0, 0);

/** A private (RFC 1918) IPv4 address with a /8 to /30 prefix → { ip, network, bits }, else null. */
function subnet(address) {
    if (typeof address !== 'string') return null;
    const [ip, prefix] = address.split('/');
    const bits = Number(prefix);
    if (net.isIP(ip) !== 4 || !/^(?:[89]|[12][0-9]|30)$/.test(prefix)) return null;
    const n = ipv4(ip), mask = (0xffffffff << (32 - bits)) >>> 0;
    const privateIP = (n >>> 24) === 10 || (n >>> 20) === (ipv4('172.16.0.0') >>> 20) || (n >>> 16) === (ipv4('192.168.0.0') >>> 16);
    return privateIP ? { ip, network: (n & mask) >>> 0, bits } : null;
}
/** Two announced machines on one local network: one public address, one private subnet, two different addresses. */
function sameNetwork(a, b) {
    const x = subnet(a.address), y = subnet(b.address);
    return Boolean(x && y && x.ip !== y.ip && x.network === y.network && x.bits === y.bits && a.public_ip && a.public_ip === b.public_ip);
}
/** A short, stable name for a machine's local network, so the owner's page can group machines without addresses. */
function networkKey(doc) {
    const s = subnet(doc.address);
    if (!s || !doc.public_ip) return null;
    return crypto.createHash('sha256').update(`${doc.public_ip}|${s.network}/${s.bits}`).digest('hex').slice(0, 12);
}
/** An unexpired, self-signed Ed25519 public certificate (PEM), never a private key. */
function certificate(value) {
    if (typeof value !== 'string' || value.length > 8192 || /PRIVATE KEY/.test(value)) fail(400, 'a public pool certificate is required');
    let cert;
    try { cert = new crypto.X509Certificate(value); } catch { fail(400, 'invalid public pool certificate'); }
    if (cert.publicKey.asymmetricKeyType !== 'ed25519' || !cert.verify(cert.publicKey) ||
        Date.parse(cert.validTo) <= Date.now() || Date.parse(cert.validFrom) > Date.now()) fail(400, 'an unexpired self-signed Ed25519 certificate is required');
    return cert.toString();
}
/** The calling machine's live node principal. A user, app or service token is refused: only a machine approves. */
async function node(db, req) {
    const sub = String(req.principal?.sub || '');
    if (!sub.startsWith('link:')) fail(403, 'only the machine itself may do this');
    const p = await db.prepare('SELECT id, owner_subject, status, owner_kind FROM platform_node_principals WHERE id = ?').get(sub.slice('link:'.length));
    if (!p || p.status !== 'active' || p.owner_kind !== 'user') fail(401, 'machine is no longer paired to an owner');
    return p;
}
async function ownMachines(bot, owner) {
    return (await bot.list(owner)).machines || [];
}
/** The pool as its members read it (bot.machine-pool@1). Rechecks every member against Bot and revokes on any change. */
async function document(db, id, owner, bot) {
    const pool = await db.prepare('SELECT * FROM machine_pools WHERE id = ? AND owner_subject = ? AND revoked_at IS NULL').get(id, owner);
    if (!pool) fail(404, 'pool not found');
    const rows = await db.prepare('SELECT * FROM machine_pool_members WHERE pool_id = ? ORDER BY machine_id').all(id);
    const current = await ownMachines(bot, owner);
    for (const member of rows) {
        const principal = await db.prepare('SELECT status, owner_subject FROM platform_node_principals WHERE id = ?').get(member.principal_id);
        if (!principal || principal.status !== 'active' || principal.owner_subject !== owner ||
            !current.some((m) => m.id === member.machine_id && m.node_id === member.principal_id)) {
            await revoke(db, id, owner);
            fail(409, 'pool membership changed; all machines must approve a new pool');
        }
    }
    return { id: pool.id, owner, head: pool.head, machines: rows.map((r) => ({ ...JSON.parse(r.doc), certificate: r.certificate || null })) };
}
async function propose(db, bot, owner, body, now = Date.now()) {
    const members = body?.machines;
    if (!Array.isArray(members) || members.length < 2 || members.length > 8 || members.some((m) => typeof m !== 'string') || new Set(members).size !== members.length) fail(400, 'choose 2-8 distinct machines');
    if (body.head != null && typeof body.head !== 'string') fail(400, 'head must be a machine id');
    const current = await ownMachines(bot, owner);
    return db.tx(async () => {
        const candidates = [];
        // Lock in a stable order: two simultaneous proposals cannot claim the same machine.
        for (const id of [...members].sort()) {
            const row = await db.prepare('SELECT * FROM machine_pool_candidates WHERE machine_id = ? AND owner_subject = ? FOR UPDATE').get(id, owner);
            if (!row || !current.some((m) => m.id === id && m.node_id === row.principal_id) || Date.parse(row.seen_at) < now - CANDIDATE_TTL_MS) fail(404, 'machine is not an available machine of this owner');
            const used = await db.prepare('SELECT m.pool_id FROM machine_pool_members m JOIN machine_pools p ON p.id = m.pool_id WHERE m.machine_id = ? AND p.revoked_at IS NULL').get(id);
            if (used) fail(409, 'machine already belongs to a pool');
            candidates.push({ row, doc: JSON.parse(row.doc) });
        }
        const head = body.head || [...candidates].sort((a, b) => b.doc.free_vram - a.doc.free_vram)[0].doc.id;
        if (!members.includes(head)) fail(400, 'head must be a member');
        const leader = candidates.find((c) => c.doc.id === head).doc;
        if (candidates.some((c) => c.doc.id !== head && !sameNetwork(leader, c.doc))) fail(400, 'machines must be on the same network');
        const id = `pool_${ids.ulid()}`;
        await db.prepare('INSERT INTO machine_pools (id, owner_subject, head, created_at) VALUES (?, ?, ?, ?)').run(id, owner, head, iso(now));
        for (const c of candidates) await db.prepare('INSERT INTO machine_pool_members (pool_id, machine_id, principal_id, doc) VALUES (?, ?, ?, ?)').run(id, c.doc.id, c.row.principal_id, JSON.stringify(c.doc));
        return { id, owner, head, machines: candidates.map((c) => ({ ...c.doc, certificate: null })) };
    });
}
async function approve(db, poolId, principal, publicCertificate, bot) {
    const pem = certificate(publicCertificate);
    // Membership is checked before the transaction, so a revocation it makes is not rolled back by the refusal.
    await document(db, poolId, principal.owner_subject, bot);
    return db.tx(async () => {
        const lock = await db.prepare('SELECT id FROM machine_pools WHERE id = ? AND revoked_at IS NULL FOR UPDATE').get(poolId);
        if (!lock) fail(404, 'pool not found');
        const member = await db.prepare('SELECT * FROM machine_pool_members WHERE pool_id = ? AND principal_id = ?').get(poolId, principal.id);
        if (!member) fail(403, 'this machine is not a member');
        if (member.certificate && member.certificate !== pem) fail(409, 'changing a key requires a new pool and new approvals');
        const others = await db.prepare('SELECT certificate FROM machine_pool_members WHERE pool_id = ? AND principal_id <> ? AND certificate IS NOT NULL').all(poolId, principal.id);
        if (others.some((m) => m.certificate === pem)) fail(400, 'each machine must generate its own key');
        await db.prepare('UPDATE machine_pool_members SET certificate = ?, approved_at = ? WHERE pool_id = ? AND principal_id = ?').run(pem, iso(Date.now()), poolId, principal.id);
        return document(db, poolId, principal.owner_subject, bot);
    });
}
async function revoke(db, id, owner) {
    await db.prepare('UPDATE machine_pools SET revoked_at = ? WHERE id = ? AND owner_subject = ? AND revoked_at IS NULL').run(iso(Date.now()), id, owner);
    await db.prepare('UPDATE machine_pool_members SET ready = false, certificate = NULL WHERE pool_id IN (SELECT id FROM machine_pools WHERE id = ? AND owner_subject = ? AND revoked_at IS NOT NULL)').run(id, owner);
}
/** The owner's pools for their machines page: approvals, readiness and each machine's share of the free VRAM. */
async function list(db, owner, now = Date.now()) {
    const pools = await db.prepare('SELECT id, head, created_at FROM machine_pools WHERE owner_subject = ? AND revoked_at IS NULL ORDER BY created_at').all(owner);
    const out = [];
    for (const p of pools) {
        const rows = await db.prepare('SELECT machine_id, approved_at, ready, seen_at, doc FROM machine_pool_members WHERE pool_id = ? ORDER BY machine_id').all(p.id);
        const docs = rows.map((r) => JSON.parse(r.doc));
        const total = docs.reduce((n, d) => n + d.free_vram, 0);
        out.push({ id: p.id, head: p.head, created_at: p.created_at, machines: rows.map((r, i) => ({
            id: r.machine_id, approved: Boolean(r.approved_at),
            ready: Boolean(r.ready && r.seen_at && Date.parse(r.seen_at) > now - READY_WINDOW_MS),
            // Credits are split by the VRAM each machine served; this is the announced share, not a speed claim.
            vram_share: total ? docs[i].free_vram / total : 1 / rows.length,
        })) });
    }
    return out;
}
/** The machines the owner can pool now, grouped by an opaque network key: no address or public IP leaves Network. */
async function candidates(db, owner, now = Date.now()) {
    const rows = await db.prepare('SELECT doc FROM machine_pool_candidates WHERE owner_subject = ? AND seen_at > ? ORDER BY machine_id').all(owner, iso(now - CANDIDATE_TTL_MS));
    return rows.map((r) => JSON.parse(r.doc)).map((d) => ({ id: d.id, free_vram: d.free_vram, free_ram: d.free_ram, hardware: d.hardware, network: networkKey(d) }));
}
/**
 * One stored AI offer as AI reads it. A machine outside any pool: as reported (a `pool` a reporter sent is dropped:
 * only this record names one). The head of a pool: with `pool` and ready only while every member is. A member that
 * is not the head: null, left out of the list.
 */
async function offerPool(db, offer, now = Date.now()) {
    const { pool: _reported, ...own } = offer;
    const row = await db.prepare('SELECT p.* FROM machine_pools p JOIN machine_pool_members m ON m.pool_id = p.id WHERE m.machine_id = ? AND p.owner_subject = ? AND p.revoked_at IS NULL').get(own.machine_id, own.owner);
    if (!row) return own;
    if (row.head !== own.machine_id) return null;
    const members = await db.prepare('SELECT m.*, n.status AS node_status, n.owner_subject AS node_owner FROM machine_pool_members m JOIN platform_node_principals n ON n.id = m.principal_id WHERE m.pool_id = ? ORDER BY m.machine_id').all(row.id);
    const ready = members.length >= 2 && members.every((m) => m.certificate && m.ready && m.seen_at && Date.parse(m.seen_at) > now - READY_WINDOW_MS && m.node_status === 'active' && m.node_owner === own.owner);
    return { ...own, pool: { machines: members.map((m) => m.machine_id), head: row.head }, ready: Boolean(own.ready && ready),
        health: ready ? own.health : { ...own.health, status: 'down' } };
}
function routers({ bot, requireAuth }) {
    const user = express.Router(), self = express.Router();
    const wrap = (fn) => async (req, res) => {
        res.set('Cache-Control', 'private, no-store');
        try { await fn(req, res, req.app.locals.db); }
        catch (e) { res.status(e.status || 503).json({ error: e.status ? e.message : 'pool registry unavailable' }); }
    };
    user.use(requireAuth, express.json({ limit: '16kb' }));
    const owner = async (db, req) => {
        if (!req.user || req.user.is_anon) fail(403, 'sign in to manage pools');
        return require('../identity/subjects').ensureUserSubject(db, req.user);
    };
    user.get('/', wrap(async (req, res, db) => {
        const subject = await owner(db, req);
        res.json({ pools: await list(db, subject), candidates: await candidates(db, subject) });
    }));
    user.post('/', wrap(async (req, res, db) => {
        const pool = await propose(db, bot, await owner(db, req), req.body);
        res.status(201).json({ pool: { id: pool.id, head: pool.head, machines: pool.machines.map((m) => ({ id: m.id, approved: false, ready: false })) } });
    }));
    user.post('/:id/revoke', wrap(async (req, res, db) => { await revoke(db, req.params.id, await owner(db, req)); res.json({ revoked: true }); }));
    // Mounted under /api/v1/link/self, whose guard (server/index.js) has already checked the node token and
    // network.link.self.manage once; every handler then resolves the live node principal (node()), which refuses a
    // request that reached it without one.
    self.use(express.json({ limit: '16kb' }));
    self.post('/announce', wrap(async (req, res, db) => {
        const p = await node(db, req), body = req.body || {};
        const machines = await ownMachines(bot, p.owner_subject);
        const machine = machines.find((m) => m.node_id === p.id);
        if (!machine) fail(403, 'paired machine not found');
        if (!subnet(body.address) || !Number.isInteger(body.port) || body.port < 1024 || body.port > 65535 ||
            !['free_vram', 'free_ram'].every((k) => Number.isInteger(body[k]) && body[k] >= 0 && body[k] <= MAX_MB)) fail(400, 'invalid local address or free memory');
        const publicIP = String(req.ip).replace(/^::ffff:/, '');
        if (!net.isIP(publicIP)) fail(400, 'source address unavailable');
        const doc = { id: machine.id, owner: p.owner_subject, address: body.address, public_ip: publicIP, port: body.port,
            free_vram: body.free_vram, free_ram: body.free_ram, hardware: String(body.hardware || 'unknown').slice(0, 120) };
        await db.prepare('INSERT INTO machine_pool_candidates (machine_id, principal_id, owner_subject, doc, seen_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (machine_id) DO UPDATE SET principal_id = excluded.principal_id, owner_subject = excluded.owner_subject, doc = excluded.doc, seen_at = excluded.seen_at').run(machine.id, p.id, p.owner_subject, JSON.stringify(doc), iso(Date.now()));
        res.json({ machine: doc });
    }));
    const member = async (db, req) => {
        const p = await node(db, req);
        const row = await db.prepare('SELECT machine_id FROM machine_pool_members WHERE pool_id = ? AND principal_id = ?').get(req.params.id, p.id);
        if (!row) fail(404, 'pool not found');
        return p;
    };
    self.get('/:id', wrap(async (req, res, db) => {
        const p = await member(db, req);
        res.json({ pool: await document(db, req.params.id, p.owner_subject, bot) });
    }));
    self.post('/:id/approve', wrap(async (req, res, db) => res.json({ pool: await approve(db, req.params.id, await node(db, req), (req.body || {}).certificate, bot) })));
    self.post('/:id/status', wrap(async (req, res, db) => {
        const p = await member(db, req);
        const pool = await document(db, req.params.id, p.owner_subject, bot);
        if (typeof (req.body || {}).ready !== 'boolean') fail(400, 'ready must be boolean');
        const result = await db.prepare('UPDATE machine_pool_members SET ready = ?, seen_at = ? WHERE pool_id = ? AND principal_id = ? AND certificate IS NOT NULL').run(req.body.ready, iso(Date.now()), req.params.id, p.id);
        if (!result.changes) fail(403, 'this machine has not approved');
        // The renewal answers with the pool, so a member checks its membership with the same request.
        res.json({ ok: true, pool });
    }));
    self.post('/:id/leave', wrap(async (req, res, db) => {
        const p = await member(db, req);
        await revoke(db, req.params.id, p.owner_subject);
        res.json({ revoked: true });
    }));
    return { user, self };
}
module.exports = { subnet, sameNetwork, networkKey, certificate, node, document, propose, approve, revoke, list, candidates, offerPool, routers, READY_WINDOW_MS };
