'use strict';

// ═══════════════════════════════════════════════════════════════
// Discord Admin Routes — Config + management for the Discord bot
// Mounted at /api/admin/discord
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const { isOwner, isSensitiveSettingKey } = require('../auth/owner-guard');

module.exports = function createDiscordRoutes(db, discordService, requireAuth, requireAdmin) {
    const router = express.Router();

    router.use(requireAuth, requireAdmin);

    /** GET /api/admin/discord — bot status + current config */
    router.get('/', (req, res) => {
        const status = discordService.getStatus();
        const settings = {
            discord_bot_token: db.getSetting('discord_bot_token') ? '••••••••' : '',
            discord_guild_id: db.getSetting('discord_guild_id') || '',
            discord_alerts_channel_id: db.getSetting('discord_alerts_channel_id') || '',
            discord_system_channel_id: db.getSetting('discord_system_channel_id') || '',
            discord_dedupe_minutes: db.getSetting('discord_dedupe_minutes') || '15',
            discord_alert_message: db.getSetting('discord_alert_message') || '',
            discord_oauth_client_id: db.getSetting('discord_oauth_client_id') || '',
            discord_oauth_client_secret: db.getSetting('discord_oauth_client_secret') ? '••••••••' : '',
        };
        res.json({ ok: true, status, settings });
    });

    /** PUT /api/admin/discord — update Discord configuration */
    router.put('/', async (req, res) => {
        const { settings } = req.body;
        if (!settings || typeof settings !== 'object') {
            return res.status(400).json({ ok: false, error: 'settings object required' });
        }

        const allowedKeys = [
            'discord_bot_token', 'discord_guild_id', 'discord_alerts_channel_id',
            'discord_system_channel_id', 'discord_dedupe_minutes', 'discord_alert_message',
            'discord_oauth_client_id', 'discord_oauth_client_secret',
        ];

        const upsert = db.prepare(
            'INSERT OR REPLACE INTO site_settings (key, value, type) VALUES (?, ?, ?)'
        );
        let tokenChanged = false;

        const owner = isOwner(req.user);
        for (const [key, value] of Object.entries(settings)) {
            if (!allowedKeys.includes(key)) continue;
            // Bot token / OAuth secret are owner-only — silently skip for admins.
            if (isSensitiveSettingKey(key) && !owner) continue;
            const strVal = String(value ?? '').trim();
            // Don't overwrite token/secret with masked values
            if (key === 'discord_bot_token' && (strVal === '••••••••' || strVal === '')) continue;
            if (key === 'discord_oauth_client_secret' && (strVal === '••••••••' || strVal === '')) continue;
            if (key === 'discord_bot_token') tokenChanged = true;
            const type = key === 'discord_dedupe_minutes' ? 'number' : 'string';
            upsert.run(key, strVal, type);
        }

        // Reinit bot if token changed
        if (tokenChanged) {
            try {
                await discordService.reinit();
            } catch (err) {
                return res.json({ ok: true, warning: `Settings saved but bot reinit failed: ${err.message}` });
            }
        }

        res.json({ ok: true, status: discordService.getStatus() });
    });

    /** POST /api/admin/discord/test — send a test alert to the configured channel */
    router.post('/test', async (req, res) => {
        const result = await discordService.sendSystemAlert({
            title: '🧪 Test Alert',
            message: `Test from openvibe.network admin at ${new Date().toISOString()}`,
            level: 'info',
        });
        res.json({ ok: result.sent, ...result });
    });

    /** POST /api/admin/discord/test-live — send a test live alert */
    router.post('/test-live', async (req, res) => {
        const result = await discordService.sendLiveAlert(
            { username: 'test', display_name: 'Test Streamer', avatar_url: null },
            { id: 0, title: 'This is a test live alert', protocol: 'webrtc' },
        );
        res.json({ ok: result.sent, ...result });
    });

    /** POST /api/admin/discord/reinit — force reconnect the bot */
    router.post('/reinit', async (req, res) => {
        try {
            await discordService.reinit();
            res.json({ ok: true, status: discordService.getStatus() });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    return router;
};
