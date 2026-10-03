'use strict';
// Without key files, a keyless child never publishes its ephemeral HS256 secret.
const assert = require('assert');
const jwt = require('jsonwebtoken');
const { bootServer } = require('./helpers/boot-server');
const { out } = require('./security-suite');

(async () => {
    const t0 = Date.now();
    const bare = await bootServer({ child: true });
    try {
        const r = await fetch(`${bare.base}/api/.well-known/jwks`);
        const body = await r.json();
        const k = body.public_key;
        if (k && !String(k).includes('BEGIN')) {
            // A published HS256 secret would let a caller forge an admin session.
            const forged = jwt.sign({ sub: 1, id: 1, username: 'admin', role: 'admin' }, k, { algorithm: 'HS256', issuer: 'https://openvibe.network', expiresIn: '1h' });
            const me = await fetch(`${bare.base}/api/auth/me`, { headers: { authorization: `Bearer ${forged}` } });
            assert.notStrictEqual(me.status, 200, 'a session signed with the published HS256 secret is refused');
        }
        assert.ok(!k || String(k).includes('BEGIN PUBLIC KEY'), 'a keyless Network publishes no HS256 secret as its public key');
    } finally {
        await bare.stop();
    }
    out(`security secrets-keys: all checks passed (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
})().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
