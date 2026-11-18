'use strict';
/**
 * Apple's client secret (plan §AB.20, provider 6): not a string the owner copies but an ES256 JWT we mint from the
 * private key (.p8), the key id, the team id and the Services ID. Apple caps its life at six months; ours is 30 days
 * (minted on each use and cached in memory for a day), so a renewing key needs no manual step.
 *
 *   const secret = appleClientSecret({ values })   → the JWT, or null when the key cannot be read
 *
 * `sub` is the Services ID, `iss` the Team ID, the header carries `kid` and `alg: ES256`, `aud` is Apple's issuer.
 * Failure is null, never an exception: a bad .p8 turns sign-in off with a clear answer rather than a crash.
 */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const AUDIENCE = 'https://appleid.apple.com';
const LIFETIME_S = 30 * 24 * 60 * 60;
const CACHE_MS = 24 * 60 * 60 * 1000;
const cache = new Map();   // key fingerprint → { secret, mintedAt }

/** A stable, non-reversible cache key for one set of Apple inputs. */
function cacheKey(values) {
    return crypto.createHash('sha256')
        .update([values.services_id, values.team_id, values.key_id, values.private_key].map((v) => String(v || '')).join('\n'))
        .digest('hex');
}

function appleClientSecret({ values = {}, now = () => Date.now() } = {}) {
    const { services_id: sub, team_id: issuer, key_id: kid, private_key: key } = values;
    if (!sub || !issuer || !kid || !key) return null;
    const id = cacheKey(values);
    const hit = cache.get(id);
    if (hit && now() - hit.mintedAt < CACHE_MS) return hit.secret;
    try {
        const t = Math.floor(now() / 1000);
        const secret = jwt.sign({ iss: issuer, iat: t, exp: t + LIFETIME_S, aud: AUDIENCE, sub }, String(key), { algorithm: 'ES256', header: { alg: 'ES256', kid } });
        cache.set(id, { secret, mintedAt: now() });
        return secret;
    } catch {
        // A .p8 that is not an ES256 key (or has been truncated) means Apple sign-in cannot work: null, not a throw.
        return null;
    }
}

module.exports = { appleClientSecret, AUDIENCE, LIFETIME_S };
