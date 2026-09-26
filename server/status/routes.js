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
 *
 * Each row also carries release_health (server/registry/release-health.js, WS-P task 15): what open tabs
 * report for services that collect release-watch reports: tabs on the current and older releases, prompts,
 * updates, deferrals and failures, and how long the last release took to drain.
 *
 * Each row also carries its exposure (server/registry/exposure.js): live (public), internal (loopback
 * only), library, repository or placeholder. A service that is up on loopback while its public domain
 * serves a placeholder reads "up (loopback only)" and has no public origin, never a bare "up".
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const contracts = require('openvibe-contracts');
const seo = require('openvibe-shared/seo');
const exposure = require('../registry/exposure');

const SLO_FILE = path.join(__dirname, '..', '..', 'docs', 'slo.json');
// The daily developer path against production (OpenVibe.Host openvibe-devpath.timer, WS-N task 1): step
// names and outcomes only, written by OpenVibe.Examples' developer-path --result.
const DEVPATH_FILE = process.env.DEVPATH_RESULT_FILE || '/var/lib/openvibe-devpath/last.json';
// The Tools job proof (openvibe-toolsjob.timer, WS-L task 4): the same record from OpenVibe.Examples'
// tools-job-proof --result, read by the same loader.
const TOOLSJOB_FILE = process.env.TOOLSJOB_RESULT_FILE || '/var/lib/openvibe-devpath/tools-job.json';
function loadDevPath(file = DEVPATH_FILE) {
    try {
        const d = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!d || !Array.isArray(d.steps)) return null;
        return { ok: !!d.ok, finished_at: String(d.finished_at || ''), steps: d.steps.slice(0, 20).map((st) => ({ name: String(st.name).slice(0, 40), ok: !!st.ok, skipped: !!st.skipped })) };
    } catch { return null; }
}
const esc = seo.esc;
const STATES = ['up', 'degraded', 'down', 'not-running', 'unknown'];
const LABEL = { up: 'Up', degraded: 'Degraded', down: 'Down', 'not-running': 'Not running', unknown: 'Unknown' };

/** The deployed commit against main (registry/deploy-drift.js), as a short note under the release. */
function mainNote(d) {
    if (!d) return '';
    if (d.state === 'current') return '<small>main: current</small>';
    if (d.state === 'behind') return `<small>main: ${esc(String(d.behind_by))} commit${d.behind_by === 1 ? '' : 's'} not deployed${d.since ? ` since <time datetime="${esc(d.since)}">${esc(d.since.slice(0, 16).replace('T', ' '))} UTC</time>` : ''}</small>`;
    if (d.state === 'diverged') return '<small>main: not on main (a local build)</small>';
    return '';
}

function loadSlo() { return JSON.parse(fs.readFileSync(SLO_FILE, 'utf8')); }

function rows(ecosystem) {
    return contracts.services.manifests.map((m) => {
        const r = ecosystem.current(m.id);
        const status = STATES.includes(r.status) ? r.status : 'unknown';
        const exp = exposure.exposureOf(m.id);
        const origin = exposure.publicOriginOf(m);
        const loopback = exp.state !== 'live' && !['not-running', 'unknown'].includes(status);
        return {
            id: m.id,
            name: m.name,
            manifest_status: m.status,
            exposure: exp,
            origin,
            ...(!origin && m.publicOrigin ? { planned_origin: m.publicOrigin } : {}),
            status,
            label: status === 'not-running' && r.reason ? `not running (${r.reason})` : loopback ? `${status} (loopback only)` : status,
            basis: r.basis || null,
            reason: r.reason || r.error || null,
            checked_at: r.checked_at || null,
            http_status: r.http_status ?? null,
            latency_ms: r.latency_ms ?? null,
            release: r.release && r.release.release ? { release: r.release.release, released_at: r.release.released_at || null, booted_at: r.release.booted_at || null } : null,
            main: (() => { const d = require('../registry/deploy-drift').current(m.id); return d ? { state: d.state, behind_by: d.behind_by ?? null, since: d.since || null } : null; })(),
            release_error: r.release && !r.release.release ? r.release.error || 'unknown' : null,
            ready: r.ready || null,
            release_health: typeof ecosystem.releaseHealth === 'function' ? ecosystem.releaseHealth(m.id) : null,
            ...(r.stale ? { stale: true, last_status: r.last_status } : {}),
        };
    });
}

const dur = (s) => (s == null ? '—' : s < 90 ? `${s} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);
const reasons = (o) => Object.entries(o || {}).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${v}`).join(', ');
function drainCell(d) {
    if (!d || d.state === 'unknown') return '<small>no reports yet</small>';
    if (d.state === 'warming') return `warming up<small>${esc(d.older)} older tab(s) so far; reliable in ${esc(dur(d.ready_in_s))}</small>`;
    if (d.state === 'draining') return `<b>${esc(d.older)}</b> older tab(s)<small>for ${esc(dur(d.for_s))}</small>`;
    if (d.seen_late) return 'drained<small>before Network watched</small>';
    return `drained ${d.within ? 'within' : 'in'} ${esc(dur(d.seconds))}`;
}
/** The release-health section: services whose tabs report (WS-P task 15). */
function releaseHealthSection(list, since) {
    const rowsOf = list.filter((r) => r.release_health);
    if (!rowsOf.length) return '<p class="lede">No service has reported release health yet.</p>';
    const tr = rowsOf.map((r) => {
        const h = r.release_health; const s = h.sessions; const c = h.counts;
        const mix = s ? (s.current + s.older ? `${s.current} / ${s.older}<small>${Math.round((100 * s.current) / (s.current + s.older))}% on current</small>` : '0 / 0') : '<small>—</small>';
        return `<tr><td><b>${esc(r.name)}</b><small><code>${esc(h.release)}</code></small></td><td>${mix}</td><td>${drainCell(h.drain)}</td>
<td>${esc(c.prompted)} · ${esc(c.applied)} · ${esc(c.reloaded)}</td><td>${esc(c.deferred)}${c.deferred ? `<small>${esc(reasons(h.deferred))}</small>` : ''}</td><td>${esc(c.failed)}${c.failed ? `<small>${esc(reasons(h.failed))}</small>` : ''}</td></tr>`;
    }).join('\n');
    return `<p class="lede">What open tabs report through release-watch: tabs heard from in the last 12 minutes on the release each service serves and on older ones, and since that release started, how many were prompted, updated in place or reloaded, deferred (and why) or failed. Drain is how long after a release went live the last older tab left; tabs report every 5 minutes, so it reads true only 6 minutes after a start. Watched since ${esc(since)}.</p>
<table><thead><tr><th>Service</th><th>Tabs current / older</th><th>Drain</th><th>Prompted · applied · reloaded</th><th>Deferred</th><th>Failed</th></tr></thead>
<tbody>
${tr}
</tbody></table>`;
}

function summary(list) {
    const counts = Object.fromEntries(STATES.map((s) => [s, 0]));
    for (const r of list) counts[r.status]++;
    return counts;
}

function exposureSummary(list) {
    const counts = Object.fromEntries(exposure.STATES.map((s) => [s, 0]));
    for (const r of list) counts[r.exposure.state] = (counts[r.exposure.state] || 0) + 1;
    return counts;
}

function exposureCell(r) {
    const e = r.exposure;
    const where = r.origin ? `<small><a href="${esc(r.origin)}" rel="noopener">${esc(r.origin.replace(/^https:\/\//, ''))}</a></small>`
        : r.planned_origin ? `<small>${esc(r.planned_origin.replace(/^https:\/\//, ''))}: not this service yet</small>` : '';
    return `${esc(e.label)}${e.release ? ` <code>${esc(e.release)}</code>` : ''}${where}${e.note ? `<small>${esc(e.note)}</small>` : ''}`;
}

const CSS = `
.st{max-width:1080px;margin:32px auto 64px;padding:0 20px}.st h1{font-size:clamp(24px,3vw,32px);letter-spacing:-.02em;margin:0 0 6px}
.st p.lede{color:var(--text-secondary,#96a7c2);margin:0 0 18px;max-width:780px;line-height:1.5}
.st-incidents{margin:0 0 20px}.st-incident{border:1px solid var(--border,#1f2d47);border-left:4px solid var(--warning,#f59e0b);border-radius:10px;padding:10px 14px;margin:0 0 10px}.st-incident h3{margin:0 0 4px;font-size:16px}.st-incident p{margin:4px 0}.st-maintenance{border-left-color:var(--info,#38bdf8)}.st-sev-critical,.st-sev-major{border-left-color:var(--danger,#ef4444)}.st-quiet{color:var(--text-muted,#8b93ad);margin:0 0 14px}.st-sum{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 18px;padding:0;list-style:none}.st-sum li{padding:6px 12px;border-radius:999px;border:1px solid var(--border,#1f2d47);font-size:13.5px}
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

/** A scheduled proof's step list (developer path, Tools job proof). */
function proofSteps(rec) {
    return `<ul class="st-sum">${rec.steps.map((st) => `<li class="st-${st.ok ? 'up' : st.skipped ? 'unknown' : 'down'}">${esc(st.name)}: ${st.ok ? 'ok' : st.skipped ? 'skipped' : 'failed'}</li>`).join('')}</ul>`;
}
const lastRun = (rec) => `Last run <time datetime="${esc(rec.finished_at)}">${esc(rec.finished_at)}</time>: <b>${rec.ok ? 'passed' : 'failed'}</b> (${rec.steps.filter((st) => st.ok).length}/${rec.steps.length} steps).`;

/** Open incidents and maintenance windows (server/status/incidents.js), at the top of /status. */
function incidentsSection(incidents) {
    const active = (incidents && incidents.active) || [];
    if (!active.length) return '<p class="st-quiet">No open incidents or maintenance. <a href="/api/v1/status/incidents">History</a></p>';
    const LBL = { investigating: 'Investigating', identified: 'Identified', monitoring: 'Monitoring', scheduled: 'Scheduled', in_progress: 'In progress' };
    return `<section class="st-incidents" aria-labelledby="h-incidents"><h2 id="h-incidents">Incidents and maintenance</h2>${active.map((i) => {
        const last = i.updates[i.updates.length - 1] || {};
        const when = i.kind === 'maintenance' ? `${esc(i.starts_at)}${i.ends_at ? ` – ${esc(i.ends_at)}` : ''}` : `since ${esc(i.starts_at)}`;
        return `<article class="st-incident st-${esc(i.kind)}${i.severity ? ` st-sev-${esc(i.severity)}` : ''}"><h3>${esc(i.title)}</h3>
<p><strong>${esc(LBL[i.state] || i.state)}</strong>${i.severity ? ` · ${esc(i.severity)}` : ''} · ${esc(i.services.join(', '))} · ${when}</p><p>${esc(last.message || '')}</p></article>`;
    }).join('')}<p><a href="/api/v1/status/incidents">History (JSON)</a></p></section>`;
}

function renderPage(list, slo, generatedAt, devPath = null, toolsJob = null, healthSince = null, incidents = null) {
    const counts = summary(list);
    const tr = list.map((r) => `<tr id="svc-${esc(r.id)}">
<td><b>${esc(r.name)}</b><small>${esc(r.id)} · manifest: ${esc(r.manifest_status)}</small></td>
<td>${exposureCell(r)}</td>
<td><span class="st-b st-${esc(r.status)}">${esc(r.status === 'not-running' ? r.label : LABEL[r.status] + (r.label.endsWith('(loopback only)') ? ' · loopback only' : ''))}</span>${r.stale ? `<small>last seen ${esc(r.last_status)}</small>` : ''}${r.basis === 'health' ? '<small>liveness only (no readiness endpoint)</small>' : ''}${r.reason && r.status !== 'not-running' ? `<small>${esc(r.reason)}</small>` : ''}${checksList(r.ready)}</td>
<td>${r.release ? `<code>${esc(r.release.release)}</code>${r.release.booted_at ? `<small>booted ${esc(r.release.booted_at)}</small>` : ''}${mainNote(r.main)}` : `<small>${r.status === 'not-running' ? '—' : esc(r.release_error ? `unknown (${r.release_error})` : 'unknown')}</small>`}</td>
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
${require('openvibe-shared/frame').noscriptNav({ name: 'OpenVibe.Network', links: [{ label: 'Status', href: '/status' }] })}
<main class="st" id="main">
<h1>Service status</h1>
${incidentsSection(incidents)}
<p class="lede">What Network observed when it last checked each service: its readiness endpoint (named checks, required or optional), its deployed release, and when. A service that has not been checked, or whose last check is out of date, shows as <b>unknown</b>. Placeholders, libraries and repositories show as not running. <b>Where</b> says whether the public domain serves the service itself (live), or the service runs on this host's loopback only while its domain still serves a placeholder page (internal). Page generated <time datetime="${esc(generatedAt)}">${esc(generatedAt)}</time>; checks run about every ${esc(Math.round(slo.pollSeconds || 60))} seconds. JSON: <a href="/api/v1/status"><code>/api/v1/status</code></a>.</p>
<ul class="st-sum">${STATES.map((s) => `<li class="st-${s}">${esc(LABEL[s])}: ${counts[s]}</li>`).join('')}</ul>
<table>
<thead><tr><th>Service</th><th>Where</th><th>Status</th><th>Release</th><th>Checked</th></tr></thead>
<tbody>
${tr}
</tbody>
</table>
<section aria-labelledby="h-release-health"><h2 id="h-release-health">Release health</h2>
${releaseHealthSection(list, healthSince || generatedAt)}
</section>
<section aria-labelledby="h-devpath"><h2 id="h-devpath">Developer path</h2>
${devPath ? `<p class="lede">Once a day a test developer account goes from sign-in to a sandbox project, a Media upload, an Events publish and pull, a credential rotation and revocation, and cleanup, through the public API and the SDK. ${lastRun(devPath)}</p>
${proofSteps(devPath)}` : '<p class="lede">The daily developer path has not reported here yet.</p>'}
</section>
<section aria-labelledby="h-toolsjob"><h2 id="h-toolsjob">Tools job proof</h2>
${toolsJob ? `<p class="lede">Every six hours a service client submits a converter job to OpenVibe.Tools through the SDK, drops and reattaches its progress stream, downloads the result from OpenVibe.Media and finds the job's events in OpenVibe.Events. ${lastRun(toolsJob)}</p>
${proofSteps(toolsJob)}` : '<p class="lede">The Tools job proof has not reported here yet.</p>'}
</section>
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
            exposure_states: exposure.STATES,
            exposure_summary: exposureSummary(list),
            release_health_since: typeof ecosystem.releaseHealthSince === 'function' ? ecosystem.releaseHealthSince() : null,
            developer_path: loadDevPath(),
            tools_job_proof: loadDevPath(TOOLSJOB_FILE),
            services: list,
        });
    });
    r.get('/api/v1/status/slo', (_req, res) => {
        res.set('Cache-Control', 'public, max-age=300').set('Access-Control-Allow-Origin', '*').json(loadSlo());
    });
    r.get('/status', (_req, res) => {
        const slo = { ...loadSlo(), pollSeconds: ecosystem.pollMs / 1000 };
        res.set('Content-Type', 'text/html; charset=utf-8').set('Cache-Control', 'no-cache, max-age=0').set('X-Robots-Tag', 'noindex, nofollow');
        let incidents = null;
        try { incidents = require('./incidents').list(_req.app.locals.db); } catch { incidents = null; }
        res.send(renderPage(rows(ecosystem), slo, now().toISOString(), loadDevPath(), loadDevPath(TOOLSJOB_FILE), typeof ecosystem.releaseHealthSince === 'function' ? ecosystem.releaseHealthSince() : null, incidents));
    });
    return r;
}

module.exports = { loadDevPath, createStatusRoutes, rows, STATES };
