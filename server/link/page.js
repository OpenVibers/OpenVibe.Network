'use strict';
const pageLinks = require('../frame/page-links');
// openvibe.link: OpenVibe Link's own front door (the machine agent). What Link is (your machines, connected), what it
// does today, how to install it on each OS, and what it never does. The chrome is Network's own; the page is Link's.
// The version, the release date and the checksums come from Link's latest GitHub release (server/link/release.js).

const kit = require('openvibe-shared/kit');
const glyphs = require('openvibe-shared/glyphs');
const arrowRight = glyphs.svg('arrow-right', { size: 16 });

const HOST = 'openvibe.link';
const WWW_HOST = `www.${HOST}`;
// The name the product had until 2026-11-07; its /install line is in people's notes and keeps working.
const SITE = `https://${HOST}`;
const DOCS = 'https://github.com/OpenVibers/OpenVibe.Link/blob/main/docs';
const INSTALL_LINE = `curl -fsSL ${SITE}/install | sh`;

// What Link does today, each with where it happens. A page that promises tomorrow is a page that lies today.
const DOES = [
    { icon: 'code', title: 'Run your agents and code on your machine', body: 'Codes starts a coding task from any browser and this machine runs it, as an unprivileged user in a sandbox.', href: 'https://openvibe.codes/run', cta: 'OpenVibe.Codes' },
    { icon: 'spark', title: 'Offer your models or your GPU and earn credits', body: 'Exchange lists what your machine serves; you choose the models, the hours, the price and who may use it.', href: 'https://openvibe.exchange/sell', cta: 'OpenVibe.Exchange' },
    { icon: 'game', title: 'Drive robots', body: 'Bot drives what you approve, at the level you set, with a kill switch on the machine and a deadline on every command.', href: 'https://openvibe.bot', cta: 'OpenVibe.Bot' },
    { icon: 'live', title: 'Stream an agent\u2019s desk', body: 'Live carries your machine\u2019s screen to a channel, private until you choose: under a second behind, with a curtain that hides secret screens.', href: 'https://openvibe.live/docs/agent-streams', cta: 'Agent streams on OpenVibe.Live' },
    { icon: 'lock', title: 'Keep your memory, read-only', body: 'The collectors read what your coding tools remember: local, redacted, and never uploaded unless you say so.', href: `${DOCS}/memory.md`, cta: 'The memory docs' },
];

// What Link never does. The two sentences people ask for most.
const NEVER = [
    'It cannot reach your computer without your pairing: nobody drives it, reads it or runs a command on it until you approved the machine.',
    'Nothing runs that you did not turn on: no task, no camera, no driver and no upload starts on its own.',
    'It opens no port to the internet: it connects out, so it works behind any home router. On your own network it takes a transfer from your other machines only after they prove they are yours.',
    'It keeps a local kill switch: one command stops everything it drives, and it stays stopped.',
];

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Which OS the visitor is on, for the install block's default panel. Server-side, so it is right before JS runs. */
function detectOS(userAgent) {
    const ua = String(userAgent || '');
    if (/Android/i.test(ua)) return 'android';
    if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
    if (/Windows/i.test(ua)) return 'windows';
    if (/Macintosh|Mac OS X/i.test(ua)) return 'mac';
    if (/Linux|X11/i.test(ua)) return 'linux';
    return 'linux';
}

/**
 * The install block per OS: the visitor's own OS opens first, every other way in stays one click away. Exact steps,
 * the release's own assets, and nothing behind a script the page does not show.
 */
function installBlock(release, userAgent) {
    const current = detectOS(userAgent);
    const v = esc(release.version || '');
    const pkg = String(release.version || '').replace(/^v/, '');
    const latest = 'https://github.com/OpenVibers/OpenVibe.Link/releases/latest/download';
    const releases = 'https://github.com/OpenVibers/OpenVibe.Link/releases';
    const dl = (name) => `${latest}/${name}`;
    const file = (name, label) => `<a href="${esc(dl(name))}">${esc(label || name)}</a>`;
    const pkgFile = (name, label) => (pkg ? `<a href="${esc(dl(name))}">${esc(label || name)}</a>` : `<a href="${releases}">${esc(label || name)}</a>`);
    // The signed APK is attached when the repo has the release key; CI attaches a debug APK when it does not. Offer
    // whichever the release actually carries, and the release page when neither is there yet.
    const assets = Array.isArray(release.assets) ? release.assets : null;
    const signedApk = release.version ? `openvibe-link-${release.version}.apk` : '';
    const debugApk = release.version ? `openvibe-link-${release.version}-debug.apk` : '';
    const apkName = !release.version ? '' : (!assets ? signedApk : (assets.includes(signedApk) ? signedApk : (assets.includes(debugApk) ? debugApk : '')));
    const apk = release.version
        ? (apkName ? `${releases}/download/${encodeURIComponent(release.version)}/${encodeURIComponent(apkName)}` : `${releases}/tag/${encodeURIComponent(release.version)}`)
        : releases;
    const apkNote = apkName && apkName === debugApk
        ? ' This is the debug build: the signed Android release waits on the repository\'s release key.'
        : '';
    const open = (os) => (current === os ? ' open' : '');
    return `<div class="np-os-list">
<details class="np-os" data-os="windows"${open('windows')}>
<summary><span>Windows</span><small>x64 and ARM64</small></summary>
<div class="np-os-body">
<p>Download the program for this PC: ${file('openvibe-link-windows-amd64.exe', 'Windows x64 (.exe)')} or ${file('openvibe-link-windows-arm64.exe', 'Windows ARM64 (.exe)')}.</p>
<p>Windows may show SmartScreen the first time: choose <strong>More info</strong>, then <strong>Run anyway</strong>. In an <strong>Administrator</strong> PowerShell, from the folder you saved it in:</p>
${kit.snippet({ code: '.\\openvibe-link pair <CODE>\n.\\openvibe-link install', id: 'np-install-win', label: 'Copy the Windows steps' })}
<p class="np-fine">The code comes from <a href="/pair">openvibe.link/pair</a> (the signed-in machines hub, <strong>Pair a machine</strong>). </p>
</div>
</details>

<details class="np-os" data-os="mac"${open('mac')}>
<summary><span>macOS</span><small>Apple silicon and Intel</small></summary>
<div class="np-os-body">
<p>The one command installs the right build and the service, and asks for a pairing code:</p>
${kit.snippet({ code: INSTALL_LINE, id: 'np-install-mac', label: 'Copy the macOS install command' })}
<p>Or download the program: ${file('openvibe-link-darwin-arm64', 'Apple silicon')}, ${file('openvibe-link-darwin-amd64', 'Intel')}, or the ${pkgFile(`openvibe-link_${pkg}_darwin_arm64.tar.gz`, 'Apple silicon tarball')} and ${pkgFile(`openvibe-link_${pkg}_darwin_amd64.tar.gz`, 'Intel tarball')} with the installer and plugins beside it. Gatekeeper: right-click the file and choose <strong>Open</strong> the first time.</p>
<p>Then in Terminal: <code>sudo ./openvibe-link pair &lt;CODE&gt;</code> and <code>sudo ./openvibe-link install</code>.</p>
</div>
</details>

<details class="np-os" data-os="linux"${open('linux')}>
<summary><span>Linux</span><small>x64 and ARM64 · .deb, .rpm, tarball, script</small></summary>
<div class="np-os-body">
<p>The one command, on any distribution, finds the CPU and installs the service:</p>
${kit.snippet({ code: INSTALL_LINE, id: 'np-install-linux', label: 'Copy the Linux install command' })}
<p>Or use your package manager: ${pkgFile(`openvibe-link_${pkg}_amd64.deb`, 'Debian/Ubuntu x64 .deb')}, ${pkgFile(`openvibe-link_${pkg}_arm64.deb`, 'Debian/Ubuntu ARM64 .deb')}, ${pkgFile(`openvibe-link-${pkg}-1.x86_64.rpm`, 'Fedora/RHEL x64 .rpm')} or ${pkgFile(`openvibe-link-${pkg}-1.aarch64.rpm`, 'Fedora/RHEL ARM64 .rpm')}.</p>
${kit.snippet({ code: 'sudo apt install ./openvibe-link_<version>_amd64.deb\n# or: sudo dnf install ./openvibe-link-<version>-1.x86_64.rpm\nopenvibe-link pair <CODE>\nsudo openvibe-link install', id: 'np-install-pkg', label: 'Copy the package steps' })}
<p>Or take the tarball: ${pkgFile(`openvibe-link_${pkg}_linux_amd64.tar.gz`, 'x64 .tar.gz')} or ${pkgFile(`openvibe-link_${pkg}_linux_arm64.tar.gz`, 'ARM64 .tar.gz')}; unpack it and run <code>sudo ./install.sh --local .</code>. On a Raspberry Pi or another robot, the one command also finds the kit and its driver.</p>
</div>
</details>

<details class="np-os" data-os="android"${open('android')}>
<summary><span>Android</span><small>the existing APK, direct</small></summary>
<div class="np-os-body">
<p>Download <a href="${esc(apk)}">${apkName ? esc(apkName) : 'the APK from the release page'}</a> on the phone, allow installing from that source when Android asks, and open <strong>OpenVibe Link</strong>.${apkNote}</p>
<p>Pair from the app with a code from <a href="/pair">openvibe.link/pair</a> or <a href="https://openvibe.bot/link/phone">openvibe.bot/link/phone</a>. The APK carries approvals, Activity, pairing and <strong>Send to OpenVibe</strong>; it is the direct build, not Google Play, and has no phone automation.</p>
</div>
</details>

<details class="np-os" data-os="ios"${open('ios')}>
<summary><span>iPhone and iPad</span><small>what works today, without the App Store</small></summary>
<div class="np-os-body">
<p>There is no native iOS app yet. What works today is the home-screen web app: open <a href="https://openvibe.my/">openvibe.my</a> in Safari, sign in, then <strong>Share</strong> &rarr; <strong>Add to Home Screen</strong>. It gives you <strong>Approvals</strong>, <strong>Activity</strong>, your <strong>machines</strong> and pairing from the phone, and it looks like an app on the home screen.</p>
<p class="np-fine">A native iOS app (and push notifications, a background connection, or using the phone as a Link camera or microphone) waits on an Apple Developer account and the App Store review that follows it. We will say when that starts; nothing here pretends it already works.</p>
</div>
</details>
</div>
<p class="np-fine">The program is <code>openvibe-link</code>. Every download is checked against the release's <a href="${esc(dl('SHA256SUMS'))}">SHA256SUMS</a>.</p>`;
}

/** The release facts: the version, when it came out, the checksums and the release page. */
function releaseBlock(release) {
    const { versionLabel, dateLabel, ageDays } = require('./release');
    const version = versionLabel(release);
    const date = dateLabel(release);
    const days = ageDays(release);
    const rows = [
        kit.row({ title: 'Latest version', sub: release.version || '', meta: date || '', metaIso: date || undefined }),
        kit.row({ href: release.checksumsUrl || '#', title: 'SHA256SUMS', sub: 'the checksums of every file in the release, to check the download against' }),
        kit.row({ href: release.url || '#', title: 'The release on GitHub', sub: 'every asset, and the notes of that release' }),
    ];
    return `<section class="np-sec np-release" aria-labelledby="h-release"><h2 id="h-release">The latest release</h2>
<p class="np-fine">${version ? `Version <strong>${esc(version)}</strong>` : 'The download links always point at the latest release.'}${date ? `, published ${esc(date)}` : ''}. The install command above always installs that release.</p>
${kit.list(rows, { flush: true })}
${release.stale && days >= 1 ? `<p class="np-fine np-warn">GitHub could not be reached just now, so this is the last release we read, from ${days === 1 ? 'a day' : `${days} days`} ago.</p>` : ''}
</section>`;
}

/** The page. `release` is what server/link/release.js answered. */
function render({ release = {}, releaseId, userAgent } = {}) {
    const title = 'OpenVibe Link: your machines, connected';
    const desc = 'OpenVibe Link runs on your computer, server, phone or robot: it runs your agents and code, offers your models or GPU to the network, drives robots, and keeps your memory read-only.';
    const ld = { '@context': 'https://schema.org', '@type': 'SoftwareApplication', name: 'OpenVibe Link', applicationCategory: 'DeveloperApplication',
        operatingSystem: 'Linux, macOS, Windows', description: desc, url: SITE,
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
        publisher: { '@type': 'Organization', '@id': 'https://openvibe.network/#org', name: 'OpenVibe' } };
    // 2026-11-12 (the owner: "more user-friendly and elegant … perfect the layout"): the mark in a tile beside the title,
    // the words beside it, and the way on as a quiet arrow link (openvibe.design: section marks in tiles, no browser links).
    const does = DOES.map((d) => `<article class="np-does">
<span class="np-does-ic">${kit.icon(d.icon)}</span>
<h3>${esc(d.title)}${d.soon ? ' <span class="np-soon">coming with S1</span>' : ''}</h3>
<p>${esc(d.body)}</p>
<p class="np-does-go"><a href="${esc(d.href)}">${esc(d.cta)} ${arrowRight}</a></p>
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
<h1>Your machines, connected</h1>
<p class="np-lede">Link runs on your computer, server or phone. Your agents use it only as far as you allow, and you choose what, if anything, it offers the network.</p>
<p class="np-cta">${kit.button({ href: '#install', label: 'Install Link', kind: 'primary' })} ${kit.button({ href: `${DOCS}/install.md`, label: 'The install guide', kind: 'quiet' })}</p>
</header>

<section class="np-sec" aria-labelledby="h-does"><h2 id="h-does">What it does today</h2>
<div class="np-grid">${does}</div>
</section>

<section class="np-sec" id="install" aria-labelledby="h-install"><h2 id="h-install">Install it</h2>
<p class="np-fine" style="margin:0 0 12px">Your system is open first; choose another to see its steps.</p>
${installBlock(release, userAgent)}
</section>

<!-- 2026-11-14 (the owner: "this page layout sucks … use OpenVibe.design … responsive … better use of space … icons"):
     what you do with Link is one grid of cards, each headed by its mark (your machines, your internet address, sending to
     a machine); the promises and the docs are compact icon tiles; the release is one card. -->
<section class="np-sec" aria-labelledby="h-yours"><h2 id="h-yours">Your Link</h2>
<div class="np-panels">
<article class="np-card" id="machines" aria-labelledby="h-machines">
<header class="np-card-h"><span class="np-ic">${glyphs.svg('computer', { size: 20 })}</span><h3 id="h-machines">Your machines</h3><p>Every computer, server and phone you paired: online or not, what each may do.</p></header>
<p class="np-fine">Rename or revoke one there; the one-time code to add another and the phone's pairing are there too.</p>
<p class="np-cta">${kit.button({ href: '/machines', label: 'Open your machines', kind: 'primary' })} ${kit.button({ href: '/pair', label: 'Pair a machine', kind: 'quiet' })}</p>
</article>
<article class="np-card" id="browsing" aria-labelledby="h-browsing">
<header class="np-card-h"><span class="np-ic">${glyphs.svg('globe', { size: 20 })}</span><h3 id="h-browsing">Your usual internet address</h3><p>When your agents browse on an OpenVibe computer, sites can see your home internet instead of a data centre's: fewer "are you a robot?" checks, your country's pages. It needs this computer on, with Link running.</p></header>
<form class="np-send" data-egress-settings>
<label class="np-switch"><input type="checkbox" role="switch" name="enabled" checked><span><b>Use my computer's internet</b><small>Off: your agents always use OpenVibe's address.</small></span></label>
<div class="np-pair">
<label>When my computer is offline<select name="offline"><option value="openvibe">Use OpenVibe's address</option><option value="wait">Wait for my computer</option></select></label>
<label>Monthly limit (GB)<input type="number" name="cap" min="0" max="10000" value="20" step="1" inputmode="numeric"></label>
</div>
<label>Sites that should use OpenVibe's address<textarea name="sites" rows="2" placeholder="example.com, another.example"></textarea><small>Comma-separated: your bank or work sites, for example. Past the monthly limit, browsing uses OpenVibe's address until the month ends.</small></label>
<button type="submit">Save browsing settings</button><p role="status" data-egress-status></p>
</form>
</article>
<article class="np-card" id="send" aria-labelledby="h-send">
<header class="np-card-h"><span class="np-ic">${glyphs.svg('send', { size: 20 })}</span><h3 id="h-send">Send to my machine</h3><p>A file or a short note to one of your machines, encrypted on this page before it leaves; the relay holds only the sealed envelope, at most 24 hours.</p></header>
<form class="np-send" data-link-send>
<label>Send to <select name="machine" required><option value="">Loading your machines…</option></select></label>
<label class="np-file">File <input name="file" type="file"></label>
<label>Or a text note <textarea name="text" rows="2" maxlength="10000" placeholder="Write a short note"></textarea></label>
<button type="submit">Encrypt and send</button>
<progress max="100" value="0" data-send-progress hidden></progress>
<p role="status" aria-live="polite" data-send-status></p>
</form>
<details class="np-sent"><summary>Sent from this page</summary>
<p class="np-fine">Only what this page sent: whether the machine accepted it, declined it, or saved it. Nothing here can be read by OpenVibe.</p>
<ul data-send-delivery aria-live="polite"></ul>
</details>
</article>
</div>
</section>

${releaseBlock(release)}

<section class="np-sec" aria-labelledby="h-never"><h2 id="h-never">What it never does</h2>
<ul class="np-never">${NEVER.map((n, k) => `<li><span class="np-ic np-ic--sm">${glyphs.svg(['link', 'stop', 'shield', 'x-circle'][k] || 'shield', { size: 18 })}</span><span>${esc(n)}</span></li>`).join('')}</ul>
</section>

<section class="np-sec" aria-labelledby="h-docs"><h2 id="h-docs">The docs</h2>
<ul class="np-docs">
${[['download', 'install', 'Install', 'Every OS, every option, and what the installer does.'],
    ['computer', 'computer', 'Your computer for your agents', 'The computer plugin, its levels and the live screen.'],
    ['box', 'worker', 'A machine that runs your jobs', 'The sandbox the job runner uses.'],
    ['link', 'protocol', 'The protocol', 'The wire format between Link and OpenVibe.Bot.'],
    ['book', 'memory', 'Your memory', 'What the collectors read and how it is uploaded.']].map(([ic, doc, t, d]) => `<li><a href="${DOCS}/${doc}.md"><span class="np-ic np-ic--sm">${glyphs.svg(ic, { size: 18 })}</span><span><b>${esc(t)}</b><small>${esc(d)}</small></span></a></li>`).join('\n')}
</ul>
<p class="np-fine">The source is on <a href="https://github.com/OpenVibers/OpenVibe.Link">GitHub</a>. The installer also lives at <a href="https://openvibe.bot/install">openvibe.bot/install</a>, which keeps working.</p>
</section>
</main>
${require('openvibe-shared/footer').ssr({ service: 'network', variant: 'compact' })}
<script src="/shared/navbar.js" defer></script>
${require('../boost').SCRIPT}
<script src="/shared/kit-web.js" defer></script>
<script type="module" src="/send.js"></script>
<script src="/egress-settings.js" defer></script>
<script>document.addEventListener('DOMContentLoaded',function(){try{if(window.OpenVibeNavbar)OpenVibeNavbar.init({service:'network',apiBase:'https://openvibe.network',sessionUrl:'/auth/me',loginUrl:'/auth/login?next={path}',logoutUrl:'/auth/logout?next={url}',silentLogin:'/auth/login?silent=1&next={url}',links:${JSON.stringify(pageLinks.LINK)}});}catch(e){}});</script>
</body>
</html>`;
}

const CSS = `
.np{max-width:1000px;margin:0 auto;padding:32px 20px 72px}
.np h1{margin:0 0 12px;font-size:clamp(1.7rem,5vw,2.6rem);letter-spacing:-.02em;line-height:1.12}
.np-lede{margin:0 0 18px;max-width:760px;color:var(--text-secondary,#96a7c2);line-height:1.65;font-size:1.03rem}
.np-lede code,.np code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9em}
.np-cta{display:flex;flex-wrap:wrap;gap:10px;margin:0}
.np-sec{margin-top:44px}
.np-send{display:grid;gap:12px;max-width:560px;padding:18px;border:1px solid var(--border,#1f2d47);border-radius:16px;background:var(--bg-card,#0f1729)}
.np-send label{display:grid;gap:6px;font-size:.92rem;font-weight:650}
.np-send input:not([type=checkbox]):not([type=radio]),.np-send select,.np-send textarea{width:100%;box-sizing:border-box;padding:10px;border:1px solid var(--border,#1f2d47);border-radius:9px;background:var(--bg-primary,#080d18);color:var(--text-primary,#eef2ff);font:inherit}
.np-send>button[type=submit]{justify-self:start;min-height:44px;padding:10px 14px;border:0;border-radius:9px;background:var(--accent,#3b82f6);color:white;font:inherit;font-weight:700;cursor:pointer}
.np-send label small{font-weight:400;font-size:.82rem;line-height:1.45;color:var(--text-secondary,#96a7c2)}
/* A switch and its words on one row (11-14: the switch had stretched into a long empty pill over its label). */
.np-send .np-switch{display:flex;align-items:center;gap:12px;min-height:44px;cursor:pointer}
.np-send .np-switch>span{display:grid;gap:2px}
@media (max-width:560px){.np-send{padding:14px;border-radius:14px}}
.np-send [role=status]{margin:0;min-height:1.3em;color:var(--text-secondary,#96a7c2)}
.np-sec h2{margin:0 0 14px;font-size:1.3rem;letter-spacing:-.01em}
.np-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px}
.np-does{padding:16px;border-radius:16px;background:var(--bg-card,#0f1729);border:1px solid var(--border,#1f2d47);display:grid;grid-template-columns:auto minmax(0,1fr);column-gap:14px;row-gap:4px;align-content:start}
.np-does>*{grid-column:2}
.np-does-ic{grid-column:1!important;grid-row:1/span 3;display:grid;place-items:center;width:42px;height:42px;border-radius:12px;color:var(--accent-light,var(--accent,#60a5fa));background:color-mix(in srgb,var(--accent,#3b82f6) 14%,transparent)}
.np-does-ic svg{width:21px;height:21px}
.np-does h3{margin:1px 0 0;font-size:1rem;line-height:1.35}
.np-does p{margin:0;color:var(--text-secondary,#96a7c2);font-size:.92rem;line-height:1.55}
.np-does-go{margin-top:6px!important}
.np-does-go a{display:inline-flex;align-items:center;min-height:36px;color:var(--accent-light,var(--accent,#60a5fa));font-weight:650;text-decoration:none}
.np-does-go a:hover{text-decoration:underline;text-underline-offset:3px}
.np-soon{display:inline-block;margin-left:6px;padding:2px 8px;border-radius:999px;font-size:.68rem;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:var(--text-muted,#7386a3);border:1px solid var(--border,#1f2d47);vertical-align:middle}
.np-installs{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px}
.np-os-list{display:grid;gap:10px;max-width:860px}
.np-os{border-radius:14px;background:var(--bg-card,#0f1729);border:1px solid var(--border,#1f2d47);overflow:hidden}
.np-os[open]{border-color:var(--accent,#3b82f6)}
.np-os summary{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:14px 16px;cursor:pointer;list-style:none}
.np-os summary::-webkit-details-marker{display:none}
.np-os summary span{font-weight:800;font-size:1rem}
.np-os summary small{color:var(--text-muted,#7386a3);font-size:.82rem;text-align:right;margin-left:auto}
.np-os summary::after{content:'+';margin-left:12px;font-weight:800;color:var(--text-muted,#7386a3);font-size:1.05rem;line-height:1}
.np-os[open] summary::after{content:'−'}
.np-os-body{padding:0 16px 16px;border-top:1px solid var(--border,#1f2d47)}
.np-os-body p{color:var(--text-secondary,#96a7c2);font-size:.92rem;line-height:1.6}
.np-os-body a{color:var(--accent,#3b82f6)}
.np-install{padding:18px;border-radius:16px;background:var(--bg-card,#0f1729);border:1px solid var(--border,#1f2d47)}
.np-install h3{margin:0 0 8px;font-size:1rem}
.np-install .ovk-snip{margin:12px 0}
.np-fine{margin:10px 0 0;font-size:.88rem;color:var(--text-muted,#7386a3);line-height:1.55}
.np-warn{color:#f0b429}
.np-panels{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,330px),1fr));gap:14px;align-items:start}
.np-card{display:grid;gap:12px;padding:16px;border-radius:var(--ov-radius-2,16px);background:var(--bg-card,#0f1729);border:1px solid var(--border,#1f2d47);min-width:0}
.np-card-h{display:grid;grid-template-columns:auto minmax(0,1fr);gap:8px 12px;align-items:center}
.np-card-h h3{margin:0;font-size:1.02rem}
.np-card-h p{grid-column:1/-1;margin:0;color:var(--text-secondary,#96a7c2);font-size:.9rem;line-height:1.55}
@media (min-width:760px){.np-panels{grid-template-columns:minmax(0,1fr) minmax(0,1fr);grid-template-areas:'m b' 's b'}#machines{grid-area:m}#browsing{grid-area:b}#send{grid-area:s}}
.np-card .np-fine{margin:0}
.np-ic{display:grid;place-items:center;flex:none;width:40px;height:40px;border-radius:12px;color:var(--accent-light,var(--accent,#60a5fa));background:color-mix(in srgb,var(--accent,#3b82f6) 13%,transparent)}
.np-ic svg{width:20px;height:20px}
.np-ic--sm{width:32px;height:32px;border-radius:10px}
.np-ic--sm svg{width:17px;height:17px}
.np-card .np-send{max-width:none;padding:0;border:0;background:none;gap:10px}
.np-pair{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,210px),1fr));gap:10px}
.np-file input[type=file]{padding:6px}
.np-file input[type=file]::file-selector-button{margin-right:10px;padding:8px 12px;border:1px solid var(--border,#1f2d47);border-radius:8px;background:var(--bg-secondary,#16223a);color:var(--text-primary,#eef2ff);font:inherit;font-weight:650;cursor:pointer}
.np-sent{border-top:1px solid var(--border,#1f2d47);padding-top:8px}
.np-sent>summary{min-height:40px;display:flex;align-items:center;cursor:pointer;font-weight:650;color:var(--text-secondary,#96a7c2)}
.np-sent ul{margin:6px 0 0;padding-left:18px;color:var(--text-secondary,#96a7c2);font-size:.9rem}
.np-release .ovk-list{border-radius:var(--ov-radius-2,16px)}
.np-never,.np-docs{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr));gap:10px}
.np-never li{display:grid;grid-template-columns:auto minmax(0,1fr);gap:12px;align-items:start;padding:12px 14px;border-radius:14px;background:var(--bg-card,#0f1729);border:1px solid var(--border,#1f2d47);color:var(--text-secondary,#96a7c2);font-size:.9rem;line-height:1.55}
.np-docs a{display:grid;grid-template-columns:auto minmax(0,1fr);gap:12px;align-items:center;min-height:56px;padding:10px 14px;border-radius:14px;background:var(--bg-card,#0f1729);border:1px solid var(--border,#1f2d47);color:inherit!important;text-decoration:none;transition:border-color .15s ease,transform .15s ease}
.np-docs a:hover,.np-docs a:focus-visible{border-color:color-mix(in srgb,var(--accent,#3b82f6) 55%,var(--border,#1f2d47))}
.np-docs a span:last-child{display:grid;gap:2px}
.np-docs b{color:var(--text-primary,#eef2ff);font-size:.95rem}
.np-docs small{color:var(--text-secondary,#96a7c2);font-size:.84rem;line-height:1.45}
.np a:not(.ovk-btn){color:var(--accent,#3b82f6)}
@media (max-width:640px){.np{padding:22px 16px 52px}}
`;

module.exports = { render, HOST, WWW_HOST, SITE, DOCS, INSTALL_LINE, DOES, NEVER };
