'use strict';
/**
 * The consent registry (L24, 2026-10-31; Contracts 0.256.0 network.consent@1).
 *
 * Nothing a person makes is off-limits to AI or data use by design: each use is OFF until that person turns it on
 * here. A choice is one row for (subject, purpose, client); changing it revokes the old row and adds a new one, so
 * the record proves what was allowed, under which wording and when. `consent_events` is append-only.
 *
 *   mine(actor)                      → network.me-consent-result@1: every purpose, the active choices, the history
 *   choose(actor, purpose, body)     → network.me-consent-result@1: the person turns one purpose on or off
 *   revokeApp(actor, purpose, client)→ network.me-consent-result@1: one app's grant ends
 *   check({ purpose, kind, client, feature, subjects }) → network.consent-check-result@1
 *   sweep()                          marks expired rows and emits network.consent.changed
 *
 * The check is the only way a service decides. It is TRUE only for an active row that covers the purpose, the kind
 * (empty kinds cover every kind), the client and the feature. Active means revoked_at is null and expires_at has not
 * passed; every check computes that itself, so the expiry sweep is bookkeeping, never the reason a check is right.
 * An unknown, deleted or merged-away subject answers false, exactly like someone who never chose: the answer never
 * tells whether an account exists. A service that cannot reach Network treats every purpose as off.
 *
 * The change event (network.consent.changed@1) is queued through Network's outbox after the transaction commits,
 * never inside it: a service that reads the event and asks again must already see the new row. It carries only the
 * contract's fields, never the content a choice covers.
 */
const express = require('express');
const { ids, validate, http } = require('openvibe-contracts');
const eventRelay = require('../developer/event-relay');

const TEXT_VERSION = '2026-10-31.1';
const KINDS = ['streams', 'vods', 'clips', 'voice', 'chat', 'posts', 'pictures', 'code'];
const WRITE_LIMIT = 30;
const WRITE_WINDOW_MS = 60_000;
const MAX_SUBJECTS = 500;
const HISTORY_LIMIT = 200;
const SWEEP_LIMIT = 500;
const CHOICE_CONTRACT = 'network.consent-choice@1';
const REQUEST_CONTRACT = 'network.consent-check-request@1';
const RESULT_CONTRACT = 'network.consent-check-result@1';
const MINE_CONTRACT = 'network.me-consent-result@1';

/**
 * The four purposes and the exact words the account page shows. Each defaults to off. `allows` says what turning it
 * on permits, `off` what turning it off does, and `cannot_undo` what a person should know before they turn it off.
 * The plain lines the owner asked for (2026-10-31): nothing is "never" again, it is "only if you turn it on".
 */
const PURPOSES = Object.freeze([
    Object.freeze({
        id: 'ai.train',
        title: 'Train AI on what you choose',
        allows: 'OpenVibe may train or fine-tune its models on the content you pick.',
        off: 'OpenVibe trains nothing new on your content.',
        cannot_undo: 'A model already trained keeps what it learned.',
        adults_only: true,
        kinds: Object.freeze([...KINDS]),
        text_version: TEXT_VERSION,
    }),
    Object.freeze({
        id: 'data.public',
        title: 'Put your content in the open dataset',
        allows: "Your content you pick goes into OpenVibe's open dataset, under the licence you choose.",
        off: 'Your content stays out of the next dataset release.',
        cannot_undo: 'Copies already downloaded stay out there; the next release leaves your content out.',
        adults_only: true,
        kinds: Object.freeze([...KINDS]),
        text_version: TEXT_VERSION,
    }),
    Object.freeze({
        id: 'face.recognize',
        title: 'Recognise your face',
        allows: 'Your face is recognised in streams, VODs and pictures, for the features you pick in OpenVibe.Vision.',
        off: 'Recognition stops and nobody new is named.',
        cannot_undo: 'A match already made cannot be unmade.',
        adults_only: true,
        kinds: Object.freeze([]),
        text_version: TEXT_VERSION,
    }),
    Object.freeze({
        id: 'app.data',
        title: 'Let one app use your content',
        allows: 'One named app may use your content for the purposes it showed you when you agreed.',
        off: 'That app loses access at its next check.',
        cannot_undo: 'A copy an app already downloaded stays with the app.',
        adults_only: false,
        kinds: Object.freeze([...KINDS]),
        text_version: TEXT_VERSION,
    }),
]);
const PURPOSE_BY_ID = new Map(PURPOSES.map((p) => [p.id, p]));

class ConsentError extends Error {
    constructor(status, code, detail, extra) { super(detail); this.status = status; this.code = code; this.extra = extra; }
}
const fail = (status, code, detail, extra) => { throw new ConsentError(status, code, detail, extra); };

const iso = (v) => {
    if (v === null || v === undefined) return null;
    if (v instanceof Date) return v.toISOString();
    const d = new Date(String(v));
    return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
};
const atIso = (ms) => new Date(ms).toISOString();
const asArray = (v) => {
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') {
        const inner = v.replace(/^\{|\}$/g, '');
        return inner ? inner.split(',').map((x) => x.replace(/^"|"$/g, '')) : [];
    }
    return [];
};
const asJson = (v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    if (typeof v === 'string') { try { const x = JSON.parse(v); return x && typeof x === 'object' && !Array.isArray(x) ? x : {}; } catch { return {}; } }
    return {};
};
const activeAt = (row, ms) => !row.revoked_at && (!row.expires_at || Date.parse(String(row.expires_at)) > ms);

/** The contract's view of one consents row. */
function consentOf(row, ms) {
    return {
        id: row.id,
        subject: row.subject,
        purpose: row.purpose,
        on: activeAt(row, ms),
        kinds: asArray(row.kinds),
        client: row.client || null,
        options: asJson(row.options),
        text_version: row.text_version,
        source: row.source,
        granted_at: iso(row.granted_at),
        revoked_at: iso(row.revoked_at),
        expires_at: iso(row.expires_at),
    };
}

/** The contract's view of one consent_events row. */
function historyOf(row) {
    return {
        consent_id: row.consent_id,
        purpose: row.purpose,
        client: row.client || null,
        action: row.action,
        at: iso(row.at),
        by: row.by,
        text_version: row.text_version,
    };
}

/** The event's payload — the contract's fields only, and never the content the choice covers. */
function eventPayload(row, on, at) {
    return {
        consent_id: row.id,
        subject: row.subject,
        purpose: row.purpose,
        client: row.client || null,
        on,
        kinds: asArray(row.kinds),
        text_version: row.text_version,
        changed_at: at,
    };
}

/** The envelope Network queues for network.consent.changed. */
function eventEnvelope(payload) {
    const env = {
        event_id: ids.newId('event', Date.parse(payload.changed_at)),
        event_type: 'network.consent.changed',
        version: 1,
        source: 'network',
        actor: { type: 'user', id: payload.subject },
        timestamp: payload.changed_at,
        visibility: 'internal',
        subject: { type: 'user', id: payload.subject },
        payload,
    };
    const v = validate('events.event-envelope@1', env);
    const pv = validate('network.consent.changed@1', payload);
    if (!v.valid || !pv.valid) {
        throw new Error(`consent: bad network.consent.changed event: ${JSON.stringify((v.errors || []).concat(pv.errors || [])).slice(0, 300)}`);
    }
    return env;
}

/** Queue the change events, after their transaction committed. */
async function publish(db, payloads = []) {
    if (!payloads.length) return 0;
    const writer = eventRelay.writerFor(db);
    for (const payload of payloads) await writer.enqueue(db, eventEnvelope(payload));
    try { const live = eventRelay.outboxFor(db); if (live) live.kick(); } catch { /* the relay polls anyway */ }
    return payloads.length;
}

const EVENT_SELECT = `id, consent_id, subject, purpose, client, action, "by", text_version, at`;

/**
 * Revoke every active choice of one subject, inside the caller's transaction (account merge or deletion). The rows
 * are kept; the returned payloads must be published by the caller after its transaction commits.
 */
async function revokeForSubject(t, subject, by, at) {
    const rows = await t.prepare('SELECT * FROM consents WHERE subject = ? AND revoked_at IS NULL').all(subject);
    const payloads = [];
    for (const row of rows) {
        await t.prepare('UPDATE consents SET revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL').run(at, by, row.id);
        await t.prepare('INSERT INTO consent_events (consent_id, subject, purpose, client, action, "by", text_version, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(row.id, row.subject, row.purpose, row.client, 'revoked', by, row.text_version, at);
        payloads.push(eventPayload({ ...row, revoked_at: at }, false, at));
    }
    return payloads;
}

/** Account merge: the account folded away never carries its choices over. Inside the merge's transaction. */
async function revokeForMerge(t, from, { at }) {
    return await revokeForSubject(t, from, 'merge', at);
}

/** Account deletion: revoke every active choice of the account and its aliases. Inside the deletion's transaction. */
async function revokeForDeletion(t, subjects, { at }) {
    const payloads = [];
    for (const subject of [...new Set(subjects)]) payloads.push(...await revokeForSubject(t, subject, 'deletion', at));
    return payloads;
}

/** Every row and every event of one subject, for the account export (ADR-033). */
async function exportOf(db, subject) {
    const consents = (await db.prepare('SELECT * FROM consents WHERE subject = ? ORDER BY granted_at, id').all(subject))
        .map((r) => ({ ...consentOf(r, Date.now()), revoked_by: r.revoked_by }));
    const events = (await db.prepare(`SELECT ${EVENT_SELECT} FROM consent_events WHERE subject = ? ORDER BY id`).all(subject))
        .map((r) => ({ ...historyOf(r), id: Number(r.id), subject: r.subject }));
    return { consents, events };
}

/**
 * The registry for one boot.
 *   db   the Network database
 *   emit async (payload) — called after each transaction commits; defaults to the outbox
 *   now  () => epoch ms
 */
function createConsent({ db, emit, now = () => Date.now(), log = console } = {}) {
    if (!db) throw new TypeError('createConsent: db is required');
    const writes = new Map();
    const send = typeof emit === 'function' ? emit : (payload) => publish(db, [payload]);

    /** 30 writes a minute per person, like the Dock's limit: a runaway page must not fill the registry. */
    function mayWrite(subject, at) {
        const kept = (writes.get(subject) || []).filter((t) => at - t < WRITE_WINDOW_MS);
        if (kept.length >= WRITE_LIMIT) { writes.set(subject, kept); fail(429, 'consent.rate_limited', 'too many consent changes; wait a minute'); }
        kept.push(at);
        writes.set(subject, kept);
        if (writes.size > 5000) writes.delete(writes.keys().next().value);
    }

    function purposeOf(id) {
        const purpose = PURPOSE_BY_ID.get(String(id || ''));
        if (!purpose) fail(400, 'consent.unknown_purpose', `no consent purpose '${String(id || '').slice(0, 40)}'`);
        return purpose;
    }

    /** The active choices and the history of one person → network.me-consent-result@1. */
    async function mine(actor) {
        const at = now();
        const atText = atIso(at);
        const consents = (await db.prepare(`SELECT * FROM consents
            WHERE subject = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
            ORDER BY purpose, client NULLS FIRST, granted_at DESC`).all(actor.subject, atText))
            .map((r) => consentOf(r, at));
        const history = (await db.prepare(`SELECT ${EVENT_SELECT} FROM consent_events WHERE subject = ? ORDER BY id DESC LIMIT ?`)
            .all(actor.subject, HISTORY_LIMIT)).map(historyOf);
        return { purposes: PURPOSES.map((p) => ({ ...p, kinds: [...p.kinds] })), consents, history };
    }

    /**
     * Turn one purpose on or off. On: the old active row (if any) is revoked and a new row granted in one
     * transaction, and the two events go out after it commits. Off: the active row is revoked.
     */
    async function choose(actor, purposeId, body = {}) {
        const purpose = purposeOf(purposeId);
        const at = now();
        const atText = atIso(at);
        mayWrite(actor.subject, at);
        if (!body || typeof body !== 'object' || Array.isArray(body)) fail(422, 'consent.invalid', 'the body must be a consent choice');
        const on = body.on === true;
        const payloads = [];

        if (on) {
            // app.data belongs to an app's consent screen (C4), where the client is named; this page never names one.
            if (purpose.id === 'app.data') fail(422, 'consent.app_data', "an app's choice is made on its consent screen, not here");
            if (body.text_version !== purpose.text_version) {
                fail(409, 'consent.stale_text', 'the wording changed; read the new words and choose again');
            }
            if (purpose.adults_only && body.adult !== true) {
                fail(422, 'consent.adult_required', 'this purpose asks you to confirm that you are 18 or older');
            }
            const kinds = [...new Set(asArray(body.kinds))];
            if (kinds.some((k) => !purpose.kinds.includes(k))) {
                fail(422, 'consent.kind_not_allowed', 'that kind is not one this purpose takes');
            }
            const options = asJson(body.options);
            const rowId = `cns_${ids.ulid(at)}`;

            const fresh = await db.tx(async (t) => {
                const active = await t.prepare('SELECT * FROM consents WHERE subject = ? AND purpose = ? AND client IS NULL AND revoked_at IS NULL FOR UPDATE')
                    .all(actor.subject, purpose.id);
                const out = [];
                for (const old of active) {
                    await t.prepare('UPDATE consents SET revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL').run(atText, 'person', old.id);
                    await t.prepare('INSERT INTO consent_events (consent_id, subject, purpose, client, action, "by", text_version, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
                        .run(old.id, old.subject, old.purpose, old.client, 'revoked', 'person', old.text_version, atText);
                    out.push(eventPayload({ ...old, revoked_at: atText }, false, atText));
                }
                const row = { id: rowId, subject: actor.subject, purpose: purpose.id, kinds, client: null, options,
                    text_version: purpose.text_version, source: 'account', granted_at: atText, revoked_at: null, expires_at: null };
                await t.prepare(`INSERT INTO consents (id, subject, purpose, kinds, client, options, text_version, source, granted_at, revoked_at, revoked_by, expires_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`)
                    .run(row.id, row.subject, row.purpose, kinds, null, JSON.stringify(options), row.text_version, row.source, atText);
                await t.prepare('INSERT INTO consent_events (consent_id, subject, purpose, client, action, "by", text_version, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
                    .run(row.id, row.subject, row.purpose, null, 'granted', 'person', row.text_version, atText);
                out.push(eventPayload(row, true, atText));
                return out;
            });
            payloads.push(...fresh);
        } else {
            // Off: every active row of this purpose goes (app.data can have one row per app; the page turns all off).
            const revoked = await db.tx(async (t) => {
                const active = await t.prepare('SELECT * FROM consents WHERE subject = ? AND purpose = ? AND revoked_at IS NULL FOR UPDATE')
                    .all(actor.subject, purpose.id);
                const out = [];
                for (const old of active) {
                    await t.prepare('UPDATE consents SET revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL').run(atText, 'person', old.id);
                    await t.prepare('INSERT INTO consent_events (consent_id, subject, purpose, client, action, "by", text_version, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
                        .run(old.id, old.subject, old.purpose, old.client, 'revoked', 'person', old.text_version, atText);
                    out.push(eventPayload({ ...old, revoked_at: atText }, false, atText));
                }
                return out;
            });
            payloads.push(...revoked);
        }

        // After the commit, never inside it: a reader of the event that asks again sees the new state.
        for (const payload of payloads) await send(payload);
        return await mine(actor);
    }

    /** One app's grant ends (the person revoking it, or an app revoking itself through its consent screen). */
    async function revokeApp(actor, purposeId, client) {
        const purpose = purposeOf(purposeId);
        const name = String(client || '');
        if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/.test(name)) fail(400, 'consent.invalid_client', 'that is not an app id');
        const at = now();
        const atText = atIso(at);
        mayWrite(actor.subject, at);
        const revoked = await db.tx(async (t) => {
            const active = await t.prepare('SELECT * FROM consents WHERE subject = ? AND purpose = ? AND client = ? AND revoked_at IS NULL FOR UPDATE')
                .all(actor.subject, purpose.id, name);
            const out = [];
            for (const old of active) {
                await t.prepare('UPDATE consents SET revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL').run(atText, 'app_revoked', old.id);
                await t.prepare('INSERT INTO consent_events (consent_id, subject, purpose, client, action, "by", text_version, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
                    .run(old.id, old.subject, old.purpose, old.client, 'revoked', 'app_revoked', old.text_version, atText);
                out.push(eventPayload({ ...old, revoked_at: atText }, false, atText));
            }
            return out;
        });
        for (const payload of revoked) await send(payload);
        return await mine(actor);
    }

    /**
     * May this purpose be used for these people? → network.consent-check-result@1.
     * ONE query: every subject's active rows for the purpose. Everything else is a false answer, never an error and
     * never a sign of whether an account exists.
     */
    async function check(query = {}) {
        const purpose = purposeOf(query.purpose);
        const subjects = Array.isArray(query.subjects) ? [...new Set(query.subjects.map(String))] : [];
        if (!subjects.length) fail(422, 'consent.invalid', 'subjects must name at least one person');
        if (subjects.length > MAX_SUBJECTS) fail(422, 'consent.too_many_subjects', `at most ${MAX_SUBJECTS} subjects a call`);
        if (purpose.id === 'app.data' && !query.client) fail(422, 'consent.client_required', 'app.data needs the app asking (client)');
        const kind = query.kind ? String(query.kind) : null;
        if (kind && !KINDS.includes(kind)) fail(422, 'consent.invalid', 'unknown kind');
        const feature = purpose.id === 'face.recognize' && query.feature ? String(query.feature) : null;
        const client = query.client === undefined || query.client === null || query.client === '' ? null : String(query.client);
        const at = now();
        const atText = atIso(at);

        const rows = await db.prepare(`SELECT subject, client, kinds, options FROM consents
            WHERE subject = ANY(?) AND purpose = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`)
            .all(subjects, purpose.id, atText);

        const bySubject = new Map();
        for (const row of rows) {
            if ((row.client || null) !== client) continue;
            const rowKinds = asArray(row.kinds);
            if (kind ? !(rowKinds.length === 0 || rowKinds.includes(kind)) : rowKinds.length !== 0) continue;
            if (feature) {
                const features = asArray(asJson(row.options).features);
                if (!features.includes(feature)) continue;
            }
            bySubject.set(row.subject, row);
        }

        const allowed = {};
        const licence = {};
        for (const subject of subjects) {
            const row = bySubject.get(subject);
            allowed[subject] = !!row;
            if (row && purpose.id === 'data.public') {
                const l = asJson(row.options).licence;
                if (l) licence[subject] = l;
            }
        }

        const result = { purpose: purpose.id, allowed, checked_at: atText };
        if (query.kind) result.kind = kind;
        if (client) result.client = client;
        if (query.feature && purpose.id === 'face.recognize') result.feature = feature;
        if (purpose.id === 'data.public') result.licence = licence;
        const v = validate(RESULT_CONTRACT, result);
        if (!v.valid) throw new Error(`consent: bad check result: ${JSON.stringify(v.errors).slice(0, 300)}`);
        return result;
    }

    /**
     * The expiry sweep: mark active rows whose end passed, with an 'expired' event, and emit. Bookkeeping only: every
     * check already computes expiry itself, so a late sweep can never make a check wrong.
     *
     * The event's `by` is 'person': the contract's history has no "the clock did it" value, and a time-limited grant
     * is the person's own choice at the moment they made it.
     */
    async function sweep({ limit = SWEEP_LIMIT } = {}) {
        const at = now();
        const atText = atIso(at);
        const rows = await db.prepare(`SELECT * FROM consents
            WHERE revoked_at IS NULL AND expires_at IS NOT NULL AND expires_at <= ? ORDER BY expires_at, id LIMIT ?`).all(atText, limit);
        const payloads = [];
        for (const row of rows) {
            const changed = await db.tx(async (t) => {
                const nowRow = await t.prepare('SELECT * FROM consents WHERE id = ? AND revoked_at IS NULL FOR UPDATE').get(row.id);
                if (!nowRow || !nowRow.expires_at || Date.parse(String(nowRow.expires_at)) > at) return null;
                await t.prepare("UPDATE consents SET revoked_at = expires_at, revoked_by = 'expired' WHERE id = ? AND revoked_at IS NULL").run(nowRow.id);
                await t.prepare('INSERT INTO consent_events (consent_id, subject, purpose, client, action, "by", text_version, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
                    .run(nowRow.id, nowRow.subject, nowRow.purpose, nowRow.client, 'expired', 'person', nowRow.text_version, atText);
                return eventPayload({ ...nowRow, revoked_at: nowRow.expires_at }, false, atText);
            });
            if (changed) payloads.push(changed);
        }
        for (const payload of payloads) await send(payload);
        return payloads.length;
    }

    return { mine, choose, revokeApp, check, sweep, _writes: writes };
}

/** The person's routes, behind Network's session check (like the Dock's), and never cached. */
function router({ consent, requireAuth }) {
    const r = express.Router();
    r.use(http.middleware());
    r.use(express.json({ limit: '16kb' }));
    r.use((req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
    const actorOf = async (req) => {
        const store = require('../developer/store');
        return await store.actorOf(req.app.locals.db, req.user);
    };
    const problem = (res, err, req, fallback) => {
        if (err && err.status) return http.sendProblem(res, err.status, err.code || fallback, { detail: err.message, errors: err.extra && err.extra.errors, ctx: req.ov });
        console.error(`[Consent] ${fallback}:`, err);
        return http.sendProblem(res, 500, fallback, { detail: 'could not read or save your data choices', ctx: req.ov });
    };

    r.get('/', requireAuth, async (req, res) => {
        try {
            res.json(await consent.mine(await actorOf(req)));
        } catch (err) { problem(res, err, req, 'consent.error'); }
    });

    r.put('/:purpose', requireAuth, async (req, res) => {
        try {
            const v = validate(CHOICE_CONTRACT, req.body);
            if (!v.valid) return http.sendProblem(res, 422, 'consent.invalid', { detail: 'that is not a consent choice', errors: v.errors, ctx: req.ov });
            const actor = await actorOf(req);
            res.json(await consent.choose(actor, req.params.purpose, req.body));
        } catch (err) { problem(res, err, req, 'consent.error'); }
    });

    r.delete('/:purpose/:client', requireAuth, async (req, res) => {
        try {
            const actor = await actorOf(req);
            res.json(await consent.revokeApp(actor, req.params.purpose, req.params.client));
        } catch (err) { problem(res, err, req, 'consent.error'); }
    });

    return r;
}

/** The service check, behind network.consent.read (service token only). */
function internalRouter({ consent }) {
    const r = express.Router();
    r.post('/check', async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try {
            const v = validate(REQUEST_CONTRACT, req.body);
            if (!v.valid) return http.sendProblem(res, 400, 'consent.invalid', { detail: 'that is not a consent check', errors: v.errors, ctx: req.ov });
            res.json(await consent.check(req.body));
        } catch (err) {
            if (err && err.status) return http.sendProblem(res, err.status, err.code || 'consent.invalid', { detail: err.message, errors: err.extra && err.extra.errors, ctx: req.ov });
            console.error('[Consent] check:', err);
            // The fail-closed rule belongs to the caller: a service that gets no answer treats every purpose as off.
            return http.sendProblem(res, 500, 'consent.error', { detail: 'could not check consent', ctx: req.ov });
        }
    });
    return r;
}

module.exports = {
    PURPOSES, PURPOSE_BY_ID, TEXT_VERSION, KINDS, WRITE_LIMIT, WRITE_WINDOW_MS, MAX_SUBJECTS,
    createConsent, router, internalRouter, eventEnvelope, publish, exportOf, revokeForMerge, revokeForDeletion,
    ConsentError, CHOICE_CONTRACT, REQUEST_CONTRACT, RESULT_CONTRACT, MINE_CONTRACT,
};
