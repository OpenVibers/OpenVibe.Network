'use strict';
const cache = require('openvibe-shared/cache-policy');
/**
 * Account export and deletion (roadmap WS-B task 7, ADR-033; Contracts 0.71.0).
 *
 * Export. The signed-in person starts a job (POST /api/v1/account/export: one open at a time, one a day). Network
 * queues network.account.export_requested; each service holding network.account.export.contribute pushes its part
 * (POST /internal/account-exports/:id/parts, network.account-export-part@1: JSON files of the subject's own rows).
 * When every expected service has answered, or at the 30-minute deadline, Network adds its own part and writes one
 * zip: README.txt, network/…, <service>/…. It stays downloadable by the same person for 7 days, then it is deleted.
 *
 * Deletion. A fresh sign-in (auth_time within 10 minutes) and the username typed out schedule it 30 days ahead
 * (POST /api/v1/account/deletion); until then the account works and DELETE cancels it. At the date, ONE transaction
 * erases what Network owns:
 *   - providers, sessions, OAuth tokens and codes, reset and verification tokens;
 *   - modules, follows and blocks both ways, notifications, preferences, push subscriptions, effects;
 *   - history, username history, the sign-in IP log and email log;
 *   - project memberships; a project the person owns passes to another owner or admin, else it is archived and
 *     its apps revoked.
 * The OpenCoins balance is closed with one ledger entry (account_deleted); ledger rows stay. The user row becomes
 * a tombstone (username released, email, password and profile cleared, deleted_at), as do accounts merged into it;
 * the subject is never reused and resolves as deleted. Its tokens are revoked strictly, and network.account.deleted
 * is queued. Each service erases its own rows and confirms (POST /internal/account-deletions/:id/confirmations,
 * network.account-deletion-confirmation@1); staff (staff.users.manage) see what is still outstanding.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const { ids, validate, staff } = require('openvibe-contracts');
const eventRelay = require('../developer/event-relay');
const agents = require('../developer/agents');
const wallet = require('../coins/wallet');
const revocation = require('../auth/revocation');
const zip = require('../utils/zip');

const EXPORT_DEADLINE_MS = 30 * 60 * 1000;
const EXPORT_KEEP_MS = 7 * 86400000;
const EXPORT_EVERY_MS = 24 * 3600 * 1000;
const PART_MAX_BYTES = 20 * 1024 * 1024;
const GRACE_MS = 30 * 86400000;
const FRESH_SIGN_IN_S = 10 * 60;
const ROW_LIMIT = 5000;
const CONTRIBUTE = 'network.account.export.contribute';
const CONFIRM = 'network.account.deletion.confirm';
const SELF_AUDIENCE = 'openvibe.network';
const ID_RE = { exp: /^exp_[0-9A-HJKMNP-TV-Z]{26}$/, del: /^del_[0-9A-HJKMNP-TV-Z]{26}$/ };
// Columns never exported: secrets, their hashes, one-time codes, push keys.
const SECRET_COL = /(^|_)(token|secret|hash|password|code|p256dh|auth|keys?)($|_)/i;

class AccountDataError extends Error {
    constructor(status, code, detail, extra) { super(detail); this.status = status; this.code = code; this.extra = extra; }
}

const iso = (ms) => new Date(ms).toISOString();

async function ensureSchema(db) { /* the schema is migrations/NNNN_*.sql (plan T2); nothing is created at runtime */ }

const tableExists = async (db, name) => !!await db.prepare("SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ?").get(name);
const columnsOf = async (db, table) => (await db.prepare('SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?').all(table)).map((c) => c.column_name);

/** The services expected to answer: every principal holding the capability for Network. */
async function expectedServices(db, capability) {
    if (!await tableExists(db, 'principal_grants')) return [];
    return (await db.prepare(`SELECT DISTINCT client_id FROM principal_grants WHERE capability = ? AND audience = ? AND revoked_at IS NULL
                       AND (expires_at IS NULL OR expires_at > ov_now()) ORDER BY client_id`).all(capability, SELF_AUDIENCE)).map((r) => r.client_id);
}

function envelope(type, payload, subject, at) {
    const env = {
        event_id: ids.newId('event', Date.parse(at)), event_type: type, version: 1, source: 'network',
        actor: { type: 'user', id: subject }, timestamp: at, visibility: 'internal', subject: { type: 'user', id: subject }, payload,
    };
    const v = validate('events.event-envelope@1', env);
    const pv = validate(`${type}@1`, payload);
    if (!v.valid || !pv.valid) throw new Error(`account-data: bad ${type}: ${JSON.stringify((v.errors || []).concat(pv.errors || [])).slice(0, 300)}`);
    return env;
}

function kick(db) { try { const live = eventRelay.outboxFor(db); if (live) live.kick(); } catch { /* the relay polls anyway */ } }

function assertPerson(user) {
    if (!user || user.is_anon) throw new AccountDataError(400, 'account.guest', 'a guest account has nothing to export or delete');
    if (user.merged_into) throw new AccountDataError(409, 'account.merged', 'this account was merged into another');
    if (user.deleted_at) throw new AccountDataError(410, 'account.deleted', 'this account was deleted');
    if (!ids.isSubjectId('user', user.subject_id)) throw new AccountDataError(400, 'account.no_subject', 'this account has no subject');
}

// ── Export ─────────────────────────────────────────────────────

async function exportView(db, row) {
    const parts = await db.prepare('SELECT service, files, bytes FROM account_export_parts WHERE export_id = ? ORDER BY service').all(row.id);
    const got = new Map(parts.map((p) => [p.service, p]));
    const built = row.services ? JSON.parse(row.services) : null;
    const services = built || [...new Set([...JSON.parse(row.expected || '[]'), ...got.keys()])].sort().map((s) => (got.has(s)
        ? { service: s, status: 'received', files: got.get(s).files, bytes: got.get(s).bytes }
        : { service: s, status: row.status === 'pending' ? 'waiting' : 'missing' }));
    const out = { export_id: row.id, status: row.status, requested_at: row.requested_at, deadline: row.deadline, services };
    if (row.ready_at) out.ready_at = row.ready_at;
    if (row.expires_at) out.expires_at = row.expires_at;
    if (row.size_bytes != null) out.size_bytes = row.size_bytes;
    return out;
}

/** The person starts an export → { status: 201|200, body: network.account-export@1 }. */
async function startExport(db, user, { now = Date.now() } = {}) {
    await ensureSchema(db);
    assertPerson(user);
    const open = await db.prepare("SELECT * FROM account_exports WHERE user_id = ? AND status = 'pending' ORDER BY requested_at DESC LIMIT 1").get(user.id);
    if (open) return { status: 200, row: open, body: await exportView(db, open) };
    const recent = await db.prepare("SELECT requested_at FROM account_exports WHERE user_id = ? AND status != 'failed' AND requested_at > ? ORDER BY requested_at DESC LIMIT 1")
        .get(user.id, iso(now - EXPORT_EVERY_MS));
    if (recent) {
        const retry = Math.ceil((Date.parse(recent.requested_at) + EXPORT_EVERY_MS - now) / 1000);
        throw new AccountDataError(429, 'export.too_soon', 'one export a day: the last one is still available below', { retry_after: retry });
    }
    const id = `exp_${ids.ulid(now)}`;
    const requestedAt = iso(now);
    const deadline = iso(now + EXPORT_DEADLINE_MS);
    const expected = await expectedServices(db, CONTRIBUTE);
    await db.tx(async () => {
        await db.prepare('INSERT INTO account_exports (id, user_id, subject, expected, requested_at, deadline) VALUES (?, ?, ?, ?, ?, ?)')
            .run(id, user.id, user.subject_id, JSON.stringify(expected), requestedAt, deadline);
        await eventRelay.writerFor(db).enqueue(envelope('network.account.export_requested', { export_id: id, subject: user.subject_id, requested_at: requestedAt, deadline }, user.subject_id, requestedAt));
    });
    kick(db);
    const row = await db.prepare('SELECT * FROM account_exports WHERE id = ?').get(id);
    return { status: 201, row, body: await exportView(db, row) };
}

/** A service's part → network.account-data-receipt@1. */
async function receivePart(db, exportId, service, body, { now = Date.now() } = {}) {
    await ensureSchema(db);
    const v = validate('network.account-export-part@1', body);
    if (!v.valid) throw new AccountDataError(400, 'export.invalid_part', JSON.stringify(v.errors).slice(0, 300));
    const row = ID_RE.exp.test(String(exportId)) ? await db.prepare('SELECT * FROM account_exports WHERE id = ?').get(exportId) : null;
    if (!row) throw new AccountDataError(404, 'export.not_found', 'no such export');
    if (body.subject !== row.subject) throw new AccountDataError(400, 'export.wrong_subject', "the part's subject is not the export's");
    if (row.status !== 'pending' || now > Date.parse(row.deadline)) throw new AccountDataError(409, 'export.closed', 'this export was already built');
    const names = body.files.map((f) => f.name);
    if (new Set(names).size !== names.length) throw new AccountDataError(400, 'export.duplicate_file', 'two files with the same name');
    const text = JSON.stringify(body);
    const bytes = Buffer.byteLength(text);
    if (bytes > PART_MAX_BYTES) throw new AccountDataError(413, 'export.part_too_large', 'a part is at most 20 MB');
    const had = !!await db.prepare('SELECT 1 FROM account_export_parts WHERE export_id = ? AND service = ?').get(row.id, service);
    await db.prepare('INSERT INTO account_export_parts (export_id, service, received_at, files, bytes, body) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (export_id, service) DO UPDATE SET received_at = excluded.received_at, files = excluded.files, bytes = excluded.bytes, body = excluded.body')
        .run(row.id, service, iso(now), body.files.length, bytes, text);
    return { id: row.id, service, received_at: iso(now), replaced: had };
}

/** Rows about a person from one table, secrets left out, newest first, at most ROW_LIMIT. */
async function rowsOf(db, table, where, params, { omit = [] } = {}) {
    if (!await tableExists(db, table)) return { rows: [], truncated: false };
    const cols = (await columnsOf(db, table)).filter((c) => !SECRET_COL.test(c) && !omit.includes(c));
    if (!cols.length) return { rows: [], truncated: false };
    // Newest first: the `seq` identity when the table has one (migrations 0003), else the primary key.
    const order = cols.includes('seq') ? 'ORDER BY seq DESC ' : cols.includes('id') ? 'ORDER BY id DESC ' : '';
    const rows = await db.prepare(`SELECT ${cols.join(', ')} FROM ${table} WHERE ${where} ${order}LIMIT ${ROW_LIMIT + 1}`).all(...params);
    return { rows: rows.slice(0, ROW_LIMIT), truncated: rows.length > ROW_LIMIT };
}

/** Network's own part: { files: [{ name, content }], truncated: [] }. */
async function networkPart(db, userId) {
    const u = await db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    const files = [];
    const truncated = [];
    const add = (name, content, cut) => { files.push({ name, content }); if (cut) truncated.push(name); };
    const keep = ['id', 'username', 'email', 'display_name', 'avatar_url', 'bio', 'role', 'profile_color', 'created_at', 'updated_at', 'last_seen',
        'email_verified', 'email_verified_at', 'name_effect', 'particle_effect', 'history_paused', 'subject_id'];
    const account = {};
    for (const k of keep) if (k in u) account[k] = u[k];
    account.merged_in = await tableExists(db, 'subject_aliases')
        ? await db.prepare('SELECT alias_id AS subject, merged_at FROM subject_aliases WHERE subject_id = ? ORDER BY merged_at').all(u.subject_id) : [];
    add('account.json', account);
    const byUser = async (name, table, opts) => { const r = await rowsOf(db, table, 'user_id = ?', [u.id], opts); add(name, r.rows, r.truncated); };
    await byUser('sign_in_providers.json', 'linked_accounts');
    await byUser('sessions.json', 'user_sessions');
    await byUser('oauth_grants.json', 'oauth_tokens');
    await byUser('notifications.json', 'notifications');
    add('preferences.json', {
        display: (await rowsOf(db, 'user_preferences', 'user_id = ?', [u.id])).rows[0] || null,
        notifications: (await rowsOf(db, 'notification_preferences', 'user_id = ?', [u.id])).rows,
        effects: (await rowsOf(db, 'user_effects', 'user_id = ?', [u.id])).rows,
        push_devices: (await rowsOf(db, 'push_subscriptions', 'user_id = ?', [u.id], { omit: ['endpoint'] })).rows,
    });
    await byUser('history.json', 'user_history');
    add('username_history.json', (await rowsOf(db, 'username_history', 'user_id = ?', [u.id], { omit: ['changed_by'] })).rows);
    await byUser('profile_changes.json', 'user_profile_changes');
    await byUser('sign_in_log.json', 'ip_log');
    await byUser('emails_sent.json', 'email_delivery_log');
    const coins = await rowsOf(db, 'coin_transactions', 'user_id = ?', [u.id]);
    add('opencoins.json', { balance: (await db.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(u.id) || { balance: 0 }).balance, ledger: coins.rows }, coins.truncated);
    add('modules.json', await tableExists(db, 'user_modules') ? (await db.prepare('SELECT namespace, version, revision, data, updated_at FROM user_modules WHERE subject_id = ? ORDER BY namespace').all(u.subject_id))
        .map((m) => { let data = m.data; try { data = JSON.parse(m.data); } catch { /* kept as text */ } return { ...m, data }; }) : []);
    const follows = await rowsOf(db, 'user_follows', 'follower_subject = ?', [u.subject_id]);
    const followers = await tableExists(db, 'user_follows') ? (await db.prepare("SELECT COUNT(*) AS n FROM user_follows WHERE target_id = ? AND active = 1").get(u.subject_id)).n : 0;
    add('follows.json', { following: follows.rows, followers_count: followers }, follows.truncated);
    add('blocks.json', (await rowsOf(db, 'user_blocks', 'blocker_subject = ?', [u.subject_id])).rows);
    add('developer_projects.json', {
        owned: (await rowsOf(db, 'dev_projects', 'owner_subject = ?', [u.subject_id])).rows,
        memberships: (await rowsOf(db, 'dev_project_members', 'subject_id = ?', [u.subject_id], { omit: ['added_by'] })).rows,
        // The agents that act for this person (WS-Z2); who revoked one may be someone else, so revoked_by stays out.
        agents: (await rowsOf(db, 'dev_agents', 'owner_subject = ?', [u.subject_id], { omit: ['revoked_by'] })).rows,
    });
    add('account_merges.json', await tableExists(db, 'account_merges')
        ? await db.prepare('SELECT id, from_subject, into_subject, initiated_by, reason, moved, merged_at FROM account_merges WHERE into_user_id = ? ORDER BY merged_at').all(u.id) : []);
    add('moderation.json', (await rowsOf(db, 'moderation_audit', 'target_subject = ?', [u.subject_id], { omit: ['actor_subject'] })).rows);
    return { files, truncated };
}

function readme(row, sections, now) {
    const lines = [
        'OpenVibe account export',
        `Export ${row.id} for ${row.subject}, requested ${row.requested_at}, built ${iso(now)}.`,
        '',
        'Each folder is one service\'s part: the rows it keeps about you, as JSON. Secrets (passwords, tokens and their',
        'hashes) are never included. Media files themselves are downloaded from the links in the media part.',
        '',
    ];
    for (const s of sections) {
        if (s.status !== 'received') { lines.push(`${s.service}: MISSING (it did not answer before ${row.deadline}; ask for a new export later)`); continue; }
        lines.push(`${s.service}: ${s.files} file(s)${s.truncated.length ? `; cut at the service's row limit: ${s.truncated.join(', ')}` : ''}${s.note ? ` (${s.note})` : ''}`);
    }
    return lines.join('\n') + '\n';
}

/** Build the archive when every expected service answered, at the deadline, or when forced. → true if built. */
async function maybeBuild(db, exportId, { dir, now = Date.now(), force = false, notify } = {}) {
    await ensureSchema(db);
    const row = await db.prepare('SELECT * FROM account_exports WHERE id = ?').get(exportId);
    if (!row || row.status !== 'pending') return false;
    const expected = JSON.parse(row.expected || '[]');
    const parts = await db.prepare('SELECT service, received_at, files, bytes, body FROM account_export_parts WHERE export_id = ? ORDER BY service').all(row.id);
    const got = new Set(parts.map((p) => p.service));
    if (!force && now < Date.parse(row.deadline) && !expected.every((s) => got.has(s))) return false;
    try {
        const own = await networkPart(db, row.user_id);
        const sections = [{ service: 'network', status: 'received', files: own.files.length, truncated: own.truncated }];
        const entries = own.files.map((f) => ({ name: `network/${f.name}`, data: JSON.stringify(f.content, null, 2) }));
        for (const p of parts) {
            const b = JSON.parse(p.body || '{"files":[]}');
            sections.push({ service: p.service, status: 'received', files: b.files.length, truncated: b.truncated || [], note: b.note });
            for (const f of b.files) entries.push({ name: `${p.service}/${f.name}`, data: JSON.stringify(f.content, null, 2) });
        }
        for (const s of expected) if (!got.has(s)) sections.push({ service: s, status: 'missing' });
        entries.unshift({ name: 'README.txt', data: readme(row, sections, now) });
        const buf = zip.build(entries, { date: new Date(now) });
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const file = path.join(dir, `${row.id}.zip`);
        fs.writeFileSync(file, buf, { mode: 0o600 });
        const status = expected.every((s) => got.has(s)) ? 'ready' : 'partial';
        const services = sections.map((s) => (s.status === 'received'
            ? { service: s.service, status: 'received', files: s.files, bytes: s.service === 'network' ? Buffer.byteLength(JSON.stringify(own.files)) : parts.find((p) => p.service === s.service).bytes }
            : { service: s.service, status: 'missing' }));
        await db.tx(async () => {
            await db.prepare('UPDATE account_exports SET status = ?, ready_at = ?, expires_at = ?, size_bytes = ?, services = ? WHERE id = ?')
                .run(status, iso(now), iso(now + EXPORT_KEEP_MS), buf.length, JSON.stringify(services), row.id);
            await db.prepare('UPDATE account_export_parts SET body = NULL WHERE export_id = ?').run(row.id);
        });
        if (notify) {
            try {
                notify(row.user_id, { title: 'Your data export is ready', message: status === 'ready' ? 'Download it from your account page within 7 days.' : 'Some services did not answer in time; the archive says which. Download it from your account page within 7 days.' });
            } catch { /* the page shows it anyway */ }
        }
        return true;
    } catch (e) {
        await db.prepare("UPDATE account_exports SET status = 'failed', error = ? WHERE id = ?").run(String(e.message).slice(0, 300), row.id);
        console.error('[AccountData] export build failed:', row.id, e.message);
        return false;
    }
}

async function exportFile(db, user, exportId, { dir, now = Date.now() } = {}) {
    await ensureSchema(db);
    const row = ID_RE.exp.test(String(exportId)) ? await db.prepare('SELECT * FROM account_exports WHERE id = ? AND user_id = ?').get(exportId, user.id) : null;
    if (!row) throw new AccountDataError(404, 'export.not_found', 'no such export');
    if (row.status === 'pending') throw new AccountDataError(409, 'export.pending', 'this export is still being gathered');
    if (!['ready', 'partial'].includes(row.status) || Date.parse(row.expires_at) < now) throw new AccountDataError(410, 'export.expired', 'this export is no longer available');
    return { row, file: path.join(dir, `${row.id}.zip`) };
}

// ── Deletion ───────────────────────────────────────────────────

function deletionView(row) {
    const out = { deletion_id: row.id, status: row.status, requested_at: row.requested_at, delete_after: row.delete_after };
    if (row.cancelled_at) out.cancelled_at = row.cancelled_at;
    if (row.deleted_at) out.deleted_at = row.deleted_at;
    return out;
}

async function scheduleDeletion(db, user, claims, confirmUsername, { now = Date.now() } = {}) {
    await ensureSchema(db);
    assertPerson(user);
    const open = await db.prepare("SELECT * FROM account_deletions WHERE user_id = ? AND status = 'scheduled'").get(user.id);
    if (open) return { status: 200, body: deletionView(open) };
    const owner = (process.env.OWNER_USERNAME || 'goosely').toLowerCase();
    if (String(user.username || '').toLowerCase() === owner) throw new AccountDataError(403, 'deletion.owner', "the owner's account cannot be deleted here");
    const authTime = Number(claims && claims.auth_time);
    if (!Number.isFinite(authTime) || now / 1000 - authTime > FRESH_SIGN_IN_S) {
        throw new AccountDataError(401, 'deletion.sign_in_again', 'sign in again (within the last 10 minutes) to delete this account');
    }
    if (String(confirmUsername || '').trim().toLowerCase() !== String(user.username).toLowerCase()) {
        throw new AccountDataError(400, 'deletion.confirm_username', 'type your username exactly to confirm');
    }
    const id = `del_${ids.ulid(now)}`;
    await db.prepare('INSERT INTO account_deletions (id, user_id, subject, requested_at, delete_after) VALUES (?, ?, ?, ?, ?)')
        .run(id, user.id, user.subject_id, iso(now), iso(now + GRACE_MS));
    return { status: 201, body: deletionView(await db.prepare('SELECT * FROM account_deletions WHERE id = ?').get(id)) };
}

async function cancelDeletion(db, userId, { by = 'person', now = Date.now() } = {}) {
    await ensureSchema(db);
    const row = await db.prepare("SELECT * FROM account_deletions WHERE user_id = ? AND status = 'scheduled'").get(userId);
    if (!row) return null;
    await db.prepare("UPDATE account_deletions SET status = 'cancelled', cancelled_at = ?, cancelled_by = ? WHERE id = ?").run(iso(now), by, row.id);
    return deletionView(await db.prepare('SELECT * FROM account_deletions WHERE id = ?').get(row.id));
}

/** Erase what Network owns for one due deletion, in one transaction, and queue network.account.deleted. → counts. */
async function erase(db, deletion, { now = Date.now() } = {}) {
    const at = iso(now);
    const erased = {};
    const count = (k, n) => { if (n) erased[k] = (erased[k] || 0) + n; };
    const run = db.txFn(async () => {
        const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(deletion.user_id);
        if (!user) throw new Error(`account-data: no user ${deletion.user_id}`);
        const subject = user.subject_id;
        const folded = await db.prepare('SELECT id, subject_id FROM users WHERE merged_into = ?').all(user.id);
        const aliases = await tableExists(db, 'subject_aliases') ? (await db.prepare('SELECT alias_id FROM subject_aliases WHERE subject_id = ?').all(subject)).map((r) => r.alias_id) : [];
        const subjects = [...new Set([subject, ...aliases, ...folded.map((f) => f.subject_id).filter(Boolean)])];
        const userIds = [user.id, ...folded.map((f) => f.id)];
        const inU = `(${userIds.map(() => '?').join(',')})`;
        const inS = `(${subjects.map(() => '?').join(',')})`;
        const del = async (table, where, params, key = table) => { if (await tableExists(db, table)) count(key, (await db.prepare(`DELETE FROM ${table} WHERE ${where}`).run(...params)).changes); };

        for (const t of ['linked_accounts', 'user_sessions', 'oauth_tokens', 'oauth_codes', 'email_verification_tokens', 'password_reset_tokens', 'notifications',
            'notification_preferences', 'user_preferences', 'user_effects', 'push_subscriptions', 'user_history', 'username_history', 'user_profile_changes',
            'ip_log', 'email_delivery_log']) await del(t, `user_id IN ${inU}`, userIds);
        if (await tableExists(db, 'account_merge_intents')) await del('account_merge_intents', `into_user_id IN ${inU}`, userIds);
        // Notifications this person sent others stay, without their name or picture.
        if (await tableExists(db, 'notifications')) await db.prepare(`UPDATE notifications SET sender_id = NULL, sender_name = 'Deleted account', sender_avatar = NULL WHERE sender_id IN ${inU}`).run(...userIds);
        if (await tableExists(db, 'analytics_events')) await db.prepare(`UPDATE analytics_events SET user_id = NULL WHERE user_id IN ${inU}`).run(...userIds);
        await del('user_modules', `subject_id IN ${inS}`, subjects, 'modules');
        await del('user_follows', `follower_subject IN ${inS} OR target_id IN ${inS}`, [...subjects, ...subjects], 'follows');
        await del('user_blocks', `blocker_subject IN ${inS} OR blocked_subject IN ${inS}`, [...subjects, ...subjects], 'blocks');
        // The person's agents first (WS-Z2), then the agents of the projects archived below.
        // Their projects' locks first, as agent creation takes them (developer/store.lockProject): no agent of theirs is created after this.
        if (await tableExists(db, 'dev_projects')) {
            await db.prepare(`SELECT p.id FROM dev_projects p JOIN dev_project_members m ON m.project_id = p.id WHERE m.subject_id IN ${inS} ORDER BY p.id FOR NO KEY UPDATE OF p`).all(...subjects);
        }
        if (await tableExists(db, 'dev_agents')) count('agents_revoked', await agents.revokeWhere(db, `owner_subject IN ${inS}`, subjects, { actor: 'system:network', reason: 'account_deleted' }));
        if (await tableExists(db, 'dev_projects')) {
            for (const p of await db.prepare(`SELECT id FROM dev_projects WHERE owner_subject IN ${inS} AND archived_at IS NULL`).all(...subjects)) {
                const heir = await db.prepare(`SELECT subject_id FROM dev_project_members WHERE project_id = ? AND subject_id NOT IN ${inS} AND role IN ('owner', 'admin')
                                         ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, added_at LIMIT 1`).get(p.id, ...subjects);
                if (heir) { await db.prepare('UPDATE dev_projects SET owner_subject = ? WHERE id = ?').run(heir.subject_id, p.id); count('projects_passed_on', 1); continue; }
                for (const a of await db.prepare('SELECT id FROM dev_apps WHERE project_id = ? AND revoked_at IS NULL').all(p.id)) {
                    await db.prepare("UPDATE dev_apps SET revoked_at = ?, revoked_by = 'account_deleted' WHERE id = ?").run(at, a.id);
                    await db.prepare("UPDATE dev_credentials SET revoked_at = ?, revoked_by = 'account_deleted' WHERE app_id = ? AND revoked_at IS NULL").run(at, a.id);
                }
                if (await tableExists(db, 'dev_agents')) count('agents_revoked', await agents.revokeWhere(db, 'project_id = ?', [p.id], { actor: 'system:network', reason: 'project_archived' }));
                await db.prepare("UPDATE dev_projects SET archived_at = ?, archived_by = 'account_deleted' WHERE id = ?").run(at, p.id);
                count('projects_archived', 1);
            }
            await del('dev_project_members', `subject_id IN ${inS}`, subjects, 'project_memberships');
        }
        if (await tableExists(db, 'account_merges')) await db.prepare(`UPDATE account_merges SET pre_state = NULL, reduced_at = COALESCE(reduced_at, ?) WHERE into_user_id IN ${inU} OR from_user_id IN ${inU}`).run(at, ...userIds, ...userIds);
        // OpenCoins: loyalty (ADR-012). The balance closes with one ledger entry; the ledger stays.
        for (const id of userIds) {
            const bal = (await db.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(id) || { balance: 0 }).balance;
            if (bal > 0) {
                await wallet.debit(db, { user_id: id, app_id: 'network', amount: bal, reason: 'account_deleted', ref: deletion.id, idempotency_key: `delete:${deletion.id}:${id}` });
                count('opencoins_closed', bal);
            }
        }
        // The tombstones: the username is released, the rest cleared; the subject stays (never reused).
        const cols = await columnsOf(db, 'users');
        for (const id of userIds) {
            const u = await db.prepare('SELECT subject_id FROM users WHERE id = ?').get(id);
            const name = `deleted-${String(u.subject_id || id).slice(-12).toLowerCase()}`;
            const set = { username: name, email: null, password_hash: '!deleted', display_name: null, avatar_url: null, bio: '', profile_color: null, ban_reason: null,
                name_effect: null, particle_effect: null, email_verified: 0, email_verified_at: null, email_bounced_at: null, email_bounce_reason: null, deleted_at: at };
            const keys = Object.keys(set).filter((k) => cols.includes(k));
            await db.prepare(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => set[k]), id);
            count('accounts', 1);
        }
        await revocation.revokeTokens(db, user.id, { reason: 'account_deleted', actor: { type: 'user', id: subject }, strict: true });
        const expected = await expectedServices(db, CONFIRM);
        await db.prepare("UPDATE account_deletions SET status = 'deleted', deleted_at = ?, expected = ?, erased = ? WHERE id = ?")
            .run(at, JSON.stringify(expected), JSON.stringify(erased), deletion.id);
        const payload = { deletion_id: deletion.id, subject, requested_at: deletion.requested_at, deleted_at: at };
        const others = subjects.filter((s) => s !== subject).slice(0, 50);
        if (others.length) payload.aliases = others;
        await eventRelay.writerFor(db).enqueue(envelope('network.account.deleted', payload, subject, at));
    });
    await run();
    kick(db);
    return erased;
}

/** A service confirms a deletion → network.account-data-receipt@1. */
async function receiveConfirmation(db, deletionId, service, body, { now = Date.now() } = {}) {
    await ensureSchema(db);
    const v = validate('network.account-deletion-confirmation@1', body);
    if (!v.valid) throw new AccountDataError(400, 'deletion.invalid_confirmation', JSON.stringify(v.errors).slice(0, 300));
    const row = ID_RE.del.test(String(deletionId)) ? await db.prepare('SELECT * FROM account_deletions WHERE id = ?').get(deletionId) : null;
    if (!row) throw new AccountDataError(404, 'deletion.not_found', 'no such deletion');
    if (body.subject !== row.subject) throw new AccountDataError(400, 'deletion.wrong_subject', "the confirmation's subject is not the deletion's");
    if (row.status !== 'deleted') throw new AccountDataError(409, 'deletion.not_deleted', 'this deletion has not happened');
    const had = !!await db.prepare('SELECT 1 FROM account_deletion_confirmations WHERE deletion_id = ? AND service = ?').get(row.id, service);
    await db.prepare('INSERT INTO account_deletion_confirmations (deletion_id, service, received_at, completed_at, erased, retained) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (deletion_id, service) DO UPDATE SET received_at = excluded.received_at, completed_at = excluded.completed_at, erased = excluded.erased, retained = excluded.retained')
        .run(row.id, service, iso(now), body.completed_at, JSON.stringify(body.erased), JSON.stringify(body.retained || {}));
    return { id: row.id, service, received_at: iso(now), replaced: had };
}

/** The periodic sweep: build exports past their deadline, delete expired archives, carry out due deletions. */
async function sweep(db, { dir, now = Date.now(), notify } = {}) {
    await ensureSchema(db);
    const out = { built: 0, expired: 0, deleted: 0 };
    for (const r of await db.prepare("SELECT id FROM account_exports WHERE status = 'pending' AND deadline <= ?").all(iso(now))) {
        if (await maybeBuild(db, r.id, { dir, now, force: true, notify })) out.built++;
    }
    for (const r of await db.prepare("SELECT id FROM account_exports WHERE status IN ('ready', 'partial') AND expires_at <= ?").all(iso(now))) {
        try { fs.rmSync(path.join(dir, `${r.id}.zip`), { force: true }); } catch { /* gone already */ }
        await db.prepare("UPDATE account_exports SET status = 'expired' WHERE id = ?").run(r.id);
        out.expired++;
    }
    for (const d of await db.prepare("SELECT * FROM account_deletions WHERE status = 'scheduled' AND delete_after <= ?").all(iso(now))) {
        try { const e = await erase(db, d, { now }); out.deleted++; console.log(`[AccountData] deleted account ${d.subject} (${d.id}): ${JSON.stringify(e)}`); }
        catch (e) { console.error('[AccountData] deletion failed:', d.id, e.message); }
    }
    return out;
}

function sendError(res, e) {
    if (e instanceof AccountDataError) {
        if (e.extra && e.extra.retry_after) res.set('Retry-After', String(e.extra.retry_after));
        return res.status(e.status).json({ error: e.code, detail: e.message, ...(e.extra || {}) });
    }
    console.error('[AccountData]', e);
    return res.status(500).json({ error: 'account_data.failed', detail: 'that did not work' });
}

/**
 * Routers: `me` under /api/v1/account (the person), `internal` under /internal (service tokens: contributeGuard,
 * confirmGuard) and `admin` under /api/admin/account-deletions (staff.users.manage).
 */
function routers({ requireAuth, staffClaims, contributeGuard, confirmGuard, dir, notify }) {
    const me = express.Router();
    me.use(express.json({ limit: '8kb' }));
    const noStore = (res) => res.set('Cache-Control', cache.htmlHeaders({ private: true }));
    me.post('/export', requireAuth, async (req, res) => {
        const db = req.app.locals.db;
        try {
            const out = await startExport(db, req.user);
            if (out.status === 201) setImmediate(async () => await maybeBuild(db, out.row.id, { dir, notify }));
            noStore(res).status(out.status).json(out.body);
        } catch (e) { sendError(res, e); }
    });
    me.get('/export', requireAuth, async (req, res) => {
        const db = req.app.locals.db; await ensureSchema(db);
        const rows = await db.prepare('SELECT * FROM account_exports WHERE user_id = ? ORDER BY requested_at DESC LIMIT 5').all(req.user.id);
        noStore(res).json({ exports: (await Promise.all(rows.map(async (r) => await exportView(db, r)))) });
    });
    me.get('/export/:id', requireAuth, async (req, res) => {
        const db = req.app.locals.db; await ensureSchema(db);
        const row = ID_RE.exp.test(req.params.id) ? await db.prepare('SELECT * FROM account_exports WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id) : null;
        if (!row) return res.status(404).json({ error: 'export.not_found' });
        noStore(res).json(await exportView(db, row));
    });
    me.get('/export/:id/download', requireAuth, async (req, res) => {
        try {
            const { row, file } = await exportFile(req.app.locals.db, req.user, req.params.id, { dir });
            if (!fs.existsSync(file)) return res.status(410).json({ error: 'export.expired' });
            const day = row.ready_at.slice(0, 10);
            noStore(res).set('Content-Type', 'application/zip')
                .set('Content-Disposition', `attachment; filename="openvibe-${String(req.user.username).replace(/[^A-Za-z0-9_.-]/g, '_')}-${day}.zip"`)
                .set('X-Content-Type-Options', 'nosniff');
            fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
        } catch (e) { sendError(res, e); }
    });
    me.get('/deletion', requireAuth, async (req, res) => {
        const db = req.app.locals.db; await ensureSchema(db);
        const row = await db.prepare("SELECT * FROM account_deletions WHERE user_id = ? AND status = 'scheduled'").get(req.user.id);
        noStore(res).json({ deletion: row ? deletionView(row) : null });
    });
    me.post('/deletion', requireAuth, async (req, res) => {
        try {
            const out = await scheduleDeletion(req.app.locals.db, req.user, req.tokenClaims, req.body && req.body.confirm_username);
            noStore(res).status(out.status).json(out.body);
        } catch (e) { sendError(res, e); }
    });
    me.delete('/deletion', requireAuth, async (req, res) => {
        const out = await cancelDeletion(req.app.locals.db, req.user.id, { by: 'person' });
        if (!out) return res.status(404).json({ error: 'deletion.not_scheduled' });
        noStore(res).json(out);
    });

    const internal = express.Router();
    const service = (req) => String((req.principal && req.principal.sub) || '').replace(/^svc:/, '');
    internal.post('/account-exports/:id/parts', contributeGuard, express.json({ limit: '21mb' }), async (req, res) => {
        const db = req.app.locals.db;
        try {
            const receipt = await receivePart(db, req.params.id, service(req), req.body);
            // Build before answering: a part that completes the export must read back as ready, not race the
            // caller (the deadline path still builds in sweep).
            await maybeBuild(db, receipt.id, { dir, notify });
            res.json(receipt);
        } catch (e) { sendError(res, e); }
    });
    internal.post('/account-deletions/:id/confirmations', confirmGuard, express.json({ limit: '64kb' }), async (req, res) => {
        try { res.json(await receiveConfirmation(req.app.locals.db, req.params.id, service(req), req.body)); } catch (e) { sendError(res, e); }
    });

    const admin = express.Router();
    admin.use(express.json({ limit: '8kb' }));
    const staffOnly = (req, res, next) => (staff.can(staffClaims(req.user), 'staff.users.manage') ? next() : res.status(403).json({ error: 'forbidden', detail: 'staff.users.manage required' }));
    admin.get('/', requireAuth, staffOnly, async (req, res) => {
        const db = req.app.locals.db; await ensureSchema(db);
        const rows = await db.prepare("SELECT * FROM account_deletions WHERE status = 'scheduled' OR deleted_at > ? ORDER BY requested_at DESC LIMIT 200").all(iso(Date.now() - 90 * 86400000));
        const confirmed = db.prepare('SELECT service FROM account_deletion_confirmations WHERE deletion_id = ?');
        noStore(res).json({
            deletions: (await Promise.all(rows.map(async (r) => {
                const got = (await confirmed.all(r.id)).map((c) => c.service);
                return { ...deletionView(r), subject: r.subject, confirmed: got, outstanding: JSON.parse(r.expected || '[]').filter((s) => !got.includes(s)) };
            }))),
        });
    });
    admin.post('/:id/cancel', requireAuth, staffOnly, async (req, res) => {
        const db = req.app.locals.db; await ensureSchema(db);
        const reason = String((req.body && req.body.reason) || '').trim();
        if (reason.length < 10) return res.status(400).json({ error: 'deletion.reason_required', detail: 'a written reason (10 characters or more)' });
        const row = ID_RE.del.test(req.params.id) ? await db.prepare("SELECT * FROM account_deletions WHERE id = ? AND status = 'scheduled'").get(req.params.id) : null;
        if (!row) return res.status(404).json({ error: 'deletion.not_scheduled' });
        const out = await cancelDeletion(db, row.user_id, { by: `staff:${req.user.subject_id || req.user.id}` });
        await db.prepare('INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)').run(req.user.id, 'account_deletion_cancelled', JSON.stringify({ deletion_id: row.id, subject: row.subject, reason: reason.slice(0, 500) }));
        res.json(out);
    });
    return { me, internal, admin };
}

module.exports = {
    ensureSchema, startExport, receivePart, maybeBuild, networkPart, exportFile, exportView, scheduleDeletion, cancelDeletion, erase,
    receiveConfirmation, sweep, routers, expectedServices, AccountDataError, GRACE_MS, EXPORT_DEADLINE_MS, EXPORT_KEEP_MS,
};
