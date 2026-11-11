'use strict';
// openvibe.link, served by Network: OpenVibe Link's front door (the Node renamed, 2026-11-07). The Host header
// decides: on openvibe.link '/' is Link's page, '/install' answers with the installer of the latest release, and
// the page has its Markdown twin, its llms.txt and its crawl files, like Network's other pages.
//
// www.openvibe.link answers 301 to openvibe.link.
//
// The route is mounted before the agent layer, so Link's page is not answered by Network's home renderer.

const { markdownTwin, linkHeaderTags } = require('openvibe-shared/agent-layer');
const fs = require('node:fs');
const pathLib = require('node:path');
const page = require('./page');
const release = require('./release');
const { verifySession } = require('../auth/session');
const { consumeTicket } = require('../auth/handoff');
const { issueTokenPair, recordLinkedService } = require('../auth/oauth-routes');

const HOST = page.HOST;
const WWW_HOST = page.WWW_HOST;
const SITE = page.SITE;

// The hub's sign-in: the link-web OAuth client, and the callback the tickets are bound to.
const LINK_CLIENT_ID = 'link-web';
const LINK_CALLBACK = `${SITE}/auth/callback`;
const HUB_PATH = '/machines';
const HUB_PAGE = pathLib.join(__dirname, '..', '..', 'public', 'my.html');
const BOT_RE = /bot|crawl|spider|slurp|headless/i;

/** The request's host, lowercased, without the port. */
function hostOf(req) {
    return String((req.headers && req.headers.host) || '').split(':')[0].toLowerCase();
}

// Return destinations are exact HTTPS origins from service manifests. Reject credentials,
// protocol-relative URLs, localhost and arbitrary hosts before redirecting.
function safeReturnTo(value) {
    if (!value || String(value).length > 2048) return null;
    try {
        const url = new URL(String(value));
        if (url.protocol !== 'https:' || url.username || url.password) return null;
        if (!require('../first-party-origins').manifestOrigins().has(url.origin)) return null;
        return url.toString();
    } catch { return null; }
}

/** Link's llms.txt: what the page is, how to install it, and where the docs are. */
function llmsTxt() {
    return [
        '# OpenVibe Link',
        '',
        '> OpenVibe Link is one program (openvibe-link) that runs on your computer, server, phone or robot. It connects out to OpenVibe, needs no open ports, keeps a local kill switch, and does nothing you did not turn on.',
        '',
        '## The page',
        '',
        `- [OpenVibe Link: your machines, connected](${SITE}/): what it is, what it does today (run your agents and code, offer your models or GPU and earn credits, drive robots, stream an agent's desk, keep your memory read-only), how to install it on each OS, and what it never does`,
        '',
        '## Install',
        '',
        `- [Install Link](${SITE}/install): the latest release's installer, as a script to run`,
        `- [Your machines](${SITE}/machines): the signed-in Link machine hub (pair, capabilities, online state)`,
        '',
        '```sh',
        page.INSTALL_LINE,
        '```',
        '',
        '## The docs',
        '',
        `- [Install](${page.DOCS}/install.md): every OS, every option, and what the installer does`,
        `- [Your computer for your agents](${page.DOCS}/computer.md): the computer plugin, its levels and the live screen`,
        `- [A machine that runs your jobs](${page.DOCS}/worker.md): the sandbox the job runner uses`,
        `- [The protocol](${page.DOCS}/protocol.md): the wire format between Link and OpenVibe.Bot`,
        `- [Your memory](${page.DOCS}/memory.md): what the collectors read and how it is uploaded`,
        '- [The source on GitHub](https://github.com/OpenVibers/OpenVibe.Link)',
        '',
    ].join('\n');
}

/** This request's cookies as an object (no cookie-parser needed). */
function readCookies(req) {
    const out = {};
    for (const part of String((req.headers && req.headers.cookie) || '').split(';')) {
        const i = part.indexOf('=');
        if (i <= 0) continue;
        const k = part.slice(0, i).trim();
        if (!(k in out)) { try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { out[k] = part.slice(i + 1).trim(); } }
    }
    return out;
}

/** The hub page's session cookies, matching the SDK sign-in on /auth (link/auth.js). */
function setLinkSession(res, accessToken, refreshToken, secure) {
    res.cookie('ov_token', accessToken, { sameSite: 'lax', secure, httpOnly: false, path: '/', maxAge: 24 * 3600e3 });
    if (refreshToken) res.cookie('ov_refresh', refreshToken, { sameSite: 'lax', secure, httpOnly: true, path: '/auth', maxAge: 30 * 24 * 3600e3 });
    res.cookie('ov_sso_hint', 'account', { sameSite: 'lax', secure, httpOnly: false, path: '/', maxAge: 365 * 24 * 3600e3 });
}

/**
 * Link's routes. Returns null for a request that is not for this host, so the router can be mounted early
 * and every other host falls through to Network's own pages. With db, config and publicKey the machines hub
 * signs arrivals in (a handoff ticket, then the silent login); without them it serves the page as before.
 */
function createLinkRoutes({ releaseId, releaseApi = release, db = null, config = null, publicKey = null, log = console } = {}) {
    /** A live link-web session for this request, or null. Never throws. */
    async function linkSession(req) {
        try {
            if (!db || !config || !publicKey) return null;
            const cookies = readCookies(req);
            const token = (req.headers && req.headers.authorization || '').startsWith('Bearer ')
                ? String(req.headers.authorization).slice(7).trim() : cookies.ov_token;
            if (!token) return null;
            const out = await verifySession(token, { db, publicKey, config });
            return out && !out.error ? out.user : null;
        } catch { return null; }
    }

    /** The machines hub arrival: ticket → session, session → hub, nobody → silent sign-in. */
    async function machinesHub(req, res) {
        const noStore = () => res.set('Cache-Control', 'no-store');
        const canSign = !!(db && config && publicKey);
        const userAgent = String((req.headers && req.headers['user-agent']) || '');
        let params;
        try { params = new URL(req.url, SITE).searchParams; } catch { params = new URLSearchParams(); }
        const ticket = params.get('ov_handoff');
        const cookies = readCookies(req);
        const sessionUser = canSign && ['GET', 'HEAD'].includes(req.method) ? await linkSession(req) : null;
        // A ticket from another OpenVibe site (openvibe.my mints one on its way here): redeem it for this
        // host's session and scrub it from the address bar. Never for a browser that already has a session
        // here (no silent account switch), and never for a browser this host signed out (the guest hint).
        if (ticket && /^ovh_[A-Za-z0-9_-]{20,200}$/.test(ticket) && !sessionUser && cookies.ov_sso_hint !== 'guest'
            && canSign && ['GET', 'HEAD'].includes(req.method)) {
            try {
                const { user, scope } = await consumeTicket(db, { ticket, clientId: LINK_CLIENT_ID, redirectUri: LINK_CALLBACK });
                const client = await db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').get(LINK_CLIENT_ID);
                if (!client) throw new Error('the link-web OAuth client is not registered');
                const pair = await issueTokenPair(db, config, req, user, client, {}, scope);
                await recordLinkedService(db, user, client);
                setLinkSession(res, pair.accessToken, pair.refreshToken, config.nodeEnv === 'production');
                params.delete('ov_handoff');
                const clean = `${HUB_PATH}${params.toString() ? `?${params.toString()}` : ''}`;
                return res.redirect(302, clean);
            } catch (err) { (log.warn || log.log || (() => {}))(`[link] handoff arrival failed: ${err && err.message ? err.message : err}`); }
        }
        // Signed in, a crawler, or back from a silent sign-in that found nobody: the hub itself.
        if (sessionUser || BOT_RE.test(userAgent) || params.get('sso') === 'none') {
            noStore();
            return res.sendFile(HUB_PAGE);
        }
        // Nobody home: the silent sign-in (prompt=none) signs a Network-signed-in person in with no click;
        // the login page only shows when they are truly signed out. Pair intent survives in ?pair=1.
        params.delete('ov_handoff');
        const next = `${HUB_PATH}${params.toString() ? `?${params.toString()}` : ''}`;
        noStore();
        return res.redirect(302, `/auth/login?silent=1&next=${encodeURIComponent(next)}`);
    }

    const router = require('express').Router();
    router.use(require('./egress').publicRouter());

    router.use(async (req, res, next) => {
        const host = hostOf(req);
        if (host !== HOST && host !== WWW_HOST) return next();

        const url = new URL(req.url, SITE);
        const path = url.pathname;

        // www is not a second name for Link: every path lands on the apex, and nginx does the same before us.
        if (host === WWW_HOST) return res.redirect(301, `${SITE}${path}${url.search}`);

        // The installer: a stale cached release must never pin an older version while GitHub's metadata
        // API is rate limited. GitHub's latest/download redirect resolves to the newest published asset.
        if (path === '/install') {
            let rel;
            try { rel = await releaseApi.latest(); } catch { rel = release.FALLBACK; }
            const target = rel && !rel.stale && rel.installUrl ? rel.installUrl : release.FALLBACK.installUrl;
            return res.set('Cache-Control', 'public, max-age=600').redirect(302, target);
        }

        if (path === '/add-computer') {
            const returnTo = safeReturnTo(url.searchParams.get('return_to'));
            if (!returnTo) return res.status(400).type('text/plain').send('Choose a return address on an OpenVibe site.');
            return res.set('Cache-Control', 'no-store').redirect(302, `${SITE}/machines?return_to=${encodeURIComponent(returnTo)}`);
        }
        if (path === '/add-computer/complete') {
            const returnTo = safeReturnTo(url.searchParams.get('return_to'));
            const id = url.searchParams.get('machine') || '';
            if (!returnTo || !/^dev_[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) return res.status(400).type('text/plain').send('That computer could not be selected.');
            const target = new URL(returnTo);
            target.searchParams.set('machine', id);
            return res.set('Cache-Control', 'no-store').redirect(303, target.toString());
        }

        // The machine hub lives on Link's own origin. It uses Network's same-origin
        // session and machine API, and keeps the existing roles and pairing controls.
        // Arrival signs in first: a handoff ticket, then the silent login; the login
        // page only shows when the person is truly signed out.
        if (path === '/machines') {
            return machinesHub(req, res).catch(next);
        }
        // Older links name a machine's screen, desks or pairing below /machines (Actor's Watch links, Bot's old
        // pages). The hub is the one page this host has, so they land on it instead of the catch-all's Network 404.
        if (path.startsWith('/machines/')) {
            return res.set('Cache-Control', 'no-store').redirect(301, `${SITE}/machines`);
        }
        // Pairing starts on the hub: /pair lands there with the intent in ?pair=1 (a query survives the
        // sign-in round trip; #pair works too once the page loads). /panel is the old name for the hub.
        if (path === '/pair') {
            return res.set('Cache-Control', 'no-store').redirect(302, `${SITE}/machines?pair=1`);
        }
        if (path === '/panel') {
            return res.set('Cache-Control', 'no-store').redirect(302, `${SITE}/machines`);
        }

        if (path === '/llms.txt') {
            return res.type('text/plain').set('Cache-Control', 'public, max-age=3600').send(llmsTxt());
        }

        // The crawl files of this host, so a crawler on openvibe.link is told about this page and not about
        // Network's (the apex serves its own). IndexNow's key file (when INDEXNOW_KEY is set) is served by the
        // app's global middleware on this host too, so an engine can fetch it at https://openvibe.link/<key>.txt.
        if (path === '/robots.txt') {
            const robots = require('openvibe-shared/seo').robotsTxt({ sitemaps: [`${SITE}/sitemap.xml`] });
            return res.type('text/plain').set('Cache-Control', 'public, max-age=3600').send(robots);
        }
        if (path === '/sitemap.xml') {
            const xml = require('openvibe-shared/seo').sitemapXml([{ loc: `${SITE}/`, changefreq: 'weekly', priority: 1.0 }]);
            return res.type('application/xml').set('Cache-Control', 'public, max-age=3600').send(xml);
        }

        if (path === '/locker.mjs' && (req.method === 'GET' || req.method === 'HEAD')) {
            let source;
            try { source = fs.readFileSync(pathResolveLocker(), 'utf8'); }
            catch { return res.status(503).type('text/plain').send('Locker is not available right now.'); }
            res.set({ 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=86400',
                'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff' });
            return res.end(req.method === 'HEAD' ? undefined : source);
        }
        // The page's two scripts, from this folder: send.js and egress-settings.js. The second had no route, so
        // openvibe.link/egress-settings.js fell through to the host's 301 onto openvibe.network, where it 404s and its
        // same-origin resource policy blocks it (found 11-09): the egress form never got its script.
        if ((path === '/send.js' || path === '/egress-settings.js') && (req.method === 'GET' || req.method === 'HEAD')) {
            const source = fs.readFileSync(pathLib.join(__dirname, path.slice(1)), 'utf8');
            res.set({ 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=600', 'X-Content-Type-Options': 'nosniff' });
            return res.end(req.method === 'HEAD' ? undefined : source);
        }

        if (path !== '/' && path !== '/index.md' && path !== '/index.html') return next();

        const isTwin = path === '/index.md' || url.searchParams.get('format') === 'markdown'
            || (req.headers.accept && req.accepts(['html', 'text/markdown']) === 'text/markdown');
        let rel;
        try { rel = await releaseApi.latest(); } catch { rel = release.FALLBACK; }
        const html = page.render({ release: rel, releaseId, userAgent: req.headers && req.headers['user-agent'] });
        const canonical = `${SITE}/`;
        const links = linkHeaderTags(canonical, `${SITE}/llms.txt`);
        res.setHeader('Link', [res.getHeader('Link'), links.header].filter(Boolean).join(', '));
        res.setHeader('Vary', [res.getHeader('Vary'), 'Accept'].filter(Boolean).join(', '));
        res.setHeader('Cache-Control', 'public, max-age=600');
        if (isTwin) {
            res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
            return res.end(req.method === 'HEAD' ? undefined : markdownTwin({ html, title: 'OpenVibe Link: your machines, connected', canonical }));
        }
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.end(req.method === 'HEAD' ? undefined : html);
    });

    return router;
}

function pathResolveLocker() {
    return pathLib.join(pathLib.dirname(require.resolve('openvibe-sdk')), 'browser', 'openvibe-sdk.mjs');
}

module.exports = { createLinkRoutes, llmsTxt, hostOf, safeReturnTo, HOST, WWW_HOST, SITE };
