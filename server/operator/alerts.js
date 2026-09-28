'use strict';
/**
 * Operator alerts (roadmap WS-H task 11; Contracts network.operator.alert, network.operator-alerts-request@1).
 *
 * The production host's Prometheus evaluates alert rules (backups, the developer path, the Tools job proof,
 * the browser check), but nothing delivered them. Host relays the complete set of alerts firing now
 * (`ovhost alerts relay`, every two minutes) to POST /internal/operator/alerts, and this module turns the
 * difference into notifications for the operator. One notification per alert episode, kept up to date in place,
 * so a flapping or resolving alert never piles up new entries (the bell had open/resolved pairs every few hours):
 *
 *   opened     an alert not firing before           critical: a pushed notification; warning: in the bell only
 *   reopened   fires again within 12 h of resolving  the same notification is revised (Alert again, times counted);
 *                                                   nothing new is created or pushed
 *   reminded   a critical still firing 24 h after    a new pushed notification (warnings are not reminded)
 *              the last page
 *   resolved   firing before, absent from this set   its notifications are revised to Resolved and marked read
 *   info       never notified; listed only
 *
 * The operator is the owner account (OWNER_USERNAME), plus any usernames in OPERATOR_ALERT_USERNAMES
 * (comma-separated). The notification is type OPERATOR_ALERT in category `admin`, so it reaches the bell,
 * web push and the realtime topic, and no block hides it. State lives in `operator_alerts`, one row per
 * fingerprint and source; resolved rows are kept 30 days for the admin view.
 */

const REMIND_MS = 24 * 3600 * 1000;
const FLAP_MS = 12 * 3600 * 1000;
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
    // The notifications of the current episode ([[userId, notificationId], …]) and how often it fired again.
    for (const col of ['notices TEXT', 'reopened INTEGER NOT NULL DEFAULT 0']) {
        try { db.exec(`ALTER TABLE operator_alerts ADD COLUMN ${col}`); } catch { /* already there */ }
    }
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

const ago = (ms) => (ms < 3600e3 ? `${Math.max(1, Math.round(ms / 60e3))} min` : `${Math.round(ms / 3600e3)} h`);

/**
 * Apply one report. `body` has passed the request contract. Answers the result document.
 * notify(userId, notification) creates one notification (the notification service's create(); `silent` skips
 * web push); revise(userId, notificationId, fields) edits one in place (title, message, icon, is_read).
 */
function receive(db, body, { notify, revise = null, now = Date.now(), env = process.env } = {}) {
    ensureTables(db);
    const source = body.source;
    const current = new Map(body.alerts.map((a) => [a.fingerprint, a]));
    const rows = db.prepare('SELECT * FROM operator_alerts WHERE source = ?').all(source);
    const byFp = new Map(rows.map((r) => [r.fingerprint, r]));
    const work = [];
    const out = { ok: true, firing: current.size, opened: 0, reminded: 0, resolved: 0, notified: 0 };

    const upsert = db.prepare(`INSERT INTO operator_alerts (source, fingerprint, name, severity, summary, description, service, state, started_at, opened_at, last_seen_at, notified_at, resolved_at, reopened)
        VALUES (@source, @fingerprint, @name, @severity, @summary, @description, @service, 'firing', @started_at, @now, @now, @notified_at, NULL, 0)
        ON CONFLICT (source, fingerprint) DO UPDATE SET name = @name, severity = @severity, summary = @summary, description = @description, service = @service,
            state = 'firing', started_at = @started_at, last_seen_at = @now, notified_at = @notified_at, resolved_at = NULL,
            reopened = operator_alerts.reopened + @reopen,
            opened_at = CASE WHEN operator_alerts.state = 'resolved' AND @reopen = 0 THEN @now ELSE operator_alerts.opened_at END`);
    const resolve = db.prepare("UPDATE operator_alerts SET state = 'resolved', resolved_at = ? WHERE source = ? AND fingerprint = ?");

    db.transaction(() => {
        for (const a of current.values()) {
            const prev = byFp.get(a.fingerprint);
            let kind = null;
            if (!prev || prev.state === 'resolved') {
                kind = prev && prev.resolved_at && now - prev.resolved_at < FLAP_MS && prev.notices ? 'reopened' : 'opened';
                out.opened += 1;
            } else if (a.severity === 'critical' && (!prev.notified_at || now - prev.notified_at >= REMIND_MS)) {
                kind = 'reminded';
                out.reminded += 1;
            }
            const paged = kind === 'opened' || kind === 'reminded';
            upsert.run({ source, fingerprint: a.fingerprint, name: a.name, severity: a.severity, summary: a.summary, description: a.description || null,
                service: a.service || null, started_at: a.started_at, now, reopen: kind === 'reopened' ? 1 : 0,
                notified_at: paged ? now : (prev && prev.notified_at) || null });
            if (kind) work.push({ kind, a, prev });
        }
        for (const r of rows) {
            if (r.state !== 'firing' || current.has(r.fingerprint)) continue;
            resolve.run(now, source, r.fingerprint);
            out.resolved += 1;
            work.push({ kind: 'resolved', a: r, prev: r });
        }
        db.prepare("DELETE FROM operator_alerts WHERE state = 'resolved' AND resolved_at < ?").run(now - KEEP_RESOLVED_MS);
    })();

    const notices = (row) => { try { return JSON.parse((row && row.notices) || '[]'); } catch { return []; } };
    const saveNotices = db.prepare('UPDATE operator_alerts SET notices = ? WHERE source = ? AND fingerprint = ?');
    const users = work.length ? operatorUserIds(db, env) : [];
    for (const { kind, a, prev } of work) {
        if (a.severity === 'info') continue;
        const critical = a.severity === 'critical';
        if (kind === 'opened' || kind === 'reminded') {
            if (typeof notify !== 'function') continue;
            const n = {
                type: 'OPERATOR_ALERT', category: 'admin', service: 'host', url: STATUS_URL,
                priority: critical ? 'critical' : 'high', icon: critical ? '🚨' : '⚠️', silent: !critical,
                title: `${kind === 'reminded' ? 'Still firing' : 'Alert'}: ${a.name}`.slice(0, 120),
                message: `${a.summary}. ${message(a)}`.slice(0, 500),
            };
            const kept = kind === 'reminded' ? notices(prev) : [];
            for (const uid of users) {
                try {
                    const created = notify(uid, n);
                    if (created) out.notified += 1;
                    if (created && created.id) kept.push([uid, created.id]);
                } catch (e) { console.warn('[operator-alerts] notify failed:', e.message); }
            }
            saveNotices.run(JSON.stringify(kept), source, a.fingerprint);
            continue;
        }
        if (typeof revise !== 'function') continue;
        const fields = kind === 'resolved'
            ? { title: `Resolved: ${a.name}`.slice(0, 120), icon: '✅', is_read: 1, message: `${a.summary} (resolved after ${ago(now - (prev.opened_at || now))}${prev.reopened ? `; it fired ${prev.reopened + 1} times` : ''}).`.slice(0, 500) }
            : { title: `Alert: ${a.name}`.slice(0, 120), icon: critical ? '🚨' : '⚠️', is_read: critical ? 0 : 1, message: `${a.summary}. ${message(a)} Fired again ${(prev.reopened || 0) + 1} time(s) within 12 h of resolving.`.slice(0, 500) };
        for (const [uid, id] of notices(prev)) {
            try { revise(uid, id, fields); } catch (e) { console.warn('[operator-alerts] revise failed:', e.message); }
        }
    }
    return out;
}

/** Firing and recently resolved alerts, newest first (the admin view and /status). */
function list(db, { limit = 100 } = {}) {
    ensureTables(db);
    return db.prepare("SELECT source, fingerprint, name, severity, summary, service, state, started_at, opened_at, last_seen_at, notified_at, resolved_at FROM operator_alerts ORDER BY state = 'firing' DESC, COALESCE(resolved_at, last_seen_at) DESC LIMIT ?").all(limit);
}

module.exports = { ensureTables, receive, list, operatorUserIds, REMIND_MS, FLAP_MS };
