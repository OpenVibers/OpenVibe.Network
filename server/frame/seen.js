'use strict';
/**
 * Who was on the network in the last thirty minutes, held in memory and nowhere else.
 *
 * Two signals fill it, both of them calls that already exist:
 *
 *   - a signed-in person's presence heartbeat (server/presence/index.js, POST /api/v1/me/presence/heartbeat):
 *     the subject and the site the tab runs on (the request's Origin). The row already says whether the
 *     person lets others see them online; this store keeps only "seen", never a status.
 *   - a page view's anonymous beacon (POST /api/frame/hit, openvibe-shared navbar.js): a guest is one
 *     distinct visitor, counted by a keyed hash of the address and the browser's user agent. The key is
 *     random and changes at UTC midnight, the hash lives only in this process's memory and for thirty
 *     minutes, and neither the address nor the hash is ever written to a database, a log or a response:
 *     the read returns a count. A beacon that says the browser is signed in (`?in=1`) is not a guest, and
 *     it forgets any guest entry the same browser left earlier in the window.
 *
 * Bots and monitors are left out by the same user-agent rule the page-view count already uses. Sizes are
 * capped so a flood cannot grow the process: the oldest entries go first.
 */
const crypto = require('crypto');

const WINDOW_MS = 30 * 60 * 1000;
const MAX_MEMBERS = 20_000;
const MAX_GUESTS = 50_000;
const BOT = /bot|crawl|spider|slurp|headless|preview|monitor|curl|wget|python|node|go-http/i;

let day = '';
let dayKey = null;
const members = new Map();   // subject id → { at: ms, site: site id | null }
const guests = new Map();    // keyed hash → last seen ms
// The UTC day's distinct people (the Report card's "people today", 11-14): signed-in ids and today's guest hashes,
// both gone at midnight with the day's key. Past the cap a newcomer still counts, it just is not remembered.
const MAX_DAY = 200000;
const dayMembers = new Set();
const dayGuests = new Set();
let dayOver = { members: 0, guests: 0 };

/** A new key at UTC midnight: yesterday's hashes cannot be recomputed from today's, so the guest entries
 *  they named go with it (the count starts again rather than mixing two days under one read). */
function rotate(now) {
    const d = new Date(now).toISOString().slice(0, 10);
    if (d !== day) {
        day = d;
        dayKey = crypto.randomBytes(32);
        guests.clear();
        dayMembers.clear();
        dayGuests.clear();
        dayOver = { members: 0, guests: 0 };
    }
}

function isBot(ua) {
    return BOT.test(String(ua || ''));
}

/** The keyed hash of an address and a user agent. Never stored outside this module's maps. */
function guestKey(ip, ua, now = Date.now()) {
    rotate(now);
    return crypto.createHmac('sha256', dayKey).update(`${String(ip || '')}\n${String(ua || '')}`).digest('base64url');
}

/** Drop everything older than the window, then the oldest entries while over a cap. */
function prune(now = Date.now()) {
    const cut = now - WINDOW_MS;
    for (const [k, e] of members) if (e.at < cut) members.delete(k);
    for (const [k, at] of guests) if (at < cut) guests.delete(k);
    if (members.size > MAX_MEMBERS) {
        const keep = [...members.entries()].sort((a, b) => b[1].at - a[1].at).slice(0, MAX_MEMBERS);
        members.clear();
        for (const [k, e] of keep) members.set(k, e);
    }
    if (guests.size > MAX_GUESTS) {
        const keep = [...guests.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_GUESTS);
        guests.clear();
        for (const [k, at] of keep) guests.set(k, at);
    }
}

/** A signed-in person was seen on `site` (a Frame site id, or null when the Origin is not one of ours). */
function seenMember(subject, site = null, now = Date.now()) {
    const id = String(subject || '');
    if (!id || !/^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) return false;
    rotate(now);
    members.set(id, { at: now, site: site ? String(site) : null });
    if (!dayMembers.has(id)) { if (dayMembers.size < MAX_DAY) dayMembers.add(id); else dayOver.members++; }
    if (members.size > MAX_MEMBERS) prune(now);
    return true;
}

/** A guest page view: one entry per distinct address + user agent in the window. */
function seenGuest(ip, ua, now = Date.now()) {
    if (isBot(ua)) return false;
    const k = guestKey(ip, ua, now);
    guests.set(k, now);
    if (!dayGuests.has(k)) { if (dayGuests.size < MAX_DAY) dayGuests.add(k); else dayOver.guests++; }
    if (guests.size > MAX_GUESTS) prune(now);
    return true;
}

/** The Frame site a request's Origin belongs to (the site's tab), or null. */
function siteOfOrigin(origin) {
    try {
        const host = new URL(String(origin || '')).hostname.toLowerCase();
        const site = require('./sites').siteForHost(host);
        return site ? site.id : null;
    } catch { return null; }
}

/** A signed-in beacon: this browser is not a guest, and any guest entry it left is forgotten. */
function forgetGuest(ip, ua, now = Date.now()) {
    const k = guestKey(ip, ua, now);
    guests.delete(k);
    dayGuests.delete(k);   // the same browser, signed in: counted once, as a member
}

/** The UTC day's distinct people so far: { day, members, guests } (counts only). */
function today(now = Date.now()) {
    rotate(now);
    return { day, members: dayMembers.size + dayOver.members, guests: dayGuests.size + dayOver.guests };
}

/** What the read sees: the members seen (with their last site) and how many distinct guests. */
function snapshot(now = Date.now()) {
    prune(now);
    const out = new Map();
    for (const [subject, e] of members) if (e.at >= now - WINDOW_MS) out.set(subject, { at: e.at, site: e.site });
    return { members: out, guests: guests.size, at: now };
}

/** Tests and diagnostics: the sizes only, never a hash or an address. */
function state() {
    return { members: members.size, guests: guests.size, day };
}

/** Tests: start from an empty store. */
function reset() {
    members.clear();
    guests.clear();
    dayMembers.clear();
    dayGuests.clear();
    dayOver = { members: 0, guests: 0 };
    day = '';
    dayKey = null;
}

module.exports = { WINDOW_MS, MAX_MEMBERS, MAX_GUESTS, BOT, isBot, guestKey, seenMember, seenGuest, forgetGuest, siteOfOrigin, snapshot, today, state, reset };
