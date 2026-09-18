'use strict';

// ═══════════════════════════════════════════════════════════════
// openvibe.network — Internal Server-to-Server API
// Used by OpenVibe.Live (3000), OpenVibe.Tools (4001),
// OpenVibe.Games (8000), and OpenVibe.Media (4100) to verify
// tokens, sync users, move OpenCoins, and fetch shared data.
// Protected by X-Internal-Key header.
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const router = express.Router();
const urlRegistry = require('../url-registry');
const wallet = require('../coins/wallet');

function getDb(req) { return req.app.locals.db; }
function getConfig(req) { return req.app.locals.config; }

// ── Internal Key Middleware ──────────────────────────────────
function requireInternalKey(req, res, next) {
    const key = req.headers['x-internal-key'];
    const config = getConfig(req);
    if (!key || key !== config.internalKey) {
        return res.status(403).json({ error: 'Invalid or missing internal key' });
    }
    next();
}

router.use(requireInternalKey);

// ── Verify Token ─────────────────────────────────────────────
// Other services call this to validate an access token and get user data.
// Avoids each service needing the public key locally (though they can — this is a convenience).
const jwt = require('jsonwebtoken');

router.post('/verify-token', (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'token required' });

    const publicKey = req.app.locals.publicKey;
    const config = getConfig(req);
    const algorithm = publicKey.includes('BEGIN') ? 'RS256' : 'HS256';

    try {
        const decoded = jwt.verify(token, publicKey, {
            algorithms: [algorithm],
            issuer: config.jwt.issuer
        });
        const db = getDb(req);
        const user = db.prepare('SELECT id, username, display_name, role, avatar_url, profile_color AS color FROM users WHERE id = ?').get(decoded.sub || decoded.id);
        res.json({ valid: true, decoded, user: user || null });
    } catch (err) {
        res.json({ valid: false, error: err.message });
    }
});

// ── Get User by ID ───────────────────────────────────────────
router.get('/users/:id', (req, res) => {
    const db = getDb(req);
    const user = db.prepare(`
        SELECT id, username, display_name, role, avatar_url, profile_color AS color, bio, created_at
        FROM users WHERE id = ?
    `).get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user });
});

// ── Lookup User by Username ──────────────────────────────────
router.get('/users/by-username/:username', (req, res) => {
    const db = getDb(req);
    const user = db.prepare(`
        SELECT id, username, display_name, role, avatar_url, profile_color AS color, bio, created_at
        FROM users WHERE username = ?
    `).get(req.params.username.toLowerCase());
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user });
});

// ── Bulk User Lookup ─────────────────────────────────────────
router.post('/users/bulk', (req, res) => {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids array required' });
    if (ids.length > 200) return res.status(400).json({ error: 'Max 200 ids per request' });

    const db = getDb(req);
    const placeholders = ids.map(() => '?').join(',');
    const users = db.prepare(`
        SELECT id, username, display_name, role, avatar_url, profile_color AS color
        FROM users WHERE id IN (${placeholders})
    `).all(...ids);
    res.json({ users });
});

// ── Get User Theme Preference ────────────────────────────────
router.get('/users/:id/theme', (req, res) => {
    const db = getDb(req);
    const prefs = db.prepare('SELECT theme_id, custom_theme_variables FROM user_preferences WHERE user_id = ?').get(req.params.id);
    if (!prefs) return res.json({ theme_id: 'vibe', custom_variables: null });
    let custom = null;
    try { custom = prefs.custom_theme_variables ? JSON.parse(prefs.custom_theme_variables) : null; } catch {}
    res.json({ theme_id: prefs.theme_id, custom_variables: custom });
});

// ── Sync Linked Account ──────────────────────────────────────
// When a user connects their OpenVibe.Live or OpenVibe.Games account,
// the service reports the link here.
router.post('/link-account', (req, res) => {
    const { user_id, service, service_user_id, service_username, avatar_url, display_name } = req.body;
    if (!user_id || !service || !service_user_id) {
        return res.status(400).json({ error: 'user_id, service, and service_user_id required' });
    }

    const db = getDb(req);
    db.prepare(`
        INSERT INTO linked_accounts (user_id, service, service_user_id, service_username, linked_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id, service) DO UPDATE SET
            service_user_id = ?,
            service_username = ?,
            linked_at = CURRENT_TIMESTAMP
    `).run(user_id, service, service_user_id, service_username || null, service_user_id, service_username || null);

    // People set their picture on the site they use (usually Live). When the network account has none, adopt it,
    // so every other site shows the same face. Never overwrites a picture or name the user set here, and only
    // accepts https URLs on our own sites.
    try {
        const me = db.prepare('SELECT avatar_url, display_name, username FROM users WHERE id = ?').get(user_id);
        if (me) {
            let okAvatar = null;
            try { const u = new URL(String(avatar_url || '')); if (u.protocol === 'https:' && /(^|\.)openvibe\.(live|media|network|games|community|tools)$/.test(u.hostname) && String(avatar_url).length < 500) okAvatar = u.toString(); } catch { /* not a URL */ }
            if (okAvatar && !me.avatar_url) db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').run(okAvatar, user_id);
            const name = String(display_name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 60);
            if (name && (!me.display_name || me.display_name === me.username)) db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(name, user_id);
        }
    } catch (err) { console.warn('[Internal] profile adopt failed:', err.message); }

    res.json({ success: true });
});

// ── Get Linked Accounts ──────────────────────────────────────
router.get('/users/:id/linked-accounts', (req, res) => {
    const db = getDb(req);
    const accounts = db.prepare('SELECT service, service_user_id, service_username, linked_at FROM linked_accounts WHERE user_id = ?').all(req.params.id);
    res.json({ accounts });
});

// ── Audit Log ────────────────────────────────────────────────
router.post('/audit', (req, res) => {
    const { user_id, action, details, ip } = req.body;
    if (!action) return res.status(400).json({ error: 'action required' });
    const db = getDb(req);
    db.prepare('INSERT INTO audit_log (user_id, action, details, ip) VALUES (?, ?, ?, ?)').run(user_id || null, action, details || null, ip || null);
    res.json({ success: true });
});

// ── Health / Stats ───────────────────────────────────────────
router.get('/stats', (req, res) => {
    const db = getDb(req);
    const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
    const themeCount = db.prepare('SELECT COUNT(*) as count FROM themes').get().count;
    const linkedCount = db.prepare('SELECT COUNT(*) as count FROM linked_accounts').get().count;
    const notifCount = db.prepare('SELECT COUNT(*) as count FROM notifications').get().count;
    res.json({ users: userCount, themes: themeCount, linked_accounts: linkedCount, notifications: notifCount });
});

router.get('/url-registry/resolved', (req, res) => {
    try {
        const db = getDb(req);
        const resolved = urlRegistry.getResolvedRegistry(db, process.env);
        res.json({ ok: true, registry: resolved });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════
// OpenCoins Wallet (server-to-server)
// Atomic better-sqlite3 transactions with idempotency_key dedupe.
// Repeating a key returns the original result (no double-apply).
// user_id is ALWAYS the Network (SSO) user id.
// ═══════════════════════════════════════════════════════════════

function handleWalletError(res, err) {
    if (err instanceof wallet.WalletError) {
        return res.status(err.status).json(err.body);
    }
    console.error('[Internal] Wallet error:', err);
    return res.status(500).json({ error: 'wallet_internal_error' });
}

// ── GET /internal/coins/stats ────────────────────────────────
// Site-wide OpenCoins totals for public stat displays (OpenVibe.Live's home hero).
// Summing the whole ledger is cheap at our size but pointless to repeat per pageview,
// so the answer is held for a minute.
let _coinStats = { at: 0, data: null };
router.get('/coins/stats', (req, res) => {
    try {
        if (_coinStats.data && Date.now() - _coinStats.at < 60_000) return res.json(_coinStats.data);
        const db = getDb(req);
        const one = (sql) => { try { return db.prepare(sql).get()?.n || 0; } catch { return 0; } };
        const data = {
            earned: one('SELECT COALESCE(SUM(delta), 0) AS n FROM coin_transactions WHERE delta > 0'),
            spent: one('SELECT COALESCE(-SUM(delta), 0) AS n FROM coin_transactions WHERE delta < 0'),
            circulating: one('SELECT COALESCE(SUM(balance), 0) AS n FROM wallets'),
            holders: one('SELECT COUNT(*) AS n FROM wallets WHERE balance > 0'),
            transactions: one('SELECT COUNT(*) AS n FROM coin_transactions'),
            // Rolling windows so the display can say whether the economy is speeding up. Same
            // shape the Live stats use: this seven days, and the seven before it.
            recent: {
                earned: {
                    w: one("SELECT COALESCE(SUM(delta), 0) AS n FROM coin_transactions WHERE delta > 0 AND created_at >= datetime('now','-7 days')"),
                    pw: one("SELECT COALESCE(SUM(delta), 0) AS n FROM coin_transactions WHERE delta > 0 AND created_at >= datetime('now','-14 days') AND created_at < datetime('now','-7 days')"),
                },
                spent: {
                    w: one("SELECT COALESCE(-SUM(delta), 0) AS n FROM coin_transactions WHERE delta < 0 AND created_at >= datetime('now','-7 days')"),
                    pw: one("SELECT COALESCE(-SUM(delta), 0) AS n FROM coin_transactions WHERE delta < 0 AND created_at >= datetime('now','-14 days') AND created_at < datetime('now','-7 days')"),
                },
                holders: {
                    w: one("SELECT COUNT(DISTINCT user_id) AS n FROM coin_transactions WHERE created_at >= datetime('now','-7 days')"),
                    pw: one("SELECT COUNT(DISTINCT user_id) AS n FROM coin_transactions WHERE created_at >= datetime('now','-14 days') AND created_at < datetime('now','-7 days')"),
                },
            },
        };
        _coinStats = { at: Date.now(), data };
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: String(err.message || err) });
    }
});

// ── POST /internal/coins/credit ──────────────────────────────
// Body: { user_id, app_id, amount (positive int), reason, ref?, idempotency_key }
// → { balance }
router.post('/coins/credit', (req, res) => {
    try {
        const { user_id, app_id, amount, reason, ref, idempotency_key } = req.body || {};
        const result = wallet.credit(getDb(req), { user_id, app_id, amount, reason, ref, idempotency_key });
        res.json({ balance: result.balance });
    } catch (err) {
        handleWalletError(res, err);
    }
});

// ── POST /internal/coins/debit ───────────────────────────────
// Same body → { balance }; insufficient funds → 409 { error: 'insufficient_funds', balance }
router.post('/coins/debit', (req, res) => {
    try {
        const { user_id, app_id, amount, reason, ref, idempotency_key } = req.body || {};
        const result = wallet.debit(getDb(req), { user_id, app_id, amount, reason, ref, idempotency_key });
        res.json({ balance: result.balance });
    } catch (err) {
        handleWalletError(res, err);
    }
});

// ── POST /internal/coins/transfer ────────────────────────────
// Body: { from_user_id, to_user_id, app_id, amount, reason, ref?, idempotency_key }
// → { from_balance, to_balance } (atomic)
router.post('/coins/transfer', (req, res) => {
    try {
        const { from_user_id, to_user_id, app_id, amount, reason, ref, idempotency_key } = req.body || {};
        const result = wallet.transfer(getDb(req), { from_user_id, to_user_id, app_id, amount, reason, ref, idempotency_key });
        res.json({ from_balance: result.from_balance, to_balance: result.to_balance });
    } catch (err) {
        handleWalletError(res, err);
    }
});

// ═══════════════════════════════════════════════════════
// Stream-Live Event Handler
// OpenVibe.Live calls this when a stream goes live.
// Handles: Discord alerts (via bot), push notifications to
// followers + "all streamer" subscribers.
// ═══════════════════════════════════════════════════════════════

router.post('/events/stream-live', async (req, res) => {
    const { streamer, stream, follower_network_ids } = req.body;
    if (!streamer?.username || !stream?.id) {
        return res.status(400).json({ error: 'streamer and stream objects required' });
    }

    const results = { discord: null, notifications: null };

    // ── Per-streamer rate limit (persisted — survives deploys) ───────────────────
    // A streamer flapping off/on (reconnects, restarts, OBS hiccups) must not re-announce
    // every time. One fan-out per streamer per `stream_live_cooldown_min` (default 60) and
    // at most `stream_live_daily_cap` (default 8) per rolling 24h — gating inbox, push,
    // email AND Discord. `force:true` (admin/manual) bypasses the cooldown, not the cap.
    {
        const db = getDb(req);
        try {
            db.exec(`CREATE TABLE IF NOT EXISTS stream_live_announcements (
                id INTEGER PRIMARY KEY AUTOINCREMENT, streamer_key TEXT NOT NULL, stream_id TEXT, sent_at DATETIME DEFAULT CURRENT_TIMESTAMP);
                CREATE INDEX IF NOT EXISTS idx_sla_key ON stream_live_announcements(streamer_key, sent_at DESC)`);
        } catch { /* */ }
        const key = String(streamer.network_id || streamer.id || streamer.username).toLowerCase();
        const cooldownMin = Math.max(1, parseInt(db.getSetting('stream_live_cooldown_min'), 10) || 60);
        const dailyCap = Math.max(1, parseInt(db.getSetting('stream_live_daily_cap'), 10) || 8);
        const last = db.prepare('SELECT sent_at FROM stream_live_announcements WHERE streamer_key = ? ORDER BY sent_at DESC LIMIT 1').get(key);
        const today = db.prepare("SELECT COUNT(*) AS c FROM stream_live_announcements WHERE streamer_key = ? AND sent_at > datetime('now','-1 day')").get(key)?.c || 0;
        const lastMs = last ? new Date(String(last.sent_at).replace(' ', 'T') + 'Z').getTime() : 0;
        const sinceMin = last ? (Date.now() - lastMs) / 60000 : Infinity;
        if (today >= dailyCap) {
            console.log(`[StreamLive] ${streamer.username}: daily cap (${dailyCap}) reached — not announcing`);
            return res.json({ ok: true, skipped: true, reason: 'daily-cap', announced_today: today, cap: dailyCap });
        }
        if (!req.body.force && sinceMin < cooldownMin) {
            const nextAt = new Date(lastMs + cooldownMin * 60000).toISOString();
            console.log(`[StreamLive] ${streamer.username}: announced ${Math.round(sinceMin)}m ago — cooling down until ${nextAt}`);
            return res.json({ ok: true, skipped: true, reason: 'cooldown', next_allowed_at: nextAt });
        }
        db.prepare('INSERT INTO stream_live_announcements (streamer_key, stream_id) VALUES (?, ?)').run(key, stream.id != null ? String(stream.id) : null);
        db.prepare("DELETE FROM stream_live_announcements WHERE sent_at < datetime('now','-7 days')").run();
    }

    // ── Discord Alert ────────────────────────────────────────
    const discordService = req.app.locals.discordService;
    if (discordService) {
        try {
            results.discord = await discordService.sendLiveAlert(streamer, stream);
        } catch (err) {
            results.discord = { sent: false, reason: 'error', error: err.message };
        }
    }

    // ── Push Notifications to Followers ──────────────────────
    const notifService = req.app.locals.notificationService;
    if (notifService) {
        const db = getDb(req);
        const displayName = streamer.display_name || streamer.username;
        const notifData = {
            type: 'STREAM_LIVE',
            title: `${displayName} is live!`,
            message: stream.title || 'Started streaming',
            icon: '🔴',
            sender_id: streamer.id || null,
            sender_name: displayName,
            sender_avatar: streamer.avatar_url || null,
            service: 'live',
            url: `https://openvibe.live/${streamer.username}`,
            rich_content: {
                thumbnail: streamer.avatar_url || null,
                context: {
                    stream_id: stream.id,
                    username: streamer.username,
                    title: stream.title || 'Started streaming',
                    protocol: stream.protocol || null,
                },
            },
        };

        // The streaming follow graph lives in OpenVibe.Live, keyed by LIVE user ids; Live
        // translates its followers to NETWORK ids via linked_accounts and sends them here.
        // (Network's own `follows` table is a separate, tiny social graph and `streamer.id`
        // is a Live id — the old lookup below silently addressed the wrong accounts.)
        let followerIds = Array.isArray(follower_network_ids)
            ? follower_network_ids.map(Number).filter(n => Number.isInteger(n) && n > 0).slice(0, 20000)
            : [];
        if (!Array.isArray(follower_network_ids)) {
            // Legacy caller: fall back to Network's graph, resolving the streamer's NETWORK id first.
            const link = streamer.id ? db.prepare("SELECT user_id FROM linked_accounts WHERE service = 'live' AND service_user_id = ?").get(String(streamer.id)) : null;
            if (link) followerIds = db.prepare('SELECT follower_id FROM follows WHERE followed_id = ?').all(link.user_id).map(r => r.follower_id);
        }
        // sender_id must be the streamer's NETWORK id for dedupe + "who is this" lookups.
        try {
            const link = streamer.id ? db.prepare("SELECT user_id FROM linked_accounts WHERE service = 'live' AND service_user_id = ?").get(String(streamer.id)) : null;
            if (link) notifData.sender_id = link.user_id;
        } catch { /* keep Live id */ }

        // Find users who opted into "all live" notifications
        const allLiveRows = db.prepare(
            "SELECT user_id FROM notification_preferences WHERE category = 'stream_live_all' AND enabled = 1"
        ).all();
        const allLiveUserIds = allLiveRows.map(r => r.user_id);

        // Merge and deduplicate
        const targetIds = [...new Set([...followerIds, ...allLiveUserIds])];

        if (targetIds.length > 0) {
            try {
                const created = notifService.createBulk(targetIds, notifData);
                results.notifications = { sent: created.length, total: targetIds.length };
            } catch (err) {
                results.notifications = { error: err.message };
            }
        } else {
            results.notifications = { sent: 0, total: 0 };
        }
    }

    res.json({ ok: true, ...results });
});

// ═══════════════════════════════════════════════════════════════
// Cross-Service Notification Push
// Services call these to create notifications for users without
// needing direct DB access.
// ═══════════════════════════════════════════════════════════════

// ── Push Single Notification ─────────────────────────────────
// POST /internal/notifications/push
// Body: { user_id, type, title, message, icon, sender_id, sender_name, sender_avatar, service, url, priority, category, rich_content, expires_at }
router.post('/notifications/push', (req, res) => {
    const notifService = req.app.locals.notificationService;
    if (!notifService) return res.status(503).json({ error: 'Notification service unavailable' });

    const { user_id, ...data } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id required' });

    try {
        const notification = notifService.create({ user_id, ...data });
        if (!notification) return res.json({ ok: true, skipped: true, reason: 'User has category disabled' });
        res.json({ ok: true, notification });
    } catch (err) {
        console.error('[Internal] Notification push error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ── Push Bulk Notifications ──────────────────────────────────
// POST /internal/notifications/push-bulk
// Body: { user_ids: [], type, title, message, ... }
router.post('/notifications/push-bulk', (req, res) => {
    const notifService = req.app.locals.notificationService;
    if (!notifService) return res.status(503).json({ error: 'Notification service unavailable' });

    const { user_ids, ...data } = req.body;
    if (!Array.isArray(user_ids) || user_ids.length === 0) {
        return res.status(400).json({ error: 'user_ids array required' });
    }
    if (user_ids.length > 1000) {
        return res.status(400).json({ error: 'Max 1000 user_ids per request' });
    }

    try {
        const results = notifService.createBulk(user_ids, data);
        res.json({ ok: true, sent: results.length, total: user_ids.length });
    } catch (err) {
        console.error('[Internal] Bulk notification push error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ── Get Unread Count for User ────────────────────────────────
// GET /internal/notifications/unread/:userId
router.get('/notifications/unread/:userId', (req, res) => {
    const notifService = req.app.locals.notificationService;
    if (!notifService) return res.status(503).json({ error: 'Notification service unavailable' });

    try {
        const count = notifService.getUnreadCount(parseInt(req.params.userId));
        res.json({ ok: true, count });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Mark Notifications Read by Type ──────────────────────────
// POST /internal/notifications/mark-read
// Body: { user_id, type, url_pattern? }
router.post('/notifications/mark-read', (req, res) => {
    const notifService = req.app.locals.notificationService;
    if (!notifService) return res.status(503).json({ error: 'Notification service unavailable' });

    const { user_id, type, url_pattern } = req.body;
    if (!user_id || !type) return res.status(400).json({ error: 'user_id and type required' });

    try {
        const changes = notifService.markReadByType(parseInt(user_id), type, url_pattern || null);
        res.json({ ok: true, marked: changes });
    } catch (err) {
        console.error('[Internal] Mark read by type error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ── Resolve User for Notification Context ────────────────────
// POST /internal/notifications/resolve-users
// Body: { usernames: [] }  → returns user IDs + display info
router.post('/notifications/resolve-users', (req, res) => {
    const { usernames } = req.body;
    if (!Array.isArray(usernames) || usernames.length === 0) {
        return res.status(400).json({ error: 'usernames array required' });
    }
    const db = getDb(req);
    const placeholders = usernames.map(() => '?').join(',');
    const users = db.prepare(`
        SELECT id, username, display_name, avatar_url, name_effect, particle_effect
        FROM users WHERE LOWER(username) IN (${placeholders})
    `).all(...usernames.map(u => u.toLowerCase()));
    res.json({ ok: true, users });
});

// ── Issue Token for Linked User ──────────────────────────────
// POST /internal/issue-token
// Body: { user_id }
// Used by first-party services to get an openvibe.network JWT for
// users who logged in via password but have a linked account.
// This enables cross-service features (notifications, themes).
router.post('/issue-token', (req, res) => {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id required' });

    const db = getDb(req);
    const config = getConfig(req);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(user_id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.is_banned) return res.status(403).json({ error: 'User is banned' });

    const privateKey = req.app.locals.privateKey;
    const algorithm = privateKey === req.app.locals.publicKey ? 'HS256' : 'RS256';

    const token = jwt.sign(
        { sub: user.id, username: user.username, role: user.role },
        privateKey,
        { algorithm, expiresIn: config.jwt.accessTokenExpiry, issuer: config.jwt.issuer }
    );

    res.json({ token, user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role, avatar_url: user.avatar_url } });
});

// ═══════════════════════════════════════════════════════════════
// Unified Anon Identity Resolution (cross-service)
// ═══════════════════════════════════════════════════════════════

// ── Resolve Anon by IP ───────────────────────────────────────
// POST /internal/resolve-anon
// Body: { ip }
// Called by first-party services to get or create a unified
// anon identity for a given IP address. Single source of truth.
router.post('/resolve-anon', (req, res) => {
    const { ip } = req.body;
    if (!ip) return res.status(400).json({ error: 'ip required' });

    const db = getDb(req);
    const { v4: uuidv4 } = require('uuid');

    try {
        // Check if this IP already has an anon
        const byIpLog = db.prepare(`
            SELECT a.* FROM anon_users a
            INNER JOIN anon_ip_log l ON l.anon_id = a.id
            WHERE l.ip = ?
            ORDER BY a.id ASC LIMIT 1
        `).get(ip);
        if (byIpLog) {
            db.prepare('UPDATE anon_users SET last_seen = CURRENT_TIMESTAMP WHERE id = ?').run(byIpLog.id);
            db.prepare(`
                UPDATE anon_ip_log SET last_seen = CURRENT_TIMESTAMP
                WHERE anon_id = ? AND ip = ?
            `).run(byIpLog.id, ip);
            return res.json({
                anon_number: byIpLog.anon_number,
                anon_id: `anon_${byIpLog.id}`,
                display_name: byIpLog.display_name || `Anonymous #${byIpLog.anon_number}`,
                username: `anon${byIpLog.anon_number}`,
                is_new: false,
            });
        }

        // Check by creating IP
        const byCreatingIp = db.prepare('SELECT * FROM anon_users WHERE ip = ? ORDER BY id ASC LIMIT 1').get(ip);
        if (byCreatingIp) {
            db.prepare('UPDATE anon_users SET last_seen = CURRENT_TIMESTAMP WHERE id = ?').run(byCreatingIp.id);
            // Ensure IP log entry exists
            try {
                db.prepare('INSERT OR IGNORE INTO anon_ip_log (anon_id, ip) VALUES (?, ?)').run(byCreatingIp.id, ip);
            } catch { /* ok */ }
            return res.json({
                anon_number: byCreatingIp.anon_number,
                anon_id: `anon_${byCreatingIp.id}`,
                display_name: byCreatingIp.display_name || `Anonymous #${byCreatingIp.anon_number}`,
                username: `anon${byCreatingIp.anon_number}`,
                is_new: false,
            });
        }

        // Create new anon
        const maxNum = db.prepare('SELECT MAX(anon_number) as max FROM anon_users').get().max || 0;
        const anonNumber = maxNum + 1;
        const sessionToken = uuidv4();

        const result = db.prepare(
            'INSERT INTO anon_users (anon_number, session_token, ip) VALUES (?, ?, ?)'
        ).run(anonNumber, sessionToken, ip);

        // Log IP
        try {
            db.prepare('INSERT INTO anon_ip_log (anon_id, ip) VALUES (?, ?)').run(result.lastInsertRowid, ip);
        } catch { /* ok */ }

        console.log(`[Internal] New unified anon #${anonNumber} for IP ${ip}`);
        res.json({
            anon_number: anonNumber,
            anon_id: `anon_${result.lastInsertRowid}`,
            display_name: `Anonymous #${anonNumber}`,
            username: `anon${anonNumber}`,
            is_new: true,
        });
    } catch (err) {
        console.error('[Internal] resolve-anon error:', err);
        res.status(500).json({ error: 'Failed to resolve anon identity' });
    }
});

// ── Admin: IP → Anon/Account Lookup ──────────────────────────
// GET /internal/anon-admin?ip=X
// Returns all anonymous identities AND registered accounts
// associated with a given IP address.
router.get('/anon-admin', (req, res) => {
    const { ip } = req.query;
    if (!ip) return res.status(400).json({ error: 'ip query param required' });

    const db = getDb(req);

    try {
        // Get all anons seen from this IP
        const anons = db.prepare(`
            SELECT a.id, a.anon_number, a.display_name, a.ip AS creating_ip,
                   a.total_messages, a.total_commands, a.first_seen, a.last_seen,
                   l.first_seen AS ip_first_seen, l.last_seen AS ip_last_seen
            FROM anon_users a
            INNER JOIN anon_ip_log l ON l.anon_id = a.id
            WHERE l.ip = ?
            ORDER BY a.anon_number ASC
        `).all(ip);

        // Get all registered users who have logged in from this IP
        const users = db.prepare(`
            SELECT DISTINCT u.id, u.username, u.display_name, u.role, u.is_banned,
                   u.anon_number, u.created_at
            FROM users u
            INNER JOIN ip_log il ON il.user_id = u.id
            WHERE il.ip = ?
            ORDER BY u.created_at ASC
        `).all(ip);

        // Get all IPs for each anon (cross-reference)
        const anonIps = {};
        for (const a of anons) {
            const ips = db.prepare('SELECT ip, first_seen, last_seen FROM anon_ip_log WHERE anon_id = ?').all(a.id);
            anonIps[a.anon_number] = ips;
        }

        res.json({
            ip,
            anonymous_identities: anons,
            registered_accounts: users,
            anon_ip_map: anonIps,
        });
    } catch (err) {
        console.error('[Internal] anon-admin error:', err);
        res.status(500).json({ error: 'Failed to lookup IP data' });
    }
});

// ── Admin: List All Anon Identities ──────────────────────────
// GET /internal/anon-list?limit=100&offset=0
router.get('/anon-list', (req, res) => {
    const db = getDb(req);
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const offset = parseInt(req.query.offset) || 0;

    try {
        const total = db.prepare('SELECT COUNT(*) as cnt FROM anon_users').get().cnt;
        const anons = db.prepare(`
            SELECT a.id, a.anon_number, a.display_name, a.ip AS creating_ip,
                   a.total_messages, a.total_commands, a.first_seen, a.last_seen
            FROM anon_users a ORDER BY a.anon_number DESC LIMIT ? OFFSET ?
        `).all(limit, offset);

        // Attach IP list to each anon
        for (const a of anons) {
            a.ips = db.prepare('SELECT ip, last_seen FROM anon_ip_log WHERE anon_id = ?').all(a.id);
        }

        res.json({ total, anons, limit, offset });
    } catch (err) {
        console.error('[Internal] anon-list error:', err);
        res.status(500).json({ error: 'Failed to list anons' });
    }
});

module.exports = router;
