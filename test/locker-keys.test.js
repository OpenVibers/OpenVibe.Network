'use strict';
/**
 * The Locker key directory (design 2026-11-06, LOCKER-DESIGN-2026-11-06.md §4; Opus's review of #577): Network
 * holds a person's public keys, their self-signature and their wrapped private keys, and never a private key in
 * the clear — and a stolen session cannot swap in somebody else's keys, because a change needs the signature of
 * the key the person has now.
 *
 *   node test/locker-keys.test.js
 *
 * What is checked here: a bad self-signature and a mismatched fingerprint are refused; an oversized blob and a
 * blob with a low PBKDF2 count are refused; one person's backup is never readable by another; the public keys are
 * found by subject and by exact name; a key change is written to the history and announced; the keys and the
 * backups can be forgotten; the lookups are rate-limited per caller; no key, signature or blob ever reaches a log
 * line. And the proof itself: a rotation with a good proof, with a bad proof and with none; a reset with a
 * recent sign-in and with a stale one; a forget with a proof and with a recent sign-in; and the notice every
 * change sends the person.
 */
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { ids } = require('openvibe-contracts');
const { getDb } = require('../server/db/database');
const { generatePersonKeys, exportPersonKeys, exportPrivateKeys, seal } = require('openvibe-sdk/locker');

(async () => {
const db = getDb();
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const config = { jwt: { issuer: 'https://openvibe.network', accessTokenExpiry: '1h' } };
const { signToken } = require('../server/auth/routes');
const requireAuth = require('../server/auth/session').makeRequireAuth(() => ({ db, publicKey: keys.publicKey, config }), signToken);
const locker = require('../server/locker/keys');
const { NotificationService } = require('../server/notifications/notification-service');
const notifications = new NotificationService(db);

const ANN = ids.newId('user');
const BOB = ids.newId('user');
const RATELIMIT = ids.newId('user');
await db.prepare(`INSERT INTO users (id, username, display_name, password_hash, subject_id, role) VALUES
    (1, 'ann', 'Ann', 'x', ?, 'user'), (2, 'bob', 'Bob', 'x', ?, 'user'), (3, 'ratelimit', 'Rate', 'x', ?, 'user')`)
    .run(ANN, BOB, RATELIMIT);

const app = express();
app.use(require('cookie-parser')());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
Object.assign(app.locals, { db, config, privateKey: keys.privateKey, publicKey: keys.publicKey });
const FIRST_PARTY = new Set(['https://openvibe.community', 'https://openvibe.live']);
app.use('/api/v1/me/keys', locker.meRouter(requireAuth, { notifications, isFirstPartyOrigin: (o) => FIRST_PARTY.has(o) }));
app.use('/api/v1/people', locker.peopleRouter(requireAuth));
const server = http.createServer(app);

/** A person's keys, as the browser would send them: the public halves and the self-signature. */
async function published() {
    const person = await generatePersonKeys();
    const pub = await exportPersonKeys(person);
    const priv = await exportPrivateKeys(person);
    return {
        person, priv,
        body: { ecdh_public: pub.ecdh, signing_public: pub.signing, self_signature: pub.fingerprint_signature },
        fingerprint: pub.fingerprint,
    };
}

/** A backup: the private keys sealed with a passphrase, as a Locker envelope in base64. */
async function backupOf(priv, password = 'a good passphrase') {
    const sealed = await seal(JSON.stringify(priv), { lock: 'password', password });
    return { format: 'locker.envelope.v1', envelope: Buffer.from(sealed.bytes).toString('base64') };
}

/** The same envelope with its header changed: the bytes a hostile client would send. */
function repatch(bytes, mutate) {
    const headerLength = bytes.readUInt32BE(4);
    const header = JSON.parse(bytes.subarray(8, 8 + headerLength).toString('utf8'));
    mutate(header);
    const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(headerBytes.length);
    return Buffer.concat([bytes.subarray(0, 4), length, headerBytes, bytes.subarray(8 + headerLength)]);
}

/** A signature over some bytes, by a person's signing key: what the browser sends as previous_signature. */
async function sign(person, bytes) {
    const signature = await globalThis.crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, person.signing.privateKey, bytes);
    return Buffer.from(signature).toString('base64');
}

const events = async () => (await db.prepare("SELECT envelope FROM network_event_outbox WHERE envelope::jsonb ->> 'event_type' = ? ORDER BY id").all(locker.EVENT_TYPE))
    .map((r) => (typeof r.envelope === 'string' ? JSON.parse(r.envelope) : r.envelope));
const history = async () => await db.prepare('SELECT subject, fingerprint, "from", "to", reason FROM locker_key_history ORDER BY id').all();
const backups = async () => await db.prepare('SELECT subject, kind, blob FROM locker_key_backups ORDER BY kind').all();
const notices = async () => (await db.prepare('SELECT message, category, service FROM notifications WHERE user_id = ? ORDER BY created_at').all(1)).map((n) => n.message);

(async () => {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const tok = async (id, opts = {}) => signToken(await db.prepare('SELECT * FROM users WHERE id = ?').get(id), keys.privateKey, config, opts);
    const as = async (id, opts = {}) => ({ authorization: `Bearer ${await tok(id, opts)}` });
    const call = (method, p, { body, headers = {} } = {}) => fetch(base + p, {
        method, headers: { 'content-type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, cache: r.headers.get('cache-control'), vary: r.headers.get('vary'), body: await r.json().catch(() => null) }));

    // Every log line the server writes while the calls below run.
    const logs = [];
    const realLog = console.log; const realError = console.error; const realWarn = console.warn;
    const spy = (...args) => { logs.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ')); };
    console.log = spy; console.error = spy; console.warn = spy;

    try {
        const ann = await published();
        const bob = await published();

        // ── The bytes a person signs are the bytes we say they are ──
        const backupsForProof = { passphrase: { format: 'locker.envelope.v1', envelope: 'abc' } };
        assert.strictEqual(locker.canonicalBackups(backupsForProof), '{"passphrase":{"envelope":"abc","format":"locker.envelope.v1"}}',
            'the canonical backups sort the keys and write no spaces');
        assert.strictEqual(await locker.backupsDigest(backupsForProof),
            '9706d4056a8e35c24ea67c65358650550fdde6f5770372a206173009ef1d3cf8',
            'the digest is the hex SHA-256 of the canonical backups');
        assert.strictEqual(await locker.keyChangeProofMessage(ANN, ann.fingerprint, backupsForProof),
            `openvibe-locker key-change v1|${ANN}|${ann.fingerprint}|9706d4056a8e35c24ea67c65358650550fdde6f5770372a206173009ef1d3cf8`,
            'the proof names the subject, the new fingerprint and the backups');
        assert.strictEqual(locker.forgetProofMessage(ANN), `openvibe-locker forget v1|${ANN}`, 'the forget proof names the subject');

        // ── The keys go in; the fingerprint is ours, not the caller's ──
        assert.strictEqual((await call('PUT', '/api/v1/me/keys', { body: ann.body })).status, 401, 'signed in only');
        let r = await call('PUT', '/api/v1/me/keys', { headers: await as(1), body: ann.body });
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.strictEqual(r.body.fingerprint, ann.fingerprint, 'the fingerprint is computed here');
        assert.strictEqual(r.body.subject, ANN);
        assert.strictEqual(r.body.changed, true);
        assert.strictEqual(r.body.reason, 'created');
        assert.match(r.cache, /private/); assert.match(r.cache, /no-store/);
        assert.strictEqual(r.vary, 'Authorization, Cookie');
        assert.ok(!('backups' in r.body), 'the answer never carries a backup');
        assert.deepStrictEqual(Object.keys(r.body).sort(), ['changed', 'changed_at', 'ecdh_public', 'fingerprint', 'reason', 'signing_public', 'subject', 'updated_at']);

        // ── A bad self-signature is refused ──
        const badSignature = { ...ann.body, self_signature: Buffer.from(crypto.randomBytes(64)).toString('base64') };
        r = await call('PUT', '/api/v1/me/keys', { headers: await as(1), body: badSignature });
        assert.strictEqual(r.status, 400, 'a signature that does not verify is refused');
        assert.strictEqual(r.body.code, 'locker.bad_signature');

        // ── A fingerprint that does not match the keys is refused ──
        r = await call('PUT', '/api/v1/me/keys', { headers: await as(1), body: { ...ann.body, fingerprint: 'alpha bravo charlie delta-echo foxtrot golf hotel' } });
        assert.strictEqual(r.status, 400, 'a fingerprint that is not the one the keys produce is refused');
        assert.strictEqual(r.body.code, 'locker.fingerprint_mismatch');

        // ── A key that is not a P-256 key is refused ──
        r = await call('PUT', '/api/v1/me/keys', { headers: await as(1), body: { ...ann.body, ecdh_public: { kty: 'EC', crv: 'P-384', x: 'x', y: 'y' } } });
        assert.strictEqual(r.status, 400);
        assert.strictEqual(r.body.code, 'locker.bad_keys');

        // ── A backup: the wrapped private keys, sealed with a passphrase ──
        const backup = await backupOf(ann.priv);
        const backupProof = await sign(ann.person, await locker.keyChangeProofBytes(ANN, ann.fingerprint, { passphrase: backup }));
        r = await call('PUT', '/api/v1/me/keys', { headers: await as(1), body: { ...ann.body, backups: { passphrase: backup }, previous_signature: backupProof } });
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.strictEqual(r.body.changed, true, 'the backup is a change');
        let held = await backups();
        assert.strictEqual(held.length, 1);
        assert.strictEqual(held[0].kind, 'passphrase');
        assert.strictEqual(held[0].blob.format, 'locker.envelope.v1');
        assert.strictEqual(held[0].blob.envelope, backup.envelope, 'the blob is stored as it came');

        // ── An oversized blob is refused ──
        const huge = { format: 'locker.envelope.v1', envelope: Buffer.alloc(20 * 1024, 7).toString('base64') };
        r = await call('PUT', '/api/v1/me/keys', { headers: await as(1), body: { ...ann.body, backups: { passphrase: huge } } });
        assert.strictEqual(r.status, 413, 'a blob bigger than 16 KB is refused');
        assert.strictEqual(r.body.code, 'locker.backup_too_large');

        // ── A blob with a low PBKDF2 count is refused ──
        const weak = repatch(Buffer.from(backup.envelope, 'base64'), (h) => { h.slots.password.iterations = 1000; });
        r = await call('PUT', '/api/v1/me/keys', { headers: await as(1), body: { ...ann.body, backups: { passphrase: { format: 'locker.envelope.v1', envelope: weak.toString('base64') } } } });
        assert.strictEqual(r.status, 400, 'a blob with too few iterations is refused');
        assert.strictEqual(r.body.code, 'locker.bad_iterations');

        // ── A blob that is not a Locker envelope is refused ──
        r = await call('PUT', '/api/v1/me/keys', { headers: await as(1), body: { ...ann.body, backups: { passphrase: { format: 'locker.envelope.v1', envelope: Buffer.from('not an envelope at all').toString('base64') } } } });
        assert.strictEqual(r.status, 400);
        assert.strictEqual(r.body.code, 'locker.bad_backup');

        // ── A backup of a kind we do not know is refused ──
        r = await call('PUT', '/api/v1/me/keys', { headers: await as(1), body: { ...ann.body, backups: { carrier_pigeon: backup } } });
        assert.strictEqual(r.status, 400);
        assert.strictEqual(r.body.code, 'locker.unknown_backup');

        // ── The public keys are found by subject and by exact name ──
        r = await call('GET', `/api/v1/people/${ANN}/keys`, { headers: await as(2) });
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.deepStrictEqual(Object.keys(r.body).sort(), ['changed_at', 'ecdh_public', 'fingerprint', 'signing_public', 'subject', 'updated_at']);
        assert.strictEqual(r.body.fingerprint, ann.fingerprint);
        assert.ok(r.body.changed_at, 'the last key change is there, so a sheet can warn');
        assert.match(r.cache, /no-store/);

        r = await call('GET', '/api/v1/people/@ann/keys', { headers: await as(2) });
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.strictEqual(r.body.fingerprint, ann.fingerprint);

        r = await call('GET', '/api/v1/people/@ANN/keys', { headers: await as(2) });
        assert.strictEqual(r.status, 200, 'names are not case-sensitive, but they are exact');

        assert.strictEqual((await call('GET', `/api/v1/people/${ANN}/keys`)).status, 401, 'signed in only');
        assert.strictEqual((await call('GET', '/api/v1/people/@nobody/keys', { headers: await as(2) })).status, 404, 'no such person');
        assert.strictEqual((await call('GET', '/api/v1/people/@ann/keys/extra', { headers: await as(2) })).status, 404, 'exact names only');

        // ── One person's backup is never readable by another ──
        r = await call('GET', '/api/v1/me/keys/backup', { headers: await as(1) });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.subject, ANN);
        assert.strictEqual(r.body.backups.passphrase.envelope, backup.envelope, 'my own backup comes back');
        assert.match(r.cache, /no-store/);

        r = await call('GET', '/api/v1/me/keys/backup', { headers: await as(2) });
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(r.body.backups, {}, 'another person gets nothing of mine');
        assert.ok(!JSON.stringify(r.body).includes(backup.envelope), 'not even a part of it');

        r = await call('GET', `/api/v1/people/${ANN}/keys/backup`, { headers: await as(2) });
        assert.strictEqual(r.status, 404, 'there is no route to another person\'s backup');
        r = await call('GET', `/api/v1/people/${ANN}/keys`, { headers: await as(2) });
        assert.ok(!JSON.stringify(r.body).includes(backup.envelope), 'the public keys carry no blob');

        // ── The history and the event say what happened ──
        let rows = await history();
        assert.deepStrictEqual(rows.map((h) => [h.subject, h.reason, h['from'], h['to']]),
            [[ANN, 'created', null, ann.fingerprint], [ANN, 'restored', ann.fingerprint, ann.fingerprint]],
            'the first set of keys, then the same keys with a backup');
        let ev = await events();
        assert.strictEqual(ev.length, 2, 'two events: the first set of keys and the backup');
        assert.deepStrictEqual(ev[0].payload, {
            subject: { type: 'user', id: ANN }, fingerprint: ann.fingerprint, previous_fingerprint: null,
            reason: 'created', changed_at: ev[0].payload.changed_at,
        });
        assert.ok(!JSON.stringify(ev[0]).includes(backup.envelope), 'the event carries no blob');

        // ── A change needs the signature of the key the person has now ──
        const rotated = await published();
        r = await call('PUT', '/api/v1/me/keys', { headers: await as(1), body: rotated.body });
        assert.strictEqual(r.status, 403, 'no proof, no change');
        assert.strictEqual(r.body.code, 'locker.proof_required');

        const wrongProof = await sign(bob.person, await locker.keyChangeProofBytes(ANN, rotated.fingerprint, {}));
        r = await call('PUT', '/api/v1/me/keys', { headers: await as(1), body: { ...rotated.body, previous_signature: wrongProof } });
        assert.strictEqual(r.status, 403, 'a proof by another key is refused');
        assert.strictEqual(r.body.code, 'locker.proof_required');

        const otherProof = await sign(ann.person, await locker.keyChangeProofBytes(ANN, ann.fingerprint, {}));
        r = await call('PUT', '/api/v1/me/keys', { headers: await as(1), body: { ...rotated.body, previous_signature: otherProof } });
        assert.strictEqual(r.status, 403, 'a proof over other bytes is refused');
        assert.strictEqual(r.body.code, 'locker.proof_required');

        // Nothing changed while the proofs were refused.
        assert.strictEqual((await history()).length, 2, 'a refused change leaves no trace');

        const goodProof = await sign(ann.person, await locker.keyChangeProofBytes(ANN, rotated.fingerprint, {}));
        r = await call('PUT', '/api/v1/me/keys', { headers: await as(1), body: { ...rotated.body, previous_signature: goodProof } });
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.strictEqual(r.body.changed, true);
        assert.strictEqual(r.body.reason, 'rotated');
        assert.strictEqual(r.body.fingerprint, rotated.fingerprint);
        rows = await history();
        assert.strictEqual(rows.length, 3);
        assert.deepStrictEqual([rows[2].reason, rows[2]['from'], rows[2]['to']], ['rotated', ann.fingerprint, rotated.fingerprint]);
        ev = await events();
        assert.strictEqual(ev.length, 3);
        assert.deepStrictEqual([ev[2].payload.reason, ev[2].payload.previous_fingerprint, ev[2].payload.fingerprint],
            ['rotated', ann.fingerprint, rotated.fingerprint]);

        // The sheet sees the change: the fingerprint and the day it changed.
        r = await call('GET', `/api/v1/people/${ANN}/keys`, { headers: await as(2) });
        assert.strictEqual(r.body.fingerprint, rotated.fingerprint);
        assert.strictEqual(typeof r.body.changed_at, 'string', 'the last change is there');

        // ── Every change tells the person ──
        let said = await notices();
        assert.strictEqual(said.length, 3, 'three changes, three notices');
        assert.ok(said.includes(locker.NOTICES.created), 'the first set of keys is announced');
        assert.ok(said.includes(locker.NOTICES.restored), 'the backup is announced');
        assert.ok(said.includes(locker.NOTICES.rotated), 'the rotation is announced');

        // ── A reset: the passphrase and the recovery kit are gone ──
        const stale = { authTime: Math.floor(Date.now() / 1000) - 3600 };
        r = await call('PUT', '/api/v1/me/keys', { headers: await as(1, stale), body: { ...rotated.body, reset: true } });
        assert.strictEqual(r.status, 403, 'a reset needs a sign-in from the last ten minutes');
        assert.strictEqual(r.body.code, 'locker.reauth_required');

        const afterReset = await published();
        r = await call('PUT', '/api/v1/me/keys', { headers: await as(1), body: { ...afterReset.body, reset: true } });
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.strictEqual(r.body.reason, 'reset');
        assert.strictEqual(r.body.fingerprint, afterReset.fingerprint);
        rows = await history();
        assert.strictEqual(rows.length, 4);
        assert.deepStrictEqual([rows[3].reason, rows[3]['from'], rows[3]['to']], ['reset', rotated.fingerprint, afterReset.fingerprint]);
        ev = await events();
        assert.strictEqual(ev.length, 4);
        assert.deepStrictEqual([ev[3].payload.reason, ev[3].payload.previous_fingerprint], ['reset', rotated.fingerprint]);
        said = await notices();
        assert.ok(said.includes('Your locker was reset: things locked for your old keys cannot be opened'),
            'the person is told what the reset means');

        // ── The lookups are rate-limited per caller ──
        let limited = null;
        for (let i = 0; i < 62; i++) {
            const rr = await call('GET', `/api/v1/people/${BOB}/keys`, { headers: await as(3) });
            if (rr.status === 429) { limited = { i, body: rr.body }; break; }
        }
        assert.ok(limited, 'the rate limit answers');
        assert.strictEqual(limited.i, 60, 'sixty a minute, then the limit');
        assert.strictEqual((await call('GET', `/api/v1/people/${ANN}/keys`, { headers: await as(2) })).status, 200, 'another caller is not affected');

        // ── Forgetting the locker ──
        r = await call('DELETE', '/api/v1/me/keys', { headers: await as(1, stale), body: { confirm: 'forget my locker' } });
        assert.strictEqual(r.status, 403, 'forgetting needs the current key or a recent sign-in');
        assert.strictEqual(r.body.code, 'locker.proof_required');

        r = await call('DELETE', '/api/v1/me/keys', { headers: await as(1), body: { confirm: 'forget my locker' } });
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.strictEqual(r.body.forgotten, true);
        assert.strictEqual((await db.prepare('SELECT COUNT(*) AS n FROM locker_keys').get()).n, 0);
        assert.strictEqual((await db.prepare('SELECT COUNT(*) AS n FROM locker_key_backups').get()).n, 0);
        const forgotten = await history();
        assert.strictEqual(forgotten.length, 5);
        assert.deepStrictEqual([forgotten[4].reason, forgotten[4]['from'], forgotten[4]['to']], ['forgotten', afterReset.fingerprint, null]);
        assert.strictEqual((await events()).length, 5, 'the forgetting is announced too');
        assert.ok((await notices()).includes(locker.NOTICES.forgotten), 'and the person is told');
        assert.strictEqual((await call('GET', `/api/v1/people/${ANN}/keys`, { headers: await as(2) })).status, 404, 'the keys are gone');
        r = await call('GET', '/api/v1/me/keys/backup', { headers: await as(1) });
        assert.deepStrictEqual(r.body.backups, {}, 'the backups are gone');

        // ── Forgetting with the proof of the key that is there now ──
        const yet = await published();
        // The proof is signed by the key that is stored now: the one the reset left behind.
        const yetProof = await sign(afterReset.person, await locker.keyChangeProofBytes(ANN, yet.fingerprint, {}));
        r = await call('PUT', '/api/v1/me/keys', { headers: await as(1), body: { ...yet.body, previous_signature: yetProof } });
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        const forgetProof = await sign(yet.person, locker.forgetProofBytes(ANN));
        r = await call('DELETE', '/api/v1/me/keys', { headers: await as(1, stale), body: { confirm: 'forget my locker', previous_signature: forgetProof } });
        assert.strictEqual(r.status, 200, 'the current key can forget the locker, even with an old session');
        assert.strictEqual((await db.prepare('SELECT COUNT(*) AS n FROM locker_keys WHERE subject = ?').get(ANN)).n, 0);

        // The confirmation text is the way in.
        const again = await published();
        const againProof = await sign(yet.person, await locker.keyChangeProofBytes(ANN, again.fingerprint, {}));
        await call('PUT', '/api/v1/me/keys', { headers: await as(1), body: { ...again.body, previous_signature: againProof } });
        r = await call('DELETE', '/api/v1/me/keys', { headers: await as(1), body: { confirm: 'yes' } });
        assert.strictEqual(r.status, 400, 'the confirmation text must match');
        assert.strictEqual(r.body.code, 'locker.confirm_required');
        assert.strictEqual((await db.prepare('SELECT COUNT(*) AS n FROM locker_keys WHERE subject = ?').get(ANN)).n, 1, 'and nothing was forgotten');

        // ── A write from another site is refused ──
        r = await call('PUT', '/api/v1/me/keys', { headers: { ...(await as(1)), 'sec-fetch-site': 'cross-site' }, body: again.body });
        assert.strictEqual(r.status, 403, 'a write another site started is refused');
        r = await call('PUT', '/api/v1/me/keys', { headers: { ...(await as(1)), origin: 'https://evil.example' }, body: again.body });
        assert.strictEqual(r.status, 403, 'and so is one with another origin');
        r = await call('PUT', '/api/v1/me/keys', { headers: { ...(await as(1)), origin: 'https://someone.openvibe.tools', 'sec-fetch-site': 'same-site' }, body: again.body });
        assert.strictEqual(r.status, 403, 'a page people host on a subdomain is not an OpenVibe site');
        assert.strictEqual(r.body.code, 'locker.cross_site');
        r = await call('PUT', '/api/v1/me/keys', { headers: { ...(await as(1)), origin: 'https://openvibe.community', 'sec-fetch-site': 'cross-site' }, body: again.body });
        assert.notStrictEqual(r.body.code, 'locker.cross_site', 'an OpenVibe site (ov-locker.js on Community) may write; here only the proof is missing');
        assert.strictEqual(r.body.code, 'locker.proof_required', 'the proof rule still applies to an OpenVibe site');
        r = await call('DELETE', '/api/v1/me/keys', { headers: { ...(await as(1)), origin: 'https://evil.example' }, body: { confirm: 'forget my locker' } });
        assert.strictEqual(r.status, 403, 'a forget from another site is refused');
        assert.strictEqual(r.body.code, 'locker.cross_site');

        // ── The docs name it: the API docs and llms.txt ──
        const llms = require('../server/home/render').llmsTxt();
        assert.match(llms, /## Locker keys/, 'llms.txt has a Locker keys section');
        assert.ok(llms.includes('/api/v1/people/@maticus/keys'), 'llms.txt has the curl for looking a public key up');
        assert.ok(llms.includes('never read a private key'), 'llms.txt says what Network cannot read');
        const readme = require('fs').readFileSync(require('path').join(__dirname, '..', 'README.md'), 'utf8');
        assert.match(readme, /## Locker keys/, 'the API docs have a Locker keys section');
        for (const route of ['PUT /api/v1/me/keys', 'GET /api/v1/me/keys/backup', 'DELETE /api/v1/me/keys',
            'GET /api/v1/people/:subject/keys', 'GET /api/v1/people/@:username/keys']) {
            assert.ok(readme.includes(route), `the API docs name ${route}`);
        }
        assert.ok(readme.includes('openvibe-locker key-change v1|'), 'the API docs give the bytes to sign');
        assert.ok(readme.includes('openvibe-locker forget v1|'), 'and the bytes to forget');

        // ── Nothing that is a key, a signature or a blob reaches a log line ──
        const written = logs.join('\n');
        assert.ok(written.length >= 0);
        for (const secret of [ann.body.self_signature, bob.body.self_signature, backup.envelope, ann.priv.ecdh.d, ann.priv.signing.d, rotated.body.self_signature]) {
            assert.ok(!written.includes(secret), `a secret reached the log: ${String(secret).slice(0, 12)}…`);
        }
        // Even an unexpected error is redacted before it is written.
        const noisy = locker.safeMessage({ message: `the row (${backup.envelope}) is not a row` });
        assert.ok(!noisy.includes(backup.envelope), 'an error message cannot carry a blob');
        assert.ok(noisy.includes('[redacted]'), 'but it still says something');
    } finally {
        console.log = realLog; console.error = realError; console.warn = realWarn;
        server.close();
    }
    console.log('locker keys: ok');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
})();
