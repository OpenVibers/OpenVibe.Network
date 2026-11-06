'use strict';
/**
 * Network's sharing API (design 2026-11-06, SHARING-DESIGN-2026-11-06.md, section 4 "Network").
 *
 *   GET /api/v1/shared-with-me      the items other people shared with this person, and the
 *                                   transfers waiting for their answer
 *   GET /api/v1/share/suggestions   the people this person has shared with (the share picker's
 *                                   suggestions): from their own history only, at most 20
 *   GET /api/v1/share/name-check    one @name check for the share picker, with a per-person budget
 *
 * The list is built from the share events (server/sharing/store.js); the name of an item and its
 * own link come from the owning service's share API when it answers (server/sharing/item.js).
 * Everything here is private: the routes need the person's own session and answer only about them.
 */
const express = require('express');
const { http } = require('openvibe-contracts');
const store = require('./store');
const { resolveItem, mintViewerToken, audienceOf, siteOf } = require('./item');
const { resolveUsername } = require('../identity/subjects');

// The picker's budget: thirty name checks a minute for one person. Typing a name checks it as you
// go, so the budget is generous for one search and too small to walk the network's accounts.
const NAME_CHECK_LIMIT = 30;
const NAME_CHECK_WINDOW_MS = 60_000;
// How many items are named on demand in one answer. A long list shows the site and kind beyond this.
const MAX_DETAILS = 25;
const NAME_RE = /^[A-Za-z0-9_.-]{1,40}$/;

/** The key of an item in a map. */
const keyOf = (r) => [r.service, r.kind, r.id].join('|');

/**
 * The name and link of each item, as the owning service sees them, for one person.
 * One token per service is minted and reused for that service's items.
 */
async function describeItems(ctx, refs, viewer) {
    const out = new Map();
    const byService = new Map();
    for (const r of refs) {
        if (!r) continue;
        if (!byService.has(r.service)) byService.set(r.service, []);
        byService.get(r.service).push(r);
    }
    await Promise.all([...byService.entries()].map(async ([service, list]) => {
        const audience = audienceOf(service);
        const token = viewer && audience ? mintViewerToken(ctx, viewer, audience) : null;
        const named = await Promise.all(list.map((r) => resolveItem(ctx, r, { token }).then((d) => [keyOf(r), d])));
        for (const [k, d] of named) out.set(k, d);
    }));
    return out;
}

/** The item, as the list shows it. */
function itemView(grant, owner, details) {
    const site = siteOf(grant.service);
    return {
        service: grant.service,
        kind: grant.kind,
        id: grant.item_id,
        site,
        title: (details && details.title) || null,
        url: (details && details.url) || null,
        owner: owner ? store.personView(owner) : null,
        role: grant.role,
        shared_at: grant.granted_at,
        expires_at: grant.expires_at || null,
    };
}

/** The item's link with the share sheet's answer on it: the person lands on the item, where the
 *  Accept and Decline buttons of the sheet are. */
function answerUrl(url, answer) {
    if (!url) return null;
    try {
        const u = new URL(url);
        u.searchParams.set('share', answer);
        return u.toString();
    } catch { return url; }
}

/** A transfer, as the list shows it. */
function transferView(transfer, owner, details) {
    const site = siteOf(transfer.service);
    const url = (details && details.url) || null;
    return {
        id: transfer.id,
        service: transfer.service,
        kind: transfer.kind,
        item_id: transfer.item_id,
        site,
        title: (details && details.title) || null,
        url,
        from: owner ? store.personView(owner) : null,
        state: transfer.state,
        keep_access: Boolean(transfer.keep_access),
        requested_at: transfer.requested_at,
        expires_at: transfer.expires_at || null,
        accept_url: answerUrl(url, 'accept'),
        decline_url: answerUrl(url, 'decline'),
    };
}

/**
 * The API of sharing.
 * @param {object} ctx  { db, requireAuth, config, privateKey, issuer, fetchImpl, serviceBase }
 */
function createSharingApi(ctx) {
    const router = express.Router();

    // The items shared with this person, and the transfers waiting for their answer.
    router.get('/shared-with-me', ctx.requireAuth, async (req, res) => {
        try {
            const subject = req.user.subject_id;
            const grants = await store.listGrants(ctx.db, subject);
            const transfers = (await store.listTransfers(ctx.db, subject)).filter((t) => t.state === 'pending');
            const refs = [
                ...grants.map((g) => ({ service: g.service, kind: g.kind, id: g.item_id })),
                ...transfers.map((t) => ({ service: t.service, kind: t.kind, id: t.item_id })),
            ].slice(0, MAX_DETAILS);
            const details = await describeItems(ctx, refs, req.user);
            const owners = new Map();
            const ownerOf = async (s) => {
                if (!store.isSubject(s)) return null;
                if (!owners.has(s)) owners.set(s, await store.personBySubject(ctx.db, s));
                return owners.get(s);
            };
            const items = [];
            for (const g of grants) items.push(itemView(g, await ownerOf(g.owner_subject), details.get(keyOf({ service: g.service, kind: g.kind, id: g.item_id }))));
            const pending = [];
            for (const t of transfers) pending.push(transferView(t, await ownerOf(t.from_subject), details.get(keyOf({ service: t.service, kind: t.kind, id: t.item_id }))));
            res.set('Cache-Control', 'private, no-store');
            res.json({ ok: true, items, transfers: pending, count: items.length });
        } catch (err) {
            console.error('[Sharing] GET /shared-with-me error:', err.message);
            res.status(500).json({ ok: false, error: 'Could not read the shared list' });
        }
    });

    // The people this person has shared with: the share picker's suggestions, from their own history.
    router.get('/share/suggestions', ctx.requireAuth, async (req, res) => {
        try {
            const people = await store.listSuggestions(ctx.db, req.user.subject_id);
            res.set('Cache-Control', 'private, no-store');
            res.json({ ok: true, people, count: people.length });
        } catch (err) {
            console.error('[Sharing] GET /share/suggestions error:', err.message);
            res.status(500).json({ ok: false, error: 'Could not read the suggestions' });
        }
    });

    // One @name check for the share picker, with a per-person budget: nobody may walk the network's
    // accounts by typing names one after another.
    router.get('/share/name-check', ctx.requireAuth, async (req, res) => {
        try {
            const name = String(req.query.name || '').trim().replace(/^@/, '');
            if (!NAME_RE.test(name)) return http.sendProblem(res, 400, 'share.invalid_name', { detail: 'an OpenVibe name is 1 to 40 letters, numbers, dots, dashes or underscores' });
            const since = new Date(Date.now() - NAME_CHECK_WINDOW_MS).toISOString();
            const used = await store.countNameChecks(ctx.db, req.user.id, since);
            if (used >= NAME_CHECK_LIMIT) {
                res.set('Retry-After', String(Math.ceil(NAME_CHECK_WINDOW_MS / 1000)));
                return http.sendProblem(res, 429, 'share.too_many_checks', { detail: 'too many name checks; wait a minute and try again' });
            }
            await store.recordNameCheck(ctx.db, req.user.id, name);
            const person = await resolveUsername(ctx.db, name);
            res.set('Cache-Control', 'private, no-store');
            res.json({
                ok: true,
                name,
                exists: Boolean(person),
                subject: person ? person.subject.id : null,
                username: person ? person.username : null,
                display_name: person ? person.display_name : null,
                avatar_url: person ? person.avatar_url : null,
            });
        } catch (err) {
            console.error('[Sharing] GET /share/name-check error:', err.message);
            res.status(500).json({ ok: false, error: 'Could not check the name' });
        }
    });

    return router;
}

module.exports = { createSharingApi, describeItems, itemView, transferView, answerUrl, NAME_CHECK_LIMIT, NAME_CHECK_WINDOW_MS, MAX_DETAILS };
