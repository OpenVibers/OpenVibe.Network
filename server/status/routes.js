'use strict';
/**
 * Operator status (roadmap Track O): what each OpenVibe service is doing right now, stated as
 * observed rather than hoped.
 *
 *   GET /status                  server-rendered page (works without JavaScript; noindex)
 *   GET /api/v1/status           the same rows as JSON
 *   GET /api/v1/status/slo       SLO categories (docs/slo.json) — proposals, not commitments
 *
 * Rows come from the ecosystem registry's health poll (server/registry/ecosystem.js): each running
 * service's readiness (openvibe-shared/ready shape) and /release.json. Every row is one of
 * up | degraded | down | not-running | unknown and carries checked_at; a service not checked yet, or
 * whose last check is stale, is 'unknown' — never an optimistic default.
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const contracts = require('openvibe-contracts');
const seo = require('openvibe-shared/seo');

const SLO_FILE = path.join(__dirname, '..', '..', 'docs', 'slo.json');
const esc = seo.esc;
const STATES = ['up', 'degraded', 'down', 'not-running', 'unknown'];
const LABEL = { up: 'Up', degraded: 'Degraded', down: 'Down', 'not-running': 'Not running', unknown: 'Unknown' };

function loadSlo() { return JSON.parse(fs.readFileSync(SLO_FILE, 'utf8')); }

function rows(ecosystem) {
    return contracts.services.manifests.map((m) => {
        const r = ecosystem.current(m.id);
        const status = STATES.includes(r.status) ? r.status : 'unknown';
        return {
            id: m.id,
            name: m.name,
            manifest_status: m.status,
            origin: m.publicOrigin || null,
            status,
            label: status === 'not-running' && r.reason ? `not running (${r.reason})` : status,
            basis: r.basis || null,
            reason: r.reason || r.error || null,
            checked_at: r.checked_at || null,
            http_status: r.http_status ?? null,
            latency_ms: r.latency_ms ?? null,
            release: r.release && r.release.release ? { release: r.release.release, released_at: r.release.released_at || null, booted_at: r.release.booted_at || null } : null,
            release_error: r.release && !r.release.release ? r.release.error || 'unknown' : null,
            ready: r.ready || null,
            ...(r.stale ? { stale: true, last_status: r.last_status } : {}),
        };
    });
}

function summary(list) {
    const counts = Object.fromEntries(STATES.map((s) => [s, 0]));
    for (const r of list) counts[r.status]++;
    return counts;
}

const CSS = `
.st{max-width:1080px;margin:32px auto 64px;padding:0 20px}.st h1{font-size:clamp(24px,3vw,32px);letter-spacing:-.02em;margin:0 0 6px}
.st p.lede{color:var(--text-secondary,#96a7c2);margin:0 0 18px;max-width:780px;line-height:1.5}
.st-sum{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 18px;padding:0;list-style:none}.st-sum li{padding:6px 12px;border-radius:999px;border:1px solid var(--border,#1f2d47);font-size:13.5px}
.st table{width:100%;border-collapse:collapse;font-size:14px}.st th,.st td{text-align:left;padding:10px 8px;border-bottom:1px solid var(--border,#1f2d47);vertical-align:top}
.st th{font-size:12px;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted,#7386a3)}
.st td small{display:block;color:var(--text-muted,#7386a3);font-size:12.5px;margin-top:2px}
.st code{font-size:12.5px}.st-b{display:inline-block;padding:2px 9px;border-radius:999px;font-weight:700;font-size:12.5px;border:1px solid currentColor}
.st-up{color:var(--success,#22c55e)}.st-degraded{color:#f59e0b}.st-down{color:var(--live-red,#ef4444)}.st-not-running,.st-unknown{color:var(--text-muted,#7386a3)}
.st ul.chk{margin:4px 0 0;padding:0;list-style:none;font-size:12.5px}.st ul.chk li{margin:1px 0}
.st section{margin-top:40px}.st dl{display:grid;grid-template-columns:minmax(160px,240px) 1fr;gap:6px 16px;font-size:14px}.st dt{font-weight:600}.st dd{margin:0;color:var(--text-secondary,#96a7c2)}
@media (max-width:720px){.st table,.st tbody,.st tr,.st td{display:block}.st thead{display:none}.st tr{border-bottom:1px solid var(--border,#1f2d47);padding:8px 0}.st td{border:0;padding:4px 0}.st dl{grid-template-columns:1fr}}`;

function checksList(ready) {
    if (!ready || !ready.checks) return '';
    const items = Object.entries(ready.checks).map(([n, c]) => `<li>${c.status === 'ok' ? 'ok' : 'FAIL'} · <code>${esc(n)}</code>${c.required ? '' : ' (optional)'}${c.error ? ` — ${esc(c.error)}` : ''}</li>`);
    return items.length ? `<ul class="chk">${items.join('')}</ul>` : '';
}

function renderPage(list, slo, generatedAt) {
    const counts = summary(list);
    const tr = list.map((r) => `<tr id="svc-${esc(r.id)}">
<td><b>${esc(r.name)}</b><small>${esc(r.id)} · manifest: ${esc(r.manifest_status)}</small></td>
<td><span class="st-b st-${esc(r.status)}">${esc(r.status === 'not-running' ? r.label : LABEL[r.status])}</span>${r.stale ? `<small>last seen ${esc(r.last_status)}</small>` : ''}${r.basis === 'health' ? '<small>liveness only (no readiness endpoint)</small>' : ''}${r.reason && r.status !== 'not-running' ? `<small>${esc(r.reason)}</small>` : ''}${checksList(r.ready)}</td>
<td>${r.release ? `<code>${esc(r.release.release)}</code>${r.release.booted_at ? `<small>booted ${esc(r.release.booted_at)}</small>` : ''}` : `<small>${r.status === 'not-running' ? '—' : esc(r.release_error ? `unknown (${r.release_error})` : 'unknown')}</small>`}</td>
<td>${r.checked_at ? `<time datetime="${esc(r.checked_at)}">${esc(r.checked_at)}</time>` : '<small>not checked yet</small>'}${r.latency_ms != null ? `<small>${esc(r.latency_ms)} ms</small>` : ''}</td>
</tr>`).join('\n');
    const sloRows = slo.categories.map((c) => `<dt>${esc(c.name)}</dt><dd>${esc(c.sli)} <br><small>Proposed: ${esc(Object.entries(c.proposed_target).map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`).join('; '))} · priority: ${esc(c.priority)} · ${esc(c.measurement_status || (c.measured_by.length ? 'measured' : 'not instrumented'))}</small></dd>`).join('\n');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Status · OpenVibe.Network</title>
<meta name="description" content="Observed status of each OpenVibe service: readiness, release and when it was last checked.">
<meta name="robots" content="noindex, nofollow">
${require('openvibe-shared/app-icon').headTags({ site: 'network', iconBase: '/assets' })}
<meta name="color-scheme" content="dark light">
<script>(function(){try{var raw=localStorage.getItem('ov_theme');if(!raw)return;var t=JSON.parse(raw),v=t&&t.variables;if(!v)return;var el=document.documentElement;for(var k in v)if(k.charAt(0)==='-')el.style.setProperty(k,v[k]);if(t.id)el.setAttribute('data-theme',t.id);}catch(_){}})();</script>
<script src="/shared/theme-loader.js" defer></script>
<style>
*,*::before,*::after{box-sizing:border-box}
:root{--bg-primary:#0a0f1c;--bg-secondary:#101828;--border:#1f2d47;--accent:#3b82f6;--text-primary:#e6edf7;--text-secondary:#96a7c2;--text-muted:#7386a3;--live-red:#ef4444;--success:#22c55e}
html,body{margin:0;background:var(--bg-primary);color:var(--text-primary);font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
a{color:var(--accent)}
${CSS}
</style>
</head>
<body>
<div id="navbar-mount"></div>
${require('openvibe-shared/chrome-ssr').noscriptNav({ name: 'OpenVibe.Network', links: [{ label: 'Status', href: '/status' }] })}
<main class="st" id="main">
<h1>Service status</h1>
<p class="lede">What Network observed when it last checked each service: its readiness endpoint (named checks, required or optional), its deployed release, and when. A service that has not been checked, or whose last check is out of date, shows as <b>unknown</b>. Placeholders show as not running. Page generated <time datetime="${esc(generatedAt)}">${esc(generatedAt)}</time>; checks run about every ${esc(Math.round(slo.pollSeconds || 60))} seconds. JSON: <a href="/api/v1/status"><code>/api/v1/status</code></a>.</p>
<ul class="st-sum">${STATES.map((s) => `<li class="st-${s}">${esc(LABEL[s])}: ${counts[s]}</li>`).join('')}</ul>
<table>
<thead><tr><th>Service</th><th>Status</th><th>Release</th><th>Checked</th></tr></thead>
<tbody>
${tr}
</tbody>
</table>
<section aria-labelledby="h-slo"><h2 id="h-slo">SLO categories (proposals)</h2>
<p class="lede">${esc(slo.note)} ${esc(slo.binding)} JSON: <a href="/api/v1/status/slo"><code>/api/v1/status/slo</code></a>.</p>
<dl>
${sloRows}
</dl></section>
</main>
${require('openvibe-shared/footer').ssr({ service: 'network', variant: 'compact' })}
<script src="/shared/navbar.js" defer></script>
<script>document.addEventListener('DOMContentLoaded',function(){try{if(window.OpenVibeNavbar)OpenVibeNavbar.init({service:'network',apiBase:location.origin});}catch(e){}});</script>
</body>
</html>`;
}

function createStatusRoutes({ ecosystem, now = () => new Date() }) {
    const r = express.Router();
    r.get('/api/v1/status', (_req, res) => {
        const list = rows(ecosystem);
        const last = ecosystem.lastPollAt();
        res.set('Cache-Control', 'no-cache, max-age=0').set('Access-Control-Allow-Origin', '*').json({
            generated_at: now().toISOString(),
            last_poll_at: last ? new Date(last).toISOString() : null,
            poll_seconds: Math.round(ecosystem.pollMs / 1000),
            states: STATES,
            summary: summary(list),
            services: list,
        });
    });
    r.get('/api/v1/status/slo', (_req, res) => {
        res.set('Cache-Control', 'public, max-age=300').set('Access-Control-Allow-Origin', '*').json(loadSlo());
    });
    r.get('/status', (_req, res) => {
        const slo = { ...loadSlo(), pollSeconds: ecosystem.pollMs / 1000 };
        res.set('Content-Type', 'text/html; charset=utf-8').set('Cache-Control', 'no-cache, max-age=0').set('X-Robots-Tag', 'noindex, nofollow');
        res.send(renderPage(rows(ecosystem), slo, now().toISOString()));
    });
    return r;
}

module.exports = { createStatusRoutes, rows, STATES };
