'use strict';
/**
 * Project usage (roadmap WS-N task 4, ADR-014): the rollups the owning services send of each developer
 * project's use (<service>.usage.recorded, openvibe-contracts common.usage-recorded@1), kept per
 * project and day for the project's dashboard on OpenVibe.Codes.
 *
 *   tools.usage.recorded    a Tools satellite's hour of a project's jobs (unit jobs)
 *   events.usage.recorded   OpenVibe.Events: published events (events) and webhook deliveries (deliveries)
 *
 * The Events consumer (server/notifications/events-consumer.js) calls record() inside its inbox
 * transaction, so a redelivery changes nothing. A rollup is the totals of its key (service, project,
 * env, capability, dimension, unit, window_start): a newer or equal revision replaces the stored one
 * and its day is added up again from its windows, so a producer re-sending an hour never counts it
 * twice. The failures a rollup samples (time, code, status, trace id, job or event id) are kept for
 * the dashboard's recent errors. Nothing here names who did the work.
 *
 *   dev_usage_windows   one row per rollup key (WINDOW_DAYS, 35 days)
 *   dev_usage_daily     per project, env, service, capability, dimension, unit and UTC day (DAILY_DAYS, 400 days)
 *   dev_usage_errors    sampled failures (ERROR_DAYS, 30 days; the newest ERRORS_PER_PROJECT per project)
 *
 * summary() is what GET /api/v1/projects/:project/usage (./routes.js) answers the project's owner, its
 * admins and staff: network.project-usage-result@1, with the recorded quotas (dev_quotas) and what
 * their current window used where the rollups can tell (a day, a month, the kept total).
 */
const { validate, capabilities } = require('openvibe-contracts');

const SERVICES = Object.freeze(['tools', 'events']);
const TOPICS = Object.freeze(SERVICES.map((s) => `${s}.usage.recorded`));
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WINDOW_DAYS = 35;
const DAILY_DAYS = 400;
const ERROR_DAYS = 30;
const ERRORS_PER_PROJECT = 200;
const MAX_DAYS = 90;
const RECENT_ERRORS = 50;
// What each service reports, so a quota on one of these is measured even before its first rollup.
const REPORTED = Object.freeze({
    'tools.job.create': ['jobs'], 'tools.tool.run': ['jobs'],
    'events.app.publish': ['events'], 'events.app.subscribe': ['deliveries'],
});

const iso = (ms) => new Date(ms).toISOString();
const dayOf = (ms) => iso(ms).slice(0, 10);
const parse = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

function ensure(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS dev_usage_windows (
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
        CREATE INDEX IF NOT EXISTS idx_dev_usage_windows_when ON dev_usage_windows(window_start);
        CREATE INDEX IF NOT EXISTS idx_dev_usage_windows_project ON dev_usage_windows(project_id, recorded_at);
        CREATE TABLE IF NOT EXISTS dev_usage_daily (
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
        CREATE INDEX IF NOT EXISTS idx_dev_usage_daily_day ON dev_usage_daily(project_id, day);
        CREATE TABLE IF NOT EXISTS dev_usage_errors (
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
        CREATE UNIQUE INDEX IF NOT EXISTS idx_dev_usage_errors_once ON dev_usage_errors(project_id, env, service, capability, at, code, ref);
        CREATE INDEX IF NOT EXISTS idx_dev_usage_errors_recent ON dev_usage_errors(project_id, at);
    `);
}

function mergeCodes(into, codes) {
    for (const [k, n] of Object.entries(obj(codes))) if (Number.isSafeInteger(n) && n > 0) into[k] = (into[k] || 0) + n;
    return into;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ now?: () => number, log?: object }} [o]
 */
function createProjectUsage(db, { now = () => Date.now(), log = console } = {}) {
    ensure(db);
    const q = {
        project: db.prepare('SELECT id FROM dev_projects WHERE id = ?'),
        window: db.prepare(`SELECT revision FROM dev_usage_windows WHERE project_id = ? AND env = ? AND service = ? AND capability = ?
            AND dimension = ? AND unit = ? AND window_start = ?`),
        upsertWindow: db.prepare(`INSERT INTO dev_usage_windows (project_id, env, service, capability, dimension, unit, window_start, window_end,
                quantity, errors, error_codes, revision, event_id, recorded_at)
            VALUES (@project_id, @env, @service, @capability, @dimension, @unit, @window_start, @window_end, @quantity, @errors, @error_codes, @revision, @event_id, @recorded_at)
            ON CONFLICT(project_id, env, service, capability, dimension, unit, window_start) DO UPDATE SET
                window_end = excluded.window_end, quantity = excluded.quantity, errors = excluded.errors, error_codes = excluded.error_codes,
                revision = excluded.revision, event_id = excluded.event_id, recorded_at = excluded.recorded_at`),
        dayWindows: db.prepare(`SELECT quantity, errors, error_codes FROM dev_usage_windows WHERE project_id = ? AND env = ? AND service = ?
            AND capability = ? AND dimension = ? AND unit = ? AND window_start >= ? AND window_start < ?`),
        upsertDaily: db.prepare(`INSERT INTO dev_usage_daily (project_id, env, service, capability, dimension, unit, day, quantity, errors, error_codes, updated_at)
            VALUES (@project_id, @env, @service, @capability, @dimension, @unit, @day, @quantity, @errors, @error_codes, @updated_at)
            ON CONFLICT(project_id, env, service, capability, dimension, unit, day) DO UPDATE SET
                quantity = excluded.quantity, errors = excluded.errors, error_codes = excluded.error_codes, updated_at = excluded.updated_at`),
        addError: db.prepare(`INSERT OR IGNORE INTO dev_usage_errors (project_id, env, service, capability, at, code, status, trace_id, ref, event_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
        capErrors: db.prepare(`DELETE FROM dev_usage_errors WHERE project_id = ? AND id NOT IN
            (SELECT id FROM dev_usage_errors WHERE project_id = ? ORDER BY at DESC, id DESC LIMIT ${ERRORS_PER_PROJECT})`),
    };
    let lastPrune = 0;

    /** Inside the consumer's inbox transaction: 'recorded' or an 'ignored:*' outcome. */
    function record(event) {
        const type = String(event && event.event_type || '');
        if (!TOPICS.includes(type)) return 'ignored:type';
        const service = type.split('.')[0];
        if (event.source !== service) return 'ignored:source';
        const p = obj(event.payload);
        if (p.redacted === true) return 'ignored:redacted';
        const v = validate(`${type}@${event.version || 1}`, p);
        if (!v.valid) {
            log.warn(`[Usage] ${event.event_id} (${type}) does not match its contract: ${v.errors.slice(0, 3).map((e) => `${e.path} ${e.message}`).join('; ')}`);
            return 'ignored:payload';
        }
        const subject = obj(event.subject);
        if (subject.type !== 'project' || subject.id !== p.project_id) return 'ignored:subject';
        const start = Date.parse(p.window_start);
        const end = Date.parse(p.window_end);
        const len = p.window === 'day' ? DAY_MS : HOUR_MS;
        if (end - start !== len || start % len !== 0) return 'ignored:window';
        const t = now();
        if (start > t + HOUR_MS) return 'ignored:future';
        if (start < t - WINDOW_DAYS * DAY_MS) return 'ignored:too_old';
        if (!q.project.get(p.project_id)) return 'ignored:project';
        const key = { project_id: p.project_id, env: p.env, service, capability: p.capability, dimension: p.dimension || '', unit: p.unit };
        const windowStart = iso(start);
        const revision = p.revision || 1;
        const prev = q.window.get(key.project_id, key.env, key.service, key.capability, key.dimension, key.unit, windowStart);
        if (prev && prev.revision > revision) return 'ignored:stale';
        const recordedAt = iso(t);
        q.upsertWindow.run({
            ...key, window_start: windowStart, window_end: iso(end), quantity: p.quantity, errors: p.errors,
            error_codes: JSON.stringify(obj(p.error_codes)), revision, event_id: event.event_id, recorded_at: recordedAt,
        });
        // The day this window falls in, added up again from its windows (a day window is its own day).
        const day = dayOf(start);
        const from = `${day}T00:00:00.000Z`;
        const to = iso(Date.parse(from) + DAY_MS);
        const sum = { quantity: 0, errors: 0, codes: {} };
        for (const w of q.dayWindows.all(key.project_id, key.env, key.service, key.capability, key.dimension, key.unit, from, to)) {
            sum.quantity += w.quantity; sum.errors += w.errors; mergeCodes(sum.codes, parse(w.error_codes, {}));
        }
        q.upsertDaily.run({ ...key, day, quantity: sum.quantity, errors: sum.errors, error_codes: JSON.stringify(sum.codes), updated_at: recordedAt });
        for (const s of Array.isArray(p.samples) ? p.samples : []) {
            q.addError.run(key.project_id, key.env, service, key.capability, iso(Date.parse(s.at)), s.code, s.status || null, s.trace_id || null, s.ref || '', event.event_id);
        }
        if (p.samples && p.samples.length) q.capErrors.run(key.project_id, key.project_id);
        if (t - lastPrune > HOUR_MS) { lastPrune = t; prune(t); }
        return 'recorded';
    }

    function prune(t = now()) {
        db.prepare('DELETE FROM dev_usage_windows WHERE window_start < ?').run(iso(t - WINDOW_DAYS * DAY_MS));
        db.prepare('DELETE FROM dev_usage_daily WHERE day < ?').run(dayOf(t - DAILY_DAYS * DAY_MS));
        db.prepare('DELETE FROM dev_usage_errors WHERE at < ?').run(iso(t - ERROR_DAYS * DAY_MS));
    }

    return { record, prune, summary: (projectId, o) => summary(db, projectId, { now, ...o }) };
}

class UsageQueryError extends Error {
    constructor(detail) { super(detail); this.status = 422; this.code = 'usage.invalid'; this.detail = detail; }
}

/** ?days=&env= → { days, env }; throws UsageQueryError for anything else. */
function parseQuery(query = {}) {
    const rawDays = query.days == null || query.days === '' ? '30' : String(query.days);
    if (!/^\d{1,3}$/.test(rawDays) || Number(rawDays) < 1 || Number(rawDays) > MAX_DAYS) throw new UsageQueryError(`days is a whole number from 1 to ${MAX_DAYS}`);
    const env = query.env == null || query.env === '' ? 'all' : String(query.env);
    if (!['all', 'sandbox', 'production'].includes(env)) throw new UsageQueryError('env is all, sandbox or production');
    return { days: Number(rawDays), env };
}

/** network.project-usage-result@1 for one project (the caller checked access). */
function summary(db, projectId, { days = 30, env = 'all', now = () => Date.now() } = {}) {
    const t = now();
    const to = dayOf(t);
    const from = dayOf(t - (days - 1) * DAY_MS);
    const envSql = env === 'all' ? '' : ' AND env = ?';
    const envArgs = env === 'all' ? [] : [env];
    const rows = db.prepare(`SELECT * FROM dev_usage_daily WHERE project_id = ? AND day >= ?${envSql}
        ORDER BY day DESC, service, capability, dimension, unit, env`).all(projectId, from, ...envArgs);

    const daily = rows.map((r) => ({ day: r.day, service: r.service, capability: r.capability, dimension: r.dimension || null, unit: r.unit, env: r.env, quantity: r.quantity, errors: r.errors }));
    const totals = new Map();
    const byCode = new Map();
    let errorTotal = 0;
    for (const r of rows) {
        const k = `${r.service}|${r.capability}|${r.unit}|${r.env}`;
        const tot = totals.get(k) || { service: r.service, capability: r.capability, unit: r.unit, env: r.env, quantity: 0, errors: 0 };
        tot.quantity += r.quantity; tot.errors += r.errors;
        totals.set(k, tot);
        errorTotal += r.errors;
        for (const [code, n] of Object.entries(parse(r.error_codes, {}))) {
            const ck = `${r.service}|${r.capability}|${code}`;
            const c = byCode.get(ck) || { service: r.service, capability: r.capability, code, count: 0 };
            c.count += n;
            byCode.set(ck, c);
        }
    }

    // Quotas (dev_quotas, staff-set): what their current window used, every environment together.
    const seen = new Set(db.prepare('SELECT DISTINCT capability, unit FROM dev_usage_daily WHERE project_id = ?').all(projectId).map((r) => `${r.capability}|${r.unit}`));
    const usedSince = db.prepare('SELECT COALESCE(SUM(quantity), 0) AS n FROM dev_usage_daily WHERE project_id = ? AND capability = ? AND unit = ? AND day >= ?');
    const quotas = db.prepare('SELECT * FROM dev_quotas WHERE project_id = ? ORDER BY capability').all(projectId).map((qr) => {
        const cap = capabilities.get(qr.capability);
        const out = { capability: qr.capability, limit: qr.limit_value, window: qr.quota_window, unit: qr.unit, enforced_by: cap ? `openvibe.${cap.owner}` : null, used: null, remaining: null, window_start: null, note: null };
        const measured = seen.has(`${qr.capability}|${qr.unit}`) || (REPORTED[qr.capability] || []).includes(qr.unit);
        if (!measured) {
            const units = REPORTED[qr.capability];
            out.note = units ? `the service reports ${units.join(', ')} for this capability, not ${qr.unit}` : 'no service reports usage of this capability yet';
            return out;
        }
        if (qr.quota_window === 'minute' || qr.quota_window === 'hour') {
            out.note = `a ${qr.quota_window} window is enforced by the service as it happens; hourly rollups cannot show it`;
            return out;
        }
        let since;
        if (qr.quota_window === 'day') { since = to; out.window_start = `${to}T00:00:00.000Z`; }
        else if (qr.quota_window === 'month') { since = `${to.slice(0, 7)}-01`; out.window_start = `${since}T00:00:00.000Z`; }
        else { since = '0000-00-00'; out.note = `total of the last ${DAILY_DAYS} days kept`; }
        out.used = usedSince.get(projectId, qr.capability, qr.unit, since).n;
        out.remaining = Math.max(0, qr.limit_value - out.used);
        return out;
    });

    const recent = db.prepare(`SELECT * FROM dev_usage_errors WHERE project_id = ? AND at >= ?${envSql} ORDER BY at DESC, id DESC LIMIT ${RECENT_ERRORS}`)
        .all(projectId, `${from}T00:00:00.000Z`, ...envArgs)
        .map((e) => ({ at: e.at, env: e.env, service: e.service, capability: e.capability, code: e.code, status: e.status == null ? null : e.status, trace_id: e.trace_id || null, ref: e.ref || null }));
    const last = db.prepare('SELECT MAX(recorded_at) AS at FROM dev_usage_windows WHERE project_id = ?').get(projectId).at || null;

    return {
        project_id: projectId, env, range: { days, from, to }, generated_at: iso(t), last_recorded_at: last,
        freshness: last
            ? 'Usage arrives as hourly rollups a few minutes after each hour closes (UTC); the current hour is not counted yet.'
            : 'No usage has been recorded for this project yet. Rollups arrive a few minutes after each hour (UTC) closes.',
        totals: [...totals.values()].sort((a, b) => a.service.localeCompare(b.service) || a.capability.localeCompare(b.capability) || a.env.localeCompare(b.env)),
        daily,
        quotas,
        errors: { total: errorTotal, by_code: [...byCode.values()].sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)), recent },
    };
}

module.exports = { createProjectUsage, summary, parseQuery, ensure, UsageQueryError, TOPICS, SERVICES, MAX_DAYS };
