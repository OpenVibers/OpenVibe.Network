'use strict';
/**
 * Network's own service tokens for its calls to other services. Network is the token issuer, so it signs them itself
 * (sub svc:network, 5 minutes, one audience, the capabilities the call performs), the way the receivers verify every
 * other service's token (identity.service-token-claims@1). One cached token per audience + capability set.
 *
 *   const token = createSelfTokens({ privateKey, issuer });
 *   token('openvibe.live', ['live.avatar.write'])   → 'eyJ…' | null (no RS256 key: a development HS256 setup)
 */
const crypto = require('crypto');

const TTL_S = 300;

function createSelfTokens({ privateKey, issuer, now = () => Date.now() } = {}) {
    const cache = new Map();
    return function token(audience, caps, { ns = null } = {}) {
        if (!privateKey || !String(privateKey).includes('BEGIN') || !issuer || !audience) return null;
        const list = [...caps].sort();
        const key = `${audience}|${list.join(',')}|${ns ? [...ns].sort().join(',') : ''}`;
        const t = Math.floor(now() / 1000);
        const hit = cache.get(key);
        if (hit && hit.exp - 60 > t) return hit.token;
        const claims = { iss: issuer, sub: 'svc:network', actor_type: 'service', aud: [audience], cap: list, ...(ns ? { ns: [...ns] } : {}),
            iat: t, exp: t + TTL_S, jti: `tok_${crypto.randomBytes(12).toString('hex')}` };
        const signed = require('openvibe-contracts').serviceAuth.signServiceToken(claims, privateKey);
        cache.set(key, { token: signed, exp: claims.exp });
        return signed;
    };
}

module.exports = { createSelfTokens };
