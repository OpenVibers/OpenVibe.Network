'use strict';
// Every host Network serves gives the shared navbar one list, on every page (the owner, 2026-11-12: the phone
// screenshot of openvibe.link showed "Pages on OpenVibe.Link: Home, My Account, Themes" — Network's fallback list,
// not Link's pages). The home row is the site's own name; a door to another site is labelled with that site's name.
//   node test/page-links.test.js
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { bootServer } = require('./helpers/boot-server');
const pageLinks = require('../server/frame/page-links');
const { ACCOUNT_HUB_PATHS } = require('../server/not-found');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/** The links array in a page's OpenVibeNavbar.init(...) call, or null when the init lives in a client script. */
function initLinks(html) {
    const at = html.indexOf('OpenVibeNavbar.init');
    if (at < 0) return null;
    const brace = html.indexOf('{', at);
    if (brace < 0) return null;
    let depth = 0, q = null, esc = false, end = -1;
    for (let i = brace; i < html.length && end < 0; i += 1) {
        const c = html[i];
        if (q) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === q) q = null; continue; }
        if (c === '"' || c === "'" || c === '`') { q = c; continue; }
        if (c === '{') depth += 1; else if (c === '}') { depth -= 1; if (!depth) end = i; }
    }
    if (end < 0) return null;
    const args = html.slice(brace, end + 1);
    const m = /(['"]?)links\1\s*:\s*(\[)/.exec(args);
    if (!m) return null;
    const start = brace + m.index + m[0].lastIndexOf('[');
    depth = 0; q = null; esc = false;
    for (let i = start; i < html.length; i += 1) {
        const c = html[i];
        if (q) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === q) q = null; continue; }
        if (c === '"' || c === "'" || c === '`') { q = c; continue; }
        if (c === '[') depth += 1; else if (c === ']') { depth -= 1; if (!depth) return JSON.parse(html.slice(start, i + 1)); }
    }
    return null;
}

(async () => {
    // ── The lists themselves: the home row names the site, and each row is unique. ──
    for (const [host, list, home] of [['openvibe.network', pageLinks.NETWORK, 'Network'], ['openvibe.link', pageLinks.LINK, 'Link'], ['openvibe.my', pageLinks.MY, 'My Account']]) {
        assert.strictEqual(pageLinks.forHost(host), list, `${host} has its own list`);
        assert.ok(list.length >= 3, `${host} lists its pages`);
        assert.strictEqual(list[0].label, home, `${host}'s home row is the site's name, never "Home"`);
        assert.strictEqual(list[0].href, '/', `${host}'s home row is its front door`);
        assert.strictEqual(new Set(list.map((l) => l.label)).size, list.length, `${host} has no repeated label`);
        assert.ok(!list.some((l) => l.label === 'Home'), `${host} never calls its own home "Home"`);
    }
    assert.strictEqual(pageLinks.forHost('www.openvibe.link'), pageLinks.LINK, 'www uses the same list');
    assert.strictEqual(pageLinks.forHost('openvibe.network'), pageLinks.NETWORK, 'every other host is Network\'s');

    // The hub's client-routed sections are the router's paths, not links it would 404.
    for (const p of pageLinks.MY.filter((l) => l.href.startsWith('/')).map((l) => l.href)) {
        assert.ok(p === '/' || ACCOUNT_HUB_PATHS.includes(p), `openvibe.my knows ${p}`);
    }

    // Pages whose navbar is started from a client script carry the same list, byte for byte.
    for (const [file, list] of [
        ['public/index.html', pageLinks.NETWORK], ['public/verify-email.html', pageLinks.NETWORK],
        ['public/js/admin/boot.js', pageLinks.NETWORK], ['public/js/wallet/common.js', pageLinks.NETWORK],
        ['public/js/my/profile.js', pageLinks.NETWORK], ['public/js/my/profile.js', pageLinks.LINK], ['public/js/my/profile.js', pageLinks.MY],
    ]) assert.ok(read(file).includes(JSON.stringify(list)), `${file} sends the ${list[0].label} list`);

    const srv = await bootServer();
    const port = new URL(srv.base).port;
    const get = (p, host) => new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', headers: { host } }, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        });
        req.on('error', reject);
        req.end();
    });
    try {
        // Every server-rendered page of a host sends that host's list, and every same-host row answers (not 404).
        const pages = {
            'openvibe.network': ['/', '/stats', '/updates', '/sites', '/bot', '/terms', '/privacy', '/dmca', '/no-such-page'],
            'openvibe.link': ['/', '/no-such-page'],
            'openvibe.my': ['/no-such-page'],
        };
        for (const [host, paths] of Object.entries(pages)) {
            for (const p of paths) {
                const r = await get(p, host);
                assert.ok([200, 404].includes(r.status), `${host}${p} answered ${r.status}`);
                const links = initLinks(r.body);
                assert.deepStrictEqual(links, pageLinks.forHost(host), `${host}${p} sends ${pageLinks.forHost(host)[0].label}'s list`);
            }
            for (const l of pageLinks.forHost(host)) {
                if (!l.href.startsWith('/')) continue;
                const r = await get(l.href, host);
                assert.notStrictEqual(r.status, 404, `${host}${l.href} is a route of this host`);
                assert.ok(r.status < 500, `${host}${l.href} does not fail (${r.status})`);
            }
        }
        console.log('page links: Network, Link and My send their own list on every page');
    } catch (err) {
        console.error(srv.logs());
        throw err;
    } finally {
        await srv.stop();
    }
})().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
