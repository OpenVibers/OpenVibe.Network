'use strict';
/**
 * People's own layouts (make your own controls design, 2026-11-11, piece 4).
 *
 * One ui.layout@1 per row: the active arrangement for one surface on one device class, and the saved
 * ones beside it. A product reads the active one for its surface (with the person's session or, for
 * a first-party service, network.layout.read); the person's own pages list, save, rename, delete,
 * set active, share read-only, publish to the gallery and copy from it. Reset to default clears the
 * active arrangement so the product draws its own.
 *
 * Every write is checked twice before it is stored: the document against ui.layout@1, and the
 * document against the ui.surface@1 catalog the caller sends, through openvibe-sdk/ui-layout — the
 * same function the editor and OpenVibe.AI use. A refusal is 422 with the validator's plain reasons.
 * A share or gallery answer carries the name and the parts only, never the account.
 *
 * Each change and its network.layout.changed@1 event are one transaction: the event goes through the
 * existing outbox (server/developer/event-relay.js), so an open page hears about it from Events or
 * refetches. Account export and deletion include the rows (server/identity/account-data.js).
 */
const crypto = require('crypto');
const express = require('express');
const { ids, validate, http, serviceAuth, capabilities } = require('openvibe-contracts');
const uiLayout = require('openvibe-sdk/ui-layout');
const eventRelay = require('../developer/event-relay');

const CONTRACT = 'ui.layout@1';
const SURFACE_CONTRACT = 'ui.surface@1';
const SUGGESTION_CONTRACT = 'ui.layout-suggestion@1';
const EVENT_TYPE = 'network.layout.changed';
const DEVICES = ['phone', 'tablet', 'computer'];
const SURFACE_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;
const LAYOUT_ID_RE = /^lay_[0-9A-HJKMNP-TV-Z]{26}$/;
const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{24,64}$/;
const SERVICE_CAPABILITY = 'network.layout.read';
const SELF_AUDIENCE = 'openvibe.network';
const MAX_SAVED = 200;
const WRITE_LIMIT = 60;
const SUGGEST_LIMIT = 10;
const WINDOW_MS = 60_000;
const MAX_BODY = '192kb';
const BAD_TEXT = /(?:https?:\/\/|www\.|(?:^|[\s"'(])(?:javascript|data|vbscript|file):|<\s*\/?\s*(?:script|iframe|img|svg|style|a|object|embed)\b|\bon[a-z]{3,}\s*=|=>|\bfunction\s*\(|\beval\s*\(|\brequire\s*\(|\bimport\s*\()/i;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const iso = (v) => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());
const nowIso = (now) => new Date(now()).toISOString();

class LayoutError extends Error {
    constructor(status, code, detail, extra) { super(detail); this.status = status; this.code = code; this.extra = extra; }
}

/** An id in the lay_ prefix the contract names; the contracts' id table has no layout kind. */
const newLayoutId = (now) => `lay_${ids.ulid(now)}`;

function parseDoc(value) {
    if (isObject(value)) return value;
    if (typeof value !== 'string') return null;
    try { const v = JSON.parse(value); return isObject(v) ? v : null; } catch { return null; }
}

/** The stored document plus the store's own fields; null when it no longer matches ui.layout@1. */
function layoutOf(row) {
    const doc = row && parseDoc(row.doc);
    if (!doc) return null;
    const out = {
        ...doc,
        id: row.id,
        revision: Number(row.revision) || 1,
        active: Boolean(row.active),
        sharing: row.sharing || doc.sharing || 'private',
        updated_at: iso(row.updated_at),
    };
    return validate(CONTRACT, out).valid ? out : null;
}

/** What a share link or the gallery shows: the surface, parts, name, author's display name and id. */
function publicView(row) {
    const doc = parseDoc(row && row.doc);
    if (!doc) return null;
    const out = {
        id: row.id,
        surface: row.surface,
        surface_version: Number(row.surface_version),
        device: row.device,
        name: row.name,
        author: { name: (doc.author && doc.author.name) || 'OpenVibe user' },
        sharing: row.sharing,
        parts: doc.parts,
        updated_at: iso(row.updated_at),
    };
    const v = validate(CONTRACT, out);
    return v.valid ? out : null;
}

function plainFaults(errors) {
    return (errors || []).slice(0, 20).map((e) => `${String(e.path || e.instancePath || '').replace(/^\//, '').replace(/\//g, '.') || 'layout'}: ${e.message}`);
}

function checked(value, contract = CONTRACT) {
    const r = validate(contract, value);
    if (r.valid) return value;
    throw new LayoutError(422, 'layout.invalid', 'that is not a valid layout', { reasons: plainFaults(r.errors), errors: r.errors });
}

/** Check a layout and the catalog it belongs to with the SDK, the one authority the editor and AI use. */
function validateWithCatalog(catalog, layout, surface, device) {
    const c = validate(SURFACE_CONTRACT, catalog);
    if (!c.valid) throw new LayoutError(400, 'layout.catalog_invalid', 'the surface catalog is not valid', { errors: c.errors });
    if (catalog.id !== surface) throw new LayoutError(422, 'layout.surface_mismatch', `this catalog is for ${catalog.id}, not ${surface}`);
    if (!Array.isArray(catalog.devices) || !catalog.devices.includes(device)) {
        throw new LayoutError(422, 'layout.device_mismatch', `${surface} is not offered on ${device}`);
    }
    checked(layout);
    if (layout.surface !== surface) throw new LayoutError(422, 'layout.surface_mismatch', `the layout names ${layout.surface}, not ${surface}`);
    if (layout.device !== device) throw new LayoutError(422, 'layout.device_mismatch', `the layout is for ${layout.device}, not ${device}`);
    if (layout.surface_version !== catalog.version) throw new LayoutError(422, 'layout.version_mismatch', `the layout is for version ${layout.surface_version} of ${surface}; the catalog is version ${catalog.version}`);
    const result = uiLayout.validate(catalog, layout);
    if (!result.ok) throw new LayoutError(422, 'layout.invalid', result.reasons.join(' '), { reasons: result.reasons });
    return layout;
}

/** The person's own document, with the server's author, name and sharing: a client never chooses those. */
function cleanLayout(layout, user) {
    const name = String(user.display_name || user.username || 'OpenVibe user').slice(0, 80);
    return {
        surface: layout.surface,
        surface_version: layout.surface_version,
        device: layout.device,
        name: String(layout.name).slice(0, 80),
        author: { name, subject: { type: 'user', id: user.subject_id } },
        sharing: 'private',
        parts: layout.parts,
    };
}

function envelope(subject, payload, at) {
    const ms = Date.parse(at) || Date.now();
    const env = {
        event_id: ids.newId('event', ms), event_type: EVENT_TYPE, version: 1, source: 'network',
        actor: { type: 'user', id: subject }, timestamp: at, visibility: 'internal',
        subject: { type: 'user', id: subject, revision: payload.revision }, payload,
    };
    const v = validate('events.event-envelope@1', env);
    const pv = validate(`${EVENT_TYPE}@1`, payload);
    if (!v.valid || !pv.valid) throw new Error(`layouts: bad ${EVENT_TYPE}: ${JSON.stringify((v.errors || []).concat(pv.errors || [])).slice(0, 300)}`);
    return env;
}

async function queue(db, subject, payload, at) {
    await eventRelay.writerFor(db).enqueue(envelope(subject, payload, at));
    try { const live = eventRelay.outboxFor(db); if (live) live.kick(); } catch { /* the relay polls anyway */ }
}

/** A per-person sliding window for writes and suggestions, the pattern the menu-feeds module uses. */
function limiter() {
    const seen = new Map();
    return function allow(key, limit, at) {
        const kept = (seen.get(key) || []).filter((t) => at - t < WINDOW_MS);
        if (kept.length >= limit) { seen.set(key, kept); return false; }
        kept.push(at); seen.set(key, kept);
        if (seen.size > 5000) seen.delete(seen.keys().next().value);
        return true;
    };
}

function createLayouts({ db, now = () => Date.now(), log = console, aiUrl = 'http://127.0.0.1:4700', selfToken = null, fetchImpl = globalThis.fetch } = {}) {
    if (!db) throw new TypeError('createLayouts: db is required');
    const allow = limiter();
    const at = () => now();

    const rowFor = async (subject, id) => await db.prepare('SELECT * FROM ui_layouts WHERE id = ? AND subject_id = ?').get(id, subject);
    const activeRow = async (subject, surface, device) => await db.prepare('SELECT * FROM ui_layouts WHERE subject_id = ? AND surface = ? AND device = ? AND active').get(subject, surface, device);

    async function active(subject, surface, device) {
        const row = await activeRow(subject, surface, device);
        return row ? layoutOf(row) : null;
    }

    async function get(subject, id) {
        const row = await rowFor(subject, id);
        if (!row) throw new LayoutError(404, 'layout.not_found', 'no such layout');
        return layoutOf(row);
    }

    async function list(subject, { surface = null, device = null } = {}) {
        const where = ['subject_id = ?']; const params = [subject];
        if (surface) { where.push('surface = ?'); params.push(surface); }
        if (device) { where.push('device = ?'); params.push(device); }
        const rows = await db.prepare(`SELECT * FROM ui_layouts WHERE ${where.join(' AND ')} ORDER BY active DESC, updated_at DESC LIMIT ${MAX_SAVED}`).all(...params);
        return rows.map(layoutOf).filter(Boolean);
    }

    /** PUT: the active layout for this surface/device, updated in place when there is one. */
    async function setActive(user, surface, device, body) {
        if (!allow(`write:${user.subject_id}`, WRITE_LIMIT, at())) throw new LayoutError(429, 'layout.rate_limited', 'too many layout writes; wait a minute');
        if (!isObject(body) || !isObject(body.catalog) || !isObject(body.layout)) {
            throw new LayoutError(400, 'layout.body_required', 'send { catalog, layout }: the surface catalog and the arrangement');
        }
        validateWithCatalog(body.catalog, body.layout, surface, device);
        const doc = cleanLayout(body.layout, user);
        const ms = at(); const stamp = nowIso(now);
        return await db.tx(async () => {
            const current = await activeRow(user.subject_id, surface, device);
            let row;
            if (current) {
                const revision = Number(current.revision) + 1;
                await db.prepare(`UPDATE ui_layouts SET doc = ?, name = ?, surface_version = ?, revision = ?, updated_at = ? WHERE id = ?`)
                    .run(JSON.stringify({ ...doc, sharing: current.sharing }), doc.name, doc.surface_version, revision, stamp, current.id);
                row = await db.prepare('SELECT * FROM ui_layouts WHERE id = ?').get(current.id);
            } else {
                const id = newLayoutId(ms);
                await db.prepare(`INSERT INTO ui_layouts (id, subject_id, surface, surface_version, device, name, doc, active, sharing, revision, created_at, updated_at)
                                  VALUES (?, ?, ?, ?, ?, ?, ?, TRUE, 'private', 1, ?, ?)`)
                    .run(id, user.subject_id, surface, doc.surface_version, device, doc.name, JSON.stringify(doc), stamp, stamp);
                row = await db.prepare('SELECT * FROM ui_layouts WHERE id = ?').get(id);
            }
            await queue(db, user.subject_id, { surface, device, layout_id: row.id, change: 'active', revision: Number(row.revision), sharing: row.sharing }, stamp);
            return layoutOf(row);
        });
    }

    /** POST: a saved layout beside the active one. */
    async function save(user, body) {
        if (!allow(`write:${user.subject_id}`, WRITE_LIMIT, at())) throw new LayoutError(429, 'layout.rate_limited', 'too many layout writes; wait a minute');
        if (!isObject(body) || !isObject(body.catalog) || !isObject(body.layout)) {
            throw new LayoutError(400, 'layout.body_required', 'send { catalog, layout }: the surface catalog and the arrangement');
        }
        const surface = body.layout.surface; const device = body.layout.device;
        if (!SURFACE_RE.test(String(surface || '')) || !DEVICES.includes(device)) throw new LayoutError(422, 'layout.invalid', 'the layout needs a surface and a device');
        validateWithCatalog(body.catalog, body.layout, surface, device);
        const doc = cleanLayout(body.layout, user);
        const ms = at(); const stamp = nowIso(now);
        return await db.tx(async () => {
            const count = (await db.prepare('SELECT COUNT(*) AS n FROM ui_layouts WHERE subject_id = ?').get(user.subject_id)).n;
            if (Number(count) >= MAX_SAVED) throw new LayoutError(409, 'layout.limit', `you can keep ${MAX_SAVED} layouts`);
            const id = newLayoutId(ms);
            await db.prepare(`INSERT INTO ui_layouts (id, subject_id, surface, surface_version, device, name, doc, active, sharing, revision, created_at, updated_at)
                              VALUES (?, ?, ?, ?, ?, ?, ?, FALSE, 'private', 1, ?, ?)`)
                .run(id, user.subject_id, surface, doc.surface_version, device, doc.name, JSON.stringify(doc), stamp, stamp);
            const row = await db.prepare('SELECT * FROM ui_layouts WHERE id = ?').get(id);
            await queue(db, user.subject_id, { surface, device, layout_id: id, change: 'saved', revision: 1, sharing: 'private' }, stamp);
            return layoutOf(row);
        });
    }

    /** PATCH: a new name; nothing else changes. */
    async function rename(user, id, body) {
        const row = await rowFor(user.subject_id, id);
        if (!row) throw new LayoutError(404, 'layout.not_found', 'no such layout');
        if (!isObject(body) || typeof body.name !== 'string' || !body.name.trim() || body.name.length > 80) {
            throw new LayoutError(400, 'layout.name_required', 'send { name }: one to eighty characters');
        }
        if (BAD_TEXT.test(body.name)) throw new LayoutError(422, 'layout.invalid', "a name can't carry a URL or code");
        const doc = parseDoc(row.doc);
        if (!doc) throw new LayoutError(500, 'layout.corrupt', 'this layout cannot be read');
        const name = body.name.trim(); const revision = Number(row.revision) + 1; const stamp = nowIso(now);
        return await db.tx(async () => {
            await db.prepare('UPDATE ui_layouts SET name = ?, doc = ?, revision = ?, updated_at = ? WHERE id = ?')
                .run(name, JSON.stringify({ ...doc, name }), revision, stamp, id);
            await queue(db, user.subject_id, { surface: row.surface, device: row.device, layout_id: id, change: 'renamed', revision, sharing: row.sharing }, stamp);
            return layoutOf(await db.prepare('SELECT * FROM ui_layouts WHERE id = ?').get(id));
        });
    }

    async function activate(user, id) {
        const row = await rowFor(user.subject_id, id);
        if (!row) throw new LayoutError(404, 'layout.not_found', 'no such layout');
        if (row.active) return layoutOf(row);
        const revision = Number(row.revision) + 1; const stamp = nowIso(now);
        return await db.tx(async () => {
            await db.prepare('UPDATE ui_layouts SET active = FALSE WHERE subject_id = ? AND surface = ? AND device = ? AND active').run(user.subject_id, row.surface, row.device);
            await db.prepare('UPDATE ui_layouts SET active = TRUE, revision = ?, updated_at = ? WHERE id = ?').run(revision, stamp, id);
            await queue(db, user.subject_id, { surface: row.surface, device: row.device, layout_id: id, change: 'active', revision, sharing: row.sharing }, stamp);
            return layoutOf(await db.prepare('SELECT * FROM ui_layouts WHERE id = ?').get(id));
        });
    }

    async function remove(user, id) {
        const row = await rowFor(user.subject_id, id);
        if (!row) throw new LayoutError(404, 'layout.not_found', 'no such layout');
        const stamp = nowIso(now); const revision = Number(row.revision) + 1;
        await db.tx(async () => {
            await db.prepare('DELETE FROM ui_layouts WHERE id = ?').run(id);
            await queue(db, user.subject_id, { surface: row.surface, device: row.device, layout_id: id, change: 'deleted', revision, sharing: row.sharing }, stamp);
        });
        return true;
    }

    /** Reset to the product's default: the active arrangement stops being active; the saved row stays. */
    async function reset(user, surface, device) {
        const row = await activeRow(user.subject_id, surface, device);
        if (!row) return false;
        const revision = Number(row.revision) + 1; const stamp = nowIso(now);
        await db.tx(async () => {
            await db.prepare('UPDATE ui_layouts SET active = FALSE, revision = ?, updated_at = ? WHERE id = ?').run(revision, stamp, row.id);
            await queue(db, user.subject_id, { surface, device, layout_id: row.id, change: 'reset', revision, sharing: row.sharing }, stamp);
        });
        return true;
    }

    async function share(user, id) {
        const row = await rowFor(user.subject_id, id);
        if (!row) throw new LayoutError(404, 'layout.not_found', 'no such layout');
        const token = row.share_token || crypto.randomBytes(24).toString('base64url');
        const revision = Number(row.revision) + 1; const stamp = nowIso(now);
        return await db.tx(async () => {
            const doc = parseDoc(row.doc) || {};
            await db.prepare("UPDATE ui_layouts SET sharing = 'link', share_token = ?, doc = ?, revision = ?, updated_at = ? WHERE id = ?")
                .run(token, JSON.stringify({ ...doc, sharing: 'link' }), revision, stamp, id);
            await queue(db, user.subject_id, { surface: row.surface, device: row.device, layout_id: id, change: 'shared', revision, sharing: 'link' }, stamp);
            const out = layoutOf(await db.prepare('SELECT * FROM ui_layouts WHERE id = ?').get(id));
            return { layout: out, token, url: `/api/v1/layouts/shared/${token}` };
        });
    }

    async function unshare(user, id) {
        const row = await rowFor(user.subject_id, id);
        if (!row) throw new LayoutError(404, 'layout.not_found', 'no such layout');
        const revision = Number(row.revision) + 1; const stamp = nowIso(now);
        return await db.tx(async () => {
            const doc = parseDoc(row.doc) || {};
            await db.prepare("UPDATE ui_layouts SET sharing = 'private', share_token = NULL, published_at = NULL, doc = ?, revision = ?, updated_at = ? WHERE id = ?")
                .run(JSON.stringify({ ...doc, sharing: 'private' }), revision, stamp, id);
            await queue(db, user.subject_id, { surface: row.surface, device: row.device, layout_id: id, change: 'unshared', revision, sharing: 'private' }, stamp);
            return layoutOf(await db.prepare('SELECT * FROM ui_layouts WHERE id = ?').get(id));
        });
    }

    async function publish(user, id) {
        const row = await rowFor(user.subject_id, id);
        if (!row) throw new LayoutError(404, 'layout.not_found', 'no such layout');
        const revision = Number(row.revision) + 1; const stamp = nowIso(now);
        return await db.tx(async () => {
            const doc = parseDoc(row.doc) || {};
            await db.prepare("UPDATE ui_layouts SET sharing = 'gallery', published_at = ?, doc = ?, revision = ?, updated_at = ? WHERE id = ?")
                .run(stamp, JSON.stringify({ ...doc, sharing: 'gallery' }), revision, stamp, id);
            await queue(db, user.subject_id, { surface: row.surface, device: row.device, layout_id: id, change: 'published', revision, sharing: 'gallery' }, stamp);
            return layoutOf(await db.prepare('SELECT * FROM ui_layouts WHERE id = ?').get(id));
        });
    }

    async function unpublish(user, id) {
        const row = await rowFor(user.subject_id, id);
        if (!row) throw new LayoutError(404, 'layout.not_found', 'no such layout');
        const revision = Number(row.revision) + 1; const stamp = nowIso(now);
        return await db.tx(async () => {
            const doc = parseDoc(row.doc) || {};
            await db.prepare("UPDATE ui_layouts SET sharing = 'private', published_at = NULL, doc = ?, revision = ?, updated_at = ? WHERE id = ?")
                .run(JSON.stringify({ ...doc, sharing: 'private' }), revision, stamp, id);
            await queue(db, user.subject_id, { surface: row.surface, device: row.device, layout_id: id, change: 'unpublished', revision, sharing: 'private' }, stamp);
            return layoutOf(await db.prepare('SELECT * FROM ui_layouts WHERE id = ?').get(id));
        });
    }

    async function gallery({ surface = null, device = null, limit = 60 } = {}) {
        const where = ["sharing = 'gallery'", 'published_at IS NOT NULL']; const params = [];
        if (surface) { where.push('surface = ?'); params.push(surface); }
        if (device) { where.push('device = ?'); params.push(device); }
        const rows = await db.prepare(`SELECT * FROM ui_layouts WHERE ${where.join(' AND ')} ORDER BY published_at DESC LIMIT ?`).all(...params, Math.min(100, Math.max(1, limit)));
        return rows.map(publicView).filter(Boolean);
    }

    async function shared(token) {
        if (!TOKEN_RE.test(String(token || ''))) return null;
        const row = await db.prepare("SELECT * FROM ui_layouts WHERE share_token = ? AND sharing IN ('link', 'gallery')").get(token);
        return row ? publicView(row) : null;
    }

    async function copy(user, id) {
        const source = await db.prepare("SELECT * FROM ui_layouts WHERE id = ? AND sharing = 'gallery' AND published_at IS NOT NULL").get(id);
        if (!source) throw new LayoutError(404, 'layout.not_found', 'no such gallery layout');
        const doc = parseDoc(source.doc);
        if (!doc) throw new LayoutError(500, 'layout.corrupt', 'this layout cannot be read');
        const ms = at(); const stamp = nowIso(now);
        const copyId = newLayoutId(ms);
        const name = `${String(source.name).slice(0, 72)} (copy)`;
        return await db.tx(async () => {
            const count = (await db.prepare('SELECT COUNT(*) AS n FROM ui_layouts WHERE subject_id = ?').get(user.subject_id)).n;
            if (Number(count) >= MAX_SAVED) throw new LayoutError(409, 'layout.limit', `you can keep ${MAX_SAVED} layouts`);
            const outDoc = { ...doc, name, author: { name: String(user.display_name || user.username || 'OpenVibe user').slice(0, 80), subject: { type: 'user', id: user.subject_id } }, sharing: 'private' };
            await db.prepare(`INSERT INTO ui_layouts (id, subject_id, surface, surface_version, device, name, doc, active, sharing, revision, created_at, updated_at)
                              VALUES (?, ?, ?, ?, ?, ?, ?, FALSE, 'private', 1, ?, ?)`)
                .run(copyId, user.subject_id, source.surface, source.surface_version, source.device, name, JSON.stringify(outDoc), stamp, stamp);
            await queue(db, user.subject_id, { surface: source.surface, device: source.device, layout_id: copyId, change: 'copied', revision: 1, sharing: 'private' }, stamp);
            return layoutOf(await db.prepare('SELECT * FROM ui_layouts WHERE id = ?').get(copyId));
        });
    }

    /** The first-party service read: the active layout one person made for the product's own surface. */
    async function forSubject(subject, surface, device) {
        const user = await db.prepare('SELECT id, subject_id FROM users WHERE subject_id = ?').get(subject);
        if (!user) throw new LayoutError(404, 'identity.subject_not_found', 'no such person');
        const layout = await active(subject, surface, device);
        if (!layout) throw new LayoutError(404, 'layout.none', 'this person has not arranged this surface on this device');
        return layout;
    }

    async function suggest(user, surface, device, body) {
        if (!allow(`suggest:${user.subject_id}`, SUGGEST_LIMIT, at())) throw new LayoutError(429, 'layout.rate_limited', 'too many suggestions; wait a minute');
        if (!isObject(body) || !isObject(body.catalog)) throw new LayoutError(400, 'layout.catalog_required', 'send { catalog, layout, words }');
        const words = typeof body.words === 'string' ? body.words.trim() : '';
        if (!words || words.length > 500) throw new LayoutError(422, 'layout.words_invalid', 'describe the arrangement in one to five hundred characters');
        if (body.layout != null) validateWithCatalog(body.catalog, body.layout, surface, device);
        else {
            const c = validate(SURFACE_CONTRACT, body.catalog);
            if (!c.valid) throw new LayoutError(400, 'layout.catalog_invalid', 'the surface catalog is not valid', { errors: c.errors });
            if (body.catalog.id !== surface || !body.catalog.devices.includes(device)) throw new LayoutError(422, 'layout.surface_mismatch', `this catalog is not ${surface} on ${device}`);
        }
        if (typeof selfToken !== 'function') throw new LayoutError(503, 'layout.ai_unavailable', 'OpenVibe.AI is not configured');
        const token = selfToken('openvibe.ai', ['ai.layout.suggest']);
        if (!token) throw new LayoutError(503, 'layout.ai_unavailable', 'OpenVibe.AI is not configured');
        let response;
        try {
            response = await fetchImpl(`${String(aiUrl).replace(/\/$/, '')}/api/v1/ui/layout/suggest`, {
                method: 'POST',
                headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'X-OV-Subject': user.subject_id },
                body: JSON.stringify({ catalog: body.catalog, layout: body.layout || null, words, device }),
            });
        } catch (err) {
            log.warn && log.warn('[Layouts] AI did not answer:', err && err.message);
            throw new LayoutError(503, 'layout.ai_unavailable', 'OpenVibe.AI did not answer');
        }
        let answer = null;
        try { answer = await response.json(); } catch { /* a non-JSON answer is a failure below */ }
        if (!response.ok) {
            throw new LayoutError(response.status === 429 ? 429 : 502, 'layout.ai_failed', (answer && (answer.detail || answer.error)) || 'OpenVibe.AI refused the suggestion');
        }
        if (!validate(SUGGESTION_CONTRACT, answer).valid) throw new LayoutError(502, 'layout.ai_invalid', 'OpenVibe.AI answered something that is not a layout suggestion');
        return answer;
    }

    return { active, get, list, setActive, save, rename, activate, remove, reset, share, unshare, publish, unpublish, gallery, shared, copy, forSubject, suggest };
}

function sendError(res, err, ctx, log = console) {
    if (err && err.status) return http.sendProblem(res, err.status, err.code || 'layout.error', { detail: err.message, errors: err.errors, extra: err.extra, ctx });
    log.error('[Layouts]', err && err.stack || err);
    return http.sendProblem(res, 500, 'layout.error', { detail: 'could not complete that', ctx });
}

function deviceOf(req) {
    const device = String(req.query.device || 'phone');
    if (!DEVICES.includes(device)) throw new LayoutError(400, 'layout.device_invalid', `device must be one of ${DEVICES.join(', ')}`);
    return device;
}

function surfaceOf(req) {
    const surface = String(req.params.surface || '');
    if (!SURFACE_RE.test(surface)) throw new LayoutError(400, 'layout.surface_invalid', 'name the surface, e.g. bot.controls');
    return surface;
}

function idOf(req) {
    const id = String(req.params.id || '');
    if (!LAYOUT_ID_RE.test(id)) throw new LayoutError(400, 'layout.id_invalid', 'name a layout id (lay_…)');
    return id;
}

/** The person's routes, behind Network's session check (a Bearer token from another first-party site). */
function router({ layouts, requireAuth }) {
    const r = express.Router();
    r.use(http.middleware());
    r.use(express.json({ limit: MAX_BODY }));
    r.use((req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
    r.get('/', requireAuth, async (req, res) => {
        try {
            const device = req.query.device ? deviceOf(req) : null;
            const surface = req.query.surface ? String(req.query.surface) : null;
            if (surface && !SURFACE_RE.test(surface)) throw new LayoutError(400, 'layout.surface_invalid', 'name the surface, e.g. bot.controls');
            res.json({ layouts: await layouts.list(req.user.subject_id, { surface, device }) });
        } catch (err) { sendError(res, err, req.ov); }
    });
    r.post('/', requireAuth, async (req, res) => {
        try { res.status(201).json(await layouts.save(req.user, req.body)); }
        catch (err) { sendError(res, err, req.ov); }
    });
    r.get('/:id', requireAuth, async (req, res, next) => {
        if (!LAYOUT_ID_RE.test(String(req.params.id || ''))) return next();
        try { res.json(await layouts.get(req.user.subject_id, req.params.id)); }
        catch (err) { sendError(res, err, req.ov); }
    });
    r.get('/:surface', requireAuth, async (req, res) => {
        try {
            const layout = await layouts.active(req.user.subject_id, surfaceOf(req), deviceOf(req));
            if (!layout) return http.sendProblem(res, 404, 'layout.none', { detail: 'no layout saved for this surface and device; draw the default', ctx: req.ov });
            res.json(layout);
        } catch (err) { sendError(res, err, req.ov); }
    });
    r.put('/:surface', requireAuth, async (req, res) => {
        try { res.json(await layouts.setActive(req.user, surfaceOf(req), deviceOf(req), req.body)); }
        catch (err) { sendError(res, err, req.ov); }
    });
    r.post('/:surface/reset', requireAuth, async (req, res) => {
        try {
            const reset = await layouts.reset(req.user, surfaceOf(req), deviceOf(req));
            if (!reset) return http.sendProblem(res, 404, 'layout.none', { detail: 'there is no saved arrangement to reset', ctx: req.ov });
            res.status(204).end();
        } catch (err) { sendError(res, err, req.ov); }
    });
    r.post('/:surface/suggest', requireAuth, async (req, res) => {
        try { res.json(await layouts.suggest(req.user, surfaceOf(req), deviceOf(req), req.body)); }
        catch (err) { sendError(res, err, req.ov); }
    });
    r.patch('/:id', requireAuth, async (req, res) => {
        try { res.json(await layouts.rename(req.user, idOf(req), req.body)); }
        catch (err) { sendError(res, err, req.ov); }
    });
    r.delete('/:id', requireAuth, async (req, res) => {
        try { await layouts.remove(req.user, idOf(req)); res.status(204).end(); }
        catch (err) { sendError(res, err, req.ov); }
    });
    r.post('/:id/activate', requireAuth, async (req, res) => {
        try { res.json(await layouts.activate(req.user, idOf(req))); }
        catch (err) { sendError(res, err, req.ov); }
    });
    r.post('/:id/share', requireAuth, async (req, res) => {
        try { res.json(await layouts.share(req.user, idOf(req))); }
        catch (err) { sendError(res, err, req.ov); }
    });
    r.delete('/:id/share', requireAuth, async (req, res) => {
        try { res.json(await layouts.unshare(req.user, idOf(req))); }
        catch (err) { sendError(res, err, req.ov); }
    });
    r.post('/:id/publish', requireAuth, async (req, res) => {
        try { res.json(await layouts.publish(req.user, idOf(req))); }
        catch (err) { sendError(res, err, req.ov); }
    });
    r.delete('/:id/publish', requireAuth, async (req, res) => {
        try { res.json(await layouts.unpublish(req.user, idOf(req))); }
        catch (err) { sendError(res, err, req.ov); }
    });
    return r;
}

/** The public, read-only routes: the gallery and one shared layout, with no account data. */
function publicRouter({ layouts, requireAuth }) {
    const r = express.Router();
    r.use(http.middleware());
    const publicCache = (req, res, next) => { res.set('Cache-Control', 'public, max-age=60'); next(); };
    r.get('/gallery', publicCache, async (req, res) => {
        try {
            const surface = req.query.surface ? String(req.query.surface) : null;
            if (surface && !SURFACE_RE.test(surface)) throw new LayoutError(400, 'layout.surface_invalid', 'name the surface, e.g. bot.controls');
            const device = req.query.device ? deviceOf(req) : null;
            res.json({ layouts: await layouts.gallery({ surface, device }) });
        } catch (err) { sendError(res, err, req.ov); }
    });
    r.get('/shared/:token', publicCache, async (req, res) => {
        try {
            const layout = await layouts.shared(req.params.token);
            if (!layout) return http.sendProblem(res, 404, 'layout.not_found', { detail: 'this share link is gone', ctx: req.ov });
            res.json({ layout });
        } catch (err) { sendError(res, err, req.ov); }
    });
    r.post('/gallery/:id/copy', (req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); }, requireAuth, async (req, res) => {
        try { res.status(201).json(await layouts.copy(req.user, idOf(req))); }
        catch (err) { sendError(res, err, req.ov); }
    });
    return r;
}

/**
 * The guard for the service read: a first-party service token (Network's own issuer) holding
 * network.layout.read. It names the person with X-OV-Subject; the path names the same person.
 */
function serviceGuard() {
    return async function layoutServiceGuard(req, res, next) {
        const auth = String(req.headers.authorization || '');
        if (!auth.startsWith('Bearer ')) {
            return http.sendProblem(res, 401, 'token.required', { detail: "a service token is needed here, not a person's", ctx: req.ov });
        }
        const publicKey = req.app.locals.publicKey;
        const issuer = req.app.locals.config && req.app.locals.config.jwt && req.app.locals.config.jwt.issuer;
        const r = serviceAuth.verifyServiceToken(auth.slice(7).trim(), { publicKey, issuer, audience: SELF_AUDIENCE });
        if (!r.ok) return http.sendProblem(res, 401, r.code || 'token.invalid', { detail: r.reason, ctx: req.ov });
        const sub = String(r.claims.sub || '');
        const record = require('../identity/principals').recordDecision(req.app.locals.db);
        if (r.claims.actor_type !== 'service' || !/^svc:[a-z0-9-]{1,39}$/.test(sub)) {
            await record({ req, capability: SERVICE_CAPABILITY, principal: { sub }, allowed: false, code: 'capability.owner_denied' }).catch(() => {});
            return http.sendProblem(res, 403, 'capability.owner_denied', { detail: 'only a first-party service may read a layout here', ctx: req.ov });
        }
        const c = capabilities.check(r.claims, SERVICE_CAPABILITY);
        if (!c.allowed) {
            await record({ req, capability: SERVICE_CAPABILITY, principal: { sub }, allowed: false, code: c.code || 'capability.denied' }).catch(() => {});
            return http.sendProblem(res, 403, c.code || 'capability.denied', { detail: c.reason, ctx: req.ov });
        }
        await record({ req, capability: SERVICE_CAPABILITY, principal: { sub }, allowed: true, code: null }).catch(() => {});
        req.principal = { sub, cap: r.claims.cap, jti: r.claims.jti };
        return next();
    };
}

/** GET /api/v1/people/:subject/layouts/:surface, guarded by network.layout.read. */
function serviceRouter({ layouts }) {
    const r = express.Router();
    r.use(http.middleware());
    r.use((req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
    r.get('/:subject/layouts/:surface', serviceGuard(), async (req, res) => {
        try {
            const subject = String(req.params.subject || '');
            if (!SUBJECT_RE.test(subject)) return http.sendProblem(res, 400, 'layout.subject_required', { detail: 'name the person: usr_…', ctx: req.ov });
            const named = String(req.headers['x-ov-subject'] || '');
            if (named && named !== subject) return http.sendProblem(res, 403, 'layout.subject_mismatch', { detail: 'X-OV-Subject names another person', ctx: req.ov });
            res.json(await layouts.forSubject(subject, surfaceOf(req), deviceOf(req)));
        } catch (err) { sendError(res, err, req.ov); }
    });
    return r;
}

module.exports = { createLayouts, router, publicRouter, serviceRouter, serviceGuard, CONTRACT, EVENT_TYPE, SERVICE_CAPABILITY, MAX_SAVED };
