'use strict';
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

const SHELL = path.join(__dirname, '..', '..', 'public', 'index.html');
const esc = seo.esc;
const icon = (name, size) => `<span class="ov-icon" data-icon="${esc(name)}" data-ovi="${esc(icons.resolve(name))}" data-fx="none" style="--ovi-size:${size}px" aria-hidden="true">${icons.svg(name)}</span>`;

// The sites come from the frame's list (server/frame/sites.js): a site is open only when its service's
// public domain serves the service itself (Network's exposure overlay), so the home page, the navbar and
// "Opening next" always agree with what is actually running.
const frameSites = require('../frame/sites').SITES;
const siteName = (site) => (site.name.includes('.') ? site.name : `OpenVibe.${site.name}`);
const OPEN = frameSites.filter((site) => site.status === 'open' && site.id !== 'network');
const SOON = frameSites.filter((site) => site.status !== 'open');
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
    ['live', 'fa-tower-broadcast', 'Go live', 'From a browser tab. No OBS, no follower minimum.', 'https://openvibe.live/broadcast', 'go live stream streaming broadcast camera webcam screen obs whip rtmp twitch'],
    ['tools', 'fa-screwdriver-wrench', 'Get something done', '', 'https://openvibe.tools/', 'tool tools convert pdf mp3 mp4 video audio image compress resize dns whois json regex download youtube'],
    ['chat', 'fa-comments', 'Chat', 'One room for the whole network, plus rooms and messages.', 'https://openvibe.chat/', 'chat talk message messages dm room rooms friends'],
    ['paste', 'fa-paste', 'Share a paste', 'Text, code or a screenshot behind one short link.', 'https://openvibe.community/new', 'paste share code snippet text link screenshot pastebin gist'],
    ['games', 'fa-gamepad', 'Play', 'Browser games that already know you.', 'https://openvibe.games/', 'play game games gaming multiplayer'],
    ['blog', 'fa-pen-nib', 'Write', 'A blog of your own, with drafts, scheduling and feeds.', 'https://openvibe.blog/write', 'write blog post posts article publish newsletter'],
    ['wiki', 'fa-book-open', 'Look it up', 'Wiki pages with sources and history.', 'https://openvibe.wiki/', 'wiki learn read knowledge research look'],
    ['services', 'fa-server', 'Build on OpenVibe', 'One console for projects, keys, grants and the API docs of every service.', 'https://openvibe.services/', 'build api sdk developer developers oauth webhook webhooks app integrate console platform'],
    ['codes', 'fa-code', 'Code with any agent', 'Claude Code, Codex, OpenCode or your own model on one task, with hand-offs.', 'https://openvibe.codes/', 'code coding agent agents ai claude codex opencode deepseek harness contribute'],
    ['actor', 'fa-user-astronaut', 'Give a task to an agent', 'Actor picks the best agent for it, checks the answer and shows the cost and why.', 'https://openvibe.actor/', 'agent agents ai assistant task tasks automate research router openrouter do it for me'],
];

function intents(catalog) {
    const toolsLine = catalog.tools.length ? `Convert, compress, look up or download: ${catalog.tools.length} tools that just open.` : 'Convert, compress, look up or download: free tools that just open.';
    return `<ul class="intents" aria-label="What you can do here">${INTENTS.map(([id, fa, verb, line, href, k]) => `<li><a class="intent" href="${esc(href)}" data-id="${esc(id)}" data-k="${esc(k)}"><i class="fa-solid ${esc(fa)}" aria-hidden="true"></i><span><b>${esc(verb)}</b><small>${esc(line || toolsLine)}</small></span></a></li>`).join('')}</ul>`;
}

// The network as a constellation: open sites on the inner ring, the ones opening next faint on the outer ring.
const SHORT = (site) => (/^OpenRe\./.test(site.name) ? 'OpenRe' : site.name.replace(/^OpenVibe\./, ''));
function constellation() {
    const ring = (list, r, start) => list.map((site, i) => {
        const a = start + (i / list.length) * Math.PI * 2;
        return { site, x: Math.round(Math.cos(a) * r), y: Math.round(Math.sin(a) * r) };
    });
    const inner = ring(OPEN, 118, -Math.PI / 2);
    const outer = ring(SOON, 176, -Math.PI / 2 + Math.PI / SOON.length);
    const lines = inner.map((n, i) => {
        const m = inner[(i + 1) % inner.length];
        return `<line class="cs-spoke" x1="0" y1="0" x2="${n.x}" y2="${n.y}"/><line class="cs-arc" x1="${n.x}" y1="${n.y}" x2="${m.x}" y2="${m.y}"/>`;
    }).join('');
    const label = (n, r) => { const dx = n.x / (Math.hypot(n.x, n.y) || 1), dy = n.y / (Math.hypot(n.x, n.y) || 1); return { x: Math.round(n.x + dx * r), y: Math.round(n.y + dy * r) + 4, anchor: Math.abs(dx) < 0.25 ? 'middle' : (dx > 0 ? 'start' : 'end') }; };
    const openNodes = inner.map((n, i) => { const l = label(n, 17); return `<a href="https://${esc(n.site.host)}/" class="cs-node" style="--d:${(i * 0.37).toFixed(2)}s"><title>${esc(siteName(n.site))}: ${esc(n.site.tagline)}</title><circle class="cs-halo" cx="${n.x}" cy="${n.y}" r="11"/><circle class="cs-star" cx="${n.x}" cy="${n.y}" r="5"/><text x="${l.x}" y="${l.y}" text-anchor="${l.anchor}">${esc(SHORT(n.site))}</text></a>`; }).join('');
    const soonNodes = outer.map((n) => { const l = label(n, 9); return `<a href="https://${esc(n.site.host)}/" class="cs-node cs-soon"><title>${esc(siteName(n.site))} — opening next</title><circle class="cs-star" cx="${n.x}" cy="${n.y}" r="2.6"/><text x="${l.x}" y="${l.y}" text-anchor="${l.anchor}">${esc(SHORT(n.site))}</text></a>`; }).join('');
    return `<svg class="constellation" viewBox="-230 -215 460 430" role="img" aria-labelledby="cs-t"><title id="cs-t">The OpenVibe network: ${OPEN.length} open sites around one account, ${SOON.length} more opening next</title>
<defs><radialGradient id="cs-core"><stop offset="0" stop-color="var(--accent-light,#60a5fa)"/><stop offset="1" stop-color="var(--accent,#3b82f6)" stop-opacity="0"/></radialGradient></defs>
<circle class="cs-orbit" r="118"/><circle class="cs-orbit cs-far" r="176"/>${lines}
<circle r="46" fill="url(#cs-core)" opacity=".35"/><circle class="cs-core" r="24"/><text class="cs-core-t" y="4" text-anchor="middle">you</text>
${openNodes}${soonNodes}</svg>`;
}

const fmtViewers = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
function rightNow(a) {
    const live = a.live.length
        ? a.live.map((s) => `<a class="now-stream" href="${esc(s.url)}">${s.thumb || s.avatar ? `<img src="${esc(s.thumb || s.avatar)}" alt="" loading="lazy" decoding="async" width="320" height="180"${s.thumb && s.avatar ? ` data-fallback="${esc(s.avatar)}" onerror="this.onerror=null;this.src=this.dataset.fallback"` : ''}>` : '<span class="now-noimg"></span>'}<span class="now-badge"><i></i>LIVE${s.viewers ? ` · ${esc(fmtViewers(s.viewers))}` : ''}</span><b>${esc(s.title)}</b><small>${esc(s.name)}${s.category ? ` · ${esc(s.category)}` : ''}</small></a>`).join('')
        : `<a class="now-stream now-empty" href="https://openvibe.live/broadcast"><span class="now-noimg"><i class="fa-solid fa-tower-broadcast" aria-hidden="true"></i></span><b>Nobody is live right now</b><small>Be the first: go live from your browser, no OBS and no follower minimum.</small></a>`;
    const list = (items, render, empty) => (items.length ? `<ul class="now-list">${items.map(render).join('')}</ul>` : `<p class="now-quiet">${empty}</p>`);
    return `<section class="sc-sec now" aria-labelledby="h-now"><h2 id="h-now"><span class="now-dot" aria-hidden="true"></span>Right now on OpenVibe</h2>
<div class="now-grid"><div class="now-col now-live"><h3>Live</h3><div class="now-streams">${live}</div><a class="now-more" href="https://openvibe.live/">All channels →</a></div>
<div class="now-col"><h3>New pastes</h3>${list(a.pastes, (p) => `<li><a href="${esc(p.url)}"><b>${esc(p.title)}</b><small>${esc(p.kind)}${p.summary ? ` · ${esc(p.summary)}` : ''}</small></a></li>`, 'Nothing new in the last while. <a href="https://openvibe.community/new">Share one</a>.')}<a class="now-more" href="https://openvibe.community/">OpenVibe.Community →</a></div>
<div class="now-col"><h3>From the blog</h3>${list(a.posts, (p) => `<li><a href="${esc(p.url)}"><b>${esc(p.title)}</b>${p.summary ? `<small>${esc(p.summary)}</small>` : ''}</a></li>`, 'No posts yet.')}<a class="now-more" href="https://openvibe.blog/">OpenVibe.Blog →</a></div></div></section>`;
}

// The kit (openvibe-shared/showcase, /shared/showcase.css) owns the sections, cards and icon styles; this is only what
// it does not draw: the "Right now" columns and the tool and "Opening next" chips.
const CSS = `
#developers{margin-bottom:56px}#developers .sc-grid{grid-template-columns:repeat(auto-fill,minmax(220px,1fr))}
.home-chips{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0 0;padding:0;list-style:none}
.home-chips>li>a{display:inline-flex;align-items:center;gap:7px;padding:6px 12px 6px 7px;border-radius:999px;border:1px solid var(--border,rgba(255,255,255,.1));font-size:13.5px;font-weight:600;color:inherit;text-decoration:none}
.home-chips>li>a:hover,.home-chips>li>a:focus-visible{border-color:var(--accent,#3b82f6);outline:0}
.home-chips.soon>li>a{color:var(--text-secondary,#a8b3c4);border-style:dashed}
.home-more{margin:14px 0 0;font-size:13.5px}.home-more a{font-weight:600;color:var(--accent-light,#60a5fa);text-decoration:none}
.now>h2{display:flex;align-items:center;gap:10px}.now-dot{width:10px;height:10px;border-radius:50%;background:var(--live-red,#ef4444);box-shadow:0 0 0 0 rgba(239,68,68,.6);animation:now-pulse 2s infinite}
@keyframes now-pulse{70%{box-shadow:0 0 0 10px rgba(239,68,68,0)}100%{box-shadow:0 0 0 0 rgba(239,68,68,0)}}
.now-grid{display:grid;gap:16px;grid-template-columns:repeat(3,minmax(0,1fr));margin-top:14px}
.now-col{display:flex;flex-direction:column;gap:10px;padding:16px;border-radius:16px;border:1px solid var(--border,rgba(255,255,255,.08));background:var(--bg-secondary,#111826);min-width:0}
.now-col h3{font-size:12px;font-weight:800;letter-spacing:.7px;text-transform:uppercase;color:var(--text-muted,#7d8aa0);margin:0}
.now-streams{display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(140px,1fr))}
.now-stream{position:relative;display:flex;flex-direction:column;gap:3px;color:inherit;text-decoration:none;min-width:0}
.now-stream img,.now-noimg{width:100%;aspect-ratio:16/9;height:auto;object-fit:cover;border-radius:10px;background:var(--bg-hover,#1c2a44);display:grid;place-items:center;font-size:26px;color:var(--accent-light,#60a5fa)}
.now-stream b{font-size:14px;line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.now-stream small{color:var(--text-secondary,#a8b3c4);font-size:12.5px}
.now-stream:hover b,.now-list a:hover b{color:var(--accent-light,#60a5fa)}
.now-badge{position:absolute;top:8px;left:8px;display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:6px;background:var(--live-red,#ef4444);color:#fff;font-size:11px;font-weight:800;letter-spacing:.4px}
.now-badge i{width:6px;height:6px;border-radius:50%;background:#fff}
.now-empty .now-noimg{border:1px dashed var(--border-light,#2c3d5c);background:transparent}
.now-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}
.now-list a{display:block;color:inherit;text-decoration:none}.now-list b{display:block;font-size:14px;line-height:1.35}
.now-list small{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;color:var(--text-secondary,#a8b3c4);font-size:12.5px;line-height:1.4;margin-top:2px}
.now-quiet{color:var(--text-muted,#7d8aa0);font-size:13.5px;margin:0}.now-quiet a{color:var(--accent-light,#60a5fa)}
.now-more{margin-top:auto;font-size:13px;font-weight:600;color:var(--accent-light,#60a5fa);text-decoration:none}
@media (max-width:860px){.now-grid{grid-template-columns:1fr}}
@media (prefers-reduced-motion:reduce){.now-dot{animation:none}}
${icons.CSS}`;

// The sites section's heading; the JSON-LD ItemList of the same sites carries it as its name, so the
// structured data names something a visitor can see (browser check, WS-Q task 3).
const sitesHeading = () => `${inWords(OPEN.length)} sites, one front door`;

// Markup inside a kit section after its grid (the kit closes the section itself); an empty section stays empty.
const inside = (section, extra) => (section && extra ? section.replace(/<\/section>$/, () => `${extra}</section>`) : section);
const chips = (list, cls = '') => (list.length ? `<ul class="home-chips${cls ? ` ${cls}` : ''}">${list.map(([href, title, ic, name]) => `<li><a href="${esc(href)}" title="${esc(title)}">${icon(ic, 22)}${esc(name)}</a></li>`).join('')}</ul>` : '');

// Below the static hero (public/index.html: the intent picker and the constellation), every section is the shared
// showcase kit, as on the other flagship homes (plan T11, D93); the data and every link are the ones this page had.
function body(catalog, act) {
    const byId = new Map(catalog.tools.map((t) => [t.id, t]));
    const popular = POPULAR.map((id) => byId.get(id)).filter(Boolean);
    const fams = catalog.families.filter((f) => f.url);
    const count = (f) => f.count || catalog.tools.filter((t) => t.family === f.id).length;
    const sites = showcase.features({
        id: 'network', title: sitesHeading(),
        lede: 'Stream, chat, build, share, play, write and store. Everything is open to visitors; signing in once carries your name, theme and notifications to all of it.',
        items: OPEN.map((site) => ({ icon: `ov:${site.icon}`, title: siteName(site), text: site.tagline ? `${site.tagline}. ${site.what}` : site.what, href: `https://${site.host}/` })),
    });
    const tools = inside(showcase.features({
        id: 'tools', title: catalog.tools.length ? `${catalog.tools.length} tools that just open` : 'Tools that just open',
        lede: 'No installs and no sign-up wall. Every tool has its own short address, so yt.openvibe.tools or dns.openvibe.tools takes you straight there.',
        items: fams.length ? fams.map((f) => ({ icon: `ov:${f.icon}`, title: f.name, text: `${count(f)} tools · ${f.tagline || ''}`, href: f.path ? `https://openvibe.tools${f.path}` : f.url }))
            : [{ icon: 'ov:tools', title: 'OpenVibe.Tools', text: 'Converters, downloaders, PDF and image tools, developer utilities and network diagnostics.', href: 'https://openvibe.tools/' }],
    }), `${chips(popular.map((t) => [t.url, t.tagline || '', t.icon, t.name]))}<p class="home-more"><a href="https://openvibe.tools/">Browse every tool at openvibe.tools →</a> · <a href="https://yt.openvibe.tools/">yt.openvibe.tools</a> · <a href="https://dns.openvibe.tools/">dns.openvibe.tools</a></p>`);
    const account = showcase.features({
        id: 'account', title: 'What signing in adds',
        lede: 'You can use almost everything as a guest. An account is for the things that need to remember you, and it works on every OpenVibe site the moment you arrive.',
        items: ACCOUNT.map(([ic, title, text, href]) => ({ icon: `ov:${ic}`, title, text, href })),
    });
    // The sites still to open stay a quiet row of chips, not cards: they are addresses, not places to go yet.
    const soon = SOON.length ? `<section class="sc-sec" id="soon" aria-labelledby="h-soon"><h2 id="h-soon">Opening next</h2><p class="sc-lede">${esc(inWords(SOON.length))} more addresses are staked out. Each one opens when it is good enough to use daily, and your account will already work there.</p>
${chips(SOON.map((site) => [`https://${site.host}/`, site.tagline, site.icon, siteName(site)]), 'soon')}</section>` : '';
    const dev = inside(showcase.features({
        id: 'developers', title: 'For developers and crawlers',
        lede: 'OpenVibe is open source and community-run. Everything public is meant to be read by machines too.',
        items: [
            { icon: 'ov:code', title: 'Build on OpenVibe', text: 'Sign in with OpenVibe (OAuth 2.0 and FedCM), the API, SDK and webhooks: all on OpenVibe.Services.', href: 'https://openvibe.services/' },
            { icon: 'ov:tools', title: 'Tool catalog', text: 'Every tool with its description, keywords and addresses as JSON.', href: 'https://openvibe.tools/api/catalog.json' },
            { icon: 'ov:blog', title: 'llms.txt', text: 'A plain-text map of the network for AI assistants, with the full text beside it.', href: '/llms.txt' },
            { icon: 'fa-code-branch', title: 'Source on GitHub', text: 'Every OpenVibe service is open source under the OpenVibers organization.', href: 'https://github.com/OpenVibers' },
        ],
    }), '<p class="home-more">Machine-readable: <a href="/llms.txt">/llms.txt</a> · <a href="/llms-full.txt">/llms-full.txt</a> · <a href="https://openvibe.tools/llms.txt">openvibe.tools/llms.txt</a></p>');
    return `<style>${CSS}</style>
${rightNow(act)}
${sites}
${tools}
${account}
${soon}
${dev}`;
}

// What an AI reader is told the page is (openvibe-shared/seo pageSummary): the meta, a WebPage JSON-LD tag and a
// noscript facts block. Only what is true right now: the open sites and the catalog's own count and date.
function summaryOf(catalog) {
    return seo.pageSummary({
        title: 'OpenVibe.Network',
        summary: `One account for ${OPEN.length} open sites (${OPEN.map((site) => SHORT(site).toLowerCase()).join(', ')}), free, open source and community run.`,
        url: 'https://openvibe.network/',
        facts: [['Open sites', OPEN.length], ['Opening next', SOON.length], ...(catalog.tools.length ? [['Online tools', catalog.tools.length]] : [])],
        updated: catalog.tools.length ? String(catalog.updated).slice(0, 10) : undefined,
    });
}

let pageCache = { key: '', html: '', etag: '' };
function render() {
    const { catalog } = toolsCatalog.peek();
    const act = activity.peek();
    const stat = fs.statSync(SHELL);
    const key = `${stat.mtimeMs}:${catalog.updated}:${catalog.tools.length}:${act.version}`;
    if (pageCache.key === key) return pageCache;
    const ld = seo.jsonLdTag(seo.jsonLd.itemList(sitesHeading(), OPEN.map((site) => ({ name: siteName(site), url: `https://${site.host}/`, description: site.what }))));
    const summary = summaryOf(catalog);
    const html = fs.readFileSync(SHELL, 'utf8').replace('<div id="navbar-mount"></div>', '<div id="navbar-mount"></div>' + summary.body + require('openvibe-shared/frame').noscriptNav({ name: 'OpenVibe.Network', links: [{ label: 'Sign in', href: '/login' }, { label: 'Themes', href: '/themes' }] })).replace('<!--OV:HOME-->', body(catalog, act)).replace('<!--OV:INTENTS-->', intents(catalog)).replace('<!--OV:CONSTELLATION-->', constellation()).replace('<!--OV:COUNT-->', catalog.tools.length ? String(catalog.tools.length) : 'free').replace('<div id="ov-footer"></div>', require('openvibe-shared/footer').ssr({ service: 'network', variant: 'full' })).replace('</head>', `${ld}\n${summary.head}\n</head>`);
    pageCache = { key, html, etag: '"' + crypto.createHash('sha1').update(html).digest('base64url').slice(0, 20) + '"' };
    return pageCache;
}

function sendHome(req, res) {
    toolsCatalog.getCatalog().catch(() => {});     // refresh in the background; this response uses what is known now
    const page = render();
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', cache.htmlHeaders({ maxAge: 120 }));
    res.set('ETag', page.etag);
    if (req.headers['if-none-match'] === page.etag) return res.status(304).end();
    res.send(page.html);
}

const llmsSummary = () => `OpenVibe is an open source, community-run network of sites that share one account: ${OPEN.map((site) => site.name.toLowerCase()).join(', ')}.`;

function llmsTxt() {
    const { catalog } = toolsCatalog.peek();
    return seo.llmsTxt({ name: 'OpenVibe Network', summary: llmsSummary(),
        sections: [{ title: 'Sites', links: OPEN.map((site) => ({ title: siteName(site), url: `https://${site.host}/`, note: site.what })) },
            { title: 'Tool families', links: catalog.families.filter(f => f.url).map(f => ({ title: f.name, url: f.path ? 'https://openvibe.tools' + f.path : f.url, note: f.tagline })) },
            { title: 'Machine-readable', links: [{ title: 'Tool catalog (JSON)', url: 'https://openvibe.tools/api/catalog.json' }, { title: 'Tools llms.txt', url: 'https://openvibe.tools/llms.txt' }, { title: 'Tool domains (JSON)', url: 'https://openvibe.network/api/domains' }] }].filter((section) => section.links.length) });
}

// /llms-full.txt: the public pages the sitemap lists (server/seo/routes.js PAGES), each with its text.
const LLMS_PAGE_TEXT = {
    '/': () => ['One OpenVibe account signs you in on every site:', ...OPEN.map((site) => `- ${siteName(site)} (https://${site.host}/): ${site.what}`)].join('\n'),
    '/status': () => 'Observed status of each OpenVibe service: readiness, release and when it was last checked.',
    '/updates': () => "Every change deployed to the OpenVibe network, newest first: each site's commits as they ship, and the Patch notes posts that gather them.",
    '/terms': () => 'The rules for using OpenVibe.Network, in plain language.',
    '/privacy': () => 'What OpenVibe.Network collects, why, and the choices you have.',
    '/dmca': () => 'How to report copyright infringement on OpenVibe.Network, and how to respond to a report.',
};
const LLMS_PAGE_TITLE = { '/': 'OpenVibe.Network', '/status': 'Status', '/updates': 'Updates', '/terms': 'Terms of Service', '/privacy': 'Privacy Policy', '/dmca': 'DMCA' };
const LLMS_FULL_MAX_BYTES = 512 * 1024;

function llmsFullTxt({ baseUrl = 'https://openvibe.network' } = {}) {
    const pages = require('../seo/routes').PAGES.filter((page) => LLMS_PAGE_TEXT[page.path])
        .map((page) => ({ title: LLMS_PAGE_TITLE[page.path], url: page.path, text: LLMS_PAGE_TEXT[page.path]() }));
    return seo.llmsFull({ site: 'OpenVibe Network', summary: llmsSummary(), base: baseUrl, maxBytes: LLMS_FULL_MAX_BYTES, sections: [{ title: 'Pages', pages }] });
}

module.exports = { sendHome, render, llmsTxt, llmsFullTxt, LLMS_FULL_MAX_BYTES, INTENTS };
