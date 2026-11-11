'use strict';
const kit = require('openvibe-shared/kit');
const sectionIcon = (name) => kit.icon(name, { cls: 'ovk-heading-icon' });
const cache = require('openvibe-shared/cache-policy');
// The openvibe.network home page: the static shell (public/index.html) with the network and the
// tool catalog rendered into it on the server, so the page is complete without JavaScript and
// always matches what openvibe.tools actually offers (catalog via server/domains/catalog.js).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const seo = require('openvibe-shared/seo');
const icons = require('openvibe-shared/icons');
const showcase = require('openvibe-shared/showcase');
const toolsCatalog = require('../domains/catalog');
const activity = require('./activity');
const homePopular = require('./popular');
const boost = require('../boost');
// The look before first paint (openvibe-shared look-boot, plan L42): the shell carries the marker and this
// puts the script there, above the stylesheets, in the page the server renders.
const lookBoot = require('../look-boot');

const SHELL = path.join(__dirname, '..', '..', 'public', 'index.html');
const esc = seo.esc;
const icon = (name, size) => `<span class="ov-icon" data-icon="${esc(name)}" data-ovi="${esc(icons.resolve(name))}" data-fx="none" style="--ovi-size:${size}px" aria-hidden="true">${icons.svg(name)}</span>`;

// The sites come from the frame's list (server/frame/sites.js): a site is open only when its service's
// public domain serves the service itself (Network's exposure overlay), so the home page, the navbar and
// "Opening next" always agree with what is actually running.
const { LISTED, GROUPS, groupOf, fullName } = require('../frame/sites');
const contracts = require('openvibe-contracts');
const social = require('openvibe-shared/social');
// OpenRestream is its own name, never "OpenVibe.OpenRestream" (the owner, 2026-10-28).
const siteName = (site) => (site.name.includes('.') ? site.name : fullName(site));
const OPEN = LISTED.filter((site) => site.status === 'open' && site.id !== 'network');
// How many places the network lists: every open entry, this front door included, the same count the menu, /sites and
// the Frame's pulse/online answer (server/sites/page.js updates with it). Pics and Download count; Media, Homes and
// Bench are merged sections, not entries.
// One number for the whole page: until 2026-11-06 the sites heading counted without the front door and the link under it
// with it, so a phone showed "51 sites, one front door" above "All 52 sites" (the owner: "why isn't this count just
// dynamic"). It always was computed; it now has one definition.
const SITE_COUNT = LISTED.filter((site) => site.status === 'open').length;
const SOON = LISTED.filter((site) => site.status !== 'open');
const WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen', 'Twenty'];
const inWords = (n) => WORDS[n] || String(n);
const ACCOUNT = [
    ['live', 'Go live and keep your VODs', 'Stream from a browser tab, clip the good parts, earn channel points and restream to other platforms.', 'https://openvibe.live/'],
    ['tools', 'Tool results that stick around', 'Guests keep results for an hour. Signed in, they stay for a day and your recent tools follow you.', 'https://openvibe.tools/'],
    ['account', 'One sign-in', 'Sign in once. Every OpenVibe site recognises you, including the ones you have not visited yet.', '/login'],
    ['theme', 'Themes that follow you', 'Pick or build a theme and every site wears it.', '/themes'],
    ['history', 'History across sites', 'Streams you watched, tools you used and pastes you opened, in one list you control.', '/history'],
    ['bell', 'One notification inbox', 'Alerts from every site in one bell, with optional push.', '/notifications'],
];
const POPULAR = ['yt', 'convert', 'mergepdf', 'jsonfmt', 'mp3', 'dns', 'whois', 'compress', 'fancy', 'ssl', 'logo', 'regex'];

// The front door (plan T11, D93): what people come to do, each a real link to where it starts. `k` holds the words
// the hero's search box matches (public/index.html); a query that names no intent strongly goes to the tool search.
const INTENTS = [
    ['vibe', 'fa-brain', 'Ask Vibe', 'Questions, research and tasks in plain words: OpenVibe\'s assistant, with your chats kept.', 'https://openvibe.chat/vibe', 'ask vibe question questions answer explain research chatgpt claude gemini chat-gpt'],
    ['live', 'fa-tower-broadcast', 'Go live', 'From a browser tab. No OBS, no follower minimum.', 'https://openvibe.live/broadcast', 'go live stream streaming broadcast camera webcam screen obs whip rtmp twitch'],
    ['tools', 'fa-screwdriver-wrench', 'Get something done', '', 'https://openvibe.tools/', 'tool tools convert pdf mp3 mp4 video audio image compress resize dns whois json regex download youtube'],
    ['chat', 'fa-comments', 'Chat', 'Group chats with AI members, servers with text and voice channels, pictures and DMs.', 'https://openvibe.chat/', 'chat talk message messages dm room rooms friends group server servers channel channels voice discord slack ai bot members'],
    ['paste', 'fa-paste', 'Share a paste', 'Text, code or a screenshot behind one short link.', 'https://openvibe.community/new', 'paste share code snippet text link screenshot pastebin gist'],
    ['tips', 'fa-hand-holding-heart', 'Get tips on stream', 'A tip page, paid messages, text-to-speech and alerts in OBS, on any platform.', 'https://openvibe.tips/', 'tip tips tipping donate donation donations superchat paid message tts text to speech alerts overlay obs streamlabs'],
    ['vip', 'fa-gem', 'Start a membership', 'Plans with perks across OpenVibe, like Patreon, and subscriptions to your own software.', 'https://openvibe.vip/', 'vip membership memberships subscribe subscription subscriptions patreon perks members only supporters license'],
    ['games', 'fa-gamepad', 'Play', 'Browser games that already know you.', 'https://openvibe.games/', 'play game games gaming multiplayer'],
    ['blog', 'fa-pen-nib', 'Write', 'A blog of your own, with drafts, scheduling and feeds.', 'https://openvibe.blog/write', 'write blog post posts article publish newsletter'],
    ['space', 'fa-wand-magic-sparkles', 'Make an app', 'Describe it and OpenVibe AI builds it on your account, with its own data, AI and server code.', 'https://openvibe.space/spaces/new', 'app apps make build builder space spaces website site page no-code gpt gpts chatgpt custom quiz poll guestbook game'],
    ['wiki', 'fa-book-open', 'Look it up', 'Wiki pages with sources and history.', 'https://openvibe.wiki/', 'wiki learn read knowledge research look'],
    ['services', 'fa-server', 'Build on OpenVibe', 'One console for projects, keys, grants and the API docs of every service.', 'https://openvibe.services/', 'build api sdk developer developers oauth webhook webhooks app integrate console platform'],
    ['codes', 'fa-code', 'Code with any agent', 'Claude Code, Codex, OpenCode or your own model on one task, with hand-offs.', 'https://openvibe.codes/', 'code coding agent agents ai claude codex opencode deepseek harness contribute'],
    ['ai', 'fa-robot', 'Compare AI models', 'Which AI does each job best, what it costs and how fast it is: the Bench results, on Report.', 'https://openvibe.report/ai', 'ai artificial intelligence benchmark benchmarks bench leaderboard comparison llm gpt claude gemini which-ai best-ai'],
    ['actor', 'fa-user-astronaut', 'Give a task to an agent', 'Actor picks the best agent for it, works on a desk you can watch and take over, and shows the cost and why.', 'https://openvibe.actor/', 'agent agents ai assistant task tasks automate automation router openrouter delegate'],
    ['bot', 'fa-desktop', 'Put your computer to work', 'Desks for your agents, a spare laptop as a desk host, and the AI models you run (Ollama, LM Studio) for your own work.', 'https://openvibe.link/machines', 'computer computers pc laptop desktop desk desks machine machines ollama lmstudio llama gpu homelab node'],
    ['work', 'fa-briefcase', 'Find work', 'Jobs from open boards in one search, each linked to where you apply.', 'https://openvibe.work/', 'job jobs work career hiring remote employment apply listings'],
    ['food', 'fa-utensils', 'Eat well for less', 'Food near you, meal plans and recipes for your budget, and delivery apps compared.', 'https://openvibe.food/', 'food eat meal meals grocery groceries recipe recipes foodbank pantry delivery doordash ubereats grubhub instacart hellofresh'],
    ['quest', 'fa-ranking-star', 'Earn badges', 'Quests across the network for the things you already do there.', 'https://openvibe.quest/', 'quest quests badge badges achievement achievements rewards opencoins earn'],
    ['rent', 'fa-house', 'Rent a place', 'Every rental site in one search, and one board for what you find there.', 'https://openvibe.rent/', 'rent rental rentals apartment apartments room house flat lease parking storage equipment craigslist zillow zumper'],
    ['homes', 'fa-house-chimney', 'Buy a home', 'Every for-sale site in one search, with county records and a mortgage calculator.', 'https://openvibe.homes/', 'home homes house houses sale realestate realtor redfin zillow mortgage property records land'],
    ['video', 'fa-film', 'Watch and upload videos', 'Upload or record a video and get AI captions, chapters and cuts, plus OpenVibe.Live\'s past streams.', 'https://openvibe.video/', 'video videos upload record vod vods recording recordings replay replays clip clips past stream streams highlights vlog captions'],
    ['pics', 'fa-image', 'Share pictures', 'Upload a picture and get links to share or embed it anywhere, in any size.', 'https://openvibe.pics/', 'picture pictures image images photo photos imgur upload host embed gif album albums alt text'],
    ['media-hub', 'fa-cloud-arrow-up', 'Keep and share files', 'A 25 GB drive with share links and folder backups.', 'https://openvibe.download/', 'download files drive upload share link storage backup sync cloud send mediafire mega'],
    ['zone', 'fa-box-archive', 'Store files in buckets', 'Private S3-compatible storage zones for your projects, with keys you scope and quotas you set.', 'https://openvibe.zone/', 'storage s3 bucket buckets object storage files backup backups rclone aws zone data upload'],
    ['play', 'fa-trophy', 'Climb the leaderboards', 'This week\'s leaders and the achievements you have unlocked in every OpenVibe game, now part of OpenVibe.Games.', 'https://openvibe.games/leaderboards', 'leaderboard leaderboards achievement achievements score scores ranking rank high score trophy games play'],
    ['inventory', 'fa-shirt', 'Wear what you earn', 'One inventory for the items you earn across OpenVibe, worn on every site.', 'https://openvibe.my/inventory', 'inventory items cosmetics name effect particles hat voice badge collect equip wear profile'],
    ['watch', 'fa-bell', 'Get told when it changes', 'Watch a page, a feed or an API and hear when your value moves.', 'https://openvibe.watch/', 'watch monitor alert alerts notify change changes price drop feed rss tracker uptime'],
    ['help', 'fa-life-ring', 'Get help', 'Every OpenVibe site\'s questions answered, and a person when they are not.', 'https://openvibe.help/', 'help support faq question questions ticket contact problem how'],
];

// The site whose visits rank an intent (the owner's plan L43: "the most popular things to do now, from the numbers").
// One site counts once: Ask Vibe and Chat are both openvibe.chat, so Chat carries its number; pictures and files are
// openvibe.video's products, so Video does. An intent with no site of its own keeps its place after the ranked ones.
const INTENT_SITE = { vibe: null, paste: 'community', video: 'media-hub', pics: null, 'media-hub': null };
const siteOfIntent = (id) => (Object.prototype.hasOwnProperty.call(INTENT_SITE, id) ? INTENT_SITE[id] : id);
const fmtVisits = (n) => (n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n));
/** The intents, most visited first this week; the first five say how many visits. Unknown numbers keep the order. */
function rankedIntents(popularity) {
    const visits = (id) => { const s = siteOfIntent(id); const n = s && popularity ? Number(popularity[s]) : NaN; return Number.isFinite(n) && n > 0 ? n : 0; };
    if (!popularity) return INTENTS.map((it) => ({ it, n: 0 }));
    return INTENTS.map((it, i) => ({ it, n: visits(it[0]), i })).sort((a, b) => (b.n - a.n) || (a.i - b.i));
}

function intents(catalog, popularity = null) {
    const toolsLine = catalog.tools.length ? `Convert, compress, look up or download: ${catalog.tools.length} tools that just open.` : 'Convert, compress, look up or download: free tools that just open.';
    const ranked = rankedIntents(popularity);
    return `<ul class="intents" data-ovk-scroll aria-label="What you can do here${popularity ? ', most visited this week first' : ''}">${ranked.map(({ it: [id, fa, verb, line, href, k], n }, pos) => `<li><a class="intent" href="${esc(href)}" data-id="${esc(id)}" data-k="${esc(k)}"><i class="fa-solid ${esc(fa)}" aria-hidden="true"></i><span><b>${esc(verb)}</b><small>${esc(line || toolsLine)}</small>${pos < 5 && n >= 10 ? `<em class="intent-n">${esc(fmtVisits(n))} visits this week</em>` : ''}</span></a></li>`).join('')}</ul>`;
}

// The network as an orbit (the owner, 2026-10-28: the hero was "ugly af, boring… not easy to understand… nice animated
// visuals"): the mark in the middle, the six most used sites on the inner ring and ten more on the outer, the rings
// turning slowly in opposite directions while each site's icon stays upright. Pure CSS transforms (cheap to draw), and
// still under reduced motion. Every open site is in the sites section below; this shows the shape of the network.
const SHORT = (site) => site.name.replace(/^OpenVibe\./, '');
function orbit() {
    const inner = OPEN.slice(0, 6), outer = OPEN.slice(6, 16);
    const node = (site, i, n, big) => `<a class="orb-node${big ? ' is-big' : ''}" href="https://${esc(site.host)}/" style="--i:${i};--n:${n}" title="${esc(siteName(site))}: ${esc(site.tagline || '')}" aria-label="${esc(siteName(site))}"><span class="orb-face">${icon(site.icon, big ? 26 : 20)}${big ? `<span class="orb-name">${esc(SHORT(site))}</span>` : ''}</span></a>`;
    return `<div class="orbit" role="group" aria-label="The OpenVibe network: ${SITE_COUNT} sites around one account">
<div class="orb-glow" aria-hidden="true"></div>
<div class="orb-ring r2">${outer.map((s, i) => node(s, i, outer.length, false)).join('')}</div>
<div class="orb-ring r1">${inner.map((s, i) => node(s, i, inner.length, true)).join('')}</div>
<a class="orb-core" href="#network"><span class="ov-mark" data-size="64" data-variant="network" style="width:64px;height:64px"></span><b>${SITE_COUNT} sites</b><small>one account</small></a>
</div>`;
}

const fmtViewers = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
const fmtCount = (n) => Number(n).toLocaleString('en-US');
// A picture that fails to load (a stream's first thumbnail is written a few seconds after it goes live) falls back to
// the avatar when there is one, else to an empty tile, never the browser's broken-image icon.
const BLANK = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
// A Media object is stored at full size: ask its resize ladder for the width drawn here (96 for the 36 px face, 640
// for a 320 px card picture). Any other picture address — a Live thumbnail, an avatar from another host, one already
// sized — is used unchanged. The full-size address stays in data-full: if Media cannot resize it, the picture retries
// the original once before the existing fallback.
const mediaW = (src, w) => (/^https:\/\/openvibe\.media\/o\/med_[0-9A-Za-z]+$/.test(String(src || '')) ? `${src}?w=${w >= 288 ? 640 : w >= 72 ? 160 : 96}` : src);
const img = (src, fallback, w, h) => {
    const sized = mediaW(src, w);
    const full = sized === src ? '' : ` data-full="${esc(src)}"`;
    return `<img src="${esc(sized)}" alt="" loading="lazy" decoding="async" width="${w}" height="${h}"${full} data-fallback="${esc(fallback || BLANK)}" onerror="if(this.dataset.full&&this.src!==this.dataset.full){this.src=this.dataset.full;return}this.src=this.dataset.fallback">`;
};
function rightNow(a) {
    // Rich cards (the owner, 2026-10-28: "more compact, bigger, like YouTube… a preview… view count… the uploader and
    // avatar… rich content"): a 16:9 picture with its length or LIVE badge, a play button and what happens in it on hover,
    // then the channel's picture, the title, and views and when. Four across on a computer, two on a tablet, a row to swipe
    // on a phone.
    const ago = (ms) => {
        if (!ms) return '';
        const s = Math.max(0, (Date.now() - ms) / 1000);
        const [n, u] = s < 3600 ? [Math.max(1, Math.round(s / 60)), 'minute'] : s < 86400 ? [Math.round(s / 3600), 'hour'] : s < 86400 * 30 ? [Math.round(s / 86400), 'day'] : [Math.round(s / (86400 * 30)), 'month'];
        return `${n} ${u}${n === 1 ? '' : 's'} ago`;
    };
    const views = (n) => (n ? `${fmtViewers(n)} view${n === 1 ? '' : 's'}` : '');
    const face = (src) => (src ? img(src, null, 36, 36) : '<span class="vc-noface"></span>');
    const card = ({ url, thumb, badge, len, about, avatar, title, who, line, cls = '' }) => `<li><a class="vcard${cls}" href="${esc(url)}">
<span class="vc-thumb">${thumb ? img(thumb, avatar, 320, 180) : '<span class="now-noimg"></span>'}${badge || ''}${len ? `<span class="vc-len">${esc(len)}</span>` : ''}<span class="vc-play" aria-hidden="true"><i class="fa-solid fa-play"></i></span>${about ? `<span class="vc-about">${esc(about)}</span>` : ''}</span>
<span class="vc-meta">${face(avatar)}<span class="vc-text"><b>${esc(title)}</b>${who ? `<small>${esc(who)}</small>` : ''}${line ? `<small>${esc(line)}</small>` : ''}</span></span></a></li>`;
    // A block's head (ask 364, 2026-11-11: the owner's "overhaul … more organized"): its name in sentence case with
    // its own mark and how many, and one short link to the rest (its full name in the title) that never wraps.
    const head = (title, n, href, more, short, mark) => `<div class="now-head"><h3 class="now-h">${mark}<span>${title}</span>${n ? `<em class="now-n">${n}</em>` : ''}</h3>`
        + `<a class="now-more" href="${esc(href)}" title="${esc(more)}" aria-label="${esc(more)}">${esc(short)}<i class="fa-solid fa-chevron-right" aria-hidden="true"></i></a></div>`;
    const MARK = { live: '<span class="now-h-live" aria-hidden="true"></span>', recs: '<i class="fa-solid fa-film now-h-ic" aria-hidden="true"></i>', shots: '<i class="fa-solid fa-image now-h-ic" aria-hidden="true"></i>' };
    const rail = (title, href, more, cards, id = '', short = 'All', mark = MARK.recs) => (cards.length ? `<div class="now-block${cards.length === 1 ? ' is-one' : ''}"${id ? ` id="${id}"` : ''}>${head(title, cards.length, href, more, short, mark)}<ul class="now-rail" data-ovk-scroll>${cards.join('')}</ul></div>` : '');

    const live = a.live.map((s) => card({ url: s.url, thumb: s.thumb || s.avatar, badge: `<span class="now-badge"><i></i>LIVE${s.viewers ? ` · ${esc(fmtViewers(s.viewers))}` : ''}</span>`, avatar: s.avatar, title: s.title, who: s.name, line: s.category }));
    // Nobody live: one honest line and the way to start, not an empty 16:9 player (a phone saw a blank screen of it).
    const quiet = a.live.length ? '' : kit.empty({ icon: 'live', title: 'Nobody is live right now.', text: 'Go live from your browser, with no OBS and no follower minimum.', action: { href: 'https://openvibe.live/broadcast', label: 'Go live', icon: 'video' } });
    const recs = (a.recordings || []).map((r) => card({ url: r.url, thumb: r.thumb, len: r.length, about: r.about, avatar: r.avatar, title: r.title, who: r.channel, line: [views(r.views), ago(r.at)].filter(Boolean).join(' · ') }));
    const shots = (a.pastes || []).filter((p) => p.shot).slice(0, 4).map((p) => card({ url: p.url, thumb: p.shot, avatar: p.avatar, title: p.title, who: p.by || 'Screenshot', line: [views(p.views), p.likes ? `${p.likes} like${p.likes === 1 ? '' : 's'}` : '', ago(p.at)].filter(Boolean).join(' · '), cls: ' is-shot' }));
    const texts = (a.pastes || []).filter((p) => !p.shot);

    const list = (items, render) => `<ul class="now-list">${items.map(render).join('')}</ul>`;
    // A column with nothing to show is left out.
    const col = (items, title, render, href, more) => (items.length ? `<div class="now-col"><h3 class="ovk-titled">${sectionIcon('grid')}${title}</h3>${list(items.slice(0, 3), render)}${kit.button({ href, label: more, icon: 'forward', kind: 'quiet' })}</div>` : '');
    const cols = [
        col(texts, 'New pastes', (p) => `<li><a href="${esc(p.url)}"><b>${esc(p.title)}</b><small>${esc(p.kind)}${p.summary ? ` · ${esc(p.summary)}` : ''}</small></a></li>`, 'https://openvibe.community/', 'OpenVibe.Community'),
        col(a.posts, 'From the blog', (p) => `<li><a href="${esc(p.url)}"><b>${esc(p.title)}</b>${p.summary ? `<small>${esc(p.summary)}</small>` : ''}</a></li>`, 'https://openvibe.blog/', 'OpenVibe.Blog'),
        col(a.jobs || [], 'New jobs', (j) => `<li><a href="${esc(j.url)}"><b>${esc(j.title)}</b><small>${[j.where, j.board ? `via ${j.board}` : ''].filter(Boolean).map(esc).join(' · ')}</small></a></li>`, 'https://openvibe.work/', 'Every job on OpenVibe.Work'),
        col(a.codes || [], 'Fresh coupon codes', (c) => `<li><a href="${esc(c.url)}">${c.code ? `<code class="now-code">${esc(c.code)}</code>` : ''}<b>${esc(c.title)}</b></a></li>`, 'https://openvibe.coupons/', 'OpenVibe.Coupons'),
    ].filter(Boolean);
    return `<section class="sc-sec now" aria-labelledby="h-now"><h2 id="h-now" class="now-title"><span class="now-dot" aria-hidden="true"></span>Right now on OpenVibe</h2>
<p class="sc-lede now-lede">Live streams, new recordings and posts from across OpenVibe, updated every minute.</p>
${live.length ? rail('Live now', 'https://openvibe.live/', 'All channels on OpenVibe.Live', live, 'now-live', 'All channels', MARK.live) : quiet}
${nowParts([
        ['recs', 'Recordings', rail('Latest recordings', 'https://openvibe.video/', 'Watch on OpenVibe.Video', recs, 'now-recs', 'OpenVibe.Video', MARK.recs)],
        ['shots', 'Screenshots', rail('New screenshots', 'https://openvibe.community/', 'OpenVibe.Community', shots, 'now-shots', 'Community', MARK.shots)],
        ['posts', 'Posts and jobs', cols.length ? `<div class="now-grid" data-ovk-scroll id="now-posts">${cols.join('\n')}</div>` : ''],
    ])}</section>`;
}

// What is new, under what is live: every part shown (the owner, 2026-10-31: never hide content to shorten); on a phone
// (600 px and under) the rails and the columns each scroll sideways, and a row of chips jumps to a part. With one part
// there are no chips.
function nowParts(parts) {
    const shown = parts.filter(([, , html]) => html);
    if (shown.length < 2) return shown.map(([, , html]) => html).join('\n');
    // A phone (600 px and under) shows one part at a time (ask 364/367, 2026-11-11: "self-contained tabs, so the page
    // isn't so freaking huge"): the radios carry the choice, so it works before and without any script.
    const radios = shown.map(([id], i) => `<input type="radio" class="now-tab-r" name="now-part" id="now-tab-${id}" value="${id}"${i === 0 ? ' checked' : ''}>`).join('');
    const tabs = shown.map(([id, label]) => `<label for="now-tab-${id}">${esc(label)}</label>`).join('');
    return `${radios}<div class="now-tabs" role="presentation">${tabs}</div>\n${shown.map(([id, , html]) => html.replace(/^<div class="(now-block|now-grid)"/, `<div class="$1" data-now-part="${id}"`)).join('\n')}`;
}

// The lower half (tools, what an account adds, what opens next, the questions, the developers' links): every section
// shown with its own heading (the owner, 2026-10-31: never hide content to shorten); on a phone a row of chips under
// "More about OpenVibe" jumps to one. A wider screen shows no chips.
function moreParts(parts) {
    const shown = parts.filter(([, , html]) => html);
    if (shown.length < 2) return shown.map(([, , html]) => html).join('\n');
    const chips = shown.map(([id, label]) => `<a href="#${id}">${esc(label)}</a>`).join('');
    return `<div class="more"><h2 class="more-pick-h">${sectionIcon('grid')}More about OpenVibe</h2><nav class="more-pick" data-ovk-scroll aria-label="More about OpenVibe">${chips}</nav>\n${shown.map(([, , html]) => html.replace(/^<section class="([^"]*)" id="([^"]*)"/, '<section class="$1" id="$2" data-more-part')).join('\n')}</div>`;
}

// The five things people do now (plan L43): a plain list, no new styles. The order and the numbers are Report's;
// when Report does not answer the fixed starter list is used and the section says so in data-source. Opus places and
// styles the block; this only renders it.
function popularNow() {
    const p = homePopular.peek();
    const items = Array.isArray(p.items) ? p.items.slice(0, 5) : [];
    if (!items.length) return '';
    const lede = p.source === 'report'
        ? "Ranked from OpenVibe.Report's numbers: what people opened today and this week."
        : 'A fixed starter list while OpenVibe.Report is away.';
    return `<section class="sc-sec" id="popular" data-source="${esc(p.source)}" aria-labelledby="h-popular"><h2 id="h-popular" class="ovk-titled">${sectionIcon('grid')}Five things people do now</h2><p class="sc-lede">${esc(lede)}</p><ul class="now-list">${items.map((it) => `<li><a href="${esc(it.url)}"><b>${esc(it.name)}</b><small>${esc(it.reason)}</small></a></li>`).join('')}</ul></section>`;
}

// The hero's numbers: only what Network read itself within the last minute (server/home/activity.js); a number it
// could not read is left out rather than guessed.
function numbers(catalog, a) {
    const c = a.counts || {};
    const items = [
        c.services ? [fmtCount(c.services.up), 'services up', `of ${c.services.live} checked`, '/status'] : null,
        [String(SITE_COUNT), 'sites, one account', '', '#network'],
        catalog.tools.length ? [fmtCount(catalog.tools.length), 'online tools', '', 'https://openvibe.tools/'] : null,
        c.accounts ? [fmtCount(c.accounts), 'accounts', '', '/login?tab=register'] : null,
        a.liveCount ? [fmtCount(a.liveCount), a.liveCount === 1 ? 'stream live now' : 'streams live now', '', 'https://openvibe.live/'] : null,
    ].filter(Boolean);
    return `<section class="net-num" aria-labelledby="h-num"><h2 id="h-num" class="ovk-titled">${sectionIcon('grid')}OpenVibe in numbers</h2><ul>${items.map(([n, label, note, href]) => `<li><a href="${esc(href)}"><b>${esc(n)}</b><span>${esc(label)}${note ? ` <small>${esc(note)}</small>` : ''}</span></a></li>`).join('')}</ul><p class="net-num-more"><a href="/stats">Every site's numbers, open to everyone →</a></p></section>`;
}

// The kit (openvibe-shared/showcase, /shared/showcase.css) owns the sections, cards and icon styles; this is only what
// it does not draw: the "Right now" columns and the tool and "Opening next" chips.
const CSS = `
.now-quiet{display:flex;gap:12px;align-items:flex-start;margin:14px 0 0;padding:14px 16px;border:1px dashed var(--border,#1f2d47);border-radius:14px;color:var(--text-secondary,#96a7c2)}
.now-quiet i{color:var(--live-red,#ef4444);margin-top:3px}
.now-quiet b{color:var(--text-primary,#e6edf7)}

.home-fold{margin:14px 0 0;border:1px solid var(--border,#1f2d47);border-radius:14px;background:var(--bg-card,#131c2e)}
.home-fold>summary{display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:48px;padding:0 16px;cursor:pointer;font-weight:700;list-style:none}
.home-fold>summary::-webkit-details-marker{display:none}
.home-fold>summary span{color:var(--text-muted,#7386a3);font-weight:600;font-size:.86rem}
.home-fold>summary::after{content:"";width:8px;height:8px;border-right:2px solid currentColor;border-bottom:2px solid currentColor;transform:rotate(45deg);margin-left:8px;flex:none}
.home-fold[open]>summary::after{transform:rotate(-135deg)}
.home-fold>div,.home-fold>section{padding:0 16px 14px}
.home-fold .sc-sec{margin:0;padding:0}
.home-dev{padding-top:0}
.home-rows{list-style:none;margin:14px 0 0;padding:0;border:1px solid var(--border,#1f2d47);border-radius:14px;background:var(--bg-card,#131c2e)}
.home-rows li+li{border-top:1px solid var(--border,#1f2d47)}
.home-rows a{display:flex;gap:12px;align-items:flex-start;padding:12px 16px;color:inherit;text-decoration:none}
.home-rows a:hover b{color:var(--accent-light,#60a5fa)}
.home-rows b{display:block;font-size:.98rem}
.home-rows small{display:block;color:var(--text-secondary,#96a7c2);font-size:.86rem;line-height:1.45}
.faq-item>summary{list-style:none;cursor:pointer;min-height:44px;display:flex;align-items:center}
.faq-item>summary::-webkit-details-marker{display:none}
.faq-item>summary h3{margin:0}
@media (max-width:599px){#network .sc-apps{grid-template-columns:repeat(4,minmax(0,1fr))}}

#faq{margin-bottom:56px}#developers .sc-grid{grid-template-columns:repeat(auto-fill,minmax(220px,1fr))}
.home-chips{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0 0;padding:0;list-style:none}
.home-chips>li>a{display:inline-flex;align-items:center;gap:7px;padding:6px 12px 6px 7px;border-radius:999px;border:1px solid var(--border,rgba(255,255,255,.1));font-size:13.5px;font-weight:600;color:inherit;text-decoration:none}
.home-chips>li>a:hover,.home-chips>li>a:focus-visible{border-color:var(--accent,#3b82f6);outline:0}
.home-chips.soon>li>a{color:var(--text-secondary,#a8b3c4);border-style:dashed}
.home-more{margin:14px 0 0;font-size:13.5px}.home-more a{font-weight:600;color:var(--accent-light,#60a5fa);text-decoration:none}
.now>h2{display:flex;align-items:center;gap:10px}.now-dot{width:10px;height:10px;border-radius:50%;background:var(--live-red,#ef4444);box-shadow:0 0 0 0 rgba(239,68,68,.6);animation:now-pulse 2s infinite}
@keyframes now-pulse{70%{box-shadow:0 0 0 10px rgba(239,68,68,0)}100%{box-shadow:0 0 0 0 rgba(239,68,68,0)}}
.now-grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fill,minmax(min(300px,100%),1fr));margin-top:14px}
.now-col{display:flex;flex-direction:column;gap:10px;padding:16px;border-radius:16px;border:1px solid var(--border,rgba(255,255,255,.08));background:var(--bg-secondary,#111826);min-width:0}
.now-col h3{font-size:12px;font-weight:800;letter-spacing:.7px;text-transform:uppercase;color:var(--text-muted,#7d8aa0);margin:0}
.now-streams{display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(140px,1fr))}
.now-stream{position:relative;display:flex;flex-direction:column;gap:3px;color:inherit;text-decoration:none;min-width:0}
.now-stream img,.now-noimg{width:100%;aspect-ratio:16/9;height:auto;object-fit:cover;border-radius:10px;background:var(--bg-hover,#1c2a44);display:grid;place-items:center;font-size:26px;color:var(--accent-light,#60a5fa)}
.now-stream b{font-size:14px;line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.now-stream small{color:var(--text-secondary,#a8b3c4);font-size:12.5px}
.now-stream:hover b,.now-list a:hover b{color:var(--accent-light,#60a5fa)}
.now-badge{position:absolute;top:8px;left:8px;display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:6px;background:#dc2626;color:#fff;font-size:11px;font-weight:800;letter-spacing:.4px}
.now-badge i{width:6px;height:6px;border-radius:50%;background:#fff}
.now-empty .now-noimg{border:1px dashed var(--border-light,#2c3d5c);background:transparent}
.now-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}
.now-list a{display:block;color:inherit;text-decoration:none}.now-list b{display:block;font-size:14px;line-height:1.35}
.now-list small{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;color:var(--text-secondary,#a8b3c4);font-size:12.5px;line-height:1.4;margin-top:2px}
.now-more{margin-top:auto;font-size:13px;font-weight:600;color:var(--accent-light,#60a5fa);text-decoration:none}
.now-rec{display:flex!important;gap:10px;align-items:flex-start}.now-rec img,.now-rec .now-noimg{flex:none;width:112px;height:63px;object-fit:cover;border-radius:8px;background:var(--bg-hover,#1c2a44);display:block}
.now-rec>span{min-width:0}.now-rec b{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.now-block{margin-top:22px}.now-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:12px}
.now-head h3{font-size:12px;font-weight:800;letter-spacing:.7px;text-transform:uppercase;color:var(--text-muted,#7d8aa0);margin:0}.now-head .now-more{margin:0}
.now-rail{list-style:none;margin:0;padding:0;display:grid;gap:18px;grid-template-columns:repeat(4,minmax(0,1fr))}
@media (max-width:980px){.now-rail{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:600px){.now-rail{display:flex;overflow-x:auto;scroll-snap-type:x mandatory;gap:12px;margin:0 -16px;padding:2px 16px 8px;scrollbar-width:none;overscroll-behavior-x:contain}.now-rail::-webkit-scrollbar{display:none}.now-rail>li{flex:0 0 min(80%,320px);scroll-snap-align:start}}
/* Phones (2026-10-29): the blog, jobs and code columns are one row that scrolls sideways like the rails above them, and
   what signing in adds is a line each (the sentences are on the wider screens and on Help). */
@media (max-width:600px){.now-grid{display:flex;overflow-x:auto;scroll-snap-type:x mandatory;gap:12px;margin:14px -16px 0;padding:2px 16px 8px;scrollbar-width:none;overscroll-behavior-x:contain}.now-grid::-webkit-scrollbar{display:none}.now-grid>.now-col{flex:0 0 min(84%,340px);scroll-snap-align:start}#account .home-rows small{display:none}#account .home-rows a{min-height:48px;align-items:center}}
.vcard{display:flex;flex-direction:column;gap:10px;color:inherit;text-decoration:none;min-width:0;border-radius:16px;outline-offset:4px}
.vc-thumb{position:relative;display:block;aspect-ratio:16/9;border-radius:14px;overflow:hidden;background:var(--bg-hover,#1c2a44);box-shadow:0 1px 0 rgba(255,255,255,.04) inset}
.vc-thumb img,.vc-thumb .now-noimg{display:block;width:100%;height:100%;object-fit:cover;transition:transform .6s cubic-bezier(.2,.7,.2,1);border-radius:0}
.vcard.is-shot .vc-thumb img{object-fit:cover;object-position:top}
.vc-len{position:absolute;right:8px;bottom:8px;padding:2px 7px;border-radius:6px;background:rgba(0,0,0,.78);color:#fff;font:700 12px/1.4 Inter,system-ui,sans-serif;transition:opacity .25s}
.vc-play{position:absolute;inset:0;display:grid;place-items:center;opacity:0;transition:opacity .25s;pointer-events:none}
.vc-play i{width:54px;height:54px;border-radius:50%;display:grid;place-items:center;background:rgba(0,0,0,.55);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);color:#fff;font-size:18px;padding-left:3px;box-sizing:border-box;transform:scale(.75);transition:transform .35s cubic-bezier(.2,1.4,.3,1)}
.vc-about{position:absolute;left:0;right:0;bottom:0;padding:34px 12px 10px;background:linear-gradient(transparent,rgba(0,0,0,.88));color:#fff;font-size:12.5px;line-height:1.4;opacity:0;transform:translateY(10px);transition:opacity .3s,transform .35s cubic-bezier(.2,.7,.2,1);pointer-events:none}
@media (hover:hover){.vcard:hover .vc-thumb img,.vcard:focus-visible .vc-thumb img{transform:scale(1.06)}.vcard:hover .vc-play,.vcard:focus-visible .vc-play{opacity:1}.vcard:hover .vc-play i,.vcard:focus-visible .vc-play i{transform:none}.vcard:hover .vc-about,.vcard:focus-visible .vc-about{opacity:1;transform:none}.vcard:hover .vc-about~.vc-len,.vcard:hover .vc-len:has(~.vc-about){opacity:0}.vcard:hover b{color:var(--accent-light,#60a5fa)}}
.vc-meta{display:flex;gap:10px;align-items:flex-start;min-width:0}
.vc-meta img,.vc-noface{flex:none;width:36px;height:36px;border-radius:50%;object-fit:cover;background:var(--bg-hover,#1c2a44)}
.vc-text{display:flex;flex-direction:column;min-width:0;gap:1px}
.vc-text b{font-size:15px;line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere;transition:color .2s}
.vc-text small{color:var(--text-secondary,#a8b3c4);font-size:13px;line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vcard .now-badge{z-index:1}
.vcard.now-empty .vc-thumb{border:1px dashed var(--border-light,#2c3d5c);background:transparent}.vcard.now-empty .now-noimg{display:grid;place-items:center;font-size:28px;color:var(--accent-light,#60a5fa);background:transparent}
.now .now-grid{margin-top:26px}
/* Right now, v2 (ask 364): a title with the live dot, one line under it, each block's head says what it is, how many,
   and a short way to the rest; one live stream fills the row; on a phone the parts are tabs. */
.now-title{display:flex;align-items:center;gap:10px}
.now-lede{margin-top:4px}
.now-head{align-items:center;margin-bottom:10px}
.now-h{display:flex;align-items:center;gap:8px;min-width:0;margin:0;font-size:16px;font-weight:800;letter-spacing:-.01em;text-transform:none;color:var(--text-primary,#e6edf7)}
.now-h-live{width:9px;height:9px;border-radius:50%;background:#ef4444;box-shadow:0 0 0 4px rgba(239,68,68,.18);flex:none}
.now-h-ic{display:grid;place-items:center;width:26px;height:26px;border-radius:8px;font-size:12px;color:var(--accent-light,#60a5fa);background:color-mix(in srgb,var(--accent,#3b82f6) 14%,transparent);flex:none}
.now-n{display:inline-flex;align-items:center;height:20px;padding:0 7px;border-radius:999px;font:700 11.5px/1 Inter,system-ui,sans-serif;font-style:normal;color:var(--text-muted,#7d8aa0);background:color-mix(in srgb,var(--text-primary,#fff) 7%,transparent)}
.now-head .now-more{display:inline-flex;align-items:center;gap:6px;flex:none;min-height:36px;padding:0 4px 0 10px;border-radius:10px;white-space:nowrap;font-size:13px;font-weight:650;color:var(--accent-light,#60a5fa);text-decoration:none}
.now-head .now-more:hover,.now-head .now-more:focus-visible{background:color-mix(in srgb,var(--accent,#3b82f6) 12%,transparent)}
.now-head .now-more i{font-size:11px;transition:transform .2s}
.now-head .now-more:hover i{transform:translateX(2px)}
.now-tab-r,.now-tabs{display:none}
@media (max-width:600px){
.now-block.is-one .now-rail>li{flex:0 0 100%}
.now-tabs{display:flex;gap:4px;margin:22px 0 0;padding:4px;border-radius:14px;background:color-mix(in srgb,var(--text-primary,#fff) 5%,transparent);overflow-x:auto;scrollbar-width:none}.now-tabs::-webkit-scrollbar{display:none}
.now-tabs label{flex:1 0 auto;display:grid;place-items:center;min-height:40px;padding:0 14px;border-radius:10px;font-size:13.5px;font-weight:700;color:var(--text-secondary,#a8b3c4);white-space:nowrap;cursor:pointer;transition:background .2s,color .2s}
.now:has(#now-tab-recs:checked) .now-tabs label[for="now-tab-recs"],.now:has(#now-tab-shots:checked) .now-tabs label[for="now-tab-shots"],.now:has(#now-tab-posts:checked) .now-tabs label[for="now-tab-posts"]{background:var(--bg-card,#16213a);color:var(--text-primary,#e6edf7);box-shadow:0 1px 0 rgba(255,255,255,.05),0 2px 8px rgba(0,0,0,.3)}
.now-tab-r:focus-visible+.now-tabs{outline:2px solid var(--accent,#3b82f6);outline-offset:2px}
.now:has(#now-tab-recs:checked) [data-now-part]:not([data-now-part="recs"]),.now:has(#now-tab-shots:checked) [data-now-part]:not([data-now-part="shots"]),.now:has(#now-tab-posts:checked) [data-now-part]:not([data-now-part="posts"]){display:none}
.now .now-block[data-now-part],.now .now-grid[data-now-part]{margin-top:14px}
}
.now-pick,.more-pick,.more-pick-h{display:none}
@media (max-width:600px){
.now-pick,.more-pick{display:flex;gap:8px;overflow-x:auto;margin:22px -16px 0;padding:2px 16px 4px;scrollbar-width:none;overscroll-behavior-x:contain}.now-pick::-webkit-scrollbar,.more-pick::-webkit-scrollbar{display:none}
.now-pick a,.more-pick a{display:inline-flex;align-items:center;flex:none;min-height:44px;padding:0 15px;border-radius:999px;border:1px solid var(--border,rgba(255,255,255,.1));color:var(--text-secondary,#a8b3c4);font-size:13.5px;font-weight:650;white-space:nowrap;text-decoration:none}
.now-pick a:hover,.now-pick a:focus-visible,.more-pick a:hover,.more-pick a:focus-visible{color:var(--text-primary,#e6edf7);border-color:var(--accent,#3b82f6)}
.now-pick a:focus-visible,.more-pick a:focus-visible{outline:2px solid var(--accent,#3b82f6);outline-offset:2px}
.now .now-block[data-now-part],.now .now-grid[data-now-part]{margin-top:22px}
.more-pick-h{display:block;margin:40px 0 0;padding:0 16px;font-size:clamp(1.25rem,5vw,1.5rem);font-weight:800;letter-spacing:-.02em}.more-pick{margin:10px 0 0;padding:2px 16px 4px}
[data-now-part],[data-more-part]{scroll-margin-top:72px}
}
.now-code{display:inline-block;margin:0 0 3px;padding:1px 7px;border-radius:6px;border:1px dashed var(--accent,#3b82f6);color:var(--accent-light,#60a5fa);font:700 12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.3px}
.now-list b{overflow-wrap:anywhere}
.net-num{margin-top:18px;padding:16px 18px;border-radius:16px;border:1px solid var(--border,rgba(255,255,255,.08));background:color-mix(in srgb,var(--bg-secondary,#101828) 85%,transparent)}
.net-num h2{font-size:12px;font-weight:800;letter-spacing:.7px;text-transform:uppercase;color:var(--text-muted,#7d8aa0);margin:0 0 10px}
.net-num ul{list-style:none;margin:0;padding:0;display:grid;gap:8px;grid-template-columns:repeat(auto-fill,minmax(min(140px,100%),1fr))}
.net-num-more{margin:12px 0 0;font-size:13.5px;font-weight:700}.net-num-more a{text-decoration:none}.net-num-more a:hover{text-decoration:underline}
.net-num a{display:flex;flex-direction:column;gap:1px;padding:10px 12px;border-radius:12px;border:1px solid var(--border,rgba(255,255,255,.08));background:var(--bg-primary,#0a0f1c);color:inherit;text-decoration:none;height:100%}
.net-num a:hover,.net-num a:focus-visible{border-color:var(--accent,#3b82f6);outline:0}
.net-num b{font-size:24px;font-weight:800;letter-spacing:-.5px;line-height:1.15;color:var(--text-primary,#e6edf7)}
.net-num span{font-size:12.5px;color:var(--text-secondary,#a8b3c4);line-height:1.35}.net-num small{display:block;color:var(--text-muted,#7d8aa0);font-size:11.5px}
.faq-grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(min(320px,100%),1fr));margin-top:4px}
.faq-item{padding:16px 18px;border-radius:16px;border:1px solid var(--border,rgba(255,255,255,.08));background:var(--bg-secondary,#101828)}
.faq-item h3{font-size:15.5px;margin:0 0 6px;line-height:1.35}.faq-item p{margin:0;color:var(--text-secondary,#a8b3c4);font-size:14px;line-height:1.55}
${icons.CSS}
/* Touch targets on phones (fleet audit, 2026-10-29): touch pointers only. */
@media (pointer: coarse) {
  .home-chips>li>a { min-height: 44px; }
  /* .orb-node is already position: absolute (the orbit places it); making it relative turns the link inline and
     each icon fills the orbit. */
  .orb-node::after { content: ''; position: absolute; left: -9px; right: -9px; top: -9px; bottom: -9px; }
  .now-more { position: relative; }
  .now-more::after { content: ''; position: absolute; left: 0; right: 0; top: -14px; bottom: -14px; }
  .home-more a:only-child { position: relative; display: inline-block; }
  .home-more a:only-child::after { content: ''; position: absolute; left: 0; right: 0; top: -14px; bottom: -14px; }
}
`;

// The sites section's heading; the JSON-LD ItemList of the same sites carries it as its name, so the
// structured data names something a visitor can see (browser check, WS-Q task 3).
const sitesHeading = () => `${inWords(SITE_COUNT)} sites, one front door`;
/** A tagline as the start of a sentence: a period only when it does not already end one ("What should we eat?"). */
const asSentence = (t) => (/[.!?…]$/.test(String(t).trim()) ? String(t).trim() : `${String(t).trim()}.`);

// Markup inside a kit section after its grid (the kit closes the section itself); an empty section stays empty.
const inside = (section, extra) => (section && extra ? section.replace(/<\/section>$/, () => `${extra}</section>`) : section);
const chips = (list, cls = '') => (list.length ? `<ul class="home-chips${cls ? ` ${cls}` : ''}">${list.map(([href, title, ic, name]) => `<li><a href="${esc(href)}" title="${esc(title)}">${icon(ic, 22)}${esc(name)}</a></li>`).join('')}</ul>` : '');

// The questions on the page, which its FAQPage JSON-LD repeats word for word: the network's own (its Contracts site
// block, the same answers OpenVibe.Help shows) after the few that only the front door answers.
const FRONT_FAQ = [
    { q: 'Do I need an account to use OpenVibe?', a: 'No. Watching streams, the tools, pastes, the wiki and the blog all work as a guest. An account keeps what should last: your history, themes, VODs and notifications.' },
    { q: 'Is OpenVibe open source?', a: 'Yes. Every OpenVibe service is open source under the OpenVibers organization on GitHub, and the network is run by the people who use it.' },
    { q: 'Can I build an app on OpenVibe?', a: 'Yes. OpenVibe.Services gives you projects, apps, keys and the API docs of every service, and your users sign in with their OpenVibe account through OAuth 2.0 or FedCM.' },
];
function faqPairs() {
    const m = contracts.services.get('network');
    const own = ((m && m.site && m.site.faq) || []).filter((f) => f && f.question && f.answer).map((f) => ({ q: f.question, a: f.answer }));
    const seen = new Set();
    return [FRONT_FAQ[0], ...own, ...FRONT_FAQ.slice(1)].filter((p) => !seen.has(p.q) && seen.add(p.q));
}

// Below the static hero (public/index.html: the intent picker and the constellation), every section is the shared
// showcase kit, as on the other flagship homes (plan T11, D93); the data and every link are the ones this page had.
function body(catalog, act) {
    const byId = new Map(catalog.tools.map((t) => [t.id, t]));
    const popular = POPULAR.map((id) => byId.get(id)).filter(Boolean);
    const fams = catalog.families.filter((f) => f.url);
    const count = (f) => f.count || catalog.tools.filter((t) => t.family === f.id).length;
    // The service map: every open place under the launcher's groups (server/frame/sites.js GROUPS), so the cards read
    // as the same eight groups, in the same order, as the menu. Pics and Download are list entries beside Video;
    // Media, Homes and Bench are merged sections and have no tile. /sites has the long descriptions.
    const groups = GROUPS.map((g) => ({
        name: g.name,
        items: OPEN.filter((site) => groupOf(site.id) === g.id).map((site) => ({ icon: `ov:${site.icon}`, name: site.name, text: `${siteName(site)}: ${site.tagline || site.what}`, href: `https://${site.host}/` })),
    })).filter((g) => g.items.length);
    const sites = showcase.apps({
        id: 'network', title: sitesHeading(),
        lede: 'Stream, chat, build, share, play, write and store. Everything is open to visitors; signing in once carries your name, theme and notifications to all of it.',
        groups, more: { href: '/sites', label: `All ${SITE_COUNT} sites, grouped by what you came to do` },
    });
    // The first two neighbourhoods show; the rest fold (a phone saw 48 tiles in eight groups, two screens of the front door).
    const foldSites = (html) => {
        const heads = [...html.matchAll(/<h3 class="sc-apps-group">/g)].map((m) => m.index);
        const end = html.indexOf('<p class="sc-apps-more">');
        if (heads.length < 3 || end < heads[2]) return html;
        return `${html.slice(0, heads[2])}<details class="home-fold home-fold-sites"><summary>Every other neighbourhood<span>${heads.length - 2} more</span></summary><div>${html.slice(heads[2], end)}</div></details>${html.slice(end)}`;
    };
    const families = inside(showcase.features({
        id: 'tools-families', title: catalog.tools.length ? `${catalog.tools.length} tools that just open` : 'Tools that just open',
        lede: 'No installs and no sign-up wall. Every tool has its own short address, so yt.openvibe.tools or dns.openvibe.tools takes you straight there.',
        items: fams.length ? fams.map((f) => ({ icon: `ov:${f.icon}`, title: f.name, text: `${count(f)} ${count(f) === 1 ? 'tool' : 'tools'} · ${f.tagline || ''}`, href: f.path ? `https://openvibe.tools${f.path}` : f.url }))
            : [{ icon: 'ov:tools', title: 'OpenVibe.Tools', text: 'Converters, downloaders, PDF and image tools, developer utilities and network diagnostics.', href: 'https://openvibe.tools/' }],
    }), '');
    const tools = `<section class="sc-sec" id="tools" aria-labelledby="h-tools"><h2 id="h-tools" class="ovk-titled">${sectionIcon('grid')}${esc(catalog.tools.length ? `${catalog.tools.length} tools that just open` : 'Tools that just open')}</h2><p class="sc-lede">No installs and no sign-up wall. Every tool has its own short address, so yt.openvibe.tools or dns.openvibe.tools takes you straight there.</p>${chips(popular.map((t) => [t.url, t.tagline || '', t.icon, t.name]))}
${fams.length ? `<details class="home-fold"><summary>Every kind of tool<span>${esc(fams.length)} families</span></summary>${families.replace(/<h2[^>]*>[\s\S]*?<\/h2>/, '').replace(/<p class="sc-lede">[\s\S]*?<\/p>/, '')}</details>` : ''}<p class="home-more"><a href="https://openvibe.tools/">Browse every tool at openvibe.tools →</a> · <a href="https://yt.openvibe.tools/">yt.openvibe.tools</a> · <a href="https://dns.openvibe.tools/">dns.openvibe.tools</a></p></section>`;
    // What signing in adds: one list, a line each (cards made it two screens on a phone).
    const account = `<section class="sc-sec" id="account" aria-labelledby="h-account"><h2 id="h-account" class="ovk-titled">${sectionIcon('members')}What signing in adds</h2><p class="sc-lede">You can use almost everything as a guest. An account is for the things that need to remember you, and it works on every OpenVibe site the moment you arrive.</p>
<ul class="home-rows">${ACCOUNT.map(([ic, title, text, href]) => `<li><a href="${esc(href)}">${icon(`ov:${ic}`, 22)}<span><b>${esc(title)}</b><small>${esc(text)}</small></span></a></li>`).join('')}</ul></section>`;
    // The sites still to open stay a quiet row of chips, not cards: they are addresses, not places to go yet.
    const soon = SOON.length ? `<section class="sc-sec" id="soon" aria-labelledby="h-soon"><h2 id="h-soon" class="ovk-titled">${sectionIcon('grid')}Opening next</h2><p class="sc-lede">${esc(inWords(SOON.length))} more addresses are staked out. Each one opens when it is good enough to use daily, and your account will already work there.</p>
${chips(SOON.map((site) => [`https://${site.host}/`, site.tagline, site.icon, siteName(site)]), 'soon')}</section>` : '';
    const devCards = inside(showcase.features({
        id: 'developers', title: 'For developers and crawlers',
        lede: 'OpenVibe is open source and community-run. Everything public is meant to be read by machines too.',
        items: [
            { icon: 'ov:code', title: 'Build on OpenVibe', text: 'Sign in with OpenVibe (OAuth 2.0 and FedCM), the API, SDK and webhooks: all on OpenVibe.Services.', href: 'https://openvibe.services/' },
            { icon: 'ov:tools', title: 'Tool catalog', text: 'Every tool with its description, keywords and addresses as JSON.', href: 'https://openvibe.tools/api/catalog.json' },
            { icon: 'ov:blog', title: 'llms.txt', text: 'A plain-text map of the network for AI assistants, with the full text beside it.', href: '/llms.txt' },
            { icon: 'fa-code-branch', title: 'Source on GitHub', text: 'Every OpenVibe service is open source under the OpenVibers organization.', href: 'https://github.com/OpenVibers' },
        ],
    }), '<p class="home-more">Machine-readable: <a href="/llms.txt">/llms.txt</a> · <a href="/llms-full.txt">/llms-full.txt</a> · <a href="https://openvibe.tools/llms.txt">openvibe.tools/llms.txt</a></p>');
    const dev = `<section class="sc-sec home-dev" id="developers" aria-label="For developers"><details class="home-fold"><summary>For developers and crawlers<span>API, SDK, llms.txt, source</span></summary>${devCards.replace(/^<section[^>]*>/, '<div>').replace(/<\/section>$/, '</div>')}</details></section>`;
    const faq = `<section class="sc-sec" id="faq" aria-labelledby="h-faq"><h2 id="h-faq" class="ovk-titled">${sectionIcon('help')}Questions people ask</h2><p class="sc-lede">The short answers. Every OpenVibe site has its own page of answers on OpenVibe.Help.</p>
<div class="faq-grid">${faqPairs().map((p, i) => `<details class="faq-item"${i === 0 ? ' open' : ''}><summary><h3 class="ovk-titled">${sectionIcon('help')}${esc(p.q)}</h3></summary><p>${esc(p.a)}</p></details>`).join('')}</div><p class="home-more"><a href="https://openvibe.help/sites/openvibe.network">More answers about your account on OpenVibe.Help →</a></p></section>`;
    return `<style>${CSS}</style>
${rightNow(act)}
${popularNow()}
${foldSites(sites)}
${moreParts([['tools', 'Tools', tools], ['account', 'Your account', account], ['soon', 'Opening next', soon], ['faq', 'Questions', faq], ['developers', 'Developers', dev]])}`;
}

// What an AI reader is told the page is (openvibe-shared/seo pageSummary): the meta, a WebPage JSON-LD tag and a
// noscript facts block. Only what is true right now: the open sites and the catalog's own count and date.
function summaryOf(catalog) {
    return seo.pageSummary({
        title: 'OpenVibe.Network',
        summary: `One account for ${SITE_COUNT} open sites (this front door, ${OPEN.map((site) => SHORT(site).toLowerCase()).join(', ')}), free, open source and community run.`,
        url: 'https://openvibe.network/',
        facts: [['Open sites', SITE_COUNT], ['Opening next', SOON.length], ...(catalog.tools.length ? [['Online tools', catalog.tools.length]] : [])],
        updated: catalog.tools.length ? String(catalog.updated).slice(0, 10) : undefined,
    });
}

let pageCache = { key: '', html: '', etag: '' };
// releaseId: the served release (server/index.js release.release), the boost marker; it keys the cache so a deploy changes the ETag.
/**
 * The Organization's sameAs (SEO-27): its profiles, then every open site, so the entity search engines build for
 * OpenVibe names all of them. The shell's static list named 15 of 55; this follows frame/sites as the home does.
 */
const SAME_AS = [...new Set(['https://github.com/OpenVibers', 'https://discord.gg/M6MuRUaeJj', ...OPEN.map((site) => `https://${site.host}`)])];
function withSameAs(html) {
    return html.replace(/("@id":"https:\/\/openvibe\.network\/#org"[^]*?"sameAs":)\[[^\]]*\]/, (_, head) => `${head}${JSON.stringify(SAME_AS)}`);
}

function render({ releaseId = '' } = {}) {
    const { catalog } = toolsCatalog.peek();
    const act = activity.peek();
    const popular = homePopular.peek();
    const stat = fs.statSync(SHELL);
    const key = `${stat.mtimeMs}:${catalog.updated}:${catalog.tools.length}:${act.version}:${popular.source}:${popular.generated_at || ''}:${(popular.items || []).map((i) => i.id).join(',')}:${releaseId}`;
    if (pageCache.key === key) return pageCache;
    // The network as one entity (SEO-31): a WebSite whose sitelinks search is the network's own search service, so a
    // search box in a Google result searches OpenVibe rather than the wider web. The description is true of today.
    const ld = seo.jsonLdTag(seo.jsonLd.website({
        name: 'OpenVibe.Network',
        url: 'https://openvibe.network/',
        description: `The front door to the OpenVibe network: one free account across ${SITE_COUNT} open sites — live streaming, tools, chat, games, a wiki, news, deals and an open developer platform.`,
        searchUrl: 'https://search.openvibe.network/?q={q}',
    })) + seo.jsonLdTag(seo.jsonLd.itemList(sitesHeading(), OPEN.map((site) => ({ name: siteName(site), url: `https://${site.host}/`, description: site.what })))) + seo.jsonLdTag(seo.jsonLd.faq(faqPairs()));
    const card = social.url('network', 'https://openvibe.network/shared') || 'https://openvibe.network/assets/logo-512.png';
    const summary = summaryOf(catalog);
    const html = withSameAs(lookBoot.apply(fs.readFileSync(SHELL, 'utf8'))).replace('<div id="navbar-mount"></div>', '<div id="navbar-mount"></div>' + summary.body + require('openvibe-shared/frame').noscriptNav({ name: 'OpenVibe.Network', links: [{ label: 'Sign in', href: '/login' }, { label: 'Themes', href: '/themes' }] })).replace('<h1>Go live, chat, play<br><span class="grad">and get things done.</span></h1>', () => kit.pageHead({ title: 'Go live, chat, play and get things done.', icon: 'home', lede: 'Your places, people and projects across OpenVibe.' })).replace('<!--OV:HOME-->', body(catalog, act)).replace('<!--OV:INTENTS-->', intents(catalog, act.popularity)).replace('<!--OV:CONSTELLATION-->', () => orbit() + numbers(catalog, act)).replaceAll('__OV_CARD__', card).replace('<!--OV:SITES-->', String(SITE_COUNT)).replace('<!--OV:COUNT-->', catalog.tools.length ? String(catalog.tools.length) : 'free').replace('<div id="ov-footer"></div>', require('openvibe-shared/footer').ssr({ service: 'network', variant: 'full' })).replace('</head>', () => `${ld}\n<link rel="stylesheet" href="${require('openvibe-shared/serve').url('kit.css')}"><script src="${require('openvibe-shared/serve').url('kit-web.js')}" defer></script>\n${summary.head}\n${boost.meta(releaseId)}\n</head>`);
    pageCache = { key, html, etag: '"' + crypto.createHash('sha1').update(html).digest('base64url').slice(0, 20) + '"' };
    return pageCache;
}

function sendHome(req, res, { releaseId = '' } = {}) {
    toolsCatalog.getCatalog().catch(() => {});     // refresh in the background; this response uses what is known now
    const page = render({ releaseId });
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', cache.htmlHeaders({ maxAge: 120 }));
    res.set('ETag', page.etag);
    if (req.headers['if-none-match'] === page.etag) return res.status(304).end();
    res.send(page.html);
}

// What OpenVibe is, said so an AI cannot mistake it (the owner, 2026-10-28: Google's AI Overview for "whois openvibe"
// described an unrelated "Openvibe" mobile app): the network, what is on it, and what it is not.
const llmsSummary = () => `OpenVibe (openvibe.network, made by OpenVibers) is an open source, community-run network of websites that share one free account: ${OPEN.map((site) => site.name.toLowerCase()).join(', ')}. It is not the Openvibe mobile social-media aggregator app, which is unrelated.`;

// The person's own account ID (the canonical usr_… subject id): what apps and robots ask for.
// GET /api/auth/me answers it for the signed-in person; a person reads it on their account page (/my).
const ACCOUNT_ID_LINK = {
    title: 'Your account ID: GET /api/auth/me → user.subject_id',
    url: 'https://openvibe.network/api/auth/me',
    note: 'the caller\'s own usr_… id: the account id apps and robots ask for. A person sees their own on their account page (openvibe.network/my); nobody else can read it',
};
const ACCOUNT_ID_TEXT = 'GET /api/auth/me with a person\'s token answers { user: { subject_id: "usr_…" } }. That usr_… value is the person\'s OpenVibe account ID: what apps and robots ask for when they ask for someone\'s OpenVibe account ID. A person sees their own on their account page (https://openvibe.network/my); nobody else can read it.';
// A path with a variable is a route to call, not a page to fetch: it is written as code in llms.txt, never as a
// Markdown link, so an agent (or a checker doing a GET) does not ask for the literal @handle address.
const API_ROUTE_TEXT = 'API routes with a variable in the path are code, not pages to fetch: `GET /api/v1/people/@handle/page` is the signed-out profile at https://openvibe.network/@handle, including its public OpenVibe places.';

function llmsTxt() {
    const { catalog } = toolsCatalog.peek();
    return seo.llmsTxt({ name: 'OpenVibe Network', summary: llmsSummary(), details: API_ROUTE_TEXT, markdown: true, base: 'https://openvibe.network',
        sections: [
            { title: 'Sites', links: OPEN.map((site) => ({ title: siteName(site), url: `https://${site.host}/`, note: site.what })) },
            // A person's account ID: the endpoint an agent needs when it works for someone.
            { title: 'Your account ID', links: [ACCOUNT_ID_LINK] },
            // Link, on its own front door: the piece the network is built around, with its own map.
            { title: 'Link', links: [
                { title: 'OpenVibe Link: your machines, connected', url: 'https://openvibe.link/',
                    note: 'one program on your computer, server, phone or robot: run your agents and code on it, offer your models or GPU to the network and earn credits, drive robots, and keep your memory read-only' },
                { title: 'Install Link', url: 'https://openvibe.link/install',
                    note: 'the installer of the latest release, as a script to run: curl -fsSL https://openvibe.link/install | sh' },
            ] },
            // The JSON an agent came for is a main section, not something to skip (AGT-5 review).
            { title: 'Machine-readable', links: [
                { title: 'Open stats (JSON): every site\'s numbers', url: 'https://openvibe.network/api/v1/stats' },
                { title: 'Trust signals (developer docs)', url: 'https://openvibe.network/docs/trust-signals', note: 'privacy-limited account and guest trust signals, API examples and fields' },
                { title: 'OpenVibe Connect MCP', url: 'https://connect.openvibe.network/mcp', note: 'includes network.person_page.read and network.my_trust.read' },
                { title: 'Tool catalog (JSON)', url: 'https://openvibe.tools/api/catalog.json' },
                { title: 'Tool domains (JSON)', url: 'https://openvibe.network/api/domains' },
            ] },
            // The Locker key directory (design 2026-11-06): the public keys of a person, and what Network
            // holds of a locker. The curl is here, so an agent can look a person's public key up.
            { title: 'Locker keys', links: [
                { title: 'Locker keys: a person\'s public keys and fingerprint', url: 'https://github.com/OpenVibers/OpenVibe.Network/blob/main/README.md#locker-keys',
                    note: 'Network holds the public keys, a self-signature and the wrapped private keys, and can never read a private key. Changing the keys needs a signature from the key the person has now. Look one up with: curl -s -H "Authorization: Bearer $TOKEN" https://openvibe.network/api/v1/people/@maticus/keys' },
                { title: 'The Locker library and the envelope format (openvibe-sdk/locker)', url: 'https://github.com/OpenVibers/OpenVibe.SDK/blob/main/docs/locker.md',
                    note: 'how a locked item is sealed and opened, the three locks, and what a service may do with an envelope it cannot read' },
            ] },
        ],
        optional: [
            ...catalog.families.filter(f => f.url).map(f => ({ title: f.name, url: f.path ? 'https://openvibe.tools' + f.path : f.url, note: f.tagline })),
            { title: 'Tools llms.txt', url: 'https://openvibe.tools/llms.txt' },
        ].filter((l) => l.url) });
}

// /llms-full.txt: the public pages the sitemap lists (server/seo/routes.js PAGES), each with its text.
const LLMS_PAGE_TEXT = {
    '/': () => ['One OpenVibe account signs you in on every site:', ...OPEN.map((site) => `- ${siteName(site)} (https://${site.host}/): ${site.what}`)].join('\n'),
    '/updates': () => "Every change deployed to the OpenVibe network, newest first: each site's commits as they ship, and the Patch notes posts that gather them.",
    '/stats': () => "Open stats: page views, people, streams, OpenCoins and how fast each service answers, for every OpenVibe site, public and reusable as JSON (https://openvibe.network/api/v1/stats) or CSV. Counts only, never about a person.",
    '/sites': () => require('../sites/page').llmsText(),
    '/bot': () => 'OpenVibeBot, OpenVibe\'s crawler: its user agent, what it reads (sitemaps, feeds, schema.org JSON-LD), what it obeys (robots.txt for OpenVibeBot or OpenVibeSources, Crawl-delay, noindex, Retry-After), and how to block it, slow it or offer a feed instead. As JSON: https://openvibe.network/bot.json',
    '/terms': () => 'The rules for using OpenVibe.Network, in plain language.',
    '/privacy': () => 'What OpenVibe.Network collects, why, and the choices you have.',
    '/dmca': () => 'How to report copyright infringement on OpenVibe.Network, and how to respond to a report.',
};
const LLMS_PAGE_TITLE = { '/': 'OpenVibe.Network', '/updates': 'Updates', '/stats': 'Open stats', '/sites': 'All the sites', '/bot': 'OpenVibeBot', '/terms': 'Terms of Service', '/privacy': 'Privacy Policy', '/dmca': 'DMCA' };
const LLMS_FULL_MAX_BYTES = 512 * 1024;

function llmsFullTxt({ baseUrl = 'https://openvibe.network' } = {}) {
    const pages = require('../seo/routes').PAGES.filter((page) => LLMS_PAGE_TEXT[page.path])
        .map((page) => ({ title: LLMS_PAGE_TITLE[page.path], url: page.path, text: LLMS_PAGE_TEXT[page.path]() }));
    return seo.llmsFull({ site: 'OpenVibe Network', summary: llmsSummary(), base: baseUrl, maxBytes: LLMS_FULL_MAX_BYTES,
        sections: [{ title: 'Pages', pages }, { title: 'Your account ID', url: ACCOUNT_ID_LINK.url, body: ACCOUNT_ID_TEXT }] });
}

module.exports = { SAME_AS, withSameAs, sendHome, render, llmsTxt, llmsFullTxt, LLMS_FULL_MAX_BYTES, INTENTS };
