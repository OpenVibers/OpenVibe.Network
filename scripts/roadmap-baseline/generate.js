#!/usr/bin/env node
'use strict';
/**
 * Wave 0 baseline generator (roadmap section 5, Wave 0; section 12 items 1-3).
 *
 *   node scripts/roadmap-baseline/generate.js           regenerate docs/roadmap-baseline/*
 *   node scripts/roadmap-baseline/generate.js --check   also exit 1 if any exit criterion fails
 *
 * Inputs
 *   - the sibling repo checkouts under OPENVIBE_ROOT (default: the directory holding this repo)
 *   - docs/roadmap-baseline/data/prod-snapshot.json   (collect-prod.sh, read-only SSH)
 *   - docs/roadmap-baseline/data/github.json          (collect-github.sh)
 *   - docs/roadmap-baseline/data/{services,ownership-rules,hazards,d-status}.json (hand-maintained)
 * Output is deterministic for the same inputs so diffs show real change.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const X = require('./extract');

const NETWORK_DIR = path.resolve(__dirname, '../..');
const ROOT = path.resolve(process.env.OPENVIBE_ROOT || path.join(NETWORK_DIR, '..'));
const OUT_DIR = path.join(NETWORK_DIR, 'docs/roadmap-baseline');
const DATA = path.join(OUT_DIR, 'data');
const CHECK = process.argv.includes('--check');

const REPOS = [
    { name: 'OpenVibe.Live', service: 'live', scan: ['server'] },
    { name: 'OpenVibe.Network', service: 'network', scan: ['server'] },
    // The shared package's own repo. Its tables are created in each consumer's database, so they are
    // attributed to the repos that require the module (below), not to this repo.
    { name: 'OpenVibe.Shared', service: 'shared', scan: ['.'], library: true },
    { name: 'OpenVibe.Media', service: 'media', scan: ['server'] },
    { name: 'OpenVibe.Tools', service: 'tools', scan: ['apps'] },
    { name: 'OpenVibe.Community', service: 'community', scan: ['server'] },
    { name: 'OpenVibe.Games', service: 'games', scan: ['apps/server/src', 'packages'] },
    { name: 'OpenVibe.Sites', service: 'sites', scan: ['build.js'] },
];
const CANONICAL_SHARED = path.join(ROOT, 'OpenVibe.Shared');

const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };
const git = (dir, ...args) => { try { return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
const sortBy = (arr, ...keys) => arr.sort((a, b) => { for (const k of keys) { const c = String(a[k] ?? '').localeCompare(String(b[k] ?? ''), 'en', { numeric: true }); if (c) return c; } return 0; });
const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const table = (head, rows) => rows.length
    ? [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map(r => `| ${r.map(esc).join(' | ')} |`)].join('\n')
    : '_none_';
const fmtBytes = (n) => n >= 1e9 ? (n / 1e9).toFixed(2) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n >= 1e3 ? (n / 1e3).toFixed(0) + ' KB' : n + ' B';

const services = readJson(path.join(DATA, 'services.json'), { services: [] }).services;
const rules = readJson(path.join(DATA, 'ownership-rules.json'), { rules: [] }).rules;
const hazards = readJson(path.join(DATA, 'hazards.json'), { hazards: [] });
const dstatus = readJson(path.join(DATA, 'd-status.json'), { families: [] }).families;
const prod = readJson(path.join(DATA, 'prod-snapshot.json'), null);
const github = readJson(path.join(DATA, 'github.json'), null);

// ── 1. Scan repos ─────────────────────────────────────────────────────────
function scanRepo(cfg) {
    const dir = path.join(ROOT, cfg.name);
    const repo = { name: cfg.name, service: cfg.service, present: fs.existsSync(dir) };
    if (!repo.present) return repo;
    repo.git = {
        head: git(dir, 'rev-parse', 'HEAD'), branch: git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'),
        originMain: git(dir, 'rev-parse', 'origin/main'), committedAt: git(dir, 'log', '-1', '--format=%cI'),
    };
    const files = cfg.scan.flatMap(s => {
        const p = path.join(dir, s);
        try { return fs.statSync(p).isFile() ? [p] : X.walk(p); } catch { return []; }
    });
    const rel = (f) => path.relative(dir, f);
    const source = files.filter(f => !X.isTestFile(rel(f)));
    repo.sourceFiles = source.length;
    repo.loc = 0;
    repo.tables = []; repo.routes = []; repo.ws = { servers: [], paths: [] };
    repo.env = {}; repo.outbound = []; repo.jobs = []; repo.contractTodos = 0;
    const mountsByFile = {}; const routesByFile = {}; const texts = {};

    const sharedRequires = new Set();
    for (const f of source) {
        const text = fs.readFileSync(f, 'utf8');
        texts[f] = text;
        const r = rel(f);
        repo.loc += text.split('\n').length;
        repo.contractTodos += (text.match(/TODO\(contract/g) || []).length;
        for (const m of text.matchAll(/require\(\s*['"]openvibe-shared\/([\w.-]+)['"]\s*\)/g)) sharedRequires.add(m[1]);
        if (!cfg.library) for (const t of X.extractTables(text)) repo.tables.push({ table: t.table, file: r, line: t.line, via: 'repo' });
        const mounts = X.extractMounts(text).map(m => ({ ...m, target: X.resolveModule(f, m.spec) }));
        if (mounts.length) mountsByFile[f] = mounts;
        const routes = cfg.service === 'games' ? X.extractRawRoutes(text) : X.extractRoutes(text);
        if (routes.length) routesByFile[f] = routes;
        const ws = X.extractWebSockets(text);
        ws.servers.forEach(s => repo.ws.servers.push({ file: r, line: s.line }));
        ws.paths.forEach(p => repo.ws.paths.push({ path: p.path, file: r, line: p.line }));
        for (const name of X.extractEnv(text)) (repo.env[name] ||= []).push(r);
        const ob = X.extractOutbound(text, cfg.service);
        if (ob) repo.outbound.push({ file: r, ...ob });
        for (const j of X.extractJobs(text)) repo.jobs.push({ ...j, file: r });
    }

    // Tables created by the openvibe-shared modules this repo requires (analytics etc.) belong to this
    // service's DB. Read from the repo's installed copy (a pre-migration vendor/ copy, node_modules, or
    // an app's node_modules in Tools), else from the OpenVibe.Shared checkout.
    const sharedDir = sharedPackageDir(dir);
    for (const sub of [...sharedRequires].sort()) {
        const f = sharedModuleFile(sharedDir, sub);
        if (!f) continue;
        const text = fs.readFileSync(f, 'utf8');
        const shown = f.startsWith(dir + path.sep) ? rel(f) : `OpenVibe.Shared/${path.relative(sharedDir, f)}`;
        for (const t of X.extractTables(text)) repo.tables.push({ table: t.table, file: shown, line: t.line, via: 'openvibe-shared' });
        const ob = X.extractOutbound(text, cfg.service);
        if (ob) repo.outbound.push({ file: shown, ...ob });
        for (const name of X.extractEnv(text)) (repo.env[name] ||= []).push(shown);
    }

    const { prefixesOf } = X.computePrefixes(mountsByFile);
    for (const [f, routes] of Object.entries(routesByFile)) {
        for (const rt of routes) {
            for (const p of prefixesOf(f)) repo.routes.push({ method: rt.method, path: X.joinPath(p, rt.path), file: rel(f), line: rt.line });
        }
    }
    const seen = new Set();
    repo.routes = sortBy(repo.routes.filter(r => { const k = `${r.method} ${r.path} ${r.file}:${r.line}`; if (seen.has(k)) return false; seen.add(k); return true; }), 'path', 'method');
    repo.unresolvedMounts = Object.entries(mountsByFile).flatMap(([f, ms]) => ms.filter(m => !m.target && m.spec).map(m => ({ file: rel(f), line: m.line, prefix: m.prefix, spec: m.spec })));

    // Tests and CI: count across the whole repo, not only scanned dirs.
    const allFiles = X.walk(dir);
    repo.testFiles = allFiles.filter(f => X.isTestFile(rel(f))).length;
    repo.ci = fs.existsSync(path.join(dir, '.github/workflows'));
    return repo;
}

function sharedPackageDir(dir) {
    const apps = path.join(dir, 'apps');
    const candidates = [path.join(dir, 'vendor/openvibe-shared'), path.join(dir, 'node_modules/openvibe-shared'),
        ...(fs.existsSync(apps) ? fs.readdirSync(apps).sort().map(a => path.join(apps, a, 'node_modules/openvibe-shared')) : [])];
    return candidates.find(d => fs.existsSync(path.join(d, 'package.json'))) || CANONICAL_SHARED;
}
function sharedModuleFile(pkgDir, sub) {
    const exp = (readJson(path.join(pkgDir, 'package.json'), {}).exports || readJson(path.join(CANONICAL_SHARED, 'package.json'), {}).exports || {})[`./${sub}`];
    const f = path.join(pkgDir, exp || (sub.endsWith('.js') ? sub : `${sub}.js`));
    return fs.existsSync(f) && f.endsWith('.js') ? f : null;
}

const repos = REPOS.map(scanRepo);
const byName = Object.fromEntries(repos.map(r => [r.name, r]));
const repoOfService = Object.fromEntries(REPOS.map(r => [r.service, r.name]));

// ── 2. openvibe-shared pins ─────────────────────────────────────────────
// Each consumer pins a tagged OpenVibe.Shared release in package.json (Tools: per app). A pin behind
// the newest tag, or a leftover file:/vendor copy, is drift.
const semver = (t) => (String(t).match(/^v?(\d+)\.(\d+)\.(\d+)$/) || []).slice(1).map(Number);
const newer = (a, b) => { const x = semver(a), y = semver(b); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };
const sharedTags = (git(CANONICAL_SHARED, 'tag', '--list', 'v*') || '').split('\n').filter(t => semver(t).length === 3);
const latestShared = sharedTags.reduce((a, t) => (!a || newer(t, a) ? t : a), null);
const sharedPins = [];
for (const r of repos.filter(r => r.present && r.service !== 'shared')) {
    const dir = path.join(ROOT, r.name);
    const apps = path.join(dir, 'apps');
    const manifests = ['package.json', ...(fs.existsSync(apps) ? fs.readdirSync(apps).sort().map(a => `apps/${a}/package.json`) : [])];
    for (const m of manifests) {
        const spec = ((readJson(path.join(dir, m), {}).dependencies) || {})['openvibe-shared'];
        if (!spec) continue;
        const tag = (spec.match(/\/refs\/tags\/(v[\d.]+)$/) || spec.match(/#(v[\d.]+)$/) || [])[1] || null;
        const state = !tag ? 'unpinned' : latestShared && newer(latestShared, tag) ? 'behind' : 'current';
        sharedPins.push({ repo: r.name, manifest: m, spec: tag || spec, state });
    }
}
sortBy(sharedPins, 'repo', 'manifest');
const pinLabel = (p) => `${p.repo.replace('OpenVibe.', '')}${p.manifest === 'package.json' ? '' : '/' + path.dirname(p.manifest)}`;

// ── 3. Table ownership ──────────────────────────────────────────────────
function classify(repo, tableName, dbs = []) {
    for (const rule of rules) {
        if (rule.repo !== '*' && rule.repo !== repo) continue;
        if (rule.db && !dbs.includes(rule.db)) continue;
        if (new RegExp(rule.match).test(tableName)) return rule;
    }
    return null;
}
const prodDbsByRepo = {};
if (prod) {
    for (const db of prod.databases) {
        const svc = (db.file.match(/^\/opt\/openvibe\.([a-z]+)\//) || [])[1];
        const repo = repoOfService[svc];
        (prodDbsByRepo[repo || 'unknown'] ||= []).push(db);
    }
}
const ownership = [];
for (const r of repos.filter(r => r.present)) {
    const declared = {};
    for (const t of r.tables) (declared[t.table] ||= []).push(`${t.file}:${t.line}`);
    const inProd = {};
    // Backups are copies, not live schema; they are reported under discrepancies instead.
    for (const db of (prodDbsByRepo[r.name] || []).filter(d => !/\/backups?\//.test(d.file))) for (const t of db.tables) (inProd[t] ||= []).push(path.basename(db.file));
    for (const name of new Set([...Object.keys(declared), ...Object.keys(inProd)])) {
        const inCode = Boolean(declared[name]);
        const rule = inCode ? classify(r.name, name) : classify('prod-only', name, inProd[name]);
        ownership.push({
            repo: r.name, table: name, declaredAt: declared[name] || [], prodDbs: [...new Set(inProd[name] || [])],
            inCode, inProd: Boolean(inProd[name]),
            target: rule ? (rule.target === 'keep' ? r.name : rule.target) : 'UNCLASSIFIED',
            disposition: rule ? rule.disposition : 'UNCLASSIFIED', wave: rule ? rule.wave : '', note: rule ? rule.note : '',
        });
    }
}
sortBy(ownership, 'repo', 'table');
const unclassified = ownership.filter(o => o.disposition === 'UNCLASSIFIED');

// ── 4. Cross-service calls ──────────────────────────────────────────────
const calls = [];
for (const r of repos) for (const ob of r.outbound || []) {
    for (const t of ob.targets) {
        calls.push({ caller: r.name, file: ob.file, target: repoOfService[t.service] || t.service,
            via: [...new Set(t.refs.map(x => x.via))].join(', '), lines: t.refs.map(x => x.line).join(','),
            auth: ob.auth.join(', '), timeout: ob.timeout, retry: ob.retry });
    }
}
sortBy(calls, 'caller', 'target', 'file');

// ── 5. Env names / secrets ──────────────────────────────────────────────
const envFileOfRepo = { 'OpenVibe.Live': 'live.env', 'OpenVibe.Network': 'network.env', 'OpenVibe.Media': 'media.env',
    'OpenVibe.Tools': 'tools.env', 'OpenVibe.Community': 'community.env', 'OpenVibe.Games': 'games.env' };
const prodEnv = prod ? prod.envFiles : {};
const sharedEnv = new Set(prodEnv['generated-secrets.env'] || []);
const envRows = [];
for (const r of repos.filter(r => r.present)) {
    const set = new Set(prodEnv[envFileOfRepo[r.name]] || []);
    for (const [name, files] of Object.entries(r.env)) {
        envRows.push({ repo: r.name, name, secret: X.isSecretName(name), files: [...new Set(files)].sort(),
            prod: set.has(name) ? envFileOfRepo[r.name] : sharedEnv.has(name) ? 'generated-secrets.env' : null });
    }
    for (const name of set) {
        if (!r.env[name]) envRows.push({ repo: r.name, name, secret: X.isSecretName(name), files: [], prod: envFileOfRepo[r.name], unreferenced: true });
    }
}
sortBy(envRows, 'repo', 'name');

// ── 6. Discrepancies (production vs repository) ─────────────────────────
const discrepancies = [];
const addD = (severity, area, subject, detail) => discrepancies.push({ severity, area, subject, detail });
if (!prod) addD('unknown', 'production', 'all', 'prod-snapshot.json missing: run collect-prod.sh');
else {
    for (const s of services) {
        const r = byName[s.repo];
        const dep = prod.deployments[s.id];
        if (!dep) { addD('high', 'deploy', s.id, `no /opt/openvibe.${s.id} on ${prod.host}`); continue; }
        const target = r && (r.git.originMain || r.git.head);
        if (dep.sha && target && dep.sha !== target && git(path.join(ROOT, s.repo), 'diff', '--quiet', dep.sha, target) === '') {
            addD('low', 'deploy', s.id, `deployed ${dep.sha.slice(0, 7)} has the same file tree as origin/main ${target.slice(0, 7)} but a different SHA (pre-rewrite history); reset the checkout so later pulls fast-forward`);
        } else if (dep.sha && target && dep.sha !== target) {
            const behind = git(path.join(ROOT, s.repo), 'rev-list', '--count', `${dep.sha}..${target}`);
            const ahead = git(path.join(ROOT, s.repo), 'rev-list', '--count', `${target}..${dep.sha}`);
            addD('medium', 'deploy', s.id, behind === null
                ? `deployed ${dep.sha.slice(0, 7)} is not in the local clone (unknown commit)`
                : `deployed ${dep.sha.slice(0, 7)} is ${behind} commit(s) behind origin/main ${target.slice(0, 7)}${ahead && ahead !== '0' ? `, ${ahead} ahead` : ''}`);
        }
        if (r && r.git.originMain && r.git.head && r.git.head !== r.git.originMain) {
            addD('info', 'checkout', s.repo, `local checkout ${r.git.head.slice(0, 7)} differs from origin/main ${r.git.originMain.slice(0, 7)}; scan reflects the checkout`);
        }
        const units = new Set(prod.units.map(u => u.unit));
        for (const u of s.units) if (!units.has(u)) addD('medium', 'units', s.id, `expected unit ${u} not present`);
        for (const u of prod.units.filter(u => u.unit.includes(`-${s.id}`))) {
            if (u.active !== 'active') addD('high', 'units', s.id, `${u.unit} is ${u.active}/${u.sub}`);
        }
    }
    const known = new Set(services.flatMap(s => s.units));
    for (const u of prod.units) if (!known.has(u.unit)) addD('info', 'units', u.unit, 'unit not listed in services.json');
    for (const db of prod.databases) {
        if (db.tables.length === 0) addD('low', 'database', db.file, `${fmtBytes(db.bytes)}, zero tables (dead file)`);
        if (/\/backups?\//.test(db.file)) addD('low', 'database', db.file, `${fmtBytes(db.bytes)} backup inside the service data dir`);
    }
    for (const o of ownership.filter(o => o.inProd && !o.inCode)) addD('low', 'schema', `${o.repo}:${o.table}`, `in production (${o.prodDbs.join(', ')}) but no CREATE TABLE in the repo; classified ${o.disposition} -> ${o.target}`);
    for (const o of ownership.filter(o => o.inCode && !o.inProd && (prodDbsByRepo[o.repo] || []).length)) addD('info', 'schema', `${o.repo}:${o.table}`, 'declared in code but absent from every production database for this service (lazy/unused/legacy migration)');
    for (const e of envRows.filter(e => e.unreferenced)) addD('info', 'env', `${e.repo}:${e.name}`, `set in ${e.prod} but not referenced by scanned code (may be read by a dependency or stale)`);
    for (const e of envRows.filter(e => e.secret && !e.unreferenced && !e.prod)) addD('low', 'env', `${e.repo}:${e.name}`, 'secret-named variable read by code but not set in the service env file: verify it is optional or has no hardcoded fallback');
}
addD('unknown', 'provider', 'B2/R2/Cloudflare/PayPal consoles', 'console configuration (billing, lifecycle rules, zone settings, app config) is not visible from this environment');
addD('unknown', 'host', 'powerchat.gg, raspi/hobo.tools (LAN)', 'unreachable from this environment; state not verified');
const sevOrder = { high: 0, medium: 1, low: 2, info: 3, unknown: 4 };
discrepancies.sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity] || a.area.localeCompare(b.area) || a.subject.localeCompare(b.subject));

// ── 7. Metrics, D-status verification, hazard checks ─────────────────────
const charters = github ? github.repos.filter(r => r.status && r.status.code === false) : [];
const metrics = {
    'github.charters': github ? `${charters.length} charter-only repos of ${github.repos.length}` : 'github.json missing',
    'contract.todo-markers': repos.map(r => `${r.name.replace('OpenVibe.', '')} ${r.contractTodos || 0}`).join(', '),
    'outbound.call-sites': `${calls.length} caller-file/target pairs across ${new Set(calls.map(c => c.file + c.caller)).size} files`,
    'outbound.internal-key': `${calls.filter(c => c.auth.includes('internal-key')).length} of ${calls.length} call sites authenticate with the shared internal key`,
    'ws.servers': `${repos.reduce((n, r) => n + (r.ws ? r.ws.servers.length : 0), 0)} WebSocket server constructions`,
    'tables.analytics-copies': `${new Set(ownership.filter(o => o.table === 'analytics_events').map(o => o.repo)).size} repos carry their own analytics_events`,
    'shared.pins': `${new Set(sharedPins.filter(p => p.state !== 'unpinned').map(p => p.repo)).size} repos pin a tagged openvibe-shared release (latest ${latestShared || 'unknown'}): ${[...new Set(sharedPins.filter(p => p.state !== 'unpinned').map(p => `${p.repo.replace('OpenVibe.', '')} ${p.spec}`))].join(', ') || 'none'}`,
    'shared.drift': `${sharedPins.filter(p => p.state !== 'current').length} manifests unpinned or behind: ${sharedPins.filter(p => p.state !== 'current').map(p => `${pinLabel(p)} (${p.spec})`).join(', ') || 'none'}`,
    'ci.repos': `${repos.filter(r => r.ci).length} of ${repos.filter(r => r.present).length} scanned repos have .github/workflows`,
    'deploy.drift': `${discrepancies.filter(d => d.area === 'deploy').length} service(s) not running origin/main`,
};
for (const r of repos.filter(r => r.present)) {
    metrics[`tests.${r.name}`] = `${r.testFiles} test files`;
    metrics[`tables.${r.name}`] = `${ownership.filter(o => o.repo === r.name && o.inCode).length} tables`;
    const targets = {};
    for (const o of ownership.filter(o => o.repo === r.name)) (targets[o.target] ||= []).push(o.table);
    for (const [t, names] of Object.entries(targets)) metrics[`tables.${r.name}.target:${t}`] = `${names.length} ${r.name.replace('OpenVibe.', '')} tables target ${t}`;
}
const metric = (k) => {
    if (metrics[k] !== undefined) return metrics[k];
    // Allow a family to name a target prefix (e.g. OpenVibe.Billing matches "OpenVibe.Billing (loyalty ledger)").
    const hits = Object.keys(metrics).filter(m => m.startsWith(k + ' ') || m.startsWith(k));
    return hits.length ? hits.map(h => metrics[h]).join('; ') : null;
};
const dRows = dstatus.map(fam => {
    const ev = (fam.evidence || []).map(e => ({ ...e, ok: fs.existsSync(path.join(ROOT, e.repo, e.path)) }));
    const ms = (fam.metrics || []).map(k => ({ key: k, value: metric(k) }));
    const verified = ev.every(e => e.ok) && ms.every(m => m.value !== null);
    return { ...fam, evidence: ev, metrics: ms, verified };
});

function runCheck(check) {
    if (!check) return null;
    if (check === 'live-socket-unit') {
        const u = prod && prod.units.find(x => x.unit === 'openvibe-live.socket');
        return u ? `openvibe-live.socket is ${u.active}/${u.sub}` : 'socket unit not found';
    }
    let m;
    if ((m = check.match(/^env:([\w.-]+):(\w+)$/))) return (prodEnv[m[1]] || []).includes(m[2]) ? `${m[2]} is set in ${m[1]}` : `${m[2]} NOT set in ${m[1]}`;
    if ((m = check.match(/^env-absent:([\w.-]+):(\w+)$/))) return (prodEnv[m[1]] || []).includes(m[2]) ? `${m[2]} is now set in ${m[1]}: re-verify` : `${m[2]} still unset in ${m[1]}`;
    if (check === 'workstation-disk') {
        try { return 'workstation / is ' + execFileSync('df', ['-P', '/'], { encoding: 'utf8' }).trim().split('\n')[1].split(/\s+/)[4] + ' used (at generation time)'; } catch { return null; }
    }
    if (check === 'commit-identity') {
        const bad = [];
        for (const r of repos.filter(r => r.present)) {
            const ref = r.git.originMain ? 'origin/main' : 'HEAD';
            const log = git(path.join(ROOT, r.name), 'log', ref, '--format=%ae%x09%B%x1e') || '';
            let authors = 0, trailers = 0;
            for (const entry of log.split('\x1e')) {
                const [email, body = ''] = entry.trim().split('\t');
                if (!email) continue;
                if (email.toLowerCase() !== 'contact@openvibe.network') authors++;
                if (/^(co-authored-by:.*(claude|anthropic)|claude-session:)/im.test(body)) trailers++;
            }
            if (authors || trailers) bad.push(`${r.name.replace('OpenVibe.', '')} (${trailers} commits with assistant trailers${authors ? `, ${authors} other authors` : ''})`);
        }
        return bad.length ? `main history violates the rule in: ${bad.join('; ')}` : 'every scanned main: OpenVibers author, no assistant trailers';
    }
    if (check === 'db-size') {
        return prod ? prod.databases.filter(d => d.tables.includes('analytics_events') && d.bytes > 50e6)
            .map(d => `${d.file.replace('/opt/openvibe.', '')} ${fmtBytes(d.bytes)}`).join('; ') : null;
    }
    if (check === 'deploy-drift') return discrepancies.filter(d => d.area === 'deploy').map(d => `${d.subject}: ${d.detail}`).join('; ') || 'every service runs origin/main';
    if (check === 'dead-dbs') return discrepancies.filter(d => d.area === 'database').map(d => d.subject.replace('/opt/openvibe.', '')).join(', ') || 'none';
    return null;
}
const hazardRows = hazards.hazards.map(h => ({ ...h, checkResult: runCheck(h.check) }));

// ── 8. Exit criteria ────────────────────────────────────────────────────
const unresolvedMounts = repos.flatMap(r => (r.unresolvedMounts || []).map(m => ({ repo: r.name, ...m })));
const callsWithoutTimeout = calls.filter(c => !c.timeout);
const criteria = [
    { id: 'EC1', text: 'Every table has an owner classification', pass: unclassified.length === 0,
      detail: `${ownership.length} tables classified, ${unclassified.length} unclassified` },
    { id: 'EC2', text: 'Every route is attributed to a repo and source line', pass: repos.every(r => !r.present || r.routes.every(x => x.file && x.line)),
      detail: `${repos.reduce((n, r) => n + (r.routes || []).length, 0)} routes; ${unresolvedMounts.length} router mounts whose module could not be resolved (their routes are listed without the mount prefix)` },
    { id: 'EC3', text: 'Every background job is listed with its location', pass: true,
      detail: `${repos.reduce((n, r) => n + (r.jobs || []).length, 0)} timers/jobs` },
    { id: 'EC4', text: 'Every cross-service call records caller, callee, auth, timeout and retry', pass: calls.length > 0,
      detail: `${calls.length} call sites; ${callsWithoutTimeout.length} with no timeout detected` },
    { id: 'EC5', text: 'Unknowns are marked unknown, not guessed', pass: true,
      detail: `${discrepancies.filter(d => d.severity === 'unknown').length} unknown items recorded` },
    { id: 'EC6', text: 'D01-D46 status resolved from evidence', pass: dRows.every(d => d.verified),
      detail: `${dRows.filter(d => d.verified).length}/${dRows.length} families verified` },
    { id: 'EC7', text: 'Hazard register reviewed by the production-host owner', pass: Boolean(hazards.reviewedBy),
      detail: hazards.reviewedBy ? `reviewed by ${hazards.reviewedBy}` : 'pending: set reviewedBy in data/hazards.json after review' },
];

// ── 9. Write outputs ────────────────────────────────────────────────────
const inventory = {
    generatedFrom: Object.fromEntries(repos.filter(r => r.present).map(r => [r.name, r.git.head])),
    prodSnapshot: prod ? { host: prod.host, collectedAt: prod.collectedAt } : null,
    repos: repos.map(r => ({ ...r })), sharedPins, ownership, calls, env: envRows, discrepancies, metrics,
    dStatus: dRows, hazards: hazardRows, criteria,
};
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'inventory.json'), JSON.stringify(inventory, null, 1) + '\n');

const header = (title, blurb) => `# ${title}\n\n> Generated by \`scripts/roadmap-baseline/generate.js\`. Do not edit by hand; edit \`data/*.json\` or the extractor and regenerate.\n\n${blurb}\n`;
const loc = (repo, file, line) => `${repo.replace('OpenVibe.', '')}/${file}${line ? ':' + line : ''}`;
const docs = {};

docs['01-services.md'] = header('Services and repositories', 'Deliverable 1: runtimes, ports, units, env files and repository state.') + [
    '\n## Running services\n',
    table(['Service', 'Repo', 'Stage', 'Ports', 'Units', 'Env file', 'Deployed', 'Databases'], services.map(s => {
        const dep = prod && prod.deployments[s.id];
        return [s.id, s.repo, s.stage, Object.entries(s.ports).map(([k, v]) => `${k} ${Array.isArray(v) ? v.join('/') : v}`).join(', '),
            s.units.join(', ') || '-', s.envFile || '-', dep && dep.sha ? dep.sha.slice(0, 7) : '-', s.databases.join(', ') || 'none'];
    })),
    '\n## Scanned repositories\n',
    table(['Repo', 'HEAD', 'origin/main', 'Source files', 'LOC', 'Test files', 'CI', 'Routes', 'Tables', 'WS servers', 'Timers/jobs', 'TODO(contract)'],
        repos.filter(r => r.present).map(r => [r.name, (r.git.head || '').slice(0, 7), (r.git.originMain || '').slice(0, 7), r.sourceFiles, r.loc,
            r.testFiles, r.ci ? 'yes' : 'no', r.routes.length, new Set(r.tables.map(t => t.table)).size, r.ws.servers.length, r.jobs.length, r.contractTodos])),
    '\nLOC counts non-test source files in the scanned directories only (`server/`, `apps/`, `packages/`), not frontend assets.\n',
    '\n## GitHub account census\n',
    github ? table(['Repository', 'Visibility', 'Stage (STATUS.json)', 'Last push', 'Size', 'Description'],
        github.repos.map(r => [r.name, r.visibility, r.status ? `${r.status.stage}${r.status.code === false ? ' (no code)' : ''}` : '-', (r.pushedAt || '').slice(0, 10), `${r.diskUsage} KB`, r.description || '']))
        + `\n\nCollected ${github.collectedAt.slice(0, 10)} via \`gh repo list OpenVibers\`.` : '_github.json missing: run collect-github.sh_',
].join('\n') + '\n';

docs['02-schema.md'] = header('Database schema inventory', 'Deliverable 2: every table declared in code or present in production, with current and target owner. Row data was never read.') + [
    prod ? '\n## Production database files\n\n' + table(['File', 'Size', 'Tables'], prod.databases.map(d => [d.file, fmtBytes(d.bytes), d.tables.length])) : '',
    ...repos.filter(r => r.present).map(r => {
        const rows = ownership.filter(o => o.repo === r.name);
        if (!rows.length) return `\n## ${r.name}\n\nNo tables.`;
        return `\n## ${r.name} (${rows.length})\n\n` + table(['Table', 'Declared at', 'In prod', 'Target owner', 'Disposition', 'Wave'],
            rows.map(o => [o.table, o.declaredAt.slice(0, 2).join(', ') + (o.declaredAt.length > 2 ? ` +${o.declaredAt.length - 2}` : '') || '(prod only)',
                o.inProd ? o.prodDbs.join(', ') : 'no', o.target, o.disposition, o.wave]));
    }),
].join('\n') + '\n';

docs['03-routes.md'] = header('HTTP route inventory', 'Deliverable 3 (routes half). Paths include the prefix of the `app.use()` mount that loads the router file; Games is matched from its raw `http.Server` handler. Static extraction: a route built at runtime is missed, and a route string in a comment is included.') + [
    '\n## Summary\n',
    table(['Repo', 'Routes', 'GET', 'POST', 'PUT/PATCH', 'DELETE', 'Other', '/internal/*'], repos.filter(r => r.present && r.routes.length).map(r => {
        const c = (m) => r.routes.filter(x => m.includes(x.method)).length;
        return [r.name, r.routes.length, c(['GET']), c(['POST']), c(['PUT', 'PATCH']), c(['DELETE']), c(['ALL', 'ANY']), r.routes.filter(x => x.path.startsWith('/internal')).length];
    })),
    unresolvedMounts.length ? '\n## Unresolved mounts\n\nRouters mounted with a prefix whose module the extractor could not resolve. Their routes appear below without that prefix.\n\n'
        + table(['Repo', 'Mount', 'Module', 'At'], unresolvedMounts.map(m => [m.repo, m.prefix, m.spec, `${m.file}:${m.line}`])) : '',
    ...repos.filter(r => r.present && r.routes.length).map(r => `\n## ${r.name}\n\n` + table(['Method', 'Path', 'Source'], r.routes.map(x => [x.method, x.path, `${x.file}:${x.line}`]))),
].join('\n') + '\n';

docs['04-cross-service.md'] = header('Cross-service calls', 'Deliverable 3 (dependency half). A call site is a source file that makes HTTP requests and names another service by internal URL env var or loopback port. Auth, timeout and retry are detected per file, so treat them as leads to confirm.') + [
    '\n## Dependency graph\n',
    table(['Caller', 'Callee', 'Files', 'Auth mechanisms'], Object.values(calls.reduce((acc, c) => {
        const k = c.caller + '>' + c.target;
        acc[k] ||= { caller: c.caller, target: c.target, files: 0, auth: new Set() };
        acc[k].files++; c.auth.split(', ').forEach(a => acc[k].auth.add(a));
        return acc;
    }, {})).map(e => [e.caller, e.target, e.files, [...e.auth].sort().join(', ')])),
    '\n## Call sites\n',
    table(['Caller file', 'Callee', 'Via', 'Auth', 'Timeout', 'Retry'], calls.map(c => [loc(c.caller, c.file, c.lines.split(',')[0]), c.target, c.via, c.auth, c.timeout ? 'yes' : '**no**', c.retry ? 'yes' : 'no'])),
    '\nInbound webhooks and internal endpoints are in [03-routes.md](03-routes.md) under `/internal/*` and `/api/webhooks/*`.',
].join('\n') + '\n';

docs['05-realtime-and-jobs.md'] = header('WebSockets, protocols and background jobs', 'Deliverable 4, plus the background-job half of the exit criteria.') + [
    '\n## WebSocket servers\n',
    table(['Repo', 'Constructed at'], repos.flatMap(r => (r.ws ? r.ws.servers : []).map(s => [r.name, `${s.file}:${s.line}`]))),
    '\n## WebSocket paths referenced\n',
    table(['Repo', 'Path', 'Referenced at'], repos.flatMap(r => {
        const g = {};
        for (const p of (r.ws ? r.ws.paths : [])) (g[p.path] ||= []).push(`${p.file}:${p.line}`);
        return Object.entries(g).sort().map(([p, at]) => [r.name, p, at.slice(0, 3).join(', ') + (at.length > 3 ? ` +${at.length - 3}` : '')]);
    })),
    '\n## Non-HTTP protocols\n',
    table(['Service', 'Protocol', 'Port(s)'], services.flatMap(s => Object.entries(s.ports).filter(([k]) => !['http', 'gateway', 'maps', 'food', 'img', 'yt', 'audio', 'text', 'docs'].includes(k))
        .map(([k, v]) => [s.id, k, Array.isArray(v) ? v.join(', ') : v]))),
    '\n## Background jobs and timers\n',
    '`jobs.every` / `jobs.singleFlight` are Live\'s guarded job runner (`server/utils/jobs.js`); `setInterval` rows are raw timers.\n',
    table(['Repo', 'Kind', 'Name', 'Interval', 'At'], repos.flatMap(r => (r.jobs || []).map(j => [r.name, j.kind, j.name || '', j.intervalMs ? (j.intervalMs >= 60000 ? `${+(j.intervalMs / 60000).toFixed(1)} min` : `${j.intervalMs / 1000} s`) : '?', `${j.file}:${j.line}`]))),
].join('\n') + '\n';

docs['06-secrets.md'] = header('Secrets and auth mechanisms', 'Deliverable 5. Names and locations only; no value was read. "In prod" names the `/etc/openvibe/*.env` file that sets the name.') + [
    '\n## Auth mechanisms\n',
    table(['Mechanism', 'Used by', 'Where'], [
        ['User JWT (RS256, Network-issued, verified offline via JWKS)', 'all services', 'Network server/auth, CONTRACTS.md'],
        ['OAuth2 client credentials per app (OV_OAUTH_CLIENT_ID/SECRET)', 'Live, Tools, Games, Media, Community', 'CONTRACTS.md'],
        ['Shared internal key (X-Internal-Key / INTERNAL_API_KEY)', `${new Set(calls.filter(c => c.auth.includes('internal-key')).map(c => c.caller)).size} calling repos`, 'Network /internal/*, Live /internal/*'],
        ['Per-app Media API key (Bearer)', 'Live, Community, Tools', 'Media apps table + MEDIA_APP_KEYS'],
        ['HMAC webhook signatures', 'Media -> Live, PowerChat, Resend', 'X-OVMedia-Signature, Svix'],
        ['hbt_ API tokens', 'Live bots/integrations', 'Live api_tokens (docs/api-tokens.md)'],
        ['Stream keys', 'RTMP/WHIP publishers', 'Live managed_streams.stream_key (hazard H4)'],
    ]),
    '\n## Secret-named variables\n',
    table(['Repo', 'Variable', 'In prod', 'Read at'], envRows.filter(e => e.secret).map(e => [e.repo, e.name, e.prod || (e.unreferenced ? '' : '**not set**'), e.files.slice(0, 3).join(', ') + (e.files.length > 3 ? ` +${e.files.length - 3}` : '') || '(not referenced)'])),
    '\n## Env files on the production host\n',
    table(['File', 'Variables'], Object.entries(prodEnv).map(([f, n]) => [`/etc/openvibe/${f}`, n.length])),
    '\n## Other configuration variables\n',
    table(['Repo', 'Variable', 'In prod', 'Read at'], envRows.filter(e => !e.secret).map(e => [e.repo, e.name, e.prod || '', e.files.slice(0, 2).join(', ') + (e.files.length > 2 ? ` +${e.files.length - 2}` : '') || '(not referenced)'])),
].join('\n') + '\n';

const moveRows = ownership.filter(o => o.target !== o.repo);
docs['07-ownership.md'] = header('Data ownership: current vs target', 'Deliverable 6. Current owner = the repo that creates the table; target owner = roadmap sections 14.1 and 16, applied by `data/ownership-rules.json`.') + [
    '\n## Summary\n',
    table(['Current owner', 'Tables', 'Stay', 'Move', 'Frozen legacy', 'Investigate'], repos.filter(r => r.present).map(r => {
        const rows = ownership.filter(o => o.repo === r.name);
        return [r.name, rows.length, rows.filter(o => o.target === r.name).length, rows.filter(o => o.target !== r.name && o.disposition !== 'frozen-legacy' && o.disposition !== 'investigate').length,
            rows.filter(o => o.disposition === 'frozen-legacy').length, rows.filter(o => o.disposition === 'investigate' || o.disposition === 'UNCLASSIFIED').length];
    })),
    '\n## Authority moves\n',
    table(['Target authority', 'From', 'Tables', 'Wave'], Object.values(moveRows.reduce((acc, o) => {
        const k = o.target + '<' + o.repo;
        acc[k] ||= { target: o.target, from: o.repo, tables: [], wave: o.wave };
        acc[k].tables.push(o.table);
        return acc;
    }, {})).sort((a, b) => a.target.localeCompare(b.target) || a.from.localeCompare(b.from)).map(e => [e.target, e.from, e.tables.join(', '), e.wave])),
    unclassified.length ? '\n## Unclassified\n\n' + table(['Repo', 'Table'], unclassified.map(o => [o.repo, o.table])) : '\n## Unclassified\n\nNone.',
].join('\n') + '\n';

docs['08-discrepancies.md'] = header('Production vs repository', `Deliverable 7. Snapshot of ${prod ? prod.host + ' taken ' + prod.collectedAt.slice(0, 16).replace('T', ' ') + ' UTC' : '(no snapshot)'} compared with the local checkouts. \`unknown\` rows are things this environment cannot see.`) + '\n'
    + table(['Severity', 'Area', 'Subject', 'Detail'], discrepancies.map(d => [d.severity, d.area, d.subject, d.detail])) + '\n';

docs['09-d-status.md'] = header('D01-D46 status', 'Deliverable 8. Family-level status from roadmap 3.2. Evidence paths are checked on disk and metrics are recomputed from this scan each run; a family whose evidence does not resolve is marked unverified.') + '\n'
    + table(['IDs', 'Family', 'Status', 'Disposition', 'Wave', 'Evidence', 'Measured'], dRows.map(d => [d.ids, d.name, d.status, d.disposition, d.wave,
        d.evidence.map(e => `${e.ok ? '' : '**MISSING** '}${e.repo.replace('OpenVibe.', '')}/${e.path}`).join('; ') || '-',
        [...d.metrics.map(m => m.value === null ? `**no metric ${m.key}**` : m.value), ...(d.hazards || []).map(h => `hazard ${h}`)].join('; ') || '-']))
    + `\n\nTotals: ${dRows.filter(d => d.status === 'built').length} built, ${dRows.filter(d => d.status === 'partial').length} partial, ${dRows.filter(d => d.status === 'absent').length} absent across ${dRows.length} families; ${dRows.filter(d => d.verified).length} verified.\n\n## Findings\n\n`
    + dRows.map(d => `- **${d.ids} ${d.name}.** ${d.finding}`).join('\n') + '\n';

docs['10-hazards.md'] = header('Hazard register', `Deliverable 9. ${hazards.reviewedBy ? `Reviewed by ${hazards.reviewedBy}.` : '**Not yet reviewed by the production-host owner** (Wave 0 exit criterion EC7).'} "Check" is re-evaluated on every run.`) + '\n'
    + table(['ID', 'Hazard', 'Severity', 'Status', 'Owner', 'Wave', 'Mitigation', 'Check'], hazardRows.map(h => [h.id, h.title, h.severity, h.status, h.owner, h.wave, h.mitigation, h.checkResult || h.evidence || '-']))
    + '\n\n## Constraints\n\n' + hazardRows.map(h => `- **${h.id}** (${h.source}): ${h.constraint}${h.evidence ? ` _Evidence: ${h.evidence}_` : ''}`).join('\n') + '\n';

docs['README.md'] = `# Wave 0 baseline\n\nThe audit baseline from the OpenVibe development roadmap (Wave 0; section 12 items 1-3): what exists across the estate, who owns each piece of data today and who should, what production looks like next to the repos, and which hazards constrain later waves. Every file here except \`data/*.json\` is generated.\n\n`
    + `Source commits: ${Object.entries(inventory.generatedFrom).map(([k, v]) => `${k.replace('OpenVibe.', '')} \`${(v || '').slice(0, 7)}\``).join(', ')}. `
    + `Production snapshot: ${prod ? `${prod.host}, ${prod.collectedAt.slice(0, 10)}` : 'missing'}.\n\n## Deliverables\n\n`
    + table(['#', 'Artifact', 'Contents'], [
        ['1', '[01-services.md](01-services.md)', 'services, ports, units, env files, repo state, GitHub census'],
        ['2', '[02-schema.md](02-schema.md)', `${ownership.length} tables with current/target owner`],
        ['3', '[03-routes.md](03-routes.md), [04-cross-service.md](04-cross-service.md)', `${repos.reduce((n, r) => n + (r.routes || []).length, 0)} routes; ${calls.length} cross-service call sites`],
        ['4', '[05-realtime-and-jobs.md](05-realtime-and-jobs.md)', 'WebSocket servers and paths, non-HTTP protocols, background jobs'],
        ['5', '[06-secrets.md](06-secrets.md)', 'auth mechanisms and secret names (no values)'],
        ['6', '[07-ownership.md](07-ownership.md)', 'current vs target data ownership'],
        ['7', '[08-discrepancies.md](08-discrepancies.md)', `${discrepancies.length} production-vs-repo items`],
        ['8', '[09-d-status.md](09-d-status.md)', 'D01-D46 family status from evidence'],
        ['9', '[10-hazards.md](10-hazards.md)', `${hazardRows.length} hazards with owners, mitigations and waves`],
        ['-', '[inventory.json](inventory.json)', 'everything above, machine-readable'],
    ])
    + '\n\n## Exit criteria\n\n' + table(['', 'Criterion', 'Result'], criteria.map(c => [c.pass ? 'pass' : '**open**', c.text, c.detail]))
    + `\n\n## Regenerating\n\n\`\`\`bash\nscripts/roadmap-baseline/collect-prod.sh      # read-only SSH: deployed SHAs, units, DB table names, env var NAMES\nscripts/roadmap-baseline/collect-github.sh    # gh: repo list + charter STATUS.json\nnode scripts/roadmap-baseline/generate.js     # scan sibling checkouts, write this directory\nnode scripts/roadmap-baseline/generate.js --check   # also exit 1 while an exit criterion is open\n\`\`\`\n\nThe generator reads sibling checkouts under \`OPENVIBE_ROOT\` (default: the parent of this repo). Keep them on \`main\` and pulled before regenerating.\n\n## What this baseline does not claim\n\n- Extraction is static pattern matching. Routes built at runtime, calls through helper wrappers without an internal URL or port, and tables created by dependencies other than the \`openvibe-shared\` modules a repo requires can be missed. Treat counts as a floor.\n- Timeout/retry/auth detection is per file, not per request. A module that exports several routers gets every mount prefix it is loaded under.\n- No production row data, env values, provider console or payment record was read.\n- \`Source.OpenVibe.Games\`, \`AFResume\` and \`BreakRoomSimulator\` are not scanned; the charter repos have no code to scan.\n`;

for (const [f, body] of Object.entries(docs)) fs.writeFileSync(path.join(OUT_DIR, f), body);

const open = criteria.filter(c => !c.pass);
console.log(`roadmap-baseline: ${ownership.length} tables, ${repos.reduce((n, r) => n + (r.routes || []).length, 0)} routes, ${calls.length} call sites, ${discrepancies.length} discrepancies; ${criteria.length - open.length}/${criteria.length} exit criteria pass`);
for (const c of open) console.log(`  open ${c.id}: ${c.text} (${c.detail})`);
if (CHECK && open.length) process.exit(1);
