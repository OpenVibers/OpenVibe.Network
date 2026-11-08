'use strict';
// openvibe.link: OpenVibe Link's own front door (the Node renamed). What Link is (your machines, connected), what it
// does today, how to install it on each OS, and what it never does. The chrome is Network's own; the page is Link's.
// The version, the release date and the checksums come from the Node's latest GitHub release (server/node/release.js).
// node.openvibe.network is the old name: it 301s here (server/node/routes.js) except /install, which keeps serving.

const kit = require('openvibe-shared/kit');

const HOST = 'openvibe.link';
const WWW_HOST = `www.${HOST}`;
// The name the product had until 2026-11-07; its /install line is in people's notes and keeps working.
const LEGACY_HOST = 'node.openvibe.network';
const SITE = `https://${HOST}`;
const DOCS = 'https://github.com/OpenVibers/OpenVibe.Node/blob/main/docs';
const INSTALL_LINE = `curl -fsSL ${SITE}/install | sh`;

// What the Node does today, each with where it happens. A page that promises tomorrow is a page that lies today.
const DOES = [
    { icon: 'code', title: 'Run your agents and code on your machine', body: 'Codes starts a coding task from any browser and this machine runs it, as an unprivileged user in a sandbox.', href: 'https://openvibe.codes/run', cta: 'OpenVibe.Codes' },
    { icon: 'spark', title: 'Offer your models or your GPU and earn credits', body: 'Exchange lists what your machine serves; you choose the models, the hours, the price and who may use it.', href: 'https://openvibe.exchange/sell', cta: 'OpenVibe.Exchange' },
    { icon: 'game', title: 'Drive robots', body: 'Bot drives what you approve, at the level you set, with a kill switch on the machine and a deadline on every command.', href: 'https://openvibe.bot', cta: 'OpenVibe.Bot' },
    { icon: 'live', title: 'Stream an agent\u2019s desk', body: 'Live carries your machine\u2019s screen to a channel, private until you choose: under a second behind, with a curtain that hides secret screens.', href: 'https://openvibe.live/docs/agent-streams', cta: 'Agent streams on OpenVibe.Live' },
    { icon: 'lock', title: 'Keep your memory, read-only', body: 'The collectors read what your coding tools remember: local, redacted, and never uploaded unless you say so.', href: `${DOCS}/memory.md`, cta: 'The memory docs' },
];

// What the Node never does. The two sentences people ask for most.
const NEVER = [
    'It cannot reach your computer without your pairing: nobody drives it, reads it or runs a command on it until you approved the machine.',
    'Nothing runs that you did not turn on: no task, no camera, no driver and no upload starts on its own.',
    'It opens no port: it connects out, so it works behind any home router.',
    'It keeps a local kill switch: one command stops everything it drives, and it stays stopped.',
];

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** The install block per OS. The one-liner is for Linux and macOS; Windows gets the release asset and the pair step. */
function installBlock(release) {
    const version = esc(release.version || '');
    const exe = `https://github.com/OpenVibers/OpenVibe.Node/releases/download/${release.version || 'latest'}/openvibe-link-windows-amd64.exe`;
    return `<div class="np-installs">
<div class="np-install">
<h3>Linux and macOS</h3>
<p class="np-fine">One command. It finds your system, downloads the release, checks it against SHA256SUMS, sets up the service and shows a code to approve.</p>
${kit.snippet({ code: INSTALL_LINE, id: 'np-install-sh', label: 'Copy the install command' })}
<p class="np-fine">On a Raspberry Pi or another robot, the same command finds the kit and its driver.</p>
</div>
<div class="np-install">
<h3>Windows</h3>
<p class="np-fine">Download the binary, then in an Administrator prompt:</p>
${kit.snippet({ code: 'openvibe-link pair <CODE>', id: 'np-install-win', label: 'Copy the pair command' })}
<p class="np-fine"><a href="${esc(exe)}">openvibe-link-windows-amd64.exe</a> from the ${version ? esc(version) : 'latest'} release; the old <code>openvibe-node</code> name is the same program.</p>
</div>
</div>
<p class="np-fine">The program is <code>openvibe-link</code>. <code>openvibe-node</code> is kept as an alias, so existing installs and scripts keep working.</p>`;
}

/** The release facts: the version, when it came out, the checksums and the release page. */
function releaseBlock(release) {
    const { versionLabel, dateLabel } = require('./release');
    const version = versionLabel(release);
    const date = dateLabel(release);
    const rows = [
        kit.row({ title: 'Latest version', sub: release.version || '', meta: date || '', metaIso: date || undefined }),
        kit.row({ href: release.checksumsUrl || '#', title: 'SHA256SUMS', sub: 'the checksums of every file in the release, to check the download against' }),
        kit.row({ href: release.url || '#', title: 'The release on GitHub', sub: 'every asset, and the notes of that release' }),
    ];
    return `<section class="np-sec" aria-labelledby="h-release"><h2 id="h-release">The latest release</h2>
<p class="np-fine">${version ? `Version <strong>${esc(version)}</strong>` : 'The latest version'}${date ? `, published ${esc(date)}` : ''}. The install command above always installs that release.</p>
${kit.list(rows, { flush: true })}
${release.stale ? '<p class="np-fine np-warn">GitHub could not be reached just now, so this is the last release we read.</p>' : ''}
</section>`;
}

/** The page. `release` is what server/node/release.js answered. */
function render({ release = {}, releaseId } = {}) {
    const title = 'OpenVibe Link: your machines, connected';
    const desc = 'OpenVibe Link runs on your computer, server, phone or robot: it runs your agents and code, offers your models or GPU to the network, drives robots, and keeps your memory read-only.';
    const ld = { '@context': 'https://schema.org', '@type': 'SoftwareApplication', name: 'OpenVibe Link', applicationCategory: 'DeveloperApplication',
        operatingSystem: 'Linux, macOS, Windows', description: desc, url: SITE,
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
        publisher: { '@type': 'Organization', '@id': 'https://openvibe.network/#org', name: 'OpenVibe' } };
    const does = DOES.map((d) => `<article class="np-does">
${kit.icon(d.icon)}
<h3>${esc(d.title)}${d.soon ? ' <span class="np-soon">coming with S1</span>' : ''}</h3>
<p>${esc(d.body)}</p>
<p class="np-fine"><a href="${esc(d.href)}">${esc(d.cta)}</a></p>
</article>`).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${SITE}/">
<meta property="og:url" content="${SITE}/">
${require('../boost').meta(releaseId)}
${require('openvibe-shared/app-icon').headTags({ site: 'network', iconBase: '/assets' })}
<meta name="color-scheme" content="dark light">
<script src="/shared/theme-loader.js" defer></script>
<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>
<link rel="stylesheet" href="/shared/kit.css">
<style>
html,body{background:var(--bg-primary);color:var(--text-primary);font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin:0}
${CSS}
</style>
</head>
<body>
<div id="navbar-mount"></div>
<main class="np" id="main">
<header class="np-head">
<p class="np-kicker">OpenVibe Link</p>
<h1>Your machines, connected</h1>
<p class="np-lede">Link runs on your computer, server or phone. Your agents use it only as far as you allow, and you choose what, if anything, it offers the network.</p>
<p class="np-cta">${kit.button({ href: '/install', label: 'Install Link', kind: 'primary' })} ${kit.button({ href: `${DOCS}/install.md`, label: 'The install guide', kind: 'quiet' })}</p>
</header>

<section class="np-sec" aria-labelledby="h-does"><h2 id="h-does">What it does today</h2>
<div class="np-grid">${does}</div>
</section>

<section class="np-sec" aria-labelledby="h-install"><h2 id="h-install">Install it</h2>
${installBlock(release)}
</section>

${releaseBlock(release)}

<section class="np-sec" aria-labelledby="h-never"><h2 id="h-never">What it never does</h2>
<ul class="np-never">${NEVER.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
</section>

<section class="np-sec" aria-labelledby="h-docs"><h2 id="h-docs">The docs</h2>
<ul class="np-docs">
<li><a href="${DOCS}/install.md">Install</a> &mdash; every OS, every option, and what the installer does.</li>
<li><a href="${DOCS}/computer.md">Your computer for your agents</a> &mdash; the computer plugin, its levels and the live screen.</li>
<li><a href="${DOCS}/worker.md">A machine that runs your jobs</a> &mdash; the sandbox the job runner uses.</li>
<li><a href="${DOCS}/protocol.md">The protocol</a> &mdash; the wire format between Link and OpenVibe.Bot.</li>
<li><a href="${DOCS}/memory.md">Your memory</a> &mdash; what the collectors read and how it is uploaded.</li>
</ul>
<p class="np-fine">The source is on <a href="https://github.com/OpenVibers/OpenVibe.Node">GitHub</a>. The installer also lives at <a href="https://openvibe.bot/install">openvibe.bot/install</a>, which keeps working.</p>
</section>
</main>
${require('openvibe-shared/footer').ssr({ service: 'network', variant: 'compact' })}
<script src="/shared/navbar.js" defer></script>
${require('../boost').SCRIPT}
<script src="/shared/kit-web.js" defer></script>
<script>document.addEventListener('DOMContentLoaded',function(){try{if(window.OpenVibeNavbar)OpenVibeNavbar.init({service:'network',apiBase:'https://openvibe.network',links:[{label:'Link',href:'/',icon:'fa-desktop',featured:true,active:true},{label:'Network',href:'https://openvibe.network/'},{label:'My Account',href:'https://openvibe.network/my'}]});}catch(e){}});</script>
</body>
</html>`;
}

const CSS = `
.np{max-width:1000px;margin:0 auto;padding:32px 20px 72px}
.np-kicker{margin:0 0 6px;font-size:.78rem;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--accent,#3b82f6)}
.np h1{margin:0 0 12px;font-size:clamp(1.7rem,5vw,2.6rem);letter-spacing:-.02em;line-height:1.12}
.np-lede{margin:0 0 18px;max-width:760px;color:var(--text-secondary,#96a7c2);line-height:1.65;font-size:1.03rem}
.np-lede code,.np code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9em}
.np-cta{display:flex;flex-wrap:wrap;gap:10px;margin:0}
.np-sec{margin-top:44px}
.np-sec h2{margin:0 0 14px;font-size:1.3rem;letter-spacing:-.01em}
.np-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px}
.np-does{padding:18px;border-radius:16px;background:var(--bg-card,#0f1729);border:1px solid var(--border,#1f2d47);display:flex;flex-direction:column;gap:6px}
.np-does svg{width:22px;height:22px;color:var(--accent,#3b82f6)}
.np-does h3{margin:2px 0 0;font-size:1rem;line-height:1.35}
.np-does p{margin:0;color:var(--text-secondary,#96a7c2);font-size:.92rem;line-height:1.55}
.np-soon{display:inline-block;margin-left:6px;padding:2px 8px;border-radius:999px;font-size:.68rem;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:var(--text-muted,#7386a3);border:1px solid var(--border,#1f2d47);vertical-align:middle}
.np-installs{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px}
.np-install{padding:18px;border-radius:16px;background:var(--bg-card,#0f1729);border:1px solid var(--border,#1f2d47)}
.np-install h3{margin:0 0 8px;font-size:1rem}
.np-install .ovk-snip{margin:12px 0}
.np-fine{margin:10px 0 0;font-size:.88rem;color:var(--text-muted,#7386a3);line-height:1.55}
.np-warn{color:#f0b429}
.np-never,.np-docs{list-style:none;margin:0;padding:0;display:grid;gap:8px;max-width:820px}
.np-never li{position:relative;padding:11px 14px 11px 42px;border-radius:12px;background:var(--bg-card,#0f1729);border:1px solid var(--border,#1f2d47);color:var(--text-secondary,#96a7c2);font-size:.93rem;line-height:1.55}
.np-never li::before{content:"";position:absolute;left:15px;top:16px;width:13px;height:13px;border-radius:50%;background:color-mix(in srgb,var(--accent,#3b82f6) 22%,transparent);box-shadow:inset 0 0 0 2px var(--accent,#3b82f6)}
.np-docs li{padding:11px 14px;border-radius:12px;background:var(--bg-card,#0f1729);border:1px solid var(--border,#1f2d47);font-size:.93rem;line-height:1.55}
.np a:not(.ovk-btn){color:var(--accent,#3b82f6)}
@media (max-width:640px){.np{padding:22px 16px 52px}}
`;

module.exports = { render, HOST, WWW_HOST, LEGACY_HOST, SITE, DOCS, INSTALL_LINE, DOES, NEVER };
