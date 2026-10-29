'use strict';
// OpenVibeBot (ADR 0007 in OpenVibe.Sources): the page its user agent links to — what it is, what it reads, what it obeys,
// and how a site blocks, slows or opts in. /bot.json says the same for machines. Static: no database, no outbound calls.

const UA = 'Mozilla/5.0 (compatible; OpenVibeBot/1.0; +https://openvibe.network/bot)';
const TOKENS = ['OpenVibeBot', 'OpenVibeSources'];
const CONTACT = 'Contact@OpenVibe.Network';

const FACTS = {
    name: 'OpenVibeBot',
    operator: 'OpenVibe (OpenVibe.Sources)',
    user_agent: UA,
    robots_tokens: TOKENS,
    info_url: 'https://openvibe.network/bot',
    contact: CONTACT,
    obeys: ['robots.txt (RFC 9309), checked before every request and every redirect hop', 'Crawl-delay',
        'noindex and nofollow in <meta name="robots">, <meta name="OpenVibeBot"> and X-Robots-Tag', 'rel=canonical',
        '429 or 503 with Retry-After: the whole site waits', '404 twice or 410: what came from that page is removed'],
    pacing: { min_gap_per_host_ms: 1000, shop_crawl_gap_ms: 5000, sites_at_once: 2, robots_cache_hours: 24 },
    reads_first: ['robots.txt Sitemap lines', 'sitemap.xml', 'feeds', 'schema.org JSON-LD'],
    never: ['solve CAPTCHAs', 'sign in or read anything behind a sign-in', 'get past cookie walls or paywalls'],
    access_policy: 'https://github.com/OpenVibers/OpenVibe.Sources/blob/main/docs/adr/0007-source-access.md',
};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// The network's own share card, the one the home page and /sites carry (served at /shared/social/network.jpg).
const shareCard = require('openvibe-shared/social').url('network', 'https://openvibe.network/shared');

function snippet(id, label, code) {
    return `<figure class="bp-code"><figcaption><span>${esc(label)}</span><button type="button" class="bp-copy" data-copy="${id}" aria-label="Copy: ${esc(label)}">Copy</button></figcaption><pre id="${id}"><code>${esc(code)}</code></pre></figure>`;
}

function render({ releaseId } = {}) {
    const title = 'OpenVibeBot: OpenVibe\'s crawler';
    const desc = 'What OpenVibeBot reads, what it obeys, and how to block it, slow it down or have your site listed from a feed instead.';
    const ld = { '@context': 'https://schema.org', '@type': 'WebPage', name: title, description: desc, url: FACTS.info_url,
        publisher: { '@type': 'Organization', '@id': 'https://openvibe.network/#org', name: 'OpenVibe' } };
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · OpenVibe.Network</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="https://openvibe.network/bot">
<link rel="alternate" type="application/json" href="/bot.json" title="OpenVibeBot as JSON">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:type" content="website"><meta property="og:image" content="${esc(shareCard)}"><meta property="og:image:alt" content="OpenVibe.Network: one account for every OpenVibe site">
${require('../boost').meta(releaseId)}
${require('openvibe-shared/app-icon').headTags({ site: 'network', iconBase: '/assets' })}
<meta name="color-scheme" content="dark light">
<script src="/shared/theme-loader.js" defer></script>
<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>
<style>
*,*::before,*::after{box-sizing:border-box}
:root{--bg-primary:#0a0f1c;--bg-secondary:#101828;--bg-card:#0f1729;--border:#1f2d47;--accent:#3b82f6;--text-primary:#e6edf7;--text-secondary:#96a7c2;--text-muted:#7386a3}
html,body{margin:0;background:var(--bg-primary);color:var(--text-primary);font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
a{color:var(--accent)}
${CSS}
</style>
</head>
<body>
<div id="navbar-mount"></div>
${require('openvibe-shared/frame').noscriptNav({ name: 'OpenVibe.Network', links: [{ label: 'Open stats', href: '/stats' }, { label: 'Status', href: '/status' }] })}
<main class="bp" id="main">
<header class="bp-head">
<p class="bp-kicker">OpenVibeBot</p>
<h1>OpenVibe's crawler, and how to steer it</h1>
<p class="bp-lede">OpenVibeBot reads public pages that describe themselves: product pages with prices, feeds and sitemaps. OpenVibe Deals, Search and the other OpenVibe sites use what it reads to link back to those pages, with where and when each fact was read. It follows your robots.txt every time, and you can stop it in one line.</p>
<dl class="bp-id">
<div class="bp-id-ua"><dt>User agent</dt><dd><code id="bp-ua">${esc(UA)}</code><button type="button" class="bp-copy" data-copy="bp-ua" aria-label="Copy the user agent">Copy</button></dd></div>
<div><dt>robots.txt names</dt><dd>${TOKENS.map((t) => `<code>${t}</code>`).join(' <span class="bp-or">or</span> ')}<small>OpenVibeSources is its older name and is still obeyed.</small></dd></div>
</dl>
</header>

<section class="bp-sec" aria-labelledby="h-reads"><h2 id="h-reads">What it reads</h2>
<ol class="bp-steps">
<li><b>Your sitemap first.</b><span>The Sitemap lines in robots.txt, else /sitemap.xml. Pages a sitemap says changed are read sooner; unchanged ones less and less often.</span></li>
<li><b>Structured data.</b><span>schema.org JSON-LD on the page: a product's name, price, list price, currency, availability, image and address. A page without it is skipped.</span></li>
<li><b>Links, only if asked.</b><span>When a site has no sitemap, links on the same site, at most two steps from the home page.</span></li>
</ol>
<p class="bp-fine">It keeps facts and a link, never a copy of your page, and nothing about people. It never leaves the site it was pointed at.</p>
</section>

<section class="bp-sec" aria-labelledby="h-obeys"><h2 id="h-obeys">What it obeys</h2>
<ul class="bp-checks">
<li><b>robots.txt</b> (RFC 9309), before every request and again on every redirect. Rules for <code>OpenVibeBot</code> or <code>OpenVibeSources</code> apply; otherwise the rules for <code>*</code>.</li>
<li><b>Crawl-delay</b>, as the least time between two requests.</li>
<li><b>noindex and nofollow</b> in <code>&lt;meta name="robots"&gt;</code>, in <code>&lt;meta name="OpenVibeBot"&gt;</code> and in the <code>X-Robots-Tag</code> header.</li>
<li><b>rel=canonical</b>: the page's own address wins over the one it was reached by.</li>
<li><b>429, or 503 with Retry-After</b>: the whole site waits, not just that page.</li>
<li><b>Gone pages</b>: a 404 twice or a 410 once removes what came from that page.</li>
</ul>
<div class="bp-pace" role="list">
<div role="listitem"><b>1 s</b><span>least gap between two requests to one site</span></div>
<div role="listitem"><b>5 s</b><span>gap when it reads a shop</span></div>
<div role="listitem"><b>2</b><span>sites read at the same time, at most</span></div>
<div role="listitem"><b>24 h</b><span>longest a robots.txt is remembered</span></div>
</div>
</section>

<section class="bp-sec" aria-labelledby="h-steer"><h2 id="h-steer">Block it or slow it down</h2>
<p class="bp-fine">Changes reach it within 24 hours, the longest it keeps a robots.txt. Nothing else to set up and nobody to ask.</p>
<div class="bp-codes">
${snippet('bp-c1', 'Keep it off the whole site (robots.txt)', 'User-agent: OpenVibeBot\nDisallow: /')}
${snippet('bp-c2', 'Keep it out of some paths (robots.txt)', 'User-agent: OpenVibeBot\nDisallow: /checkout/\nDisallow: /account/')}
${snippet('bp-c3', 'Slow it down (robots.txt)', 'User-agent: OpenVibeBot\nCrawl-delay: 30')}
${snippet('bp-c4', 'Keep one page out (HTML)', '<meta name="OpenVibeBot" content="noindex, nofollow">')}
${snippet('bp-c5', 'Keep a file out (HTTP header)', 'X-Robots-Tag: OpenVibeBot: noindex')}
</div>
</section>

<section class="bp-sec bp-two" aria-labelledby="h-never">
<div><h2 id="h-never">What it never does</h2>
<ul class="bp-nos">${FACTS.never.map((n) => `<li>${esc(n.charAt(0).toUpperCase() + n.slice(1))}.</li>`).join('')}<li>Hide what it is: every request carries the user agent above.</li></ul></div>
<div><h2 id="h-how">How a site gets read at all</h2>
<p class="bp-fine bp-tight">A short check of a site's public answers decides, the same way for every site: if its pages answer, they are read; if only its sitemap or feeds answer, OpenVibe uses feeds, the site's own API or a partnership instead and leaves the pages alone; if nothing answers, nothing is read and the site is checked again a day later.</p></div>
</section>

<section class="bp-sec bp-cta" aria-labelledby="h-optin"><h2 id="h-optin">Want your shop listed from a feed instead?</h2>
<p>A product feed, an affiliate program or an API is faster for you and more accurate for shoppers than any crawl. Tell us where it is and the crawler steps aside. Questions, a request that hit you too hard, or a correction: write to <a href="mailto:${CONTACT}">${CONTACT}</a>.</p>
<p class="bp-fine">For machines: <a href="/bot.json"><code>/bot.json</code></a> says all of this as JSON.</p>
</section>
</main>
${require('openvibe-shared/footer').ssr({ service: 'network', variant: 'compact' })}
<script src="/shared/navbar.js" defer></script>
${require('../boost').SCRIPT}
<script>document.addEventListener('DOMContentLoaded',function(){try{if(window.OpenVibeNavbar)OpenVibeNavbar.init({service:'network',apiBase:location.origin});}catch(e){}
document.querySelectorAll('.bp-copy').forEach(function(b){b.addEventListener('click',function(){var el=document.getElementById(b.getAttribute('data-copy'));if(!el||!navigator.clipboard)return;navigator.clipboard.writeText(el.textContent).then(function(){b.textContent='Copied';b.classList.add('is-done');setTimeout(function(){b.textContent='Copy';b.classList.remove('is-done');},1600);},function(){});});});});</script>
</body>
</html>`;
}

const CSS = `
.bp{max-width:980px;margin:0 auto;padding:28px 20px 64px}
.bp-kicker{margin:0 0 6px;font-size:.78rem;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--accent)}
.bp h1{margin:0 0 10px;font-size:clamp(1.6rem,4.4vw,2.4rem);letter-spacing:-.02em;line-height:1.15}
.bp-lede{margin:0 0 20px;max-width:760px;color:var(--text-secondary);line-height:1.6;font-size:1.02rem}
.bp code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.88em}
.bp-id{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(0,1fr);gap:12px;margin:0}
.bp-id>div{padding:14px 16px;border-radius:16px;background:linear-gradient(160deg,color-mix(in srgb,var(--accent) 10%,transparent),transparent 70%),var(--bg-card);border:1px solid var(--border);min-width:0}
.bp-id dt{font-size:.74rem;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:var(--text-muted);margin-bottom:8px}
.bp-id dd{margin:0;display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.bp-id-ua dd code{flex:1 1 260px;min-width:0;overflow-wrap:anywhere;padding:8px 10px;border-radius:10px;background:var(--bg-secondary);border:1px solid var(--border);line-height:1.45}
.bp-id dd>code:not(#bp-ua){padding:3px 9px;border-radius:8px;background:var(--bg-secondary);border:1px solid var(--border);font-weight:700}
.bp-or{color:var(--text-muted);font-size:.84rem}
.bp-id small{flex-basis:100%;color:var(--text-muted);font-size:.8rem}
.bp-copy{flex:none;font:inherit;font-size:.8rem;font-weight:700;padding:6px 12px;border-radius:999px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);cursor:pointer;min-height:32px}
.bp-copy:hover{border-color:var(--accent)}
.bp-copy:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.bp-copy.is-done{color:var(--success,#22c55e);border-color:color-mix(in srgb,var(--success,#22c55e) 50%,var(--border))}
.bp-sec{margin-top:38px}
.bp-sec h2{margin:0 0 10px;font-size:1.25rem;letter-spacing:-.01em}
.bp-fine{margin:12px 0 0;font-size:.88rem;color:var(--text-muted);line-height:1.55;max-width:780px}
.bp-tight{margin-top:0}
.bp-steps{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;counter-reset:s}
.bp-steps li{counter-increment:s;display:flex;flex-direction:column;gap:6px;padding:16px;border-radius:16px;background:var(--bg-card);border:1px solid var(--border)}
.bp-steps li::before{content:counter(s);display:grid;place-items:center;width:28px;height:28px;border-radius:50%;font-weight:800;font-size:.86rem;background:color-mix(in srgb,var(--accent) 18%,transparent);color:var(--accent)}
.bp-steps b{font-size:1rem}
.bp-steps span{color:var(--text-secondary);font-size:.9rem;line-height:1.5}
.bp-checks,.bp-nos{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.bp-checks li,.bp-nos li{position:relative;padding:10px 14px 10px 40px;border-radius:12px;background:var(--bg-card);border:1px solid var(--border);color:var(--text-secondary);line-height:1.5;font-size:.92rem}
.bp-checks b{color:var(--text-primary)}
.bp-checks li::before,.bp-nos li::before{content:"";position:absolute;left:14px;top:14px;width:14px;height:14px;border-radius:50%}
.bp-checks li::before{background:color-mix(in srgb,var(--success,#22c55e) 22%,transparent);box-shadow:inset 0 0 0 2px var(--success,#22c55e)}
.bp-nos li::before{background:color-mix(in srgb,var(--danger,#f87171) 22%,transparent);box-shadow:inset 0 0 0 2px var(--danger,#f87171)}
.bp-pace{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-top:14px}
.bp-pace>div{display:flex;flex-direction:column;gap:2px;padding:12px 14px;border-radius:14px;background:var(--bg-card);border:1px solid var(--border)}
.bp-pace b{font-size:1.4rem;font-variant-numeric:tabular-nums;color:var(--text-primary)}
.bp-pace span{font-size:.82rem;color:var(--text-muted);line-height:1.35}
.bp-codes{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;margin-top:14px}
.bp-code{display:flex;flex-direction:column;margin:0;border-radius:14px;background:var(--bg-card);border:1px solid var(--border);overflow:hidden;min-width:0}
.bp-code figcaption{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 8px 8px 14px;border-bottom:1px solid var(--border);font-size:.84rem;font-weight:700;color:var(--text-secondary)}
.bp-code pre{flex:1;margin:0;padding:12px 14px;white-space:pre-wrap;overflow-wrap:anywhere;font-size:.86rem;line-height:1.55;background:var(--bg-secondary)}
.bp-two{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:24px}
.bp-two h2{margin-bottom:10px}
.bp-cta{padding:20px;border-radius:18px;background:linear-gradient(135deg,color-mix(in srgb,var(--accent) 16%,transparent),transparent 75%),var(--bg-card);border:1px solid color-mix(in srgb,var(--accent) 35%,var(--border))}
.bp-cta p{margin:0;color:var(--text-secondary);line-height:1.6;max-width:760px}
.bp-cta .bp-fine{margin-top:10px}
@media (max-width:640px){.bp{padding:20px 16px 48px}.bp-id{grid-template-columns:1fr}}
`;

function createBotPage({ release } = {}) {
    const router = require('express').Router();
    router.get('/bot', (_req, res) => {
        res.set('Cache-Control', 'public, max-age=600').type('html').send(render({ releaseId: release && release.release }));
    });
    router.get('/bot.json', (_req, res) => {
        res.set('Cache-Control', 'public, max-age=3600').set('Access-Control-Allow-Origin', '*').json(FACTS);
    });
    return router;
}

module.exports = { createBotPage, render, FACTS, UA };
