-- OpenVibe.Network SQLite schema at commit 20dd7ff (the last SQLite release, in production before the T2 cutover).
-- Generated from that commit's server booted once on an empty file (initDb() plus the tables its modules create
-- lazily at startup: analytics, account merges/exports/deletions, history, frame cache, …): sqlite_master in
-- creation order. Read by scripts/rehearse-pg-cutover.js to build the seeded rehearsal database. Do not edit by
-- hand: it is history.

CREATE TABLE users (
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
        , is_anon INTEGER DEFAULT 0, anon_number INTEGER, name_effect TEXT, particle_effect TEXT, email_verified INTEGER DEFAULT 0, email_verified_at DATETIME, email_bounced_at DATETIME, email_bounce_reason TEXT, history_paused INTEGER DEFAULT 0, subject_id TEXT, merged_into INTEGER, deleted_at TEXT, profile_revision INTEGER NOT NULL DEFAULT 0);

CREATE TABLE oauth_clients (
            client_id TEXT PRIMARY KEY,
            client_secret TEXT NOT NULL,
            name TEXT NOT NULL,
            redirect_uris TEXT NOT NULL,   -- JSON array of allowed redirect URIs
            is_first_party INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

CREATE TABLE oauth_codes (
            code TEXT PRIMARY KEY,
            client_id TEXT NOT NULL,
            user_id INTEGER NOT NULL,
            redirect_uri TEXT NOT NULL,
            scope TEXT DEFAULT 'profile theme',
            expires_at DATETIME NOT NULL,
            used INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP, code_challenge TEXT, code_challenge_method TEXT, nonce TEXT,
            FOREIGN KEY (client_id) REFERENCES oauth_clients(client_id),
            FOREIGN KEY (user_id) REFERENCES users(id)
        );

CREATE TABLE oauth_tokens (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            token TEXT UNIQUE NOT NULL,
            client_id TEXT NOT NULL,
            user_id INTEGER NOT NULL,
            scope TEXT DEFAULT 'profile theme',
            expires_at DATETIME NOT NULL,
            revoked INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP, family_id TEXT, generation INTEGER NOT NULL DEFAULT 0, revoked_reason TEXT, revoked_at DATETIME,
            FOREIGN KEY (client_id) REFERENCES oauth_clients(client_id),
            FOREIGN KEY (user_id) REFERENCES users(id)
        );

CREATE TABLE user_preferences (
            user_id INTEGER PRIMARY KEY,
            theme_id TEXT DEFAULT 'vibe',
            custom_theme_variables TEXT,   -- JSON: custom CSS var overrides
            language TEXT DEFAULT 'en',
            notifications_enabled INTEGER DEFAULT 1,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, display_prefs TEXT,
            FOREIGN KEY (user_id) REFERENCES users(id)
        );

CREATE TABLE themes (
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

CREATE TABLE linked_accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            service TEXT NOT NULL,          -- 'live', 'games', etc.
            service_user_id TEXT NOT NULL,
            linked_at DATETIME DEFAULT CURRENT_TIMESTAMP, service_username TEXT, last_used_at DATETIME,
            FOREIGN KEY (user_id) REFERENCES users(id),
            UNIQUE(service, service_user_id)
        );

CREATE TABLE audit_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            action TEXT NOT NULL,
            details TEXT,                 -- JSON context
            ip TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

CREATE TABLE ip_log (
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

CREATE TABLE site_settings (
            key TEXT PRIMARY KEY,
            value TEXT,
            type TEXT DEFAULT 'string'
        );

CREATE TABLE url_registry (
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
        , source TEXT NOT NULL DEFAULT 'admin');

CREATE TABLE notifications (
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

CREATE INDEX idx_notif_user_read ON notifications(user_id, is_read, created_at DESC);

CREATE INDEX idx_notif_user_cat ON notifications(user_id, category);

CREATE INDEX idx_notif_expires ON notifications(expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE notification_preferences (
            user_id INTEGER NOT NULL,
            category TEXT NOT NULL,           -- or '*' for global
            enabled INTEGER DEFAULT 1,
            sound INTEGER DEFAULT 1,
            toasts INTEGER DEFAULT 1,
            email INTEGER DEFAULT 0,
            PRIMARY KEY (user_id, category),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

CREATE TABLE email_delivery_log (
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

CREATE INDEX idx_email_delivery_created ON email_delivery_log(created_at DESC);

CREATE INDEX idx_email_delivery_status ON email_delivery_log(status, created_at DESC);

CREATE INDEX idx_email_delivery_type ON email_delivery_log(email_type, created_at DESC);

CREATE TABLE password_reset_tokens (
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

CREATE INDEX idx_password_reset_user ON password_reset_tokens(user_id, used_at, expires_at);

CREATE INDEX idx_password_reset_expires ON password_reset_tokens(expires_at);

CREATE TABLE anon_users (
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
        , ip TEXT, subject_id TEXT);

CREATE TABLE user_sessions (
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

CREATE INDEX idx_sessions_user ON user_sessions(user_id, is_active);

CREATE INDEX idx_sessions_token ON user_sessions(session_token);

CREATE TABLE user_effects (
            user_id INTEGER NOT NULL,
            effect_type TEXT NOT NULL,         -- 'name' or 'particle'
            effect_id TEXT NOT NULL,           -- e.g. 'rainbow', 'fire', 'neon'
            is_active INTEGER DEFAULT 0,
            acquired_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (user_id, effect_type, effect_id),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

CREATE TABLE follows (
            follower_id INTEGER NOT NULL,
            followed_id INTEGER NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (follower_id, followed_id),
            FOREIGN KEY (follower_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (followed_id) REFERENCES users(id) ON DELETE CASCADE
        );

CREATE TABLE wallets (
            user_id INTEGER PRIMARY KEY,
            balance INTEGER NOT NULL DEFAULT 0,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

CREATE TABLE coin_transactions (
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

CREATE INDEX idx_coin_tx_user ON coin_transactions(user_id, created_at DESC);

CREATE INDEX idx_coin_tx_app ON coin_transactions(app_id, created_at DESC);

CREATE TABLE verification_keys (
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

CREATE INDEX idx_vkeys_key ON verification_keys(key);

CREATE INDEX idx_vkeys_target ON verification_keys(target_username);

CREATE INDEX idx_vkeys_status ON verification_keys(status);

CREATE TABLE anon_ip_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                anon_id INTEGER NOT NULL,
                ip TEXT NOT NULL,
                first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
                last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (anon_id) REFERENCES anon_users(id) ON DELETE CASCADE,
                UNIQUE(anon_id, ip)
            );

CREATE INDEX idx_anon_ip_log_ip ON anon_ip_log(ip);

CREATE INDEX idx_anon_ip_log_anon ON anon_ip_log(anon_id);

CREATE TABLE push_subscriptions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                endpoint TEXT NOT NULL UNIQUE,
                keys_p256dh TEXT NOT NULL,
                keys_auth TEXT NOT NULL,
                user_agent TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );

CREATE INDEX idx_push_sub_user ON push_subscriptions(user_id);

CREATE INDEX idx_push_sub_endpoint ON push_subscriptions(endpoint);

CREATE INDEX idx_oauth_tokens_family ON oauth_tokens(family_id);

CREATE TABLE email_verification_tokens (
                token_hash TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL,
                email TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                expires_at DATETIME NOT NULL,
                used_at DATETIME,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );

CREATE INDEX idx_email_verify_user ON email_verification_tokens(user_id, created_at DESC);

CREATE UNIQUE INDEX idx_linked_user_service ON linked_accounts(user_id, service);

CREATE TABLE identity_legacy_map (
            source_system TEXT NOT NULL,
            source_type   TEXT NOT NULL,
            source_id     TEXT NOT NULL,
            subject_id    TEXT NOT NULL,
            first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            verified_at   DATETIME,
            metadata      TEXT,
            PRIMARY KEY (source_system, source_type, source_id)
        );

CREATE INDEX idx_identity_legacy_subject ON identity_legacy_map(subject_id);

CREATE UNIQUE INDEX idx_users_subject_id ON users(subject_id);

CREATE UNIQUE INDEX idx_anon_users_subject_id ON anon_users(subject_id);

CREATE TABLE principal_grants (
            client_id  TEXT NOT NULL,
            capability TEXT NOT NULL,
            audience   TEXT NOT NULL,
            namespaces TEXT NOT NULL DEFAULT '[]',
            granted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            granted_by TEXT,
            revoked_at DATETIME, expires_at DATETIME, reason TEXT, revoked_by TEXT,
            PRIMARY KEY (client_id, capability, audience)
        );

CREATE TABLE principal_usage (
            principal  TEXT NOT NULL,
            route      TEXT NOT NULL,
            capability TEXT NOT NULL,
            auth       TEXT NOT NULL,
            allowed    INTEGER NOT NULL,
            code       TEXT NOT NULL DEFAULT '',
            count      INTEGER NOT NULL DEFAULT 0,
            first_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (principal, route, auth, allowed, code)
        );

CREATE TABLE principal_grant_changes (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id   TEXT NOT NULL,
        capability  TEXT NOT NULL,
        audience    TEXT NOT NULL,
        change      TEXT NOT NULL CHECK (change IN ('granted', 'updated', 'revoked', 'expired')),
        namespaces  TEXT NOT NULL DEFAULT '[]',
        expires_at  TEXT,
        reason      TEXT,
        actor       TEXT,
        event_id    TEXT,
        at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

CREATE INDEX idx_grant_changes_client ON principal_grant_changes(client_id, id);

CREATE TABLE user_modules (
            subject_id TEXT NOT NULL,
            namespace  TEXT NOT NULL,
            version    INTEGER NOT NULL,
            revision   INTEGER NOT NULL DEFAULT 0,
            data       TEXT NOT NULL,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_by TEXT,
            PRIMARY KEY (subject_id, namespace)
        );

CREATE TABLE user_module_revisions (
            subject_id TEXT NOT NULL,
            namespace  TEXT NOT NULL,
            revision   INTEGER NOT NULL,
            PRIMARY KEY (subject_id, namespace)
        );

CREATE TABLE user_module_retirements (
            namespace       TEXT PRIMARY KEY,
            owner           TEXT NOT NULL,
            retired_seen_at INTEGER NOT NULL
        );

CREATE TABLE network_event_outbox (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id        TEXT NOT NULL UNIQUE,
            envelope        TEXT NOT NULL,
            traceparent     TEXT,
            created_at      INTEGER NOT NULL,
            attempts        INTEGER NOT NULL DEFAULT 0,
            next_attempt_at INTEGER NOT NULL DEFAULT 0,
            sent_at         INTEGER,
            seq             INTEGER,
            rejected_at     INTEGER,
            last_error      TEXT
        );

CREATE INDEX idx_network_event_outbox_due ON network_event_outbox(sent_at, rejected_at, next_attempt_at);

CREATE TRIGGER user_modules_guard_users_delete BEFORE DELETE ON users
            WHEN OLD.subject_id IS NOT NULL AND EXISTS (SELECT 1 FROM user_modules WHERE subject_id = OLD.subject_id)
            BEGIN SELECT RAISE(ABORT, 'user_modules rows remain for this subject: call modules.onSubjectRemoved or onSubjectMerged first'); END;

CREATE TRIGGER user_modules_guard_users_rekey BEFORE UPDATE OF subject_id ON users
            WHEN OLD.subject_id IS NOT NULL AND NEW.subject_id IS NOT OLD.subject_id
                 AND EXISTS (SELECT 1 FROM user_modules WHERE subject_id = OLD.subject_id)
            BEGIN SELECT RAISE(ABORT, 'user_modules rows remain for this subject: call modules.onSubjectMerged first'); END;

CREATE TRIGGER user_modules_guard_anon_users_delete BEFORE DELETE ON anon_users
            WHEN OLD.subject_id IS NOT NULL AND EXISTS (SELECT 1 FROM user_modules WHERE subject_id = OLD.subject_id)
            BEGIN SELECT RAISE(ABORT, 'user_modules rows remain for this subject: call modules.onSubjectRemoved or onSubjectMerged first'); END;

CREATE TRIGGER user_modules_guard_anon_users_rekey BEFORE UPDATE OF subject_id ON anon_users
            WHEN OLD.subject_id IS NOT NULL AND NEW.subject_id IS NOT OLD.subject_id
                 AND EXISTS (SELECT 1 FROM user_modules WHERE subject_id = OLD.subject_id)
            BEGIN SELECT RAISE(ABORT, 'user_modules rows remain for this subject: call modules.onSubjectMerged first'); END;

CREATE TABLE dev_projects (
            id                 TEXT PRIMARY KEY,
            owner_subject      TEXT NOT NULL,
            name               TEXT NOT NULL,
            environment_policy TEXT NOT NULL DEFAULT 'sandbox' CHECK (environment_policy IN ('sandbox', 'sandbox+production')),
            allowance          TEXT NOT NULL DEFAULT '[]',
            created_at         TEXT NOT NULL,
            created_by         TEXT NOT NULL,
            archived_at        TEXT,
            archived_by        TEXT
        );

CREATE INDEX idx_dev_projects_owner ON dev_projects(owner_subject);

CREATE TABLE dev_project_members (
            project_id TEXT NOT NULL REFERENCES dev_projects(id),
            subject_id TEXT NOT NULL,
            role       TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'developer', 'viewer')),
            added_at   TEXT NOT NULL,
            added_by   TEXT NOT NULL,
            PRIMARY KEY (project_id, subject_id)
        );

CREATE INDEX idx_dev_members_subject ON dev_project_members(subject_id);

CREATE TABLE dev_apps (
            id              TEXT PRIMARY KEY,
            project_id      TEXT NOT NULL REFERENCES dev_projects(id),
            name            TEXT NOT NULL,
            environment     TEXT NOT NULL CHECK (environment IN ('sandbox', 'production')),
            oauth_client_id TEXT NOT NULL UNIQUE,
            client_type     TEXT NOT NULL CHECK (client_type IN ('confidential', 'public')),
            redirect_uris   TEXT NOT NULL DEFAULT '[]',
            created_at      TEXT NOT NULL,
            created_by      TEXT NOT NULL,
            revoked_at      TEXT,
            revoked_by      TEXT
        );

CREATE INDEX idx_dev_apps_project ON dev_apps(project_id);

CREATE TABLE dev_credentials (
            id           TEXT PRIMARY KEY,
            app_id       TEXT NOT NULL REFERENCES dev_apps(id),
            secret_hash  TEXT NOT NULL UNIQUE,
            hint         TEXT NOT NULL,
            created_at   TEXT NOT NULL,
            created_by   TEXT NOT NULL,
            expires_at   TEXT,
            revoked_at   TEXT,
            revoked_by   TEXT,
            last_used_at TEXT
        );

CREATE INDEX idx_dev_credentials_app ON dev_credentials(app_id);

CREATE TABLE dev_grants (
            app_id       TEXT NOT NULL REFERENCES dev_apps(id),
            capability   TEXT NOT NULL,
            audience     TEXT NOT NULL,
            status       TEXT NOT NULL CHECK (status IN ('requested', 'approved', 'denied', 'revoked')),
            requested_by TEXT NOT NULL,
            requested_at TEXT NOT NULL,
            decided_by   TEXT,
            decided_at   TEXT,
            PRIMARY KEY (app_id, capability)
        );

CREATE TABLE dev_quotas (
            project_id   TEXT NOT NULL REFERENCES dev_projects(id),
            capability   TEXT NOT NULL,
            limit_value  INTEGER NOT NULL CHECK (limit_value >= 0),
            quota_window TEXT NOT NULL CHECK (quota_window IN ('minute', 'hour', 'day', 'month', 'total')),
            unit         TEXT NOT NULL DEFAULT 'requests',
            updated_at   TEXT NOT NULL,
            updated_by   TEXT NOT NULL,
            PRIMARY KEY (project_id, capability)
        );

CREATE TABLE dev_auth_codes (
            code_hash      TEXT PRIMARY KEY,
            app_id         TEXT NOT NULL REFERENCES dev_apps(id),
            user_subject   TEXT NOT NULL,
            redirect_uri   TEXT NOT NULL,
            scope          TEXT NOT NULL DEFAULT '',
            code_challenge TEXT NOT NULL,
            expires_at     TEXT NOT NULL,
            used           INTEGER NOT NULL DEFAULT 0
        );

CREATE TABLE dev_audit (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            at         TEXT NOT NULL,
            project_id TEXT,
            actor      TEXT NOT NULL,
            action     TEXT NOT NULL,
            target     TEXT,
            detail     TEXT NOT NULL DEFAULT '{}',
            request_id TEXT,
            event_type TEXT,
            event      TEXT
        );

CREATE INDEX idx_dev_audit_project ON dev_audit(project_id, id);

CREATE TRIGGER dev_audit_append_only_update BEFORE UPDATE ON dev_audit
            BEGIN SELECT RAISE(ABORT, 'dev_audit is append-only'); END;

CREATE TRIGGER dev_audit_append_only_delete BEFORE DELETE ON dev_audit
            BEGIN SELECT RAISE(ABORT, 'dev_audit is append-only'); END;

CREATE TABLE dev_usage_windows (
            project_id   TEXT NOT NULL,
            env          TEXT NOT NULL CHECK (env IN ('sandbox', 'production')),
            service      TEXT NOT NULL,
            capability   TEXT NOT NULL,
            dimension    TEXT NOT NULL DEFAULT '',
            unit         TEXT NOT NULL,
            window_start TEXT NOT NULL,
            window_end   TEXT NOT NULL,
            quantity     INTEGER NOT NULL,
            errors       INTEGER NOT NULL,
            error_codes  TEXT NOT NULL DEFAULT '{}',
            revision     INTEGER NOT NULL DEFAULT 1,
            event_id     TEXT NOT NULL,
            recorded_at  TEXT NOT NULL,
            PRIMARY KEY (project_id, env, service, capability, dimension, unit, window_start)
        );

CREATE INDEX idx_dev_usage_windows_when ON dev_usage_windows(window_start);

CREATE INDEX idx_dev_usage_windows_project ON dev_usage_windows(project_id, recorded_at);

CREATE TABLE dev_usage_daily (
            project_id  TEXT NOT NULL,
            env         TEXT NOT NULL,
            service     TEXT NOT NULL,
            capability  TEXT NOT NULL,
            dimension   TEXT NOT NULL DEFAULT '',
            unit        TEXT NOT NULL,
            day         TEXT NOT NULL,
            quantity    INTEGER NOT NULL DEFAULT 0,
            errors      INTEGER NOT NULL DEFAULT 0,
            error_codes TEXT NOT NULL DEFAULT '{}',
            updated_at  TEXT NOT NULL,
            PRIMARY KEY (project_id, env, service, capability, dimension, unit, day)
        );

CREATE INDEX idx_dev_usage_daily_day ON dev_usage_daily(project_id, day);

CREATE TABLE dev_usage_errors (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id TEXT NOT NULL,
            env        TEXT NOT NULL,
            service    TEXT NOT NULL,
            capability TEXT NOT NULL,
            at         TEXT NOT NULL,
            code       TEXT NOT NULL,
            status     INTEGER,
            trace_id   TEXT,
            ref        TEXT NOT NULL DEFAULT '',
            event_id   TEXT NOT NULL
        );

CREATE UNIQUE INDEX idx_dev_usage_errors_once ON dev_usage_errors(project_id, env, service, capability, at, code, ref);

CREATE INDEX idx_dev_usage_errors_recent ON dev_usage_errors(project_id, at);

CREATE TABLE user_blocks (
        blocker_subject TEXT NOT NULL,
        blocked_subject TEXT NOT NULL,
        active          INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        revision        INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
        created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        PRIMARY KEY (blocker_subject, blocked_subject),
        CHECK (blocker_subject <> blocked_subject)
    );

CREATE INDEX idx_user_blocks_blocked ON user_blocks(blocked_subject, active);

CREATE TABLE user_follows (
        follower_subject TEXT NOT NULL,
        target_type      TEXT NOT NULL CHECK (target_type IN ('channel')),
        target_id        TEXT NOT NULL,
        active           INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        notify_email     INTEGER NOT NULL DEFAULT 1 CHECK (notify_email IN (0, 1)),
        notify_push      INTEGER NOT NULL DEFAULT 1 CHECK (notify_push IN (0, 1)),
        revision         INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
        source           TEXT NOT NULL DEFAULT 'network',
        created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        PRIMARY KEY (follower_subject, target_type, target_id),
        CHECK (follower_subject <> target_id)
    );

CREATE INDEX idx_user_follows_target ON user_follows(target_type, target_id, active, created_at);

CREATE TABLE follow_import_holds (
        source        TEXT NOT NULL,
        follower_ref  TEXT NOT NULL,
        target_ref    TEXT NOT NULL,
        reason        TEXT NOT NULL,
        seen_at       TEXT NOT NULL,
        PRIMARY KEY (source, follower_ref, target_ref)
    );

CREATE TABLE status_incidents (
        id         TEXT PRIMARY KEY,
        kind       TEXT NOT NULL CHECK (kind IN ('incident', 'maintenance')),
        title      TEXT NOT NULL,
        severity   TEXT CHECK (severity IS NULL OR severity IN ('minor', 'major', 'critical')),
        state      TEXT NOT NULL,
        services   TEXT NOT NULL DEFAULT '[]',
        starts_at  TEXT NOT NULL,
        ends_at    TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );

CREATE TABLE status_incident_updates (
        incident_id TEXT NOT NULL REFERENCES status_incidents(id),
        at          TEXT NOT NULL,
        state       TEXT NOT NULL,
        message     TEXT NOT NULL,
        author      TEXT NOT NULL
    );

CREATE INDEX idx_status_incident_updates ON status_incident_updates(incident_id, at);

CREATE TABLE creator_streams (
        stream_id        INTEGER PRIMARY KEY,
        creator_subject  TEXT NOT NULL,
        title            TEXT,
        category         TEXT,
        started_at       TEXT NOT NULL,
        ended_at         TEXT NOT NULL,
        duration_seconds INTEGER NOT NULL DEFAULT 0,
        peak_viewers     INTEGER,
        avg_viewers      REAL,
        unique_chatters  INTEGER,
        messages         INTEGER,
        watch_minutes    INTEGER,
        received_at      TEXT NOT NULL
    );

CREATE INDEX idx_creator_streams_creator ON creator_streams(creator_subject, started_at);

CREATE TABLE platform_nodes (
        id          TEXT PRIMARY KEY,
        source      TEXT NOT NULL,
        doc         TEXT NOT NULL,
        status      TEXT NOT NULL,
        reported_at TEXT NOT NULL
    );

CREATE TABLE analytics_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        service TEXT NOT NULL,
        event_type TEXT NOT NULL DEFAULT 'pageview',
        path TEXT,
        method TEXT DEFAULT 'GET',
        status_code INTEGER,
        response_time_ms INTEGER,
        user_id INTEGER,
        session_id TEXT,
        ip TEXT,
        country TEXT,
        city TEXT,
        user_agent TEXT,
        referer TEXT,
        is_bot INTEGER DEFAULT 0,
        bot_type TEXT,
        device_type TEXT,
        browser TEXT,
        os TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    , authenticated INTEGER NOT NULL DEFAULT 0);

CREATE TABLE analytics_hourly (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        service TEXT NOT NULL,
        hour TEXT NOT NULL,
        pageviews INTEGER DEFAULT 0,
        api_calls INTEGER DEFAULT 0,
        unique_visitors INTEGER DEFAULT 0,
        unique_users INTEGER DEFAULT 0,
        bot_hits INTEGER DEFAULT 0,
        avg_response_ms INTEGER DEFAULT 0,
        error_count INTEGER DEFAULT 0,
        bandwidth_bytes INTEGER DEFAULT 0,
        top_paths TEXT,
        top_referers TEXT,
        UNIQUE(service, hour)
    );

CREATE TABLE analytics_daily (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        service TEXT NOT NULL,
        date TEXT NOT NULL,
        pageviews INTEGER DEFAULT 0,
        api_calls INTEGER DEFAULT 0,
        unique_visitors INTEGER DEFAULT 0,
        unique_users INTEGER DEFAULT 0,
        new_users INTEGER DEFAULT 0,
        bot_hits INTEGER DEFAULT 0,
        avg_response_ms INTEGER DEFAULT 0,
        error_count INTEGER DEFAULT 0,
        top_paths TEXT,
        top_referers TEXT,
        top_countries TEXT,
        device_breakdown TEXT,
        browser_breakdown TEXT,
        UNIQUE(service, date)
    );

CREATE TABLE analytics_rate_tracking (
        ip TEXT NOT NULL,
        window_start INTEGER NOT NULL,
        hit_count INTEGER DEFAULT 1,
        PRIMARY KEY (ip, window_start)
    );

CREATE TABLE analytics_visitor_days (
        service TEXT NOT NULL,
        day TEXT NOT NULL,
        hour TEXT NOT NULL,
        vhash TEXT NOT NULL,
        authenticated INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (service, hour, vhash)
    );

CREATE TABLE analytics_day_salts (
        service TEXT NOT NULL,
        day TEXT NOT NULL,
        salt TEXT NOT NULL,
        PRIMARY KEY (service, day)
    );

CREATE INDEX idx_analytics_events_created ON analytics_events(created_at);

CREATE INDEX idx_analytics_events_service ON analytics_events(service, created_at);

CREATE INDEX idx_analytics_events_path ON analytics_events(service, path, created_at);

CREATE INDEX idx_analytics_events_bot ON analytics_events(is_bot, created_at);

CREATE INDEX idx_analytics_hourly_lookup ON analytics_hourly(service, hour);

CREATE INDEX idx_analytics_daily_lookup ON analytics_daily(service, date);

CREATE INDEX idx_analytics_visitor_days_day ON analytics_visitor_days(service, day);

CREATE TABLE moderation_audit (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id       TEXT NOT NULL UNIQUE,
            service        TEXT NOT NULL,
            action         TEXT NOT NULL,
            actor_subject  TEXT,
            target_type    TEXT,
            target_id      TEXT,
            target_subject TEXT,
            scope          TEXT,
            reason         TEXT,
            details        TEXT NOT NULL DEFAULT '{}',
            occurred_at    TEXT NOT NULL,
            recorded_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );

CREATE INDEX idx_modaudit_when ON moderation_audit(occurred_at);

CREATE INDEX idx_modaudit_service ON moderation_audit(service, id);

CREATE INDEX idx_modaudit_actor ON moderation_audit(actor_subject, id);

CREATE TABLE network_event_inbox (
            consumer     TEXT NOT NULL,
            event_id     TEXT NOT NULL,
            processed_at INTEGER NOT NULL,
            PRIMARY KEY (consumer, event_id)
        );

CREATE TABLE subject_aliases (
            alias_id   TEXT PRIMARY KEY,
            subject_id TEXT NOT NULL,
            merge_id   TEXT NOT NULL,
            merged_at  TEXT NOT NULL,
            merged_by  TEXT NOT NULL
        );

CREATE INDEX idx_subject_aliases_subject ON subject_aliases(subject_id);

CREATE TABLE account_merges (
            id            TEXT PRIMARY KEY,
            from_subject  TEXT NOT NULL UNIQUE,
            into_subject  TEXT NOT NULL,
            from_user_id  INTEGER NOT NULL,
            into_user_id  INTEGER NOT NULL,
            initiated_by  TEXT NOT NULL CHECK (initiated_by IN ('person', 'staff')),
            actor_subject TEXT NOT NULL,
            reason        TEXT,
            moved         TEXT NOT NULL,
            pre_state     TEXT,
            merged_at     TEXT NOT NULL,
            split_until   TEXT NOT NULL,
            reduced_at    TEXT
        );

CREATE TABLE account_merge_intents (
            id           TEXT PRIMARY KEY,
            into_user_id INTEGER NOT NULL,
            created_at   INTEGER NOT NULL,
            expires_at   INTEGER NOT NULL,
            used_at      INTEGER
        );

CREATE TABLE mod_principals (
            mod_id     TEXT PRIMARY KEY,
            owner      TEXT NOT NULL,
            runtime    TEXT NOT NULL,
            name       TEXT,
            version    TEXT,
            publisher  TEXT,
            manifest   TEXT NOT NULL,
            status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
            revision   INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            created_by TEXT,
            updated_at TEXT NOT NULL,
            revoked_at TEXT,
            revoked_by TEXT
        );

CREATE TABLE mod_principal_grants (
            mod_id     TEXT NOT NULL,
            capability TEXT NOT NULL,
            state      TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'revoked')),
            changed_at TEXT NOT NULL,
            changed_by TEXT,
            PRIMARY KEY (mod_id, capability)
        );

CREATE TABLE account_exports (
            id           TEXT PRIMARY KEY,
            user_id      INTEGER NOT NULL,
            subject      TEXT NOT NULL,
            status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'partial', 'expired', 'failed')),
            expected     TEXT NOT NULL DEFAULT '[]',
            requested_at TEXT NOT NULL,
            deadline     TEXT NOT NULL,
            ready_at     TEXT,
            expires_at   TEXT,
            size_bytes   INTEGER,
            services     TEXT,
            error        TEXT
        );

CREATE INDEX idx_account_exports_user ON account_exports(user_id, requested_at);

CREATE TABLE account_export_parts (
            export_id   TEXT NOT NULL,
            service     TEXT NOT NULL,
            received_at TEXT NOT NULL,
            files       INTEGER NOT NULL,
            bytes       INTEGER NOT NULL,
            body        TEXT,
            PRIMARY KEY (export_id, service)
        );

CREATE TABLE account_deletions (
            id           TEXT PRIMARY KEY,
            user_id      INTEGER NOT NULL,
            subject      TEXT NOT NULL,
            status       TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'cancelled', 'deleted')),
            requested_at TEXT NOT NULL,
            delete_after TEXT NOT NULL,
            cancelled_at TEXT,
            cancelled_by TEXT,
            deleted_at   TEXT,
            expected     TEXT,
            erased       TEXT
        );

CREATE UNIQUE INDEX idx_account_deletions_open ON account_deletions(user_id) WHERE status = 'scheduled';

CREATE TABLE account_deletion_confirmations (
            deletion_id  TEXT NOT NULL,
            service      TEXT NOT NULL,
            received_at  TEXT NOT NULL,
            completed_at TEXT NOT NULL,
            erased       TEXT NOT NULL,
            retained     TEXT NOT NULL,
            PRIMARY KEY (deletion_id, service)
        );

CREATE TABLE user_profile_changes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            changed TEXT NOT NULL,
            at INTEGER NOT NULL
        );

CREATE INDEX idx_user_profile_changes_user ON user_profile_changes(user_id);

CREATE TRIGGER users_profile_changed AFTER UPDATE OF username, display_name, avatar_url, profile_color, role, is_banned ON users
        WHEN COALESCE(NEW.is_anon, 0) = 0 AND (OLD.username IS NOT NEW.username OR OLD.display_name IS NOT NEW.display_name OR OLD.avatar_url IS NOT NEW.avatar_url OR OLD.profile_color IS NOT NEW.profile_color OR OLD.role IS NOT NEW.role OR OLD.is_banned IS NOT NEW.is_banned)
        BEGIN INSERT INTO user_profile_changes (user_id, changed, at) VALUES (NEW.id, trim((CASE WHEN OLD.username IS NOT NEW.username THEN 'username ' ELSE '' END) || (CASE WHEN OLD.display_name IS NOT NEW.display_name THEN 'display_name ' ELSE '' END) || (CASE WHEN OLD.avatar_url IS NOT NEW.avatar_url THEN 'avatar_url ' ELSE '' END) || (CASE WHEN OLD.profile_color IS NOT NEW.profile_color THEN 'profile_color ' ELSE '' END) || (CASE WHEN OLD.role IS NOT NEW.role THEN 'role ' ELSE '' END) || (CASE WHEN OLD.is_banned IS NOT NEW.is_banned THEN 'banned ' ELSE '' END)), CAST(strftime('%s', 'now') AS INTEGER) * 1000); END;

CREATE TRIGGER users_profile_created AFTER INSERT ON users
        WHEN COALESCE(NEW.is_anon, 0) = 0
        BEGIN INSERT INTO user_profile_changes (user_id, changed, at) VALUES (NEW.id, 'created', CAST(strftime('%s', 'now') AS INTEGER) * 1000); END;

CREATE TABLE user_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            service TEXT,
            sub TEXT,
            type TEXT NOT NULL DEFAULT 'page',
            title TEXT NOT NULL,
            url TEXT NOT NULL,
            icon TEXT,
            meta TEXT,
            hits INTEGER NOT NULL DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id)
        );

CREATE INDEX idx_user_history_user_time ON user_history(user_id, updated_at DESC);

CREATE INDEX idx_user_history_user_url ON user_history(user_id, url);

CREATE TABLE frame_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);

CREATE TABLE frame_hits (day TEXT NOT NULL, host TEXT NOT NULL, hits INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, host));

CREATE TABLE tool_domains (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tool_id TEXT NOT NULL,
            host TEXT NOT NULL UNIQUE,
            role TEXT NOT NULL DEFAULT 'alias' CHECK (role IN ('canonical', 'short', 'alias', 'mirror')),
            enabled INTEGER NOT NULL DEFAULT 1,
            note TEXT,
            created_by INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

CREATE INDEX idx_tool_domains_tool ON tool_domains(tool_id, role, enabled);

CREATE TABLE operator_alerts (
        source       TEXT NOT NULL,
        fingerprint  TEXT NOT NULL,
        name         TEXT NOT NULL,
        severity     TEXT NOT NULL,
        summary      TEXT NOT NULL,
        description  TEXT,
        service      TEXT,
        state        TEXT NOT NULL CHECK (state IN ('firing', 'resolved')),
        started_at   TEXT NOT NULL,
        opened_at    INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        notified_at  INTEGER,
        resolved_at  INTEGER, notices TEXT, reopened INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (source, fingerprint)
    );

CREATE TABLE stream_live_announcements (
        id INTEGER PRIMARY KEY AUTOINCREMENT, streamer_key TEXT NOT NULL, stream_id TEXT, sent_at DATETIME DEFAULT CURRENT_TIMESTAMP);

CREATE INDEX idx_sla_key ON stream_live_announcements(streamer_key, sent_at DESC);

CREATE TABLE username_history (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id      INTEGER NOT NULL,
        old_username TEXT NOT NULL,
        new_username TEXT NOT NULL,
        changed_by   INTEGER,
        changed_at   DATETIME DEFAULT CURRENT_TIMESTAMP
    );

CREATE INDEX idx_username_history_old ON username_history(old_username COLLATE NOCASE);

CREATE INDEX idx_username_history_user ON username_history(user_id);

CREATE TABLE admin_rate_limits (
        user_id INTEGER NOT NULL,
        action  TEXT    NOT NULL,
        last_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, action)
    );
