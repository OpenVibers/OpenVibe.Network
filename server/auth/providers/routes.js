'use strict';
/**
 * Sign in with anything (plan §AB.20, wave 1): the provider routes and the account rules they enforce.
 *
 *   GET  /api/auth/connect                       the providers this Network offers (the sign-in page's buttons)
 *   GET  /api/auth/connect/:id                   start a sign-in (no session needed)
 *   GET  /api/auth/connect/:id/verify            ask the owner's provider app whether it is reachable
 *   GET  /api/auth/connect/:id/callback          the provider's answer: sign in, or link
 *   POST /api/auth/connect/:id/callback          the same, for Apple's form_post
 *   GET  /api/auth/connect/:id/status            the person's own link state for this provider
 *   POST /api/auth/connect/:id/link              start a link (a session is required)
 *   DELETE /api/auth/connect/:id/link            unlink, unless it is the last way in
 *   GET  /api/auth/discord/link                  the old Discord path, kept as an alias of the sign-in start
 *   GET  /api/auth/discord/callback              and its callback
 *
 * Accounts, safe by default (research §3.3, ADR-029):
 *   - an identity already in linked_accounts signs its person in, whatever the email;
 *   - an identity that is not linked makes a NEW account (a username from the provider's name, made unique, the
 *     provider's picture, the address only when the provider verified it), never an account matched by email;
 *   - when the provider's verified email belongs to an existing account, the person is told to sign in to that account
 *     and link this provider from the account page: nothing is attached, merged or silently duplicated;
 *   - a signed-in person may link an identity (mode=link), and unlink one, but never the last way in.
 * Every start, sign-in, link and unlink is an audit row (signin_*), with no token, code or secret in it.
 */
const crypto = require('crypto');
const express = require('express');
const presets = require('./presets');
const configNs = require('./config');
const stateStore = require('./state');
const { createRegistry } = require('./index');
const { requireOwner } = require('../owner-guard');
const subjects = require('../../identity/subjects');
const usernames = require('../../identity/usernames');

// A sentinel that bcrypt never matches: an account made by a provider has no password until the person sets one.
const NO_PASSWORD = '!provider';
const SIGNIN_SWITCH = 'signin_switch';

/** The identity shape the provider layer returns, trimmed to what is safe to store and compare. */
function cleanIdentity(id) {
    const text = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
    return {
        provider_user_id: String(id.provider_user_id || '').slice(0, 200),
        username: text(id.username, 64),
        display_name: text(id.display_name, 80) || 'OpenVibe account',
        avatar_url: text(id.avatar_url, 1000),
        email: text(id.email, 254),
        email_verified: id.email_verified === true,
    };
}

/** A username from a provider's name: ASCII letters, digits and underscores, 3 to 24, never the reserved prefixes. */
function suggestUsername(identity, providerId) {
    const raw = String(identity.username || identity.display_name || providerId || 'vibe');
    let base = raw.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
    if (base.length > 24) base = base.slice(0, 24);
    if (base.length < 3) base = `${base}${providerId}`.replace(/[^A-Za-z0-9_]/g, '').slice(0, 24);
    if (base.length < 3) base = `vibe_${providerId}`;
    if (/^anon/i.test(base)) base = `v_${base.slice(4)}`.slice(0, 24);
    if (RESERVED_NAMES.has(base.toLowerCase())) base = `v_${base}`.slice(0, 24);
    return base;
}
// The names registration refuses (server/auth/routes.js), kept in step here so a provider's name cannot claim one.
const RESERVED_NAMES = new Set(['live', 'system', 'openvibelivebot']);

/** The first free username from a suggestion: name, name2, name3 … (case-insensitive, and never one in reservation). */
async function uniqueUsername(db, suggestion, userId = null) {
    for (let i = 0; i < 50; i += 1) {
        const candidate = i === 0 ? suggestion : `${suggestion.slice(0, 24 - String(i + 1).length)}${i + 1}`;
        if (!(await usernames.problemWith(db, candidate, userId))) return candidate;
    }
    return `${suggestion.slice(0, 16)}_${crypto.randomBytes(3).toString('hex')}`;
}

/** The audit line every sign-in path writes: the provider and the outcome, never a token, a code or a secret. */
async function audit(db, action, { userId = null, provider = null, outcome = null, detail = null } = {}) {
    try {
        const details = JSON.stringify({ provider, outcome, ...(detail ? { detail: String(detail).slice(0, 200) } : {}) });
        await db.prepare('INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)').run(userId, action, details);
    } catch { /* audit is best effort, as everywhere */ }
}

/**
 * The account an identity belongs to, or what to do about it:
 *   { user }                       already linked: sign that person in
 *   { newAccount: true, ... }      not linked: make one (nothing matched by email)
 *   { emailTaken: { user } }       a verified address already on an account: not an error, a sentence and a way in
 */
async function lookup(db, providerId, identity) {
    const linked = await db.prepare('SELECT user_id FROM linked_accounts WHERE service = ? AND service_user_id = ?').get(providerId, identity.provider_user_id);
    if (linked) {
        const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(linked.user_id);
        return user ? { user: await require('../../identity/account-aliases').effectiveUser(db, user) } : { newAccount: true };
    }
    return { newAccount: true };
}

/** Whether an address is already on some account (users.email or a verified account_emails row): only used to explain. */
async function accountForEmail(db, email) {
    if (!email) return null;
    const row = await db.prepare(`SELECT u.id FROM users u WHERE LOWER(u.email) = LOWER(?) AND u.deleted_at IS NULL
        UNION SELECT ae.user_id FROM account_emails ae WHERE LOWER(ae.email) = LOWER(?) AND ae.verified = 1 AND ae.user_id IN (SELECT id FROM users WHERE deleted_at IS NULL)
        LIMIT 1`).get(email, email);
    return row ? row.id : null;
}

/** The person's ways in: a password they know, a passkey, another provider, or a live recovery code. */
async function waysIn(db, userId) {
    const user = await db.prepare('SELECT id, password_hash FROM users WHERE id = ?').get(userId);
    // Only a sign-in provider is a way in. linked_accounts also holds the sites a person has signed in to (Live,
    // Tools, and the `network:<id>` row the code exchange writes): those are not accounts anyone can sign in with,
    // and counting them would let the last provider be removed as if two were left.
    const providerIds = [...presets.BY_ID.keys()];
    const rows = await db.prepare(`SELECT service FROM linked_accounts WHERE user_id = ? AND service IN (${providerIds.map(() => '?').join(', ')})`).all(userId, ...providerIds);
    let passkeys = 0;
    try { passkeys = (await require('../passkeys').list(db, userId)).length; } catch { /* no passkeys table in an old database */ }
    const hasPassword = !!(user && user.password_hash && !/^!/.test(user.password_hash));
    return { password: hasPassword, passkeys, linked: rows.length };
}

/**
 * Make a new account from a provider identity: the username made unique, the provider's picture and (only when the
 * provider verified it) the address, the no-password sentinel, and a default preferences row like registration's.
 */
async function createAccount(db, providerId, identity, { ip } = {}) {
    const username = await uniqueUsername(db, suggestUsername(identity, providerId));
    const linked = identity.email && identity.email_verified ? identity.email : null;
    const result = await db.prepare(`
        INSERT INTO users (username, email, password_hash, display_name, avatar_url, profile_color, subject_id, email_verified, email_verified_at, is_test)
        VALUES (?, ?, ?, ?, ?, '#8b5cf6', ?, ?, ?, ?) RETURNING id
    `).run(username, linked, NO_PASSWORD, identity.display_name || username, identity.avatar_url || null,
        subjects.newUserSubjectId(), linked ? 1 : 0, linked ? new Date().toISOString() : null, subjects.isTestUsername(username) ? 1 : 0);
    const userId = result.lastInsertRowid;
    await db.prepare('INSERT INTO user_preferences (user_id) VALUES (?) ON CONFLICT DO NOTHING').run(userId);
    if (linked) {
        try {
            await db.prepare('INSERT INTO account_emails (id, user_id, email, verified, verified_at, is_primary) VALUES (?, ?, ?, 1, ov_now(), 1)')
                .run(crypto.randomUUID(), userId, linked);
        } catch { /* a second verified copy of one address is refused by its unique index: the users row still has it */ }
    }
    try {
        await db.prepare('INSERT INTO ip_log (user_id, ip, action) VALUES (?, ?, ?)').run(userId, String(ip || '').slice(0, 64), `signin_${providerId}`);
    } catch { /* optional */ }
    return await db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
}

/** Attach an identity to an account, or say why not. → { ok } | { alreadyLinkedOther: userId } | { alreadyYours: true } */
async function link(db, userId, providerId, identity) {
    const existing = await db.prepare('SELECT user_id, service_username FROM linked_accounts WHERE service = ? AND service_user_id = ?').get(providerId, identity.provider_user_id);
    if (existing && Number(existing.user_id) !== Number(userId)) return { alreadyLinkedOther: Number(existing.user_id) };
    if (existing) return { alreadyYours: true };
    const mine = await db.prepare('SELECT service_user_id FROM linked_accounts WHERE user_id = ? AND service = ?').get(userId, providerId);
    const handle = String(identity.username || identity.display_name || '').slice(0, 100);
    if (mine) {
        await db.prepare('UPDATE linked_accounts SET service_user_id = ?, service_username = ?, linked_at = ov_now(), last_used_at = ov_now() WHERE user_id = ? AND service = ?')
            .run(identity.provider_user_id, handle, userId, providerId);
        return { ok: true, replaced: mine.service_user_id };
    }
    await db.prepare('INSERT INTO linked_accounts (user_id, service, service_user_id, service_username, linked_at, last_used_at) VALUES (?, ?, ?, ?, ov_now(), ov_now())')
        .run(userId, providerId, identity.provider_user_id, handle);
    return { ok: true };
}

/** The page a sign-in comes back to when it is not an app's: the account hub, or ?return= when it is one of ours. */
function safeReturn(value) {
    const s = String(value || '');
    if (!s || s.length > 300) return '/my';
    if (s.startsWith('/') && !/^\/[\/\\]/.test(s) && !/[\\\u0000-\u001f\u007f]/.test(s)) return s;
    try {
        const u = new URL(s);
        if (u.protocol === 'https:' && !u.username && !u.password && require('../../first-party-origins').manifestOrigins().has(u.origin)) return u.toString();
    } catch { /* not a URL */ }
    return '/my';
}

/**
 * The router. `requireAuth` is the session guard from server/auth/routes.js; `signToken` its token minter;
 * `fetch` is injected so tests can answer for the providers from recorded documents (no test ever reaches the
 * network).
 */
function createRouter({ requireAuth, signToken, config = {}, fetch: fetchImpl = globalThis.fetch, log = console, now = () => Date.now() } = {}) {
    const r = express.Router();
    const registry = createRegistry({ config, fetch: fetchImpl, log, now });
    const baseUrl = () => String((config.baseUrl || config.loginUrl || 'https://openvibe.network')).replace(/\/+$/, '');
    const callbackPath = (id, alias = null) => (alias || `${baseUrl()}/api/auth/connect/${id}/callback`);
    const dbOf = (req) => req.app.locals.db;
    const sealerOf = (req) => stateStore.sealer(req.app.locals.privateKey || req.app.locals.config?.jwt?.privateKey || 'openvibe-network');

    // The connect routes carry a state, a code and a cookie: no cache, ever, and no indexing.
    r.use((req, res, next) => { res.set('Cache-Control', 'no-store'); res.set('X-Robots-Tag', 'noindex'); next(); });

    // A sign-in start needs no session; a link start does. Resolve the session when one is present, and never refuse
    // here: `mode=link` answers 401 itself, so the person gets the "sign in first" sentence rather than a bare error.
    r.use(async (req, res, next) => {
        try {
            const { verifySession, requestToken } = require('../session');
            const token = requestToken(req);
            if (token) {
                const out = await verifySession(token, { db: dbOf(req), publicKey: req.app.locals.publicKey, config: req.app.locals.config || config });
                if (!out.error && out.user && !out.user.is_anon) { req.user = out.user; req.token = token; req.tokenClaims = out.decoded; }
            }
        } catch { /* not signed in */ }
        next();
    });

    // ── What the sign-in page draws, and the page itself is indexable ──
    async function list(req) {
        const db = dbOf(req);
        const store = await configNs.forDb(db, baseUrl());
        const all = await registry.listed(db);
        const master = (store.get() || {})[SIGNIN_SWITCH];
        return { providers: master === false ? [] : all, master_on: master !== false };
    }

    r.get('/', async (req, res) => {
        try {
            const { providers } = await list(req);
            res.set('Cache-Control', 'public, max-age=60');
            res.json({ ok: true, providers });
        } catch (err) {
            log.error(`[SignIn] the provider list failed: ${String(err && err.message).slice(0, 160)}`);
            res.json({ ok: true, providers: [] });
        }
    });

    // ── Start ──
    /**
     * `?mode=signin` (the default) needs no session: an identity already linked signs its person in, and a new one makes
     * a new account. `?mode=link` needs the session and attaches the identity to it. `?app=<query>` is a site's OAuth
     * authorize query, replayed after the sign-in so the app gets its code as usual; `?return=` is a path back.
     */
    async function startFlow(req, res, providerId, { alias = null, forceMode = null } = {}) {
        const db = dbOf(req);
        const p = presets.BY_ID.get(providerId);
        if (!p) return res.status(404).json({ ok: false, error: 'No such sign-in provider', code: 'unknown_provider' });
        const s = await registry.settings(db, providerId);
        if (!s || !s.enabled) return res.status(503).json({ ok: false, error: `Sign in with ${p.name} is not configured`, code: 'provider_not_configured' });
        const mode = forceMode || (String(req.query.mode || '') === 'link' ? 'link' : 'signin');
        if (mode === 'link' && !req.user) return res.status(401).json({ ok: false, error: 'Sign in first, then link', code: 'link_needs_session', sign_in_url: `${baseUrl()}/login?return=${encodeURIComponent(`/my`)}` });
        // A link never carries an app's authorize query: it is the person's own account page doing it.
        const appQuery = mode === 'link' ? null : (typeof req.query.app === 'string' && req.query.app.length <= 1200 ? req.query.app : null);
        const returnTo = mode === 'link' ? '/my' : safeReturn(req.query.return);

        const state = await stateStore.create({
            db, provider: providerId, mode, userId: mode === 'link' ? req.user.id : null,
            returnTo, appQuery, verifier: null, nonce: null, seal: sealerOf(req),
        });
        const redirectUri = callbackPath(providerId, alias);
        let built;
        try {
            built = await registry.start({ db, providerId, state, redirectUri, values: s.values });
        } catch (err) {
            stateStore.clearCookie(res);
            return res.status(err.code === 'provider_discovery_failed' ? 502 : 400).json({ ok: false, error: err.message, code: err.code || 'provider_start_failed' });
        }
        // Store the verifier and nonce now that the engine made them, sealed in the same row.
        if (built.verifier || built.nonce) {
            const seal = sealerOf(req);
            await db.prepare('UPDATE signin_states SET verifier = ?, nonce = ? WHERE state_hash = ?')
                .run(built.verifier ? seal.seal(built.verifier) : null, built.nonce ? seal.seal(built.nonce) : null, stateStore.hash(state));
        }
        // Apple answers with a cross-site POST (form_post), which a SameSite=Lax cookie never rides on.
        stateStore.setCookie(res, state, { crossSitePost: p.kind === 'apple' });
        await audit(db, 'signin_started', { userId: mode === 'link' ? req.user.id : null, provider: providerId, outcome: mode });
        return res.redirect(302, built.redirect);
    }

    r.get('/:id', async (req, res) => {
        const id = String(req.params.id || '').toLowerCase();
        if (!presets.BY_ID.has(id)) return res.status(404).json({ ok: false, error: 'No such sign-in provider', code: 'unknown_provider' });
        return startFlow(req, res, id);
    });
    // The old Discord link path (an existing app registration points at it): the same flow, the old callback path.
    r.get('/:id/link', async (req, res) => {
        const id = String(req.params.id || '').toLowerCase();
        if (!presets.BY_ID.has(id)) return res.status(404).json({ ok: false, error: 'No such sign-in provider', code: 'unknown_provider' });
        return startFlow(req, res, id, { alias: `${baseUrl()}/api/auth/connect/${id}/callback`, forceMode: 'link' });
    });

    // ── The person's own link state ──
    /** Every offered provider at once, for the account page: { apps: { google: { linked, can_unlink }, … } }. */
    r.get('/apps/status', requireAuth, (req, res, next) => appsStatus(req, res, next));
    r.get('/:id/status', requireAuth, (req, res, next) => appsStatus(req, res, next, String(req.params.id || '').toLowerCase()));
    async function appsStatus(req, res, next, only = null) {
        try {
            const db = dbOf(req);
            const s = only ? null : await registry.listed(db);
            const ids = only ? [only] : (s || []).map((p) => p.id);
            if (only && !presets.BY_ID.has(only)) return res.status(404).json({ ok: false, error: 'No such sign-in provider', code: 'unknown_provider' });
            const w = await waysIn(db, req.user.id);
            const apps = {};
            for (const id of ids) {
                const linked = await db.prepare('SELECT service_user_id, service_username, linked_at, last_used_at FROM linked_accounts WHERE user_id = ? AND service = ?').get(req.user.id, id);
                apps[id] = {
                    linked: linked || null,
                    // Whether this one can be unlinked: some other way in has to stay (a password, a passkey, or a
                    // second linked app).
                    can_unlink: !!linked && (w.password || w.passkeys > 0 || w.linked > 1),
                };
            }
            if (only) {
                const one = await registry.settings(db, only);
                return res.json({ ok: true, configured: !!(one && one.enabled), linked: apps[only].linked, can_unlink: apps[only].can_unlink });
            }
            return res.json({ ok: true, apps, ways_in: w });
        } catch (err) { return next(err); }
    }

    // ── The callback ──
    /**
     * One callback for sign-in and linking. Refusals are a redirect to the sign-in page with `?error=` (a browser got
     * here by navigating), never a JSON body a person would see; a state problem also clears the cookie.
     */
    async function callback(req, res, providerId, { alias = null } = {}) {
        const db = dbOf(req);
        const p = presets.BY_ID.get(providerId);
        if (!p) return res.redirect(302, `${baseUrl()}/login?error=unknown_provider`);
        const query = { ...(req.query || {}) };
        const body = req.method === 'POST' ? (req.body || {}) : {};
        const stateValue = String((body.state !== undefined ? body.state : query.state) || '');
        // The browser's cookie must carry this exact state, in constant time, or the callback is not ours.
        if (!stateStore.matchesCookie(req, stateValue)) {
            stateStore.clearCookie(res);
            await audit(db, 'signin_refused', { provider: providerId, outcome: 'state_mismatch' });
            return res.redirect(302, `${baseUrl()}/login?error=state_mismatch&provider=${encodeURIComponent(providerId)}`);
        }
        // One use: the row is deleted as it is read; a replay finds nothing.
        const row = await stateStore.take({ db, state: stateValue });
        stateStore.clearCookie(res);
        if (!row) {
            await audit(db, 'signin_refused', { provider: providerId, outcome: 'state_expired' });
            return res.redirect(302, `${baseUrl()}/login?error=state_expired&provider=${encodeURIComponent(providerId)}`);
        }
        const fail = async (outcome, detail = null) => {
            await audit(db, 'signin_refused', { userId: row.user_id, provider: providerId, outcome, detail });
            // A link started from the account page comes back to it; a sign-in comes back to the sign-in page.
            if (row.mode === 'link') return res.redirect(302, `${baseUrl()}/my?linked=${encodeURIComponent(providerId)}&result=${encodeURIComponent(outcome)}`);
            const back = safeReturn(row.return_to);
            return res.redirect(302, `${baseUrl()}/login?error=${encodeURIComponent(outcome)}&provider=${encodeURIComponent(providerId)}&return=${encodeURIComponent(back)}`);
        };
        // Error coming back from the provider itself (access_denied, and the like).
        const provErr = String(body.error !== undefined ? body.error : query.error || '');
        if (provErr) return fail(`provider_${provErr}`.slice(0, 60));

        const seal = sealerOf(req);
        const unsealed = { ...row, verifier: seal.open(row.verifier), nonce: seal.open(row.nonce) };
        const redirectUri = callbackPath(providerId, alias);
        let identity;
        try {
            identity = cleanIdentity(await registry.finish({ db, providerId, stateRow: unsealed, query, body, redirectUri }));
        } catch (err) {
            log.warn(`[SignIn] ${providerId}: ${String(err && err.message).slice(0, 200)}`);
            return fail(err && err.code ? String(err.code).slice(0, 60) : 'provider_failed');
        }
        if (!identity.provider_user_id) return fail('provider_no_identity');

        // ── Linking an identity to the account already signed in ──
        if (row.mode === 'link') {
            const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
            if (!user || user.deleted_at || user.merged_into) return fail('session_gone');
            const out = await link(db, user.id, providerId, identity);
            if (out.alreadyLinkedOther) {
                await audit(db, 'signin_link_refused', { userId: user.id, provider: providerId, outcome: 'already_linked_other' });
                return res.redirect(302, `${baseUrl()}/my?linked=${encodeURIComponent(providerId)}&result=already_linked_other`);
            }
            if (out.ok) {
                await audit(db, 'signin_linked', { userId: user.id, provider: providerId, outcome: out.replaced ? 'replaced' : 'linked', detail: identity.username || identity.display_name });
                return res.redirect(302, `${baseUrl()}/my?linked=${encodeURIComponent(providerId)}&result=success`);
            }
            return res.redirect(302, `${baseUrl()}/my?linked=${encodeURIComponent(providerId)}&result=already_yours`);
        }

        // ── Signing in ──
        const found = await lookup(db, providerId, identity);
        if (found.user) {
            if (found.user.deleted_at) return fail('account_deleted');
            if (found.user.is_banned) {
                await audit(db, 'signin_refused', { userId: found.user.id, provider: providerId, outcome: 'banned' });
                return res.redirect(302, `${baseUrl()}/login?error=banned&provider=${encodeURIComponent(providerId)}`);
            }
            // The account may keep two-factor on its own terms, exactly as the password route does.
            try {
                if (await require('../mfa').challengeLogin(db, req, res, found.user)) {
                    await audit(db, 'signin_challenged', { userId: found.user.id, provider: providerId, outcome: 'mfa' });
                    return;
                }
            } catch (err) {
                log.warn(`[SignIn] ${providerId}: two-factor challenge failed: ${String(err && err.message).slice(0, 160)}`);
                return fail('mfa_unavailable');
            }
            await db.prepare('UPDATE users SET last_seen = ov_now() WHERE id = ?').run(found.user.id);
            await db.prepare('UPDATE linked_accounts SET last_used_at = ov_now() WHERE service = ? AND service_user_id = ?').run(providerId, identity.provider_user_id);
            const token = signToken(found.user, req.app.locals.privateKey, req.app.locals.config);
            require('../session').setSessionCookies(res, token);
            await audit(db, 'signin', { userId: found.user.id, provider: providerId, outcome: 'ok', detail: identity.username || null });
            return res.redirect(302, afterSignIn(req, token, found.user, row));
        }

        // An identity that is not linked: never attach it to an account because an email matches. When the provider
        // verified the address and an account holds it, say so and offer the way in instead (ADR-029).
        if (identity.email && identity.email_verified) {
            const owner = await accountForEmail(db, identity.email);
            if (owner) {
                await audit(db, 'signin_refused', { provider: providerId, outcome: 'email_on_another_account' });
                // Wait for the person's own decision (the page renders "sign in to your account, then link") — the
                // email is in the page only after this provider verified it, and it is the person's own address.
                return res.redirect(302, `${baseUrl()}/login?error=email_taken&provider=${encodeURIComponent(providerId)}&email=${encodeURIComponent(identity.email)}&return=${encodeURIComponent(safeReturn(row.return_to))}`);
            }
        }
        const user = await createAccount(db, providerId, identity, { ip: req.ip });
        await link(db, user.id, providerId, identity);
        const token = signToken(user, req.app.locals.privateKey, req.app.locals.config);
        require('../session').setSessionCookies(res, token);
        await audit(db, 'signin', { userId: user.id, provider: providerId, outcome: 'new_account', detail: identity.username || null });
        return res.redirect(302, afterSignIn(req, token, user, row, { created: true }));
    }

    /**
     * Where a signed-in person lands. An app's sign-in (`app=` on the start) goes back through /login, which reads
     * the session just set and confirms it for the app exactly as a password sign-in does (its chooser, its consent,
     * its code); anything else goes back to `?return=`, with a note when the account is new.
     */
    function afterSignIn(req, token, user, row, { created = false } = {}) {
        if (row.app_query) {
            const q = new URLSearchParams(String(row.app_query));
            // The provider's answer set the session cookie and this page reads it (login.js adoptSignedInProvider):
            // the app gets its code through the same confirm a password sign-in uses.
            q.set('signed_in', '1');
            return `${baseUrl()}/login?${q.toString()}`;
        }
        const back = safeReturn(row.return_to);
        const u = new URL(back, baseUrl());
        if (created) u.searchParams.set('welcome', '1');
        return u.toString();
    }

    r.get('/:id/callback', (req, res) => callback(req, res, String(req.params.id || '').toLowerCase()));
    r.post('/:id/callback', (req, res) => callback(req, res, String(req.params.id || '').toLowerCase()));

    // ── Unlink, never the last way in ──
    async function unlink(req, res, id) {
        const db = dbOf(req);
        const p = presets.BY_ID.get(id);
        if (!p) return res.status(404).json({ ok: false, error: 'No such sign-in provider', code: 'unknown_provider' });
        const mine = await db.prepare('SELECT service_user_id FROM linked_accounts WHERE user_id = ? AND service = ?').get(req.user.id, id);
        if (!mine) return res.json({ ok: true, unlinked: false });
        const w = await waysIn(db, req.user.id);
        // This row is one of the ways in: after removing it, something else must remain (a password, a passkey, or
        // one more linked sign-in provider). sites in linked_accounts are not ways in.
        if (!(w.password || w.passkeys > 0 || w.linked > 1)) {
            return res.status(409).json({
                ok: false, code: 'last_way_in',
                error: `That is your only way in. Set a password or add another sign-in first, then remove ${p.name}.`,
                ways_in: w,
            });
        }
        await db.prepare('DELETE FROM linked_accounts WHERE user_id = ? AND service = ?').run(req.user.id, id);
        await audit(db, 'signin_unlinked', { userId: req.user.id, provider: id, outcome: 'ok' });
        return res.json({ ok: true, unlinked: true });
    }
    r.delete('/:id/link', requireAuth, (req, res) => unlink(req, res, String(req.params.id || '').toLowerCase()));

    // ── The owner's "verify": one cheap read of the provider's own endpoints with the stored keys ──
    // Owner only: it names the provider's endpoints and makes an outbound call, which is a diagnostic for the person
    // who holds the keys, not for everyone signed in.
    r.get('/:id/verify', requireAuth, requireOwner, async (req, res) => {
        const db = dbOf(req);
        const id = String(req.params.id || '').toLowerCase();
        const p = presets.BY_ID.get(id);
        if (!p) return res.status(404).json({ ok: false, error: 'No such sign-in provider', code: 'unknown_provider' });
        res.set('Cache-Control', 'no-store');
        try {
            const s = await registry.settings(db, id);
            if (!s) return res.json({ ok: true, reachable: false, message: 'No such provider' });
            if (!s.enabled) return res.json({ ok: true, reachable: false, message: `${p.name} is not set up yet: its keys are missing or its switch is off.` });
            if (p.kind === 'oidc' || p.kind === 'apple') {
                const doc = await registry.discovery.get(p.issuer || p.discoveryIssuer);
                return res.json({ ok: true, reachable: true, message: `${p.name}'s sign-in service answered: ${doc.authorization_endpoint}` });
            }
            if (p.kind === 'oauth2') {
                // A HEAD/GET of the authorize endpoint is enough: a reachable provider answers anything but a network error.
                const out = await fetchImpl(p.authorize, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(6000), headers: { accept: 'text/html' } });
                return res.json({ ok: true, reachable: out.status < 500, message: `${p.name}'s sign-in page answered HTTP ${out.status}` });
            }
            const out = await fetchImpl(p.endpoint, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(6000) });
            return res.json({ ok: true, reachable: out.status < 500, message: `Steam's OpenID endpoint answered HTTP ${out.status}` });
        } catch (err) {
            return res.json({ ok: true, reachable: false, message: String(err && err.message ? err.message : 'It did not answer').slice(0, 200) });
        }
    });

    /**
     * The old /api/auth/discord mount, kept for the Discord app registration and the account page that already point at
     * it: /link starts a link (a session, as it always did), /callback answers on the old path, /status is the old
     * shape. Appended after the generic routes, so nothing here is reached by /connect/:id.
     */
    const discordAlias = express.Router();
    discordAlias.use((req, res, next) => { res.set('Cache-Control', 'no-store'); res.set('X-Robots-Tag', 'noindex'); next(); });
    discordAlias.get('/link', requireAuth, (req, res) => startFlow(req, res, 'discord', { alias: `${baseUrl()}/api/auth/discord/callback`, forceMode: 'link' }));
    discordAlias.get('/callback', (req, res) => callback(req, res, 'discord', { alias: `${baseUrl()}/api/auth/discord/callback` }));
    discordAlias.post('/callback', (req, res) => callback(req, res, 'discord', { alias: `${baseUrl()}/api/auth/discord/callback` }));
    discordAlias.delete('/link', requireAuth, async (req, res) => { await unlink(req, res, 'discord'); });
    discordAlias.get('/status', requireAuth, async (req, res) => {
        const db = dbOf(req);
        const s = await registry.settings(db, 'discord');
        const linked = await db.prepare("SELECT service_user_id, service_username, linked_at FROM linked_accounts WHERE user_id = ? AND service = 'discord'").get(req.user.id);
        res.json({ ok: true, configured: !!(s && s.enabled), linked: linked || null });
    });

    return { router: r, discordAlias, list, registry };
}

module.exports = { createRouter, NO_PASSWORD, SIGNIN_SWITCH, cleanIdentity, suggestUsername, uniqueUsername, waysIn, createAccount, link, safeReturn, audit };
