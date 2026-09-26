'use strict';
/**
 * Operator alerts (roadmap WS-H task 11; Contracts network.operator.alert, network.operator-alerts-request@1).
 *
 * The production host's Prometheus evaluates alert rules (backups, the developer path, the Tools job proof,
 * the browser check), but nothing delivered them. Host relays the complete set of alerts firing now
 * (`ovhost alerts relay`, every two minutes) to POST /internal/operator/alerts, and this module turns the
 * difference into notifications for the operator:
 *
 *   opened     an alert not firing before           critical → priority critical, else high
 *   reminded   still firing 24 h after the last page  same priority
 *   resolved   firing before, absent from this set   priority normal
 *
 * The operator is the owner account (OWNER_USERNAME), plus any usernames in OPERATOR_ALERT_USERNAMES
 * (comma-separated). The notification is type OPERATOR_ALERT in category `admin`, so it reaches the bell,
 * web push and the realtime topic, and no block hides it. State lives in `operator_alerts`, one row per
 * fingerprint and source; resolved rows are kept 30 days for the admin view.
 */

const REMIND_MS = 24 * 3600 * 1000;
const KEEP_RESOLVED_MS = 30 * 24 * 3600 * 1000;
const STATUS_URL = 'https://openvibe.network/status';

function ensureTables(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS operator_alerts (
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
        resolved_at  INTEGER,
        PRIMARY KEY (source, fingerprint)
    )`);
}

function operatorUserIds(db, env = process.env) {
    const names = new Set([(env.OWNER_USERNAME || 'goosely').toLowerCase()]);
    for (const n of String(env.OPERATOR_ALERT_USERNAMES || '').split(',')) if (n.trim()) names.add(n.trim().toLowerCase());
    const q = db.prepare('SELECT id FROM users WHERE lower(username) = ?');
    return [...names].map((n) => q.get(n)).filter(Boolean).map((u) => u.id);
}

function message(a) {
    return [a.description || a.summary, a.service ? `Service: ${a.service}.` : null, `Firing since ${a.started_at}.`].filter(Boolean).join(' ');
}

/**
 * Apply one report. `body` has passed the request contract. Answers the result document.
 * notify(userId, notification) creates one notification (the notification service's create()).
 */
function receive(db, body, { notify, now = Date.now(), env = process.env } = {}) {
    ensureTables(db);
    const source = body.source;
    const current = new Map(body.alerts.map((a) => [a.fingerprint, a]));
    const rows = db.prepare('SELECT * FROM operator_alerts WHERE source = ?').all(source);
    const byFp = new Map(rows.map((r) => [r.fingerprint, r]));
    const pages = [];
    const out = { ok: true, firing: current.size, opened: 0, reminded: 0, resolved: 0, notified: 0 };

    const upsert = db.prepare(`INSERT INTO operator_alerts (source, fingerprint, name, severity, summary, description, service, state, started_at, opened_at, last_seen_at, notified_at, resolved_at)
        VALUES (@source, @fingerprint, @name, @severity, @summary, @description, @service, 'firing', @started_at, @now, @now, @notified_at, NULL)
        ON CONFLICT (source, fingerprint) DO UPDATE SET name = @name, severity = @severity, summary = @summary, description = @description, service = @service,
            state = 'firing', started_at = @started_at, last_seen_at = @now, notified_at = @notified_at, resolved_at = NULL,
            opened_at = CASE WHEN operator_alerts.state = 'resolved' THEN @now ELSE operator_alerts.opened_at END`);
    const resolve = db.prepare("UPDATE operator_alerts SET state = 'resolved', resolved_at = ?, notified_at = ? WHERE source = ? AND fingerprint = ?");

    db.transaction(() => {
        for (const a of current.values()) {
            const prev = byFp.get(a.fingerprint);
            let kind = null;
            if (!prev || prev.state === 'resolved') kind = 'opened';
            else if (!prev.notified_at || now - prev.notified_at >= REMIND_MS) kind = 'reminded';
            upsert.run({ source, fingerprint: a.fingerprint, name: a.name, severity: a.severity, summary: a.summary, description: a.description || null,
                service: a.service || null, started_at: a.started_at, now, notified_at: kind ? now : (prev && prev.notified_at) || null });
            if (kind) { out[kind] += 1; pages.push({ kind, a }); }
        }
        for (const r of rows) {
            if (r.state !== 'firing' || current.has(r.fingerprint)) continue;
            resolve.run(now, now, source, r.fingerprint);
            out.resolved += 1;
            pages.push({ kind: 'resolved', a: r });
        }
        db.prepare("DELETE FROM operator_alerts WHERE state = 'resolved' AND resolved_at < ?").run(now - KEEP_RESOLVED_MS);
    })();

    if (pages.length && typeof notify === 'function') {
        const users = operatorUserIds(db, env);
        for (const { kind, a } of pages) {
            const resolved = kind === 'resolved';
            const n = {
                type: 'OPERATOR_ALERT', category: 'admin', service: 'host', url: STATUS_URL,
                priority: resolved ? 'normal' : (a.severity === 'critical' ? 'critical' : 'high'),
                icon: resolved ? '✅' : (a.severity === 'critical' ? '🚨' : '⚠️'),
                title: `${resolved ? 'Resolved' : kind === 'reminded' ? 'Still firing' : 'Alert'}: ${a.name}`.slice(0, 120),
                message: (resolved ? `${a.summary} (resolved).` : `${a.summary}. ${message(a)}`).slice(0, 500),
            };
            for (const uid of users) {
                try { if (notify(uid, n)) out.notified += 1; } catch (e) { console.warn('[operator-alerts] notify failed:', e.message); }
            }
        }
    }
    return out;
}

/** Firing and recently resolved alerts, newest first (the admin view and /status). */
function list(db, { limit = 100 } = {}) {
    ensureTables(db);
    return db.prepare("SELECT source, fingerprint, name, severity, summary, service, state, started_at, opened_at, last_seen_at, notified_at, resolved_at FROM operator_alerts ORDER BY state = 'firing' DESC, COALESCE(resolved_at, last_seen_at) DESC LIMIT ?").all(limit);
}

module.exports = { ensureTables, receive, list, operatorUserIds, REMIND_MS };
