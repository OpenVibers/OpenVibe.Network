'use strict';
// /sites: the front door to the whole network, for people and for crawlers (SEO-9). Every open site is listed under
// the same six neighbourhoods the home page uses (server/frame/sites.js GROUPS), with the site's own tagline, and
// each site is anchored at its registry id (/sites#live) so it can be linked directly. One source: the registry the
// home reads, so the hub cannot disagree with the home, and a site that is not open is never listed.
const seo = require('openvibe-shared/seo');
const icons = require('openvibe-shared/ov-icons');
const { SITES, GROUPS, groupOf, PRODUCTS, fullName } = require('../frame/sites');

const esc = seo.esc;
const siteName = (site) => (site.name.includes('.') ? site.name : fullName(site));
// The one-line purpose, in the home's own words: the tagline it renders on every card (the llms.txt and ItemList
// descriptions use `what`, the longer text).
const siteLine = (site) => site.tagline || site.what;
const openSites = (list = SITES) => list.filter((site) => site.status === 'open');
// The home counts the front door itself in "N sites, one account"; the hub lists it too (it is an open site, with the
// account and themes behind every other one).
const groupsOf = (sites) => GROUPS.map((group) => ({ group, sites: sites.filter((site) => groupOf(site.id) === group.id), also: PRODUCTS.filter((p) => groupOf(p.id) === group.id) })).filter((x) => x.sites.length);

const card = (site) => `<a class="sc-card" id="${esc(site.id)}" href="https://${esc(site.host)}/"><span class="sc-ic sc-ic-ov"><span class="ov-icon sc-ovi" data-icon="${esc(site.icon)}" style="--ovi-size:40px" aria-hidden="true">${icons.svg(site.icon)}</span></span><span><b>${esc(siteName(site))}</b><small>${esc(siteLine(site))}</small></span></a>`;

function render({ releaseId = '', sites = SITES } = {}) {
    const open = openSites(sites);
    const groups = groupsOf(open);
    const count = open.length;
    const title = `All ${count} OpenVibe sites`;
    const desc = `Every open OpenVibe site in one place, grouped by what people come to do, each with a link to its own home. One free account signs you in on all of them.`;
    const intro = 'Every open OpenVibe site, grouped by what people come to do; signing in once carries your name, theme and notifications to all of them.';
    const headings = new Map(groups.map(({ group }) => [group.id, `h-${group.id}`]));
    // The group anchors are prefixed: a group id ("games") can be a site id too, and one page cannot hold both.
    const jump = `<nav class="sites-jump" aria-labelledby="h-jump"><h2 id="h-jump">The groups</h2><ol>${groups.map(({ group, sites: list }) => `<li><a href="#group-${esc(group.id)}">${esc(group.name)}<small>${list.length}</small></a></li>`).join('')}</ol></nav>`;
    const body = groups.map(({ group, sites: list, also }) => `<section class="sc-sec" id="group-${esc(group.id)}" aria-labelledby="${esc(headings.get(group.id))}"><h2 id="${esc(headings.get(group.id))}">${esc(group.name)}</h2><div class="sc-grid">${list.map(card).join('')}</div>${also.length ? `<p class="sites-also">Also here: ${also.map((p) => `<a href="https://${esc(p.host)}/">${esc(p.host)}</a> (${esc(p.tagline.toLowerCase())})`).join(', ')}</p>` : ''}</section>`).join('\n');
    const ld = {
        '@context': 'https://schema.org', '@type': 'CollectionPage',
        name: title, description: desc, url: 'https://openvibe.network/sites',
        isPartOf: { '@id': 'https://openvibe.network/#site' },
        publisher: { '@type': 'Organization', '@id': 'https://openvibe.network/#org', name: 'OpenVibe' },
        mainEntity: seo.jsonLd.itemList(title, open.map((site) => ({ name: siteName(site), url: `https://${site.host}/`, description: siteLine(site) }))),
    };
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · OpenVibe.Network</title>
<meta name="description" content="${esc(desc)}">
<meta name="robots" content="index, follow">
<link rel="canonical" href="https://openvibe.network/sites">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:type" content="website"><meta property="og:url" content="https://openvibe.network/sites">
${require('../boost').meta(releaseId)}
${require('openvibe-shared/app-icon').headTags({ site: 'network', iconBase: '/assets' })}
<meta name="color-scheme" content="dark light">
<link rel="stylesheet" href="/shared/showcase.css">
<script src="/shared/theme-loader.js" defer></script>
<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>
<style>
*,*::before,*::after{box-sizing:border-box}
:root{--bg-primary:#0a0f1c;--bg-secondary:#101828;--bg-card:#0f1729;--border:#1f2d47;--border-light:#2c3d5c;--accent:#3b82f6;--accent-light:#60a5fa;--text-primary:#e6edf7;--text-secondary:#96a7c2;--text-muted:#7386a3}
html,body{margin:0;background:var(--bg-primary);color:var(--text-primary);font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
a{color:var(--accent)}
${icons.CSS}
${CSS}
</style>
</head>
<body>
<div id="navbar-mount"></div>
${require('openvibe-shared/frame').noscriptNav({ name: 'OpenVibe.Network', links: [{ label: 'Open stats', href: '/stats' }, { label: 'OpenVibeBot', href: '/bot' }] })}
<main class="sites" id="main">
<header class="sites-head">
<p class="sc-eyebrow">The OpenVibe network</p>
<h1>${esc(title)}</h1>
<p class="sc-hero-lede">${esc(intro)}</p>
${jump}
</header>
${body}
</main>
${require('openvibe-shared/footer').ssr({ service: 'network', variant: 'compact' })}
<script src="/shared/navbar.js" defer></script>
${require('../boost').SCRIPT}
<script>document.addEventListener('DOMContentLoaded',function(){try{if(window.OpenVibeNavbar)OpenVibeNavbar.init({service:'network',apiBase:location.origin});}catch(e){}});</script>
</body>
</html>`;
}

// The same list as text, for /llms-full.txt: every site with the one-line purpose the page shows.
function llmsText() {
    return ['Every open OpenVibe site, grouped by what people come to do:', ...GROUPS.map((group) => {
        const list = openSites().filter((site) => groupOf(site.id) === group.id);
        return list.length ? `\n${group.name}:\n${list.map((site) => `- ${siteName(site)} (https://${site.host}/): ${siteLine(site)}`).join('\n')}` : '';
    }).filter(Boolean)].join('\n');
}

const CSS = `
.sites{padding:0 0 64px}
.sites-head{max-width:1080px;margin:0 auto;padding:24px 24px 0}
.sites-head h1{margin:6px 0 10px;font-size:clamp(1.7rem,4vw,2.5rem);letter-spacing:-.03em;line-height:1.1}
.sites-head .sc-hero-lede{margin:0;max-width:760px}
.sites-jump{margin:26px 0 0;padding:16px 18px;border-radius:16px;border:1px solid var(--border);background:var(--bg-card)}
.sites-jump h2{margin:0 0 10px;font-size:12px;font-weight:800;letter-spacing:.7px;text-transform:uppercase;color:var(--text-muted)}
.sites-jump ol{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:8px}
.sites-jump a{display:inline-flex;align-items:center;gap:7px;padding:6px 12px;border-radius:999px;border:1px solid var(--border);font-size:13.5px;font-weight:600;color:inherit;text-decoration:none}
.sites-jump a:hover,.sites-jump a:focus-visible{border-color:var(--accent);outline:0}
.sites-jump small{color:var(--text-muted);font-weight:700;font-size:12px;font-variant-numeric:tabular-nums}
.sites .sc-sec:first-of-type{margin-top:40px}
.sc-card[id]{scroll-margin-top:84px}
.sites-also{margin:12px 0 0;font-size:13.5px;color:var(--text-secondary)}
.sites-also a{color:var(--accent-light);font-weight:600;text-decoration:none}
.sites-also a:hover{text-decoration:underline}
`;

module.exports = { render, llmsText, siteLine, openSites, CSS };
