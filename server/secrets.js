'use strict';
// ═══════════════════════════════════════════════════════════════
// Provider secrets: the environment only (roadmap §18.2(12): secrets are environment references, never
// plaintext reusable provider keys in a database).
//
// Each secret Network uses has a named environment variable (set in /etc/openvibe/network.env). That is the
// only place it is read from: a site_settings row of the same key is ignored, the admin UI shows the secret
// as "set in the environment" or "not set" and never stores one. (The database fallback and its copy-out
// script were retired on 2026-10-10, once production held no database copy of any secret.) The companions
// below are not secret: they are read environment-first with the database as a fallback.
//
// db.getSetting() (server/db/database.js) goes through value() for these keys, so every reader (email,
// Resend webhook, Discord bot and account linking, web push) gets this without its own code.
// ═══════════════════════════════════════════════════════════════

const SECRETS = [
    { key: 'resend_api_key', env: 'RESEND_API_KEY', use: 'email delivery (Resend API key)' },
    { key: 'resend_webhook_secret', env: 'RESEND_WEBHOOK_SECRET', use: 'Resend delivery webhooks (Svix signing secret, whsec_...)' },
    { key: 'discord_bot_token', env: 'DISCORD_BOT_TOKEN', use: 'Discord bot (go-live and system alerts)' },
    { key: 'discord_oauth_client_secret', env: 'DISCORD_OAUTH_CLIENT_SECRET', use: 'Discord account linking (OAuth client secret)' },
    { key: 'vapid_private_key', env: 'VAPID_PRIVATE_KEY', use: 'web push (VAPID private key; must stay the pair of vapid_public_key)' },
    { key: 'github_token', env: 'GITHUB_TOKEN', use: 'GitHub API, read-only public repositories (registry library versions; OpenVibe.Blog\'s network changelog)' },
];

// Read environment-first too, but not secret: never blanked, only listed.
const COMPANIONS = [
    { key: 'vapid_public_key', env: 'VAPID_PUBLIC_KEY', use: 'web push (VAPID public key, served to browsers; the pair of VAPID_PRIVATE_KEY)' },
];

// Secret-looking settings Network stores but never reads. The Net tools tokens are read by the Tools
// gateway from its own environment (NET_IPINFO_TOKEN, NET_GLOBALPING_TOKEN in tools.env); the SES keys
// are from the email provider before Resend.
const UNUSED = new Map([
    ['net.ipinfo_token', 'not read by Network (the Tools gateway reads NET_IPINFO_TOKEN from tools.env)'],
    ['net.globalping_token', 'not read by Network (the Tools gateway reads NET_GLOBALPING_TOKEN from tools.env)'],
    ['ses_access_key_id', 'not read by Network (Amazon SES, replaced by Resend)'],
    ['ses_secret_access_key', 'not read by Network (Amazon SES, replaced by Resend)'],
]);

const BY_KEY = new Map([...SECRETS, ...COMPANIONS].map(s => [s.key, s]));

/** The environment value for a managed key, or null (unset or blank). */
function fromEnv(key, env = process.env) {
    const s = BY_KEY.get(key);
    if (!s) return null;
    const v = env[s.env];
    return typeof v === 'string' && v.trim() ? v.trim() : null;
}

const isManaged = (key) => BY_KEY.has(key);
const isSecret = (key) => SECRETS.some(s => s.key === key);
const envName = (key) => (BY_KEY.get(key) || {}).env || null;

async function dbValue(db, key) {
    try { const r = await db.prepare('SELECT value FROM site_settings WHERE key = ?').get(key); return r && r.value ? String(r.value) : ''; } catch { return ''; }
}

/** 'env' | 'database' | 'unset' for a managed key; a secret is never 'database' (environment-only). */
async function source(db, key, env = process.env) {
    if (fromEnv(key, env) !== null) return 'env';
    if (isSecret(key)) return 'unset';
    return (await dbValue(db, key)) ? 'database' : 'unset';
}

/** Where each secret comes from, by name only: [{ key, env, source, database_copy, use }]. Never values. */
async function report(db, env = process.env) {
    return await Promise.all([...SECRETS, ...COMPANIONS].map(async s => ({
        key: s.key, env: s.env, secret: isSecret(s.key), source: await source(db, s.key, env),
        database_copy: !!(await dbValue(db, s.key)), use: s.use,
    })));
}

/** One boot line: "resend_api_key=env discord_bot_token=unset ..." (names and sources only). */
async function summary(db, env = process.env) {
    return (await report(db, env)).filter(r => r.secret).map(r => `${r.key}=${r.source}`).join(' ');
}

module.exports = { SECRETS, COMPANIONS, UNUSED, fromEnv, isManaged, isSecret, envName, source, report, summary };
