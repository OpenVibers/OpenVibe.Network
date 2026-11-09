'use strict';

/**
 * "Try next" for a signed-in person on /my (plan L43, 2026-11-09): the sites people with similar use open, not a
 * hand-picked list. The person's own top sites come from their own Network history, in their own request; the
 * similar-use part is Report's aggregate co-usage answer, which only reads people who chose to publish their site
 * list and never carries a person, a username or a subject. A site the person already uses is never suggested.
 *
 * When Report has no co-usage (or too small a sample to be honest), the answer falls back to Report's public popular
 * sites, still excluding what the person uses; when Report does not answer at all, it is the fixed starter list.
 * The answer says which it is: { source, basis, generated_at, items: [...] }.
 */
const { SITES, fullName } = require('../frame/sites');

const DAY = 86_400_000;
const OPEN = SITES.filter((site) => site.status === 'open' && site.id !== 'network');
const BY_SERVICE = new Map();
for (const site of OPEN) { BY_SERVICE.set(site.service, site); BY_SERVICE.set(site.id, site); }
// History's host-derived service name for a product whose site has another id.
for (const alias of [['video', 'media-hub'], ['pastes', 'community'], ['openre', 'stream'], ['my', 'network']]) {
    const site = OPEN.find((s) => s.id === alias[1]);
    if (site) BY_SERVICE.set(alias[0], site);
}
const siteOf = (service) => BY_SERVICE.get(String(service || '').toLowerCase()) || null;

function itemOf(site, reason, extra = {}) {
    return {
        id: site.id, kind: 'site', name: fullName(site), url: `https://${site.host}/`, icon: site.icon,
        reason, ...extra,
    };
}

function createTryNext({ db = null, popularity = null, now = () => Date.now(), limit = 3 } = {}) {
    const clock = typeof now === 'function' ? now : () => Date.now();

    async function forPerson({ userId, limit: asked = limit } = {}) {
        const max = Math.min(10, Math.max(1, parseInt(asked, 10) || limit));
        const at = clock();
        const generatedAt = new Date(at).toISOString();
        const since = (days) => new Date(at - days * DAY).toISOString().slice(0, 19).replace('T', ' ');

        let usedSiteIds = new Set(['network']);
        let topSites = [];
        if (db && userId != null) {
            try {
                const [topRows, usedRows] = await Promise.all([
                    db.prepare(`SELECT service, COUNT(*) AS n FROM user_history
                        WHERE user_id = ? AND service IS NOT NULL AND created_at >= ?
                        GROUP BY service ORDER BY n DESC, service LIMIT 12`).all(userId, since(30)),
                    db.prepare('SELECT DISTINCT service FROM user_history WHERE user_id = ? AND service IS NOT NULL').all(userId),
                ]);
                for (const row of Array.isArray(usedRows) ? usedRows : []) {
                    const site = siteOf(row.service);
                    if (site) usedSiteIds.add(site.id);
                }
                const seen = new Set();
                topSites = [];
                for (const row of Array.isArray(topRows) ? topRows : []) {
                    const site = siteOf(row.service);
                    if (!site || site.id === 'network' || seen.has(site.id)) continue;
                    seen.add(site.id);
                    topSites.push(site);
                    if (topSites.length === 3) break;
                }
            } catch { usedSiteIds = new Set(['network']); topSites = []; }
        }

        // The aggregate co-usage answer: for each pair, the other site is a candidate when one side is one of the
        // person's top sites and the other is not already theirs. `via` remembers which top site it came through.
        const via = new Map();
        if (popularity && topSites.length) {
            let co = null;
            try { co = await popularity.coUsage(); } catch { co = null; }
            const topIds = new Set(topSites.map((site) => site.id));
            for (const pair of (co && Array.isArray(co.pairs) ? co.pairs : [])) {
                const aSite = siteOf(pair.a);
                const bSite = siteOf(pair.b);
                if (!aSite || !bSite) continue;
                for (const [from, to] of [[aSite, bSite], [bSite, aSite]]) {
                    if (!topIds.has(from.id) || topIds.has(to.id) || usedSiteIds.has(to.id) || to.id === 'network') continue;
                    const prev = via.get(to.id);
                    if (!prev || pair.people > prev.people) via.set(to.id, { site: to, from, people: pair.people });
                }
            }
        }

        let items = [];
        let source = 'fallback';
        let basis = 'starter';
        if (via.size) {
            items = [...via.values()]
                .sort((x, y) => y.people - x.people || x.site.id.localeCompare(y.site.id))
                .slice(0, max)
                .map(({ site, from, people }) => itemOf(site, `People who use ${fullName(from)} also use this`, { score: people }));
            source = 'report';
            basis = 'co-usage';
        }

        // No co-usage sample: Report's public popular sites, still without anything the person already uses.
        if (!items.length && popularity) {
            let publicView = null;
            try { publicView = popularity.peek(); } catch { publicView = null; }
            const pool = (publicView && Array.isArray(publicView.items) ? publicView.items : [])
                .filter((item) => item && item.kind === 'site' && !usedSiteIds.has(item.id));
            if (pool.length) {
                items = pool.slice(0, max).map((item) => ({
                    id: item.id, kind: 'site', name: item.name, url: item.url, icon: item.icon,
                    reason: 'Popular on OpenVibe', ...(item.score != null ? { score: item.score } : {}),
                }));
                source = publicView.source === 'report' ? 'report' : 'fallback';
                basis = publicView.source === 'report' ? 'popular' : 'starter';
            }
        }

        // Report never answered: the same fixed floor the signed-out list uses, without what the person already uses.
        if (!items.length && popularity && Array.isArray(popularity.fallback)) {
            items = popularity.fallback
                .filter((item) => item && item.kind === 'site' && !usedSiteIds.has(item.id))
                .slice(0, max)
                .map((item) => ({ id: item.id, kind: 'site', name: item.name, url: item.url, icon: item.icon, reason: 'A place to start' }));
            source = 'fallback';
            basis = 'starter';
        }

        return { source, basis, generated_at: generatedAt, items: items.slice(0, max) };
    }

    return { forPerson };
}

module.exports = { createTryNext, siteOf, OPEN };
