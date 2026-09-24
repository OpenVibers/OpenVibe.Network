'use strict';
/**
 * Headers for Network's public/ files. /assets/* are the network's brand assets (logo, app icons,
 * OG images) that every OpenVibe site and placeholder shows from openvibe.network, so they are
 * readable cross-origin (helmet's default Cross-Origin-Resource-Policy: same-origin broke the logo
 * on every placeholder) and cached for a day. Scripts and stylesheets revalidate every time.
 */
const path = require('path');

function publicStaticHeaders(res, filePath) {
    const p = String(filePath).split(path.sep).join('/');
    if (/\/public\/assets\//.test(p)) {
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return;
    }
    if (p.endsWith('.js') || p.endsWith('.css')) res.setHeader('Cache-Control', 'no-cache');
}

module.exports = { publicStaticHeaders };
