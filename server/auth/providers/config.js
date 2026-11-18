'use strict';
/**
 * The owner's sign-in settings (plan §AB.20): one namespace, `network.signin`, in Network's own configuration journal
 * (openvibe-shared/config), the same store the rest of Network's settings live in (server/admin/site-config.js).
 *
 * Every provider contributes rows named `<id>.<field>`:
 *   google.client_id, google.client_secret, google.enabled
 *   apple.services_id, apple.team_id, apple.key_id, apple.private_key, apple.enabled
 *   steam.api_key (optional), steam.enabled
 * The secret-class fields (client_secret, private_key, api_key) are write-only: the shared store seals them under
 * OV_CONFIG_KEKS and shows a fingerprint marker, never the value, exactly as it does for every other secret. Each row
 * carries `x-owner-input` { group: 'sign-in-apps', unlocks, get_it_at, get_it_how } so the owner's Setup tab lists it
 * with the others, and its description carries the redirect URI to copy into that provider's app.
 *
 * A provider is offered on the sign-in page only when `configured()` holds: every required field set and its
 * `<id>.enabled` switch not off.
 *
 *   const signin = await forDb(db, baseUrl)
 *   signin.values('google')          → { client_id, client_secret, enabled }
 *   signin.enabled()                 → the providers to draw on the page, most used first
 */
const config = require('openvibe-shared/config');
const presets = require('./presets');

const NAMESPACE = 'network.signin';
const SECRET_FIELDS = new Set(['client_secret', 'private_key', 'api_key']);

const base = (baseUrl) => String(baseUrl || 'https://openvibe.network').replace(/\/+$/, '');

/** The schema the Setup tab reads: one property per provider field, the secret ones marked, the rest typed. */
function schemaFor(baseUrl) {
    const properties = {};
    for (const p of [...presets.PROVIDERS].sort((a, b) => a.rank - b.rank)) {
        const redirect = presets.redirectUri(base(baseUrl), p.id);
        const owner = { group: 'sign-in-apps', unlocks: `Sign in with ${p.name}`, get_it_at: presets.OWNER(p.id, p.name).get_it_at, get_it_how: presets.OWNER(p.id, p.name).get_it_how };
        for (const field of presets.fieldsOf(p)) {
            const secret = SECRET_FIELDS.has(field);
            // Test sits on the one row that stands for the app: its client id (Steam's Web API key is the only row a
            // keyless provider has). The tester reads every stored value of the provider, never just this one.
            const testable = field === 'client_id' || (p.kind === 'openid2' && field === 'api_key');
            properties[`${p.id}.${field}`] = {
                type: 'string',
                title: `${p.name} ${TITLES[field] || field}`,
                description: `${secret ? `The secret ${p.name} gave the OpenVibe app. It is sealed and never shown again. ` : ''}`
                    + `Redirect URI to copy into the ${p.name} app: ${redirect}`,
                'x-owner-input': testable ? { ...owner, test: true } : owner,
            };
        }
        if (p.defaults) {
            for (const [field, value] of Object.entries(p.defaults)) {
                if (properties[`${p.id}.${field}`] !== undefined) properties[`${p.id}.${field}`].default = value;
            }
        }
        properties[`${p.id}.enabled`] = {
            type: 'boolean',
            title: `Sign in with ${p.name}`,
            description: `Shows ${p.name} on the sign-in page when its keys are set. Off hides it without deleting the keys.`,
            default: true,
            'x-owner-input': owner,
        };
    }
    // The master switch: the owner's one lever that turns every provider off (a new sign-in route is a security
    // change; this is what closes it without deleting any keys).
    properties.signin_switch = {
        type: 'boolean',
        default: true,
        title: 'Sign-in with other apps',
        description: 'Off hides every provider button and refuses every start, without deleting any keys.',
        'x-owner-input': { group: 'sign-in-apps', unlocks: 'Sign in with Google, Discord, Twitch and the rest', get_it_how: 'One switch for all of them: sign in with the apps below, or hide them all at once.' },
    };
    return Object.freeze({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        title: 'Sign in',
        description: 'The apps people sign in with. Each provider is offered once its keys are set and its switch is on.',
        type: 'object',
        additionalProperties: false,
        properties,
    });
}
const TITLES = {
    client_id: 'client id', client_secret: 'client secret', services_id: 'Services ID', team_id: 'Team ID',
    key_id: 'Key ID', private_key: 'private key (.p8 contents)', api_key: 'Web API key', tenant: 'tenant (common for everyone)',
};

const byDb = new WeakMap();

/** The store for one database handle (one per boot: the journal is loaded once, as site-config's is). */
async function forDb(db, baseUrl) {
    const url = base(baseUrl);
    const hit = byDb.get(db);
    if (hit && hit.baseUrl === url) return hit.ready;
    const ready = config.createConfigStore({
        db, service: 'network', namespace: NAMESPACE, schema: schemaFor(url),
        classify: (key) => (SECRET_FIELDS.has(String(key).split('.').pop()) ? 'secret' : 'internal'),
        log: { info: (m) => console.log(`[SignIn] ${m}`), warn: (m) => console.warn(`[SignIn] ${m}`), error: (m) => console.error(`[SignIn] ${m}`) },
    });
    byDb.set(db, { baseUrl: url, ready });
    try { return await ready; } catch (err) { byDb.delete(db); throw err; }
}

/** One provider's stored values, by field name. Never includes another provider's. */
function valuesOf(store, id) {
    const all = store.get() || {};
    const out = {};
    for (const p of presets.PROVIDERS) if (p.id === id) for (const f of presets.fieldsOf(p)) out[f] = all[`${id}.${f}`];
    return out;
}

/** Whether a provider may be offered: every required field set, and its switch not off. */
function isEnabled(store, id) {
    const p = presets.BY_ID.get(id);
    if (!p) return false;
    const all = store.get() || {};
    if (all[`${id}.enabled`] === false) return false;
    return presets.configured(p, (providerId, field) => (all[`${providerId}.${field}`] === undefined ? '' : all[`${providerId}.${field}`]));
}

/** The providers the sign-in page draws, most used first (the preset rank). */
function enabledProviders(store) {
    return [...presets.PROVIDERS].sort((a, b) => a.rank - b.rank)
        .filter((p) => isEnabled(store, p.id))
        .map((p) => ({
            id: p.id, name: p.name, rank: p.rank, kind: p.kind,
            icon: p.icon || { brand: null, icon: 'globe' },
            // Apple needs form_post; every other flow is a plain GET redirect.
            formPost: p.responseMode === 'form_post',
        }));
}

module.exports = { forDb, valuesOf, isEnabled, enabledProviders, schemaFor, NAMESPACE, SECRET_FIELDS };
