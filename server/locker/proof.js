'use strict';
/**
 * The bytes a person signs to change their locker (design 2026-11-06, LOCKER-DESIGN-2026-11-06.md; Opus's review
 * of Network#577: a stolen session must not be able to swap in somebody else's keys).
 *
 * A person who already has keys proves they still hold them: the **current** signing key signs a message that
 * names the subject, the fingerprint the keys are becoming and a digest of the backups that are being written.
 * Without that signature a change is refused, whatever the session cookie says.
 *
 *   key change   "openvibe-locker key-change v1|<subject>|<new fingerprint>|<sha256 of the canonical backups>"
 *   forget       "openvibe-locker forget v1|<subject>"
 *
 * The bytes are UTF-8 of that text. The fingerprint is the eight words the SDK computes (fingerprintOf). The
 * backups digest is the **lower-case hex SHA-256** of the canonical JSON of the backups that are written:
 *
 *   {"passphrase":{"envelope":"<base64>","format":"locker.envelope.v1"}}
 *
 * The canonical JSON sorts the keys of every object and writes no spaces, so the same backups always give the
 * same bytes in the browser and on the server. The browser (openvibe-shared/ov-locker.js) signs these exact
 * bytes with the person's ECDSA P-256 signing key and sends the signature as `previous_signature`, base64.
 *
 * These helpers are exported so the browser can produce the same bytes; the rules above are the contract, and
 * test/locker-keys.test.js pins them.
 */
/** WebCrypto, or a clear error when the runtime has none. */
function subtle() {
    const crypto = globalThis.crypto;
    if (!crypto || !crypto.subtle) throw new Error('locker: this runtime has no WebCrypto (globalThis.crypto.subtle)');
    return crypto.subtle;
}

/** The canonical JSON of a value: the keys sorted, no spaces, the same bytes everywhere. */
function canonicalJson(value) {
    if (value === undefined || value === null) return 'null';
    if (typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

/** The lower-case hex SHA-256 of some bytes. */
async function sha256Hex(bytes) {
    const digest = await subtle().digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The canonical JSON of the backups that are written: { kind: { envelope, format } }, the kinds sorted. */
function canonicalBackups(backups) {
    const out = {};
    for (const kind of Object.keys(backups || {}).sort()) {
        out[kind] = { envelope: String(backups[kind].envelope), format: String(backups[kind].format) };
    }
    return canonicalJson(out);
}

/** The digest of the backups: the hex SHA-256 of their canonical JSON. → 64 hex characters */
async function backupsDigest(backups) {
    return await sha256Hex(new TextEncoder().encode(canonicalBackups(backups)));
}

/** The message a person signs to change their keys. */
async function keyChangeProofMessage(subject, fingerprint, backups) {
    return `openvibe-locker key-change v1|${subject}|${fingerprint}|${await backupsDigest(backups)}`;
}

/** The bytes a person signs to change their keys. */
async function keyChangeProofBytes(subject, fingerprint, backups) {
    return new TextEncoder().encode(await keyChangeProofMessage(subject, fingerprint, backups));
}

/** The message a person signs to forget their locker. */
function forgetProofMessage(subject) {
    return `openvibe-locker forget v1|${subject}`;
}

/** The bytes a person signs to forget their locker. */
function forgetProofBytes(subject) {
    return new TextEncoder().encode(forgetProofMessage(subject));
}

/** The bytes of a base64 (or base64url) signature, or null when it is not one of 64 bytes. */
function signatureBytes(text) {
    if (typeof text !== 'string' || !text.length) return null;
    const plain = /^[A-Za-z0-9+/]+={0,2}$/.test(text) && text.length % 4 === 0 ? text : null;
    const url = /^[A-Za-z0-9_-]+$/.test(text) ? Buffer.from(text, 'base64url') : null;
    let bytes = null;
    try { bytes = plain ? Buffer.from(plain, 'base64') : url; } catch { return null; }
    if (!bytes || bytes.length !== 64) return null;      // an ECDSA P-256 signature is 64 bytes: r and s
    return new Uint8Array(bytes);
}

/**
 * Does this signature, made by the key in `publicKey`, cover these bytes? WebCrypto only, as everywhere else in
 * the Locker. A key that is not a P-256 key, a signature that is not one, or anything that goes wrong is a false.
 */
async function verifyProof(publicKey, messageBytes, signature) {
    const bytes = signatureBytes(signature);
    if (!bytes || !publicKey || publicKey.kty !== 'EC' || publicKey.crv !== 'P-256') return false;
    try {
        const key = await subtle().importKey(
            'jwk', { kty: publicKey.kty, crv: publicKey.crv, x: publicKey.x, y: publicKey.y },
            { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'],
        );
        return await subtle().verify({ name: 'ECDSA', hash: 'SHA-256' }, key, bytes, messageBytes);
    } catch {
        return false;
    }
}

module.exports = {
    canonicalJson, canonicalBackups, sha256Hex, backupsDigest,
    keyChangeProofMessage, keyChangeProofBytes, forgetProofMessage, forgetProofBytes,
    signatureBytes, verifyProof,
};
