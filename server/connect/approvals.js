'use strict';
/**
 * The ask first (Compute plan E7): a send, a delete and a pay action always wait for the person.
 *
 * The request is written down, the caller waits, and the person decides on the Apps page (and in the
 * account hub). Nothing happens before the answer: the action runs only after an approval, and a
 * denial or a timeout is a refusal, not a partial run.
 *
 * A standing rule changes that for one recipe: when the person says that one app and action does not
 * have to ask again, it does not ask again. The rule is per app and per action, never per person
 * across apps.
 *
 * The summary is what the person reads: the app, the action and what it touches. The input itself is
 * not in the summary; only its digest is kept, so the same input can be recognised later.
 */
const crypto = require('crypto');
const { newId } = require('./ids');

const STATES = ['pending', 'approved', 'denied', 'expired'];
const DEFAULT_TTL_MS = 15 * 60 * 1000;
const DEFAULT_WAIT_MS = 120000;
const DEFAULT_POLL_MS = 500;

class ApprovalError extends Error {
    constructor(status, code, detail) { super(detail || code); this.status = status; this.code = code; this.detail = detail || code; }
}
const fail = (status, code, detail) => { throw new ApprovalError(status, code, detail); };

const nowIso = () => new Date().toISOString();
const digestOf = (input) => crypto.createHash('sha256').update(JSON.stringify(input ?? null)).digest('hex');

function view(row) {
    if (!row) return null;
    return {
        id: row.id, app: row.app, action: row.action, summary: row.summary, state: row.state,
        created_at: row.created_at, expires_at: row.expires_at, decided_at: row.decided_at || null,
        caller_id: row.caller_id,
    };
}

/** The person's standing rules, as a map of app.action. */
async function rulesOf(db, subject) {
    const rows = await db.prepare('SELECT app, action FROM connect_rules WHERE subject = ?').all(subject);
    return new Set(rows.map((r) => `${r.app}.${r.action}`));
}

/** Let one recipe ask no more. */
async function setRule(db, subject, app, action, on = true) {
    if (!on) {
        await db.prepare('DELETE FROM connect_rules WHERE subject = ? AND app = ? AND action = ?').run(subject, app, action);
        return { rules: [...(await rulesOf(db, subject))] };
    }
    await db.prepare(`INSERT INTO connect_rules (subject, app, action, created_at) VALUES (?, ?, ?, ?)
                      ON CONFLICT (subject, app, action) DO NOTHING`).run(subject, app, action, nowIso());
    return { rules: [...(await rulesOf(db, subject))] };
}

/** The approvals waiting for this person. */
async function list(db, subject, { state = null } = {}) {
    const rows = state
        ? await db.prepare('SELECT * FROM connect_approvals WHERE subject = ? AND state = ? ORDER BY created_at DESC LIMIT 100').all(subject, state)
        : await db.prepare('SELECT * FROM connect_approvals WHERE subject = ? ORDER BY created_at DESC LIMIT 100').all(subject);
    return rows.map(view);
}

/** Write the request down and let the caller wait. */
async function request(db, { subject, callerId, app, action, summary, input, ttlMs = DEFAULT_TTL_MS }) {
    const id = newId('cap');
    const at = nowIso();
    const expires = new Date(Date.parse(at) + ttlMs).toISOString();
    await db.prepare(`INSERT INTO connect_approvals (id, subject, caller_id, app, action, summary, input_digest, state, created_at, expires_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
        .run(id, subject, callerId, app, action, String(summary || `${app}.${action}`).slice(0, 500), digestOf(input), at, expires);
    return view(await db.prepare('SELECT * FROM connect_approvals WHERE id = ?').get(id));
}

/** The person decides. Only a pending request can be decided, and only by its owner. */
async function decide(db, subject, id, decision) {
    if (!['approve', 'deny'].includes(decision)) fail(422, 'connect.invalid_decision', 'the decision is approve or deny');
    const row = await db.prepare('SELECT * FROM connect_approvals WHERE id = ? AND subject = ?').get(String(id), subject);
    if (!row) fail(404, 'connect.approval_not_found', 'no such request');
    if (row.state !== 'pending') fail(409, 'connect.approval_decided', 'that request was already decided');
    const state = decision === 'approve' ? 'approved' : 'denied';
    const at = nowIso();
    const r = await db.prepare(`UPDATE connect_approvals SET state = ?, decided_at = ? WHERE id = ? AND state = 'pending'`)
        .run(state, at, row.id);
    if (!r.changes) fail(409, 'connect.approval_decided', 'that request was already decided');
    return view(await db.prepare('SELECT * FROM connect_approvals WHERE id = ?').get(row.id));
}

/**
 * Wait for the answer. → { state: 'approved' | 'denied' | 'expired' }
 * A request past its expiry is expired, whether or not anyone noticed.
 */
async function wait(db, id, { timeoutMs = DEFAULT_WAIT_MS, pollMs = DEFAULT_POLL_MS, now = () => Date.now() } = {}) {
    const start = now();
    for (;;) {
        const row = await db.prepare('SELECT * FROM connect_approvals WHERE id = ?').get(String(id));
        if (!row) return { state: 'expired' };
        if (row.state !== 'pending') return { state: row.state };
        if (row.expires_at <= nowIso()) {
            await db.prepare("UPDATE connect_approvals SET state = 'expired' WHERE id = ? AND state = 'pending'").run(row.id);
            return { state: 'expired' };
        }
        if (now() - start >= timeoutMs) return { state: 'pending' };
        await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
}

/** The summary the person reads: what the action would do. */
function summaryOf(app, action, input) {
    const parts = [app.name || app.key, action.title || action.name];
    if (input && typeof input === 'object') {
        const shown = Object.entries(input)
            .filter(([, v]) => typeof v !== 'object' || v === null)
            .slice(0, 4)
            .map(([k, v]) => `${k}: ${String(v).slice(0, 120)}`);
        if (shown.length) parts.push(shown.join(', '));
    }
    return parts.join(' — ');
}

module.exports = { request, decide, wait, list, setRule, rulesOf, summaryOf, view, ApprovalError, STATES, DEFAULT_TTL_MS, DEFAULT_WAIT_MS };
