'use strict';

/**
 * A feed row as feed.item@1, and the page-level operations the feed API applies after reading it:
 * kind mapping, folding a run of the same kind, and the For you / Following ranking.
 *
 * The ranking is the owner's ask: live first, then what the person follows and opens, then
 * freshness and engagement, with anything older than seven days below the last week's items (the
 * same order Community's feed proved, 11-11). No field here is private: a row only reaches this
 * module after store.listItems() applied the visibility and test-account rules.
 */

const SITE_NAMES = {
    live: 'Live', 'media-hub': 'Video', media: 'Media', pics: 'Pics', video: 'Video', community: 'Community', blog: 'Blog',
    wiki: 'Wiki', quest: 'Quest', chat: 'Chat', tools: 'Tools', news: 'News', report: 'Report', today: 'Today',
    network: 'Network', space: 'Space', meme: 'Meme', games: 'Games', play: 'Games', work: 'Work', deals: 'Deals',
    rundown: 'Live', stream: 'Live', exchange: 'Exchange', blog2: 'Blog',
};

const clean = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
const https = (u) => {
    try { const x = new URL(String(u)); return x.protocol === 'https:' ? x.href : (x.protocol === 'http:' ? x.href : null); } catch { return null; }
};

/** The site a row comes from, as an origin: a relative address in its text or picture is on that site, not on the
 *  page that shows the card (the menu on openvibe.link showed Community's "/p/x" as a broken link and picture). */
const ORIGINS = { community: 'https://openvibe.community', 'media-hub': 'https://openvibe.video', rundown: 'https://openvibe.live', stream: 'https://openvibe.live' };
const originOf = (site) => ORIGINS[site] || (/^[a-z][a-z0-9-]{0,30}$/.test(String(site || '')) ? `https://openvibe.${site}` : null);
const absolute = (u, site) => {
    const s = String(u || '').trim();
    if (!s) return null;
    try { const x = new URL(s, originOf(site) || undefined); return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : null; } catch { return null; }
};
const MD_IMAGE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const MD_LINK = /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
/** Markdown a source left in a card's text, as plain words, and the first picture it named (11-12: the menu printed it). */
function plainText(text, site) {
    const raw = String(text == null ? '' : text);
    let image = null;
    const noImages = raw.replace(MD_IMAGE, (m, alt, src) => { if (!image) image = absolute(src, site); return ' '; });
    const words = noImages.replace(MD_LINK, '$1').replace(/(^|\n)[ \t]*(?:#{1,6}|>)[ \t]*/g, '$1').replace(/\*{1,3}|`+|~~/g, '');
    return { text: words, image };
}

/** What a source row is, as a feed kind. An unknown type is a post, never dropped silently. */
function kindOf(service, type, row = {}) {
    const s = String(service || '');
    const t = String(type || '');
    if (s === 'live') {
        if (/^(episode|rundown)$/.test(t)) return 'rundown';
        if (/^(recording|vod|video)$/.test(t)) return 'video';
        if (/^(clip|moment)$/.test(t)) return 'clip';
        if (/^(stream|went_live|broadcast|live)$/.test(t)) return 'live';
    }
    if (s === 'media-hub' || s === 'media') return /picture|image|photo/.test(t) ? 'pic' : 'video';
    if (s === 'pics') return 'pic';
    if (s === 'games' || s === 'play') return 'game';
    if (s === 'quest') return 'quest';
    if (s === 'chat') return 'chat';
    if (s === 'today') return 'event';
    if (s === 'community') {
        if (t === 'poll') return 'poll';
        if (t === 'thread' || t === 'status' || t === 'post' || t === 'submission') return 'post';
        if (t === 'paste') return row.picture_url || row.kind === 'pic' || row.media_ratio ? 'pic' : 'paste';
        return 'post';
    }
    if (s === 'blog') return 'update';
    if (s === 'wiki') return 'wiki';
    if (s === 'news') return 'news';
    if (s === 'space') return 'space';
    if (s === 'work') return 'work';
    if (s === 'deals') return 'deal';
    if (s === 'report') return 'report';
    if (s === 'meme') return 'meme';
    if (s === 'network') {
        if (/member|join/.test(t)) return 'member';
        if (t === 'avatar') return 'avatar';
        if (t === 'banner') return 'banner';
        if (t === 'follow') return 'follow';
        if (t === 'site') return 'site';
    }
    if (s === 'rundown') return 'rundown';
    if (s === 'stream') return 'stream';
    return 'post';
}

/** What a card knows about a deal, kept beside the card and never in it: feed.item@1 has no price of its
 *  own, so the price belongs to the group item that lists the deal (group.items[].price / was / store). */
const DEAL_FACTS = new WeakMap();

/** The price of an offer, as the group item states it: both halves, or nothing. */
function dealFacts(row) {
    const amount = Number(row.price_amount);
    const currency = String(row.price_currency || '').trim().toUpperCase();
    const price = Number.isFinite(amount) && amount >= 0 && /^[A-Z]{3}$/.test(currency) ? { amount, currency } : null;
    const was = Number(row.was_price);
    const store = clean(row.store_name, 60) || null;
    if (!price && !Number.isFinite(was) && !store) return null;
    return { price, was: Number.isFinite(was) && was >= 0 ? was : null, store };
}

/** One group item: what the card says, plus what the offer costs when the source stated it. */
function groupItem(card) {
    const item = { id: card.id, url: card.url, title: card.title, media: card.media };
    const facts = DEAL_FACTS.get(card);
    if (facts) {
        if (facts.price) item.price = facts.price;
        if (facts.was != null) item.was = facts.was;
        if (facts.store) item.store = facts.store;
    }
    return item;
}

/** One row as a card. `actor` is the resolved person { name, avatar, handle, level, fx } when the row names one. */
function cardOf(row, actor = null) {
    const counts = row.counts && typeof row.counts === 'object' ? row.counts : {};
    const safe = {};
    for (const k of ['views', 'likes', 'comments', 'watchers', 'people']) {
        const n = Number(counts[k]);
        if (Number.isSafeInteger(n) && n >= 0) safe[k] = n;
    }
    const ratio = Number(row.media_ratio);
    const length = Number(row.media_length);
    // Who did it (feed.item@1 1.1.0): the person the row names, with their username, their level
    // (null when they hide it from the leaderboard) and the name effect they wear. A row that names
    // only a person the feed does not know keeps that name alone.
    const handle = actor && /^[A-Za-z0-9_.-]{1,40}$/.test(String(actor.handle || '')) ? String(actor.handle) : null;
    const rawLevel = actor ? Number(actor.level) : NaN;
    // A person who hides their level sends null; a level outside the contract's range is left out.
    const level = !actor ? undefined
        : (actor.level === null ? null : (Number.isSafeInteger(rawLevel) && rawLevel >= 1 && rawLevel <= 1000 ? rawLevel : undefined));
    const fx = actor && /^name-fx-[a-z]{2,24}$/.test(String(actor.fx || '')) ? String(actor.fx) : null;
    const actorCard = actor
        ? {
            name: clean(actor.name, 80) || null,
            avatar: https(actor.avatar),
            ...(handle ? { handle } : {}),
            ...(level !== undefined ? { level } : {}),
            ...(fx ? { fx } : {}),
        }
        : (row.actor_name ? { name: clean(row.actor_name, 80) || null, avatar: null } : null);
    const card = {
        id: `f:${row.source_service}:${row.source_type}:${row.source_id}`,
        kind: row.kind,
        url: https(row.url) || String(row.url || ''),
        title: clean(row.title, 300),
        text: '',
        at: row.occurred_at ? new Date(row.occurred_at).toISOString() : null,
        site: String(row.site || row.source_service || ''),
        site_name: String(row.site_name || SITE_NAMES[row.site] || SITE_NAMES[row.source_service] || row.site || ''),
        actor: actorCard,
        subject: row.actor_subject || null,
        media: row.picture_url && https(row.picture_url)
            ? { thumb: https(row.picture_url), ...(row.preview_url && https(row.preview_url) ? { preview: https(row.preview_url) } : {}), ratio: Number.isFinite(ratio) && ratio > 0 ? ratio : 16 / 9, ...(Number.isFinite(length) && length > 0 ? { length } : {}) }
            : null,
        counts: safe,
    };
    // The words as words: Markdown out, relative addresses on the source's own site, and no text that only repeats
    // the title (a shared post's body is "[its title](its link)"). A shared post's picture becomes the card's picture.
    const plain = plainText(row.text, card.site);
    card.text = clean(plain.text, 280);
    if (card.text && card.text.toLowerCase() === card.title.toLowerCase()) card.text = '';
    if (!/^https?:/.test(card.url) && card.url) card.url = absolute(card.url, card.site) || card.url;
    if (!card.media && plain.image) card.media = { thumb: plain.image, ratio: Number.isFinite(ratio) && ratio > 0 ? ratio : 16 / 9 };
    // A Community paste's picture is served by Community (Media keeps it private to the paste): the small copy, never
    // Media's original address, which answers 404 to everyone else (the menu's broken picture, 11-12).
    if (row.source_service === 'community' && row.source_type === 'paste' && card.media && /^https:\/\/openvibe\.media\/o\//.test(card.media.thumb)) {
        card.media.thumb = `https://openvibe.community/p/${encodeURIComponent(String(row.source_id))}/screenshot?w=640`;
    }
    if (card.media && card.media.thumb && /^https:\/\/openvibe\.community\/p\/[^/]+\/screenshot$/.test(card.media.thumb)) card.media.thumb += '?w=640';
    if (row.starts_at) card.starts_at = new Date(row.starts_at).toISOString();
    if (row.label) card.label = row.label;
    // The menu labels AI output and system/aggregate rows; keep the old Pulse's promise that AI is never a person.
    if (!card.label && row.origin === 'ai') card.label = 'AI';
    else if (!card.label && row.origin === 'system' && !card.actor && !card.site_name) card.label = 'System';
    if (row.visibility === 'followers') card.visibility = 'followers';
    if (card.kind === 'live' || card.kind === 'stream') {
        card.live_now = row.kind === 'live' && row.live_now === true;
        if (!card.live_now) card.kind = 'stream';
        if (card.live_now) card.label = 'Live';
    }
    if (card.kind === 'report' && row.trend && typeof row.trend === 'object') {
        const direction = ['up', 'down', 'flat'].includes(row.trend.direction) ? row.trend.direction : null;
        if (direction) {
            card.trend = { direction };
            if (Number.isFinite(Number(row.trend.pct)) && Number(row.trend.pct) >= 0) card.trend.pct = Number(row.trend.pct);
            if (Number.isSafeInteger(Number(row.trend.previous)) && Number(row.trend.previous) >= 0) card.trend.previous = Number(row.trend.previous);
        }
    }
    // A report's moment and its side numbers (feed.item@1 1.2.0 `stat`): the reader's own clock says the time.
    if (card.kind === 'report' && row.stat && typeof row.stat === 'object') {
        const stat = {};
        const at = Date.parse(String(row.stat.at || ''));
        if (Number.isFinite(at)) stat.at = new Date(at).toISOString();
        const facts = (Array.isArray(row.stat.facts) ? row.stat.facts : [])
            .filter((x) => x && Number.isSafeInteger(Number(x.n)) && Number(x.n) >= 0 && clean(x.label, 40))
            .slice(0, 6).map((x) => ({ label: clean(x.label, 40), n: Number(x.n) }));
        if (facts.length) stat.facts = facts;
        if (Object.keys(stat).length) card.stat = stat;
    }
    // What the offer costs, kept beside the card: the price belongs to the group item that lists it.
    const facts = dealFacts(row);
    if (facts) DEAL_FACTS.set(card, facts);
    return card;
}

const BURST_MS = 15 * 60_000;
const BURST_WORD = { pic: ['photo', 'photos'], clip: ['clip', 'clips'], video: ['video', 'videos'], game: ['achievement', 'achievements'], quest: ['quest', 'quests'], avatar: ['picture change', 'picture changes'], banner: ['banner change', 'banner changes'], paste: ['paste', 'pastes'], space: ['space', 'spaces'] };
// A poll can deliver forty of the same kind at once with no person behind them (deals, news): one card.
const BULK_WORD = { deal: ['deal', 'deals'], news: ['story', 'stories'], event: ['event', 'events'] };
// What a person did, said the way the single card says it (2026-11-14, the owner: "'added' instead of like completed
// … is weird" under "krissy_sweet added 2 quests" / "finished a quest").
const BURST_SAY = {
    pic: (n) => `posted ${n} photos`, clip: (n) => `made ${n} clips`, video: (n) => `posted ${n} videos`,
    game: (n) => `earned ${n} achievements`, quest: (n) => `finished ${n} quests`, paste: (n) => `posted ${n} pastes`,
    space: (n) => `made ${n} spaces`, avatar: (n) => `changed their picture ${n} times`, banner: (n) => `changed their banner ${n} times`,
};

/** The id of one site's run of one bulk kind in one UTC hour ('2026-11-12T17'): the same on every page that reads it. */
const bulkId = (kind, site, hour) => `g:${kind}:${site}:${hour}`;

function titleKey(card) {
    return String(card.title || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Many of the same kind in a short time become one card: a person's ten recordings in one evening,
 * their four pictures in ten minutes. Work is grouped per UTC hour (the owner's ask: new jobs as one
 * grouped item per hour); Report is one card per day and is already one row.
 */
function foldCards(cards, now = Date.now()) {
    const groups = [];
    for (const card of cards) {
        if (card.kind === 'work') {
            const hour = String(card.at || '').slice(0, 13);
            const prior = groups.find((g) => g.workHour === hour);
            if (prior) { prior.cards.push(card); continue; }
            groups.push({ workHour: hour, card, cards: [card] });
            continue;
        }
        const at = Date.parse(card.at || '');
        // A picture source may name only its author, not a subject (OpenVibe.Pics): group by that name too.
        const who = card.subject || (card.actor && card.actor.name) || null;
        const prior = BURST_WORD[card.kind] && who && Number.isFinite(at) && groups.find((g) => g.subject != null
            && g.subject === who && g.site === card.site && g.card.kind === card.kind && Math.abs(g.at - at) <= BURST_MS);
        if (prior) { prior.cards.push(card); continue; }
        // No person behind a run (a Deals poll, a News import): the same kind and site in the same hour is one card.
        const hour = String(card.at || '').slice(0, 13);
        const bulk = !who && BULK_WORD[card.kind] && hour && groups.find((g) => g.bulk && g.card.kind === card.kind && g.site === card.site && g.hour === hour);
        if (bulk) { bulk.cards.push(card); continue; }
        groups.push({ subject: who, at, site: card.site, card, cards: [card], bulk: !who && BULK_WORD[card.kind] ? true : undefined, hour });
    }
    return groups.map((g) => {
        if (g.workHour !== undefined) {
            if (g.cards.length < 2) return g.card;
            const sites = new Set(g.cards.map((c) => c.site_name).filter(Boolean));
            return {
                ...g.card,
                id: `g:work:${g.workHour}`,
                title: `${g.cards.length} new jobs this hour`,
                text: clean(g.cards.map((c) => c.title).slice(0, 3).join(' · '), 280),
                group: { count: g.cards.length, items: g.cards.slice(0, 20).map(groupItem) },
                counts: { ...g.card.counts, people: g.cards.length },
                site: g.card.site,
                site_name: sites.size === 1 ? [...sites][0] : g.card.site_name,
            };
        }
        if (g.bulk) {
            // One row stays itself (its own title) unless the API finds more of its hour; a run is one card per hour.
            const [one, many] = BULK_WORD[g.card.kind];
            const bulk = { kind: g.card.kind, site: g.site, hour: g.hour, one, many };
            if (g.cards.length < 2) return { ...g.card, bulk };
            return {
                ...g.card,
                id: bulkId(g.card.kind, g.site, g.hour),
                bulk,
                title: `${g.cards.length} new ${many}`,
                media: null,   // each row shows its own picture
                group: { count: g.cards.length, items: g.cards.slice(0, 20).map(groupItem) },
                counts: { ...g.card.counts, people: g.cards.length },
            };
        }
        if (g.cards.length < 2) return g.card;
        const [one, many] = BURST_WORD[g.card.kind];
        const name = (g.card.actor && g.card.actor.name) || 'Someone';
        return {
            ...g.card,
            title: `${name} ${BURST_SAY[g.card.kind] ? BURST_SAY[g.card.kind](g.cards.length) : `added ${g.cards.length} ${many}`}`,
            text: '',
            group: { count: g.cards.length, items: g.cards.slice(0, 20).map(groupItem) },
            counts: { ...g.card.counts, people: g.cards.length },
            ...(one ? {} : {}),
        };
    });
}

/**
 * One card per thing (2026-11-13, the owner: "Why is it duplicating stuff … I should just show the post that she made,
 * not like duplicate on community"). Community opens a discussion thread for each paste, clip and video it lists, and
 * that thread (and its replies) reached the feed beside the thing itself, with the same picture. A card whose picture
 * another card shows is folded into the thing: the thing keeps its place, takes the thread's comment count, and takes
 * its author when the thing had nobody (pictures arrive without one). A reply whose thread was folded goes too.
 */
const pictureKey = (card) => {
    const t = card && card.media && card.media.thumb;
    if (!t) return null;
    try { const u = new URL(t); return `${u.host}${u.pathname}`.replace(/\/screenshot$/, ''); } catch { return null; }
};
const isDiscussion = (card) => card && card.site === 'community' && /^f:community:(thread|post):/.test(String(card.id || ''));
const threadOf = (url) => String(url || '').split('#')[0];
function oneCardPerThing(cards) {
    const byPicture = new Map();
    for (const c of cards) { const k = pictureKey(c); if (k && !isDiscussion(c) && !byPicture.has(k)) byPicture.set(k, c); }
    const folded = new Set();
    const out = [];
    for (const c of cards) {
        const k = pictureKey(c);
        const thing = k && isDiscussion(c) ? byPicture.get(k) : null;
        if (thing) {
            const counts = { ...(thing.counts || {}) };
            const theirs = Number(c.counts && c.counts.comments) || 0;
            if (theirs > (Number(counts.comments) || 0)) counts.comments = theirs;
            thing.counts = counts;
            if (!thing.actor && c.actor) { thing.actor = c.actor; if (!thing.subject && c.subject) thing.subject = c.subject; }
            folded.add(threadOf(c.url));
            continue;
        }
        out.push(c);
    }
    // A reply in a folded thread is part of that thing's comments, not a card of its own.
    return out.filter((c) => !(isDiscussion(c) && /^f:community:post:/.test(String(c.id || '')) && folded.has(threadOf(c.url))));
}

const DAY_MS = 24 * 60 * 60_000;
const engagement = (card) => {
    const c = card.counts || {};
    return Math.log1p(Math.max(0, Number(c.likes) || 0) + 2 * Math.max(0, Number(c.comments) || 0)
        + 0.2 * Math.max(0, Number(c.views) || 0) + 0.1 * Math.max(0, Number(c.watchers) || 0)) * 2;
};

/** The order the menu and the Pulse page show: live, the last week's best for you, then older. */
function compareRankedCards(a, b, { followed = new Set(), affinity = new Map(), now = Date.now() } = {}) {
    const liveOrder = Number(b.kind === 'live' && b.live_now === true) - Number(a.kind === 'live' && a.live_now === true);
    if (liveOrder) return liveOrder;
    const ageDays = (card) => {
        const at = Date.parse(card.at || '');
        return Number.isFinite(at) ? Math.max(0, (now - at) / DAY_MS) : Infinity;
    };
    const aAge = ageDays(a), bAge = ageDays(b);
    const staleOrder = Number(aAge > 7) - Number(bAge > 7);
    if (staleOrder) return staleOrder;
    const score = (card, age) => (Number.isFinite(age) ? Math.max(0, 7 - age) : 0)
        + engagement(card)
        + (card.subject && followed.has(card.subject) ? 4 : 0)
        + (card.site ? Math.min(2, 0.2 * (affinity.get(card.site) || 0)) : 0);
    const scoreOrder = score(b, bAge) - score(a, aAge);
    if (scoreOrder) return scoreOrder;
    const timeOrder = (Date.parse(b.at || '') || 0) - (Date.parse(a.at || '') || 0);
    return timeOrder || String(a.id).localeCompare(String(b.id));
}

function rankCards(cards, options) {
    return cards.slice().sort((a, b) => compareRankedCards(a, b, options));
}

const ALIASES = {
    clip: 'clip', clips: 'clip', video: 'video', videos: 'video', recording: 'video', recordings: 'video',
    photo: 'pic', photos: 'pic', pic: 'pic', pics: 'pic', picture: 'pic', pictures: 'pic', post: 'post', posts: 'post',
    paste: 'paste', pastes: 'paste', stream: 'stream', streams: 'stream', live: 'live', game: 'game', games: 'game',
    update: 'update', updates: 'update', wiki: 'wiki', quest: 'quest', quests: 'quest', chat: 'chat', event: 'event',
    events: 'event', work: 'work', jobs: 'work', deal: 'deal', deals: 'deal', news: 'news', report: 'report',
    rundown: 'rundown', member: 'member', members: 'member', meme: 'meme', memes: 'meme', poll: 'poll', polls: 'poll',
    episode: 'episode', episodes: 'episode', space: 'space', spaces: 'space',
};

/** Search words, kind words and dates ("new clips from today") over one card. */
function searchMatches(card, query) {
    const q = clean(query, 80).toLowerCase();
    if (!q) return true;
    const kindWord = (q.match(/\b[a-z]+\b/g) || []).find((word) => ALIASES[word]);
    const kind = kindWord && ALIASES[kindWord];
    if (kind && card.kind !== kind && !(kind === 'stream' && card.kind === 'live')) return false;
    const day = String(card.at || '').slice(0, 10);
    if (/\btoday\b/.test(q) && day !== new Date().toISOString().slice(0, 10)) return false;
    if (/\byesterday\b/.test(q) && day !== new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)) return false;
    const date = /\b\d{4}-\d{2}-\d{2}\b/.exec(q);
    if (date && day !== date[0]) return false;
    const words = q.replace(/\b(clips?|videos?|recordings?|photos?|pics?|pictures?|posts?|pastes?|streams?|live|games?|updates?|jobs?|deals?|wikis?|quests?|polls?|episodes?|spaces?|from|today|yesterday|new)\b/g, '')
        .replace(/\b\d{4}-\d{2}-\d{2}\b/g, '').trim();
    return !words || [card.title, card.text, card.site, card.site_name, card.kind, card.actor && card.actor.name]
        .some((v) => String(v || '').toLowerCase().includes(words));
}

/** The "Try" words under the search box. */
function searchExamples(cards) {
    const examples = [];
    const add = (text, reason) => { if (text && !examples.some((x) => x.text === text)) examples.push({ text, reason }); };
    for (const c of cards) if (c.actor && c.actor.name) add(c.actor.name, 'person');
    for (const kind of new Set(cards.map((c) => c.kind))) add(`new ${kind === 'pic' ? 'photos' : `${kind}s`}`, 'kind');
    if (cards.some((c) => String(c.at || '').slice(0, 10) === new Date().toISOString().slice(0, 10))) add('from today', 'date');
    return examples.slice(0, 8);
}

/** A feed card as the menu's older wall item (GET /api/v1/pulse shape): the same ids, another drawing. */
function wallItem(card) {
    return {
        id: card.id,
        source: { service: card.site, type: card.kind, id: card.id },
        title: card.title,
        text: card.text,
        url: card.url,
        picture_url: card.media ? card.media.thumb : null,
        origin: card.label === 'AI' ? 'ai' : (card.subject ? 'user' : 'system'),
        label: card.label || null,
        actor: card.actor ? { display_name: card.actor.name, avatar_url: card.actor.avatar } : null,
        occurred_at: card.at,
    };
}

module.exports = { bulkId, BULK_WORD, SITE_NAMES, kindOf, cardOf, oneCardPerThing, foldCards, compareRankedCards, rankCards, searchMatches, searchExamples, wallItem, titleKey, clean, https };
