'use strict';

// ═══════════════════════════════════════════════════════════════
// Discord Account Linking — OAuth2 flow for linking Discord
// identity to a OpenVibe account.
// Mounted at /api/auth/discord
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const DISCORD_API = 'https://discord.com/api/v10';

// Temporary state storage for OAuth CSRF protection (in-memory, short-lived)
const _pendingStates = new Map();
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Clean stale states periodically
setInterval(() => {
    const now = Date.now();
    for (const [state, data] of _pendingStates) {
        if (now - data.created > STATE_TTL_MS) _pendingStates.delete(state);
    }
}, 60 * 1000);

/**
 * GET /api/auth/discord/link — Start Discord OAuth2 flow
 * Requires authenticated user. Redirects to Discord authorization.
 */
router.get('/link', (req, res) => {
    const db = req.app.locals.db;
    const clientId = db.getSetting('discord_oauth_client_id');
    if (!clientId) {
        return res.status(503).json({ error: 'Discord linking is not configured' });
    }

    // Verify auth
    const user = req.user;
    if (!user) return res.status(401).json({ error: 'Authentication required' });

    const state = crypto.randomBytes(24).toString('hex');
    _pendingStates.set(state, { userId: user.id, created: Date.now() });

    const redirectUri = `${req.app.locals.config.baseUrl}/api/auth/discord/callback`;
    const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'identify',
        state,
    });

    res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

/**
 * GET /api/auth/discord/callback — Discord OAuth2 callback
 * Exchanges code for token, fetches Discord user, links account.
 */
router.get('/callback', async (req, res) => {
    const { code, state, error: oauthError } = req.query;

    if (oauthError) {
        return res.redirect(`${req.app.locals.config.baseUrl}/linked?discord=error&reason=${encodeURIComponent(oauthError)}`);
    }

    if (!state || !_pendingStates.has(state)) {
        return res.redirect(`${req.app.locals.config.baseUrl}/linked?discord=error&reason=invalid_state`);
    }

    const stateData = _pendingStates.get(state);
    _pendingStates.delete(state);

    if (Date.now() - stateData.created > STATE_TTL_MS) {
        return res.redirect(`${req.app.locals.config.baseUrl}/linked?discord=error&reason=expired`);
    }

    const db = req.app.locals.db;
    const clientId = db.getSetting('discord_oauth_client_id');
    const clientSecret = db.getSetting('discord_oauth_client_secret');
    if (!clientId || !clientSecret) {
        return res.redirect(`${req.app.locals.config.baseUrl}/linked?discord=error&reason=not_configured`);
    }

    try {
        // Exchange code for token
        const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: clientId,
                client_secret: clientSecret,
                grant_type: 'authorization_code',
                code,
                redirect_uri: `${req.app.locals.config.baseUrl}/api/auth/discord/callback`,
            }),
        });

        if (!tokenRes.ok) {
            return res.redirect(`${req.app.locals.config.baseUrl}/linked?discord=error&reason=token_exchange_failed`);
        }

        const tokenData = await tokenRes.json();

        // Fetch Discord user info
        const userRes = await fetch(`${DISCORD_API}/users/@me`, {
            headers: { Authorization: `Bearer ${tokenData.access_token}` },
        });

        if (!userRes.ok) {
            return res.redirect(`${req.app.locals.config.baseUrl}/linked?discord=error&reason=user_fetch_failed`);
        }

        const discordUser = await userRes.json();

        // Check if this Discord account is already linked to a different user
        const existing = db.prepare(
            "SELECT user_id FROM linked_accounts WHERE service = 'discord' AND service_user_id = ?"
        ).get(discordUser.id);

        if (existing && existing.user_id !== stateData.userId) {
            return res.redirect(`${req.app.locals.config.baseUrl}/linked?discord=error&reason=already_linked_other`);
        }

        // Link the account
        db.prepare(`
            INSERT INTO linked_accounts (user_id, service, service_user_id, service_username, linked_at)
            VALUES (?, 'discord', ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(user_id, service) DO UPDATE SET
                service_user_id = ?,
                service_username = ?,
                linked_at = CURRENT_TIMESTAMP
        `).run(
            stateData.userId,
            discordUser.id,
            `${discordUser.username}#${discordUser.discriminator || '0'}`,
            discordUser.id,
            `${discordUser.username}#${discordUser.discriminator || '0'}`,
        );

        // Audit log
        db.prepare('INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)').run(
            stateData.userId, 'discord_linked', `Discord: ${discordUser.username} (${discordUser.id})`
        );

        return res.redirect(`${req.app.locals.config.baseUrl}/linked?discord=success`);
    } catch (err) {
        console.error('[Discord OAuth] Callback error:', err);
        return res.redirect(`${req.app.locals.config.baseUrl}/linked?discord=error&reason=internal`);
    }
});

/**
 * DELETE /api/auth/discord/link — Unlink Discord account
 * Requires authenticated user.
 */
router.delete('/link', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });

    const db = req.app.locals.db;
    const result = db.prepare(
        "DELETE FROM linked_accounts WHERE user_id = ? AND service = 'discord'"
    ).run(req.user.id);

    if (result.changes > 0) {
        db.prepare('INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)').run(
            req.user.id, 'discord_unlinked', 'Discord account unlinked'
        );
    }

    res.json({ ok: true, unlinked: result.changes > 0 });
});

/**
 * GET /api/auth/discord/status — Check if Discord is linked
 */
router.get('/status', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });

    const db = req.app.locals.db;
    const linked = db.prepare(
        "SELECT service_user_id, service_username, linked_at FROM linked_accounts WHERE user_id = ? AND service = 'discord'"
    ).get(req.user.id);

    const configured = !!(db.getSetting('discord_oauth_client_id') && db.getSetting('discord_oauth_client_secret'));

    res.json({ ok: true, configured, linked: linked || null });
});

module.exports = router;
