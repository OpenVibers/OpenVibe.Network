'use strict';

// ═══════════════════════════════════════════════════════════════
// openvibe.network — Central Database (PostgreSQL through openvibe-sdk/db, ADR-035 / plan T2)
//
// The schema lives in migrations/NNNN_*.sql; this module opens the process-wide handle, runs the
// migrations as the owner (DATABASE_DIRECT_URL) and seeds the boot data that is not schema
// (OAuth clients, site settings, built-in themes). Every query is async; the handle is shaped like
// better-sqlite3's (db.prepare(sql).get/all/run) but must be awaited.
// ═══════════════════════════════════════════════════════════════

const path = require('path');
const fs = require('fs');
const { createDb } = require('openvibe-sdk/db');
const config = require('../config');

const MIGRATIONS = path.join(__dirname, '..', '..', 'migrations');
const DEV_PGLITE = path.join(__dirname, '..', '..', 'data', 'pglite');

let database = null;
let seeded = false;

function previewFromVars(vars) {
    return JSON.stringify({
        bg: vars['--bg-primary'] || '#0d0d0f',
        accent: vars['--accent'] || '#8b5cf6',
        text: vars['--text-primary'] || '#e8e6e3',
    });
}

/**
 * The serving handle: DATABASE_URL through PgBouncer; in development without it, an embedded PGlite
 * database in config.db.pgliteDir. Migrations run first, as the owner (DATABASE_DIRECT_URL), or on the
 * embedded handle. Production without DATABASE_URL refuses to boot.
 */
async function openDb(cfg = config, { log = console, registry } = {}) {
    if (!cfg.db.url) {
        if (cfg.nodeEnv === 'production') throw new Error('DATABASE_URL is not set: production serves from PostgreSQL (OpenVibe.Host roles/data add-service.sh network)');
        const dir = cfg.db.pgliteDir || DEV_PGLITE;
        log.warn(`[DB] DATABASE_URL unset: embedded PGlite database in ${dir} (development only, one process)`);
        fs.mkdirSync(dir, { recursive: true });
        const db = createDb({ pglite: dir, service: 'network', registry, log });
        await db.migrate({ dir: MIGRATIONS, log });
        return db;
    }
    if (!cfg.db.directUrl) throw new Error('DATABASE_DIRECT_URL is not set: migrations run with the owner role on a direct connection');
    const owner = createDb({ url: cfg.db.directUrl, service: 'network-migrate', max: 1, log });
    try { await owner.migrate({ dir: MIGRATIONS, log }); } finally { await owner.close(); }
    return createDb({ url: cfg.db.url, service: 'network', registry, log });
}

/** Open the process-wide database once, at boot (server/index.js, scripts). Seeds the boot data. */
async function initDb(cfg = config, opts) {
    if (!database && globalThis.__ovNetworkTestDb) database = globalThis.__ovNetworkTestDb;   // tests (test/helpers/pg-preload.mjs)
    if (!database) database = await openDb(cfg, opts);
    await attachHelpers(database);
    if (!seeded) { seeded = true; await seedDb(database); }
    return database;
}

/** The process-wide database initDb() opened. */
function getDb() {
    if (!database && globalThis.__ovNetworkTestDb) database = globalThis.__ovNetworkTestDb;
    if (!database) throw new Error('the database is not open: await initDb() at boot');
    return database;
}

/** Tests: use this handle as the process-wide database. */
async function setDb(db) { database = db; await attachHelpers(db); }

// ── Boot data (the schema is the migration; this is what is not) ─────────────

/**
 * Seed OAuth2 clients, site settings and the built-in theme catalogue, idempotently. Safe under
 * concurrent writers: every write is an upsert, and the redirect-URI merge takes the row with
 * SELECT … FOR UPDATE inside a transaction (decision 1).
 */
async function seedDb(db, { log = console } = {}) {
    const warn = (m) => log.warn(`[DB] ${m}`);

    // ── Seed OAuth2 clients (per CONTRACTS) ──────────────────
    // Each first-party client is created if missing, with a fresh UUID secret printed exactly once.
    {
        const { v4: uuidv4 } = require('uuid');
        const contractClients = [
            { client_id: 'live', name: 'OpenVibe.Live', redirect_uris: ['https://openvibe.live/api/auth/callback'] },
            { client_id: 'tools', name: 'OpenVibe.Tools', redirect_uris: ['https://openvibe.tools/auth/callback'] },
            { client_id: 'games', name: 'OpenVibe.Games', redirect_uris: ['https://openvibe.games/auth/callback', 'https://play.openvibe.games/auth/callback'] },
            { client_id: 'media', name: 'OpenVibe.Media', redirect_uris: ['https://openvibe.media/auth/callback'] },
            { client_id: 'community', name: 'OpenVibe.Community', redirect_uris: ['https://openvibe.community/auth/callback'] },
            { client_id: 'space', name: 'OpenVibe.Space', redirect_uris: ['https://openvibe.space/auth/callback'] },
            // Waves 9-16 products with a signed-in UI. Create each with server/setup/service-principal.js
            // first (secret into its env file); this only adds the redirect URI to that client.
            { client_id: 'tips', name: 'OpenVibe.Tips', redirect_uris: ['https://openvibe.tips/auth/callback'] },
            { client_id: 'vip', name: 'OpenVibe.VIP', redirect_uris: ['https://openvibe.vip/auth/callback'] },
            { client_id: 'wiki', name: 'OpenVibe.Wiki', redirect_uris: ['https://openvibe.wiki/auth/callback'] },
            { client_id: 'blog', name: 'OpenVibe.Blog', redirect_uris: ['https://openvibe.blog/auth/callback'] },
            { client_id: 'openre', name: 'OpenRe.Stream', redirect_uris: ['https://openre.stream/auth/callback'] },
            { client_id: 'reviews', name: 'OpenVibe.Reviews', redirect_uris: ['https://openvibe.reviews/auth/callback'] },
            { client_id: 'news', name: 'OpenVibe.News', redirect_uris: ['https://openvibe.news/auth/callback'] },
            { client_id: 'trade', name: 'OpenVibe.Trade', redirect_uris: ['https://openvibe.trade/auth/callback'] },
            { client_id: 'deals', name: 'OpenVibe.Deals', redirect_uris: ['https://openvibe.deals/auth/callback'] },
            { client_id: 'coupons', name: 'OpenVibe.Coupons', redirect_uris: ['https://openvibe.coupons/auth/callback'] },
            { client_id: 'host', name: 'OpenVibe.Host', redirect_uris: ['https://openvibe.host/auth/callback'] },
            { client_id: 'codes', name: 'OpenVibe.Codes', redirect_uris: ['https://openvibe.codes/auth/callback'] },
            { client_id: 'billing', name: 'OpenVibe.Billing', redirect_uris: ['https://billing.openvibe.network/auth/callback'] },
            { client_id: 'ai', name: 'OpenVibe.AI', redirect_uris: ['https://ai.openvibe.network/auth/callback', 'https://ai.openvibe.services/auth/callback'] },
            { client_id: 'bot', name: 'OpenVibe.Bot', redirect_uris: ['https://openvibe.bot/auth/callback'] },
        ];
        let seededAny = false;
        for (const c of contractClients) {
            const existing = await db.prepare('SELECT client_id, redirect_uris FROM oauth_clients WHERE client_id = ?').get(c.client_id);
            if (!existing) {
                await db.prepare('INSERT INTO oauth_clients (client_id, client_secret, name, redirect_uris, is_first_party) VALUES (?, ?, ?, ?, 1)')
                    .run(c.client_id, uuidv4(), c.name, JSON.stringify(c.redirect_uris));
                console.log(`[DB] Seeded OAuth2 client: ${c.client_id} (secret stored in oauth_clients; read it from the database, never from logs)`);
                seededAny = true;
                continue;
            }
            await mergeRedirectUris(db, c.client_id, c.redirect_uris, { log });
        }
        if (seededAny) console.log('[DB] New OAuth2 clients seeded; their secrets are in oauth_clients (they are never logged).');
    }

    // ── Local development redirect URIs ──────────────────────
    if (!(process.env.NODE_ENV === 'production' && process.env.BOOTSTRAP_PROFILE !== 'local-dev')) {
        const localClients = [
            { clientId: 'live', extraUris: ['http://localhost:3000/auth/callback', 'http://localhost:3000/api/auth/callback'] },
            { clientId: 'tools', extraUris: ['http://localhost:4001/auth/callback'] },
            { clientId: 'games', extraUris: ['http://localhost:8000/auth/callback', 'http://localhost:5173/auth/callback'] },
            { clientId: 'media', extraUris: ['http://localhost:4100/auth/callback'] },
            { clientId: 'community', extraUris: ['http://localhost:4200/auth/callback'] },
            { clientId: 'space', extraUris: ['http://localhost:4940/auth/callback'] },
        ];
        for (const { clientId, extraUris } of localClients) {
            try { await mergeRedirectUris(db, clientId, extraUris, { log, local: true }); }
            catch (err) { warn(`Failed to add local redirect_uris for ${clientId}: ${err.message}`); }
        }
    }

    // ── Email verification preference reset + seeds ──────────
    try {
        const flagged = await db.prepare("SELECT value FROM site_settings WHERE key = 'migr_pref_email_null'").get();
        if (!flagged) {
            // notification_preferences.email: 0 used to be the implicit default written whenever a
            // user toggled anything else in the row. It now means an EXPLICIT "no email"; NULL is
            // "no choice → defaults apply". One-time reset.
            const n = (await db.prepare('UPDATE notification_preferences SET email = NULL WHERE email = 0').run()).changes;
            await db.prepare("INSERT INTO site_settings (key, value, type) VALUES ('migr_pref_email_null', '1', 'boolean') ON CONFLICT (key) DO UPDATE SET value = excluded.value, type = excluded.type").run();
            if (n) console.log(`[DB] notification_preferences: ${n} email=0 rows reset to default (NULL)`);
        }
        const seed = db.prepare('INSERT INTO site_settings (key, value, type) VALUES (?, ?, ?) ON CONFLICT (key) DO NOTHING');
        await seed.run('email_user_daily_cap', '30', 'number');
        await seed.run('email_daily_cap', '2000', 'number');
        await seed.run('email_verify_user_daily_cap', '6', 'number');
        await seed.run('resend_webhook_secret', '', 'string');
        await seed.run('stream_live_cooldown_min', '60', 'number');
        await seed.run('stream_live_daily_cap', '8', 'number');
    } catch (e) { warn(`email verification migration: ${e.message}`); }

    // ── Seed default settings (only on a fresh settings table) ──
    {
        const settingsCount = (await db.prepare('SELECT COUNT(*) AS cnt FROM site_settings').get()).cnt;
        if (Number(settingsCount) === 0) {
            const defaults = [
                ['registration_open', 'true', 'boolean'],
                ['platform_name', 'OpenVibe', 'string'],
                ['default_theme', 'vibe', 'string'],
                ['email_enabled', 'false', 'boolean'],
                ['resend_api_key', '', 'string'],
                ['email_from_address', 'noreply@openvibe.network', 'string'],
                ['email_from_name', 'OpenVibe', 'string'],
                ['notifications_enabled', 'true', 'boolean'],
                ['notification_max_age_days', '90', 'number'],
                ['notification_email_critical_only', 'true', 'boolean'],
            ];
            const insertSetting = db.prepare('INSERT INTO site_settings (key, value, type) VALUES (?, ?, ?) ON CONFLICT (key) DO NOTHING');
            for (const [k, v, t] of defaults) await insertSetting.run(k, v, t);
        }
    }

    // ── Always-seed Discord + integration settings (idempotent) ──
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
            ['github_token', '', 'secret'],
        ];
        const insertSeed = db.prepare('INSERT INTO site_settings (key, value, type) VALUES (?, ?, ?) ON CONFLICT (key) DO NOTHING');
        for (const [k, v, t] of alwaysSeed) await insertSeed.run(k, v, t);
    }

    // ── Sync built-in themes ─────────────────────────────────
    {
        const { BUILTIN_THEMES } = require('openvibe-shared/theme-sync');
        const upsertTheme = db.prepare(`
            INSERT INTO themes (id, name, slug, description, mode, variables, preview_colors, is_builtin, is_public, tags, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ov_now())
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
                updated_at = ov_now()
        `);
        for (const t of BUILTIN_THEMES) {
            await upsertTheme.run(t.id, t.name, t.slug, t.description, t.mode,
                JSON.stringify(t.variables || {}), previewFromVars(t.variables || {}), JSON.stringify(t.tags || []));
        }
        // A built-in that was renamed or removed must not linger as a stale catalog row.
        const ids = BUILTIN_THEMES.map((t) => t.id);
        const gone = (await db.prepare(`DELETE FROM themes WHERE is_builtin = 1 AND id NOT IN (${ids.map(() => '?').join(',')})`).run(...ids)).changes;
        console.log(`[DB] Synced ${BUILTIN_THEMES.length} built-in themes${gone ? ` (removed ${gone} stale)` : ''}`);
    }

    // ── Per-module boot work (the tables are migrations/NNNN_*.sql; this is the idempotent data work
    //    each module did at boot on SQLite) ─────────────────────────────────────────────────────────
    // Subject ids + identity_legacy_map (server/identity/subjects.js): backfill and seed.
    await require('../identity/subjects').ensureSchema(db);
    // Service principals: grants per OAuth client (server/identity/principals.js) — seeds the default
    // grants and re-revokes the ones ADR-012 forbids.
    await require('../identity/principals').ensureSchema(db);
    // Versioned user modules (server/identity/modules.js).
    await require('../identity/modules').ensureSchema(db);
    // Developer projects, apps, credentials, grants, quotas and audit (server/developer/store.js).
    await require('../developer/store').ensureSchema(db);
    // Their usage, from the services' rollups (server/developer/usage.js).
    await require('../developer/usage').ensure(db);
    // Platform blocks, keyed by subjects (server/identity/blocks.js).
    await require('../identity/blocks').ensureSchema(db);
    // The follow graph, keyed by subjects (server/identity/follows.js; ADR-030).
    await require('../identity/follows').ensureSchema(db);
    // Incidents and maintenance on /status (server/status/incidents.js).
    await require('../status/incidents').ensureSchema(db);
    // Creator analytics from live.stream.ended (server/analytics/creators.js).
    await require('../analytics/creators').ensureSchema(db);
    // The platform's machines (server/registry/nodes.js; ADR-034 §12).
    await require('../registry/nodes').ensureSchema(db);
    // What the network can place on: node and provider offers (server/registry/offers.js; plan T2).
    await require('../registry/offers').ensureSchema(db);
    // Cells and node principals (plan T2): every machine already in the node registry gets its platform principal.
    await require('../registry/cells').ensureSchema(db);
    // Refresh tokens: hash-only storage (server/auth/refresh-tokens.js).
    await require('../auth/refresh-tokens').ensureSchema(db);

    console.log('[DB] Central database seeded');
}

/** Union `uris` into a client's redirect_uris under SELECT … FOR UPDATE (decision 1: many writers). */
async function mergeRedirectUris(db, clientId, uris, { log = console, local = false } = {}) {
    await db.tx(async (t) => {
        const row = await t.prepare('SELECT redirect_uris FROM oauth_clients WHERE client_id = ? FOR UPDATE').get(clientId);
        if (!row) return;
        let current;
        try { current = new Set(JSON.parse(row.redirect_uris || '[]')); } catch { return; }   // malformed: leave untouched
        let changed = false;
        for (const uri of uris) { if (!current.has(uri)) { current.add(uri); changed = true; } }
        if (!changed) return;
        await t.prepare('UPDATE oauth_clients SET redirect_uris = ? WHERE client_id = ?').run(JSON.stringify([...current]), clientId);
        if (local) console.log(`[DB] Added local redirect_uris for ${clientId}: ${uris.join(', ')}`);
        else console.log(`[DB] Updated ${clientId} redirect_uris to include contract URIs`);
    });
}

// ── Handle helpers (attached to the database handle, async) ──────────────────

function attachHelpers(db) {
    if (db._ovHelpers) return db;
    const secrets = require('../secrets');

    // better-sqlite3's db.transaction(fn) returned a function; db.tx(fn) runs now. txFn keeps that
    // shape (a runner the caller invokes, possibly more than once, e.g. a dry-run path).
    db.txFn = (fn) => async (...args) => await db.tx(() => fn(...args));

    // Provider secrets come from their environment variable when it is set.
    db.getSetting = async function (key) {
        const fromEnv = secrets.fromEnv(key);
        if (fromEnv !== null) return fromEnv;
        const row = await db.prepare('SELECT value, type FROM site_settings WHERE key = ?').get(key);
        if (!row) return null;
        if (row.type === 'boolean') return row.value === 'true';
        if (row.type === 'number') return Number(row.value);
        return row.value;
    };

    db.createVerificationKey = async function ({ key, target_username, note, created_by }) {
        return await db.prepare('INSERT INTO verification_keys (key, target_username, note, created_by) VALUES (?, ?, ?, ?)')
            .run(key, target_username, note || '', created_by);
    };
    db.getVerificationKeyByKey = async function (key) {
        return await db.prepare('SELECT * FROM verification_keys WHERE key = ?').get(key);
    };
    db.getVerificationKeyByUsername = async function (username) {
        return await db.prepare("SELECT * FROM verification_keys WHERE lower(target_username) = lower(?) AND status = 'active'").get(username);
    };
    db.getAllVerificationKeys = async function () {
        return await db.prepare(`
            SELECT vk.*, u1.username as created_by_name, u2.username as used_by_name
            FROM verification_keys vk
            LEFT JOIN users u1 ON vk.created_by = u1.id
            LEFT JOIN users u2 ON vk.used_by = u2.id
            ORDER BY vk.created_at DESC
        `).all();
    };
    db.redeemVerificationKey = async function (key, userId) {
        return await db.prepare("UPDATE verification_keys SET status = 'used', used_by = ?, used_at = ov_now() WHERE key = ? AND status = 'active'")
            .run(userId, key);
    };
    db.revokeVerificationKey = async function (id) {
        return await db.prepare("UPDATE verification_keys SET status = 'revoked' WHERE id = ? AND status = 'active'").run(id);
    };
    db.isUsernameReserved = async function (username) {
        const vk = await db.prepare("SELECT id FROM verification_keys WHERE lower(target_username) = lower(?) AND status = 'active'").get(username);
        return !!vk;
    };

    Object.defineProperty(db, '_ovHelpers', { value: true, enumerable: false });
    return db;
}

module.exports = { openDb, initDb, getDb, setDb, seedDb, attachHelpers, MIGRATIONS, mergeRedirectUris };
