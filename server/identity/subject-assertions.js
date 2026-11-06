'use strict';

/**
 * Subject assertions (ADR-003, amendment 2026-11-06; plan H1).
 *
 * A subject assertion is a short-lived, Network-signed proof that a person authorized the calling
 * service to act for them on ONE other service (the audience). It is what a money call carries
 * beside the name of the person:
 *
 *   Authorization: Bearer <the service's own token>       who is calling
 *   X-OV-Subject: usr_…                                    who the service says it acts for
 *   X-OV-Subject-Assertion: <the assertion>                 that the person allowed it
 *
 * The assertion is minted here, and only here: POST /internal/subject-assertions takes the
 * person's OWN Network access token (the service has it from their session) and signs it into an
 * ES256 JWT that lives 60 seconds. Without the person's token nothing is signed: a service that
 * knows a person's id cannot say the person allowed anything.
 *
 * The key is Network's own EC (P-256) key, published in the JWKS next to the RS256 session key
 * (kid `ov-network-assertion-1`), so Billing and Tips can verify the signature offline.
 *
 * The claims (contract identity.subject-assertion-claims@1):
 *
 *   iss  the Network issuer
 *   sub  the person: usr_…
 *   aud  the service the assertion is for (openvibe.billing)
 *   act  the service it was minted for (svc:live)
 *   jti  unique per assertion, so a replay can be refused
 *   iat, exp  60 seconds
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const { http, serviceAuth } = require('openvibe-contracts');

const KID = 'ov-network-assertion-1';
/** How long an assertion lives. */
const TTL_S = 60;
/** The audiences an assertion may be minted for: the money services (H1). */
const DEFAULT_AUDIENCES = ['openvibe.billing', 'openvibe.tips'];
const AUDIENCE_RE = /^openvibe\.[a-z0-9][a-z0-9.-]*$/;
const SERVICE_RE = /^svc:[a-z][a-z0-9-]{1,39}$/;
const USER_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * The EC key pair, loaded from disk or generated once and kept there.
 * `data/keys/assertion-private.pem` (0600) and `data/keys/assertion-public.pem`. An environment
 * pair wins, so a deployment may keep the key outside the repository.
 */
function loadAssertionKeys({ privateKeyPath, publicKeyPath, log = console } = {}) {
    const priv = privateKeyPath ? path.resolve(privateKeyPath) : null;
    const pub = publicKeyPath ? path.resolve(publicKeyPath) : null;
    let privateKey = null;
    let publicKey = null;
    try {
        if (priv) privateKey = fs.readFileSync(priv, 'utf8');
    } catch { /* not there yet */ }
    try {
        if (pub) publicKey = fs.readFileSync(pub, 'utf8');
    } catch { /* not there yet */ }
    if (privateKey && !publicKey) {
        // The private key is enough: the public half is derived from it.
        try { publicKey = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString(); } catch { /* unreadable key */ }
    }
    if (!privateKey || !publicKey) {
        const pair = crypto.generateKeyPairSync('ec', {
            namedCurve: 'P-256',
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
            publicKeyEncoding: { type: 'spki', format: 'pem' },
        });
        privateKey = pair.privateKey;
        publicKey = pair.publicKey;
        // Keep it: an assertion signed before a restart must still verify after it.
        for (const [file, key] of [[priv, privateKey], [pub, publicKey]]) {
            if (!file) continue;
            try {
                fs.mkdirSync(path.dirname(file), { recursive: true });
                fs.writeFileSync(file, key, { mode: 0o600 });
            } catch (err) {
                (log && log.warn) ? log.warn(`[Assertions] the EC key could not be written to ${file}: ${err.message}; it will change on every restart`) : null;
            }
        }
    }
    return { privateKey, publicKey, kid: KID };
}

/** The JWK of the assertion key, as the JWKS publishes it. */
function assertionJwk(publicKey) {
    const jwk = crypto.createPublicKey(publicKey).export({ format: 'jwk' });
    return { ...jwk, use: 'sig', alg: 'ES256', kid: KID };
}

/**
 * Sign an assertion for a person.
 *
 * `act` is the service that vouched for the person (it held their token), `for` the services that
 * may carry the assertion (the minting service alone by default) and `audience` the service (or the
 * services, when the assertion travels a chain) the assertion is for.
 */
function signAssertion({ privateKey, subject, audience, act, for: forServices, issuer, ttlS = TTL_S, now = () => Date.now() }) {
    const iat = Math.floor(now() / 1000);
    const jti = `as_${crypto.randomBytes(12).toString('hex')}`;
    const token = jwt.sign(
        { sub: subject, act, ...(forServices && forServices.length ? { for: forServices } : {}) },
        privateKey,
        {
            algorithm: 'ES256', keyid: KID, issuer,
            audience: Array.isArray(audience) ? audience : [audience],
            expiresIn: ttlS, jwtid: jti, noTimestamp: false,
        },
    );
    return { assertion: token, jti, issued_at: iat, expires_at: iat + ttlS };
}

/** A small in-process limiter: one service may not mint assertions without bound. */
function createLimiter({ perMinute = 120, now = () => Date.now() } = {}) {
    const hits = new Map();     // key -> { count, at }
    return function allow(key) {
        const t = now();
        const row = hits.get(key);
        if (!row || t - row.at > 60000) { hits.set(key, { count: 1, at: t }); return true; }
        row.count += 1;
        if (hits.size > 1000) { for (const [k, v] of hits) if (t - v.at > 60000) hits.delete(k); }
        return row.count <= perMinute;
    };
}

/**
 * The route: POST /internal/subject-assertions.
 *
 * A first-party service (a service token, never an app or a mod) hands over the person's own
 * access token and the audience it needs an assertion for. Network checks that token is a live
 * session of a person, that the person is the one the caller says it acts for, and signs a
 * 60-second assertion naming the caller as `act`.
 */
function subjectAssertionRouter({ log = console } = {}) {
    const limit = createLimiter();

    /** The caller's own service token: the route takes nothing else. */
    function requireService(req, res, next) {
        const auth = String(req.headers.authorization || '');
        if (!auth.startsWith('Bearer ')) {
            return http.sendProblem(res, 401, 'token.missing', { detail: 'a service token is required', ctx: req.ov });
        }
        const r = serviceAuth.verifyServiceToken(auth.slice(7).trim(), {
            publicKey: req.app.locals.publicKey,
            issuer: (req.app.locals.config || {}).jwt && req.app.locals.config.jwt.issuer,
        });
        if (!r.ok) return http.sendProblem(res, 401, r.code, { detail: r.reason, ctx: req.ov });
        // Only a first-party service may ask for an assertion. A developer app, a mod or an agent
        // never gets one: their own authorization (on_behalf_of) is what they act on.
        if (r.claims.actor_type !== 'service' || !/^svc:[a-z][a-z0-9-]{1,39}$/.test(String(r.claims.sub || ''))) {
            return http.sendProblem(res, 403, 'assertion.not_a_service', { detail: 'only a first-party service may ask for a subject assertion', ctx: req.ov });
        }
        req.principal = { sub: r.claims.sub, cap: r.claims.cap || [], jti: r.claims.jti };
        return next();
    }

    async function handle(req, res) {
        try {
            const config = req.app.locals.config || {};
            const audiences_allowed = (config.subjectAssertions && Array.isArray(config.subjectAssertions.audiences) && config.subjectAssertions.audiences.length)
                ? config.subjectAssertions.audiences : DEFAULT_AUDIENCES;
            const body = req.body || {};
            const userToken = String(body.user_token || '').trim();
            // The audience is one service, or a list when the assertion travels a chain (a tip goes
            // from the site to Tips and on to Billing).
            const audiences = (Array.isArray(body.audience) ? body.audience : [body.audience]).map((a) => String(a || '').trim()).filter(Boolean);
            // The services that may carry it. The minting service is always one of them.
            const forServices = [...new Set([req.principal.sub, ...(Array.isArray(body.for) ? body.for : body.for ? [body.for] : []).map((f) => String(f || '').trim()).filter(Boolean)])];
            if (!userToken) return http.sendProblem(res, 401, 'assertion.no_user_token', { detail: "the person's own access token is required", ctx: req.ov });
            if (!audiences.length || audiences.some((a) => !AUDIENCE_RE.test(a))) {
                return http.sendProblem(res, 422, 'assertion.invalid_audience', { detail: 'the audience must be an openvibe.<service> id', ctx: req.ov });
            }
            if (audiences.some((a) => !audiences_allowed.includes(a))) {
                return http.sendProblem(res, 403, 'assertion.audience_not_allowed', { detail: `no assertion is minted for ${audiences.join(', ')}`, ctx: req.ov });
            }
            if (forServices.some((f) => !SERVICE_RE.test(f))) {
                return http.sendProblem(res, 422, 'assertion.invalid_for', { detail: 'the services that may carry the assertion are svc:<id>', ctx: req.ov });
            }
            if (!limit(req.principal.sub)) {
                return http.sendProblem(res, 429, 'assertion.rate_limited', { detail: 'too many assertions for this service', ctx: req.ov });
            }

            // The person's own token: a live session, not a service or app token.
            const session = await require('../auth/session').verifySession(userToken, { db: req.app.locals.db, publicKey: req.app.locals.publicKey, config });
            if (session.error) {
                return http.sendProblem(res, session.status || 401, 'assertion.invalid_user_token', { detail: session.error, ctx: req.ov });
            }
            const subject = await require('./subjects').ensureUserSubject(req.app.locals.db, session.user);
            if (!subject || !USER_RE.test(String(subject))) {
                return http.sendProblem(res, 403, 'assertion.no_subject', { detail: 'that account has no canonical subject yet', ctx: req.ov });
            }
            // The caller may only assert for the person it says it acts for.
            const asked = body.subject ? String(body.subject).trim() : null;
            if (asked && asked !== subject) {
                return http.sendProblem(res, 403, 'assertion.subject_mismatch', { detail: 'that token names another person', ctx: req.ov });
            }

            const assertionKeys = req.app.locals.assertionKeys || {};
            if (!assertionKeys.privateKey) {
                return http.sendProblem(res, 503, 'assertion.unavailable', { detail: 'the assertion key is not loaded yet', ctx: req.ov });
            }
            const out = signAssertion({
                privateKey: assertionKeys.privateKey,
                subject,
                audience: audiences.length === 1 ? audiences[0] : audiences,
                act: req.principal.sub,
                for: forServices,
                issuer: config.jwt.issuer,
            });
            res.set('Cache-Control', 'no-store');
            return res.json({
                assertion: out.assertion,
                subject,
                audience: audiences.length === 1 ? audiences[0] : audiences,
                act: req.principal.sub,
                for: forServices,
                jti: out.jti,
                expires_at: new Date(out.expires_at * 1000).toISOString(),
                expires_in: TTL_S,
            });
        } catch (err) {
            (log && log.error) ? log.error('[Assertions] mint failed:', err && err.stack ? err.stack : err) : null;
            return http.sendProblem(res, 500, 'internal.error', { detail: 'unexpected error', ctx: req.ov });
        }
    }

    // The two middlewares: the caller's own service token, then the mint.
    return [requireService, handle];
}

module.exports = { KID, TTL_S, DEFAULT_AUDIENCES, loadAssertionKeys, assertionJwk, signAssertion, subjectAssertionRouter, createLimiter };
