'use strict';

let _db = null;
let _publicKey = null;

let webpush;
try {
    webpush = require('web-push');
} catch {
    console.warn('[push] web-push not installed — browser push notifications disabled');
}

/**
 * Initialize VAPID keys. Generates a new keypair on first run and stores in site_settings.
 * @param {object} db - better-sqlite3 Database instance
 */
function publicFromPrivate(privateKey) {
    const ecdh = require('crypto').createECDH('prime256v1');
    ecdh.setPrivateKey(Buffer.from(String(privateKey), 'base64url'));
    return ecdh.getPublicKey().toString('base64url');
}

function initVapid(db) {
    _db = db;
    if (!webpush) return;
    const upsert = db.prepare('INSERT OR REPLACE INTO site_settings (key, value, type) VALUES (?, ?, ?)');
    // Both are environment-first (VAPID_PRIVATE_KEY / VAPID_PUBLIC_KEY, server/secrets.js), else site_settings.
    let publicKey = db.getSetting('vapid_public_key');
    let privateKey = db.getSetting('vapid_private_key');

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
        upsert.run('vapid_public_key', publicKey, 'secret');
        upsert.run('vapid_private_key', privateKey, 'secret');
        _publicKey = publicKey;
        console.log('[push] Generated new VAPID keypair');
    }

    const contactEmail = db.getSetting('vapid_contact_email') || 'mailto:admin@openvibe.live';
    webpush.setVapidDetails(contactEmail, publicKey, privateKey);
    console.log('[push] VAPID initialized');
}

/**
 * Get the public VAPID key for client subscription.
 */
function getPublicKey() {
    return _publicKey || _db?.getSetting('vapid_public_key') || null;
}

/**
 * Save a push subscription for a user.
 */
function subscribe(userId, subscription) {
    if (!_db) throw new Error('Push service not initialized');
    if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
        throw new Error('Invalid push subscription');
    }
    const stmt = _db.prepare(`
        INSERT OR REPLACE INTO push_subscriptions (user_id, endpoint, keys_p256dh, keys_auth, user_agent, created_at)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);
    stmt.run(userId, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth, subscription.userAgent || null);
}

/**
 * Remove a push subscription.
 */
function unsubscribe(userId, endpoint) {
    if (!_db) return;
    _db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(userId, endpoint);
}

/**
 * Remove all subscriptions for a user.
 */
function unsubscribeAll(userId) {
    if (!_db) return;
    _db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(userId);
}

/**
 * Send a push notification to all subscriptions for a user.
 * @param {number} userId
 * @param {{ title: string, message: string, icon?: string, url?: string, tag?: string }} payload
 */
async function sendPush(userId, payload) {
    if (!webpush || !_db) return;

    const subs = _db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId);
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
        try {
            await webpush.sendNotification({
                endpoint: sub.endpoint,
                keys: { p256dh: sub.keys_p256dh, auth: sub.keys_auth },
            }, pushPayload);
        } catch (err) {
            if (err.statusCode === 404 || err.statusCode === 410) {
                stale.push(sub.id);
            }
        }
    }));

    // Cleanup stale subscriptions
    if (stale.length) {
        const placeholders = stale.map(() => '?').join(',');
        _db.prepare(`DELETE FROM push_subscriptions WHERE id IN (${placeholders})`).run(...stale);
    }
}

/**
 * Send push to multiple users (bulk).
 */
async function sendPushBulk(userIds, payload) {
    if (!webpush || !userIds.length) return;
    // Fire all in parallel, don't block
    await Promise.allSettled(userIds.map(uid => sendPush(uid, payload)));
}

module.exports = { initVapid, getPublicKey, subscribe, unsubscribe, unsubscribeAll, sendPush, sendPushBulk };
