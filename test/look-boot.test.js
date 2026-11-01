'use strict';
// The look before first paint (openvibe-shared 4.64.0 look-boot, plan L42; the owner, 10-31: seasonal turned off
// on Network was still on, and orange, until the deferred theme-loader.js caught up). Every page that carried the
// old ov_theme bootstrap now paints the look this browser last painted here (ov_paint), or the one a link from
// another OpenVibe page carried (?ov_look=), before its first stylesheet: once, and the marker never reaches a page.
// A browser from before look-boot (its theme only) is painted once from that theme, colours only.
//   node test/look-boot.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootServer } = require('./helpers/boot-server');
const { BOOT } = require('openvibe-shared/look-boot');
const { MARK } = require('../server/look-boot');

const PAGES = [
    ['/', 'the home page'],
    ['/my', 'the account hub'],
    ['/admin', 'the admin panel'],
    ['/verify-email', 'the email verification page'],
    ['/sso/fanout', 'the sign-out fanout'],
];

(async () => {
    const srv = await bootServer();
    try {
        for (const [path, name] of PAGES) {
            const r = await fetch(srv.base + path);
            assert.strictEqual(r.status, 200, `${path} (${name}) answers 200`);
            const html = await r.text();
            assert.ok(!html.includes(MARK), `${path}: the marker never reaches the page`);
            assert.strictEqual(html.split(BOOT).length, 2, `${path}: look-boot once`);
            const at = html.indexOf(BOOT);
            // A linked sheet or an inline <style>: /verify-email has only its own (its one link was Font Awesome's, L54 K4).
            const firstSheet = html.search(/<link[^>]+rel="stylesheet"|<style\b/);
            assert.ok(at > 0 && firstSheet > 0 && at < firstSheet, `${path}: it paints before any stylesheet`);
            // The one-time fallback for a browser from before look-boot: its theme only, colours only.
            const legacy = html.slice(at, firstSheet);
            assert.match(legacy, /if \(localStorage\.getItem\('ov_paint'\)\) return;/, `${path}: the fallback waits for a painted look`);
            assert.match(legacy, /!\/url\|expression\/i\.test/, `${path}: the fallback takes colours only`);
        }
        // No public page keeps the old bootstrap (it painted the theme only, so the season stayed on until the loader ran).
        const pub = path.join(__dirname, '..', 'public');
        for (const name of fs.readdirSync(pub).filter((n) => n.endsWith('.html'))) {
            const html = fs.readFileSync(path.join(pub, name), 'utf8');
            assert.ok(!html.includes("var raw=localStorage.getItem('ov_theme')"), `${name}: the old theme-only bootstrap is gone`);
        }
        console.log('look boot: every page paints the kept or carried look before its first stylesheet');
    } catch (err) {
        console.error(srv.logs());
        throw err;
    } finally {
        await srv.stop();
    }
})().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
