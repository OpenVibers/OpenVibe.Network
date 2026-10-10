'use strict';
const https = require('https');
const net = require('net');
const { isPublicAddress, isInternalName, normalizeHost, safeLookup } = require('openvibe-shared/egress');

let _db = null;
let _publicKey = null;

/**
 * A subscription's endpoint is a URL the browser hands us, so anyone signed in chooses where Network
 * POSTs. Only https, no credentials, and a public host: an IP literal must be a public address, a name
 * must not be an internal one (localhost, *.internal, ...). Names are checked again where the
 * connection is made (pushAgent), so a DNS answer cannot turn internal after this check.
 */
function endpointAllowed(endpoint) {
    let u;
    try { u = new URL(String(endpoint)); } catch { return false; }
    if (u.protocol !== 'https:' || u.username || u.password) return false;
    const host = normalizeHost(u.hostname);
    if (net.isIP(host)) return isPublicAddress(host);
    return !isInternalName(host);
}
// Every push connects through safeLookup: it fails unless every DNS answer is a public address, and the
// socket connects to the address it checked (no second resolution, no rebinding).
const pushAgent = new https.Agent({ lookup: safeLookup, keepAlive: true, maxSockets: 32 });

let webpush;
try {
    webpush = require('web-push');
} catch {
    console.warn('[push] web-push not installed — browser push notifications disabled');
}

/**
 * Initialize VAPID keys. Generates a new keypair on first run and stores in site_settings.
 * @param {object} db - service database handle
 */
function publicFromPrivate(privateKey) {
    const ecdh = require('crypto').createECDH('prime256v1');
    ecdh.setPrivateKey(Buffer.from(String(privateKey), 'base64url'));
    return ecdh.getPublicKey().toString('base64url');
}

async function initVapid(db) {
    _db = db;
    if (!webpush) return;
    const upsert = db.prepare('INSERT INTO site_settings (key, value, type) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, type = excluded.type');
    // Both are environment-first (VAPID_PRIVATE_KEY / VAPID_PUBLIC_KEY, server/secrets.js), else site_settings.
    let publicKey = await db.getSetting('vapid_public_key');
    let privateKey = await db.getSetting('vapid_private_key');

    // The public key is derived from the private one, so a private key alone (or a stale public key
    // beside it) still gives a matching pair; a new pair is made only when there is no private key.
    if (privateKey) {
        try {
            const derived = publicFromPrivate(privateKey);
            if (publicKey && publicKey !== derived) console.warn('[push] vapid_public_key does not match the private key; using the key derived from it');
            publicKey = derived;
        } catch (err) { console.warn('[push] VAPID private key unreadable:', err.message); }
    }
    _publicKey = publicKey || null;

    if (!publicKey || !privateKey) {
        const keys = webpush.generateVAPIDKeys();
        publicKey = keys.publicKey;
        privateKey = keys.privateKey;
        await upsert.run('vapid_public_key', publicKey, 'secret');
        await upsert.run('vapid_private_key', privateKey, 'secret');
        _publicKey = publicKey;
        console.log('[push] Generated new VAPID keypair');
    }

    const contactEmail = await db.getSetting('vapid_contact_email') || 'mailto:admin@openvibe.live';
    webpush.setVapidDetails(contactEmail, publicKey, privateKey);
    console.log('[push] VAPID initialized');
}

/**
 * Get the public VAPID key for client subscription.
 */
async function getPublicKey() {
    return _publicKey || await _db?.getSetting('vapid_public_key') || null;
}

/**
 * Save a push subscription for a user.
 */
async function subscribe(userId, subscription) {
    if (!_db) throw new Error('Push service not initialized');
    if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
        throw new Error('Invalid push subscription');
    }
    if (String(subscription.endpoint).length > 1000 || !endpointAllowed(subscription.endpoint)) throw new Error('Invalid push subscription endpoint');
    const stmt = _db.prepare(`
        INSERT INTO push_subscriptions (user_id, endpoint, keys_p256dh, keys_auth, user_agent, created_at)
        VALUES (?, ?, ?, ?, ?, ov_now())
        ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, keys_p256dh = excluded.keys_p256dh, keys_auth = excluded.keys_auth, user_agent = excluded.user_agent, created_at = excluded.created_at
    `);
    await stmt.run(userId, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth, subscription.userAgent || null);
}

/**
 * Remove a push subscription.
 */
async function unsubscribe(userId, endpoint) {
    if (!_db) return;
    await _db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(userId, endpoint);
}

/**
 * Remove all subscriptions for a user.
 */
async function unsubscribeAll(userId) {
    if (!_db) return;
    await _db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(userId);
}

/**
 * Send a push notification to all subscriptions for a user.
 * @param {number} userId
 * @param {{ title: string, message: string, icon?: string, url?: string, tag?: string }} payload
 */
async function sendPush(userId, payload) {
    if (!webpush || !_db) return;

    const subs = await _db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId);
    if (!subs.length) return;

    const pushPayload = JSON.stringify({
        title: payload.title || 'OpenVibe.Live',
        body: payload.message || '',
        icon: payload.icon || '/assets/img/logo-192.png',
        url: payload.url || 'https://openvibe.live',
        tag: payload.tag || payload.type || 'notification',
    });

    const stale = [];
    await Promise.allSettled(subs.map(async (sub) => {
        if (!endpointAllowed(sub.endpoint)) { stale.push(sub.id); return; }   // stored before the rule existed
        try {
            await webpush.sendNotification({
                endpoint: sub.endpoint,
                keys: { p256dh: sub.keys_p256dh, auth: sub.keys_auth },
            }, pushPayload, { agent: pushAgent, timeout: 10000 });
        } catch (err) {
            if (err.statusCode === 404 || err.statusCode === 410) {
                stale.push(sub.id);
            }
        }
    }));

    // Cleanup stale subscriptions
    if (stale.length) {
        const placeholders = stale.map(() => '?').join(',');
        await _db.prepare(`DELETE FROM push_subscriptions WHERE id IN (${placeholders})`).run(...stale);
    }
}

/**
 * Send push to multiple users (bulk).
 */
async function sendPushBulk(userIds, payload) {
    if (!webpush || !userIds.length) return;
    // Fire all in parallel, don't block
    await Promise.allSettled(userIds.map(async uid => await sendPush(uid, payload)));
}

module.exports = { initVapid, getPublicKey, subscribe, unsubscribe, unsubscribeAll, sendPush, sendPushBulk, endpointAllowed };
