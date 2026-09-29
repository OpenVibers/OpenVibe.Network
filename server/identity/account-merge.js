'use strict';
/**
 * Account merge (roadmap WS-B task 5, ADR-029; Contracts 0.69.0 network.subject.merged@1,
 * network.account-merge-result@1, staff.identity.merge).
 *
 * Two accounts one person controls become one. The survivor (`into`) keeps its subject, username, profile and
 * settings; the folded-in account (`from`) becomes an alias: subject_aliases (from → into), and resolving `from`,
 * or any legacy id mapped to it, answers the survivor (identity_legacy_map itself is never repointed, ADR-001).
 *
 * Proof, for a person (never staff silently):
 *   1. signed in to the survivor: POST /api/v1/account/merge/intents → a merge intent, valid 10 minutes;
 *   2. signed in to the other account, freshly (the token's auth_time within 10 minutes: a real sign-in, not a
 *      renewal): POST /api/v1/account/merge { intent } folds that account into the intent's.
 * Staff (account recovery): POST /api/admin/account-merges { from, into, reason } needs staff.identity.merge
 * (the owner) and a written reason; it writes an audit row.
 *
 * Network moves what it owns in ONE transaction, with the event network.subject.merged in its outbox:
 *   linked providers, sessions and devices, OAuth tokens and codes, developer projects and memberships,
 *   OpenCoins (one ledger entry per side, reason account_merge, idempotent by merge id), user modules (the
 *   survivor's fields win, the folded-in values fill only what it lacks), follows (both directions), blocks,
 *   notifications, notification and display preferences, push subscriptions and effects.
 * A row that would collide with the survivor's (the same provider, project membership, follow, preference…) keeps
 * the survivor's and drops the other, and is counted. Every other service follows the event.
 *
 * The folded-in user row stays, marked merged_into, with its tokens revoked; signing in to it signs in to the
 * survivor. The merge record keeps its pre-merge state for 30 days so staff can split a mistake by hand; after
 * that the record is reduced to the alias (reduceExpired). A retried merge of the same pair answers the first.
 */
const express = require('express');
const { ids, validate, staff } = require('openvibe-contracts');
const eventRelay = require('../developer/event-relay');
const wallet = require('../coins/wallet');
const modules = require('./modules');
const follows = require('./follows');
const revocation = require('../auth/revocation');

const INTENT_TTL_MS = 10 * 60 * 1000;
const FRESH_SIGN_IN_S = 10 * 60;
const SPLIT_DAYS = 30;
const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

class MergeError extends Error {
    constructor(status, code, detail) { super(detail); this.status = status; this.code = code; }
}

async function ensureSchema(db) { /* the schema is migrations/NNNN_*.sql (plan T2); nothing is created at runtime */ }

/** The survivor of a subject: itself, or what it was merged into (aliases are kept flat). */
async function survivorOf(db, subjectId) {
    try {
        const a = await db.prepare('SELECT subject_id FROM subject_aliases WHERE alias_id = ?').get(String(subjectId || ''));
        return a ? a.subject_id : subjectId;
    } catch { return subjectId; }   // before the first merge the table may not exist
}

/** A user row, or the survivor's when it was merged (signing in to a folded-in account signs in to the survivor). */
async function effectiveUser(db, user) {
    if (!user || !user.merged_into) return user;
    return await db.prepare('SELECT * FROM users WHERE id = ?').get(user.merged_into) || user;
}

const iso = (ms) => new Date(ms).toISOString();

function buildEvent({ mergeId, from, into, mergedAt, splitUntil, initiatedBy, actorSubject }) {
    const payload = { merge_id: mergeId, from, into, merged_at: mergedAt, initiated_by: initiatedBy, split_until: splitUntil };
    const env = {
        event_id: ids.newId('event', Date.parse(mergedAt)), event_type: 'network.subject.merged', version: 1, source: 'network',
        actor: { type: 'user', id: actorSubject }, timestamp: mergedAt, visibility: 'internal',
        subject: { type: 'user', id: into }, payload,
    };
    const v = validate('events.event-envelope@1', env);
    const pv = validate('network.subject.merged@1', payload);
    if (!v.valid || !pv.valid) throw new Error(`account-merge: bad event: ${JSON.stringify((v.errors || []).concat(pv.errors || [])).slice(0, 300)}`);
    return env;
}

/**
 * Move rows keyed by an integer user id. keyCols: the columns that, with the user id, are unique ([] = one row
 * per user); a row whose key the survivor already holds is dropped, or with keepOnClash left on the folded-in
 * account (a linked provider: signing in with it still lands on the survivor through merged_into).
 */
async function moveByUserId(db, table, column, fromId, intoId, keyCols = null, { keepOnClash = false } = {}) {
    let moved = 0; let dropped = 0;
    if (!await tableExists(db, table)) return { moved, dropped };
    const rows = await db.prepare(`SELECT seq AS _rid, * FROM ${table} WHERE ${column} = ?`).all(fromId);
    for (const r of rows) {
        if (keyCols) {
            const where = keyCols.map((k) => ` AND ${k} = ?`).join('');
            const clash = await db.prepare(`SELECT 1 FROM ${table} WHERE ${column} = ?${where}`).get(intoId, ...keyCols.map((k) => r[k]));
            if (clash) {
                if (!keepOnClash) await db.prepare(`DELETE FROM ${table} WHERE seq = ?`).run(r._rid);
                dropped++;
                continue;
            }
        }
        await db.prepare(`UPDATE ${table} SET ${column} = ? WHERE seq = ?`).run(intoId, r._rid);
        moved++;
    }
    return { moved, dropped };
}

async function tableExists(db, name) {
    return !!await db.prepare("SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ?").get(name);
}

/**
 * Fold `fromUser` into `intoUser`. opts: { initiatedBy: 'person'|'staff', actorSubject, reason, now }.
 * → network.account-merge-result@1. Throws MergeError.
 */
async function merge(db, fromUser, intoUser, { initiatedBy = 'person', actorSubject, reason = null, now = Date.now() } = {}) {
    await ensureSchema(db);
    if (!fromUser || !intoUser) throw new MergeError(404, 'merge.unknown_account', 'no such account');
    if (fromUser.id === intoUser.id) throw new MergeError(400, 'merge.same_account', 'an account cannot be merged into itself');
    const from = fromUser.subject_id; const into = intoUser.subject_id;
    if (!SUBJECT_RE.test(String(from || '')) || !SUBJECT_RE.test(String(into || ''))) throw new MergeError(400, 'merge.no_subject', 'both accounts need a subject');
    const done = await db.prepare('SELECT * FROM account_merges WHERE from_subject = ?').get(from);
    if (done) {
        if (done.into_subject !== into) throw new MergeError(409, 'merge.already_merged', 'that account was already merged into another');
        return resultOf(done, true);
    }
    if (fromUser.merged_into || intoUser.merged_into) throw new MergeError(409, 'merge.already_merged', 'one of these accounts was already merged');
    if (fromUser.is_anon || intoUser.is_anon) throw new MergeError(400, 'merge.guest', 'a guest converts by signing up, not by merging');
    if (fromUser.is_banned || intoUser.is_banned) throw new MergeError(403, 'merge.banned', 'a banned account cannot be merged');
    const owner = (process.env.OWNER_USERNAME || 'goosely').toLowerCase();
    if (String(fromUser.username || '').toLowerCase() === owner) throw new MergeError(403, 'merge.owner', "the owner's account cannot be folded into another");

    const mergeId = `mrg_${ids.ulid(now)}`;
    const mergedAt = iso(now);
    const splitUntil = iso(now + SPLIT_DAYS * 86400000);
    const actor = actorSubject || into;
    const run = db.txFn(async () => {
        const pre = {
            user: { ...fromUser, password_hash: undefined },
            linked_accounts: await db.prepare('SELECT id, service, service_user_id FROM linked_accounts WHERE user_id = ?').all(fromUser.id),
            sessions: (await db.prepare('SELECT id FROM user_sessions WHERE user_id = ?').all(fromUser.id)).map((r) => r.id),
            balance: (await db.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(fromUser.id) || { balance: 0 }).balance,
            projects: await tableExists(db, 'dev_projects') ? (await db.prepare('SELECT id FROM dev_projects WHERE owner_subject = ?').all(from)).map((r) => r.id) : [],
            modules: await db.prepare('SELECT namespace, revision FROM user_modules WHERE subject_id = ?').all(from),
        };
        const moved = { providers: 0, sessions: 0, oauth_grants: 0, projects: 0, coins: 0, modules: 0 };
        const dropped = {};
        const note = (k, r) => { if (r.dropped) dropped[k] = (dropped[k] || 0) + r.dropped; return r.moved; };

        moved.providers = note('providers', await moveByUserId(db, 'linked_accounts', 'user_id', fromUser.id, intoUser.id, ['service'], { keepOnClash: true }));
        moved.sessions = note('sessions', await moveByUserId(db, 'user_sessions', 'user_id', fromUser.id, intoUser.id));
        moved.oauth_grants = (await moveByUserId(db, 'oauth_tokens', 'user_id', fromUser.id, intoUser.id)).moved
            + (await moveByUserId(db, 'oauth_codes', 'user_id', fromUser.id, intoUser.id)).moved;
        if (await tableExists(db, 'dev_projects')) {
            moved.projects = (await db.prepare('UPDATE dev_projects SET owner_subject = ? WHERE owner_subject = ?').run(into, from)).changes;
            for (const m of await db.prepare('SELECT project_id FROM dev_project_members WHERE subject_id = ?').all(from)) {
                const has = await db.prepare('SELECT 1 FROM dev_project_members WHERE project_id = ? AND subject_id = ?').get(m.project_id, into);
                if (has) { await db.prepare('DELETE FROM dev_project_members WHERE project_id = ? AND subject_id = ?').run(m.project_id, from); dropped.project_members = (dropped.project_members || 0) + 1; }
                else await db.prepare('UPDATE dev_project_members SET subject_id = ? WHERE project_id = ? AND subject_id = ?').run(into, m.project_id, from);
            }
        }
        // OpenCoins: loyalty (ADR-012), moved by Network itself, one ledger entry per side, once per merge.
        if (pre.balance > 0) {
            await wallet.debit(db, { user_id: fromUser.id, app_id: 'network', amount: pre.balance, reason: 'account_merge', ref: mergeId, idempotency_key: `merge:${mergeId}:out` });
            await wallet.credit(db, { user_id: intoUser.id, app_id: 'network', amount: pre.balance, reason: 'account_merge', ref: mergeId, idempotency_key: `merge:${mergeId}:in` });
            moved.coins = pre.balance;
        }
        const mods = await modules.onSubjectMerged(db, { from, into });
        moved.modules = mods.moved + (mods.filled || 0);
        // Follows (Network's since ADR-030), both directions, and blocks: the survivor's pair wins.
        if (await tableExists(db, 'user_follows')) dropped.follows = follows.onSubjectMerged ? (await follows.onSubjectMerged(db, { from, into })).dropped : 0;
        if (await tableExists(db, 'user_blocks')) {
            for (const col of ['blocker_subject', 'blocked_subject']) {
                const other = col === 'blocker_subject' ? 'blocked_subject' : 'blocker_subject';
                for (const b of await db.prepare(`SELECT ${other} AS o FROM user_blocks WHERE ${col} = ?`).all(from)) {
                    const clash = b.o === into || await db.prepare(`SELECT 1 FROM user_blocks WHERE ${col} = ? AND ${other} = ?`).get(into, b.o);
                    if (clash) await db.prepare(`DELETE FROM user_blocks WHERE ${col} = ? AND ${other} = ?`).run(from, b.o);
                    else await db.prepare(`UPDATE user_blocks SET ${col} = ? WHERE ${col} = ? AND ${other} = ?`).run(into, from, b.o);
                }
            }
        }
        await moveByUserId(db, 'notifications', 'user_id', fromUser.id, intoUser.id);
        await moveByUserId(db, 'push_subscriptions', 'user_id', fromUser.id, intoUser.id);
        note('preferences', await moveByUserId(db, 'notification_preferences', 'user_id', fromUser.id, intoUser.id, ['category']));
        note('preferences', await moveByUserId(db, 'user_preferences', 'user_id', fromUser.id, intoUser.id, []));
        note('effects', await moveByUserId(db, 'user_effects', 'user_id', fromUser.id, intoUser.id, ['effect_type', 'effect_id']));

        // The alias (and any alias of the folded-in subject now points at the survivor: aliases stay flat).
        await db.prepare('UPDATE subject_aliases SET subject_id = ? WHERE subject_id = ?').run(into, from);
        await db.prepare('INSERT INTO subject_aliases (alias_id, subject_id, merge_id, merged_at, merged_by) VALUES (?, ?, ?, ?, ?)').run(from, into, mergeId, mergedAt, actor);
        // The folded-in account: merged, its tokens revoked and announced (network.user.token_valid_after, reason
        // account_merged: sites close its sockets). Its sessions already belong to the survivor.
        await db.prepare('UPDATE users SET merged_into = ? WHERE id = ?').run(intoUser.id, fromUser.id);
        await revocation.revokeTokens(db, fromUser.id, { reason: 'account_merged', actor: { type: 'user', id: actor }, strict: true });
        await db.prepare(`INSERT INTO account_merges (id, from_subject, into_subject, from_user_id, into_user_id, initiated_by, actor_subject, reason, moved, pre_state, merged_at, split_until)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(mergeId, from, into, fromUser.id, intoUser.id, initiatedBy, actor, reason, JSON.stringify({ ...moved, dropped }), JSON.stringify(pre), mergedAt, splitUntil);
        if (initiatedBy === 'staff') {
            await db.prepare('INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)')
                .run(null, 'account_merge', JSON.stringify({ merge_id: mergeId, from, into, actor, reason }));
        }
        await eventRelay.writerFor(db).enqueue(db, buildEvent({ mergeId, from, into, mergedAt, splitUntil, initiatedBy, actorSubject: actor }));
        return await db.prepare('SELECT * FROM account_merges WHERE id = ?').get(mergeId);
    });
    const row = await run();
    try { const live = eventRelay.outboxFor(db); if (live) live.kick(); } catch { /* the relay polls anyway */ }
    return resultOf(row, false);
}

function resultOf(row, replayed) {
    const m = JSON.parse(row.moved || '{}');
    const moved = {};
    for (const k of ['providers', 'sessions', 'oauth_grants', 'projects', 'coins', 'modules']) moved[k] = Number(m[k]) || 0;
    return { merge_id: row.id, from: row.from_subject, into: row.into_subject, merged_at: row.merged_at, split_until: row.split_until, moved, replayed };
}

/** After 30 days a merge record keeps only the alias facts: its pre-merge state is dropped. */
async function reduceExpired(db, { now = Date.now() } = {}) {
    await ensureSchema(db);
    return (await db.prepare('UPDATE account_merges SET pre_state = NULL, reduced_at = ? WHERE reduced_at IS NULL AND split_until < ?').run(iso(now), iso(now))).changes;
}

async function createIntent(db, intoUser, { now = Date.now() } = {}) {
    await ensureSchema(db);
    const id = `mgi_${ids.ulid(now)}`;
    await db.prepare('INSERT INTO account_merge_intents (id, into_user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(id, intoUser.id, now, now + INTENT_TTL_MS);
    return { intent: id, expires_at: iso(now + INTENT_TTL_MS) };
}

/** The person's merge: the caller is the account being folded in (freshly signed in), the intent names the survivor. */
async function mergeWithIntent(db, caller, claims, intentId, { now = Date.now() } = {}) {
    await ensureSchema(db);
    const authTime = Number(claims && claims.auth_time);
    if (!Number.isFinite(authTime) || now / 1000 - authTime > FRESH_SIGN_IN_S) {
        throw new MergeError(401, 'merge.sign_in_again', 'sign in to this account again (within the last 10 minutes) to merge it');
    }
    const intent = await db.prepare('SELECT * FROM account_merge_intents WHERE id = ?').get(String(intentId || ''));
    if (!intent || intent.expires_at < now) throw new MergeError(410, 'merge.intent_expired', 'that merge request expired: start again from the account that stays');
    const into = await db.prepare('SELECT * FROM users WHERE id = ?').get(intent.into_user_id);
    if (intent.used_at) {
        const done = await db.prepare('SELECT * FROM account_merges WHERE from_subject = ? AND into_user_id = ?').get(caller.subject_id, intent.into_user_id);
        if (done) return resultOf(done, true);
        throw new MergeError(410, 'merge.intent_used', 'that merge request was already used');
    }
    const out = await merge(db, caller, into, { initiatedBy: 'person', actorSubject: into && into.subject_id, now });
    await db.prepare('UPDATE account_merge_intents SET used_at = ? WHERE id = ?').run(now, intent.id);
    return out;
}

function sendError(res, e) {
    if (e instanceof MergeError) return res.status(e.status).json({ error: e.code, detail: e.message });
    console.error('[AccountMerge]', e);
    return res.status(500).json({ error: 'merge.failed', detail: 'the merge did not happen' });
}

/** /api/v1/account/merge… (the person) and /api/admin/account-merges (staff.identity.merge). */
function routers({ requireAuth, staffClaims }) {
    const me = express.Router();
    me.use(express.json({ limit: '8kb' }));
    me.post('/merge/intents', requireAuth, async (req, res) => {
        if (req.user.merged_into) return res.status(409).json({ error: 'merge.already_merged' });
        res.status(201).json(await createIntent(req.app.locals.db, req.user));
    });
    me.post('/merge', requireAuth, async (req, res) => {
        try { res.json(await mergeWithIntent(req.app.locals.db, req.user, req.tokenClaims, req.body && req.body.intent)); } catch (e) { sendError(res, e); }
    });
    me.get('/merges', requireAuth, async (req, res) => {
        const db = req.app.locals.db; await ensureSchema(db);
        const rows = await db.prepare('SELECT * FROM account_merges WHERE into_user_id = ? ORDER BY merged_at DESC LIMIT 50').all(req.user.id);
        res.set('Cache-Control', 'private, no-store').json({ merges: rows.map((r) => resultOf(r, false)) });
    });

    const admin = express.Router();
    admin.use(express.json({ limit: '8kb' }));
    admin.post('/', requireAuth, async (req, res) => {
        const db = req.app.locals.db;
        if (!staff.can(staffClaims(req.user), 'staff.identity.merge')) return res.status(403).json({ error: 'forbidden', detail: 'staff.identity.merge required' });
        const b = req.body || {};
        const reason = String(b.reason || '').trim();
        if (reason.length < 10) return res.status(400).json({ error: 'merge.reason_required', detail: 'a staff merge needs a written reason (10 characters or more)' });
        const byRef = async (ref) => (SUBJECT_RE.test(String(ref || '')) ? await db.prepare('SELECT * FROM users WHERE subject_id = ?').get(ref) : await db.prepare('SELECT * FROM users WHERE lower(username) = lower(?)').get(String(ref || '')));
        try {
            const out = await merge(db, await byRef(b.from), await byRef(b.into), { initiatedBy: 'staff', actorSubject: req.user.subject_id, reason: reason.slice(0, 500) });
            res.json(out);
        } catch (e) { sendError(res, e); }
    });
    admin.get('/', requireAuth, async (req, res) => {
        const db = req.app.locals.db; await ensureSchema(db);
        if (!staff.can(staffClaims(req.user), 'staff.identity.merge')) return res.status(403).json({ error: 'forbidden', detail: 'staff.identity.merge required' });
        const rows = await db.prepare('SELECT id, from_subject, into_subject, initiated_by, actor_subject, reason, moved, merged_at, split_until, reduced_at FROM account_merges ORDER BY merged_at DESC LIMIT 200').all();
        res.set('Cache-Control', 'private, no-store').json({ merges: rows });
    });
    return { me, admin };
}

module.exports = { ensureSchema, survivorOf, effectiveUser, merge, mergeWithIntent, createIntent, reduceExpired, routers, MergeError, SPLIT_DAYS };
