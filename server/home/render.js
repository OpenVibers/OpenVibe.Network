'use strict';
// The openvibe.network home page: the static shell (public/index.html) with the network and the
// tool catalog rendered into it on the server, so the page is complete without JavaScript and
// always matches what openvibe.tools actually offers (catalog via server/domains/catalog.js).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const seo = require('openvibe-shared/seo');
const icons = require('openvibe-shared/icons');
const toolsCatalog = require('../domains/catalog');

const SHELL = path.join(__dirname, '..', '..', 'public', 'index.html');
const esc = seo.esc;
const icon = (name, size) => `<span class="ov-icon" data-icon="${esc(name)}" data-ovi="${esc(icons.resolve(name))}" data-fx="none" style="--ovi-size:${size}px" aria-hidden="true">${icons.svg(name)}</span>`;

const SITES = [
    ['live', 'OpenVibe.Live', 'https://openvibe.live/', 'Live streaming', 'Go live from a browser, OBS or a phone. Restream to other platforms, clip moments, run chat games and keep your VODs.'],
    ['tools', 'OpenVibe.Tools', 'https://openvibe.tools/', 'Online tools', 'Converters, downloaders, PDF and image tools, developer utilities and network diagnostics, each on its own easy address.'],
    ['community', 'OpenVibe.Community', 'https://openvibe.community/', 'Pastes and posts', 'Share text and code with a link, comment, and follow what the people of OpenVibe are making.'],
    ['games', 'OpenVibe.Games', 'https://openvibe.games/', 'Browser games', 'Scraplandia and other games that run in a tab and know your OpenVibe account.'],
    ['media', 'OpenVibe.Media', 'https://openvibe.media/', 'VODs, clips and files', 'The media library behind every site: recorded streams, clips and uploads.'],
];
const SOON = [['chat', 'Chat'], ['codes', 'Codes'], ['blog', 'Blog'], ['wiki', 'Wiki'], ['news', 'News'], ['reviews', 'Reviews'], ['tips', 'Tips'], ['vip', 'VIP'], ['trade', 'Trade'], ['host', 'Host'], ['deals', 'Deals'], ['coupons', 'Coupons']];
const ACCOUNT = [
    ['live', 'Go live and keep your VODs', 'Stream from a browser tab, clip the good parts, earn channel points and restream to other platforms.', 'https://openvibe.live/'],
    ['tools', 'Tool results that stick around', 'Guests keep results for an hour. Signed in, they stay for a day and your recent tools follow you.', 'https://openvibe.tools/'],
    ['account', 'One sign-in', 'Sign in once. Every OpenVibe site recognises you, including the ones you have not visited yet.', '/login'],
    ['theme', 'Themes that follow you', 'Pick or build a theme and every site wears it.', '/themes'],
    ['history', 'History across sites', 'Streams you watched, tools you used and pastes you opened, in one list you control.', '/history'],
    ['bell', 'One notification inbox', 'Alerts from every site in one bell, with optional push.', '/notifications'],
];
const POPULAR = ['yt', 'convert', 'mergepdf', 'jsonfmt', 'mp3', 'dns', 'whois', 'compress', 'fancy', 'ssl', 'logo', 'regex'];

const CSS = `
.home-sec{max-width:1080px;margin:56px auto 0;padding:0 24px}.home-sec>h2{font-size:clamp(22px,2.6vw,30px);letter-spacing:-.02em;margin:0 0 6px}.home-sec>p.lede{color:var(--text-secondary,#a8b3c4);margin:0 0 18px;max-width:760px}
.home-grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(260px,1fr))}
.home-card{display:flex;gap:14px;align-items:flex-start;padding:16px;border-radius:16px;border:1px solid var(--border,rgba(255,255,255,.08));background:var(--bg-secondary,#111826);color:inherit;text-decoration:none;transition:border-color .15s,transform .15s}
.home-card:hover,.home-card:focus-visible{border-color:var(--accent,#3b82f6);transform:translateY(-2px);outline:0}
.home-card b{display:block;font-size:16px}.home-card em{display:block;font-style:normal;font-size:12px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:var(--accent-light,var(--accent,#60a5fa));margin:1px 0 4px}
.home-card small{display:block;color:var(--text-secondary,#a8b3c4);font-size:13.5px;line-height:1.45}
.home-fams{display:grid;gap:10px;grid-template-columns:repeat(auto-fill,minmax(220px,1fr))}
.home-fam{display:flex;gap:12px;align-items:center;padding:12px 14px;border-radius:14px;border:1px solid var(--border,rgba(255,255,255,.08));color:inherit;text-decoration:none}
.home-fam:hover{border-color:var(--accent,#3b82f6)}.home-fam b{display:block;font-size:14.5px}.home-fam small{color:var(--text-muted,#7d8aa0);font-size:12.5px}
.home-chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px;padding:0;list-style:none}
.home-chips>li>a{display:inline-flex;align-items:center;gap:7px;padding:6px 12px 6px 7px;border-radius:999px;border:1px solid var(--border,rgba(255,255,255,.1));font-size:13.5px;font-weight:600;color:inherit;text-decoration:none}
.home-chips>li>a:hover{border-color:var(--accent,#3b82f6)}
.home-dev{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}
.home-dev div{padding:16px;border-radius:16px;border:1px dashed var(--border,rgba(255,255,255,.14))}.home-dev b{display:block;margin-bottom:4px}.home-dev p{margin:0;color:var(--text-secondary,#a8b3c4);font-size:13.5px}.home-dev code{font-size:12.5px}
@media (prefers-reduced-motion:reduce){.home-card{transition:none}}
${icons.CSS}`;

function body(catalog) {
    const byId = new Map(catalog.tools.map(t => [t.id, t]));
    const popular = POPULAR.map(id => byId.get(id)).filter(Boolean);
    const fams = catalog.families.filter(f => f.url);
    const count = (f) => f.count || catalog.tools.filter(t => t.family === f.id).length;
    return `<style>${CSS}</style>
<section class="home-sec" id="network" aria-labelledby="h-sites"><h2 id="h-sites">Five sites, one front door</h2><p class="lede">Stream, build, share, play and store. Everything is open to visitors; signing in once carries your name, theme and notifications to all of it.</p>
<div class="home-grid">${SITES.map(([ic, n, u, tag, d]) => `<a class="home-card" href="${u}">${icon(ic, 48)}<span><b>${n}</b><em>${tag}</em><small>${d}</small></span></a>`).join('')}</div></section>
<section class="home-sec" id="tools" aria-labelledby="h-tools"><h2 id="h-tools">${catalog.tools.length} tools that just open</h2><p class="lede">No installs and no sign-up wall. Every tool has its own short address, so <a href="https://yt.openvibe.tools/">yt.openvibe.tools</a> or <a href="https://dns.openvibe.tools/">dns.openvibe.tools</a> takes you straight there. Browse them all at <a href="https://openvibe.tools/">openvibe.tools</a>.</p>
<div class="home-fams">${fams.map(f => `<a class="home-fam" href="${esc(f.path ? 'https://openvibe.tools' + f.path : f.url)}">${icon(f.icon, 38)}<span><b>${esc(f.name)}</b><small>${count(f)} tools · ${esc(f.tagline || '')}</small></span></a>`).join('')}</div>
<ul class="home-chips">${popular.map(t => `<li><a href="${esc(t.url)}" title="${esc(t.tagline || '')}">${icon(t.icon, 22)}${esc(t.name)}</a></li>`).join('')}</ul></section>
<section class="home-sec" aria-labelledby="h-acct"><h2 id="h-acct">What signing in adds</h2><p class="lede">You can use almost everything as a guest. An account is for the things that need to remember you, and it works on every OpenVibe site the moment you arrive.</p>
<div class="home-grid">${ACCOUNT.map(([ic, n, d, u]) => `<a class="home-card" href="${u}">${icon(ic, 44)}<span><b>${n}</b><small>${d}</small></span></a>`).join('')}</div></section>
<section class="home-sec" aria-labelledby="h-soon"><h2 id="h-soon">Opening next</h2><p class="lede">Thirteen more addresses are staked out. Each one opens when it is good enough to use daily, and your account will already work there.</p>
<ul class="home-chips">${SOON.map(([id, n]) => `<li><a href="https://openvibe.${id}/">${icon(id, 22)}OpenVibe.${n}</a></li>`).join('')}<li><a href="https://openre.stream/">${icon('stream', 22)}OpenRe.Stream</a></li></ul></section>
<section class="home-sec" aria-labelledby="h-dev"><h2 id="h-dev">For developers and crawlers</h2><p class="lede">OpenVibe is open source and community-run. Everything public is meant to be read by machines too.</p>
<div class="home-dev"><div><b>Tool catalog</b><p>Every tool with its description, keywords and addresses as JSON: <a href="https://openvibe.tools/api/catalog.json"><code>openvibe.tools/api/catalog.json</code></a></p></div>
<div><b>llms.txt</b><p>A plain-text map of the network for AI assistants: <a href="/llms.txt"><code>/llms.txt</code></a> here and on <a href="https://openvibe.tools/llms.txt">openvibe.tools</a>.</p></div>
<div><b>Sign in with OpenVibe</b><p>OAuth 2.0 and FedCM for sites on the network. Source on <a href="https://github.com/OpenVibers" rel="noopener">GitHub</a>.</p></div></div></section>`;
}

let cache = { key: '', html: '', etag: '' };
function render() {
    const { catalog } = toolsCatalog.peek();
    const stat = fs.statSync(SHELL);
    const key = `${stat.mtimeMs}:${catalog.updated}:${catalog.tools.length}`;
    if (cache.key === key) return cache;
    const ld = seo.jsonLdTag(seo.jsonLd.itemList('OpenVibe sites', SITES.map(([, n, u, , d]) => ({ name: n, url: u, description: d }))));
    const html = fs.readFileSync(SHELL, 'utf8').replace('<div id="navbar-mount"></div>', '<div id="navbar-mount"></div>' + require('openvibe-shared/chrome-ssr').noscriptNav({ name: 'OpenVibe.Network', links: [{ label: 'Sign in', href: '/login' }, { label: 'Themes', href: '/themes' }] })).replace('<!--OV:HOME-->', body(catalog)).replace('<!--OV:COUNT-->', String(catalog.tools.length)).replace('<div id="ov-footer"></div>', require('openvibe-shared/footer').ssr({ service: 'network', variant: 'full' })).replace('</head>', `${ld}\n</head>`);
    cache = { key, html, etag: '"' + crypto.createHash('sha1').update(html).digest('base64url').slice(0, 20) + '"' };
    return cache;
}

function sendHome(req, res) {
    toolsCatalog.getCatalog().catch(() => {});     // refresh in the background; this response uses what is known now
    const page = render();
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=120, stale-while-revalidate=3600');
    res.set('ETag', page.etag);
    if (req.headers['if-none-match'] === page.etag) return res.status(304).end();
    res.send(page.html);
}

function llmsTxt() {
    const { catalog } = toolsCatalog.peek();
    return seo.llmsTxt({ name: 'OpenVibe Network', summary: 'OpenVibe is an open source, community-run network of sites that share one account: live streaming, online tools, community pastes, games and media.',
        sections: [{ title: 'Sites', links: SITES.map(([, n, u, , d]) => ({ title: n, url: u, note: d })) },
            { title: 'Tool families', links: catalog.families.filter(f => f.url).map(f => ({ title: f.name, url: f.path ? 'https://openvibe.tools' + f.path : f.url, note: f.tagline })) },
            { title: 'Machine-readable', links: [{ title: 'Tool catalog (JSON)', url: 'https://openvibe.tools/api/catalog.json' }, { title: 'Tools llms.txt', url: 'https://openvibe.tools/llms.txt' }, { title: 'Tool domains (JSON)', url: 'https://openvibe.network/api/domains' }] }] });
}

module.exports = { sendHome, render, llmsTxt };
