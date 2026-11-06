'use strict';
/**
 * The Locker key directory (design 2026-11-06, LOCKER-DESIGN-2026-11-06.md, section 4 "Network: the key
 * directory"; the format and the library are openvibe-sdk/locker and openvibe-sdk/locker/server).
 *
 * A person's locker is two P-256 key pairs (an ECDH one that receives content keys, an ECDSA one that signs the
 * fingerprint) plus a copy of the private halves wrapped by a key from their locker passphrase. Network holds the
 * public halves, the self-signature and the wrapped copies as opaque bytes: it can read the public keys and the
 * fingerprint, and it can never read a private key.
 *
 *   PUT    /api/v1/me/keys                  my public keys, my self-signature and my wrapped backups
 *   GET    /api/v1/me/keys/backup           my own wrapped private keys, for a new device (never anybody else's)
 *   DELETE /api/v1/me/keys                  forget my locker (keys and backups), with the confirmation text
 *   GET    /api/v1/people/:subject/keys     a person's public keys and fingerprint, by subject
 *   GET    /api/v1/people/@:username/keys   the same, by exact name
 *
 * What Network checks, and what it refuses:
 *   - the two public keys must be P-256 keys, and the self-signature must verify with the signing key
 *     (openvibe-sdk/locker verifyPersonKeys): a set nobody signed is not a person's set.
 *   - the fingerprint is computed here (fingerprintOf), never taken from the caller: a client that says another
 *     fingerprint than the keys produce is refused.
 *   - every backup must be a Locker envelope with a password lock, at most 16 KB, sealed with a PBKDF2 count
 *     between 600 000 and 10 000 000 (openvibe-sdk/locker/server inspectEnvelope). It is stored as it came.
 *   - a person who ALREADY has keys proves they still hold them: the current signing key signs the change
 *     (server/locker/proof.js), and without that signature nothing is changed (403 locker.proof_required).
 *     A stolen session cookie alone cannot swap in somebody else's keys.
 *   - a real reset (the passphrase and the recovery kit are both lost) is a `reset: true` with a sign-in from
 *     the last ten minutes (the session's auth_time), and it is written down as a reset.
 *   - every change (created, rotated, restored, reset, forgotten) sends the person a notification, so a swap
 *     nobody asked for is seen.
 *
 * Nothing here is ever logged: a key, a signature or a blob never reaches a log line, an error message or a
 * response other than the one the person asked for. Every answer is private and never stored by a cache.
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const cache = require('openvibe-shared/cache-policy');
const { http, ids, validate } = require('openvibe-contracts');
const { fingerprintOf, verifyPersonKeys } = require('openvibe-sdk/locker');
const { inspectEnvelope } = require('openvibe-sdk/locker/server');
const eventRelay = require('../developer/event-relay');
const proof = require('./proof');
// A real sign-in (the session's auth_time within ten minutes), the rule account-merge and the account deletion
// already use: never a renewal, never a QR session carrying an old source time.
const { isFreshSignIn } = require('../identity/account-merge');

/** The event a key change announces (ids and fingerprints only; never a key, never a blob). */
const EVENT_TYPE = 'locker.keys.changed';
/** The only shape a backup may have: a Locker envelope, base64. */
const BACKUP_FORMAT = 'locker.envelope.v1';
/** The kinds of backup a person may keep: one row per kind. */
const BACKUP_KINDS = ['passphrase', 'recovery', 'passkey'];
/** A backup may not be bigger than this (the wrapped private keys are small; 16 KB is generous). */
const MAX_BACKUP_BYTES = 16 * 1024;
/** The PBKDF2 count we accept for a password lock: the floor and the ceiling the SDK uses. */
const PASSWORD_ITERATIONS_MIN = 600000;
const PASSWORD_ITERATIONS_MAX = 10000000;
/** The text a person must type to forget their locker. */
const CONFIRM_TEXT = 'forget my locker';
/** A subject id (usr_<ULID>). */
const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
/** A name (letters, digits, dot, dash, underscore): exact names only, never a pattern. */
const NAME_RE = /^[A-Za-z0-9_.-]{1,40}$/;
/** The eight words of a fingerprint, in two groups of four. */
// openvibe-sdk/locker's fingerprintOf: eight words in two groups of four, joined by " · " (SDK 0.86.0).
const FINGERPRINT_RE = /^[a-z]+ [a-z]+ [a-z]+ [a-z]+ · [a-z]+ [a-z]+ [a-z]+ [a-z]+$/;
/** A base64 ECDSA P-256 signature: 64 bytes, 86 characters and the padding. */
const SIGNATURE_RE = /^[A-Za-z0-9+/]{86}==$/;
/** How many lookups one caller may do a minute. */
const LOOKUP_LIMIT = 60;
const LOOKUP_WINDOW_MS = 60_000;
/** The reasons a locker's history holds. */
const REASONS = ['created', 'rotated', 'restored', 'reset', 'forgotten'];
/** What each change tells the person. The reset's words are fixed: they say what is lost. */
const NOTICES = {
    created: 'Your locker was set up: the things you lock are opened with these keys.',
    rotated: 'Your locker keys changed: things locked for your old keys cannot be opened with the new ones.',
    restored: 'Your locker backup was restored: the things you lock are opened with the same keys.',
    reset: 'Your locker was reset: things locked for your old keys cannot be opened',
    forgotten: 'Your locker was forgotten: your keys and your backups are gone.',
};

class LockerError extends Error {
    constructor(status, code, detail) { super(detail); this.status = status; this.code = code; }
}

/** A P-256 public key as a JWK: the four members a browser's WebCrypto writes. */
function publicKeyOk(key) {
    return !!key && typeof key === 'object' && !Array.isArray(key)
        && key.kty === 'EC' && key.crv === 'P-256'
        && typeof key.x === 'string' && /^[A-Za-z0-9_-]{43}$/.test(key.x)
        && typeof key.y === 'string' && /^[A-Za-z0-9_-]{43}$/.test(key.y);
}

/** The bytes of a base64 string, or null when the text is not base64 at all. */
function fromBase64(text) {
    if (typeof text !== 'string' || !text.length || text.length % 4 !== 0) return null;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return null;
    let bytes;
    try { bytes = Buffer.from(text, 'base64'); } catch { return null; }
    // Round-trip: base64 that does not come back the same was not base64.
    if (bytes.toString('base64') !== text) return null;
    return bytes;
}

/**
 * One backup: a Locker envelope with a password lock, checked with the SDK's server rules and stored as it came.
 * Never opens it, never logs it: the bytes are only read to look at the header.
 */
function checkBackup(blob) {
    if (!blob || typeof blob !== 'object' || Array.isArray(blob)) {
        throw new LockerError(400, 'locker.bad_backup', 'a backup is { format, envelope }');
    }
    if (blob.format !== BACKUP_FORMAT) {
        throw new LockerError(400, 'locker.bad_backup', 'the backup is not a Locker envelope');
    }
    const bytes = fromBase64(blob.envelope);
    if (!bytes) throw new LockerError(400, 'locker.bad_backup', 'the backup envelope is not base64');
    if (bytes.length > MAX_BACKUP_BYTES) {
        throw new LockerError(413, 'locker.backup_too_large', 'the backup is bigger than 16 KB');
    }
    const info = inspectEnvelope(bytes);
    // The lock and the derivation count say what the blob is, so they are read before the whole shape is judged.
    const header = info.header || {};
    if (header.lock && header.lock !== 'password') {
        throw new LockerError(400, 'locker.backup_not_password', 'the backup must be sealed with a password');
    }
    const iterations = header.slots && header.slots.password ? header.slots.password.iterations : null;
    if (iterations != null && (!Number.isInteger(iterations)
        || iterations < PASSWORD_ITERATIONS_MIN || iterations > PASSWORD_ITERATIONS_MAX)) {
        throw new LockerError(400, 'locker.bad_iterations', 'the backup uses a password derivation we do not accept');
    }
    if (!info.valid) throw new LockerError(400, 'locker.bad_backup', 'the backup is not a Locker envelope we accept');
    return { format: BACKUP_FORMAT, envelope: blob.envelope };
}

/** The signed-in person as a subject, or a LockerError (a guest has no locker). */
async function meOf(db, user) {
    if (!user || user.is_anon) throw new LockerError(403, 'locker.guest', 'sign in with an account to use a locker');
    const subject = await require('../identity/subjects').ensureUserSubject(db, user);
    if (!SUBJECT_RE.test(String(subject || ''))) {
        throw new LockerError(403, 'locker.guest', 'sign in with an account to use a locker');
    }
    return subject;
}

/** The person's key row, or undefined. */
async function keyRow(db, subject) {
    return await db.prepare(`SELECT subject, ecdh_public, signing_public, fingerprint, self_signature, created_at, updated_at
        FROM locker_keys WHERE subject = ?`).get(String(subject));
}

/** When the person's keys last changed (the newest history row), or null. */
async function changedAtOf(db, subject) {
    const row = await db.prepare('SELECT changed_at FROM locker_key_history WHERE subject = ? ORDER BY id DESC LIMIT 1').get(String(subject));
    return row ? row.changed_at : null;
}

/** What anybody may read about a person's locker: the public keys, the fingerprint and when they changed. */
function view(row, changedAt) {
    return {
        subject: row.subject,
        ecdh_public: row.ecdh_public,
        signing_public: row.signing_public,
        fingerprint: row.fingerprint,
        updated_at: row.updated_at,
        changed_at: changedAt || null,
    };
}

/** The envelope for one key change. Ids and fingerprints only: no key, no signature, no blob. */
function buildEnvelope({ subject, fingerprint, previous, reason, at }) {
    const ms = Date.parse(at) || Date.now();
    const env = {
        event_id: ids.newId('event', ms), event_type: EVENT_TYPE, version: 1, source: 'network',
        actor: { type: 'user', id: subject }, timestamp: new Date(ms).toISOString(), visibility: 'subject',
        subject: { type: 'user', id: subject },
        payload: {
            subject: { type: 'user', id: subject },
            fingerprint: fingerprint || null,
            previous_fingerprint: previous || null,
            reason,
            changed_at: new Date(ms).toISOString(),
        },
    };
    const v = validate('events.event-envelope@1', env);
    if (!v.valid) throw new LockerError(500, 'locker.event_failed', 'the key change could not be announced');
    return env;
}

/**
 * The notification a key change sends the person, so a swap nobody asked for is seen: the bell, the email and the
 * push all carry the same words. Nothing about the keys themselves: the notice says that they changed, not what
 * they are.
 */
async function notifyKeyChange(notifications, user, reason) {
    if (!notifications || !user) return null;
    const message = NOTICES[reason] || NOTICES.rotated;
    try {
        return await notifications.create({
            user_id: user.id, type: 'GENERIC', category: 'system', priority: 'high', icon: '🔒',
            title: 'Your locker changed', message, service: 'network',
            url: 'https://openvibe.network/my',
        });
    } catch (err) {
        // The change is already written; a notice that could not be sent must not undo it.
        console.error('[Locker]', 'the notice could not be sent:', safeMessage(err));
        return null;
    }
}

/**
 * A write another site started (CSRF), judged from what the browser says: Sec-Fetch-Site other than same-origin
 * (or none: typed by the person), or an Origin on another host. A client that sends neither (an agent with a
 * bearer token) is not a browser and is let through.
 */
function crossSite(req, isFirstPartyOrigin = null) {
    // An OpenVibe site (the exact first-party origins Network's CORS lists, never a wildcard such as *.openvibe.tools,
    // where people host their own pages): ov-locker.js sets a locker up from the site the person is on.
    const from = req.get('origin');
    if (from && from !== 'null' && typeof isFirstPartyOrigin === 'function' && isFirstPartyOrigin(from)) return false;
    const site = req.get('sec-fetch-site');
    if (site && site !== 'same-origin' && site !== 'none') return true;
    const origin = req.get('origin');
    if (!origin || origin === 'null') return false;
    const host = String(req.get('host') || '').toLowerCase();
    try {
        const o = new URL(origin);
        const same = o.host.toLowerCase() === host;
        const forwarded = req.get('x-forwarded-host');
        return !(same || (forwarded && o.host.toLowerCase() === String(forwarded).split(',')[0].trim().toLowerCase()));
    } catch { return true; }
}

/** Every answer here is private and never kept by a cache. */
function privateAnswer(res) {
    res.set('Cache-Control', cache.htmlHeaders({ private: true }));
    res.set('Vary', 'Authorization, Cookie');
}

/**
 * An error message that cannot carry a key, a signature or a blob: a private key, a signature and an envelope
 * are all long runs of base64, and those are redacted before the message is written anywhere.
 */
function safeMessage(err) {
    const text = String((err && err.message) || err || '');
    return text.replace(/[A-Za-z0-9+/=_-]{40,}/g, '[redacted]').slice(0, 200);
}

/** The one error path: a problem answer, and a log line that says nothing about a key. */
function send(req, res, fn) {
    return (async () => {
        try {
            return await fn(req.app.locals.db);
        } catch (err) {
            if (err instanceof LockerError) {
                return http.sendProblem(res, err.status, err.code, { detail: err.message, ctx: req.ov });
            }
            // A log line that cannot carry a key, a signature or a blob: anything long and base64-ish (a
            // private key, a signature, an envelope) is redacted before it is written.
            console.error('[Locker]', 'unexpected error:', safeMessage(err));
            return http.sendProblem(res, 500, 'locker.failed', { detail: 'the locker could not be read or changed', ctx: req.ov });
        }
    })();
}

/**
 * The person's own locker: PUT /api/v1/me/keys, GET /api/v1/me/keys/backup, DELETE /api/v1/me/keys.
 */
function meRouter(requireAuth, { notifications = null, isFirstPartyOrigin = null } = {}) {
    const router = express.Router();
    router.use(http.middleware());

    // Set or rotate my keys. The same keys again change nothing and announce nothing.
    router.put('/', requireAuth, async (req, res) => await send(req, res, async (db) => {
        if (crossSite(req, isFirstPartyOrigin)) throw new LockerError(403, 'locker.cross_site', 'this write came from another site');
        const me = await meOf(db, req.user);
        const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
        const ecdh = body.ecdh_public;
        const signing = body.signing_public;
        const signature = body.self_signature;
        if (!publicKeyOk(ecdh) || !publicKeyOk(signing)) {
            throw new LockerError(400, 'locker.bad_keys', 'the public keys are not P-256 keys');
        }
        if (typeof signature !== 'string' || !SIGNATURE_RE.test(signature)) {
            throw new LockerError(400, 'locker.bad_signature', 'the self-signature is not a signature');
        }
        // The fingerprint is computed here. A caller that sends one that does not match its own keys is refused.
        const fingerprint = await fingerprintOf(ecdh, signing);
        if (!FINGERPRINT_RE.test(fingerprint)) throw new LockerError(500, 'locker.failed', 'the fingerprint could not be computed');
        if (body.fingerprint != null && body.fingerprint !== fingerprint) {
            throw new LockerError(400, 'locker.fingerprint_mismatch', 'the fingerprint does not match the keys');
        }
        // The signature must verify with the signing key: a set nobody signed is not a person's set.
        const signed = await verifyPersonKeys({ ecdh, signing, fingerprint_signature: signature, fingerprint });
        if (!signed) throw new LockerError(400, 'locker.bad_signature', 'the self-signature does not verify with the signing key');

        const given = body.backups && typeof body.backups === 'object' && !Array.isArray(body.backups) ? body.backups : {};
        const kinds = Object.keys(given);
        for (const kind of kinds) {
            if (!BACKUP_KINDS.includes(kind)) throw new LockerError(400, 'locker.unknown_backup', 'a backup is passphrase, recovery or passkey');
        }
        const backups = {};
        for (const kind of kinds) backups[kind] = checkBackup(given[kind]);

        const prev = await keyRow(db, me);
        const reset = body.reset === true;
        // The proof: the CURRENT signing key signs the change (server/locker/proof.js). Without it, a stolen
        // session could swap in somebody else's keys and read everything locked for this person from then on.
        let proved = false;
        if (prev && typeof body.previous_signature === 'string' && body.previous_signature.length) {
            const bytes = await proof.keyChangeProofBytes(me, fingerprint, backups);
            proved = await proof.verifyProof(prev.signing_public, bytes, body.previous_signature);
        }
        if (prev && !proved) {
            if (!reset) {
                throw new LockerError(403, 'locker.proof_required', 'the change needs a signature from the key you have now');
            }
            // A real reset: the passphrase and the recovery kit are gone. A sign-in from the last ten minutes
            // (the session's auth_time) is the only thing that can open this door.
            if (!isFreshSignIn(req.tokenClaims)) {
                throw new LockerError(403, 'locker.reauth_required', 'sign in again (within the last 10 minutes) to reset your locker');
            }
        }

        const now = new Date().toISOString();
        const out = await db.tx(async () => {
            const before = await keyRow(db, me);
            // The proof was checked against the keys read before this transaction. If another device changed them
            // in between, that proof is about keys that are gone: refuse, and let the person reload.
            if ((prev ? prev.fingerprint : null) !== (before ? before.fingerprint : null)) {
                throw new LockerError(409, 'locker.conflict', 'your locker changed on another device: reload and try again');
            }
            const held = await db.prepare('SELECT kind, blob FROM locker_key_backups WHERE subject = ?').all(me);
            const beforeBackups = {};
            for (const row of held) beforeBackups[row.kind] = row.blob;
            const backupsChanged = Object.keys(backups).some((kind) => JSON.stringify(beforeBackups[kind] || null) !== JSON.stringify(backups[kind]));
            const changed = !before || before.fingerprint !== fingerprint || reset || backupsChanged;
            // Why it changed: the first keys, a reset, new keys, or the same keys with new backups.
            const reason = !before ? 'created' : (reset ? 'reset' : (before.fingerprint !== fingerprint ? 'rotated' : 'restored'));
            if (before) {
                await db.prepare(`UPDATE locker_keys SET ecdh_public = ?::jsonb, signing_public = ?::jsonb,
                    fingerprint = ?, self_signature = ?, updated_at = ? WHERE subject = ?`)
                    .run(JSON.stringify(ecdh), JSON.stringify(signing), fingerprint, signature, now, me);
            } else {
                await db.prepare(`INSERT INTO locker_keys (subject, ecdh_public, signing_public, fingerprint, self_signature, created_at, updated_at)
                    VALUES (?, ?::jsonb, ?::jsonb, ?, ?, ?, ?)`)
                    .run(me, JSON.stringify(ecdh), JSON.stringify(signing), fingerprint, signature, now, now);
            }
            // A reset replaces the whole locker: the old backups wrap keys that are gone.
            if (reset) await db.prepare('DELETE FROM locker_key_backups WHERE subject = ?').run(me);
            for (const kind of Object.keys(backups)) {
                const blob = JSON.stringify(backups[kind]);
                const has = await db.prepare('SELECT created_at FROM locker_key_backups WHERE subject = ? AND kind = ?').get(me, kind);
                if (has) {
                    await db.prepare('UPDATE locker_key_backups SET blob = ?::jsonb, updated_at = ? WHERE subject = ? AND kind = ?')
                        .run(blob, now, me, kind);
                } else {
                    await db.prepare('INSERT INTO locker_key_backups (subject, kind, blob, created_at, updated_at) VALUES (?, ?, ?::jsonb, ?, ?)')
                        .run(me, kind, blob, now, now);
                }
            }
            if (changed) {
                await db.prepare(`INSERT INTO locker_key_history (subject, fingerprint, "from", "to", reason, changed_at)
                    VALUES (?, ?, ?, ?, ?, ?)`).run(me, fingerprint, before ? before.fingerprint : null, fingerprint, reason, now);
                await eventRelay.writerFor(db).enqueue(buildEnvelope({
                    subject: me, fingerprint, previous: before ? before.fingerprint : null, reason, at: now,
                }));
            }
            return { changed, reason };
        });
        if (out.changed) await notifyKeyChange(notifications, req.user, out.reason);
        const row = await keyRow(db, me);
        const changedAt = await changedAtOf(db, me);
        privateAnswer(res);
        res.json({ ...view(row, changedAt), changed: out.changed, reason: out.reason });
    }));

    // My own wrapped private keys, for a new device. Nobody else's: this route only ever answers about the caller.
    router.get('/backup', requireAuth, async (req, res) => await send(req, res, async (db) => {
        const me = await meOf(db, req.user);
        const rows = await db.prepare('SELECT kind, blob FROM locker_key_backups WHERE subject = ? ORDER BY kind').all(me);
        const backups = {};
        for (const row of rows) backups[row.kind] = row.blob;
        privateAnswer(res);
        res.json({ subject: me, backups });
    }));

    // Forget my locker: the keys and the backups go, the history stays. The current signing key says so, or the
    // person signed in again in the last ten minutes.
    router.delete('/', requireAuth, async (req, res) => await send(req, res, async (db) => {
        if (crossSite(req, isFirstPartyOrigin)) throw new LockerError(403, 'locker.cross_site', 'this write came from another site');
        const me = await meOf(db, req.user);
        const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
        if (body.confirm !== CONFIRM_TEXT) {
            throw new LockerError(400, 'locker.confirm_required', 'the confirmation text does not match');
        }
        const prev = await keyRow(db, me);
        if (!prev) throw new LockerError(404, 'locker.no_keys', 'there are no keys to forget');
        let proved = false;
        if (typeof body.previous_signature === 'string' && body.previous_signature.length) {
            proved = await proof.verifyProof(prev.signing_public, proof.forgetProofBytes(me), body.previous_signature);
        }
        if (!proved && !isFreshSignIn(req.tokenClaims)) {
            throw new LockerError(403, 'locker.proof_required', 'the change needs a signature from the key you have now, or a sign-in from the last 10 minutes');
        }
        const now = new Date().toISOString();
        await db.tx(async () => {
            await db.prepare('DELETE FROM locker_key_backups WHERE subject = ?').run(me);
            await db.prepare('DELETE FROM locker_keys WHERE subject = ?').run(me);
            await db.prepare(`INSERT INTO locker_key_history (subject, fingerprint, "from", "to", reason, changed_at)
                VALUES (?, ?, ?, NULL, 'forgotten', ?)`).run(me, prev.fingerprint, prev.fingerprint, now);
            await eventRelay.writerFor(db).enqueue(buildEnvelope({
                subject: me, fingerprint: null, previous: prev.fingerprint, reason: 'forgotten', at: now,
            }));
        });
        await notifyKeyChange(notifications, req.user, 'forgotten');
        privateAnswer(res);
        res.json({ subject: me, forgotten: true });
    }));

    return router;
}

/**
 * The public key directory: anybody signed in may look up one person's public keys and fingerprint, by subject or
 * by exact name. Nobody may read anybody's backup here: there is no such route.
 */
function peopleRouter(requireAuth) {
    const router = express.Router();
    router.use(http.middleware());
    const limit = rateLimit({
        windowMs: LOOKUP_WINDOW_MS,
        max: LOOKUP_LIMIT,
        keyGenerator: (req) => `locker-${req.user && req.user.id ? req.user.id : 'none'}`,
        message: { error: 'too_many_requests', error_description: 'sixty locker key lookups a minute' },
    });

    /** The person's public keys, or a LockerError (no such person, or no keys). */
    const readKeys = async (db, subject) => {
        const row = await keyRow(db, subject);
        if (!row) throw new LockerError(404, 'locker.no_keys', 'that person has no locker keys');
        return view(row, await changedAtOf(db, subject));
    };

    // By exact name: the name a person is known by, nothing else.
    router.get('/@:username/keys', requireAuth, limit, async (req, res) => await send(req, res, async (db) => {
        const name = String(req.params.username || '').trim();
        if (!NAME_RE.test(name)) throw new LockerError(404, 'locker.unknown_person', 'no such person');
        const person = await require('../identity/subjects').resolveUsername(db, name);
        if (!person) throw new LockerError(404, 'locker.unknown_person', 'no such person');
        const out = await readKeys(db, person.subject.id);
        privateAnswer(res);
        res.json(out);
    }));

    // By subject.
    router.get('/:target/keys', requireAuth, limit, async (req, res) => await send(req, res, async (db) => {
        const target = String(req.params.target || '').trim();
        if (!SUBJECT_RE.test(target)) throw new LockerError(404, 'locker.unknown_person', 'no such person');
        const out = await readKeys(db, target);
        privateAnswer(res);
        res.json(out);
    }));

    return router;
}

module.exports = {
    EVENT_TYPE, BACKUP_FORMAT, BACKUP_KINDS, MAX_BACKUP_BYTES, CONFIRM_TEXT, LOOKUP_LIMIT, REASONS, NOTICES,
    LockerError, publicKeyOk, checkBackup, view, buildEnvelope, crossSite, safeMessage, notifyKeyChange,
    meRouter, peopleRouter,
    // The bytes a person signs, so the browser (openvibe-shared/ov-locker.js) signs the same ones.
    canonicalJson: proof.canonicalJson,
    canonicalBackups: proof.canonicalBackups,
    backupsDigest: proof.backupsDigest,
    keyChangeProofMessage: proof.keyChangeProofMessage,
    keyChangeProofBytes: proof.keyChangeProofBytes,
    forgetProofMessage: proof.forgetProofMessage,
    forgetProofBytes: proof.forgetProofBytes,
    verifyProof: proof.verifyProof,
};
