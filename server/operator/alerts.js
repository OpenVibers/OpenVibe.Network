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

function ensureTables(db) { /* the schema is migrations/NNNN_*.sql (plan T2); nothing is created at runtime */ }

async function operatorUserIds(db, env = process.env) {
    const names = new Set([(env.OWNER_USERNAME || 'goosely').toLowerCase()]);
    for (const n of String(env.OPERATOR_ALERT_USERNAMES || '').split(',')) if (n.trim()) names.add(n.trim().toLowerCase());
    const q = db.prepare('SELECT id FROM users WHERE lower(username) = ?');
    return (await Promise.all([...names].map(async (n) => await q.get(n)))).filter(Boolean).map((u) => u.id);
}

function message(a) {
    return [a.description || a.summary, a.service ? `Service: ${a.service}.` : null, `Firing since ${a.started_at}.`].filter(Boolean).join(' ');
}

const ago = (ms) => (ms < 3600e3 ? `${Math.max(1, Math.round(ms / 60e3))} min` : `${Math.round(ms / 3600e3)} h`);

/** OpenVibeBrowserCheckFailed → "Browser check failed": how an alert's name reads in a notification. */
function humanize(name) {
    const s = String(name || '').replace(/^OpenVibe(?=[A-Z])/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim();
    return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : 'Alert';
}


// ── What a browser-check alert says (network.operator-alerts-request@1 details) ───────────────────
// The host sends the result file's facts; this is the one place they become words a person reads. Every
// string here is text and every link is https on an allowed host, whatever the host sent.
const LINK_HOSTS = new Set(['git.openvibe.codes', 'github.com', 'dequeuniversity.com']);
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five'];
let domainsCache = null;

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const count = (n, one, many) => `${NUMBER_WORDS[n] || String(n)} ${n === 1 ? one : many}`;
const has = (n) => (n === 1 ? 'has' : 'have');
const is = (n) => (n === 1 ? 'is' : 'are');

/** The network's own public domains, from the contracts service manifests; no other site host may be linked. */
function networkDomains() {
    if (domainsCache) return domainsCache;
    let lib = null;
    try { lib = require('openvibe-contracts'); } catch { lib = null; }
    const out = new Set();
    for (const m of (lib && lib.services && lib.services.manifests) || []) {
        for (const d of m.domains || []) if (d) out.add(String(d).toLowerCase());
        try { const h = new URL(m.publicOrigin).hostname.toLowerCase(); if (h) out.add(h); } catch { /* no origin */ }
    }
    domainsCache = out;
    return out;
}

/** An https link on an allowed host, else null. The host builds them; this refuses anything else it is sent. */
function linked(href) {
    try {
        const u = new URL(String(href));
        if (u.protocol !== 'https:') return null;
        const host = u.hostname.toLowerCase();
        if (!LINK_HOSTS.has(host) && !networkDomains().has(host)) return null;
        return u.href;
    } catch { return null; }
}

/** Rule id or check → one sentence a person understands. An unknown rule falls back to its id and axe's help. */
const RULE_SENTENCES = {
    'summary-name': (n) => `${cap(count(n, 'fold heading', 'fold headings'))} ${has(n)} no name a screen reader can say`,
    'color-contrast': (n) => `${cap(count(n, 'piece', 'pieces'))} of text ${is(n)} too faint to read comfortably`,
    'image-alt': (n) => `${cap(count(n, 'image', 'images'))} ${has(n)} no text description`,
    'link-name': (n) => `${cap(count(n, 'link', 'links'))} ${has(n)} no name a screen reader can say`,
    'button-name': (n) => `${cap(count(n, 'button', 'buttons'))} ${has(n)} no name a screen reader can say`,
    'label': (n) => `${cap(count(n, 'form field', 'form fields'))} ${has(n)} no label`,
    'aria-hidden-focus': (n) => `${cap(count(n, 'hidden element', 'hidden elements'))} can still take keyboard focus`,
    'landmark-one-main': () => 'The page has no main landmark',
    'region': (n) => `${cap(count(n, 'part', 'parts'))} of the page ${is(n)} outside a landmark`,
};

function detailWhat(d) {
    const n = Math.max(1, (Array.isArray(d.targets) && d.targets.length) || 1);
    if (d.check === 'axe') {
        const rule = String(d.rule || '').toLowerCase();
        const sentence = RULE_SENTENCES[rule];
        if (sentence) return sentence(n);
        return `The page breaks the accessibility rule ${d.rule || 'it names'}${d.help ? ` (${d.help})` : ''}`;
    }
    if (d.check === 'errors') return d.message ? `The page logged a console error: ${d.message}` : 'The page logged a console error';
    if (d.check === 'overflow') {
        const offenders = Array.isArray(d.offenders) && d.offenders.length ? ` (${d.offenders.join(', ')})` : '';
        return `${d.width ? `At ${d.width} px, the` : 'The'} page scrolls sideways${offenders}`;
    }
    if (d.check === 'scripts') return `The page loads a script twice${d.message ? `: ${d.message}` : ''}`;
    if (d.check === 'jsonld') {
        const m = String(d.message || '');
        if (/^does not parse/i.test(m)) return `The page's structured data ${m.replace(/^does not parse:\s*/i, 'does not parse: ')}`;
        return `The page's structured data names ${m ? `"${m}"` : 'a value'} but the page text does not show it`;
    }
    if (d.check === 'status') return `The page answered ${d.status}${d.width ? ` at ${d.width} px` : ''}`;
    if (d.check === 'run') return 'The browser could not finish the check';
    return `The ${d.check || 'browser'} check failed`;
}

function detailWhere(d) {
    if (Array.isArray(d.targets) && d.targets.length) return d.targets.join(', ');
    if (Array.isArray(d.offenders) && d.offenders.length) return d.offenders.join(', ');
    return d.width ? `${d.width} px` : '';
}

const shortSha = (a) => {
    const s = String(a.release || '');
    if (/^[0-9a-f]{7,40}$/i.test(s)) return s.slice(0, 7);
    return (/release ([0-9a-f]{7,40})/i.exec(String(a.summary || '')) || [])[1]?.slice(0, 7) || null;
};

function siteName(a, details) {
    for (const d of details) {
        const href = linked(d.page_url);
        if (href) { try { return new URL(href).hostname; } catch { /* fall through */ } }
    }
    return String(a.service || 'the site');
}

function when(iso) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return null;
    return new Date(t).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

/** The notification's words and stored data for a browser-check alert, or null when it has no details. */
function browserCheck(a) {
    const details = (Array.isArray(a.details) ? a.details : []).filter((d) => d && typeof d === 'object').slice(0, 5);
    if (!details.length) return null;
    const site = siteName(a, details);
    const release = shortSha(a);
    const routes = [...new Set(details.map((d) => d.route).filter((r) => typeof r === 'string' && r))];
    const countPhrase = details.length === 1 ? 'a problem' : `${details.length} problems`;
    const where = routes.length === 1 ? ` on the page ${routes[0]}`
        : routes.length > 1 ? ` on ${routes.length} pages (${routes.join(', ')})` : '';
    const head = `${release ? `After release ${release}, the` : 'The'} automatic check of ${site} found ${countPhrase}${where}.`;
    const sentences = details.map((d) => {
        const targets = d.check === 'axe' && Array.isArray(d.targets) && d.targets.length ? ` (${d.targets.join(', ')})` : '';
        return `${detailWhat(d)}${targets}.`;
    });
    const message = `${head} ${sentences.join(' ')}`.replace(/\s+/g, ' ').trim().slice(0, 500);

    const first = details[0];
    const targets = detailWhere(first);
    const facts = [
        { label: 'Site', value: site },
        { label: 'Page', value: first.route || '/', href: linked(first.page_url) },
        { label: 'What', value: `${detailWhat(first)}${details.length > 1 ? ` (and ${details.length - 1} more)` : ''}` },
        ...(targets ? [{ label: 'Where', value: targets }] : []),
        ...(release ? [{ label: 'Release', value: release, href: linked(a.release_url) }] : []),
        ...(when(a.checked_at) ? [{ label: 'Checked', value: when(a.checked_at) }] : []),
        ...(when(a.failing_since || a.started_at) ? [{ label: 'Failing since', value: when(a.failing_since || a.started_at) }] : []),
    ].map((f) => (f.href ? f : { label: f.label, value: f.value }));

    const page = linked((details.find((d) => d.page_url) || {}).page_url);
    const help = linked((details.find((d) => d.check === 'axe' && d.help_url) || {}).help_url);
    const releaseUrl = linked(a.release_url);
    const actions = [
        ...(page ? [{ label: 'Open the page', href: page }] : []),
        ...(releaseUrl ? [{ label: 'See the release', href: releaseUrl }] : []),
        ...(help ? [{ label: 'What this rule means', href: help }] : []),
    ];

    return {
        title: `${site}: ${details.length} problem${details.length === 1 ? '' : 's'} found by the browser check`,
        message,
        facts,
        actions,
        next: 'The browser check runs again after every release and once a day. This alert closes itself when the check passes.',
    };
}

/**
 * The parts of an alert a person reads, kept apart from the shell command its rule may carry (owner 10-28: raw
 * "run: sudo ovhost …" text in the notification body). `rich_content` gives Shared's notification UI the name,
 * state, severity, sites, release and the command for a copy button; the message stays plain words.
 */
function readable(a) {
    const text = [a.summary, a.description].filter(Boolean).join('. ');
    const command = (/run:\s*(sudo [^;]+?)(?:\.\s|;|\.$|$)/.exec(text) || [])[1] || null;
    const sites = [...new Set((text.match(/(?:^|\.\s+)([a-z0-9][a-z0-9.-]{1,30}):\s/g) || []).map((s) => s.replace(/^\.\s+/, '').replace(/:\s$/, '')))].slice(0, 6);
    const release = (/release ([0-9a-f]{7,40})/i.exec(text) || [])[1] || null;
    const failing = (/\((\d+) failing check/i.exec(text) || [])[1] || null;
    let summary = String(a.summary || '').replace(/run:\s*sudo [^;]+?(?:\.\s|;|\.$|$)/g, '').replace(/^[a-z0-9][a-z0-9.-]{1,30}:\s/, '').trim();
    if (release || failing) summary = [release ? `Release ${release.slice(0, 7)}` : null, failing ? `${failing} failing check${failing === '1' ? '' : 's'}` : null].filter(Boolean).join(' · ');
    const detail = String(a.description || '').replace(/run:\s*sudo [^;]+?(?:\.\s|;|\.$|$)/g, '').trim();
    const message = [sites.length ? sites.join(', ') : (a.service || null), summary || null, detail && detail !== summary ? detail : null].filter(Boolean).join(' · ');
    return { command, sites, release, summary, message: message.slice(0, 500) };
}

function opsContent(a, state, r = readable(a)) {
    const browser = browserCheck(a);
    return { kind: 'ops_alert', name: a.name, state, severity: a.severity, sites: r.sites, release: r.release, summary: r.summary,
        command: r.command, service: a.service || null, since: a.started_at || null, runbook_url: STATUS_URL,
        ...(browser ? { facts: browser.facts, actions: browser.actions, next: browser.next } : {}) };
}

/**
 * Apply one report. `body` has passed the request contract. Answers the result document.
 * notify(userId, notification) creates one notification (the notification service's create(); `silent` skips
 * web push); revise(userId, notificationId, fields) edits one in place (title, message, icon, is_read).
 */
async function receive(db, body, { notify, revise = null, now = Date.now(), env = process.env } = {}) {
    ensureTables(db);
    const source = body.source;
    const current = new Map(body.alerts.map((a) => [a.fingerprint, a]));
    const rows = await db.prepare('SELECT * FROM operator_alerts WHERE source = ?').all(source);
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

    await db.tx(async () => {
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
            await upsert.run({ source, fingerprint: a.fingerprint, name: a.name, severity: a.severity, summary: a.summary, description: a.description || null,
                service: a.service || null, started_at: a.started_at, now, reopen: kind === 'reopened' ? 1 : 0,
                notified_at: paged ? now : (prev && prev.notified_at) || null });
            if (kind) work.push({ kind, a, prev });
        }
        for (const r of rows) {
            if (r.state !== 'firing' || current.has(r.fingerprint)) continue;
            await resolve.run(now, source, r.fingerprint);
            out.resolved += 1;
            work.push({ kind: 'resolved', a: r, prev: r });
        }
        await db.prepare("DELETE FROM operator_alerts WHERE state = 'resolved' AND resolved_at < ?").run(now - KEEP_RESOLVED_MS);
    });

    const notices = (row) => { try { return JSON.parse((row && row.notices) || '[]'); } catch { return []; } };
    const saveNotices = db.prepare('UPDATE operator_alerts SET notices = ? WHERE source = ? AND fingerprint = ?');
    const users = work.length ? await operatorUserIds(db, env) : [];
    for (const { kind, a, prev } of work) {
        if (a.severity === 'info') continue;
        const critical = a.severity === 'critical';
        if (kind === 'opened' || kind === 'reminded') {
            if (typeof notify !== 'function') continue;
            const r = readable(a);
            const browser = browserCheck(a);
            const n = {
                type: 'OPERATOR_ALERT', category: 'admin', service: 'host', url: STATUS_URL,
                priority: critical ? 'critical' : 'high', icon: critical ? '🚨' : '⚠️', silent: !critical,
                title: `${kind === 'reminded' ? 'Still failing: ' : ''}${browser ? browser.title : humanize(a.name)}`.slice(0, 120),
                message: (browser ? browser.message : (r.message || `${a.summary}. ${message(a)}`)).slice(0, 500),
                rich_content: opsContent(a, kind === 'reminded' ? 'reminded' : 'firing', r),
            };
            const kept = kind === 'reminded' ? notices(prev) : [];
            for (const uid of users) {
                try {
                    const created = await notify(uid, n);
                    if (created) out.notified += 1;
                    if (created && created.id) kept.push([uid, created.id]);
                } catch (e) { console.warn('[operator-alerts] notify failed:', e.message); }
            }
            await saveNotices.run(JSON.stringify(kept), source, a.fingerprint);
            continue;
        }
        if (typeof revise !== 'function') continue;
        const r = readable(a);
        const browser = browserCheck(a);
        const fields = kind === 'resolved'
            ? { title: `Resolved: ${humanize(a.name)}`.slice(0, 120), icon: '✅', is_read: 1, rich_content: opsContent(a, 'resolved', r),
                message: `${r.message || a.summary} (resolved after ${ago(now - (prev.opened_at || now))}${prev.reopened ? `; it fired ${prev.reopened + 1} times` : ''}).`.slice(0, 500) }
            : { title: (browser ? browser.title : humanize(a.name)).slice(0, 120), icon: critical ? '🚨' : '⚠️', is_read: critical ? 0 : 1, rich_content: opsContent(a, 'firing', r),
                message: `${browser ? browser.message : (r.message || a.summary)}. Fired again ${(prev.reopened || 0) + 1} time(s) within 12 h of resolving.`.slice(0, 500) };
        for (const [uid, id] of notices(prev)) {
            try { await revise(uid, id, fields); } catch (e) { console.warn('[operator-alerts] revise failed:', e.message); }
        }
    }
    return out;
}

/** Firing and recently resolved alerts, newest first (the admin view and /status). */
async function list(db, { limit = 100 } = {}) {
    ensureTables(db);
    return await db.prepare("SELECT source, fingerprint, name, severity, summary, service, state, started_at, opened_at, last_seen_at, notified_at, resolved_at FROM operator_alerts ORDER BY state = 'firing' DESC, COALESCE(resolved_at, last_seen_at) DESC LIMIT ?").all(limit);
}

module.exports = { ensureTables, receive, list, operatorUserIds, humanize, readable, browserCheck, REMIND_MS, FLAP_MS };
