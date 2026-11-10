'use strict';
// The home page's pictures come from three places, and the CSP must let each one through: avatars and media from
// openvibe.media, live thumbnails from openvibe.live, and the "Right now" screenshot pastes from openvibe.community
// (blocked until 2026-11-06: a screenshot card showed nothing, and the browser logged a CSP refusal).
const assert = require('assert');
const { bootServer } = require('./helpers/boot-server');

(async () => {
    const srv = await bootServer();
    try {
        const r = await fetch(srv.base + '/');
        const csp = r.headers.get('content-security-policy') || '';
        const img = (csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('img-src')) || '').split(/\s+/);
        for (const origin of ['https://openvibe.media', 'https://openvibe.live', 'https://openvibe.community']) {
            assert.ok(img.includes(origin), `img-src lets ${origin} through: ${img.join(' ')}`);
        }
        // The machine hub's live screen (/machines) imports mediasoup-client's pinned ESM build and opens
        // OpenRestream's viewer signaling socket: exactly those two, in the two directives that gate them.
        const directive = (name) => csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(name)) || '';
        assert.ok(directive('script-src').includes('https://esm.sh'), 'script-src lets the mediasoup client through');
        assert.ok(directive('connect-src').includes('wss://ingest.openre.stream'), 'connect-src lets the screen signaling through');
        console.log('CSP: home images, and the machine hub\'s live screen sources');
        await srv.stop();
        process.exit(0);
    } finally {
        await srv.stop();
    }
})().catch((e) => { console.error(e); process.exit(1); });
