'use strict';

// ═══════════════════════════════════════════════════════════════
// Discord Service — Modular Discord bot for the OpenVibe
// Handles: live stream alerts, system notifications, admin alerts
// Future: role sync, moderation hooks, linked-account verification
// ═══════════════════════════════════════════════════════════════

let Discord;
try {
    Discord = require('discord.js');
} catch {
    console.warn('[Discord] discord.js not installed — Discord integration disabled');
}

class DiscordService {
    /**
     * @param {object} db — better-sqlite3 Database instance (with getSetting helper)
     */
    constructor(db) {
        this._db = db;
        this._client = null;
        this._ready = false;
        this._destroyed = false;

        // Per-streamer dedupe: username → lastAlertTimestamp
        this._liveAlertCooldowns = new Map();
    }

    // ─── Lifecycle ─────────────────────────────────────────

    /**
     * Initialize and login the Discord bot.
     * Reads bot token from site_settings. No-ops if token is missing.
     */
    async init() {
        if (!Discord) return;

        const token = this._getSetting('discord_bot_token');
        if (!token) {
            console.log('[Discord] No bot token configured — bot disabled');
            return;
        }

        try {
            this._client = new Discord.Client({
                intents: [Discord.GatewayIntentBits.Guilds],
            });

            this._client.once('ready', () => {
                this._ready = true;
                console.log(`[Discord] Bot logged in as ${this._client.user.tag}`);
            });

            this._client.on('error', (err) => {
                console.error('[Discord] Client error:', err.message);
            });

            await this._client.login(token);
        } catch (err) {
            console.error('[Discord] Failed to login:', err.message);
            this._client = null;
            this._ready = false;
        }
    }

    /**
     * Gracefully disconnect the bot.
     */
    async destroy() {
        this._destroyed = true;
        if (this._client) {
            try { this._client.destroy(); } catch {}
            this._client = null;
            this._ready = false;
        }
    }

    /**
     * Reinitialize with new credentials (e.g. after admin updates the token).
     */
    async reinit() {
        await this.destroy();
        this._destroyed = false;
        await this.init();
    }

    // ─── Status ────────────────────────────────────────────

    getStatus() {
        return {
            available: !!Discord,
            connected: this._ready,
            botTag: this._client?.user?.tag || null,
            guildId: this._getSetting('discord_guild_id') || null,
            alertsChannelId: this._getSetting('discord_alerts_channel_id') || null,
        };
    }

    isReady() {
        return this._ready && !!this._client;
    }

    // ─── Live Stream Alerts ────────────────────────────────

    /**
     * Send a live-stream alert to the configured alerts channel.
     * Includes per-streamer dedupe to prevent spam from flapping streams.
     *
     * @param {{ username: string, display_name?: string, avatar_url?: string }} streamer
     * @param {{ id: number, title?: string, protocol?: string }} stream
     * @returns {{ sent: boolean, reason?: string }}
     */
    async sendLiveAlert(streamer, stream) {
        if (!this.isReady()) return { sent: false, reason: 'bot_not_connected' };

        const channelId = this._getSetting('discord_alerts_channel_id');
        if (!channelId) return { sent: false, reason: 'no_alerts_channel' };

        // Dedupe check — one alert per streamer per cooldown window
        const cooldownMin = parseInt(this._getSetting('discord_dedupe_minutes') || '15', 10);
        const cooldownMs = Math.max(cooldownMin, 1) * 60 * 1000;
        const key = streamer.username.toLowerCase();
        const lastAlert = this._liveAlertCooldowns.get(key);
        if (lastAlert && (Date.now() - lastAlert) < cooldownMs) {
            return { sent: false, reason: 'cooldown', remaining_ms: cooldownMs - (Date.now() - lastAlert) };
        }

        try {
            const channel = await this._client.channels.fetch(channelId);
            if (!channel || !channel.isTextBased()) {
                return { sent: false, reason: 'channel_not_found' };
            }

            const displayName = streamer.display_name || streamer.username;
            const streamUrl = `https://openvibe.live/${streamer.username}`;
            const title = stream.title || 'Started streaming';

            const embed = new Discord.EmbedBuilder()
                .setTitle(`🔴 ${displayName} is live!`)
                .setDescription(title)
                .setURL(streamUrl)
                .setColor(0xef4444)
                .setTimestamp()
                .setFooter({ text: 'OpenVibe.Live.com' });

            if (streamer.avatar_url) {
                embed.setThumbnail(streamer.avatar_url);
            }

            if (stream.protocol) {
                embed.addFields({ name: 'Protocol', value: stream.protocol.toUpperCase(), inline: true });
            }

            // Custom message template support
            const customTemplate = this._getSetting('discord_alert_message');
            let content = null;
            if (customTemplate) {
                content = customTemplate
                    .replace(/{username}/g, streamer.username)
                    .replace(/{display_name}/g, displayName)
                    .replace(/{title}/g, title)
                    .replace(/{url}/g, streamUrl);
            }

            await channel.send({ content, embeds: [embed] });

            this._liveAlertCooldowns.set(key, Date.now());
            return { sent: true };
        } catch (err) {
            console.error('[Discord] Failed to send live alert:', err.message);
            return { sent: false, reason: 'send_error', error: err.message };
        }
    }

    // ─── System Alerts ─────────────────────────────────────

    /**
     * Send a system/admin alert to a configured system channel.
     * @param {{ title: string, message: string, level?: 'info'|'warning'|'error' }} alert
     */
    async sendSystemAlert(alert) {
        if (!this.isReady()) return { sent: false, reason: 'bot_not_connected' };

        const channelId = this._getSetting('discord_system_channel_id');
        if (!channelId) return { sent: false, reason: 'no_system_channel' };

        const colors = { info: 0x3b82f6, warning: 0xf59e0b, error: 0xef4444 };

        try {
            const channel = await this._client.channels.fetch(channelId);
            if (!channel || !channel.isTextBased()) {
                return { sent: false, reason: 'channel_not_found' };
            }

            const embed = new Discord.EmbedBuilder()
                .setTitle(alert.title)
                .setDescription(alert.message)
                .setColor(colors[alert.level] || colors.info)
                .setTimestamp()
                .setFooter({ text: 'OpenVibe System' });

            await channel.send({ embeds: [embed] });
            return { sent: true };
        } catch (err) {
            console.error('[Discord] Failed to send system alert:', err.message);
            return { sent: false, reason: 'send_error', error: err.message };
        }
    }

    // ─── Helpers ───────────────────────────────────────────

    _getSetting(key) {
        try {
            return this._db.getSetting(key) || null;
        } catch {
            return null;
        }
    }
}

module.exports = { DiscordService };
