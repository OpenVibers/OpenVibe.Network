'use strict';

const { URL_DEFINITIONS, normalizeValue, resolveRegistryValues } = require('openvibe-shared/url-resolver');

function initializeUrlRegistry(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS url_registry (
            key TEXT PRIMARY KEY,
            label TEXT NOT NULL,
            category TEXT NOT NULL,
            service TEXT NOT NULL,
            scope TEXT NOT NULL,
            type TEXT NOT NULL,
            value TEXT,
            description TEXT,
            source TEXT NOT NULL DEFAULT 'admin',
            updated_by INTEGER,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);
}

function getRegistryRows(db) {
    return db.prepare('SELECT key, label, category, service, scope, type, value, description, source, updated_by, updated_at FROM url_registry ORDER BY category, service, key').all();
}

function getRegistryRow(db, key) {
    return db.prepare('SELECT key, label, category, service, scope, type, value, description, source, updated_by, updated_at FROM url_registry WHERE key = ?').get(key);
}

function encodeRegistryValue(value, type) {
    const normalized = normalizeValue(value, type);
    if (normalized == null) return null;
    switch (type) {
        case 'json_array':
        case 'json_map':
            return JSON.stringify(normalized);
        default:
            return String(normalized);
    }
}

function decodeRegistryValue(value, type) {
    if (value == null) return null;
    switch (type) {
        case 'json_array':
        case 'json_map':
            if (typeof value === 'string') {
                try {
                    return normalizeValue(JSON.parse(value), type);
                } catch {
                    return null;
                }
            }
            return normalizeValue(value, type);
        default:
            return normalizeValue(value, type);
    }
}

function getAllRegistryEntries(db) {
    const rows = db.prepare('SELECT key, value, source, updated_by, updated_at FROM url_registry').all();
    const rowMap = rows.reduce((map, row) => {
        map[row.key] = row;
        return map;
    }, {});

    const warnings = getRegistryWarnings(db);

    return Object.values(URL_DEFINITIONS).map(def => {
        const row = rowMap[def.key];
        const rawValue = row?.value ?? null;
        return {
            key: def.key,
            label: def.label,
            category: def.category,
            service: def.service,
            scope: def.scope,
            type: def.type,
            description: def.description || '',
            value: rawValue != null ? decodeRegistryValue(rawValue, def.type) : null,
            updated_by: row?.updated_by || null,
            updated_at: row?.updated_at || null,
            source: row?.source || 'default',
            placeholder: def.default || '',
            warning: warnings[def.key] || null,
        };
    });
}

function getRegistryWarnings(db, env = process.env) {
    const warnings = {};
    const resolved = getResolvedRegistry(db, env);
    try {
        const liveHost = resolved.OV_LIVE_URL.value ? new URL(resolved.OV_LIVE_URL.value).hostname : null;
        const whipHost = resolved.WHIP_PUBLIC_URL.value ? new URL(resolved.WHIP_PUBLIC_URL.value).hostname : null;
        if (liveHost && whipHost && liveHost !== whipHost) {
            warnings.WHIP_PUBLIC_URL = 'Dedicated WHIP hostname differs from OV_LIVE_URL host. Ensure DNS, vhost, and TLS are configured for this host.';
            warnings.MEDIASOUP_ANNOUNCED_IP = 'Mediasoup announced host is currently derived from OV_LIVE_URL by default. Set MEDIASOUP_ANNOUNCED_IP explicitly for a different ICE hostname.';
        }
    } catch {
        // Ignore parse failures from incomplete values.
    }
    return warnings;
}

function loadRegistryValuesBySource(db, source) {
    const rows = db.prepare("SELECT key, value FROM url_registry WHERE source = ? AND value IS NOT NULL AND value != ''").all(source);
    return rows.reduce((map, row) => {
        const def = URL_DEFINITIONS[row.key];
        map[row.key] = def ? decodeRegistryValue(row.value, def.type) : row.value;
        return map;
    }, {});
}

function loadOverrides(db) {
    return loadRegistryValuesBySource(db, 'admin');
}

function loadBootstrapValues(db) {
    return loadRegistryValuesBySource(db, 'bootstrap');
}

function formatEntry(row) {
    if (!row) return null;
    const value = row.value != null ? decodeRegistryValue(row.value, row.type) : null;
    return {
        key: row.key,
        label: row.label,
        category: row.category,
        service: row.service,
        scope: row.scope,
        type: row.type,
        description: row.description || '',
        value,
        source: row.source || 'admin',
        updated_by: row.updated_by || null,
        updated_at: row.updated_at || null,
    };
}

function getResolvedRegistry(db, env = process.env) {
    const overrides = loadOverrides(db);
    const bootstrap = loadBootstrapValues(db);
    return resolveRegistryValues(env, overrides, bootstrap, URL_DEFINITIONS);
}

function setRegistryEntry(db, key, value, updatedBy = null) {
    if (!URL_DEFINITIONS[key]) {
        throw new Error(`Unknown URL registry key: ${key}`);
    }
    const entry = URL_DEFINITIONS[key];
    const encoded = encodeRegistryValue(value, entry.type);
    if (encoded == null) {
        throw new Error(`Invalid value for ${key}`);
    }
    db.prepare(`
        INSERT INTO url_registry (key, label, category, service, scope, type, value, description, source, updated_by, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'admin', ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            source = 'admin',
            updated_by = excluded.updated_by,
            updated_at = excluded.updated_at
    `).run(entry.key, entry.label, entry.category, entry.service, entry.scope, entry.type, encoded, entry.description, updatedBy);
    return formatEntry(getRegistryRow(db, key));
}

function resetRegistryEntry(db, key) {
    if (!URL_DEFINITIONS[key]) {
        throw new Error(`Unknown URL registry key: ${key}`);
    }
    db.prepare('DELETE FROM url_registry WHERE key = ?').run(key);
    return URL_DEFINITIONS[key];
}

function isRegistrySeeded(db) {
    const rowCount = db.prepare('SELECT COUNT(*) AS cnt FROM url_registry').get().cnt;
    return rowCount > 0;
}

function buildBootstrapOverrides(env = {}, profile = 'local-dev') {
    const bootstrap = {};
    for (const [key, def] of Object.entries(URL_DEFINITIONS)) {
        if (env[key]) {
            bootstrap[key] = env[key];
            continue;
        }
        if (profile === 'local-dev') {
            bootstrap[key] = def.default;
            continue;
        }
        bootstrap[key] = def.default;
    }
    return bootstrap;
}

function seedBootstrapRegistry(db, env = process.env, profile = 'local-dev') {
    const bootstrap = buildBootstrapOverrides(env, profile);
    const insert = db.prepare(`
        INSERT INTO url_registry (key, label, category, service, scope, type, value, description, source, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'bootstrap', CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO NOTHING
    `);
    const exists = db.prepare('SELECT 1 FROM url_registry WHERE key = ? LIMIT 1');

    const tx = db.transaction(() => {
        for (const [key, def] of Object.entries(URL_DEFINITIONS)) {
            if (exists.get(def.key)) continue;
            const encoded = encodeRegistryValue(bootstrap[key], def.type);
            if (encoded == null) continue;
            insert.run(def.key, def.label, def.category, def.service, def.scope, def.type, encoded, def.description || '');
        }
    });
    tx();
}

module.exports = {
    initializeUrlRegistry,
    getRegistryRows,
    getRegistryRow,
    getAllRegistryEntries,
    setRegistryEntry,
    resetRegistryEntry,
    loadOverrides,
    loadBootstrapValues,
    getResolvedRegistry,
    formatEntry,
    isRegistrySeeded,
    seedBootstrapRegistry,
    buildBootstrapOverrides,
};
