'use strict';
// Run on the deployment host with the existing probe credential in process.env.
// Never prints credentials, assertions, tokens or recovery codes. No database writes.
const { createRequire } = require('module');
const requireLive = createRequire('/opt/openvibe.network/package.json');
const crypto = require('crypto');
const { isoCBOR } = requireLive('@simplewebauthn/server/helpers');
const assert = require('assert');
const hash = b => crypto.createHash('sha256').update(b).digest();
const b64 = b => Buffer.from(b).toString('base64url');
(async () => {
    const password = process.env.PROBE_MERGE_KEEP_PW;
    if (!password) throw new Error('Probe credential unavailable');
    let token; const cookies = new Map(); let keyId; let recovery;
    const call = async (path, body, signed = false) => {
        const res = await fetch('https://openvibe.network/api/auth/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(signed ? { authorization: `Bearer ${token}` } : {}), cookie: [...cookies].map(([k,v]) => `${k}=${v}`).join('; ') }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        for (const value of res.headers.getSetCookie()) { const [pair] = value.split(';'); const i = pair.indexOf('='); if (pair.slice(i+1)) cookies.set(pair.slice(0,i), pair.slice(i+1)); else cookies.delete(pair.slice(0,i)); }
        return { status: res.status, body: await res.json() };
    };
    const login = () => call('login', { username: 'ovprobe_merge_keep', password });
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = publicKey.export({ format: 'jwk' }); const id = crypto.randomBytes(32); let counter = 0; let handle;
    const data = flags => { const c = Buffer.alloc(4); c.writeUInt32BE(++counter); return Buffer.concat([hash('openvibe.network'), Buffer.from([flags]), c]); };
    const client = (type, options) => Buffer.from(JSON.stringify({ type, challenge: options.challenge, origin: 'https://openvibe.network', crossOrigin: false }));
    const assertion = options => { const authData = data(5); const c = client('webauthn.get', options); return { id: b64(id), rawId: b64(id), type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: b64(c), authenticatorData: b64(authData), userHandle: handle, signature: b64(crypto.sign('sha256', Buffer.concat([authData, hash(c)]), privateKey)) } }; };
    try {
        let r = await login(); assert.equal(r.status, 200); token = r.body.token; cookies.clear();
        const initial = await call('passkeys', undefined, true); assert.equal(initial.status, 200); assert.equal(initial.body.keys.length, 0, 'Probe already has a passkey; leave it alone');
        const mfa = await call('mfa', undefined, true); assert.equal(mfa.body.enabled, false, 'Probe has an authenticator; leave it alone');
        r = await call('passkeys/register/options', { password }, true); assert.equal(r.status, 200); const setup = r.body; handle = setup.options.user.id;
        const len = Buffer.alloc(2); len.writeUInt16BE(id.length);
        const cose = isoCBOR.encode(new Map([[1,2],[3,-7],[-1,1],[-2,Buffer.from(jwk.x,'base64url')],[-3,Buffer.from(jwk.y,'base64url')]]));
        const authData = Buffer.concat([data(0x45), Buffer.alloc(16), len, id, cose]);
        const response = { id: b64(id), rawId: b64(id), type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: b64(client('webauthn.create', setup.options)), attestationObject: b64(isoCBOR.encode(new Map([['fmt','none'],['attStmt',new Map()],['authData',authData]]))), transports: ['internal'] } };
        r = await call('passkeys/register/verify', { state: setup.state, response, name: 'Temporary production probe' }, true); assert.equal(r.status, 200); keyId = b64(id); recovery = r.body.recovery_codes;
        console.log('production passkey enrollment: 200');
        cookies.clear(); r = await call('passkeys/login/options', {}); const body = { response: assertion(r.body) }; const ceremonyCookie = cookies.get('__Host-ov_passkey');
        r = await call('passkeys/login/verify', body); assert.equal(r.status, 200); console.log('production passkey sign-in: 200');
        cookies.clear(); cookies.set('__Host-ov_passkey', ceremonyCookie); r = await call('passkeys/login/verify', body); assert.equal(r.status, 401); console.log('production assertion replay: 401');
        cookies.clear(); assert.equal((await login()).status, 202); r = await call('passkeys/login/options', {}); r = await call('passkeys/login/verify', { response: assertion(r.body) }); assert.equal(r.status, 200); console.log('production password plus passkey: 200');
        cookies.clear(); assert.equal((await login()).status, 202); assert.equal((await call('mfa/verify', { code: recovery[0] })).status, 200);
        cookies.clear(); assert.equal((await login()).status, 202); assert.equal((await call('mfa/verify', { code: recovery[0] })).status, 401); console.log('production recovery: 200 then 401 on reuse');
    } finally {
        if (keyId) { cookies.clear(); const r = await call('passkeys/remove', { password, code: recovery[1], id: keyId }, true); assert.equal(r.status, 200); console.log('production probe passkey removed: 200'); }
    }
    cookies.clear(); assert.equal((await login()).status, 200); console.log('production probe password sign-in restored: 200');
})().catch(() => { console.error('Production passkey probe failed; details redacted'); process.exitCode = 1; });
