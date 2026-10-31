'use strict';
/**
 * The look before first paint (openvibe-shared 4.64.0 look-boot, plan L42).
 *
 * Every OpenVibe site keeps a record of the look it painted (localStorage 'ov_paint'), and a link from
 * another OpenVibe page carries that look in '?ov_look='. openvibe-shared's look-boot paints it before
 * the first frame: the colours, the season, Calm, the text size and color-scheme. Network's own bootstrap
 * painted only the old 'ov_theme' record, so a page could show the wrong season, or flash, until
 * theme-loader.js (deferred) ran.
 *
 * The pages carry a marker (<!--ov:look-boot-->) where the script belongs; this module puts it there:
 * at serve time for the page the server renders (the home page), and for the pages served raw, once, at boot.
 * The marker never reaches a page.
 */
const fs = require('fs');
const path = require('path');
const { BOOT, tag } = require('openvibe-shared/look-boot');

const MARK = '<!--ov:look-boot-->';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

/** The marker replaced by the inline script. A page without the marker is left alone. */
function apply(html) {
    if (typeof html !== 'string' || !html.includes(MARK)) return html;
    return html.replace(MARK, () => tag());
}

// The public pages that carry the marker, read once at boot: their look-boot is in the bytes from here on.
const files = new Map();
for (const name of fs.readdirSync(PUBLIC_DIR)) {
    if (!name.endsWith('.html')) continue;
    const html = fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8');
    if (!html.includes(MARK)) continue;
    files.set(name, apply(html));
}

/** The page with look-boot in it, or null when the file is not one of ours. */
function page(name) {
    return files.get(name) || null;
}

/** Send a public page with look-boot in it. The headers a caller set (no-store, a redirect) are kept. */
function send(res, name) {
    const html = page(name);
    if (!html) return false;
    res.set('Content-Type', 'text/html; charset=utf-8');
    if (!res.get('Cache-Control')) res.set('Cache-Control', 'public, max-age=0');
    res.send(html);
    return true;
}

/**
 * The pages the static file server would answer raw (public/*.html reached by their own file name):
 * they get look-boot too, so no path serves a page without it.
 */
function middleware() {
    return (req, res, next) => {
        if (!req.path.endsWith('.html')) return next();
        if (!page(path.basename(req.path))) return next();
        send(res, path.basename(req.path));
    };
}

module.exports = { MARK, BOOT, apply, page, send, middleware, files };
