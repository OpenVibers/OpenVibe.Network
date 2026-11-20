'use strict';
// A guest is the token they hold, never their IP or a fingerprint (2026-11-20, security). Against the real server:
//   - two guests from one address are two guests, and the second never rotates the first's token (it used to hand the
//     first guest to anyone behind the same carrier or campus IP and sign them out);
//   - sending another guest's fingerprint gets a new guest, not theirs;
//   - /api/auth/anon-identities lists only the caller's own guest (their Bearer guest token), without any session token;
//     without one, nothing (it used to list every guest seen from the caller's IP with their tokens, unauthenticated);
//   - new guests are limited per address.
//   node test/guest-identity.test.js
const assert = require('assert');
const { bootServer } = require('./helpers/boot-server');

(async () => {
    const srv = await bootServer();
    try {
        const post = async (body) => {
            const r = await fetch(srv.base + '/api/auth/anon-session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
            return { status: r.status, body: await r.json().catch(() => ({})) };
        };
        const me = async (token) => (await fetch(srv.base + '/api/auth/anon/' + encodeURIComponent(token))).status;

        const a = await post({ fingerprint: 'fp-of-alice' });
        assert.strictEqual(a.status, 200, JSON.stringify(a.body));
        const b = await post({});
        assert.strictEqual(b.status, 200);
        assert.notStrictEqual(a.body.user.anon_number, b.body.user.anon_number, 'the same address: two guests');
        assert.strictEqual(await me(a.body.token), 200, "the first guest's token still works (not rotated)");

        const c = await post({ fingerprint: 'fp-of-alice' });
        assert.notStrictEqual(c.body.user.anon_number, a.body.user.anon_number, "another guest's fingerprint is not their identity");
        assert.strictEqual(await me(a.body.token), 200, 'and still does not sign the first one out');

        const list = async (token) => {
            const r = await fetch(srv.base + '/api/auth/anon-identities', token ? { headers: { authorization: `Bearer ${token}` } } : {});
            return { cache: r.headers.get('cache-control') || '', body: await r.json() };
        };
        let l = await list(null);
        assert.deepStrictEqual(l.body.identities, [], 'no token: nobody');
        assert.match(l.cache, /no-store/);
        l = await list(a.body.token);
        assert.strictEqual(l.body.identities.length, 1);
        assert.strictEqual(l.body.identities[0].anon_number, a.body.user.anon_number, 'the caller\'s own guest');
        assert.ok(!JSON.stringify(l.body).includes(a.body.token) && !JSON.stringify(l.body).includes(b.body.token), 'never a session token');

        // The per-address limit on new guests (60 an hour): the 61st from one address is refused.
        let refused = null;
        for (let i = 0; i < 61 && !refused; i++) { const r = await post({}); if (r.status === 429) refused = r; }
        assert.ok(refused && refused.body.code === 'auth.guest_rate_limited', 'new guests are limited per address');
        console.log('guest identity: the token, never the address or a fingerprint; the list shows only your own guest');
    } finally { await srv.stop(); }
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
