'use strict';
/**
 * The provider registry (plan §AB.20, wave 1): what is switched on, how a flow starts, and what comes back.
 *
 *   const registry = createRegistry({ config, fetch, log, now })
 *   const started  = await registry.start({ db, providerId, mode, userId, redirectUri, returnTo, appQuery, req })
 *   const done     = await registry.finish({ db, providerId, query, body, redirectUri, stateRow, req })
 *
 * start()  → { redirect: 'https://provider/…' } or a thrown error ({ code })
 * finish() → the identity { provider_user_id, username, display_name, avatar_url, email, email_verified }
 *
 * The mechanism is the preset's `kind`: oidc (discovery + id_token), apple (OIDC, form_post, a derived secret),
 * oauth2 (URLs + a profile mapper) and openid2 (Steam's check_authentication). The routes above this file never
 * know which one answered.
 */
const crypto = require('crypto');
const presets = require('./presets');
const configNs = require('./config');
const oidc = require('./oidc');
const oauth2 = require('./oauth2');
const openid2 = require('./openid2');
const apple = require('./apple');

const PKCE_VERIFIER = () => crypto.randomBytes(32).toString('base64url');
const pkceChallenge = (v) => crypto.createHash('sha256').update(v).digest('base64url');

function createRegistry({ config = {}, fetch: fetchImpl = globalThis.fetch, log = console, now = () => Date.now(), discovery = null } = {}) {
    const baseUrl = String(config.baseUrl || config.loginUrl || 'https://openvibe.network').replace(/\/+$/, '');
    const disc = discovery || oidc.createDiscovery({ fetch: fetchImpl, log, now });

    /** The stored owner values for a provider, or null when its keys are not all set. */
    async function settings(db, providerId) {
        const store = await configNs.forDb(db, baseUrl);
        const p = presets.BY_ID.get(providerId);
        if (!p) return null;
        // The owner's one master switch closes every provider at once, without deleting a single key.
        const masterOff = (store.get() || {}).signin_switch === false;
        return { store, provider: p, values: configNs.valuesOf(store, providerId), enabled: !masterOff && configNs.isEnabled(store, providerId) };
    }

    /** The providers the page may draw, most used first. */
    async function listed(db) {
        const store = await configNs.forDb(db, baseUrl);
        if ((store.get() || {}).signin_switch === false) return [];
        return configNs.enabledProviders(store);
    }

    /**
     * Build the redirect to the provider. `redirectUri` is this provider's own callback (the alias Discord path when the
     * old route started the flow), and `state` is the value in the browser's cookie.
     */
    async function start({ db, providerId, state, redirectUri, values, extra = {} }) {
        const p = presets.BY_ID.get(providerId);
        if (!p) throw Object.assign(new Error('No such sign-in provider'), { code: 'unknown_provider' });
        const verifier = p.pkce === 'none' ? null : PKCE_VERIFIER();
        const nonce = crypto.randomBytes(24).toString('base64url');
        const scopes = (p.scopes || []).join(' ');

        if (p.kind === 'openid2') {
            const params = openid2.authorizeParams({ provider: p, returnTo: `${redirectUri}?state=${encodeURIComponent(state)}` });
            return { redirect: `${p.endpoint}?${new URLSearchParams(params)}`, verifier: null, nonce: null, codeChallenge: null };
        }

        let authorizationEndpoint, tokenEndpoint, jwksUri, doc = null;
        if (p.kind === 'oidc' || p.kind === 'apple') {
            const issuer = p.issuer || p.discoveryIssuer;
            doc = await disc.get(issuer);
            authorizationEndpoint = doc.authorization_endpoint;
            tokenEndpoint = doc.token_endpoint;
            jwksUri = doc.jwks_uri;
        } else {
            authorizationEndpoint = p.authorize;
            tokenEndpoint = p.token;
        }
        const params = new URLSearchParams({
            client_id: String(values.client_id || ''),
            redirect_uri: redirectUri,
            response_type: 'code',
            scope: scopes,
            state,
            nonce,
        });
        if (verifier) { params.set('code_challenge', pkceChallenge(verifier)); params.set('code_challenge_method', 'S256'); }
        if (p.kind === 'apple') params.set('response_mode', 'form_post');
        if (p.claims) params.set('claims', JSON.stringify(p.claims));
        if (p.issuerTemplate) {
            // The templated issuer's tenant (Microsoft's owner setting) replaces {tenantid} in the discovered endpoints
            // too, so the authorize and token calls go to that tenant's own URLs; nothing else changes.
            const tenant = String(values.tenant || 'common');
            if (!/^(common|organizations|consumers|[0-9a-f-]{36}|[A-Za-z0-9.-]{1,253})$/.test(tenant)) throw Object.assign(new Error('The Microsoft tenant is not a tenant id or common'), { code: 'bad_tenant' });
            const swap = (u) => String(u).split('{tenantid}').join(tenant).split('/common/').join(`/${tenant}/`);
            authorizationEndpoint = swap(authorizationEndpoint);
            tokenEndpoint = swap(tokenEndpoint);
        }
        return { redirect: `${authorizationEndpoint}${authorizationEndpoint.includes('?') ? '&' : '?'}${params}`, verifier, nonce, doc, tokenEndpoint, jwksUri };
    }

    /**
     * The identity a callback's answer proves. `stateRow` carries the verifier and nonce stored at the start. Throws
     * with a stable `code` on any refusal; nothing here writes to the database.
     */
    async function finish({ db, providerId, stateRow, query = {}, body = {}, redirectUri }) {
        const p = presets.BY_ID.get(providerId);
        if (!p) throw Object.assign(new Error('No such sign-in provider'), { code: 'unknown_provider' });
        const { values } = await settings(db, providerId);
        const merged = { ...(query || {}), ...(body || {}) };
        const verifier = stateRow && stateRow.verifier ? stateRow.verifier : null;
        const nonce = stateRow && stateRow.nonce ? stateRow.nonce : null;

        if (p.kind === 'openid2') {
            const out = await openid2.verify({ provider: p, query: merged, baseUrl, fetch: fetchImpl });
            const who = await openid2.summary({ provider: p, values, steamId: out.steam_id, fetch: fetchImpl });
            return {
                provider_user_id: out.steam_id,
                username: null,
                display_name: (who && who.display_name) || `Steam ${out.steam_id.slice(-4)}`,
                avatar_url: (who && who.avatar_url) || null,
                email: null,
                email_verified: false,
            };
        }

        let tokenEndpoint, jwksUri, meta = null;
        if (p.kind === 'oidc' || p.kind === 'apple') {
            meta = await disc.get(p.issuer || p.discoveryIssuer);
            tokenEndpoint = meta.token_endpoint;
            jwksUri = meta.jwks_uri;
        } else {
            tokenEndpoint = p.token;
        }
        if (p.issuerTemplate) {
            // The code was issued by the owner's tenant, so its token endpoint (not common's) must redeem it.
            const tenant = String(values.tenant || 'common');
            if (/^(common|organizations|consumers|[0-9a-f-]{36}|[A-Za-z0-9.-]{1,253})$/.test(tenant)) {
                tokenEndpoint = String(tokenEndpoint).split('{tenantid}').join(tenant).split('/common/').join(`/${tenant}/`);
                jwksUri = String(jwksUri || '').split('{tenantid}').join(tenant).split('/common/').join(`/${tenant}/`);
            }
        }
        const clientId = String(values.client_id || '');
        const clientSecret = p.kind === 'apple'
            ? appleClientSecret(values)
            : String(values.client_secret || '');
        if (!tokenEndpoint) throw Object.assign(new Error('The provider has no token endpoint'), { code: 'provider_misconfigured' });

        // The code exchange. Apple and every OIDC provider use the form the metadata names; the presets say.
        const form = new URLSearchParams({ grant_type: 'authorization_code', code: String(merged.code || ''), redirect_uri: redirectUri });
        if (verifier) form.set('code_verifier', verifier);
        const headers = { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' };
        if ((p.authMethod || 'client_secret_post') === 'client_secret_basic') {
            headers.authorization = oauth2.basicAuth(clientId, clientSecret);
        } else {
            form.set('client_id', clientId);
            if (clientSecret) form.set('client_secret', clientSecret);
        }
        let res;
        try {
            res = await fetchImpl(tokenEndpoint, { method: 'POST', headers, body: form, signal: AbortSignal.timeout(8000), redirect: 'error' });
        } catch {
            throw Object.assign(new Error(`${p.name}'s token endpoint did not answer`), { code: 'token_unreachable' });
        }
        const text = await res.text().catch(() => '');
        let tok = null;
        try { tok = text ? JSON.parse(text) : null; } catch { tok = null; }
        if (!res.ok || !tok || typeof tok.access_token !== 'string') {
            const why = tok && (tok.error_description || tok.error) ? String(tok.error_description || tok.error).slice(0, 160) : `HTTP ${res.status}`;
            throw Object.assign(new Error(`${p.name} refused the sign-in: ${why}`), { code: 'token_refused' });
        }

        if (p.kind === 'oidc' || p.kind === 'apple') {
            if (typeof tok.id_token !== 'string') throw Object.assign(new Error(`${p.name} sent no id_token`), { code: 'id_token_missing' });
            const claims = await oidc.verifyIdToken({ token: tok.id_token, meta, provider: p.id, clientId, nonce, jwksUri, fetch: fetchImpl, now, log });
            // Apple sends the person's name only in the first authorization, as a JSON form field (never in the id_token).
            let first = {};
            if (p.kind === 'apple' && merged.user) {
                try { first = typeof merged.user === 'string' ? JSON.parse(merged.user) : merged.user; } catch { first = {}; }
            }
            const profile = { ...claims };
            if (first && first.name) profile.name = [first.name.firstName, first.name.lastName].filter(Boolean).join(' ') || claims.name;
            if (first && first.email && !profile.email) profile.email = first.email;
            const id = p.map(profile);
            id.email_verified = oidc.emailVerified(p, claims);
            return id;
        }

        // oauth2 preset: the profile read with the access token, mapped by the preset.
        return await oauth2.profile({ provider: p, values, token: tok, fetch: fetchImpl });
    }

    return { start, finish, listed, settings, baseUrl, discovery: disc };
}

/** Apple's secret, exported for the routes' "is Apple ready" check. */
const appleClientSecret = (values) => apple.appleClientSecret({ values });

module.exports = { createRegistry, appleClientSecret, PKCE_VERIFIER, pkceChallenge };
