'use strict';
// Same-owner machine pools (server/registry/machine-pools.js): only the owner's own machines can be pooled, each
// machine approves on itself, and the AI offer carries a pool only from this record. Isolated migrated PGlite: no
// production connection. Run through test/run.js.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ids } = require('openvibe-contracts');
const pools = require('../server/registry/machine-pools');
const { getDb } = require('../server/db/database');
(async () => {
    const db = getDb(), owner = `usr_${ids.ulid()}`, stranger = `usr_${ids.ulid()}`;
    const own = [], principals = [], theirs = [];
    const bot = { list: async (who) => ({ machines: who === owner ? own : who === stranger ? theirs : [] }) };
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-cert-'));
    const machine = async (who, i, list, address = `192.168.1.${i + 2}/24`, publicIP = '203.0.113.1') => {
        const principal = `nod_${ids.ulid()}`, id = `dev_${ids.ulid()}`;
        list.push({ id, node_id: principal });
        await db.prepare(`INSERT INTO platform_node_principals (id, node_id, home_cell, owner_kind, trust, owner_subject, credential_hash, created_by)
            VALUES (?, ?, 'wnam-1', 'user', 'community', ?, ?, ?)`).run(principal, `pool-node-${id.slice(-12).toLowerCase()}`, who, require('node:crypto').createHash('sha256').update(id).digest('hex'), who);
        const doc = { id, owner: who, address, public_ip: publicIP, port: 50053, free_vram: (i + 1) * 1000, free_ram: 16000, hardware: 'test' };
        await db.prepare('INSERT INTO machine_pool_candidates (machine_id, principal_id, owner_subject, doc, seen_at) VALUES (?, ?, ?, ?, ?)')
            .run(id, principal, who, JSON.stringify(doc), new Date().toISOString());
        return { id: principal, owner_subject: who, machine: id };
    };
    try {
        for (let i = 0; i < 3; i++) principals.push(await machine(owner, i, own));
        const strangers = [await machine(stranger, 7, theirs)];
        const elsewhere = await machine(owner, 8, own, '192.168.9.9/24', '198.51.100.4');

        // Only the owner's own machines can be pooled.
        await assert.rejects(pools.propose(db, bot, stranger, { machines: own.slice(0, 2).map((m) => m.id) }), /owner/, 'a stranger cannot pool my machines');
        await assert.rejects(pools.propose(db, bot, owner, { machines: [own[0].id, strangers[0].machine] }), /owner/, 'I cannot pool a stranger\'s machine');
        await assert.rejects(pools.propose(db, bot, owner, { machines: [own[0].id, elsewhere.machine] }), /same network/, 'a machine on another network is refused');
        await assert.rejects(pools.propose(db, bot, owner, { machines: [own[0].id] }), /2-8/);
        await assert.rejects(pools.propose(db, bot, owner, { machines: [own[0].id, own[0].id] }), /2-8/);
        await assert.rejects(pools.propose(db, bot, owner, { machines: [own[0].id, own[1].id], head: own[2].id }), /head must be a member/);

        const pool = await pools.propose(db, bot, owner, { machines: own.slice(0, 2).map((m) => m.id) });
        assert.equal(pool.head, own[1].id, 'most free VRAM is the default head');
        assert.ok(pool.machines.every((m) => m.certificate === null), 'a new pool has no approvals');
        const offer = { offer_id: `ai:${pool.head}`, machine_id: pool.head, owner, ready: true, health: { status: 'up' } };
        assert.equal((await pools.offerPool(db, offer)).ready, false, 'no traffic before approvals');

        const certs = [];
        for (let i = 0; i < 3; i++) {
            const key = path.join(temp, `key${i}.pem`), cert = path.join(temp, `cert${i}.pem`);
            execFileSync('openssl', ['req', '-x509', '-newkey', 'ed25519', '-nodes', '-days', '1', '-subj', '/CN=pool-test', '-keyout', key, '-out', cert], { stdio: 'ignore' });
            certs.push(fs.readFileSync(cert, 'utf8'));
        }
        const privateKey = fs.readFileSync(path.join(temp, 'key0.pem'), 'utf8');

        // The approve step is needed on each machine, by that machine.
        for (const sub of ['svc:bot', `user:${owner}`, owner, 'app:app_01J8Z3Q4R5S6T7V8W9X0Y1Z2A1', '']) {
            await assert.rejects(pools.node(db, { principal: { sub } }), /only the machine/, `${sub || 'no principal'} cannot act for a machine`);
        }
        await assert.rejects(pools.node(db, {}), /only the machine/, 'a request that skipped the node guard is refused');
        await assert.rejects(pools.node(db, { principal: { sub: `node:nod_${ids.ulid()}` } }), /no longer paired/);
        await assert.rejects(pools.approve(db, pool.id, principals[2], certs[2], bot), /not a member/, 'a machine outside the pool cannot approve it');
        await assert.rejects(pools.approve(db, pool.id, strangers[0], certs[2], bot), /not found/, 'a stranger\'s machine cannot see the pool');
        await assert.rejects(pools.approve(db, pool.id, principals[0], privateKey, bot), /public pool certificate/, 'a private key is refused');
        await assert.rejects(pools.approve(db, pool.id, principals[0], 'not a certificate', bot), /invalid public pool certificate/);
        await pools.approve(db, pool.id, principals[0], certs[0], bot);
        assert.equal((await pools.offerPool(db, offer)).ready, false, 'one approval cannot approve the other machine');
        let listed = (await pools.list(db, owner))[0];
        assert.deepEqual(listed.machines.map((m) => m.approved).sort(), [false, true]);
        await assert.rejects(pools.approve(db, pool.id, principals[1], certs[0], bot), /own key/);
        await pools.approve(db, pool.id, principals[1], certs[1], bot);
        await assert.rejects(pools.approve(db, pool.id, principals[0], certs[2], bot), /new pool/, 'a key change needs a new pool');

        // Ready only while every member renews; a member is never a second offer for the same GPU.
        await db.prepare('UPDATE machine_pool_members SET ready = true, seen_at = ? WHERE pool_id = ?').run(new Date().toISOString(), pool.id);
        const live = await pools.offerPool(db, offer);
        assert.equal(live.ready, true);
        assert.deepEqual(new Set(live.pool.machines), new Set(own.slice(0, 2).map((m) => m.id)));
        assert.equal(live.pool.head, pool.head);
        assert.equal(await pools.offerPool(db, { ...offer, offer_id: `ai:${own[0].id}`, machine_id: own[0].id }), null, 'members do not double-sell the same GPU');
        assert.equal((await pools.offerPool(db, offer, Date.now() + pools.READY_WINDOW_MS + 1000)).ready, false, 'a missed renewal stops the whole offer');
        assert.equal((await pools.offerPool(db, offer, Date.now() + pools.READY_WINDOW_MS + 1000)).health.status, 'down');
        listed = (await pools.list(db, owner))[0];
        assert.ok(listed.machines.every((m) => m.approved && m.ready));
        assert.equal(Math.round(listed.machines.reduce((n, m) => n + m.vram_share, 0) * 1000), 1000, 'the VRAM shares split the credits whole');
        assert.ok(!('owner_subject' in listed) && !('revoked_at' in listed), 'the owner view is not a raw row');

        // Only the pool record names a pool: a reported one is dropped.
        const outside = { offer_id: `ai:${own[2].id}`, machine_id: own[2].id, owner, ready: true, health: { status: 'up' } };
        const forged = await pools.offerPool(db, { ...outside, pool: { machines: [own[2].id, own[0].id], head: own[2].id } });
        assert.equal(forged.pool, undefined, 'a machine cannot nominate a pool of its own');
        assert.equal(forged.ready, true);

        // The owner's page sees machines and an opaque network key, never an address or public IP.
        const cands = await pools.candidates(db, owner);
        assert.ok(cands.length >= 3);
        assert.ok(cands.every((c) => !('address' in c) && !('public_ip' in c) && !JSON.stringify(c).includes('203.0.113')));
        const keys = new Map(cands.map((c) => [c.id, c.network]));
        assert.equal(keys.get(own[0].id), keys.get(own[1].id), 'same network, same key');
        assert.notEqual(keys.get(own[0].id), keys.get(elsewhere.machine), 'another network, another key');
        assert.ok(!cands.some((c) => c.id === strangers[0].machine), 'a stranger\'s machine is never listed');

        await assert.rejects(pools.propose(db, bot, owner, { machines: [own[0].id, own[2].id] }), /already belongs/);

        // Removing a machine from its owner revokes the whole pool, and the pool's offer goes with it.
        own.splice(0, 1);
        await assert.rejects(pools.document(db, pool.id, owner, bot), /membership changed/);
        assert.equal((await pools.list(db, owner)).length, 0, 'removing a machine revokes its pool');
        const after = await pools.offerPool(db, offer);
        assert.equal(after.pool, undefined, 'a revoked pool is no longer offered');
        const certsLeft = await db.prepare('SELECT COUNT(*) AS n FROM machine_pool_members WHERE pool_id = ? AND certificate IS NOT NULL').get(pool.id);
        assert.equal(Number(certsLeft.n), 0, 'revocation forgets the public certificates');

        assert.equal(pools.sameNetwork({ address: '192.168.1.2/24', public_ip: '1.1.1.1' }, { address: '192.168.2.2/24', public_ip: '1.1.1.1' }), false);
        assert.equal(pools.sameNetwork({ address: '192.168.1.2/24', public_ip: '1.1.1.1' }, { address: '192.168.1.3/24', public_ip: '1.1.1.2' }), false);
        assert.equal(pools.sameNetwork({ address: '192.168.1.2/24', public_ip: '1.1.1.1' }, { address: '192.168.1.2/24', public_ip: '1.1.1.1' }), false, 'one address is one machine');
        for (const bad of ['0.0.0.0/24', '8.8.8.8/24', '127.0.0.1/8', '192.168.1.2/32', '192.168.1.2', '172.32.0.1/16']) assert.equal(pools.subnet(bad), null, bad);
        console.log('machine-pools: owner isolation, per-machine approvals, unique public keys, head selection, renewals, member suppression, forged pools and revocation passed');
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
})().catch((err) => { console.error(err); process.exitCode = 1; });
