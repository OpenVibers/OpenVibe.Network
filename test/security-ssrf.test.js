'use strict';
// SSRF (roadmap WS-R task 5). Where Network fetches a URL a person chose, the address must be public.
//   1. Web push: a subscription's endpoint comes from the browser, so anyone signed in chose where
//      Network POSTs. Every internal spelling is refused at subscribe (loopback, RFC1918, CGNAT,
//      169.254.169.254, ::1, ::, ::ffff:127.0.0.1, ::ffff:7f00:1, fc00::/7, fe80::, NAT64
//      64:ff9b::7f00:1, 6to4 2002:7f00:1::, decimal, octal and hex IPv4, 0.0.0.0, trailing dots,
//      internal names, credentials in the URL, plain http), and at send time rows stored before the
//      rule are skipped and names resolve through openvibe-shared/egress's safeLookup: a name answering
//      loopback, a mixed answer and a rebinding name never reach an internal address (dns.lookup is
//      stubbed before the guard loads; a local listener counts connections).
//   2. Avatars: only openvibe.media addresses are fetched by Network itself (normalizeAvatar); a picture
//      from anywhere else goes to Media's ingest (which fetches safely), never to its own address.
//   3. With the real server booted (every TCP connect it makes is logged by the preload): avatar
//      imports of internal URLs, a developer app's redirect URIs, OAuth authorize with them and push
//      subscriptions to internal endpoints make no connection to the named address; the GitHub
//      integration test goes to api.github.com only.
//   4. A ratchet over server/: every outbound call site (fetch, http(s).request/get, WebSocket, axios,
//      got, undici, net/tls connect, web-push, discord.js login, the events SDK client), comments
//      stripped, is listed below with why its destination is not a stranger's choice (or how it is
//      guarded). A new or unlisted one fails until it is reviewed here.
//   Skipped by design: the sign-in `next` redirect (test/security-redirects.test.js covers it).
//   node test/security-ssrf.test.js
const assert = require('assert');
const dns = require('dns');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

// ── DNS stub, before anything loads openvibe-shared/egress ──────────────
const PUBLIC = '93.184.216.34';
let rebindCalls = 0;
const ANSWERS = {
    'loop.example.com': () => [{ address: '127.0.0.1', family: 4 }],
    'v6loop.example.com': () => [{ address: '::ffff:127.0.0.1', family: 6 }],
    'meta.example.com': () => [{ address: '169.254.169.254', family: 4 }],
    'mixed.example.com': () => [{ address: PUBLIC, family: 4 }, { address: '127.0.0.1', family: 4 }],
    'rebind.example.com': () => (rebindCalls++ === 0 ? [{ address: PUBLIC, family: 4 }] : [{ address: '127.0.0.1', family: 4 }]),
    'pub.example.com': () => [{ address: PUBLIC, family: 4 }],
};
const realLookup = dns.lookup;
dns.lookup = function (host, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    const f = ANSWERS[String(host).toLowerCase().replace(/\.$/, '')];
    if (!f) return realLookup.call(dns, host, opts, cb);
    const all = f();
    process.nextTick(() => (opts && opts.all ? cb(null, all) : cb(null, all[0].address, all[0].family)));
};
// No traffic off the machine. Every TCP connect is recorded: an IP literal as 'address port'; a name
// as 'name→address port' once its lookup (the caller's own, e.g. safeLookup, else dns.lookup) answered,
// or 'name denied' when that lookup refused it. Only loopback is actually connected to.
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const connects = [];
const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
    let o = args[0];
    if (Array.isArray(o)) o = o[0];
    if (!o || typeof o !== 'object') o = { port: args[0], host: typeof args[1] === 'string' ? args[1] : 'localhost' };
    if (o.path) return realConnect.apply(this, args);
    const host = String(o.host || 'localhost').replace(/^\[|\]$/g, '');
    if (!net.isIP(host) && host !== 'localhost') {
        const inner = o.lookup || dns.lookup;
        o.lookup = (h, opts, cb) => inner(h, opts, (err, addr, fam) => {
            if (err) { connects.push(`${h} denied`); return cb(err); }
            const first = Array.isArray(addr) ? addr[0].address : addr;
            connects.push(`${h}→${first} ${o.port}`);
            if (LOOPBACK.has(first)) return cb(null, addr, fam);
            return cb(Object.assign(new Error(`test: no egress to ${first}`), { code: 'ECONNREFUSED' }));
        });
        if (Array.isArray(args[0])) args[0][0] = o; else args[0] = o;
        return realConnect.apply(this, args);
    }
    connects.push(`${host} ${o.port}`);
    if (LOOPBACK.has(host) || host === 'localhost') return realConnect.apply(this, args);
    process.nextTick(() => this.destroy(Object.assign(new Error(`test: no egress to ${host}`), { code: 'ECONNREFUSED' })));
    return this;
};

const { getDb } = require('../server/db/database');
const push = require('../server/push/push-service');
const { normalizeAvatar } = require('../server/profile/avatar');
const { buildWorld } = require('./security-world');

const out = (...a) => process.stdout.write(a.join(' ') + '\n');

/** A loopback listener that counts connections (it never answers TLS). */
async function counter() {
    let n = 0;
    const s = net.createServer((sock) => { n++; sock.destroy(); });
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    return { port: s.address().port, count: () => n, close: () => new Promise((r) => s.close(r)) };
}

/** Every internal spelling of a host, as https URLs to `port`. */
function internalUrls(port, pathPart = '/x') {
    const hosts = ['127.0.0.1', '127.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '100.64.0.1', '169.254.169.254', '0.0.0.0', '[::1]', '[::]',
        '[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '[fc00::1]', '[fd12:3456::1]', '[fe80::1]', '[64:ff9b::7f00:1]', '[2002:7f00:1::]',
        '2130706433', '0177.0.0.1', '0x7f000001', '0x7f.0.0.1', 'localhost', 'localhost.', 'foo.localhost', 'printer.local', 'db.internal', 'router.home.arpa', 'intranet',
        '127.0.0.1.', '[::ffff:a9fe:a9fe]', '[::ffff:169.254.169.254]'];
    return [...hosts.map((h) => `https://${h}:${port}${pathPart}`),
        `https://user:pass@push.example.com:${port}${pathPart}`, `https://push.example.com@127.0.0.1:${port}${pathPart}`,
        `http://push.example.com:${port}${pathPart}`, `http://127.0.0.1:${port}${pathPart}`, `ftp://push.example.com${pathPart}`, `file:///etc/passwd`, 'javascript:alert(1)'];
}

/** Outbound call sites in server/: 'file kind' → how many. */
const PATTERNS = {
    fetch: /\bfetch(?:Impl)?\s*\(/g, 'http.request': /\bhttps?\.(?:request|get)\s*\(/g, websocket: /\bnew\s+WebSocket\s*\(/g, axios: /\baxios\b/g,
    got: /require\(\s*['"]got['"]\s*\)/g, undici: /\bundici\b/g, 'net.connect': /\b(?:net|tls)\.(?:connect|createConnection)\s*\(/g,
    'web-push': /\bsendNotification\s*\(/g, 'discord.js': /\.login\s*\(/g, 'sdk client': /\bcreate(?:Events)?Client\s*\(/g,
};
// The reviewed list: where each goes, and why a stranger cannot choose it (or how it is guarded).
const REVIEWED = {
    'server/admin/tools-workers.js fetch': [1, 'Owner-only fixed Tools admin paths at the operator-configured internal URL; no caller URL; redirects refused.'],
    'server/link/egress-settings.js fetch': [2, 'browser-only GET and PUT to the fixed same-origin /api/v1/me/nodes/egress settings route; no caller-chosen host or URL'],
    'server/connect/egress.js http.request': [1, 'Connect gateway (E7): only the app definition\'s fixed API host, through openvibe-shared/egress (IP literals refused before the socket, public DNS answers only, redirects followed by hand with every hop re-checked); never a URL from the input (Opus review 11-06)'],
    'server/home/activity.js fetch': [1, 'front door activity: fixed first-party loopback URLs (OV_LIVE/COMMUNITY/BLOG_INTERNAL_URL, operator config) for public lists, never a request value'],
    'server/home/popular.js fetch': [2, 'Report public popularity and co-usage: the operator-configured first-party Report URL (OV_REPORT_INTERNAL_URL), a fixed loopback origin, never a request value'],
    'server/composer/routes.js fetch': [2, 'mention search: the operator-configured OpenVibe.Git internal URL (config.services.git) with a fixed /api/v1/repos path and the query percent-encoded; no caller-chosen host, 2.5 s timeout, and no token or body is sent with it'],
    'server/frame/today.js fetch': [1, 'Report internal URL from operator config, fixed /api/v1/stats?days=30 path, five-second timeout; no request-selected URL'],
    'server/admin/analytics-routes.js fetch': [2, 'staff analytics: the services\' internal URLs from the registry (owner/admin set), and Insights\' Prometheus (PROMETHEUS_URL, loopback by default) with fixed queries; never a request value'],
    'server/admin/events-ops.js fetch': [1, 'OV_EVENTS_INTERNAL_URL (operator config) for staff DLQ views'],
    'server/admin/routes.js fetch': [1, 'registry refresh: POSTs to the service refresh targets resolved from the registry (admin-set service URLs, staff only)'],
    'server/auth/discord-link.js fetch': [2, 'fixed Discord API host (discord.com/api)'],
    'server/developer/event-relay.js sdk client': [4, 'OV_EVENTS_INTERNAL_URL (operator config)'],
    'server/discord/discord-service.js fetch': [2, 'discord.js channels.fetch: Discord API only'],
    'server/discord/discord-service.js discord.js': [1, 'discord.js login: Discord gateway only'],
    'server/domains/catalog.js fetch': [3, 'the tools catalog URL from operator config'],
    'server/today/live-follows.js fetch': [1, 'Live\'s internal URL from config (OV_LIVE_INTERNAL_URL): its public list of live streams, fixed path, 2.5 s timeout, held 10 s; never a request value'],
    'server/money/reasons.js fetch': [1, 'Quest\'s public catalog URL from operator config (QUESTS_URL, default https://openvibe.quest): the fixed /api/v1/quests path, 2.5 s timeout, held 10 minutes; it only names a quest id already in a ledger reason, and no request value names a host'],
    'server/coins/routes.js fetch': [1, 'Billing internal URL from config (the person\'s Vibes with their own token, 2 s timeout)'],
    'server/today/receipts.js fetch': [1, 'Mail\'s internal URL from config (OV_MAIL_INTERNAL_URL, loopback 5250): the person\'s own token to the fixed path /api/v1/me/mail/receipts, 2.5 s timeout; never a request value names a host'],
    'server/wallet/routes.js fetch': [2, 'Billing internal URL from config (OV_BILLING_INTERNAL_URL, loopback 4600) only: the person\'s own token for /api/me/activity and every /api/me read and write, and — only while /api/me/activity is missing — the marked temporary journal fallback, a billing.balance.read service read scoped to the signed-in person\'s own usr_ id; the paths are fixed, a charge id must be a vch_ ULID and is percent-encoded, and no request value ever names a host. The second call site is Network\'s own loopback (config.internalUrl, else 127.0.0.1:<port>): the fixed path POST /internal/subject-assertions, which signs the person\'s own token into a 60-second subject assertion; the person\'s token is in the body, never in the URL, and no request value names a host'],
    'server/frame/service.js fetch': [7, 'The composer\'s pictures and posts go to OpenVibe.Community\'s fixed paths (POST /api/v1/spaces/status/attachments, POST /api/v1/posts) on its internal URL. Live and AI internal URLs from config (navbar ranking copy); https://<open site host>/privacy, hosts from the site registry only, no redirects, 5 s (legal links); Community internal URL from config for the menu composer relay (POST /api/frame/status, fixed path, the person\'s Bearer only); Billing and Inventory internal URLs from config for the wallet relays (/api/frame/wallet/…, fixed paths, a usr_/itd_ id must match its pattern, the person\'s Bearer only, no redirects, 8 s); Codes and Actor internal URLs from config for the Dock relays (/api/frame/agent-view…, /agent/timeline, /agent/approvals/…, /agent/kill-switch, /tasks/…, /actor…, fixed paths, product and id matched against patterns and percent-encoded, the person\'s Bearer only, no cookie, no redirects, 15 s)'],
    'server/frame/menu-cards.js fetch': [2, 'https://<open site host>/.well-known/openvibe-menu.json, hosts from the site registry only, no redirects, 5 s, 64 KB (menu cards)'],
    'server/stats/open.js fetch': [1, 'open stats (/stats): fixed first-party loopback URLs only — Live (OV_LIVE_INTERNAL_URL, its public home numbers and service-token analytics totals) and Prometheus (PROMETHEUS_URL, loopback by default) with fixed queries; the request only picks 7, 30 or 90 days'],
    'server/admin/service-proxies.js fetch': [1, 'the admin panel proxies: Live\'s and Chat\'s internal URLs from config, fixed path prefixes, staff only'],
    'server/admin/review-queue.js fetch': [2, 'the reviewer queue: Wiki/Blog/News/Trade internal URLs from operator config (loopback defaults), fixed /api/v1/review-queue and review paths, ids percent-encoded, the signed-in staff member\'s own token, staff only'],
    'server/admin/ai-config-proxy.js fetch': [1, 'the owner settings proxy and the Setup tab (server/admin/setup.js calls through it): the reachable services\' internal URLs from config.services (operator-set, loopback defaults), fixed /internal/config and AI /api/v1/providers paths, service, namespace and key checked against the known names, owner only'],
    'server/integrations/github.js fetch': [1, 'fixed host api.github.com (asserted below)'],
    'server/link/send.js fetch': [8, 'browser-only Link Send requests to fixed same-origin routes (the session read, machine keys, the resumable transfer parts and the delivery list); page input supplies file bytes, never a URL or destination host'],
    'server/notifications/email-service.js http.request': [1, 'fixed host api.resend.com'],
    'server/actions/index.js fetch': [7, 'The Action Center: OpenVibe.Actor, OpenVibe.Codes and OpenVibe.AI only (OV_ACTOR_INTERNAL_URL, OV_CODES_INTERNAL_URL, OV_AI_INTERNAL_URL, loopback); the paths are fixed (the decide route, the cancel route, the retry route of Actor or AI, Actor\'s public GET /api/v1/skills catalogue, and Actor\'s POST /api/v1/runs for a catalogue skill whose id must match the skill id pattern), the subject is the signed-in person\'s own usr_ id, and an item id must match [A-Za-z0-9_-]{1,80}'],
    'server/profile/card.js fetch': [2, 'Operator-configured Quest and Live bases only, fixed paths with encoded canonical identities, no redirects, two second timeout'],
    'server/profile/public.js fetch': [6, 'OpenVibe.Inventory, Quest and Play use operator-configured internal URLs and fixed paths with a checked usr_ id. Public place reads use only the configured Live, Community and Space service URLs, fixed public paths, encoded canonical usernames, 2 s timeouts and no user-supplied host or token; Space results are restricted to the exact owner and Published cards'],
    'server/profile/avatar.js fetch': [4, 'Live (push) and Media (ingest, release) internal URLs from config; a picture is never fetched here — Media\'s ingest fetches it (asserted below)'],
    'server/push/push-service.js web-push': [1, 'a person\'s push endpoint: endpointAllowed() at subscribe and send, connections through safeLookup (asserted below)'],
    'server/registry/deploy-drift.js fetch': [2, 'fixed hosts: api.github.com (compare) and github.com (git ls-refs); the repository matches REPO_RE (OpenVibers/ only)'],
    'server/registry/ecosystem.js fetch': [2, 'service URLs from openvibe-contracts manifests and operator env overrides'],
    'server/registry/library-tags.js fetch': [1, 'fixed host api.github.com'],
    'server/link/release.js fetch': [2, 'the Node\'s own release page: fixed hosts only — https://github.com/OpenVibers/OpenVibe.Link.git/git-upload-pack (ls-refs of refs/tags/v, no REST call) and the fixed GitHub API path (https://api.github.com/repos/OpenVibers/OpenVibe.Link/releases/latest), each with an 8 s timeout; the REST answer is held 15 minutes in memory and on disk and read only when a new tag exists; no request value ever names a host and it only ever reads the public release list'],
    'server/registry/machines.js fetch': [1, 'the machines hub calls Bot: the internal URL from operator config (OV_BOT_INTERNAL_URL, loopback by default), the paths are fixed, the machine id is a checked dev_ id (percent-encoded) and the person is named in a header, never in the URL'],
    'server/presence/index.js fetch': [2, "Live and Chat internal URLs from operator config (loopback defaults): Live's public /api/streams (fixed path, 2 s timeout, held 30 s) and Chat's POST /internal/chat/dm/peers (fixed path, 1.5 s, the subject list in the body); never a request value names a host"],
    'server/updates/routes.js fetch': [1, 'OV_BLOG_INTERNAL_URL (operator config)'],
};

/** JS source with comments blanked (strings, template literals and regex literals kept). */
function stripComments(src) {
    let o = '';
    let i = 0;
    let prev = '';
    const n = src.length;
    while (i < n) {
        const c = src[i];
        const d = src[i + 1];
        if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') { o += ' '; i++; } continue; }
        if (c === '/' && d === '*') { const end = src.indexOf('*/', i + 2); const stop = end < 0 ? n : end + 2; o += src.slice(i, stop).replace(/[^\n]/g, ' '); i = stop; continue; }
        if (c === '\'' || c === '"' || c === '`') {
            let j = i + 1;
            while (j < n && src[j] !== c) { if (src[j] === '\\') j++; j++; }
            o += src.slice(i, j + 1); i = j + 1; prev = c; continue;
        }
        if (c === '/' && (prev === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prev))) {
            let j = i + 1; let cls = false;
            while (j < n && src[j] !== '\n') { if (src[j] === '\\') { j += 2; continue; } if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false; else if (src[j] === '/' && !cls) break; j++; }
            o += src.slice(i, j + 1); i = j + 1; prev = '/'; continue;
        }
        o += c;
        if (!/\s/.test(c)) prev = c;
        i++;
    }
    return o;
}

function inventory(root) {
    const found = {};
    const walk = (d) => {
        for (const f of fs.readdirSync(d)) {
            const p = path.join(d, f);
            if (fs.statSync(p).isDirectory()) { walk(p); continue; }
            if (!p.endsWith('.js')) continue;
            const src = stripComments(fs.readFileSync(p, 'utf8'));
            for (const [kind, re] of Object.entries(PATTERNS)) {
                const k = (src.match(re) || []).length;
                if (k) found[`${path.relative(root, p).split(path.sep).join('/')} ${kind}`] = k;
            }
        }
    };
    walk(path.join(root, 'server'));
    return found;
}

(async () => {
    const t0 = Date.now();

    // ── 4. Ratchet ───────────────────────────────────────────────────
    assert.strictEqual(stripComments("const a = '/* not a comment */'; // fetch(x)\n/* fetch(y) */ fetch(z); const r = /\\/\\*/;").match(PATTERNS.fetch).length, 1, 'the stripper keeps strings and drops comments');
    const inv = inventory(path.join(__dirname, '..'));
    const unreviewed = Object.entries(inv).filter(([k, n]) => !REVIEWED[k] || REVIEWED[k][0] !== n).map(([k, n]) => `${k}: ${n} call site(s)${REVIEWED[k] ? ` (reviewed: ${REVIEWED[k][0]})` : ' (not reviewed)'}`);
    assert.deepStrictEqual(unreviewed, [], `outbound call sites changed; review each and update REVIEWED in this file:\n${unreviewed.join('\n')}`);
    const gone = Object.keys(REVIEWED).filter((k) => !inv[k]);
    assert.deepStrictEqual(gone, [], `reviewed call sites no longer exist; drop them from REVIEWED:\n${gone.join('\n')}`);

    // ── 1. Web push ──────────────────────────────────────────────────
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-ssrf-'));
    const log = console.log; console.log = () => {};
    const db = await getDb();
    await push.initVapid(db);
    console.log = log;
    await db.prepare("INSERT INTO users (id, username, password_hash) VALUES (7, 'pushy', 'x')").run();
    const listener = await counter();
    const P = listener.port;
    const keys = { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' };
    const refusedAtSubscribe = [];
    for (const endpoint of internalUrls(P)) {
        try { await push.subscribe(7, { endpoint, keys }); refusedAtSubscribe.push(`accepted ${endpoint}`); } catch (e) { assert.match(e.message, /Invalid push subscription/); }
    }
    assert.deepStrictEqual(refusedAtSubscribe, [], 'every internal endpoint is refused at subscribe');
    await push.subscribe(7, { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys });   // a real push service is fine
    await push.subscribe(7, { endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/abc', keys });
    assert.strictEqual((await db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = 7').get()).n, 2);
    await db.prepare('DELETE FROM push_subscriptions').run();
    // Rows stored before the rule, and names that resolve inward at send time.
    const rows = [`https://127.0.0.1:${P}/x`, `https://[::ffff:127.0.0.1]:${P}/x`, `https://2130706433:${P}/x`, `https://localhost:${P}/x`,
        `https://loop.example.com:${P}/x`, `https://loop.example.com.:${P}/x`, `https://v6loop.example.com:${P}/x`, `https://meta.example.com:${P}/x`, `https://mixed.example.com:${P}/x`,
        `https://rebind.example.com:${P}/x`, `https://pub.example.com:${P}/x`];
    const ins = db.prepare('INSERT INTO push_subscriptions (user_id, endpoint, keys_p256dh, keys_auth) VALUES (7, ?, ?, ?)');
    for (const e of rows) await ins.run(e, keys.p256dh, keys.auth);
    connects.length = 0;
    await push.sendPush(7, { title: 't', message: 'm' });
    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(listener.count(), 0, `no push reached the loopback listener (connects: ${connects.join(', ')})`);
    for (const name of ['loop.example.com', 'loop.example.com.', 'v6loop.example.com', 'meta.example.com', 'mixed.example.com']) {
        assert.ok(connects.includes(`${name} denied`), `${name}: refused where the connection is made (${connects.join(', ')})`);
    }
    assert.ok(connects.includes(`rebind.example.com→${PUBLIC} ${P}`), 'a rebinding name: the socket connects to the address that was checked');
    assert.ok(connects.includes(`pub.example.com→${PUBLIC} ${P}`), 'public names are still pushed to (positive control)');
    assert.deepStrictEqual(connects.filter((c) => !c.endsWith(' denied') && !c.includes(`→${PUBLIC} `)), [], 'no connection to any internal address');
    const left = (await db.prepare('SELECT endpoint FROM push_subscriptions').all()).map((r) => r.endpoint);
    assert.ok(!left.some((e) => /127\.0\.0\.1|\[::ffff|2130706433|localhost/.test(e)), 'rows with an internal address are dropped');
    await listener.close();

    // ── 2. Avatars: Network itself never fetches a picture (Media's ingest does) ─────────
    // An accepted source is handed to Media; what must not happen is a look-alike or internal address being
    // rewritten onto our own media host, which Network used to fetch. (Part 3 proves no connection is made.)
    const hostOf = (x) => { try { return new URL(x).hostname.toLowerCase(); } catch { return null; } };
    for (const u of [...internalUrls(8443, '/a.png'), 'https://openvibe.media@127.0.0.1/a.png', 'https://openvibe.media.evil.test/a.png', 'https://127.0.0.1/p/abc/screenshot', 'https://[::1]/p/abc']) {
        const n = normalizeAvatar(u);
        assert.ok(!n.url || hostOf(u) === 'openvibe.media' || hostOf(n.url) !== 'openvibe.media', `${u}: not rewritten to openvibe.media (${JSON.stringify(n)})`);
    }

    // ── 3. The booted server ─────────────────────────────────────────
    // Media's ingest, stubbed: it records what Network asked it to import (Media does the fetching).
    const http = require('http');
    const ingested = [];
    const media = http.createServer((req, res) => {
        let b = ''; req.on('data', (d) => { b += d; });
        req.on('end', () => { try { const j = JSON.parse(b); ingested.push({ path: req.url, url: j.url, subject: j.subject }); } catch { /* */ } res.writeHead(422, { 'content-type': 'application/json' }).end('{"ok":false,"error":"refused"}'); });
    });
    await new Promise((r) => media.listen(0, '127.0.0.1', r));
    const w = await buildWorld({ label: 'ssrf', env: { OV_MEDIA_INTERNAL_URL: `http://127.0.0.1:${media.address().port}` } });
    const target = await counter();
    try {
        const T = target.port;
        const before = w.connects().length;
        for (const u of internalUrls(T, '/a.png').slice(0, 20)) await w.call('alice', 'PUT', '/api/profile/avatar', { source: u });
        const app = await w.call('alice', 'PATCH', `/api/v1/projects/${w.dev.PA.id}/apps/${w.dev.PA.app}`, { redirect_uris: [`https://127.0.0.1:${T}/cb`, `http://localhost:${T}/cb`] });
        assert.ok(app.status < 500, `redirect URIs are validated, not fetched (${app.status})`);
        for (const ru of [`https://127.0.0.1:${T}/cb`, `http://localhost:${T}/cb`]) {
            await w.call('alice', 'GET', `/oauth/authorize?client_id=${w.dev.PA.app}&redirect_uri=${encodeURIComponent(ru)}&response_type=code&code_challenge=${'a'.repeat(43)}&code_challenge_method=S256`);
            await w.call(null, 'POST', '/oauth/confirm', { token: w.users.alice.token, client_id: w.dev.PA.app, redirect_uri: ru });
        }
        for (const e of internalUrls(T).slice(0, 12)) {
            const r = await w.call('alice', 'POST', '/api/push/subscribe', { subscription: { endpoint: e, keys } });
            assert.strictEqual(r.status, 400, `push subscribe refuses ${e}`);
        }
        const gh = await w.call(w.callers.owner, 'POST', '/api/admin/integrations/github/test', {});
        assert.ok(gh.status < 500 || gh.status === 502, `github test answered (${gh.status})`);
        await new Promise((r) => setTimeout(r, 500));
        const made = w.connects().slice(before);
        assert.strictEqual(target.count(), 0, 'nothing connected to the address a person named');
        assert.deepStrictEqual(made.filter((c) => c.endsWith(` ${T}`)), [], 'no connection to the chosen port at all');
        const hosts = new Set(made.map((c) => c.split(' ')[0]));
        // The menu-cards fetcher (server/frame/menu-cards.js, reviewed above) reads every open site's fixed
        // https://<site host>/.well-known/openvibe-menu.json on a five-minute timer, so whether it runs during this test
        // is timing. The hosts it may reach are exactly the open sites' hosts in server/frame/sites.js (openvibe.live,
        // openre.stream, ...), never a value a person named; anything else, a look-alike included, is unexpected.
        const SITE_HOSTS = new Set(require('../server/frame/sites').SITES.filter((s) => s.status === 'open').map((s) => s.host));
        for (const h of hosts) assert.ok(['127.0.0.1', 'discord.com', 'gateway.discord.gg', 'api.github.com'].includes(h) || SITE_HOSTS.has(h), `unexpected destination ${h}`);
        assert.match(gh.text, /no egress to api\.github\.com|could not be reached/, 'the GitHub integration test goes to api.github.com only (the egress guard refuses the socket; undici surfaces it as a fetch failure)');
        assert.ok(ingested.length >= 10 && ingested.every((x) => x.path === '/internal/avatar-ingest'), `avatar imports went to Media's ingest instead (${ingested.length})`);
        assert.ok(ingested.some((x) => x.url === `https://127.0.0.1:${T}/a.png`), 'Media was asked to import the URL; Network did not fetch it');
        assert.ok(ingested.every((x) => x.subject === w.users.alice.subject), 'the import names its owner by subject, so Media records it on the object');
    } finally {
        await target.close();
        await new Promise((r) => media.close(r));
        await w.stop();
        fs.rmSync(dir, { recursive: true, force: true });
    }
    out(`security ssrf: ${Object.keys(inv).length} reviewed call sites, all checks passed (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
})().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
