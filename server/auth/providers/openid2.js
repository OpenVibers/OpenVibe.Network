'use strict';
/**
 * Steam, as OpenID 2.0 (plan §AB.20): there is no app to register and no OAuth. The person is sent to Steam's
 * checkid_setup endpoint; Steam sends them back with an assertion; and the assertion is only a proof once we have
 * asked Steam's own `check_authentication` endpoint about it (a bare `openid.claimed_id` in the query string is
 * forgeable: anyone can type it).
 *
 *   const back = openid2.callbackParams({ baseUrl, provider, returnTo })   the query string Steam is sent to
 *   const id   = await openid2.verify({ provider, query, baseUrl, fetch })  the steamid64, or a thrown error
 *
 * The checks: `openid.mode` is id_res; `openid.op_endpoint` is Steam's endpoint exactly; `openid.claimed_id`
 * starts with `https://steamcommunity.com/openid/id/` and the rest is a 17-digit steamid64; `openid.return_to` is
 * ours; `openid.signed` actually covers claimed_id, op_endpoint, return_to and identity; and the POSTed
 * check_authentication answer says `is_valid:true`. Then, only if the owner gave a Web API key, the name and picture
 * come from GetPlayerSummaries (otherwise the person is asked for a username).
 */
const crypto = require('crypto');

const STEAM_ID_RE = /^[0-9]{17}$/;

function nonce() {
    return crypto.randomBytes(16).toString('hex');
}

/**
 * The parameters of the redirect to Steam. `return_to` carries our own state and PKCE verifier in the query, so the
 * callback needs no cookie beyond the state cookie the registry sets.
 */
function authorizeParams({ provider, returnTo }) {
    const params = {
        'openid.ns': 'http://specs.openid.net/auth/2.0',
        'openid.mode': 'checkid_setup',
        'openid.return_to': returnTo,
        'openid.realm': new URL(returnTo).origin,
        'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
        'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select',
    };
    return params;
}

/** What a callback says: the claimed id, the endpoint, the return_to and the signed list. */
function callbackParams(query = {}) {
    return {
        mode: query['openid.mode'],
        claimedId: query['openid.claimed_id'] || '',
        opEndpoint: query['openid.op_endpoint'] || '',
        returnTo: query['openid.return_to'] || '',
        signed: String(query['openid.signed'] || ''),
    };
}

/**
 * Ask Steam whether the assertion is genuine. → the 17-digit steamid64, or a thrown error with a stable `code`.
 * `fetch` is injected so the recorded-answer tests never touch the network.
 */
async function verify({ provider, query = {}, baseUrl, fetch: fetchImpl = globalThis.fetch }) {
    const fail = (code, detail) => { throw Object.assign(new Error(detail || code), { code }); };
    const c = callbackParams(query);
    if (c.mode !== 'id_res') fail('openid_mode', 'not an id_res assertion');
    // The endpoint must be Steam's own: a lookalike op_endpoint could answer check_authentication for itself.
    if (c.opEndpoint !== provider.endpoint) fail('openid_endpoint', `op_endpoint is not ${provider.endpoint}`);
    // return_to is the exact callback we built, so an assertion made for another site cannot be replayed here.
    const expectedReturn = `${String(baseUrl).replace(/\/+$/, '')}/api/auth/connect/${provider.id}/callback`;
    if (!c.returnTo || String(c.returnTo).split('?')[0] !== expectedReturn) fail('openid_return_to', 'return_to is not our callback');
    // claimed_id must be a steamid64 under the one prefix we accept, exactly.
    if (!c.claimedId.startsWith(provider.claimedPrefix)) fail('openid_claimed_id', 'claimed_id is not a Steam id');
    const steamId = c.claimedId.slice(provider.claimedPrefix.length);
    if (!STEAM_ID_RE.test(steamId)) fail('openid_claimed_id', 'claimed_id is not a 17-digit Steam id');
    // The signed list has to cover the fields we rely on, or the signature proves nothing about them.
    const signed = new Set(c.signed.split(',').map((s) => s.trim()));
    for (const need of ['claimed_id', 'op_endpoint', 'return_to', 'identity', 'response_nonce', 'assoc_handle']) {
        if (!signed.has(need)) fail('openid_signed', `the assertion does not sign ${need}`);
    }

    // check_authentication: send every openid.* field back, with mode=check_authentication, and read the answer.
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
        if (!k.startsWith('openid.') || k === 'openid.mode') continue;
        body.set(k, String(v));
    }
    body.set('openid.mode', 'check_authentication');
    let res;
    try {
        res = await fetchImpl(provider.endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(8000), redirect: 'error' });
    } catch {
        fail('openid_unreachable', 'Steam did not answer the assertion check');
    }
    const text = await res.text().catch(() => '');
    if (!res.ok) fail('openid_check_failed', `Steam answered ${res.status}`);
    const answer = Object.fromEntries(String(text).split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
        const at = l.indexOf(':');
        return at > 0 ? [l.slice(0, at), l.slice(at + 1)] : [l, ''];
    }));
    if (answer['is_valid'] !== 'true') fail('openid_invalid', 'Steam did not confirm the assertion');
    return { steam_id: steamId, claimed_id: c.claimedId };
}

/**
 * The name and picture, when the owner gave a Web API key. → { display_name, avatar_url } or null when there is no
 * key or Steam has no summary for that id. Never throws: a failed read is a missing name, not a failed sign-in.
 */
async function summary({ provider, values = {}, steamId, fetch: fetchImpl = globalThis.fetch }) {
    const key = values.api_key ? String(values.api_key).trim() : '';
    if (!key || !provider.profileUrl) return null;
    try {
        const url = `${provider.profileUrl}?key=${encodeURIComponent(key)}&steamids=${encodeURIComponent(steamId)}`;
        const res = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000), redirect: 'error' });
        if (!res.ok) return null;
        const json = await res.json();
        const players = json && json.response && Array.isArray(json.response.players) ? json.response.players : [];
        const p = players[0];
        if (!p) return null;
        return { display_name: p.personaname || null, avatar_url: p.avatarfull || p.avatarmedium || null };
    } catch { return null; }
}

module.exports = { authorizeParams, callbackParams, verify, summary, nonce, STEAM_ID_RE };
