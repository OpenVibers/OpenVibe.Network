'use strict';
/**
 * App tokens (roadmap Wave 20 foundation, ADR-014). Developer apps use /oauth/token like service
 * principals do, but they are recognised by their client id (app_<ULID>) and never touch
 * oauth_clients or principal_grants.
 *
 *   confidential app   grant_type=client_credentials  client_id, client_secret, audience[, scope]
 *   any app            grant_type=authorization_code  client_id, code, redirect_uri, code_verifier,
 *                      audience[, scope]  (+ client_secret for a confidential app)
 *
 * Tokens are RS256, 5 minutes, shaped by identity.service-token-claims@1:
 *   sub app:app_<ULID>, actor_type app, aud [audience], cap (approved grants ∩ allowance ∩ still
 *   grantable, for that audience), ns [project_id], project_id, env sandbox|production,
 *   on_behalf_of usr_<ULID> (authorization code only).
 * A sandbox app gets a token only for an audience that opted in to sandbox tokens
 * (DEV_SANDBOX_AUDIENCES); receivers also refuse env=sandbox unless they opted in.
 * No refresh tokens: a revoked credential or app stops new tokens at once, and issued tokens end
 * within their 5-minute lifetime.
 */
const crypto = require('crypto');
const { serviceAuth, assertValid } = require('openvibe-contracts');
const policy = require('./policy');
const store = require('./store');

const TOKEN_TTL_S = 300;
const CODE_TTL_MS = 5 * 60 * 1000;
const PKCE_RE = /^[A-Za-z0-9_-]{43,128}$/;

const isAppClient = (clientId) => store.APP_ID_RE.test(String(clientId || ''));
const oauthError = (status, error, description) => ({ status, body: { error, error_description: description } });

/** The app plus its project, if both are usable for issuing tokens now. */
function usableApp(db, clientId) {
    const app = isAppClient(clientId) ? db.prepare('SELECT * FROM dev_apps WHERE oauth_client_id = ?').get(String(clientId)) : null;
    if (!app || app.revoked_at) return { error: oauthError(401, 'invalid_client', 'unknown or revoked app') };
    const project = db.prepare('SELECT * FROM dev_projects WHERE id = ?').get(app.project_id);
    if (!project || project.archived_at) return { error: oauthError(401, 'invalid_client', 'project archived') };
    if (!policy.ENVIRONMENT_POLICIES[project.environment_policy].includes(app.environment)) {
        return { error: oauthError(400, 'unauthorized_client', `${app.environment} apps are not enabled for this project`) };
    }
    return { app, project };
}

/** Capabilities the app holds for an audience right now. */
function effectiveGrants(db, app, project, audience) {
    const allowance = new Set(JSON.parse(project.allowance || '[]'));
    return db.prepare("SELECT capability FROM dev_grants WHERE app_id = ? AND audience = ? AND status = 'approved' ORDER BY capability")
        .all(app.id, audience).map(r => r.capability)
        .filter(c => allowance.has(c) && policy.isGrantable(c) && policy.audienceOf(c) === audience);
}

function mint({ app, project, audience, scope, limit, onBehalfOf, privateKey, issuer, settings, db }) {
    const aud = String(audience || '').trim();
    if (!aud || !/^[a-z0-9.-]+$/.test(aud)) return oauthError(400, 'invalid_request', 'audience is required');
    if (app.environment === 'sandbox' && !settings.sandboxAudiences.has(aud)) {
        return oauthError(400, 'invalid_target', `${aud} does not accept sandbox tokens`);
    }
    const held = effectiveGrants(db, app, project, aud).filter(c => !limit || limit.includes(c));
    const wanted = scope ? String(scope).split(/\s+/).filter(Boolean) : null;
    const missing = wanted ? wanted.filter(w => !held.includes(w)) : [];
    if (missing.length) return oauthError(400, 'invalid_scope', `not granted: ${missing.join(' ')}`);
    const cap = wanted || held;
    if (!cap.length) return oauthError(400, 'invalid_scope', `no grants for audience ${aud}`);
    const now = Math.floor(Date.now() / 1000);
    const claims = {
        iss: issuer, sub: `app:${app.id}`, actor_type: 'app', aud: [aud], cap, ns: [project.id],
        project_id: project.id, env: app.environment,
        ...(onBehalfOf ? { on_behalf_of: onBehalfOf } : {}),
        iat: now, exp: now + TOKEN_TTL_S, jti: `tok_${crypto.randomBytes(12).toString('hex')}`,
    };
    assertValid('identity.service-token-claims@1', claims);
    return { status: 200, body: { access_token: serviceAuth.signServiceToken(claims, privateKey), token_type: 'Bearer', expires_in: TOKEN_TTL_S, scope: cap.join(' ') } };
}

/** Authenticate the client of a token request. Public apps present no secret. */
function authenticate(db, app, clientSecret) {
    if (app.client_type === 'public') {
        if (clientSecret) return oauthError(401, 'invalid_client', 'public apps have no client secret');
        return null;
    }
    if (!store.matchSecret(db, app.id, clientSecret)) return oauthError(401, 'invalid_client', 'Invalid client credentials');
    return null;
}

/** /oauth/token for an app client id. Returns { status, body }. */
function handleTokenRequest(db, body, { privateKey, issuer, config }) {
    const settings = policy.settings(config);
    const found = usableApp(db, body.client_id);
    if (found.error) return found.error;
    const { app, project } = found;
    if (body.grant_type === 'client_credentials') {
        if (app.client_type !== 'confidential') return oauthError(400, 'unauthorized_client', 'public apps use authorization_code with PKCE');
        const bad = authenticate(db, app, body.client_secret);
        if (bad) return bad;
        return mint({ app, project, audience: body.audience, scope: body.scope, privateKey, issuer, settings, db });
    }
    if (body.grant_type === 'authorization_code') {
        const bad = authenticate(db, app, body.client_secret);
        if (bad) return bad;
        const code = String(body.code || '');
        if (!code) return oauthError(400, 'invalid_request', 'Missing code');
        const hash = store.hashSecret(code);
        const row = db.prepare('SELECT * FROM dev_auth_codes WHERE code_hash = ?').get(hash);
        if (!row || row.app_id !== app.id) return oauthError(400, 'invalid_grant', 'Invalid authorization code');
        // Single use, atomically; a failed verification below still burns the code.
        if (db.prepare('UPDATE dev_auth_codes SET used = 1 WHERE code_hash = ? AND used = 0').run(hash).changes !== 1) return oauthError(400, 'invalid_grant', 'Code already used');
        if (Date.parse(row.expires_at) < Date.now()) return oauthError(400, 'invalid_grant', 'Authorization code expired');
        if (row.redirect_uri !== String(body.redirect_uri || '')) return oauthError(400, 'invalid_grant', 'Redirect URI mismatch');
        if (!verifierMatches(body.code_verifier, row.code_challenge)) return oauthError(400, 'invalid_grant', 'PKCE verification failed');
        const user = db.prepare('SELECT subject_id, is_banned FROM users WHERE subject_id = ?').get(row.user_subject);
        if (!user || user.is_banned) return oauthError(400, 'invalid_grant', 'User not found or banned');
        // The exchange may narrow what was authorized, never widen it.
        const authorized = row.scope ? row.scope.split(' ') : null;
        const asked = body.scope ? String(body.scope).split(/\s+/).filter(Boolean) : null;
        if (authorized && asked && asked.some(s => !authorized.includes(s))) return oauthError(400, 'invalid_scope', 'scope exceeds what the user authorized');
        return mint({ app, project, audience: body.audience, scope: body.scope, limit: authorized, onBehalfOf: row.user_subject, privateKey, issuer, settings, db });
    }
    return oauthError(400, 'unsupported_grant_type', 'apps use client_credentials or authorization_code');
}

function verifierMatches(verifier, challenge) {
    if (!PKCE_RE.test(String(verifier || ''))) return false;
    const a = Buffer.from(crypto.createHash('sha256').update(String(verifier)).digest('base64url'));
    const b = Buffer.from(String(challenge));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * /oauth/authorize and /oauth/confirm checks for an app client id: registered redirect URI and a
 * PKCE S256 challenge (required for every app). Returns { app, project } or { error: message }.
 */
function checkAuthorizeRequest(db, { client_id, redirect_uri, code_challenge, code_challenge_method }) {
    const found = usableApp(db, client_id);
    if (found.error) return { error: 'Unknown client_id' };
    const uris = JSON.parse(found.app.redirect_uris || '[]');
    if (!redirect_uri || !uris.includes(String(redirect_uri))) return { error: 'Invalid redirect_uri' };
    if (!code_challenge || code_challenge_method !== 'S256' || !PKCE_RE.test(String(code_challenge))) {
        return { error: 'apps must send a PKCE code_challenge with code_challenge_method=S256', pkce: true };
    }
    return found;
}

/**
 * Issue an authorization code to an app for a signed-in user. A sandbox app may only be authorized
 * by members of its project. Returns { code } or { status, error }.
 */
function issueCode(db, { app, project, user, redirectUri, scope, challenge }) {
    const subjects = require('../identity/subjects');
    const subject = subjects.ensureUserSubject(db, user);
    if (!subject) return { status: 403, error: 'account has no subject id' };
    if (app.environment === 'sandbox' && !store.memberRole(db, project.id, subject)) {
        return { status: 403, error: 'sandbox apps can only be authorized by members of their project' };
    }
    const code = crypto.randomBytes(32).toString('hex');
    db.prepare(`INSERT INTO dev_auth_codes (code_hash, app_id, user_subject, redirect_uri, scope, code_challenge, expires_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)`).run(store.hashSecret(code), app.id, subject, redirectUri,
        String(scope || '').split(/\s+/).filter(s => policy.isGrantable(s)).join(' '), challenge, new Date(Date.now() + CODE_TTL_MS).toISOString());
    db.prepare('DELETE FROM dev_auth_codes WHERE expires_at < ?').run(new Date(Date.now() - 3600 * 1000).toISOString());
    return { code };
}

module.exports = { isAppClient, handleTokenRequest, checkAuthorizeRequest, issueCode, effectiveGrants, TOKEN_TTL_S };
