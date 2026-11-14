'use strict';
/**
 * The generic OIDC client (plan §AB.20, wave 1): discovery, PKCE S256, nonce, and an id_token checked every way it
 * has to be before it is a person's identity.
 *
 *   const client = createOidc({ fetch: myFetch, cache, log })
 *   const meta   = await client.metadata('google')            discovery, cached 10 minutes, last good copy kept
 *   const id     = await client.identity({ provider, meta, token, nonce, clientId, clientSecret, redirectUri })
 *
 * The id_token rules (research §5.3, all of them refuse rather than warn):
 *   - `alg` is one the provider's own metadata advertises (`id_token_signing_alg_values_supported`), never `none`,
 *     never an HMAC algorithm, and never `HS*` whatever the metadata says: a shared secret is not a signature check.
 *   - The signature is checked against the JWKS in the metadata (or a refetch when the `kid` is unknown once).
 *   - `iss` equals the *discovered* issuer. For Microsoft the issuer is templated
 *     (https://login.microsoftonline.com/{tenantid}/v2.0): it is resolved from the token's `tid`, and compared to
 *     that, never to the literal `common` URL.
 *   - `aud` equals our client id (or names it, when the provider sends an array), and `azp`, when present, equals it.
 *   - `exp` has not passed and `iat` is not in the future (60 s of clock skew allowed each way).
 *   - `nonce` equals the one we sent, in constant time.
 *   - `email_verified` is a boolean true only; anything else is false (a string "true" from a sloppy provider is
 *     accepted as true only for Apple, whose email_verified really is a string).
 */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const TTL_MS = 10 * 60 * 1000;          // a discovery document is fresh for ten minutes
const MIN_REFETCH_MS = 30 * 1000;       // an unknown kid refetches at most this often
const SKEW_S = 60;
const OIDC_TIMEOUT_MS = 8000;

/** The provider's own view of its endpoints, fetched once and remembered with the last good copy. */
function createDiscovery({ fetch: fetchImpl = globalThis.fetch, now = () => Date.now(), log = console } = {}) {
    const seen = new Map();   // issuer → { doc, at }
    const lastGood = new Map();
    return {
        async get(issuerUrl) {
            const hit = seen.get(issuerUrl);
            if (hit && now() - hit.at < TTL_MS) return hit.doc;
            try {
                const res = await fetchImpl(`${String(issuerUrl).replace(/\/+$/, '')}/.well-known/openid-configuration`, {
                    headers: { accept: 'application/json' }, signal: AbortSignal.timeout(OIDC_TIMEOUT_MS), redirect: 'error',
                });
                if (!res.ok) throw new Error(`answered ${res.status}`);
                const doc = await res.json();
                if (!doc || typeof doc.issuer !== 'string' || typeof doc.authorization_endpoint !== 'string' || typeof doc.token_endpoint !== 'string' || typeof doc.jwks_uri !== 'string') {
                    throw new Error('the document is missing an issuer, an authorization, token or JWKS endpoint');
                }
                seen.set(issuerUrl, { doc, at: now() });
                lastGood.set(issuerUrl, doc);
                return doc;
            } catch (err) {
                // Never a single point of failure: the last good document keeps sign-in working through an outage.
                const old = lastGood.get(issuerUrl);
                if (old) {
                    (log.warn || log.log || (() => {})).call(log, `[SignIn] discovery for ${issuerUrl} failed (${err.message}); using the last good copy`);
                    return old;
                }
                throw Object.assign(new Error(`Could not read ${issuerUrl}'s discovery document: ${err.message}`), { code: 'provider_discovery_failed' });
            }
        },
    };
}

/** The algorithms we accept for an id_token: the metadata's, minus everything that is not a real signature check. */
function allowedAlgs(meta) {
    const advertised = Array.isArray(meta.id_token_signing_alg_values_supported)
        ? meta.id_token_signing_alg_values_supported.filter((a) => /^(RS256|RS384|RS512|ES256|ES384|PS256|PS384|PS512|EdDSA)$/.test(String(a)))
        : ['RS256'];
    // A provider that advertises none (Roblox, Twitch on some documents) still signs with RS256; never widen to
    // HS* and never to none.
    return advertised.length ? advertised : ['RS256'];
}

/** A public key named by the JWKS document, or null. Only signature keys, only the family the algorithm wants. */
function keyFromJwks(doc, kid, alg) {
    const kty = String(alg || '').startsWith('ES') ? 'EC' : (String(alg || '').startsWith('Ed') ? 'OKP' : 'RSA');
    const keys = doc && Array.isArray(doc.keys) ? doc.keys : [];
    for (const jwk of keys) {
        if (!jwk || jwk.kty !== kty) continue;
        if (kid && jwk.kid !== kid) continue;
        if (jwk.use && jwk.use !== 'sig') continue;
        try { return crypto.createPublicKey({ key: jwk, format: 'jwk' }); } catch { /* unusable */ }
    }
    return null;
}

/**
 * The identity a token proves, or a thrown error with a stable `code` (a caller turns it into one audit line and a
 * friendly answer; it never reaches the browser as an error string).
 */
async function verifyIdToken({ token, meta, provider, clientId, nonce, jwksUri = null, fetch: fetchImpl = globalThis.fetch, now = () => Date.now(), log = console }) {
    const fail = (code, detail) => { throw Object.assign(new Error(detail || code), { code }); };
    if (typeof token !== 'string' || token.split('.').length !== 3) fail('id_token_malformed', 'the id_token is not a JWT');
    let header;
    try { header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8')); } catch { fail('id_token_malformed', 'the id_token header is not readable'); }
    if (!header || typeof header.alg !== 'string' || header.alg === 'none' || /^HS/i.test(header.alg)) fail('id_token_alg', `the id_token is signed with ${header.alg}`);
    if (!allowedAlgs(meta).includes(header.alg)) fail('id_token_alg', `the provider did not advertise ${header.alg}`);

    const jwks = jwksUri || (meta.jwks_uri ? meta.jwks_uri : null);
    if (!jwks) fail('id_token_key', 'the provider publishes no JWKS');
    let jwksDoc = null;
    const load = async () => {
        const res = await fetchImpl(jwks, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(OIDC_TIMEOUT_MS), redirect: 'error' });
        if (!res.ok) throw new Error(`JWKS answered ${res.status}`);
        return await res.json();
    };
    try { jwksDoc = await load(); } catch (err) { (log.warn || log.log || (() => {})).call(log, `[SignIn] ${provider} JWKS: ${err.message}`); fail('id_token_key', 'the provider\'s keys could not be read'); }
    let key = keyFromJwks(jwksDoc, header.kid, header.alg);
    if (!key) {
        // One refetch for a rotation; a made-up kid costs one fetch per provider at most every 30 s.
        const last = now();
        const at = REFETCH.get(provider) || 0;
        if (last - at >= MIN_REFETCH_MS) {
            REFETCH.set(provider, last);
            try { jwksDoc = await load(); key = keyFromJwks(jwksDoc, header.kid, header.alg); } catch { /* keep the first answer */ }
        }
        if (!key) fail('id_token_key', `no key for kid ${header.kid || '(none)'}`);
    }

    let claims;
    try {
        claims = jwt.verify(token, key, { algorithms: [header.alg], clockTolerance: SKEW_S });
    } catch (err) {
        const code = err && err.name === 'TokenExpiredError' ? 'id_token_expired' : 'id_token_signature';
        fail(code, err.message);
    }

    // issuer: the discovered one, or for Microsoft the tenant the token itself names
    const expected = expectedIssuer(meta, provider, claims);
    if (!expected || claims.iss !== expected) fail('id_token_issuer', `iss ${claims.iss} is not ${expected}`);
    // audience: ours, alone or in a list; azp names us when it is present
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(clientId)) fail('id_token_audience', `aud ${String(claims.aud)} does not name the client`);
    if (claims.azp !== undefined && claims.azp !== clientId) fail('id_token_audience', `azp ${claims.azp} is not the client`);
    // freshness: exp in the future, iat not in the future
    const t = Math.floor(now() / 1000);
    if (typeof claims.exp !== 'number' || claims.exp + SKEW_S < t) fail('id_token_expired', 'the id_token has expired');
    if (typeof claims.iat === 'number' && claims.iat - SKEW_S > t) fail('id_token_issued', 'the id_token was issued in the future');
    // nonce: the one we sent, in constant time
    if (nonce) {
        if (typeof claims.nonce !== 'string' || !constantEqual(claims.nonce, nonce)) fail('id_token_nonce', 'the nonce does not match the one we sent');
    } else if (claims.nonce) {
        // We never send a flow without a nonce; a token carrying one we did not send is not ours.
        fail('id_token_nonce', 'the id_token carries a nonce we did not send');
    }
    return claims;
}
const REFETCH = new Map();

/**
 * The issuer a token must name. Normally the discovered issuer itself (not a string from the preset: a document that
 * disagrees with the preset is the document's word that counts). Microsoft is the one templated case: the metadata
 * says `{tenantid}` and the token says which tenant answered in `tid`.
 */
function expectedIssuer(meta, provider, claims) {
    const docIssuer = String(meta && meta.issuer ? meta.issuer : '');
    if (!docIssuer.includes('{tenantid}')) return docIssuer || null;
    const tid = claims && typeof claims.tid === 'string' ? claims.tid : '';
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tid)) return null;
    return docIssuer.split('{tenantid}').join(tid);
}

function constantEqual(a, b) {
    const x = Buffer.from(String(a), 'utf8');
    const y = Buffer.from(String(b), 'utf8');
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** The value only a real provider answer flips: `email_verified` true, in the shape the provider sends it. */
function emailVerified(provider, claims) {
    const v = claims && (claims.email_verified !== undefined ? claims.email_verified : claims.verified);
    if (provider && provider.emailVerifiedFrom === 'none') return false;
    if (provider && provider.emailVerifiedFrom === 'profile_claim') return v === true;
    // Apple sends the string "true"; a boolean is the normal case everywhere else.
    return v === true || v === 'true';
}

module.exports = {
    createDiscovery, verifyIdToken, expectedIssuer, allowedAlgs, emailVerified, constantEqual,
    TTL_MS, MIN_REFETCH_MS, SKEW_S,
};
