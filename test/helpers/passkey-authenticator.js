'use strict';
// A software ES256 authenticator: exercises the real verifier, never replaces it.
const crypto = require('crypto');
const { isoCBOR } = require('@simplewebauthn/server/helpers');
const hash = b => crypto.createHash('sha256').update(b).digest();
const b64 = b => Buffer.from(b).toString('base64url');
function authenticator() {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = publicKey.export({ format: 'jwk' });
    const id = crypto.randomBytes(32); let counter = 0; let handle;
    const cose = isoCBOR.encode(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
    const data = (flags, rp) => { const c = Buffer.alloc(4); c.writeUInt32BE(++counter); return Buffer.concat([hash(rp), Buffer.from([flags]), c]); };
    const client = (type, options, origin) => Buffer.from(JSON.stringify({ type, challenge: options.challenge, origin, crossOrigin: false }));
    return {
        id: b64(id),
        register(options, { origin = 'https://openvibe.network', rp = 'openvibe.network', flags = 0x45 } = {}) {
            handle = options.user.id;
            const length = Buffer.alloc(2); length.writeUInt16BE(id.length);
            const authData = Buffer.concat([data(flags, rp), Buffer.alloc(16), length, id, cose]);
            return { id: b64(id), rawId: b64(id), type: 'public-key', clientExtensionResults: {}, response: {
                clientDataJSON: b64(client('webauthn.create', options, origin)),
                attestationObject: b64(isoCBOR.encode(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]))), transports: ['internal'],
            } };
        },
        assert(options, { origin = 'https://openvibe.network', rp = 'openvibe.network', flags = 5, wrongHandle = false } = {}) {
            const authData = data(flags, rp); const clientData = client('webauthn.get', options, origin);
            return { id: b64(id), rawId: b64(id), type: 'public-key', clientExtensionResults: {}, response: {
                clientDataJSON: b64(clientData), authenticatorData: b64(authData), userHandle: wrongHandle ? b64('another account') : handle,
                signature: b64(crypto.sign('sha256', Buffer.concat([authData, hash(clientData)]), privateKey)),
            } };
        },
    };
}
module.exports = { authenticator };
