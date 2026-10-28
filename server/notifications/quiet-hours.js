'use strict';

// ═══════════════════════════════════════════════════════════════
// Quiet hours — a person's do-not-disturb window in their own zone.
// The window may cross midnight (22:00–07:00); start === end means none.
// Intl.DateTimeFormat does the zone arithmetic, so DST changes need no
// special case. An unknown or missing zone is read as UTC.
// ═══════════════════════════════════════════════════════════════

const DEFAULT_QUIET = Object.freeze({ enabled: false, start_min: 22 * 60, end_min: 7 * 60, tz: 'UTC' });

/** 'HH:MM' → minutes since midnight, or null when it is not a valid wall time. */
function parseTime(value) {
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value ?? ''));
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** Minutes since midnight → 'HH:MM'. */
function formatTime(minutes) {
    const n = Number(minutes);
    if (!Number.isInteger(n) || n < 0 || n > 1439) return '00:00';
    return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
}

/** An IANA zone Intl accepts (UTC included); aliases such as US/Pacific are fine. */
function validTimeZone(tz) {
    if (typeof tz !== 'string' || !tz || tz.length > 100) return false;
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

/** The person's wall clock at `at`: { minute: 0–1439, hour: 0–23, day: 'YYYY-MM-DD' }. */
function zoned(at, tz) {
    const zone = validTimeZone(tz) ? tz : 'UTC';
    const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    const parts = {};
    for (const p of fmt.formatToParts(at instanceof Date ? at : new Date(at))) parts[p.type] = p.value;
    let hour = Number(parts.hour);
    if (hour === 24) hour = 0;   // some ICU versions render midnight as 24
    return { minute: hour * 60 + Number(parts.minute), hour, day: `${parts.year}-${parts.month}-${parts.day}` };
}

/** A stored row (or nothing) as the numeric config inQuiet() reads. */
function rowToConfig(row) {
    if (!row) return { ...DEFAULT_QUIET };
    return {
        enabled: !!Number(row.enabled),
        start_min: Number(row.start_min),
        end_min: Number(row.end_min),
        tz: row.tz || 'UTC',
    };
}

/** The API shape: { enabled, start: 'HH:MM', end: 'HH:MM', tz }. */
function configToView(config) {
    const c = config || DEFAULT_QUIET;
    return {
        enabled: !!c.enabled,
        start: formatTime(c.start_min),
        end: formatTime(c.end_min),
        tz: c.tz || 'UTC',
    };
}

/**
 * Whether `at` falls in this quiet window. Cross-midnight windows wrap; start === end is no window.
 * @param {{ start_min: number, end_min: number, tz: string, enabled?: boolean|number }} config
 * @param {number|Date} [at]
 */
function inQuiet(config = {}, at = Date.now()) {
    const off = config.enabled === false || Number(config.enabled) === 0;
    if (off) return false;
    const start = Number(config.start_min);
    const end = Number(config.end_min);
    if (!Number.isInteger(start) || !Number.isInteger(end)) return false;
    if (start < 0 || start > 1439 || end < 0 || end > 1439) return false;
    if (start === end) return false;
    const now = zoned(at, config.tz).minute;
    return start < end ? (now >= start && now < end) : (now >= start || now < end);
}

module.exports = {
    DEFAULT_QUIET, parseTime, formatTime, validTimeZone, zoned, rowToConfig, configToView, inQuiet,
};
