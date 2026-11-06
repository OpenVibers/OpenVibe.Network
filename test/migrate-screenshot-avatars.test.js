'use strict';
// The one-off move of every profile picture onto the person's own avatar object (incident 2026-11-06).
//   - the dry run lists exactly the rows it would change, and changes nothing (Network or Live);
//   - --apply copies each https picture through Media (product + slot recorded), clears a value that is not a
//     picture address, falls a legacy Live local path back to the linked Network picture or the initial, copies a
//     channel banner with the wide shape, and announces the Network profile updates.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-avatar-migration-'));
    const key = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const keyPath = path.join(tmp, 'private.pem');
    fs.writeFileSync(keyPath, key.privateKey);
    process.env.JWT_PRIVATE_KEY = keyPath;

    const { getDb } = require('../server/db/database');
    const script = require('../scripts/migrate-screenshot-avatars');

    const OBJECT = 'https://openvibe.media/o/med_01KZK5GRQ088Y3CW1TMEF4Z4RN';
    const PASTE = 'https://openvibe.media/p/fierce-clover-90/screenshot';
    const LEGACY = '/data/avatars/avatar-13-1773211874260.png';

    const db = getDb();
    await db.prepare(`INSERT INTO users (id, username, password_hash, avatar_url, subject_id) VALUES
        (501, 'Ana', 'x', ?, 'usr_01KZK5GRQ088Y3CW1TMEF4Z4R1'),
        (502, 'Ben', 'x', ?, 'usr_01KZK5GRQ088Y3CW1TMEF4Z4R2'),
        (503, 'Cal', 'x', ?, 'usr_01KZK5GRQ088Y3CW1TMEF4Z4R3'),
        (504, 'Dee', 'x', NULL, 'usr_01KZK5GRQ088Y3CW1TMEF4Z4R4')`).run(OBJECT, PASTE, LEGACY);

    const live = {
        userRows: [
            { id: 13, username: 'Cal', avatar_url: LEGACY, network_user_id: 503 },
            { id: 461, username: 'Ben', avatar_url: PASTE, network_user_id: 502 },
        ],
        bannerRows: [{ id: 7, offline_banner_url: 'https://openvibe.media/p/banner-shot/screenshot', network_user_id: 502 }],
        async users() { return this.userRows; },
        async banners() { return this.bannerRows; },
        async setUserAvatar(id, url) { this.userRows.find((u) => u.id === id).avatar_url = url; },
        async setBanner(id, url) { this.bannerRows.find((c) => c.id === id).offline_banner_url = url; },
    };
    const take = () => ({ users: live.userRows.map((u) => ({ ...u })), banners: live.bannerRows.map((c) => ({ ...c })) });

    // ── Dry run: the exact list, no write anywhere ──────────────
    const before = take();
    const lines = [];
    const log = { log: (m) => lines.push(String(m)), error: (m) => lines.push(`ERROR ${m}`) };
    const code = await script.main([], { db, live, log });
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(lines, [
        `network users.avatar_url id=501  copy ${OBJECT}`,
        `network users.avatar_url id=502  copy ${PASTE}`,
        `network users.avatar_url id=503  not a picture address ${LEGACY} → the initial`,
        'live avatar:13  legacy local path /data/avatars/avatar-13-1773211874260.png → the initial',
        `live avatar:461  copy ${PASTE}`,
        'live banner:7  copy https://openvibe.media/p/banner-shot/screenshot',
        'dry run: 3 Network avatar(s), 3 Live picture(s)/banner(s)',
        'Nothing changed. Re-run with --apply to copy them into avatar objects.',
    ], 'the dry run lists exactly the affected rows');
    assert.deepStrictEqual((await db.prepare('SELECT avatar_url FROM users WHERE id = 501').get()).avatar_url, OBJECT, 'the dry run writes nothing on Network');
    assert.deepStrictEqual(take(), before, 'the dry run writes nothing on Live');

    // ── Apply: copy through Media, fall back, announce ──────────
    const realFetch = global.fetch;
    const calls = [];
    const NEW = 'med_01KZK5GRQ088Y3CW1TMEF4Z4RX';
    global.fetch = async (u, o) => {
        const url = String(u); const body = o && o.body ? JSON.parse(o.body) : null;
        calls.push({ url, body });
        if (url.endsWith('/internal/avatar-ingest')) {
            const id = body.shape === 'banner' ? 'med_01KZK5GRQ088Y3CW1TMEF4Z4RY' : NEW;
            return { ok: true, json: async () => ({ ok: true, object_id: id, url: `https://openvibe.media/o/${id}`, reused: false }) };
        }
        return { ok: true, json: async () => ({ ok: true, released: 1 }) };
    };
    try {
        lines.length = 0;
        const applied = await script.main(['--apply'], { db, live, log });
        assert.strictEqual(applied, 0, lines.join('\n'));

        const avatar = async (id) => (await db.prepare('SELECT avatar_url FROM users WHERE id = ?').get(id)).avatar_url;
        assert.strictEqual(await avatar(501), `https://openvibe.media/o/${NEW}`, 'an avatar object is copied too (only the person\'s own is reused)');
        assert.strictEqual(await avatar(502), `https://openvibe.media/o/${NEW}`, 'a paste screenshot becomes an avatar object');
        assert.strictEqual(await avatar(503), null, 'a value that is not a picture address is cleared to the initial');
        assert.strictEqual(await avatar(504), null, 'an account without a picture is left alone');

        const ingest = calls.filter((c) => c.url.endsWith('/internal/avatar-ingest')).map((c) => c.body);
        assert.ok(ingest.some((b) => b.url === PASTE && b.product === 'network' && b.ref === '502' && b.subject === 'usr_01KZK5GRQ088Y3CW1TMEF4Z4R2'),
            'the Network copy records the profile reference and the owner subject');
        assert.ok(calls.some((c) => c.url.endsWith('/internal/avatar-release') && c.body.ref === '503'), 'clearing releases the old reference');
        assert.ok(lines.some((l) => /announced \d+ profile update/.test(l)), `the profile updates are announced: ${lines.join(' | ')}`);
        const events = await db.prepare("SELECT envelope FROM network_event_outbox").all();
        assert.ok(events.some((e) => JSON.stringify(e.envelope).includes('usr_01KZK5GRQ088Y3CW1TMEF4Z4R2') && JSON.stringify(e.envelope).includes('network.user.updated')),
            'network.user.updated is queued for the changed people');

        assert.strictEqual(live.userRows.find((u) => u.id === 13).avatar_url, null, 'the legacy Live local path falls back to Network\'s (here the initial)');
        assert.strictEqual(live.userRows.find((u) => u.id === 461).avatar_url, `https://openvibe.media/o/${NEW}`, 'Live\'s own copy points at an avatar object');
        assert.strictEqual(live.bannerRows.find((c) => c.id === 7).offline_banner_url, 'https://openvibe.media/o/med_01KZK5GRQ088Y3CW1TMEF4Z4RY', 'the banner is copied with the wide shape');
        assert.ok(ingest.some((b) => b.shape === 'banner' && b.product === 'live' && b.ref === 'banner:7'), 'the banner slot is its own reference');
        assert.ok(ingest.some((b) => b.product === 'live' && b.ref === 'avatar:461' && b.subject === 'usr_01KZK5GRQ088Y3CW1TMEF4Z4R2'), 'Live\'s avatar records the slot and the linked subject');

        console.log('migrate screenshot avatars: all checks passed');
    } finally {
        global.fetch = realFetch;
        fs.rmSync(tmp, { recursive: true, force: true });
    }
})().catch((err) => { console.error(err); process.exit(1); });
