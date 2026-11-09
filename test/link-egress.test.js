'use strict';
const assert = require('assert/strict');
const crypto = require('crypto');
const { ids } = require('openvibe-contracts');
const { getDb } = require('../server/db/database');
const principals = require('../server/registry/link-principals');
const egress = require('../server/link/egress');

(async () => {
    const db = getDb();
    const owner = `usr_${ids.ulid()}`, other = `usr_${ids.ulid()}`;
    await db.prepare("INSERT INTO users(id, username, password_hash, subject_id) VALUES (9211, 'egressone', 'x', ?), (9212, 'egresstwo', 'x', ?)").run(owner, other);
    const pair = async subject => {
        const p = await principals.createPairing(db, 'bot', { owner: { kind: 'user', subject }, ref: `dev_${ids.ulid()}` });
        return (await principals.redeem(db, { pairing: p.pairing_id, code: p.code, name: 'Home computer' })).principal;
    };
    const own = await pair(owner), foreign = await pair(other);
    const machineId = `dev_${ids.ulid()}`;
    const bot = { list: async subject => { assert.equal(subject, owner); return { machines: [{ id: machineId, node_id: own.id }] }; } };
    assert.equal(await egress.cloudMachine(bot, { ...own, pairing_ref: 'worker:someone', paired_by_service: 'bot' }), machineId);
    await assert.rejects(egress.cloudMachine({ list: async () => ({ machines: [{ id: machineId, node_id: foreign.id }] }) }, own), { code: 'egress.node_unavailable' });
    const now = Date.now();
    const defaults = await egress.settings(db, owner);
    assert.deepEqual(defaults, { egress_via_link: true, offline_choice: 'openvibe', monthly_bytes: 20_000_000_000, excluded_sites: [] });
    assert.equal((await egress.selectRoute(db, owner, now)).mode, 'direct', 'offline defaults to OpenVibe');
    await db.prepare("INSERT INTO link_egress_settings(owner_subject, offline_choice) VALUES (?, 'wait')").run(owner);
    assert.equal((await egress.selectRoute(db, owner, now)).mode, 'wait');
    await db.prepare('INSERT INTO link_egress_devices(node_id, relay_url, checked_at) VALUES (?, ?, ?)')
        .run(own.id, 'wss://egress--mine.openvibe.link/__ov_egress', now);
    assert.equal((await egress.selectRoute(db, owner, now)).device, own.id);
    assert.equal((await egress.selectRoute(db, other, now)).mode, 'direct', 'another account never gets my online device');
    const session = `ses_${ids.ulid()}`, credential = crypto.randomBytes(32).toString('base64url');
    const hash = crypto.createHash('sha256').update(credential).digest('hex');
    await db.prepare(`INSERT INTO link_egress_sessions(session_id,owner_subject,machine,desk,node_id,credential_hash,expires_at)
        VALUES (?,?,'machine','desk-test',?,?,?)`).run(session, owner, own.id, hash, now + 60000);
    const request = { session_id: session, credential, node_id: own.id };
    assert.equal((await egress.open(db, request, now)).node_id, own.id);
    await assert.rejects(egress.open(db, { ...request, credential: crypto.randomBytes(32).toString('base64url') }, now), { code: 'egress.refused' });
    await assert.rejects(egress.open(db, { ...request, node_id: foreign.id }, now), { code: 'egress.refused' });
    await db.prepare('UPDATE link_egress_sessions SET node_id = ? WHERE session_id = ?').run(foreign.id, session);
    await assert.rejects(egress.open(db, { ...request, node_id: foreign.id }, now), { code: 'egress.owner_mismatch' }, 'session owner must equal current device owner');
    await db.prepare('UPDATE link_egress_sessions SET node_id = ? WHERE session_id = ?').run(own.id, session);
    // Ownership is read on each open, rather than trusting the prior successful open.
    await db.prepare('UPDATE platform_node_principals SET owner_subject = ? WHERE id = ?').run(other, own.id);
    await assert.rejects(egress.open(db, request, now), { code: 'egress.owner_mismatch' });
    await db.prepare('UPDATE platform_node_principals SET owner_subject = ? WHERE id = ?').run(owner, own.id);
    await db.prepare('UPDATE link_egress_settings SET egress_via_link = false WHERE owner_subject = ?').run(owner);
    assert.equal((await egress.selectRoute(db, owner, now)).mode, 'direct');
    await assert.rejects(egress.open(db, request, now), { code: 'egress.disabled' }, 'opt-out stops even an existing credential');
    await db.prepare('UPDATE link_egress_settings SET egress_via_link = true, monthly_bytes = 0 WHERE owner_subject = ?').run(owner);
    await assert.rejects(egress.open(db, request, now), { code: 'egress.disabled' });
    await db.prepare('UPDATE link_egress_settings SET monthly_bytes = 20 WHERE owner_subject = ?').run(owner);
    await assert.rejects(egress.open(db, request, now + 60001), { code: 'egress.refused' });
    await db.prepare('UPDATE link_egress_sessions SET ended = true WHERE session_id = ?').run(session);
    await assert.rejects(egress.open(db, request, now), { code: 'egress.refused' });
    assert.deepEqual(egress.validateSettings({ ...defaults, excluded_sites: ['Example.com', 'example.com'] }).excluded_sites, ['example.com']);
    for (const site of ['*.com', 'https://example.com', '127.0.0.1', 'example.com;DIRECT']) assert.throws(() => egress.validateSettings({ ...defaults, excluded_sites: [site] }));
    console.log('link egress: default, offline choices, owner mismatch on every open, opt-out, expiry, stop and settings passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
