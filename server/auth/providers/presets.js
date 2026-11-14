'use strict';
/**
 * The sign-in providers, as data (plan §AB.20, wave 1; research: research/signin-providers-1114.md).
 *
 * One object per provider, no flow code: the mechanisms live in oidc.js (OIDC discovery, id_token checks),
 * oauth2.js (an authorize/token pair and a profile mapper) and openid2.js (Steam's OpenID 2.0 assertion). A field
 * names the owner input it needs (client id, client secret, and Apple's three extras); the registry (index.js) only
 * offers a provider whose fields are set and whose switch is on.
 *
 * `id` is also the `linked_accounts.service` of a person's identity there (bare words: `google`, `steam`, …), and the
 * route segment of /api/auth/connect/<id>. Never change one: it is what a linked identity is found by.
 *
 * kind:
 *   'oidc'     a discovery document at <issuer>/.well-known/openid-configuration; id_token is the proof
 *   'oauth2'   no discovery: the URLs and the profile mapper below are the whole provider
 *   'openid2'  OpenID 2.0 (Steam): a check_authentication POST is the proof; no OAuth at all
 *   'apple'    OIDC with Apple's form_post answer and its derived ES256 client secret
 *
 * Profile shape every mapper returns (the one shape the rest of Network reads):
 *   { provider_user_id, username?, display_name, avatar_url?, email?, email_verified }
 * A missing email is null and never an error (Discord's phone-only accounts, Steam, TikTok). email_verified is true
 * only when the provider says so in so many words: an address a person can change and re-verify elsewhere is never
 * enough to attach an identity to an existing account (ADR-029, §3.3 of the research).
 */

// The app-creation page of every provider: where the owner makes the client and finds its id and secret.
const APPS_LINKS = {
    google: 'https://console.cloud.google.com/apis/credentials',
    discord: 'https://discord.com/developers/applications',
    twitch: 'https://dev.twitch.tv/console/apps',
    github: 'https://github.com/settings/developers',
    apple: 'https://developer.apple.com/account/resources/identifiers/list/serviceId',
    microsoft: 'https://entra.microsoft.com/',
    kick: 'https://kick.com/settings/developer',
    x: 'https://developer.x.com/en/portal/dashboard',
    roblox: 'https://create.roblox.com/dashboard/credentials',
    facebook: 'https://developers.facebook.com/apps/',
    steam: 'https://steamcommunity.com/dev/apikey',
};
const HOW = {
    google: 'Create credentials, then OAuth client ID, then Web application, and paste the client id and secret. Add the redirect URI below to Authorized redirect URIs.',
    discord: 'New Application, then OAuth2, paste the Application ID as the client id and reset and copy the client secret. Add the redirect URI below under Redirects.',
    twitch: 'Register Your Application, paste the client id and secret, and add the redirect URI below under OAuth Redirect URLs.',
    github: 'New OAuth App, paste the client id and generate a client secret. Set the Authorization callback URL to the redirect URI below.',
    apple: 'Make a Services ID (enable Sign in with Apple on it), a key (.p8, download it once), and paste the Services ID, Team ID, Key ID and the key here. Add openvibe.network to the Services ID Domains and the redirect URI to its Return URLs.',
    microsoft: 'App registrations, then New registration. Paste the Application (client) ID and a client secret, and add the redirect URI below under Authentication, Web.',
    kick: 'Turn on two-factor authentication first, open Developer, create an app and paste its client id and secret. Add the redirect URI below.',
    x: 'Create an app with OAuth 2.0 (Web App) and paste the client id; the secret is optional (a public client works). Add the redirect URI below as a callback.',
    roblox: 'Creator Dashboard, then OAuth 2.0 apps, create one with openid, profile and email, and paste the client id, secret and the redirect URI below.',
    facebook: 'Create a Consumer app, add Facebook Login, paste the App ID and App secret, and add the redirect URI below to Valid OAuth Redirect URIs. Switch the app Live.',
    steam: 'Nothing to register: Steam has no app. Optionally make a free Web API key here so a person\'s name and picture come with the sign-in; without it they are asked for a username.',
};

/** What each owner input row says on the Setup page, grouped under Sign-in apps. */
const OWNER = (id, name) => ({
    group: 'sign-in-apps',
    unlocks: `Sign in with ${name}`,
    get_it_at: APPS_LINKS[id],
    get_it_how: HOW[id],
});

const PROVIDERS = [
    // ── 1. Google: OIDC with discovery, non-sensitive scopes, no review ──
    {
        id: 'google', name: 'Google', kind: 'oidc', rank: 1,
        issuer: 'https://accounts.google.com',
        scopes: ['openid', 'email', 'profile'],
        pkce: 'required',
        authMethod: 'client_secret_post',
        emailVerifiedFrom: 'profile_claim',   // the id_token's email_verified
        fields: ['client_id', 'client_secret'],
        icon: { brand: 'google' },
        map: (p) => ({
            provider_user_id: String(p.sub),
            username: p.name ? String(p.name).replace(/[^A-Za-z0-9_]/g, '_').slice(0, 24) : null,
            display_name: String(p.name || p.email || 'Google account'),
            avatar_url: p.picture || null,
            email: p.email || null,
            email_verified: p.email_verified === true,
        }),
    },
    // ── 2. Discord: OIDC discovery; the link-only flow this replaces keeps its route and its rows ──
    {
        id: 'discord', name: 'Discord', kind: 'oidc', rank: 2,
        issuer: 'https://discord.com',
        scopes: ['openid', 'identify', 'email'],
        pkce: 'required',
        authMethod: 'client_secret_post',
        emailVerifiedFrom: 'profile_claim',
        fields: ['client_id', 'client_secret'],
        icon: { brand: 'discord' },
        map: (p) => ({
            provider_user_id: String(p.sub || p.id),
            username: p.username || p.preferred_username || null,
            display_name: String(p.global_name || p.display_name || p.username || 'Discord account'),
            avatar_url: p.avatar_url || p.picture || null,
            email: p.email || null,          // null on a phone-only account: no email, never an error
            email_verified: p.verified === true || p.email_verified === true,
        }),
    },
    // ── 3. Steam: OpenID 2.0, no app to register, no email ever ──
    {
        id: 'steam', name: 'Steam', kind: 'openid2', rank: 3,
        endpoint: 'https://steamcommunity.com/openid/login',
        claimedPrefix: 'https://steamcommunity.com/openid/id/',
        // A free Web API key is optional: with it, name and picture come from GetPlayerSummaries; without it, the
        // person picks a username and the id is the proof.
        fields: ['api_key'],
        optionalFields: ['api_key'],
        profileUrl: 'https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/',
        icon: { brand: 'steam' },
    },
    // ── 4. Twitch: OIDC (the old passport-twitch is abandoned; Twitch is OIDC now) ──
    {
        id: 'twitch', name: 'Twitch', kind: 'oidc', rank: 4,
        issuer: 'https://id.twitch.tv/oauth2',
        scopes: ['openid', 'user:read:email'],
        claims: { id_token: { email: null, email_verified: null, picture: null, preferred_username: null } },
        pkce: 'required',
        authMethod: 'client_secret_post',
        emailVerifiedFrom: 'profile_claim',
        fields: ['client_id', 'client_secret'],
        icon: { brand: 'twitch' },
        map: (p) => ({
            provider_user_id: String(p.sub),
            username: p.preferred_username || null,
            display_name: String(p.preferred_username || 'Twitch account'),
            avatar_url: p.picture || null,
            email: p.email || null,
            email_verified: p.email_verified === true,
        }),
    },
    // ── 5. GitHub: OAuth2 preset; no refresh token by design, S256 only ──
    {
        id: 'github', name: 'GitHub', kind: 'oauth2', rank: 5,
        authorize: 'https://github.com/login/oauth/authorize',
        token: 'https://github.com/login/oauth/access_token',
        profile: 'https://api.github.com/user',
        emails: 'https://api.github.com/user/emails',
        scopes: ['read:user', 'user:email'],
        pkce: 'required',
        authMethod: 'client_secret_post',
        fields: ['client_id', 'client_secret'],
        icon: { brand: 'github' },
        // The email is the entry with primary && verified in /user/emails; /user alone has email: null without user:email.
        profileOf: (j) => ({ id: j.id, login: j.login, name: j.name, avatar: j.avatar_url }),
        emailOf: (rows) => {
            const list = Array.isArray(rows) ? rows : [];
            const pick = list.find((e) => e && e.primary && e.verified) || list.find((e) => e && e.verified);
            return pick ? { email: pick.email, verified: true } : { email: null, verified: false };
        },
    },
    // ── 6. Apple: OIDC with form_post; the client secret is an ES256 JWT we mint from key id, team id and .p8 ──
    {
        id: 'apple', name: 'Apple', kind: 'apple', rank: 6,
        issuer: 'https://appleid.apple.com',
        scopes: ['openid', 'email', 'name'],
        pkce: 'none',                        // Apple accepts nonce, not code_challenge
        authMethod: 'client_secret_post',
        responseMode: 'form_post',
        fields: ['services_id', 'team_id', 'key_id', 'private_key'],
        icon: { brand: 'apple' },
        map: (p) => ({
            provider_user_id: String(p.sub),
            // Name and email come only on the very first authorization (from the `user` form field, not the id_token).
            username: null,
            display_name: String(p.name || (p.email ? String(p.email).split('@')[0] : 'Apple account')),
            avatar_url: null,
            email: p.email || null,
            email_verified: p.email_verified === true || p.email_verified === 'true',
        }),
    },
    // ── 7. Microsoft: OIDC with a templated issuer (compare against the tenant the token names) ──
    {
        id: 'microsoft', name: 'Microsoft', kind: 'oidc', rank: 7,
        issuerTemplate: 'https://login.microsoftonline.com/{tenantid}/v2.0',
        discoveryIssuer: 'https://login.microsoftonline.com/common/v2.0',
        scopes: ['openid', 'profile', 'email', 'offline_access'],
        pkce: 'required',
        authMethod: 'client_secret_post',
        emailVerifiedFrom: 'profile_claim',
        fields: ['client_id', 'client_secret', 'tenant'],
        defaults: { tenant: 'common' },
        icon: { brand: null, icon: 'window' },     // no Simple Icons mark; the window glyph stands in
        map: (p) => ({
            provider_user_id: String(p.oid || p.sub),
            username: p.preferred_username ? String(p.preferred_username).split('@')[0] : null,
            display_name: String(p.name || p.preferred_username || 'Microsoft account'),
            avatar_url: p.picture || null,
            email: p.email || p.preferred_username || null,
            email_verified: p.email_verified === true,
        }),
    },
    // ── 8. Kick: OAuth 2.1 with PKCE required, no discovery, no userinfo endpoint ──
    {
        id: 'kick', name: 'Kick', kind: 'oauth2', rank: 8,
        authorize: 'https://id.kick.com/oauth/authorize',
        token: 'https://id.kick.com/oauth/token',
        profile: 'https://api.kick.com/public/v1/users',
        scopes: ['user:read'],
        pkce: 'required',
        authMethod: 'client_secret_post',
        fields: ['client_id', 'client_secret'],
        icon: { brand: 'kick' },
        profileOf: (j) => {
            const u = (j && Array.isArray(j.data) ? j.data[0] : null) || {};
            return { id: u.user_id, name: u.name, avatar: u.profile_picture, email: u.email };
        },
        emailUnverified: true,               // Kick sends no email_verified: the address is contact, never proof
    },
    // ── 9. X: OAuth 2.0 with PKCE mandatory; the profile is one metered read ──
    {
        id: 'x', name: 'X', kind: 'oauth2', rank: 9,
        authorize: 'https://x.com/i/oauth2/authorize',
        token: 'https://api.x.com/2/oauth2/token',
        profile: 'https://api.x.com/2/users/me?user.fields=profile_image_url,verified',
        scopes: ['users.read', 'tweet.read', 'offline.access'],
        pkce: 'required',
        authMethod: 'client_secret_post',
        fields: ['client_id', 'client_secret'],
        optionalFields: ['client_secret'],   // a public client with PKCE is the normal shape
        icon: { brand: 'x' },
        profileOf: (j) => {
            const u = (j && j.data) || {};
            return { id: u.id, name: u.name, username: u.username, avatar: u.profile_image_url, verified: u.verified };
        },
        emailUnverified: true,               // users.email needs elevated access, and sends no verified flag
    },
    // ── 10. Roblox: complete OIDC (openid must be selected on the app or no id_token comes back) ──
    {
        id: 'roblox', name: 'Roblox', kind: 'oidc', rank: 10,
        issuer: 'https://apis.roblox.com/oauth',
        scopes: ['openid', 'profile', 'email'],
        pkce: 'required',
        authMethod: 'client_secret_post',
        emailVerifiedFrom: 'profile_claim',
        fields: ['client_id', 'client_secret'],
        icon: { brand: null, icon: 'gamepad' },   // no Simple Icons mark; the gamepad glyph stands in
        map: (p) => ({
            provider_user_id: String(p.sub),
            username: p.preferred_username || p.nickname || null,
            display_name: String(p.nickname || p.preferred_username || 'Roblox account'),
            avatar_url: p.picture || null,
            email: p.email || null,
            email_verified: p.email_verified === true,
        }),
    },
    // ── 11. Facebook / Meta: OIDC-shaped, the token exchange is Graph; app-scoped id ──
    {
        id: 'facebook', name: 'Facebook', kind: 'oidc', rank: 11,
        issuer: 'https://www.facebook.com',
        scopes: ['openid', 'public_profile', 'email'],
        pkce: 'required',
        authMethod: 'client_secret_post',
        emailVerifiedFrom: 'none',           // no flag; the address is the account's primary, never proof
        fields: ['client_id', 'client_secret'],
        icon: { brand: 'facebook' },
        map: (p) => ({
            provider_user_id: String(p.sub || p.id),
            username: null,
            display_name: String(p.name || 'Facebook account'),
            avatar_url: p.picture || (p.picture && p.picture.data ? p.picture.data.url : null),
            email: p.email || null,
            email_verified: false,
        }),
    },
];

const BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]));

/** Every field a provider needs from the owner, in the order a row shows them. */
const fieldsOf = (p) => [...(p.fields || [])];

/** Whether the provider's owner inputs are all set: `value(id, field)` returns the stored value or ''. A field with a
 *  default (Microsoft's tenant) is not required: the default stands until the owner changes it. */
function configured(p, value) {
    const defaults = p.defaults || {};
    return fieldsOf(p).filter((f) => !(p.optionalFields || []).includes(f) && defaults[f] === undefined).every((f) => {
        const v = value(p.id, f);
        return v !== null && v !== undefined && String(v).trim() !== '';
    });
}

/** The redirect URI a provider's app must list (the row's description shows this exact string). */
const redirectUri = (baseUrl, id) => `${String(baseUrl).replace(/\/+$/, '')}/api/auth/connect/${id}/callback`;

/** The owner input rows, in the order the Setup page lists them (rank first: most used at the top). */
const ownerFields = () => {
    const rows = [];
    for (const p of [...PROVIDERS].sort((a, b) => a.rank - b.rank)) {
        for (const field of fieldsOf(p)) {
            rows.push({ provider: p.id, name: p.name, field, rank: p.rank, owner: OWNER(p.id, p.name) });
        }
    }
    return rows;
};

module.exports = { PROVIDERS, BY_ID, fieldsOf, configured, redirectUri, ownerFields, OWNER };
