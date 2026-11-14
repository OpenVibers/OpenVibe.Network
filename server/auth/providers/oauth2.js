'use strict';
/**
 * The generic OAuth2 client for the providers that have no discovery document (plan §AB.20): the preset carries the
 * authorize, token and profile URLs, the scopes, the PKCE rule and a mapper from the provider's profile JSON to the
 * one identity shape the rest of Network reads. GitHub, Kick and X are the first three.
 *
 *   const token = await exchangeCode({ provider, values, code, redirectUri, verifier, fetch })
 *   const id    = await profile({ provider, values, token, fetch })
 *
 * PKCE S256 is sent for every provider whose preset says so (`required` or `supported`), and the exchange always
 * sends the verifier. A provider that returns no `email_verified` (Kick, X) makes the address contact, never proof:
 * `email_verified` is false unless a mapper says true and the preset allows it.
 */
const PROFILE_TIMEOUT_MS = 8000;

function basicAuth(id, secret) {
    return `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString('base64')}`;
}

/** Turn a preset's stored value into the token request headers and body its authMethod asks for. */
function tokenRequest({ provider, values, form }) {
    const body = new URLSearchParams(form);
    const headers = { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' };
    const method = provider.authMethod || 'client_secret_post';
    if (method === 'client_secret_basic') {
        headers.authorization = basicAuth(values.client_id, values.client_secret || '');
    } else {
        body.set('client_id', values.client_id);
        if (values.client_secret) body.set('client_secret', values.client_secret);
    }
    return { headers, body };
}

function readJson(text, type) {
    if (!text) return null;
    try { return JSON.parse(text); } catch { /* GitHub answers form-encoded unless asked for JSON */ }
    if (/application\/x-www-form-urlencoded/i.test(type || '')) return Object.fromEntries(new URLSearchParams(text));
    return null;
}

/** Exchange an authorization code. → { access_token, id_token?, token_type, … } or a thrown error with a code. */
async function exchangeCode({ provider, values, code, redirectUri, verifier, fetch: fetchImpl = globalThis.fetch }) {
    const form = { grant_type: 'authorization_code', code, redirect_uri: redirectUri };
    if (verifier) form.code_verifier = verifier;
    const { headers, body } = tokenRequest({ provider, values, form });
    let res;
    try {
        res = await fetchImpl(provider.token, { method: 'POST', headers, body, signal: AbortSignal.timeout(PROFILE_TIMEOUT_MS), redirect: 'error' });
    } catch (err) {
        throw Object.assign(new Error(`${provider.name}'s token endpoint did not answer`), { code: 'token_unreachable' });
    }
    const text = await res.text().catch(() => '');
    const json = readJson(text, res.headers.get('content-type'));
    if (!res.ok || !json || typeof json.access_token !== 'string' || !json.access_token) {
        const why = json && (json.error_description || json.error || json.message) ? String(json.error_description || json.error || json.message).slice(0, 160) : `HTTP ${res.status}`;
        throw Object.assign(new Error(`${provider.name} refused the code: ${why}`), { code: 'token_refused' });
    }
    return json;
}

/** The signed-in identity: the profile read with the access token, through the preset's mapper. */
async function profile({ provider, values, token, fetch: fetchImpl = globalThis.fetch }) {
    const headers = { accept: 'application/json', authorization: `Bearer ${token.access_token}`, 'user-agent': 'OpenVibe.Network sign-in' };
    let res;
    try {
        res = await fetchImpl(provider.profile, { headers, signal: AbortSignal.timeout(PROFILE_TIMEOUT_MS), redirect: 'error' });
    } catch {
        throw Object.assign(new Error(`${provider.name}'s profile read did not answer`), { code: 'profile_unreachable' });
    }
    const text = await res.text().catch(() => '');
    let json = null;
    if (text) { try { json = JSON.parse(text); } catch { json = null; } }
    if (!res.ok || !json) throw Object.assign(new Error(`${provider.name} refused the profile read (HTTP ${res.status})`), { code: 'profile_refused' });

    let email = null, emailVerified = false;
    if (provider.emails) {
        // GitHub: /user has email: null without the scope; /user/emails has the verified primary one.
        try {
            const r = await fetchImpl(provider.emails, { headers, signal: AbortSignal.timeout(PROFILE_TIMEOUT_MS), redirect: 'error' });
            if (r.ok) {
                const picked = provider.emailOf(await r.json());
                email = picked.email || null;
                emailVerified = picked.verified === true;
            }
        } catch { /* an address is optional: the person still signs in */ }
    }
    const raw = provider.profileOf(json) || {};
    if (raw.email) { email = raw.email; emailVerified = raw.verified === true; }
    if (provider.emailUnverified) emailVerified = false;
    const providerUserId = raw.id === undefined || raw.id === null ? null : String(raw.id);
    if (!providerUserId) throw Object.assign(new Error(`${provider.name}'s profile read did not name the person`), { code: 'profile_incomplete' });
    return {
        provider_user_id: providerUserId,
        username: raw.username || raw.login || null,
        display_name: String(raw.name || raw.username || raw.login || `${provider.name} account`),
        avatar_url: raw.avatar || null,
        email,
        email_verified: emailVerified,
    };
}

module.exports = { exchangeCode, profile, tokenRequest, basicAuth, readJson, PROFILE_TIMEOUT_MS };
