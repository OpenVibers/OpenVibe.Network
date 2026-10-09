'use strict';
// ═══════════════════════════════════════════════════════════════
// Public profiles (plan T21 step 3): one page per person on the Network, and the same data as JSON for every site.
//
//   GET /@:username                    HTML: picture, name, bio, member since, what they wear, the items they own
//   GET /api/v1/profiles/:username     JSON, public and CORS-open (server/public-cors.js): profile@1 below
//
// Items come from OpenVibe.Inventory's public reads (GET /api/v1/kinds, /people/:subject/items and /equipped) with the
// Network's own service token (svc:network, audience openvibe.inventory), kept 60 s per person, so a busy profile costs
// Inventory one read a minute. Inventory down: the profile still answers, with its items marked unavailable.
//
// Who has one: a real account (not anonymous, banned, merged into another or deleted); anyone else is a 404. An old
// username answers 301 to the current one. A person can hide theirs (users.profile_public = 0, the account hub's Edit
// Profile card): the page then shows only their name and picture, is not indexed, and the JSON says private: true.
// ═══════════════════════════════════════════════════════════════
const express = require('express');
const seo = require('openvibe-shared/seo');
const cache = require('openvibe-shared/cache-policy');
const usernames = require('../identity/usernames');

const esc = seo.esc;
const SITE = 'https://openvibe.network';
const INVENTORY_SITE = 'https://inventory.openvibe.network';
const AUDIENCE = 'openvibe.inventory';
const ITEMS_TTL_MS = 60_000;
const KINDS_TTL_MS = 10 * 60_000;
const TIMEOUT_MS = 4000;
const MAX_ITEMS = 400;   // two pages of Inventory's 200; the rest is one link away on OpenVibe.Inventory
const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const RARITY = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
const RARITY_LABEL = { common: 'Common', uncommon: 'Uncommon', rare: 'Rare', epic: 'Epic', legendary: 'Legendary' };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const profileUrl = (username) => `${SITE}/@${encodeURIComponent(username)}`;
const avatarUrl = (username, size = 160) => `${SITE}/avatar/${encodeURIComponent(username)}?s=${size}`;
const itemUrl = (definitionId) => `${INVENTORY_SITE}/items/${encodeURIComponent(definitionId)}`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const rarityRank = (r) => Math.max(0, RARITY.indexOf(r));

/** 'YYYY-MM-DD …' → 'October 2026' (null when the date is unusable). */
function monthOf(ts) {
    const m = /^(\d{4})-(\d{2})/.exec(String(ts || ''));
    return m && MONTHS[Number(m[2]) - 1] ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : null;
}

function createPublicProfiles({ db, selfToken = () => null, inventoryUrl = 'http://127.0.0.1:5030', fetchImpl = (...a) => fetch(...a), now = () => Date.now(), log = console } = {}) {
    const base = String(inventoryUrl).replace(/\/+$/, '');
    const itemsCache = new Map();   // subject → { at, value }
    let kindsHit = null;
    let lastWarn = '';

    async function inventoryGet(path) {
        const token = selfToken(AUDIENCE, ['inventory.item.read']);
        const r = await fetchImpl(`${base}/api/v1${path}`, {
            headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!r.ok) throw new Error(`answered ${r.status}`);
        return await r.json();
    }

    async function kinds() {
        if (kindsHit && now() - kindsHit.at < KINDS_TTL_MS) return kindsHit.value;
        const out = await inventoryGet('/kinds');
        const value = new Map((out.kinds || []).map((k) => [k.id, k]));
        kindsHit = { at: now(), value };
        return value;
    }

    /** A person's items and what they wear, or { unavailable: true } while Inventory cannot answer. */
    async function itemsOf(subject) {
        if (!SUBJECT_RE.test(String(subject || ''))) return { items: [], showcase: [], total: 0, more: false };
        const hit = itemsCache.get(subject);
        if (hit && now() - hit.at < ITEMS_TTL_MS) return hit.value;
        let value;
        try {
            const [kindMap, worn] = await Promise.all([kinds(), inventoryGet(`/people/${subject}/equipped`)]);
            const instances = [];
            const definitions = {};
            let cursor = null;
            let more = false;
            do {
                const page = await inventoryGet(`/people/${subject}/items?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
                instances.push(...(page.instances || []));
                Object.assign(definitions, page.definitions || {});
                cursor = page.next_cursor || null;
                more = !!cursor && instances.length >= MAX_ITEMS;
            } while (cursor && instances.length < MAX_ITEMS);
            const kindOf = (id) => kindMap.get(id) || { id, name: id };
            const items = instances.filter((i) => definitions[i.definition_id]).map((i) => {
                const d = definitions[i.definition_id];
                return { instance_id: i.id, definition_id: d.id, name: d.name, rarity: RARITY_LABEL[d.rarity] ? d.rarity : 'common', kind: d.kind, kind_name: kindOf(d.kind).name, art: d.art || {}, acquired_at: i.acquired_at || null, url: itemUrl(d.id) };
            });
            const byInstance = new Map(items.map((i) => [i.instance_id, i]));
            const showcase = [];
            for (const [key, slot] of Object.entries((worn && worn.slots) || {})) {
                const item = byInstance.get(slot.instance_id);
                if (item) showcase.push({ slot: key.split(':')[1] || key, ...item });
            }
            const order = [...kindMap.keys()];
            showcase.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.name.localeCompare(b.name));
            value = { items, showcase, total: items.length, more };
            lastWarn = '';
        } catch (err) {
            const m = `OpenVibe.Inventory: ${err.message}`;
            if (m !== lastWarn) { lastWarn = m; log.warn(`[Profiles] ${m}`); }
            return { items: [], showcase: [], total: 0, more: false, unavailable: true };
        }
        itemsCache.set(subject, { at: now(), value });
        if (itemsCache.size > 2000) itemsCache.delete(itemsCache.keys().next().value);
        return value;
    }

    /** → { moved: current } | { user } | null */
    async function find(name) {
        const rec = await usernames.lookup(db, name);
        if (!rec) return null;
        if (rec.renamed) return { moved: rec.current };
        const u = await db.prepare(`SELECT id, username, display_name, bio, profile_color, created_at, subject_id, profile_public,
            is_anon, merged_into, deleted_at FROM users WHERE id = ?`).get(rec.network_id);
        if (!u || Number(u.is_anon) || u.merged_into || u.deleted_at) return null;
        return { user: u };
    }

    /** profile@1: what every site may show about a person. */
    async function profileOf(u) {
        const out = {
            username: u.username,
            display_name: u.display_name || u.username,
            avatar_url: avatarUrl(u.username),
            profile_url: profileUrl(u.username),
            private: !Number(u.profile_public),
        };
        if (out.private) return out;
        const inv = await itemsOf(u.subject_id);
        const counts = new Map();
        for (const i of inv.items) counts.set(i.kind, { kind: i.kind, name: i.kind_name, count: ((counts.get(i.kind) || {}).count || 0) + 1 });
        return Object.assign(out, {
            bio: String(u.bio || '').slice(0, 500),
            color: COLOR_RE.test(String(u.profile_color || '')) ? u.profile_color : null,
            member_since: String(u.created_at || '').slice(0, 10) || null,
            showcase: inv.showcase.map((i) => ({ slot: i.slot, kind: i.kind, kind_name: i.kind_name, definition_id: i.definition_id, name: i.name, rarity: i.rarity, art: i.art, url: i.url })),
            items: { count: inv.total, more: inv.more, by_kind: [...counts.values()], unavailable: !!inv.unavailable },
            inventory_url: SUBJECT_RE.test(String(u.subject_id || '')) ? `${INVENTORY_SITE}/u/${u.subject_id}` : null,
        });
    }

    /** GET /@:username (server/index.js mounts it with its own rate limit). */
    async function pageHandler(req, res, next) {
        try {
            const found = await find(req.params.username);
            if (!found) return next();   // the shared 404 page
            if (found.moved) return res.redirect(301, `/@${encodeURIComponent(found.moved)}`);
            const u = found.user;
            const inv = Number(u.profile_public) ? await itemsOf(u.subject_id) : null;
            res.set('Content-Type', 'text/html; charset=utf-8');
            res.set('Cache-Control', cache.htmlHeaders({ maxAge: 60 }));
            res.send(renderPage(u, inv));
        } catch (err) { next(err); }
    }

    const api = express.Router();
    api.get('/:username', async (req, res, next) => {
        try {
            const found = await find(req.params.username);
            res.set('Cache-Control', 'public, max-age=60');
            if (!found) return res.status(404).json({ error: 'not_found' });
            if (found.moved) return res.status(301).set('Location', `/api/v1/profiles/${encodeURIComponent(found.moved)}`).json({ moved_to: found.moved });
            res.json({ profile: await profileOf(found.user) });
        } catch (err) { next(err); }
    });

    return { pageHandler, api, find, profileOf, itemsOf };
}

// ── The page ───────────────────────────────────────────────────

/** The item's picture: a Media image, or its emoji, on a square tinted by rarity. */
function art(i, size = 'md') {
    const a = i.art || {};
    if (a.media_id && /^[A-Za-z0-9_-]{1,80}$/.test(String(a.media_id))) {
        return `<span class="pf-art pf-art-${size} r-${i.rarity}"><img src="https://openvibe.media/o/${esc(a.media_id)}" alt="" loading="lazy" width="64" height="64"></span>`;
    }
    return `<span class="pf-art pf-art-${size} r-${i.rarity}" aria-hidden="true">${esc(String(a.emoji || '◆').slice(0, 8))}</span>`;
}
const rarityBadge = (r) => `<span class="pf-rarity r-${esc(r)}">${esc(RARITY_LABEL[r] || r)}</span>`;

function showcaseHtml(inv, name) {
    if (!inv.showcase.length) return '';
    return `<section class="pf-section" aria-labelledby="pf-wearing"><h2 id="pf-wearing">Wearing</h2>
<ul class="pf-showcase">${inv.showcase.map((i) => `<li class="pf-worn r-${esc(i.rarity)}"><a href="${esc(i.url)}">${art(i, 'lg')}<span class="pf-worn-body"><span class="pf-kind">${esc(i.kind_name)}</span><span class="pf-name">${esc(i.name)}</span>${rarityBadge(i.rarity)}</span></a></li>`).join('')}</ul>
<p class="pf-note">What ${esc(name)} shows in chat, on stream overlays and here.</p></section>`;
}

function itemsHtml(inv, u) {
    const name = esc(u.display_name || u.username);
    if (inv.unavailable) return `<section class="pf-section" aria-labelledby="pf-items"><h2 id="pf-items">Items</h2><p class="pf-empty">The items could not be loaded just now. They are safe on <a href="${INVENTORY_SITE}/">OpenVibe.Inventory</a>; try again in a minute.</p></section>`;
    if (!inv.items.length) return `<section class="pf-section" aria-labelledby="pf-items"><h2 id="pf-items">Items</h2><p class="pf-empty">${name} has no items yet. Items come from streaming, chatting and playing on OpenVibe sites. <a href="${INVENTORY_SITE}/items">See what there is</a>.</p></section>`;
    const groups = new Map();
    for (const i of inv.items) {
        if (!groups.has(i.kind)) groups.set(i.kind, { name: i.kind_name, list: [] });
        groups.get(i.kind).list.push(i);
    }
    const worn = new Set(inv.showcase.map((i) => i.instance_id));
    const sorted = [...groups.values()].sort((a, b) => b.list.length - a.list.length || a.name.localeCompare(b.name));
    const all = SUBJECT_RE.test(String(u.subject_id || '')) ? `${INVENTORY_SITE}/u/${u.subject_id}` : `${INVENTORY_SITE}/`;
    return `<section class="pf-section" aria-labelledby="pf-items"><h2 id="pf-items">Items <span class="pf-count">${inv.more ? `${inv.total}+` : inv.total}</span></h2>
${sorted.map((g) => {
        g.list.sort((a, b) => rarityRank(b.rarity) - rarityRank(a.rarity) || a.name.localeCompare(b.name));
        return `<h3 class="pf-kind-head">${esc(g.name)} <span class="pf-count">${g.list.length}</span></h3>
<ul class="pf-grid">${g.list.map((i) => `<li class="pf-card r-${esc(i.rarity)}${worn.has(i.instance_id) ? ' is-worn' : ''}"><a href="${esc(i.url)}" title="${esc(`${i.name} · ${RARITY_LABEL[i.rarity]}`)}">${art(i)}<span class="pf-card-name">${esc(i.name)}</span>${rarityBadge(i.rarity)}${worn.has(i.instance_id) ? '<span class="pf-worn-tag">Worn</span>' : ''}</a></li>`).join('')}</ul>`;
    }).join('\n')}
<p class="pf-note"><a href="${esc(all)}">${inv.more ? 'Every item' : 'This inventory'} on OpenVibe.Inventory</a> · <a href="${INVENTORY_SITE}/items">Every item there is</a></p></section>`;
}

function renderPage(u, inv) {
    const name = u.display_name || u.username;
    const isPublic = !!inv;
    const color = COLOR_RE.test(String(u.profile_color || '')) ? u.profile_color : '#3b82f6';
    const since = monthOf(u.created_at);
    const bio = isPublic ? String(u.bio || '').trim().slice(0, 500) : '';
    const title = `${name} (@${u.username}) · OpenVibe`;
    const description = !isPublic
        ? `${name} on OpenVibe. This profile is private.`
        : (bio ? bio.slice(0, 155) : `${name}'s profile on OpenVibe${inv.total ? `: ${plural(inv.total, 'item', 'items')}` : ''}${inv.showcase.length ? `, wearing ${inv.showcase.slice(0, 3).map((i) => i.name).join(', ')}` : ''}.`);
    const stats = isPublic ? [
        since ? `<li><span class="pf-stat-k">Member since</span><span class="pf-stat-v">${esc(since)}</span></li>` : '',
        inv.unavailable ? '' : `<li><span class="pf-stat-k">Items</span><span class="pf-stat-v">${inv.more ? `${inv.total}+` : inv.total}</span></li>`,
        inv.items.length ? `<li><span class="pf-stat-k">Rarest</span><span class="pf-stat-v">${esc(RARITY_LABEL[inv.items.reduce((best, i) => (rarityRank(i.rarity) > rarityRank(best) ? i.rarity : best), 'common')])}</span></li>` : '',
    ].join('') : '';
    const ld = isPublic ? seo.jsonLdTag({
        '@context': 'https://schema.org', '@type': 'ProfilePage', url: profileUrl(u.username), name: title,
        ...(String(u.created_at || '').length >= 10 ? { dateCreated: String(u.created_at).slice(0, 10) } : {}),
        mainEntity: { '@type': 'Person', name, alternateName: `@${u.username}`, image: avatarUrl(u.username, 256), url: profileUrl(u.username), ...(bio ? { description: bio } : {}) },
    }) : '';
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(profileUrl(u.username))}">
${isPublic ? '' : '<meta name="robots" content="noindex">'}
<meta property="og:type" content="profile">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(profileUrl(u.username))}">
<meta property="og:image" content="${esc(avatarUrl(u.username, 256))}">
<meta property="profile:username" content="${esc(u.username)}">
<link rel="alternate" type="application/json" href="/api/v1/profiles/${esc(encodeURIComponent(u.username))}">
${require('openvibe-shared/app-icon').headTags({ site: 'network', iconBase: '/assets' })}
<meta name="color-scheme" content="dark light">
<script src="/shared/theme-loader.js" defer></script>
${ld}
<style>
*,*::before,*::after{box-sizing:border-box}
:root{--bg-primary:#0a0f1c;--bg-secondary:#101828;--bg-card:#0f172a;--border:#1f2d47;--accent:#3b82f6;--text-primary:#e6edf7;--text-secondary:#96a7c2;--text-muted:#7386a3;
--r-common:#94a3b8;--r-uncommon:#22c55e;--r-rare:#3b82f6;--r-epic:#a855f7;--r-legendary:#f59e0b}
html,body{margin:0;background:var(--bg-primary);color:var(--text-primary);font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
a{color:var(--accent)}
.pf{max-width:1040px;margin:0 auto;padding:20px 16px 48px}
.pf-hero{position:relative;border:1px solid var(--border);border-radius:18px;overflow:hidden;background:var(--bg-secondary)}
.pf-banner{height:96px;background:linear-gradient(120deg,color-mix(in srgb,var(--pf-color) 70%,transparent),color-mix(in srgb,var(--pf-color) 18%,transparent) 60%,transparent),var(--bg-card)}
.pf-head{display:flex;gap:20px;align-items:flex-end;padding:0 24px 20px;margin-top:-52px;flex-wrap:wrap}
.pf-avatar{width:112px;height:112px;border-radius:50%;object-fit:cover;border:4px solid var(--bg-secondary);box-shadow:0 0 0 2px var(--pf-color);background:var(--bg-card);flex:none}
.pf-who{flex:1;min-width:200px;padding-top:56px}
.pf-who h1{margin:0;font-size:clamp(1.5rem,4vw,2.1rem);line-height:1.15;overflow-wrap:anywhere}
.pf-handle{margin:.2em 0 0;color:var(--text-secondary)}
.pf-bio{margin:0;padding:0 24px 18px;color:var(--text-primary);line-height:1.6;white-space:pre-line;overflow-wrap:anywhere;max-width:72ch}
.pf-stats{list-style:none;display:flex;flex-wrap:wrap;gap:8px;margin:0;padding:0 24px 22px}
.pf-stats li{display:flex;flex-direction:column;gap:2px;padding:8px 14px;border:1px solid var(--border);border-radius:12px;background:var(--bg-card);min-width:110px}
.pf-stat-k{font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;color:var(--text-muted)}
.pf-stat-v{font-weight:700}
.pf-private{margin:0;padding:0 24px 24px;color:var(--text-secondary)}
.pf-section{margin-top:28px}
.pf-section h2{font-size:1.15rem;margin:0 0 12px;display:flex;align-items:center;gap:8px}
.pf-kind-head{font-size:.85rem;text-transform:uppercase;letter-spacing:.06em;color:var(--text-secondary);margin:20px 0 10px;display:flex;align-items:center;gap:8px}
.pf-count{font-size:.75rem;font-weight:700;padding:.1rem .5rem;border-radius:999px;background:color-mix(in srgb,var(--accent) 16%,transparent);color:var(--text-primary);letter-spacing:0;text-transform:none}
.pf-showcase{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}
.pf-worn a{display:flex;gap:14px;align-items:center;padding:14px;border-radius:14px;text-decoration:none;color:inherit;border:1px solid color-mix(in srgb,var(--rc) 45%,var(--border));background:linear-gradient(135deg,color-mix(in srgb,var(--rc) 14%,var(--bg-secondary)),var(--bg-secondary))}
.pf-worn a:hover,.pf-worn a:focus-visible{border-color:var(--rc)}
.pf-worn-body{display:flex;flex-direction:column;gap:3px;min-width:0}
.pf-kind{font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;color:var(--text-muted)}
.pf-name{font-weight:700;overflow-wrap:anywhere}
.pf-grid{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(132px,1fr));gap:10px}
.pf-card a{position:relative;display:flex;flex-direction:column;align-items:center;gap:6px;padding:12px 10px;border-radius:12px;border:1px solid var(--border);border-bottom:3px solid var(--rc);background:var(--bg-secondary);text-decoration:none;color:inherit;text-align:center;height:100%}
.pf-card a:hover,.pf-card a:focus-visible{border-color:var(--rc);background:color-mix(in srgb,var(--rc) 8%,var(--bg-secondary))}
.pf-card-name{font-size:.85rem;font-weight:600;overflow-wrap:anywhere}
.pf-worn-tag{position:absolute;top:6px;right:6px;font-size:.62rem;font-weight:700;padding:.05rem .4rem;border-radius:999px;background:var(--accent);color:var(--on-accent,#fff)}
.pf-art{display:inline-flex;align-items:center;justify-content:center;border-radius:12px;background:radial-gradient(circle at 50% 35%,color-mix(in srgb,var(--rc) 30%,transparent),color-mix(in srgb,var(--rc) 8%,var(--bg-card)));flex:none;overflow:hidden}
.pf-art-md{width:56px;height:56px;font-size:28px}.pf-art-lg{width:68px;height:68px;font-size:34px}
.pf-art img{width:100%;height:100%;object-fit:cover}
.pf-rarity{font-size:.68rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:color-mix(in srgb,var(--rc) 70%,var(--text-primary))}
.r-common{--rc:var(--r-common)}.r-uncommon{--rc:var(--r-uncommon)}.r-rare{--rc:var(--r-rare)}.r-epic{--rc:var(--r-epic)}.r-legendary{--rc:var(--r-legendary)}
.pf-empty{color:var(--text-secondary);padding:18px;border:1px dashed var(--border);border-radius:12px;margin:0}
.pf-note{color:var(--text-secondary);font-size:.85rem;margin:12px 0 0}
@media (max-width:560px){.pf-head{padding:0 16px 16px;gap:14px}.pf-avatar{width:92px;height:92px}.pf-who{padding-top:0;min-width:100%}.pf-bio,.pf-stats,.pf-private{padding-left:16px;padding-right:16px}.pf-grid{grid-template-columns:repeat(auto-fill,minmax(112px,1fr))}}
</style>
</head>
<body>
<div id="navbar-mount"></div>
${require('openvibe-shared/frame').noscriptNav({ name: 'OpenVibe.Network', links: [{ label: 'Sign in', href: '/login' }, { label: 'Inventory', href: `${INVENTORY_SITE}/` }] })}
<main class="pf" id="main" style="--pf-color:${esc(color)}">
<section class="pf-hero" aria-label="Profile">
<div class="pf-banner" aria-hidden="true"></div>
<div class="pf-head">
<img class="pf-avatar" src="${esc(avatarUrl(u.username))}" alt="" width="112" height="112">
<div class="pf-who"><h1>${esc(name)}</h1><p class="pf-handle">@${esc(u.username)}</p></div>
</div>
${bio ? `<p class="pf-bio">${esc(bio)}</p>` : ''}
${isPublic ? `<ul class="pf-stats">${stats}</ul>` : '<p class="pf-private">This profile is private.</p>'}
</section>
${isPublic ? showcaseHtml(inv, name) + itemsHtml(inv, u) : ''}
</main>
${require('openvibe-shared/footer').ssr({ service: 'network', variant: 'compact' })}
<script src="/shared/navbar.js" defer></script>
<script>document.addEventListener('DOMContentLoaded',function(){try{if(window.OpenVibeNavbar)OpenVibeNavbar.init({service:'network',apiBase:location.origin});}catch(e){}});</script>
</body>
</html>`;
}

module.exports = { createPublicProfiles, renderPage, monthOf, SUBJECT_RE };
