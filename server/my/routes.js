'use strict';
// ═══════════════════════════════════════════════════════════════
// openvibe.my — the account hub's own front door (plan OpenVibe_Seven_Domains_Plan §4).
//
// Network stays the authority: the API is https://openvibe.network/api/v1/me/*, and every call from
// openvibe.my is a Bearer call (no cookie is ever sent to openvibe.network). openvibe.my has its own
// first-party OAuth client (`my`, PKCE S256, confidential) and a host-only ov_token/ov_refresh on its
// own origin; the shared navbar's silent flow (prompt=none) signs a person already signed in to
// Network in with no click. Signing in here calls OpenVibe.Network's own /oauth/authorize and
// /oauth/token, exactly as every product site does.
//
// The Host header decides:
//   openvibe.my          the account hub at /, and /<section> (the old /my/<section> paths)
//   www.openvibe.my      301 to the apex
//   openvibe.network/my  301 to https://openvibe.my/… (query kept); the account hub's other old paths
//                        (/themes, /security, /machines, …) 301 there too
//   /my, /my.html, /my/* on openvibe.my are 301 to the canonical /<section>
// ═══════════════════════════════════════════════════════════════

const path = require('path');
const express = require('express');
const { createSsoClient, COOKIES } = require('openvibe-sdk/sso');

const MY_HOST = 'openvibe.my';
const WWW_HOST = 'www.openvibe.my';
const NETWORK_HOSTS = new Set(['openvibe.network', 'www.openvibe.network']);
const HUB_PATHS = new Set(require('../not-found').ACCOUNT_HUB_PATHS.filter((p) => !p.startsWith('/my')));
const BOT_RE = /bot|crawl|spider|slurp|headless/i;
const PAGE = path.join(__dirname, '..', '..', 'public', 'my.html');

/** The request's host, lowercased, without the port. */
function hostOf(req) {
    return String((req.headers && req.headers.host) || '').split(':')[0].toLowerCase();
}

/** The request's query, exactly as it came (empty when there is none). */
function queryOf(req) {
    const url = String(req.originalUrl || '');
    const i = url.indexOf('?');
    return i >= 0 ? url.slice(i) : '';
}

function isMyPath(p) {
    return p === '/my' || p === '/my.html' || p === '/my/' || p.startsWith('/my/');
}

function isHubPath(p) {
    return isMyPath(p) || HUB_PATHS.has(p);
}

/** The canonical openvibe.my path for an old Network path: /my/security → /security, /my → /. */
function pathFromNetwork(p) {
    if (p === '/my' || p === '/my.html' || p === '/my/') return '/';
    if (p.startsWith('/my/')) return p.slice(3) || '/';
    return p;
}

/** The canonical openvibe.my path for a /my… path requested on openvibe.my itself. */
function pathFromMy(p) {
    if (p === '/my' || p === '/my.html' || p === '/my/') return '/';
    return p.slice(3) || '/';
}

/** A same-site post-sign-in target: /my… becomes the canonical path, and anything not ours goes home. */
function canonicalNext(raw) {
    const s = String(raw == null ? '' : raw);
    if (!s || /[\\\u0000-\u001f\u007f]/.test(s)) return '/';
    if (s.startsWith('/')) {
        if (s.startsWith('//')) return '/';
        if (s === '/my' || s === '/my.html' || s === '/my/') return '/';
        if (s.startsWith('/my/')) return s.slice(3) || '/';
        if (s.startsWith('/my?') || s.startsWith('/my#')) return `/${s.slice(3)}`;
        if (s.startsWith('/my.html?') || s.startsWith('/my.html#')) return `/${s.slice(8)}`;
        return s;
    }
    try {
        const u = new URL(s);
        if (u.username || u.password) return '/';
        if (u.origin === `https://${MY_HOST}`) return canonicalNext(`${u.pathname}${u.search}${u.hash}`);
        if (NETWORK_HOSTS.has(u.hostname) && u.protocol === 'https:') {
            const p = pathFromNetwork(u.pathname);
            return `${p}${u.search}${u.hash}`;
        }
    } catch { /* not a URL */ }
    return '/';
}

function readCookie(req, name) {
    if (req.cookies && Object.prototype.hasOwnProperty.call(req.cookies, name)) return req.cookies[name];
    const m = String((req.headers && req.headers.cookie) || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
    return m ? decodeURIComponent(m[1]) : null;
}

/** Build the sign-in client: the `my` row's secret, or the host's OV_MY_OAUTH_CLIENT_SECRET. */
async function buildSso({ db, config = require('../config'), log = console } = {}) {
    const opts = config.my || {};
    const clientId = String(opts.clientId || 'my');
    let secret = String(opts.clientSecret || '');
    if (!secret && db && typeof db.prepare === 'function') {
        try {
            const row = await db.prepare('SELECT client_secret FROM oauth_clients WHERE client_id = ?').get(clientId);
            secret = row && row.client_secret ? String(row.client_secret) : '';
        } catch (err) {
            log.warn(`[my] could not read the OAuth client secret: ${err.message}`);
        }
    }
    if (!secret) log.warn(`[my] OAuth client '${clientId}' has no secret yet; sign-in on ${opts.baseUrl || MY_HOST} will fail until the client is provisioned`);
    const baseUrl = String(opts.baseUrl || `https://${MY_HOST}`).replace(/\/+$/, '');
    return createSsoClient({
        site: 'my',
        siteName: 'OpenVibe.My',
        baseUrl,
        clientId,
        clientSecret: secret,
        redirectUri: `${baseUrl}/auth/callback`,
        scope: 'profile theme',
        networkUrl: config.networkUrl,
        networkInternalUrl: config.internalUrl,
        issuer: config.jwt.issuer,
        audience: ['openvibe.network', 'openvibe.my'],
        secureCookies: config.nodeEnv === 'production',
        log,
    });
}

/** The /login, /register… URLs the hub already uses, translated to the SDK's /auth/login (+prompt). */
function loginRedirect(req, res) {
    const q = new URLSearchParams();
    const next = canonicalNext(req.query.return || req.query.next || '/');
    if (next !== '/') q.set('next', next);
    const add = req.query.add_account === '1' || req.query.add_account === '' || req.query.prompt === 'select_account';
    const reauth = req.query.reauth === '1' || req.query.prompt === 'login';
    if (add) q.set('prompt', 'select_account');
    else if (reauth) q.set('prompt', 'login');
    const hint = String(req.query.login_hint || '').trim();
    if (hint.length <= 64 && /^@?[A-Za-z0-9_.-]+$/.test(hint)) q.set('login_hint', hint);
    return res.redirect(302, `/auth/login${q.toString() ? `?${q.toString()}` : ''}`);
}

/** The hub's "sign in/out everywhere" links: clear this origin first, then run Network's fanout, then come back. */
function fanoutRedirect(req, res) {
    const action = req.query.action === 'logout' ? 'logout' : 'login';
    let back = String(req.query.next || '/');
    if (back.startsWith('/') && !back.startsWith('//')) back = `https://${MY_HOST}${back}`;
    try {
        const u = new URL(back);
        if (u.protocol !== 'https:' || !['openvibe.my', 'www.openvibe.my', 'openvibe.network', 'www.openvibe.network'].includes(u.hostname)) back = `https://${MY_HOST}/`;
    } catch { back = `https://${MY_HOST}/`; }
    // After signing out everywhere, land quietly on the hub instead of starting a silent sign-in with the
    // Network session that the fanout is about to clear.
    if (action === 'logout') {
        try { const u = new URL(back); u.searchParams.set('sso', 'none'); back = u.toString(); } catch { /* keep back */ }
    }
    const fanout = new URL('https://openvibe.network/sso/fanout');
    fanout.searchParams.set('action', action);
    fanout.searchParams.set('next', back);
    for (const k of ['step', 'done', 'skipped', 'skip']) {
        if (req.query[k] != null) fanout.searchParams.set(k, String(req.query[k]));
    }
    const base = action === 'logout' ? '/auth/logout' : '/auth/login?silent=1';
    return res.redirect(302, `${base}${base.includes('?') ? '&' : '?'}next=${encodeURIComponent(fanout.toString())}`);
}

/**
 * The routes. Calls next() for a request that is not for one of these hosts, so every other host falls
 * through to Network's own pages.
 */
async function createMyRoutes({ db, config = require('../config'), sso, pagePath = PAGE, log = console } = {}) {
    const client = sso || await buildSso({ db, config, log });
    const auth = client.router(express);
    const page = path.resolve(pagePath);

    function serveApp(req, res) {
        const quiet = String(req.query.sso || '') === 'none' || readCookie(req, COOKIES.hint) === 'guest';
        if (!readCookie(req, COOKIES.access) && !quiet && ['GET', 'HEAD'].includes(req.method) && !BOT_RE.test(String(req.headers['user-agent'] || ''))) {
            return res.redirect(302, `/auth/login?silent=1&next=${encodeURIComponent(req.originalUrl || '/')}`);
        }
        res.set('Cache-Control', 'no-store');
        return res.sendFile(page);
    }

    function onMyHost(req, res, next) {
        const p = req.path;
        // The API stays on its canonical host: the page calls it with a Bearer token from openvibe.my,
        // and a cookie from this host must never be what authenticates a call there.
        if (/^\/(api|internal|oauth)(\/|$)/.test(p)) return res.redirect(308, `https://openvibe.network${req.originalUrl}`);
        if (!['GET', 'HEAD'].includes(req.method)) return next();
        if (isMyPath(p)) return res.redirect(301, `${pathFromMy(p)}${queryOf(req)}`);
        if (p === '/index.html') return res.redirect(301, `/${queryOf(req)}`);
        if (['/login', '/register', '/signup', '/sign-up', '/forgot-password', '/reset-password'].includes(p)) return loginRedirect(req, res);
        if (p === '/sso/fanout' || p === '/sso/fanout.html') return fanoutRedirect(req, res);
        if (p === '/sso/check') return res.redirect(302, `https://openvibe.network${req.originalUrl}`);
        // Pages that live on Network, not in the account hub: keep their old relative links working.
        if (['/wallet', '/sites', '/apps', '/admin'].includes(p) || p.startsWith('/admin/')) {
            return res.redirect(302, `https://openvibe.network${req.originalUrl}`);
        }
        if (p === '/' || HUB_PATHS.has(p)) return serveApp(req, res);
        return next();
    }

    const router = express.Router();
    // Host routing first: the hub's SSO and pages answer only on openvibe.my.
    router.use((req, res, next) => {
        const host = hostOf(req);
        if (host === WWW_HOST) return res.redirect(301, `https://${MY_HOST}${req.originalUrl}`);
        if (NETWORK_HOSTS.has(host)) {
            if (!isHubPath(req.path) || !['GET', 'HEAD'].includes(req.method)) return next();
            return res.redirect(301, `https://${MY_HOST}${pathFromNetwork(req.path)}${queryOf(req)}`);
        }
        if (host === MY_HOST) req.ovMyHost = true;
        next();
    });
    // Mounted at /auth, as the SDK expects; the host guard keeps it off openvibe.network.
    router.use('/auth', (req, res, next) => (req.ovMyHost ? auth(req, res, next) : next()));
    router.use((req, res, next) => (req.ovMyHost ? onMyHost(req, res, next) : next()));
    return router;
}

module.exports = {
    MY_HOST, WWW_HOST, HUB_PATHS, isMyPath, isHubPath, createMyRoutes, buildSso, pathFromNetwork, pathFromMy, canonicalNext, loginRedirect, fanoutRedirect,
};
