'use strict';
/**
 * Identifiers for the Connect tables: a prefix and a ULID (Crockford base32, uppercase, 26 characters),
 * the shape the rest of the house uses for its rows.
 */
const crypto = require('crypto');

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A ULID: 10 characters of time, then 16 of randomness. */
function ulid(now = Date.now()) {
    let t = now;
    let time = '';
    for (let i = 0; i < 10; i++) { time = ALPHABET[t % 32] + time; t = Math.floor(t / 32); }
    const rand = crypto.randomBytes(16);
    let tail = '';
    for (let i = 0; i < 16; i++) tail += ALPHABET[rand[i] % 32];
    return time + tail;
}

/** A new id: 'cvd_01J…', 'cal_01J…', 'cap_01J…', 'clg_01J…'. */
function newId(prefix) {
    return prefix + '_' + ulid();
}

module.exports = { newId, ulid };
