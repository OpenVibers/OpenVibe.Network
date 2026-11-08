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
    const latest = 'https://github.com/OpenVibers/OpenVibe.Node/releases/latest/download';
    const releases = 'https://github.com/OpenVibers/OpenVibe.Node/releases';
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
<p class="np-fine">The code comes from <a href="/pair">openvibe.link/pair</a> (the signed-in machines hub, <strong>Pair a machine</strong>). <code>openvibe-node.exe</code> is the same program under its old name.</p>
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
<p class="np-fine">The program is <code>openvibe-link</code>. <code>openvibe-node</code> is kept as an alias, so existing installs and scripts keep working. Every download is checked against the release's <a href="${esc(dl('SHA256SUMS'))}">SHA256SUMS</a>.</p>`;
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
    return `<section class="np-sec" aria-labelledby="h-release"><h2 id="h-release">The latest release</h2>
<p class="np-fine">${version ? `Version <strong>${esc(version)}</strong>` : 'The download links always point at the latest release.'}${date ? `, published ${esc(date)}` : ''}. The install command above always installs that release.</p>
${kit.list(rows, { flush: true })}
${release.stale && days >= 1 ? `<p class="np-fine np-warn">GitHub could not be reached just now, so this is the last release we read, from ${days === 1 ? 'a day' : `${days} days`} ago.</p>` : ''}
</section>`;
}

/** The page. `release` is what server/node/release.js answered. */
function render({ release = {}, releaseId, userAgent } = {}) {
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
<p class="np-cta">${kit.button({ href: '#install', label: 'Install Link', kind: 'primary' })} ${kit.button({ href: `${DOCS}/install.md`, label: 'The install guide', kind: 'quiet' })}</p>
</header>

<section class="np-sec" aria-labelledby="h-does"><h2 id="h-does">What it does today</h2>
<div class="np-grid">${does}</div>
</section>

<section class="np-sec" id="install" aria-labelledby="h-install"><h2 id="h-install">Install it</h2>
<p class="np-fine" style="margin:0 0 12px">Your system is open first; choose another to see its steps.</p>
${installBlock(release, userAgent)}
</section>

<section class="np-sec" id="machines" aria-labelledby="h-machines"><h2 id="h-machines">Your machines</h2>
<p class="np-fine">Sign in to see every machine you paired: whether it is online, what it is allowed to do, and the one-time code to add another. The same page renames or revokes one, and the phone pairs there too.</p>
<p class="np-cta" style="margin-top:12px">${kit.button({ href: 'https://openvibe.my/machines', label: 'Open your machines', kind: 'primary' })} ${kit.button({ href: '/pair', label: 'Pair a machine', kind: 'quiet' })}</p>
</section>

<section class="np-sec" id="send" aria-labelledby="h-send"><h2 id="h-send">Send to my machine</h2>
<p class="np-fine">Choose one of your paired machines and send a file or a short text note. Link encrypts it for that machine before it leaves this page; the relay only holds the encrypted envelope for up to 24 hours.</p>
<form class="np-send" data-link-send>
<label>Send to <select name="machine" required><option value="">Loading your machines…</option></select></label>
<label>File <input name="file" type="file"></label>
<label>Or a text note <textarea name="text" rows="3" maxlength="10000" placeholder="Write a short note"></textarea></label>
<button type="submit">Encrypt and send</button><p role="status" aria-live="polite" data-send-status></p>
</form>
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
<script type="module" src="/send.js"></script>
<script>document.addEventListener('DOMContentLoaded',function(){try{if(window.OpenVibeNavbar)OpenVibeNavbar.init({service:'network',apiBase:'https://openvibe.network',sessionUrl:'/auth/me',loginUrl:'/auth/login?next={path}',logoutUrl:'/auth/logout?next={url}',silentLogin:'/auth/login?silent=1&next={url}',links:[{label:'Link',href:'/',icon:'fa-desktop',featured:true,active:true},{label:'Machines',href:'/machines',icon:'fa-laptop'},{label:'Network',href:'https://openvibe.network/'},{label:'My Account',href:'https://openvibe.network/my'}]});}catch(e){}});</script>
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
.np-send{display:grid;gap:12px;max-width:560px;padding:18px;border:1px solid var(--border,#1f2d47);border-radius:16px;background:var(--bg-card,#0f1729)}
.np-send label{display:grid;gap:6px;font-size:.92rem;font-weight:650}
.np-send input,.np-send select,.np-send textarea{width:100%;box-sizing:border-box;padding:10px;border:1px solid var(--border,#1f2d47);border-radius:9px;background:var(--bg-primary,#080d18);color:var(--text-primary,#eef2ff);font:inherit}
.np-send button{justify-self:start;padding:10px 14px;border:0;border-radius:9px;background:var(--accent,#3b82f6);color:white;font:inherit;font-weight:700;cursor:pointer}
.np-send [role=status]{margin:0;min-height:1.3em;color:var(--text-secondary,#96a7c2)}
.np-sec h2{margin:0 0 14px;font-size:1.3rem;letter-spacing:-.01em}
.np-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px}
.np-does{padding:18px;border-radius:16px;background:var(--bg-card,#0f1729);border:1px solid var(--border,#1f2d47);display:flex;flex-direction:column;gap:6px}
.np-does svg{width:22px;height:22px;color:var(--accent,#3b82f6)}
.np-does h3{margin:2px 0 0;font-size:1rem;line-height:1.35}
.np-does p{margin:0;color:var(--text-secondary,#96a7c2);font-size:.92rem;line-height:1.55}
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
.np-never,.np-docs{list-style:none;margin:0;padding:0;display:grid;gap:8px;max-width:820px}
.np-never li{position:relative;padding:11px 14px 11px 42px;border-radius:12px;background:var(--bg-card,#0f1729);border:1px solid var(--border,#1f2d47);color:var(--text-secondary,#96a7c2);font-size:.93rem;line-height:1.55}
.np-never li::before{content:"";position:absolute;left:15px;top:16px;width:13px;height:13px;border-radius:50%;background:color-mix(in srgb,var(--accent,#3b82f6) 22%,transparent);box-shadow:inset 0 0 0 2px var(--accent,#3b82f6)}
.np-docs li{padding:11px 14px;border-radius:12px;background:var(--bg-card,#0f1729);border:1px solid var(--border,#1f2d47);font-size:.93rem;line-height:1.55}
.np a:not(.ovk-btn){color:var(--accent,#3b82f6)}
@media (max-width:640px){.np{padding:22px 16px 52px}}
`;

module.exports = { render, HOST, WWW_HOST, LEGACY_HOST, SITE, DOCS, INSTALL_LINE, DOES, NEVER };
