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

/** One row as a card. `actor` is the resolved person { name, avatar } when the row names one. */
function cardOf(row, actor = null) {
    const counts = row.counts && typeof row.counts === 'object' ? row.counts : {};
    const safe = {};
    for (const k of ['views', 'likes', 'comments', 'watchers', 'people']) {
        const n = Number(counts[k]);
        if (Number.isSafeInteger(n) && n >= 0) safe[k] = n;
    }
    const ratio = Number(row.media_ratio);
    const length = Number(row.media_length);
    const card = {
        id: `f:${row.source_service}:${row.source_type}:${row.source_id}`,
        kind: row.kind,
        url: https(row.url) || String(row.url || ''),
        title: clean(row.title, 300),
        text: clean(row.text, 280),
        at: row.occurred_at ? new Date(row.occurred_at).toISOString() : null,
        site: String(row.site || row.source_service || ''),
        site_name: String(row.site_name || SITE_NAMES[row.site] || SITE_NAMES[row.source_service] || row.site || ''),
        actor: actor ? { name: clean(actor.name, 80) || null, avatar: https(actor.avatar) } : (row.actor_name ? { name: clean(row.actor_name, 80) || null, avatar: null } : null),
        subject: row.actor_subject || null,
        media: row.picture_url && https(row.picture_url)
            ? { thumb: https(row.picture_url), ...(row.preview_url && https(row.preview_url) ? { preview: https(row.preview_url) } : {}), ratio: Number.isFinite(ratio) && ratio > 0 ? ratio : 16 / 9, ...(Number.isFinite(length) && length > 0 ? { length } : {}) }
            : null,
        counts: safe,
    };
    if (row.starts_at) card.starts_at = new Date(row.starts_at).toISOString();
    if (row.label) card.label = row.label;
    // The menu labels AI output and system/aggregate rows; keep the old Pulse's promise that AI is never a person.
    if (!card.label && row.origin === 'ai') card.label = 'AI';
    else if (!card.label && row.origin === 'system' && !card.actor) card.label = 'System';
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
    return card;
}

const BURST_MS = 15 * 60_000;
const BURST_WORD = { pic: ['photo', 'photos'], clip: ['clip', 'clips'], video: ['video', 'videos'], game: ['achievement', 'achievements'], quest: ['quest', 'quests'], avatar: ['picture change', 'picture changes'], banner: ['banner change', 'banner changes'], paste: ['paste', 'pastes'], space: ['space', 'spaces'] };

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
        groups.push({ subject: who, at, site: card.site, card, cards: [card] });
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
                group: { count: g.cards.length, items: g.cards.slice(0, 20).map((c) => ({ id: c.id, url: c.url, title: c.title, media: c.media })) },
                counts: { ...g.card.counts, people: g.cards.length },
                site: g.card.site,
                site_name: sites.size === 1 ? [...sites][0] : g.card.site_name,
            };
        }
        if (g.cards.length < 2) return g.card;
        const [one, many] = BURST_WORD[g.card.kind];
        const name = (g.card.actor && g.card.actor.name) || 'Someone';
        return {
            ...g.card,
            title: `${name} added ${g.cards.length} ${many}`,
            text: '',
            group: { count: g.cards.length, items: g.cards.slice(0, 20).map((c) => ({ id: c.id, url: c.url, title: c.title, media: c.media })) },
            counts: { ...g.card.counts, people: g.cards.length },
            ...(one ? {} : {}),
        };
    });
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

module.exports = { SITE_NAMES, kindOf, cardOf, foldCards, compareRankedCards, rankCards, searchMatches, searchExamples, wallItem, titleKey, clean, https };
