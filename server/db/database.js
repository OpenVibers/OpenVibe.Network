'use strict';

// ═══════════════════════════════════════════════════════════════
// openvibe.network — Central Database
// Authoritative source for user accounts, OAuth2 clients,
// themes, the OpenCoins wallet, and cross-platform preferences.
// ═══════════════════════════════════════════════════════════════

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const ROLE_PRIORITY = {
    user: 0,
    streamer: 1,
    global_mod: 2,
    admin: 3,
};

function previewFromVars(vars) {
    return JSON.stringify({
        bg: vars['--bg-primary'] || '#0d0d0f',
        accent: vars['--accent'] || '#8b5cf6',
        text: vars['--text-primary'] || '#e8e6e3',
    });
}

function resolveLiveDbPath() {
    const candidates = [
        process.env.OPENVIBELIVE_DB_PATH,
        '/opt/openvibelive/data/live.db',
        path.resolve(process.cwd(), '..', 'live', 'data', 'live.db'),
        path.resolve(__dirname, '..', '..', '..', 'live', 'data', 'live.db'),
    ].filter(Boolean);

    return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function syncLinkedLiveRoles(db) {
    const hsDbPath = resolveLiveDbPath();
    if (!hsDbPath) return;

    let hsDb;
    try {
        hsDb = new Database(hsDbPath, { readonly: true, fileMustExist: true });
        const rows = db.prepare(`
            SELECT
                u.id AS user_id,
                u.username,
                u.role AS current_role,
                u.legacy_id,
                la.service_user_id,
                la.service_username
            FROM users u
            LEFT JOIN linked_accounts la
                ON la.user_id = u.id
               AND la.service = 'live'
            WHERE u.legacy_source = 'live'
               OR la.service_user_id IS NOT NULL
               OR la.service_username IS NOT NULL
        `).all();

        const selectById = hsDb.prepare('SELECT id, username, role FROM users WHERE id = ?');
        const selectByUsername = hsDb.prepare('SELECT id, username, role FROM users WHERE LOWER(username) = LOWER(?)');
        const updateRole = db.prepare('UPDATE users SET role = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');

        let synced = 0;
        for (const row of rows) {
            const lookupId = Number.parseInt(row.service_user_id || row.legacy_id, 10);
            const lookupUsername = row.service_username || row.username;
            let sourceUser = null;

            if (Number.isFinite(lookupId)) {
                sourceUser = selectById.get(lookupId);
            }
            if (!sourceUser && lookupUsername) {
                sourceUser = selectByUsername.get(lookupUsername);
            }
            if (!sourceUser || !ROLE_PRIORITY.hasOwnProperty(sourceUser.role)) {
                continue;
            }

            const currentRank = ROLE_PRIORITY[row.current_role] ?? 0;
            const sourceRank = ROLE_PRIORITY[sourceUser.role] ?? 0;
            if (sourceRank > currentRank) {
                updateRole.run(sourceUser.role, row.user_id);
                synced += 1;
            }
        }

        if (synced > 0) {
            console.log(`[DB] Synced ${synced} network role(s) from linked OpenVibe.Live accounts`);
        }
    } catch (err) {
        console.warn('[DB] Role sync from OpenVibe.Live skipped:', err.message);
    } finally {
        try { hsDb?.close(); } catch {}
    }
}

function initDb(dbPath) {
    const dir = path.dirname(path.resolve(dbPath));
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const db = new Database(path.resolve(dbPath));
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');

    // ── Schema ───────────────────────────────────────────────
    db.exec(`
        -- Users (canonical identity for the OpenVibe)
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            email TEXT UNIQUE,
            password_hash TEXT NOT NULL,
            display_name TEXT,
            avatar_url TEXT,
            bio TEXT DEFAULT '',
            role TEXT DEFAULT 'user' CHECK(role IN ('user','streamer','global_mod','admin')),
            profile_color TEXT DEFAULT '#8b5cf6',
            is_banned INTEGER DEFAULT 0,
            ban_reason TEXT,
            token_valid_after TEXT DEFAULT NULL,
            legacy_source TEXT,          -- 'live' for migrated accounts
            legacy_id INTEGER,           -- original user ID in source platform
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        -- OAuth2 client registry
        CREATE TABLE IF NOT EXISTS oauth_clients (
            client_id TEXT PRIMARY KEY,
            client_secret TEXT NOT NULL,
            name TEXT NOT NULL,
            redirect_uris TEXT NOT NULL,   -- JSON array of allowed redirect URIs
            is_first_party INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        -- OAuth2 authorization codes (short-lived, single-use)
        CREATE TABLE IF NOT EXISTS oauth_codes (
            code TEXT PRIMARY KEY,
            client_id TEXT NOT NULL,
            user_id INTEGER NOT NULL,
            redirect_uri TEXT NOT NULL,
            scope TEXT DEFAULT 'profile theme',
            expires_at DATETIME NOT NULL,
            used INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (client_id) REFERENCES oauth_clients(client_id),
            FOREIGN KEY (user_id) REFERENCES users(id)
        );

        -- OAuth2 refresh tokens
        CREATE TABLE IF NOT EXISTS oauth_tokens (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            token TEXT UNIQUE NOT NULL,
            client_id TEXT NOT NULL,
            user_id INTEGER NOT NULL,
            scope TEXT DEFAULT 'profile theme',
            expires_at DATETIME NOT NULL,
            revoked INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (client_id) REFERENCES oauth_clients(client_id),
            FOREIGN KEY (user_id) REFERENCES users(id)
        );

        -- User preferences (theme, language, notification settings)
        CREATE TABLE IF NOT EXISTS user_preferences (
            user_id INTEGER PRIMARY KEY,
            theme_id TEXT DEFAULT 'vibe',
            custom_theme_variables TEXT,   -- JSON: custom CSS var overrides
            language TEXT DEFAULT 'en',
            notifications_enabled INTEGER DEFAULT 1,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id)
        );

        -- Theme catalog (built-in + community)
        CREATE TABLE IF NOT EXISTS themes (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            slug TEXT UNIQUE NOT NULL,
            author_id INTEGER,
            description TEXT DEFAULT '',
            mode TEXT DEFAULT 'dark' CHECK(mode IN ('dark','light')),
            variables TEXT NOT NULL,       -- JSON: CSS variable map
            preview_colors TEXT,           -- JSON: preview color swatches
            is_builtin INTEGER DEFAULT 0,
            is_public INTEGER DEFAULT 1,
            downloads INTEGER DEFAULT 0,
            rating_sum INTEGER DEFAULT 0,
            rating_count INTEGER DEFAULT 0,
            tags TEXT DEFAULT '[]',        -- JSON array
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (author_id) REFERENCES users(id)
        );

        -- Linked accounts (which OpenVibe user owns which service-specific account)
        CREATE TABLE IF NOT EXISTS linked_accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            service TEXT NOT NULL,          -- 'live', 'games', etc.
            service_user_id TEXT NOT NULL,
            linked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id),
            UNIQUE(service, service_user_id)
        );

        -- Audit log
        CREATE TABLE IF NOT EXISTS audit_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            action TEXT NOT NULL,
            details TEXT,                 -- JSON context
            ip TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        -- IP log (cross-platform)
        CREATE TABLE IF NOT EXISTS ip_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            ip TEXT NOT NULL,
            action TEXT DEFAULT 'login',
            country TEXT,
            region TEXT,
            city TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id)
        );

        -- Site settings (key-value)
        CREATE TABLE IF NOT EXISTS site_settings (
            key TEXT PRIMARY KEY,
            value TEXT,
            type TEXT DEFAULT 'string'
        );

        -- URL registry for admin-managed first-party and protocol URLs
        CREATE TABLE IF NOT EXISTS url_registry (
            key TEXT PRIMARY KEY,
            label TEXT NOT NULL,
            category TEXT NOT NULL,
            service TEXT NOT NULL,
            scope TEXT NOT NULL,
            type TEXT NOT NULL,
            value TEXT,
            description TEXT,
            updated_by INTEGER,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        -- ═══════════════════════════════════════════════════════
        -- Notifications
        -- ═══════════════════════════════════════════════════════

        -- Central notification store
        CREATE TABLE IF NOT EXISTS notifications (
            id TEXT PRIMARY KEY,              -- UUID
            user_id INTEGER NOT NULL,
            type TEXT NOT NULL,               -- from TYPES enum (FOLLOW, MENTION, etc.)
            category TEXT NOT NULL,           -- social, chat, game, stream, economy, etc.
            priority TEXT NOT NULL DEFAULT 'normal',  -- low, normal, high, critical
            title TEXT NOT NULL,
            message TEXT,
            icon TEXT,
            sender_id INTEGER,               -- who triggered this (nullable)
            sender_name TEXT,                 -- denormalized for display
            sender_avatar TEXT,
            service TEXT,                     -- originating service (openvibelive, etc.)
            url TEXT,                         -- click-through destination
            rich_content TEXT,                -- JSON: images, actions, embeds
            is_read INTEGER DEFAULT 0,
            is_dismissed INTEGER DEFAULT 0,
            is_emailed INTEGER DEFAULT 0,
            expires_at DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_notif_user_read ON notifications(user_id, is_read, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_notif_user_cat ON notifications(user_id, category);
        CREATE INDEX IF NOT EXISTS idx_notif_expires ON notifications(expires_at) WHERE expires_at IS NOT NULL;

        -- Per-user notification preferences (overrides per category)
        CREATE TABLE IF NOT EXISTS notification_preferences (
            user_id INTEGER NOT NULL,
            category TEXT NOT NULL,           -- or '*' for global
            enabled INTEGER DEFAULT 1,
            sound INTEGER DEFAULT 1,
            toasts INTEGER DEFAULT 1,
            email INTEGER DEFAULT 0,
            PRIMARY KEY (user_id, category),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        -- Email delivery log (email metrics / admin visibility)
        CREATE TABLE IF NOT EXISTS email_delivery_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email_type TEXT NOT NULL,
            recipient TEXT NOT NULL,
            subject TEXT,
            status TEXT NOT NULL CHECK(status IN ('sent', 'failed')),
            error_message TEXT,
            user_id INTEGER,
            notification_id TEXT,
            metadata TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
            FOREIGN KEY (notification_id) REFERENCES notifications(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_email_delivery_created ON email_delivery_log(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_email_delivery_status ON email_delivery_log(status, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_email_delivery_type ON email_delivery_log(email_type, created_at DESC);

        -- Password reset tokens
        CREATE TABLE IF NOT EXISTS password_reset_tokens (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            token_hash TEXT UNIQUE NOT NULL,
            expires_at DATETIME NOT NULL,
            used_at DATETIME,
            requested_ip TEXT,
            requested_user_agent TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_password_reset_user ON password_reset_tokens(user_id, used_at, expires_at);
        CREATE INDEX IF NOT EXISTS idx_password_reset_expires ON password_reset_tokens(expires_at);

        -- ═══════════════════════════════════════════════════════
        -- Anonymous Users & Multi-Account Sessions
        -- ═══════════════════════════════════════════════════════

        -- Anonymous user tracking
        CREATE TABLE IF NOT EXISTS anon_users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            anon_number INTEGER UNIQUE NOT NULL,
            fingerprint TEXT,                 -- browser fingerprint hash (optional)
            session_token TEXT UNIQUE NOT NULL,
            display_name TEXT,
            preferences TEXT DEFAULT '{}',    -- JSON
            total_messages INTEGER DEFAULT 0,
            total_commands INTEGER DEFAULT 0,
            first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        -- Multi-account session tracking (like Google multi-login)
        CREATE TABLE IF NOT EXISTS user_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            session_token TEXT UNIQUE NOT NULL,
            device_name TEXT,
            ip TEXT,
            user_agent TEXT,
            is_active INTEGER DEFAULT 1,
            last_used DATETIME DEFAULT CURRENT_TIMESTAMP,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            expires_at DATETIME NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_user ON user_sessions(user_id, is_active);
        CREATE INDEX IF NOT EXISTS idx_sessions_token ON user_sessions(session_token);

        -- ═══════════════════════════════════════════════════════
        -- User Profile Extras
        -- ═══════════════════════════════════════════════════════

        -- Name & particle effects ownership
        CREATE TABLE IF NOT EXISTS user_effects (
            user_id INTEGER NOT NULL,
            effect_type TEXT NOT NULL,         -- 'name' or 'particle'
            effect_id TEXT NOT NULL,           -- e.g. 'rainbow', 'fire', 'neon'
            is_active INTEGER DEFAULT 0,
            acquired_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (user_id, effect_type, effect_id),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        -- User followers
        CREATE TABLE IF NOT EXISTS follows (
            follower_id INTEGER NOT NULL,
            followed_id INTEGER NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (follower_id, followed_id),
            FOREIGN KEY (follower_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (followed_id) REFERENCES users(id) ON DELETE CASCADE
        );

        -- ═══════════════════════════════════════════════════════
        -- OpenCoins Wallet (network-wide currency)
        -- user_id is ALWAYS the Network (SSO) user id.
        -- ═══════════════════════════════════════════════════════

        CREATE TABLE IF NOT EXISTS wallets (
            user_id INTEGER PRIMARY KEY,
            balance INTEGER NOT NULL DEFAULT 0,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS coin_transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            app_id TEXT,
            delta INTEGER NOT NULL,
            reason TEXT,
            ref TEXT,
            idempotency_key TEXT UNIQUE,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_coin_tx_user ON coin_transactions(user_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_coin_tx_app ON coin_transactions(app_id, created_at DESC);

        -- Verification keys (reserved username claims)
        CREATE TABLE IF NOT EXISTS verification_keys (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            key TEXT UNIQUE NOT NULL,
            target_username TEXT NOT NULL,
            note TEXT DEFAULT '',
            created_by INTEGER NOT NULL,
            used_by INTEGER,
            status TEXT DEFAULT 'active' CHECK(status IN ('active', 'used', 'revoked')),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            used_at DATETIME,
            FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (used_by) REFERENCES users(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_vkeys_key ON verification_keys(key);
        CREATE INDEX IF NOT EXISTS idx_vkeys_target ON verification_keys(target_username);
        CREATE INDEX IF NOT EXISTS idx_vkeys_status ON verification_keys(status);
    `);

    // ── Anon IP tracking (unified cross-service anon resolution) ──
    try {
        db.exec(`
            CREATE TABLE IF NOT EXISTS anon_ip_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                anon_id INTEGER NOT NULL,
                ip TEXT NOT NULL,
                first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
                last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (anon_id) REFERENCES anon_users(id) ON DELETE CASCADE,
                UNIQUE(anon_id, ip)
            );
            CREATE INDEX IF NOT EXISTS idx_anon_ip_log_ip ON anon_ip_log(ip);
            CREATE INDEX IF NOT EXISTS idx_anon_ip_log_anon ON anon_ip_log(anon_id);
        `);
    } catch (e) { /* already exists */ }

    // ── Push Subscriptions (Web Push / VAPID) ──
    try {
        db.exec(`
            CREATE TABLE IF NOT EXISTS push_subscriptions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                endpoint TEXT NOT NULL UNIQUE,
                keys_p256dh TEXT NOT NULL,
                keys_auth TEXT NOT NULL,
                user_agent TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_push_sub_user ON push_subscriptions(user_id);
            CREATE INDEX IF NOT EXISTS idx_push_sub_endpoint ON push_subscriptions(endpoint);
        `);
    } catch (e) { /* already exists */ }

    // ── Migration: Add columns that may not exist ────────────
    const migrations = [
        { table: 'linked_accounts', column: 'service_username', sql: "ALTER TABLE linked_accounts ADD COLUMN service_username TEXT" },
        { table: 'url_registry', column: 'source', sql: "ALTER TABLE url_registry ADD COLUMN source TEXT NOT NULL DEFAULT 'admin'" },
        { table: 'users', column: 'is_anon', sql: "ALTER TABLE users ADD COLUMN is_anon INTEGER DEFAULT 0" },
        { table: 'users', column: 'anon_number', sql: "ALTER TABLE users ADD COLUMN anon_number INTEGER" },
        { table: 'users', column: 'name_effect', sql: "ALTER TABLE users ADD COLUMN name_effect TEXT" },
        { table: 'users', column: 'particle_effect', sql: "ALTER TABLE users ADD COLUMN particle_effect TEXT" },
        { table: 'anon_users', column: 'ip', sql: "ALTER TABLE anon_users ADD COLUMN ip TEXT" },
    ];
    for (const m of migrations) {
        const cols = db.prepare(`PRAGMA table_info(${m.table})`).all();
        if (!cols.find(c => c.name === m.column)) {
            try { db.exec(m.sql); console.log(`[DB] Migrated: ${m.table}.${m.column}`); }
            catch (e) { /* already exists — silently skip */ }
        }
    }

    // ── Migration: one linked account per (user, service) ────────
    // The link-account upsert uses ON CONFLICT(user_id, service), which needs a
    // matching unique index (the table only declared UNIQUE(service, service_user_id)).
    try {
        // Drop any pre-existing duplicate (user_id, service) rows, keeping the newest.
        db.exec(`
            DELETE FROM linked_accounts WHERE id NOT IN (
                SELECT MAX(id) FROM linked_accounts GROUP BY user_id, service
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_linked_user_service ON linked_accounts(user_id, service);
        `);
    } catch (e) { console.warn('[DB] linked_accounts unique index migration:', e.message); }

    // ── Seed OAuth2 Clients (per CONTRACTS) ──────────────────
    // Each first-party client is created if missing, with a fresh UUID secret
    // printed exactly once on creation.
    {
        const { v4: uuidv4 } = require('uuid');
        const contractClients = [
            {
                client_id: 'live',
                name: 'OpenVibe.Live',
                redirect_uris: ['https://openvibe.live/api/auth/callback'],
            },
            {
                client_id: 'tools',
                name: 'OpenVibe.Tools',
                redirect_uris: ['https://openvibe.tools/auth/callback'],
            },
            {
                client_id: 'games',
                name: 'OpenVibe.Games',
                redirect_uris: ['https://openvibe.games/auth/callback', 'https://play.openvibe.games/auth/callback'],
            },
            {
                client_id: 'media',
                name: 'OpenVibe.Media',
                redirect_uris: ['https://openvibe.media/auth/callback'],
            },
        ];
        const insert = db.prepare(
            'INSERT INTO oauth_clients (client_id, client_secret, name, redirect_uris, is_first_party) VALUES (?, ?, ?, ?, 1)'
        );
        let seededAny = false;
        for (const c of contractClients) {
            const existing = db.prepare('SELECT client_id, redirect_uris FROM oauth_clients WHERE client_id = ?').get(c.client_id);
            if (!existing) {
                const secret = uuidv4();
                insert.run(c.client_id, secret, c.name, JSON.stringify(c.redirect_uris));
                console.log(`[DB] Seeded OAuth2 client: ${c.client_id} (secret: ${secret})`);
                seededAny = true;
                continue;
            }
            // Ensure existing clients include the contract redirect URIs
            try {
                const uris = new Set(JSON.parse(existing.redirect_uris || '[]'));
                let changed = false;
                for (const uri of c.redirect_uris) {
                    if (!uris.has(uri)) { uris.add(uri); changed = true; }
                }
                if (changed) {
                    db.prepare('UPDATE oauth_clients SET redirect_uris = ? WHERE client_id = ?')
                        .run(JSON.stringify([...uris]), c.client_id);
                    console.log(`[DB] Updated ${c.client_id} redirect_uris to include contract URIs`);
                }
            } catch { /* malformed redirect_uris — leave untouched */ }
        }
        if (seededAny) console.log('[DB] ⚠️  Save these client secrets! They are shown only once.');
    }

    function ensureLocalOauthRedirects() {
        if (process.env.NODE_ENV === 'production' && process.env.BOOTSTRAP_PROFILE !== 'local-dev') return;

        const localClients = [
            {
                clientId: 'live',
                extraUris: ['http://localhost:3000/auth/callback', 'http://localhost:3000/api/auth/callback'],
            },
            {
                clientId: 'tools',
                extraUris: ['http://localhost:4001/auth/callback'],
            },
            {
                clientId: 'games',
                extraUris: ['http://localhost:8000/auth/callback', 'http://localhost:5173/auth/callback'],
            },
            {
                clientId: 'media',
                extraUris: ['http://localhost:4100/auth/callback'],
            },
        ];

        for (const { clientId, extraUris } of localClients) {
            try {
                const client = db.prepare('SELECT redirect_uris FROM oauth_clients WHERE client_id = ?').get(clientId);
                if (!client) continue;
                const uris = new Set(JSON.parse(client.redirect_uris || '[]'));
                let changed = false;
                for (const uri of extraUris) {
                    if (!uris.has(uri)) {
                        uris.add(uri);
                        changed = true;
                    }
                }
                if (changed) {
                    db.prepare('UPDATE oauth_clients SET redirect_uris = ? WHERE client_id = ?')
                        .run(JSON.stringify([...uris]), clientId);
                    console.log(`[DB] Added local redirect_uris for ${clientId}: ${extraUris.join(', ')}`);
                }
            } catch (err) {
                console.warn(`[DB] Failed to add local redirect_uris for ${clientId}:`, err.message);
            }
        }
    }
    ensureLocalOauthRedirects();

    // ── Seed Default Settings ────────────────────────────────
    const settingsCount = db.prepare('SELECT COUNT(*) as cnt FROM site_settings').get().cnt;
    if (settingsCount === 0) {
        const defaults = [
            ['registration_open', 'true', 'boolean'],
            ['platform_name', 'OpenVibe', 'string'],
            ['default_theme', 'vibe', 'string'],
            // Email provider defaults
            ['email_enabled', 'false', 'boolean'],
            ['resend_api_key', '', 'string'],
            ['email_from_address', 'noreply@openvibe.network', 'string'],
            ['email_from_name', 'OpenVibe', 'string'],
            // Notification defaults
            ['notifications_enabled', 'true', 'boolean'],
            ['notification_max_age_days', '90', 'number'],
            ['notification_email_critical_only', 'true', 'boolean'],
        ];
        const insertSetting = db.prepare('INSERT OR IGNORE INTO site_settings (key, value, type) VALUES (?, ?, ?)');
        for (const [k, v, t] of defaults) insertSetting.run(k, v, t);
    }

    // ── Always-Seed Discord + Integration Settings (idempotent) ──
    {
        const alwaysSeed = [
            ['discord_bot_token', '', 'secret'],
            ['discord_guild_id', '', 'string'],
            ['discord_alerts_channel_id', '', 'string'],
            ['discord_system_channel_id', '', 'string'],
            ['discord_dedupe_minutes', '15', 'number'],
            ['discord_alert_message', '', 'string'],
            ['discord_oauth_client_id', '', 'string'],
            ['discord_oauth_client_secret', '', 'secret'],
        ];
        const insertSeed = db.prepare('INSERT OR IGNORE INTO site_settings (key, value, type) VALUES (?, ?, ?)');
        for (const [k, v, t] of alwaysSeed) insertSeed.run(k, v, t);
    }

    // ── Sync Built-in Themes ─────────────────────────────────
    {
        const { BUILTIN_THEMES } = require('openvibe-shared/theme-sync');
        const upsertTheme = db.prepare(`
            INSERT INTO themes (id, name, slug, description, mode, variables, preview_colors, is_builtin, is_public, tags, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                slug = excluded.slug,
                description = excluded.description,
                mode = excluded.mode,
                variables = excluded.variables,
                preview_colors = excluded.preview_colors,
                is_builtin = 1,
                is_public = 1,
                tags = excluded.tags,
                updated_at = CURRENT_TIMESTAMP
        `);
        for (const t of BUILTIN_THEMES) {
            upsertTheme.run(
                t.id,
                t.name,
                t.slug,
                t.description,
                t.mode,
                JSON.stringify(t.variables || {}),
                previewFromVars(t.variables || {}),
                JSON.stringify(t.tags || [])
            );
        }
        console.log(`[DB] Synced ${BUILTIN_THEMES.length} built-in themes`);
    }

    // ── Sync Roles From Linked OpenVibe.Live Accounts ────────
    syncLinkedLiveRoles(db);

    // ── Helper: getSetting ───────────────────────────────────
    db.getSetting = function (key) {
        const row = this.prepare('SELECT value, type FROM site_settings WHERE key = ?').get(key);
        if (!row) return null;
        if (row.type === 'boolean') return row.value === 'true';
        if (row.type === 'number') return Number(row.value);
        return row.value;
    };

    // ── Verification Key helpers ─────────────────────────────
    db.createVerificationKey = function ({ key, target_username, note, created_by }) {
        return this.prepare(
            'INSERT INTO verification_keys (key, target_username, note, created_by) VALUES (?, ?, ?, ?)'
        ).run(key, target_username, note || '', created_by);
    };

    db.getVerificationKeyByKey = function (key) {
        return this.prepare('SELECT * FROM verification_keys WHERE key = ?').get(key);
    };

    db.getVerificationKeyByUsername = function (username) {
        return this.prepare("SELECT * FROM verification_keys WHERE target_username = ? COLLATE NOCASE AND status = 'active'").get(username);
    };

    db.getAllVerificationKeys = function () {
        return this.prepare(`
            SELECT vk.*, u1.username as created_by_name, u2.username as used_by_name
            FROM verification_keys vk
            LEFT JOIN users u1 ON vk.created_by = u1.id
            LEFT JOIN users u2 ON vk.used_by = u2.id
            ORDER BY vk.created_at DESC
        `).all();
    };

    db.redeemVerificationKey = function (key, userId) {
        return this.prepare(
            "UPDATE verification_keys SET status = 'used', used_by = ?, used_at = CURRENT_TIMESTAMP WHERE key = ? AND status = 'active'"
        ).run(userId, key);
    };

    db.revokeVerificationKey = function (id) {
        return this.prepare("UPDATE verification_keys SET status = 'revoked' WHERE id = ? AND status = 'active'").run(id);
    };

    db.isUsernameReserved = function (username) {
        const vk = this.prepare("SELECT id FROM verification_keys WHERE target_username = ? COLLATE NOCASE AND status = 'active'").get(username);
        return !!vk;
    };

    console.log('[DB] Central database initialized');
    return db;
}

module.exports = { initDb };
