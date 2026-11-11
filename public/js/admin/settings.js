// Copy only: setting values, types and save paths remain owned by the existing forms.
const ADMIN_SETTING_COPY = {
    "registration_open": [
        "Allow new accounts",
        "Allows people to register; the default is on. Turn it off to pause sign-ups, and on again to reopen them."
    ],
    "platform_name": [
        "Network name",
        "The name shown to people across Network; the default is OpenVibe. For example, keep OpenVibe for the shared network."
    ],
    "default_theme": [
        "Starting appearance",
        "The theme used before a person chooses their own; the default is vibe. Enter a theme name such as vibe."
    ],
    "notifications_enabled": [
        "Send notifications",
        "Allows Network notifications; the default is on. Turn it off to pause new notifications, then on to resume."
    ],
    "notification_max_age_days": [
        "Keep notifications (days)",
        "Notifications older than this are removed; the default is 90 days. Higher keeps more history, lower removes it sooner; removed history cannot be restored here."
    ],
    "notification_email_critical_only": [
        "Email only urgent notifications",
        "Limits notification emails to critical messages; the default is on. Turn it off to allow other notification priorities by email."
    ],
    "payments_enabled": [
        "Allow purchases and subscriptions",
        "Allows real-money checkout on Live when a payment provider is also ready; the default is off. Turn it off again to stop offering new purchases; this does not refund existing payments."
    ],
    "bucks_per_usd": [
        "Vibes per US dollar",
        "Sets the Vibes value of US $1; the default is 100 Vibes. Higher means each Vibe is worth less in dollars, lower means more; save the previous rate to undo future pricing changes."
    ],
    "bucks_min_purchase_bucks": [
        "Smallest purchase (Vibes)",
        "Sets the minimum Vibes purchase; the default is 100 Vibes. Higher requires a larger purchase, lower allows smaller purchases; restore the previous amount to undo."
    ],
    "sub_price_usd": [
        "Subscription price (US dollars)",
        "The fallback subscription price is US $4.99 when Billing supplies no price. Higher charges more and lower charges less; restore the old price for future checkouts, with refunds handled in Billing."
    ],
    "sub_streamer_share_pct": [
        "Creator share (percent)",
        "The creator share defaults to 70 percent. Higher gives the creator more and the site less; restore the old percentage for future calculations."
    ],
    "sub_site_route_fee_pct": [
        "Site routing fee (percent)",
        "The site routing fee defaults to 10 percent. Higher increases the site fee and lower reduces it; restore the old percentage for future calculations."
    ],
    "discord_bot_token": [
        "Discord bot token",
        "Lets the bot connect to Discord; blank by default means no bot connection. Set the token in the server environment, then reconnect the bot."
    ],
    "discord_guild_id": [
        "Discord server ID",
        "Selects the Discord server for the bot; blank by default. Copy the ID of your own server, not its name."
    ],
    "discord_alerts_channel_id": [
        "Live alert channel ID",
        "Sends go-live alerts to this channel; blank by default means no live alert destination. Copy the channel ID, for example the ID of your live-alerts channel."
    ],
    "discord_system_channel_id": [
        "System alert channel ID",
        "Sends operator alerts to this channel; blank by default means no system alert destination. Use a private staff channel, for example admin-alerts."
    ],
    "discord_dedupe_minutes": [
        "Wait between repeat alerts (minutes)",
        "Waits before repeating a stream alert; the default is 15 minutes. Higher sends fewer repeat alerts, lower sends them sooner (1 to 1,440 minutes)."
    ],
    "discord_alert_message": [
        "Live alert wording",
        "Customizes the live alert; blank uses the built-in message. For example: {display_name} went live: {title} {url}."
    ],
    "discord_oauth_client_id": [
        "Discord sign-in application ID",
        "Identifies the application used to link Discord accounts; blank by default leaves it unconfigured. Copy the Client ID of the same application as the client secret."
    ],
    "discord_oauth_client_secret": [
        "Discord sign-in application secret",
        "Authenticates account linking with Discord; blank by default leaves it unconfigured. Set the matching Client Secret in the server environment."
    ],
    "github_token": [
        "GitHub read-only access",
        "Allows more requests to GitHub public repositories; blank uses anonymous access. Use a fine-grained token with public repository read access only."
    ],
    "email_enabled": [
        "Send email",
        "Allows outgoing email; the default is off. Turning it off stops email delivery, including recovery messages; turn it on again to resume."
    ],
    "email_from_address": [
        "Sender email address",
        "The default sender is noreply@openvibe.network. Use an address on a domain verified with the email provider, for example alerts@your-domain.example."
    ],
    "email_from_name": [
        "Sender name",
        "The name recipients see; the default is OpenVibe. For example, use OpenVibe Support for support mail."
    ],
    "resend_api_key": [
        "Resend email key",
        "Lets Network send email through Resend; blank by default means email is not configured. Set the provider key in the server environment."
    ],
    "chat_slowmode_seconds": [
        "Wait between chat messages (seconds)",
        "The default is 0 seconds, which turns slow mode off. Higher makes people wait longer between messages; for example 5 allows one message every five seconds."
    ],
    "coins_per_minute": [
        "Watching reward (OpenCoins per minute)",
        "The default is 10 OpenCoins for each minute watched. Higher awards more coins and lower awards fewer; restore the old amount to undo future rewards."
    ],
    "ai_max_cost_usd_per_day": [
        "Daily AI spending limit (US dollars)",
        "The default is US $0, meaning no cap. A higher positive cap permits more spending; a lower positive cap stops spending sooner, for example US $5 per day."
    ],
    "ai_viewers_global_cap_usd_per_day": [
        "Daily AI viewer spending limit (US dollars)",
        "Caps site-paid AI viewers; the default is US $0, meaning no cap. A higher positive amount permits more spending and a lower positive amount less; for example US $5 per day."
    ],
    "ai_stream_capture_interval_sec": [
        "Time between stream captures (seconds)",
        "The default is 120 seconds between captures. Higher captures less often and lower more often; for example 60 captures once per minute."
    ],
    "ai_viewers_max_lines_per_min": [
        "AI chat messages per minute",
        "Limits bot messages per channel; the default is 12 per minute. Higher allows more chat and lower makes the bots quieter."
    ],
    "ai_viewers_max_roster": [
        "AI viewers per channel",
        "Limits the number of AI viewers in a channel; the default is 12 viewers. Higher permits more viewers and lower limits the roster."
    ],
    "stripe_enabled": [
        "Offer Stripe payments",
        "Offers Stripe at checkout when purchases are enabled and Billing has a working provider; the default is off. Turn it off to remove this payment option; existing payments are not refunded."
    ],
    "paypal_enabled": [
        "Offer PayPal payments",
        "Offers PayPal at checkout when purchases are enabled and Billing has a working provider; the default is off. Turn it off to remove this payment option; existing payments are not refunded."
    ],
    "ccbill_enabled": [
        "Offer CCBill payments",
        "Offers CCBill at checkout when purchases are enabled and Billing has a working provider; the default is off. Turn it off to remove this payment option; existing payments are not refunded."
    ],
    "crypto_enabled": [
        "Offer cryptocurrency payments",
        "Offers cryptocurrency at checkout when purchases are enabled and Billing has a working provider; the default is off. Turn it off to remove this payment option; existing payments are not refunded."
    ],
    "max_audio_bitrate": [
        "Audio quality limit (kilobits per second)",
        "The default is 320 kilobits per second. Higher raises this limit and lower reduces it; for example, keep 320 for the starting allowance."
    ],
    "max_video_bitrate": [
        "Video quality limit (kilobits per second)",
        "The default is 6000 kilobits per second. Higher raises this limit and lower reduces it; for example, keep 6000 for the starting allowance."
    ],
    "max_clip_duration": [
        "Clip length limit (seconds)",
        "The default is 60 seconds. Higher raises this limit and lower reduces it; for example, keep 60 for the starting allowance."
    ],
    "max_emotes_per_user": [
        "Custom emoji limit (emoji per person)",
        "The default is 25 emoji per person. Higher raises this limit and lower reduces it; for example, keep 25 for the starting allowance."
    ],
    "max_vod_size_mb": [
        "Recording size limit (MB)",
        "The default is 5120 MB. Higher raises this limit and lower reduces it; for example, keep 5120 for the starting allowance."
    ],
    "paste_comment_max_length": [
        "Comment length limit (characters)",
        "The default is 2000 characters. Higher raises this limit and lower reduces it; for example, keep 2000 for the starting allowance."
    ],
    "paste_max_size_kb": [
        "Paste size limit (KB)",
        "The default is 512 KB. Higher raises this limit and lower reduces it; for example, keep 512 for the starting allowance."
    ],
    "paste_screenshot_max_size_mb": [
        "Screenshot size limit (MB)",
        "The default is 8 MB. Higher raises this limit and lower reduces it; for example, keep 8 for the starting allowance."
    ],
    "paste_max_per_user_per_day": [
        "Daily paste limit (pastes per person per day)",
        "The default is 50 pastes per person per day. Higher raises this limit and lower reduces it; for example, keep 50 for the starting allowance. Zero means unlimited."
    ],
    "paste_comment_cooldown_seconds": [
        "Wait between comments (seconds)",
        "The default is 10 seconds. Higher raises this limit and lower reduces it; for example, keep 10 for the starting allowance."
    ],
    "paste_cooldown_seconds": [
        "Wait between pastes (seconds)",
        "The default is 30 seconds. Higher raises this limit and lower reduces it; for example, keep 30 for the starting allowance."
    ],
    "min_cashout_amount": [
        "Minimum cashout (Vibes)",
        "The default is 500 Vibes. Higher raises this limit and lower reduces it; for example, keep 500 for the starting allowance."
    ]
};
Object.assign(ADMIN_SETTING_COPY, {
    "tts_max_length": [
        "Spoken message limit (characters)",
        "The default is 200 characters per message. Higher allows longer speech and lower keeps messages shorter."
    ],
    "tts_max_queue_global": [
        "Speech waiting list (messages)",
        "The default is 20 waiting messages across the site. Higher allows a longer waiting list and lower rejects excess messages sooner."
    ],
    "tts_max_queue_per_user": [
        "Speech waiting list per person (messages)",
        "The default is 3 waiting messages per person. Higher permits more queued speech and lower leaves room for other people."
    ],
    "money_writes_frozen": [
        "Pause all Live money actions",
        "The default is off. When frozen, new money actions are refused while balances remain readable; the owner can lift the freeze in the money controls to resume."
    ],
    "ai_viewers_default_settings_json": [
        "Starting AI viewer settings",
        "Overrides the built-in defaults for channel AI viewers; the default empty object leaves those defaults in place. For example, restore {} to remove these overrides."
    ]
});
const ADMIN_LIVE_DEFAULTS = {
    "ai_enabled": "false",
    "ai_max_cost_usd_per_day": "0",
    "ai_paste_analysis_enabled": "true",
    "ai_stream_capture_interval_sec": "120",
    "ai_stream_memory_enabled": "false",
    "ai_timeline_enabled": "false",
    "ai_transcription_enabled": "true",
    "ai_viewers_default_settings_json": "{}",
    "ai_viewers_enabled": "true",
    "ai_viewers_global_cap_usd_per_day": "0",
    "ai_viewers_max_lines_per_min": "12",
    "ai_viewers_max_roster": "12",
    "bucks_min_purchase_bucks": "100",
    "bucks_per_usd": "100",
    "ccbill_client_account": "",
    "ccbill_enabled": "false",
    "ccbill_flexform_id": "",
    "ccbill_subaccount": "",
    "chat_slowmode_seconds": "0",
    "coins_per_minute": "10",
    "crypto_enabled": "false",
    "crypto_provider": "nowpayments",
    "google_client_id": "",
    "kick_client_id": "",
    "max_audio_bitrate": "320",
    "max_clip_duration": "60",
    "max_emotes_per_user": "25",
    "max_video_bitrate": "6000",
    "max_vod_size_mb": "5120",
    "min_cashout_amount": "500",
    "money_writes_frozen": "false",
    "motd": "",
    "nsfw_enabled": "true",
    "paste_anon_allowed": "true",
    "paste_comment_anon_allowed": "true",
    "paste_comment_cooldown_seconds": "10",
    "paste_comment_max_length": "2000",
    "paste_cooldown_seconds": "30",
    "paste_image_upload_enabled": "true",
    "paste_max_per_user_per_day": "50",
    "paste_max_size_kb": "512",
    "paste_screenshot_max_size_mb": "8",
    "payments_enabled": "false",
    "paypal_client_id": "",
    "paypal_enabled": "false",
    "paypal_mode": "sandbox",
    "paypal_webhook_id": "",
    "powerchat_allow_test_fulfillment": "false",
    "powerchat_base_url": "https://powerchatlive.dev",
    "powerchat_client_id": "",
    "powerchat_enabled": "false",
    "powerchat_sandbox_username": "alex",
    "powerchat_scopes": "profile:read webhooks:events checkout:attribute paid_messages:read alerts:trigger chat:write viewcount:write subscriptions:write follows:write currency:write tips:write chat:read",
    "powerchat_site_tip_username": "",
    "registration_open": "true",
    "require_email": "false",
    "site_description": "Live streaming for camp culture",
    "site_name": "OpenVibe.Live",
    "stripe_enabled": "false",
    "stripe_publishable_key": "",
    "sub_price_usd": "4.99",
    "sub_site_route_fee_pct": "10",
    "sub_streamer_share_pct": "70",
    "tts_aws_region": "us-east-1",
    "tts_default_voice": "gary",
    "tts_enabled": "true",
    "tts_google_service_account": "",
    "tts_max_length": "200",
    "tts_max_queue_global": "20",
    "tts_max_queue_per_user": "3",
    "tts_provider": "espeak-ng",
    "twitch_client_id": ""
};
function adminWords(key) {
    const words = String(key || '').replace(/[_-]+/g, ' ');
    return words.charAt(0).toUpperCase() + words.slice(1);
}
function adminSettingLabel(key, setting = {}) {
    const copy = ADMIN_SETTING_COPY[key];
    const title = copy ? copy[0] : (setting.title || adminWords(key));
    const defaultValue = Object.prototype.hasOwnProperty.call(ADMIN_LIVE_DEFAULTS, key) ? ADMIN_LIVE_DEFAULTS[key] : undefined;
    const defaultHelp = defaultValue === undefined ? ' No default is published here; keep the saved value unless you know the change you need.' : defaultValue === '' ? ' Starts blank; add the value supplied by your provider when enabling this feature.' : setting.type === 'boolean' ? ` Starts ${defaultValue === 'true' ? 'on' : 'off'}; toggle it to ${defaultValue === 'true' ? 'disable' : 'enable'} the described feature, and toggle it back to undo.` : ` The starting value is ${defaultValue}; use it as an example when restoring the original setup.`;
    const help = copy ? copy[1] : (setting.description || 'This service supplies this setting without a description.') + defaultHelp;
    return `<strong>${esc(title)}</strong> <code class="admin-machine-key">${esc(key)}</code><span class="admin-help">${esc(help)}</span>`;
}

/* ═══════════════════════════════════════════════════════════════
   OpenVibe.Network — admin panel (/admin): settings sub-tabs, URL registry, streamer settings, Discord and GitHub.
   Split out of admin.html. Classic scripts, global scope: they rely on
   admin/core.js's helpers (api, esc, toast, API, token) and on the
   tabLoaders map in admin/boot.js (loaded last). No ES modules.
   ═══════════════════════════════════════════════════════════════ */
// ═══════════════════════════════════════════════════════════════
// Settings (dual: openvibe-network + OpenVibe.Live)
// ═══════════════════════════════════════════════════════════════
let currentSettingsSub = 'tools';
function showSettingsSub(sub, btn) {
    currentSettingsSub = sub;
    document.querySelectorAll('#settings-sub-tabs button').forEach(b => b.classList.remove('active'));
    btn?.classList.add('active');
    document.getElementById('settings-tools').style.display = sub === 'tools' ? 'block' : 'none';
    document.getElementById('settings-streamer').style.display = sub === 'streamer' ? 'block' : 'none';
    document.getElementById('settings-media').style.display = sub === 'media' ? 'block' : 'none';
    document.getElementById('settings-urls').style.display = sub === 'urls' ? 'block' : 'none';
    document.getElementById('settings-discord').style.display = sub === 'discord' ? 'block' : 'none';
    document.getElementById('settings-github').style.display = sub === 'github' ? 'block' : 'none';
    if (sub === 'tools') loadToolsSettings();
    else if (sub === 'streamer') loadStreamerSettings();
    else if (sub === 'media') loadStreamerMediaTools();
    else if (sub === 'urls') loadUrlRegistry();
    else if (sub === 'discord') loadDiscordSettings();
    else if (sub === 'github') loadGithubSettings();
}

async function loadSettings() {
    loadToolsSettings();
}

async function loadToolsSettings() {
    const c = document.getElementById('settings-tools');
    c.innerHTML = '<div class="loading">Loading...</div>';
    try {
        const data = await api('/api/admin/settings');
        const settings = data.settings || {};
        const keys = Object.keys(settings);
        if (!keys.length) { c.innerHTML = '<p class="muted">No settings are available. Check Network setup, then reload this tab.</p>'; return; }
        _toolsSettingsOriginal = {};
        for (const key of keys) _toolsSettingsOriginal[key] = settings[key].type === 'boolean' ? (settings[key].value === 'true' ? 'true' : 'false') : String(settings[key].value ?? '');
        c.innerHTML = `
            <p class="admin-intro">These settings control accounts, notifications, and integrations in Network. Change them when you need to adjust how the network works; save the previous value to undo a change.</p>
            <form id="tools-settings-form" style="max-width:700px">
                ${keys.map(key => {
                    const s = settings[key];
                    const isSensitive = /(password|secret|token|private|credential|api[_-]?key|bearer)/i.test(key);
                    if (s.source === 'env') return `
                        <div class="setting-row" style="flex-direction:column;align-items:stretch">
                            <label for="ts-${esc(key)}">${adminSettingLabel(key, s)}</label>
                            <input type="password" id="ts-${esc(key)}" data-key="${esc(key)}" data-type="${esc(s.type||'string')}" value="" disabled placeholder="Set in the environment (${esc(s.env || '')})"
                                style="margin-top:4px;padding:8px 10px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:13px">
                        </div>`;
                    if (s.type === 'boolean') return `
                        <div class="setting-row">
                            <label for="ts-${esc(key)}">${adminSettingLabel(key, s)}</label>
                            <input type="checkbox" id="ts-${esc(key)}" data-key="${esc(key)}" data-type="boolean" ${s.value==='true'?'checked':''} style="width:18px;height:18px;cursor:pointer">
                        </div>`;
                    return `
                        <div class="setting-row" style="flex-direction:column;align-items:stretch">
                            <label for="ts-${esc(key)}">${adminSettingLabel(key, s)}</label>
                            <input type="${isSensitive?'password':'text'}" id="ts-${esc(key)}" data-key="${esc(key)}" data-type="${esc(s.type||'string')}" value="${esc(s.value)}"
                                style="margin-top:4px;padding:8px 10px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:13px">
                            ${s.source === 'database' && s.env && s.secret ? `<span class="muted" style="font-size:12px;margin-top:4px">Stored in the database; prefer <code>${esc(s.env)}</code> in the server's environment file.</span>` : ''}
                        </div>`;
                }).join('')}
                <div style="margin-top:16px"><button type="button" class="btn btn-primary" onclick="saveToolsSettings()"><i class="fa-solid fa-floppy-disk"></i> Save Network settings</button></div>
            </form>`;
    } catch (e) { c.innerHTML = `<p class="muted">Error: ${esc(e.message)}</p>`; }
    finally { if (currentUser && currentUser.is_owner) await loadToolsWorkers(); }
}

let _toolsSettingsOriginal = {};
async function saveToolsSettings() {
    const inputs = document.querySelectorAll('#tools-settings-form [data-key]');
    const changed = [];
    for (const input of inputs) {
        if (input.disabled) continue;                                 // provided by the environment
        const key = input.dataset.key;
        const value = input.dataset.type === 'boolean' ? (input.checked ? 'true' : 'false') : input.value;
        if (value.startsWith('••••')) continue;                       // masked secret, untouched
        if (_toolsSettingsOriginal[key] !== undefined && _toolsSettingsOriginal[key] === value) continue;
        if (input.dataset.type === 'number' && !Number.isFinite(Number(value))) { toast(`${key}: must be a number`, 'error'); return; }
        changed.push({ key, value, type: input.dataset.type });
    }
    if (!changed.length) { toast('No changes to save', 'info'); return; }
    try {
        for (const { key, value, type } of changed) {
            await api('/api/admin/settings', { method: 'PUT', body: { key, value, type } });
            _toolsSettingsOriginal[key] = value;
        }
        toast(`Saved ${changed.length} setting${changed.length === 1 ? '' : 's'}: ${changed.map(c => c.key).join(', ')}`, 'success');
    } catch (e) { toast(e.message, 'error'); }
}

async function loadUrlRegistry() {
    const c = document.getElementById('settings-urls');
    c.innerHTML = '<div class="loading">Loading URL registry...</div>';
    try {
        const data = await api('/api/admin/url-registry');
        const entries = data.entries || [];
        if (!entries.length) {
            c.innerHTML = '<p class="muted">No service addresses are available to edit. Check the service registry setup, then reopen this tab.</p>';
            return;
        }
        c.innerHTML = `
            <div style="max-width:900px;display:grid;gap:16px">
                <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
                    <div>
                        <strong>Service addresses</strong>
                        <div class="muted" style="font-size:13px">These are the addresses services use to reach each other. Change them when moving a service, then refresh services to pick up the saved addresses.</div>
                    </div>
                    <div style="display:flex;gap:8px;flex-wrap:wrap">
                        <button class="btn btn-sm btn-primary" onclick="refreshAllUrlRegistry()"><i class="fa-solid fa-arrows-rotate"></i> Refresh all services</button>
                    </div>
                </div>
                <div id="url-registry-refresh-status" class="muted" style="font-size:13px"></div>
                ${entries.map(entry => `
                    <div class="card" style="padding:16px">
                        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
                            <div>
                                <div style="font-weight:700">${esc(entry.label)} <code class="admin-machine-key">${esc(entry.key)}</code></div>
                                <div class="muted" id="url-registry-help-${esc(entry.key)}" style="font-size:13px">Use the address or switch for this service; the supplied example is shown in the field. Reset restores the configured default; save your previous value to undo.</div>
                            </div>
                            <div style="display:flex;gap:8px;flex-wrap:wrap">
                                <button class="btn btn-sm btn-outline" onclick="resetUrlRegistryEntry('${esc(entry.key)}')"><i class="fa-solid fa-rotate-left"></i> Restore default</button>
                                <button class="btn btn-sm btn-primary" onclick="saveUrlRegistryEntry('${esc(entry.key)}')"><i class="fa-solid fa-floppy-disk"></i> ${entry.type === 'boolean' ? 'Save the switch' : 'Save the address'}</button>
                            </div>
                        </div>
                        <div class="form-field" style="margin-top:12px">
                            <label for="url-registry-${esc(entry.key)}">${entry.type === 'boolean' ? 'Turn this feature on or off' : 'Saved address'}</label>
                            ${entry.type === 'boolean' ? `
                                <div style="display:flex;align-items:center;gap:8px">
                                    <input type="checkbox" id="url-registry-${esc(entry.key)}" aria-describedby="url-registry-help-${esc(entry.key)}" ${entry.value ? 'checked' : ''}>
                                    <span>${esc(entry.label)}</span>
                                </div>
                            ` : `
                                <input type="text" id="url-registry-${esc(entry.key)}" aria-describedby="url-registry-help-${esc(entry.key)}" value="${esc(entry.value || '')}" placeholder="${esc(entry.placeholder || '')}">
                            `}
                            <div class="muted" style="margin-top:4px">${entry.source === 'default' ? 'Using the configured default.' : entry.source === 'env' ? 'Using the server environment setting.' : 'Using a saved override.'}</div>
                            ${entry.key === 'WHIP_PUBLIC_URL' ? `<div class="badge badge-warning" style="margin-top:8px;display:inline-block">Note</div><div class="muted" style="margin-top:4px">A dedicated WHIP hostname also requires explicit enablement via WHIP_PUBLIC_URL_ENABLED, plus DNS/vhost/TLS support.</div>` : ''}
                            ${entry.warning ? `<div class="badge badge-warning" style="margin-top:8px;display:inline-block">Warning</div><div class="muted" style="margin-top:4px">${esc(entry.warning)}</div>` : ''}
                        </div>
                    </div>
                `).join('')}
            </div>`;
    } catch (e) {
        c.innerHTML = `<p class="muted">Error: ${esc(e.message)}</p>`;
    }
}

async function saveUrlRegistryEntry(key) {
    const input = document.getElementById(`url-registry-${key}`);
    if (!input) return toast('Missing registry field', 'error');
    const value = input.type === 'checkbox' ? input.checked : input.value.trim();
    try {
        await api(`/api/admin/url-registry/${encodeURIComponent(key)}`, { method: 'PUT', body: { value } });
        toast('URL registry entry saved', 'success');
        loadUrlRegistry();
    } catch (e) { toast(e.message, 'error'); }
}

async function resetUrlRegistryEntry(key) {
    if (!confirm('Restore the configured default service address? This changes where services connect after refresh. Save the current value first; enter and save it again to undo.')) return;
    try {
        await api(`/api/admin/url-registry/${encodeURIComponent(key)}/reset`, { method: 'POST' });
        toast('URL registry entry reset', 'success');
        loadUrlRegistry();
    } catch (e) { toast(e.message, 'error'); }
}

async function refreshAllUrlRegistry() {
    const statusEl = document.getElementById('url-registry-refresh-status');
    statusEl.textContent = 'Refreshing all services...';
    try {
        const data = await api('/api/admin/url-registry/refresh-all', { method: 'POST' });
        if (!data.ok) throw new Error(data.error || 'Refresh failed');
        const results = data.refreshResults || [];
        statusEl.innerHTML = results.map(service => {
            const result = (service.results && service.results[0]) || {};
            const mode = result.mode || (result.ok ? 'success' : 'failed');
            const badge = result.mode === 'local'
                ? '<span class="badge badge-info">Refreshed this server.</span>'
                : result.mode === 'not_configured'
                    ? '<span class="badge badge-warning">No refresh destination is configured.</span>'
                    : result.mode === 'unsupported'
                        ? '<span class="badge badge-warning">This service cannot refresh remotely.</span>'
                        : result.ok
                            ? '<span class="badge badge-success">The service refreshed its settings.</span>'
                            : '<span class="badge badge-danger">The service could not refresh.</span>';
            const message = result.error ? ` <span class="muted">${esc(result.error)}</span>` : (result.message ? ` <span class="muted">${esc(result.message)}</span>` : '');
            return `<div><strong>${esc(service.service)}</strong>: ${badge}${message}</div>`;
        }).join('');
        toast('Refresh command sent to services', 'success');
    } catch (e) {
        statusEl.textContent = `Refresh failed: ${esc(e.message)}`;
        toast(e.message, 'error');
    }
}

// Grouped, icon'd sections for the (otherwise huge) OpenVibe.Live settings list.
const ADMIN_SETTINGS_GROUP_INTROS = {
    "Site & General": "These settings control the public Live site and registration. Change them when updating the site identity or who may join.",
    "Payment Processors": "These settings control paid features on Live. Change them when reviewing prices or payment availability; restore earlier values to undo future pricing changes, and handle refunds in Billing.",
    "Kick / Twitch / YouTube": "These settings connect external streaming accounts to Live. Change them when configuring or replacing an application at the named provider.",
    "AI Config": "These settings control automated analysis and AI viewers on Live. Change limits when balancing useful analysis against cost and server load.",
    "Cloud TTS": "These settings connect services that read text aloud. Change them when setting up a voice provider or replacing its credentials.",
    "Media & Uploads": "These settings limit uploaded media and stream quality. Raise limits when more capacity is available, or lower them to reduce storage and bandwidth use.",
    "Chat & Rewards": "These settings control chat pacing and watching rewards. Change them when chat needs slowing down or rewards need adjusting.",
    "Other": "These are additional settings published by Live. Change a value only after reading its description and keeping the previous value for recovery."
};
const STREAMER_SETTINGS_GROUPS = [
    { title: 'Site & General', icon: 'fa-sliders', test: k => /^(site_|motd$|registration_open$|require_email$|nsfw_enabled$)/.test(k) },
    { title: 'Payment Processors', icon: 'fa-credit-card', test: k => /^(payments_|bucks_|sub_|paypal_|stripe_|ccbill_|crypto_|min_cashout)/.test(k) },
    { title: 'Kick / Twitch / YouTube', icon: 'fa-plug', test: k => /^(twitch_|kick_|google_client)/.test(k) },
    { title: 'AI Config', icon: 'fa-robot', test: k => /^ai_/.test(k) },
    { title: 'Cloud TTS', icon: 'fa-volume-high', test: k => /^tts_/.test(k) },
    { title: 'Media & Uploads', icon: 'fa-photo-film', test: k => /^(gif_|soundboard_|paste_|storage_tier|max_emotes|max_clip|max_video|max_audio|max_vod)/.test(k) },
    { title: 'Chat & Rewards', icon: 'fa-comments', test: k => /^(chat_|coins_per)/.test(k) },
    { title: 'Other', icon: 'fa-ellipsis', test: () => true },
];

const REDACTED_MASK = '••••';
function _looksJson(v) { return typeof v === 'string' && /^\s*[\[{]/.test(v); }
function _isMultiline(s) {
    return s.type === 'json' || _looksJson(s.value) || /\n/.test(String(s.value ?? '')) || String(s.value ?? '').length > 140;
}
function _streamerSettingField(s) {
    const isSensitive = /(password|secret|token|private|credential|api[_-]?key|bearer|salt)/i.test(s.key);
    const label = `<label for="ss-${esc(s.key)}">${adminSettingLabel(s.key, s)}${s.redacted ? ' <span class="badge badge-warning" style="font-size:10px">owner-only</span>' : ''}</label>`;
    const base = 'margin-top:4px;padding:8px 10px;background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:13px';
    if (s.type === 'boolean') return `<div class="setting-row">${label}
        <input type="checkbox" id="ss-${esc(s.key)}" data-key="${esc(s.key)}" data-type="boolean" ${s.value==='true'?'checked':''} style="width:18px;height:18px;cursor:pointer"></div>`;
    if (!isSensitive && _isMultiline(s)) {
        const kind = (s.type === 'json' || _looksJson(s.value)) ? 'json' : 'text';
        let shown = String(s.value ?? '');
        if (kind === 'json') { try { shown = JSON.stringify(JSON.parse(shown), null, 2); } catch { /* show as-is; save validation will flag it */ } }
        const rows = Math.min(18, Math.max(3, shown.split('\n').length + 1));
        return `<div class="setting-row" style="flex-direction:column;align-items:stretch">${label}
        <details class="admin-advanced" ${kind === 'json' ? '' : 'open'}><summary>Advanced settings: ${kind === 'json' ? 'structured data (JSON)' : 'long text'}</summary><p class="admin-help">Edit the complete value below. Keep a copy before saving so you can restore it.</p><textarea id="ss-${esc(s.key)}" data-key="${esc(s.key)}" data-type="${kind}" rows="${rows}" spellcheck="false"
            style="${base};font-family:ui-monospace,SFMono-Regular,Menlo,monospace;resize:vertical;white-space:pre;overflow:auto">${esc(shown)}</textarea></details>
        <div class="setting-err muted" data-err-for="${esc(s.key)}" style="display:none;color:var(--danger-text, var(--danger,#f87171));font-size:12px;margin-top:4px"></div></div>`;
    }
    const type = s.type === 'number' ? 'number' : (isSensitive ? 'password' : 'text');
    const width = s.type === 'number' ? 'width:200px;' : '';
    return `<div class="setting-row" style="flex-direction:column;align-items:stretch">${label}
        <input type="${type}" id="ss-${esc(s.key)}" data-key="${esc(s.key)}" data-type="${esc(s.type||'string')}" value="${esc(s.value)}" ${type === 'number' ? 'step="any"' : ''}
            style="${base};${width}">
        <div class="setting-err muted" data-err-for="${esc(s.key)}" style="display:none;color:var(--danger-text, var(--danger,#f87171));font-size:12px;margin-top:4px"></div></div>`;
}

// Snapshot of what the server sent (keyed by setting key) so Save only submits real changes.
let _streamerSettingsOriginal = {};
function _streamerFieldValue(input) {
    return input.dataset.type === 'boolean' ? (input.checked ? 'true' : 'false') : input.value;
}
// Normalize so cosmetic differences (pretty-printed JSON, trailing whitespace) don't count as edits.
function _streamerNormalize(input, raw) {
    if (input.dataset.type === 'json') { try { return JSON.stringify(JSON.parse(raw)); } catch { return raw; } }
    if (input.dataset.type === 'number') return String(raw).trim();
    return raw;
}
function _markDirty(input) {
    const orig = _streamerSettingsOriginal[input.dataset.key];
    const dirty = orig !== undefined && _streamerNormalize(input, _streamerFieldValue(input)) !== _streamerNormalize(input, orig);
    input.style.borderColor = dirty ? 'var(--accent, #8b5cf6)' : '';
    const btn = document.getElementById('streamer-settings-save');
    if (btn) {
        const n = document.querySelectorAll('#streamer-settings-form [data-key][data-dirty="1"]').length + (dirty && input.dataset.dirty !== '1' ? 1 : (!dirty && input.dataset.dirty === '1' ? -1 : 0));
        input.dataset.dirty = dirty ? '1' : '0';
        btn.innerHTML = `<i class="fa-solid fa-floppy-disk"></i> Save ${n ? n + ' change' + (n === 1 ? '' : 's') : 'Settings'}`;
    }
}

async function loadStreamerSettings() {
    const c = document.getElementById('settings-streamer');
    c.innerHTML = '<div class="loading">Loading...</div>';
    try {
        const data = await api('/api/admin/streamer/settings');
        const settings = data.settings || [];
        if (!settings.length) { c.innerHTML = '<p class="muted">No Live settings are available. Check the Live connection, then reopen this tab.</p>'; return; }
        _streamerSettingsOriginal = {};
        for (const s of settings) _streamerSettingsOriginal[s.key] = s.value == null ? '' : String(s.value);
        // Bucket each setting into the first matching group.
        const buckets = STREAMER_SETTINGS_GROUPS.map(() => []);
        for (const s of settings) {
            const gi = STREAMER_SETTINGS_GROUPS.findIndex(g => g.test(s.key));
            buckets[gi === -1 ? buckets.length - 1 : gi].push(s);
        }
        const sections = STREAMER_SETTINGS_GROUPS.map((g, i) => {
            const items = buckets[i].sort((a, b) => a.key.localeCompare(b.key));
            if (!items.length) return '';
            return `<details class="settings-group" ${i < 2 ? 'open' : ''} style="border:1px solid var(--border);border-radius:8px;margin-bottom:10px">
                <summary style="cursor:pointer;padding:10px 14px;font-weight:700;list-style:none"><i class="fa-solid ${g.icon}"></i> ${esc(g.title)} <span style="opacity:.5;font-weight:400">(${items.length})</span></summary>
                <div style="padding:4px 14px 12px"><p class="admin-intro">${esc(ADMIN_SETTINGS_GROUP_INTROS[g.title])}</p>${items.map(_streamerSettingField).join('')}</div>
            </details>`;
        }).join('');
        c.innerHTML = `
            <form id="streamer-settings-form" style="max-width:760px">
                ${sections}
                <div style="margin-top:8px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
                    <button type="button" id="streamer-settings-save" class="btn btn-primary" onclick="saveStreamerSettings()"><i class="fa-solid fa-floppy-disk"></i> Save Network settings</button>
                    <button type="button" class="btn btn-outline" onclick="loadStreamerSettings()"><i class="fa-solid fa-rotate-left"></i> Discard changes</button>
                    <span class="muted" style="font-size:12px">Only fields you changed are sent. JSON and numeric fields are validated first.</span>
                </div>
            </form>`;
        c.querySelectorAll('#streamer-settings-form [data-key]').forEach(el => el.addEventListener('input', () => _markDirty(el)));
    } catch (e) { c.innerHTML = `<p class="muted">Error: ${esc(e.message)}</p>`; }
}

function _setFieldError(key, msg) {
    const el = document.querySelector(`#streamer-settings-form [data-err-for="${CSS.escape(key)}"]`);
    if (el) { el.textContent = msg || ''; el.style.display = msg ? '' : 'none'; }
    const input = document.getElementById(`ss-${key}`);
    if (input) input.style.borderColor = msg ? 'var(--danger, #f87171)' : (input.dataset.dirty === '1' ? 'var(--accent, #8b5cf6)' : '');
}

async function saveStreamerSettings() {
    const inputs = document.querySelectorAll('#streamer-settings-form [data-key]');
    const settings = {};
    const errors = [];
    inputs.forEach(input => {
        const key = input.dataset.key;
        const raw = _streamerFieldValue(input);
        _setFieldError(key, '');
        // Not in the snapshot (shouldn't happen) or redacted mask untouched → never send.
        const orig = _streamerSettingsOriginal[key];
        if (orig === undefined) return;
        if (raw.startsWith(REDACTED_MASK)) return;
        if (_streamerNormalize(input, raw) === _streamerNormalize(input, orig)) return;
        let value = raw;
        if (input.dataset.type === 'json') {
            try { value = JSON.stringify(JSON.parse(raw)); }
            catch (e) { errors.push(key); _setFieldError(key, `Invalid JSON: ${e.message}`); return; }
        } else if (input.dataset.type === 'number') {
            if (raw.trim() === '' || !Number.isFinite(Number(raw))) { errors.push(key); _setFieldError(key, 'Must be a number'); return; }
            value = String(Number(raw));
        } else if (_looksJson(orig) && !_looksJson(raw)) {
            // Previously JSON, now something that clearly isn't → almost certainly a truncation/mistake.
            errors.push(key); _setFieldError(key, 'This setting was JSON; the new value is not. Clear the field completely if you really mean to blank it.'); return;
        }
        settings[key] = value;
    });
    if (errors.length) {
        toast(`Not saved — fix ${errors.length} invalid field${errors.length === 1 ? '' : 's'}: ${errors.join(', ')}`, 'error');
        const first = document.getElementById(`ss-${errors[0]}`);
        if (first) { for (let parent = first.parentElement; parent; parent = parent.parentElement) { if (parent.tagName === 'DETAILS') parent.open = true; } first.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
        return;
    }
    const keys = Object.keys(settings);
    if (!keys.length) { toast('No changes to save', 'info'); return; }
    try {
        const out = await api('/api/admin/streamer/settings', { method: 'PUT', body: { settings } });
        if (out && out.rejected && Object.keys(out.rejected).length) {
            for (const [k, msg] of Object.entries(out.rejected)) _setFieldError(k, msg);
            toast(`Server rejected: ${Object.keys(out.rejected).join(', ')}`, 'error');
            return;
        }
        for (const k of keys) _streamerSettingsOriginal[k] = settings[k];
        inputs.forEach(el => { el.dataset.dirty = '0'; el.style.borderColor = ''; });
        const btn = document.getElementById('streamer-settings-save');
        if (btn) btn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save Settings';
        toast(`Saved ${keys.length} setting${keys.length === 1 ? '' : 's'}: ${keys.join(', ')}` + (out?.message && /skipped/.test(out.message) ? ` (${out.message})` : ''), 'success');
    } catch (e) {
        // Server-side validation failed: nothing was written; surface the per-field reasons.
        const rejected = e.body && e.body.rejected;
        if (rejected && Object.keys(rejected).length) for (const [k, msg] of Object.entries(rejected)) _setFieldError(k, msg);
        toast(e.message, 'error');
    }
}

// ═══════════════════════════════════════════════════════════════
// Discord Bot Settings
// ═══════════════════════════════════════════════════════════════
// A secret input for a provider secret: disabled when its environment variable provides it (server/secrets.js).
function envSecretInput(sources, key, value, placeholder, style) {
    // Provider secrets are environment-only (server/secrets.js): the field shows where it comes from and never edits it.
    const src = (sources || {})[key] || {};
    const env = esc(src.env || '');
    const label = src.source === 'env' ? `Set in the environment (${env})` : `Not set: add ${env} to /etc/openvibe/network.env and restart Network`;
    return `<input type="password" id="ds-${esc(key)}" data-key="${esc(key)}" value="" placeholder="${label}" disabled style="${style}">`;
}

async function loadDiscordSettings() {
    const c = document.getElementById('settings-discord');
    c.innerHTML = '<p class="muted">Loading Discord settings...</p>';
    try {
        const data = await api('/api/admin/discord');
        const s = data.settings || {};
        const st = data.status || {};
        const statusBadge = st.connected
            ? `<span class="badge" style="background:var(--success-bg,#166534);color:var(--success-text,#4ade80)">● Connected as ${esc(st.botTag || '?')}</span>`
            : `<span class="badge" style="background:var(--danger-bg,#7f1d1d);color:var(--danger-text,#f87171)">The bot is not connected. Check its token and reconnect.</span>`;

        c.innerHTML = `
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px">
                <h3 style="margin:0"><i class="fa-brands fa-discord"></i> Discord Bot</h3>
                ${statusBadge}
            </div>
            <p class="admin-intro">The Discord bot posts live and system alerts to your server. Configure its application and channel IDs when enabling alerts, then send a test alert to check delivery.</p><form id="discord-settings-form">
                <div class="setting-row">
                    <label for="ds-discord_bot_token">${adminSettingLabel("discord_bot_token")}<span class="admin-help">Where to get it: <a href="https://discord.com/developers/applications" target="_blank" rel="noopener">Discord Developer Portal</a>. Open your application → Bot → Reset Token, then copy the new token into the server environment; resetting it invalidates the previous token.</span></label>
                    ${envSecretInput(data.sources, 'discord_bot_token', s.discord_bot_token, 'Bot token from Discord Developer Portal', 'width:100%;max-width:500px')}
                </div>
                <div class="setting-row">
                    <label for="ds-discord_guild_id">${adminSettingLabel("discord_guild_id")}<span class="admin-help">Where to get it: <a href="https://discord.com/developers/applications" target="_blank" rel="noopener">Discord Developer Portal</a>. Use the application you invited to your server; in Discord, enable User Settings → Advanced → Developer Mode, then right-click the server → Copy Server ID (<a href="https://support.discord.com/hc/en-us/articles/206346498-Where-can-I-find-my-User-Server-Message-ID" target="_blank" rel="noopener">Discord’s ID guide</a>).</span></label>
                    <input type="text" id="ds-discord_guild_id" data-key="discord_guild_id" value="${esc(s.discord_guild_id || '')}" placeholder="Right-click server → Copy Server ID" style="width:240px">
                </div>
                <div class="setting-row">
                    <label for="ds-discord_alerts_channel_id">${adminSettingLabel("discord_alerts_channel_id")}<span class="admin-help">Where to get it: <a href="https://discord.com/developers/applications" target="_blank" rel="noopener">Discord Developer Portal</a>. Use the server where you invited this application; in Discord with Developer Mode enabled, right-click the live-alerts channel → Copy Channel ID.</span></label>
                    <input type="text" id="ds-discord_alerts_channel_id" data-key="discord_alerts_channel_id" value="${esc(s.discord_alerts_channel_id || '')}" placeholder="Channel for go-live alerts" style="width:240px">
                </div>
                <div class="setting-row">
                    <label for="ds-discord_system_channel_id">${adminSettingLabel("discord_system_channel_id")}<span class="admin-help">Where to get it: <a href="https://discord.com/developers/applications" target="_blank" rel="noopener">Discord Developer Portal</a>. Use the server where you invited this application; in Discord with Developer Mode enabled, right-click the staff-alerts channel → Copy Channel ID.</span></label>
                    <input type="text" id="ds-discord_system_channel_id" data-key="discord_system_channel_id" value="${esc(s.discord_system_channel_id || '')}" placeholder="Channel for system/admin alerts (optional)" style="width:240px">
                </div>
                <div class="setting-row">
                    <label for="ds-discord_dedupe_minutes">${adminSettingLabel("discord_dedupe_minutes")}</label>
                    <input type="number" id="ds-discord_dedupe_minutes" data-key="discord_dedupe_minutes" value="${esc(s.discord_dedupe_minutes || '15')}" min="1" max="1440" style="width:100px">
                    <span class="muted" style="margin-left:8px">Fewer repeated alerts when a stream disconnects and reconnects.</span>
                </div>
                <div class="setting-row">
                    <label for="ds-discord_alert_message">${adminSettingLabel("discord_alert_message")}</label>
                    <input type="text" id="ds-discord_alert_message" data-key="discord_alert_message" value="${esc(s.discord_alert_message || '')}" placeholder="{display_name} went live: {title}" style="width:100%;max-width:500px">
                    <div class="muted" style="font-size:12px;margin-top:4px">Placeholders: {username}, {display_name}, {title}, {url}</div>
                </div>
                <h4 style="margin-top:24px"><i class="fa-brands fa-discord"></i> Link Discord accounts</h4><p class="admin-intro">These application details let people connect their Discord identity. Configure them when enabling account linking, using the same Discord application for both fields.</p>
                <div class="setting-row">
                    <label for="ds-discord_oauth_client_id">${adminSettingLabel("discord_oauth_client_id")}<span class="admin-help">Where to get it: <a href="https://discord.com/developers/applications" target="_blank" rel="noopener">Discord Developer Portal</a>. Open your application → OAuth2 → General, then copy Client ID.</span></label>
                    <input type="text" id="ds-discord_oauth_client_id" data-key="discord_oauth_client_id" value="${esc(s.discord_oauth_client_id || '')}" placeholder="Discord application client ID" style="width:300px">
                </div>
                <div class="setting-row">
                    <label for="ds-discord_oauth_client_secret">${adminSettingLabel("discord_oauth_client_secret")}<span class="admin-help">Where to get it: <a href="https://discord.com/developers/applications" target="_blank" rel="noopener">Discord Developer Portal</a>. Open your application → OAuth2 → General, then copy Client Secret into the server environment; resetting it invalidates the previous secret.</span></label>
                    ${envSecretInput(data.sources, 'discord_oauth_client_secret', s.discord_oauth_client_secret, 'Discord application client secret', 'width:300px')}
                </div>
                <div style="margin-top:16px;display:flex;gap:8px;flex-wrap:wrap">
                    <button type="button" class="btn btn-primary" onclick="saveDiscordSettings()"><i class="fa-solid fa-save"></i> Save Discord settings</button>
                    <button type="button" class="btn btn-outline" onclick="testDiscordAlert()"><i class="fa-solid fa-bell"></i> Test System Alert</button>
                    <button type="button" class="btn btn-outline" onclick="testDiscordLiveAlert()"><i class="fa-solid fa-broadcast-tower"></i> Test Live Alert</button>
                    <button type="button" class="btn btn-outline" onclick="reinitDiscordBot()"><i class="fa-solid fa-rotate"></i> Reconnect the bot</button>
                </div>
            </form>`;
    } catch (e) {
        c.innerHTML = `<p class="muted">Error loading Discord settings: ${esc(e.message)}</p>`;
    }
}

// ═══════════════════════════════════════════════════════════════
// GitHub integration (owner-only): the read-only token for the registry and Blog's changelog
// ═══════════════════════════════════════════════════════════════
async function loadGithubSettings() {
    const c = document.getElementById('settings-github');
    c.innerHTML = '<p class="muted">Loading…</p>';
    try {
        const g = (await api('/api/admin/integrations/github')).github || {};
        const env = esc(g.env || 'GITHUB_TOKEN');
        const badge = g.set ? `<span class="badge" style="background:var(--success-bg,#166534);color:var(--success-text,#4ade80)">● Token …${esc(g.last4 || '')} (set in the environment)</span>` : `<span class="badge badge-warning">● No token: anonymous, 60 requests an hour for the whole host</span>`;
        c.innerHTML = `
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;flex-wrap:wrap">
                <h3 style="margin:0"><i class="fa-brands fa-github"></i> GitHub</h3>${badge}
            </div>
            <p class="muted" style="max-width:720px">A read-only token for public repositories. With it, GitHub allows 5,000 requests an hour instead of the 60 an hour this host shares without one. Used by: ${(g.used_by || []).map(esc).join('; ')}.</p>
            <p class="muted" style="max-width:720px">Provider secrets live in the server's environment only, never in the database. ${g.set ? `This one comes from <code>${env}</code>; change it there.` : `To add one, create a fine-grained token with <b>public repositories, read-only</b> access and no other permissions, set <code>${env}</code> in <code>/etc/openvibe/network.env</code>, and restart Network.`}</p>
            <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
                <button type="button" class="btn btn-outline" onclick="testGithubToken()"><i class="fa-solid fa-plug"></i> Test the token</button>
            </div>
            <div id="github-test-result" class="muted" style="margin-top:10px"></div>`;
    } catch (e) { c.innerHTML = `<p class="muted">GitHub settings could not be loaded: ${esc(e.message)}</p>`; }
}
async function testGithubToken() {
    const out = document.getElementById('github-test-result');
    if (out) out.textContent = 'Asking GitHub…';
    try {
        const t = (await api('/api/admin/integrations/github/test', { method: 'POST' })).test || {};
        if (out) out.innerHTML = t.ok ? `${t.authenticated ? '✅ Authenticated' : '⚠️ Anonymous'}: ${esc(String(t.remaining))} of ${esc(String(t.limit))} requests left this hour${t.reset ? ` (resets ${esc(new Date(t.reset).toLocaleTimeString())})` : ''}.` : `❌ GitHub refused it: ${esc(t.message || t.status)}`;
    } catch (e) { if (out) out.textContent = e.message; }
}

async function saveDiscordSettings() {
    try {
        const form = document.getElementById('discord-settings-form');
        const settings = {};
        form.querySelectorAll('[data-key]').forEach(el => {
            if (el.disabled) return;                               // provided by the environment
            settings[el.dataset.key] = el.value;
        });
        await api('/api/admin/discord', { method: 'PUT', body: JSON.stringify({ settings }) });
        toast('Discord settings saved');
        loadDiscordSettings();
    } catch (e) { toast(e.message, 'error'); }
}

async function testDiscordAlert() {
    try {
        const data = await api('/api/admin/discord/test', { method: 'POST' });
        toast(data.sent ? 'Test alert sent!' : `Alert not sent: ${data.reason || 'unknown'}`, data.sent ? 'success' : 'error');
    } catch (e) { toast(e.message, 'error'); }
}

async function testDiscordLiveAlert() {
    try {
        const data = await api('/api/admin/discord/test-live', { method: 'POST' });
        toast(data.sent ? 'Test live alert sent!' : `Alert not sent: ${data.reason || 'unknown'}`, data.sent ? 'success' : 'error');
    } catch (e) { toast(e.message, 'error'); }
}

async function reinitDiscordBot() {
    try {
        const data = await api('/api/admin/discord/reinit', { method: 'POST' });
        toast(data.status?.connected ? `Bot reconnected as ${data.status.botTag}` : 'Bot reconnected (not logged in)', data.status?.connected ? 'success' : 'warning');
        loadDiscordSettings();
    } catch (e) { toast(e.message, 'error'); }
}
