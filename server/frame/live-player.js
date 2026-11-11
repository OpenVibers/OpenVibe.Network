'use strict';
const express = require('express');
const { SITES, PRODUCTS } = require('./sites');

const allowedHosts = new Set([...SITES, ...PRODUCTS].map((site) => site.host));
const router = express.Router();

function parentOrigin(value) {
    try {
        const url = new URL(String(value || ''));
        if (url.protocol !== 'https:' || url.origin !== value || !allowedHosts.has(url.hostname)) return null;
        return url.origin;
    } catch { return null; }
}

// Every destination already permits Network frames. This narrow bridge lets one of
// those frames host Live's existing /embed player without widening every site's CSP.
router.get('/:username', (req, res) => {
    const from = parentOrigin(req.query.from);
    const username = String(req.params.username || '');
    if (!from || !/^[A-Za-z0-9_-]{1,40}$/.test(username)) return res.sendStatus(404);
    res.removeHeader('X-Frame-Options');
    res.set({
        'Content-Security-Policy': `default-src 'none'; frame-src https://openvibe.live; frame-ancestors ${from}; script-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; object-src 'none'`,
        'Cache-Control': 'public, max-age=300',
    });
    res.type('html').send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Live stream</title><style>html,body{margin:0;width:100%;height:100%;background:#000}iframe{display:block;width:100%;height:100%;border:0}</style></head><body><iframe id="player" src="https://openvibe.live/embed/${encodeURIComponent(username)}" title="Live stream" allow="autoplay; fullscreen; picture-in-picture" sandbox="allow-scripts allow-same-origin allow-popups allow-forms" referrerpolicy="strict-origin-when-cross-origin"></iframe><script src="/js/live-player-bridge.js" defer></script></body></html>`);
});

module.exports = { router, parentOrigin };
