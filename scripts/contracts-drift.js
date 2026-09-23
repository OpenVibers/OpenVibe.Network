#!/usr/bin/env node
'use strict';
/**
 * Version drift: which OpenVibe services pin an older openvibe-contracts (or openvibe-sdk /
 * openvibe-shared) than the latest release tag. It WARNS; it never fails a build (exit 0), unless
 * --strict is given. A pin to a tag that was never published is also reported.
 *
 *   node scripts/contracts-drift.js                         each manifest repository's package.json on GitHub
 *   node scripts/contracts-drift.js --dir ~/OpenVibers      local checkouts (<dir>/<Repo>/package.json)
 *   node scripts/contracts-drift.js --registry https://openvibe.network
 *                                                           what the running services report (/api/v1/registry/releases)
 *   options: --package openvibe-sdk (default openvibe-contracts; "all" = contracts, sdk and shared)
 *            --latest v0.30.1 (skip the tag lookup)   --json   --strict
 *
 * Repositories come from the installed openvibe-contracts service manifests (`repository`). The
 * latest release is the highest vX.Y.Z tag of the package's repository. GITHUB_TOKEN is used when
 * set (CI). Under GitHub Actions each finding is also printed as a ::warning:: annotation.
 */
const fs = require('fs');
const path = require('path');
const { parsePin, latestOf, driftOf } = require('../server/registry/versions');

const PACKAGES = {
    'openvibe-contracts': 'OpenVibers/OpenVibe.Contracts',
    'openvibe-sdk': 'OpenVibers/OpenVibe.SDK',
    'openvibe-shared': 'OpenVibers/OpenVibe.Shared',
};

function ghHeaders(env = process.env) {
    const h = { 'User-Agent': 'openvibe-network-drift', Accept: 'application/vnd.github+json' };
    if (env.GITHUB_TOKEN) h.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
    return h;
}

async function fetchTags(repo, { fetchImpl = fetch, env = process.env } = {}) {
    const tags = [];
    for (let page = 1; page <= 5; page++) {
        const r = await fetchImpl(`https://api.github.com/repos/${repo}/tags?per_page=100&page=${page}`, { headers: ghHeaders(env), signal: AbortSignal.timeout(15000) });
        if (!r.ok) throw new Error(`GitHub tags for ${repo} answered ${r.status}`);
        const body = await r.json();
        tags.push(...body.map(t => t.name));
        if (body.length < 100) break;
    }
    return tags;
}

/** The repositories to check: every service manifest with a repository, minus the libraries themselves. */
function repositories(manifests = require('openvibe-contracts').services.manifests) {
    const libs = new Set(Object.values(PACKAGES));
    const out = [];
    for (const m of manifests) {
        if (!m.repository || libs.has(m.repository)) continue;
        if (!out.some(r => r.repo === m.repository)) out.push({ service: m.id, repo: m.repository });
    }
    return out;
}

/** The dependency spec of `pkg` in a package.json object (dependencies, then devDependencies). */
function specIn(pkgJson, pkg) {
    if (!pkgJson || typeof pkgJson !== 'object') return null;
    return (pkgJson.dependencies && pkgJson.dependencies[pkg]) || (pkgJson.devDependencies && pkgJson.devDependencies[pkg]) || null;
}

async function pinsFromGithub(pkgs, { fetchImpl = fetch, env = process.env, manifests } = {}) {
    const rows = [];
    for (const { service, repo } of repositories(manifests)) {
        let json = null; let error = null;
        try {
            const r = await fetchImpl(`https://raw.githubusercontent.com/${repo}/HEAD/package.json`, { headers: { 'User-Agent': 'openvibe-network-drift' }, signal: AbortSignal.timeout(15000) });
            if (r.status === 404) error = 'no package.json at the repository root';
            else if (!r.ok) error = `package.json answered ${r.status}`;
            else json = await r.json();
        } catch (err) { error = err.message; }
        for (const p of pkgs) rows.push({ service, repo, package: p, spec: specIn(json, p), error });
    }
    return rows;
}

function pinsFromDir(dir, pkgs, { manifests } = {}) {
    const rows = [];
    for (const { service, repo } of repositories(manifests)) {
        const file = path.join(dir, repo.split('/')[1], 'package.json');
        let json = null; let error = null;
        try { json = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { error = err.code === 'ENOENT' ? 'no local checkout' : err.message; }
        for (const p of pkgs) rows.push({ service, repo, package: p, spec: specIn(json, p), error });
    }
    return rows;
}

async function pinsFromRegistry(base, pkgs, { fetchImpl = fetch } = {}) {
    const r = await fetchImpl(`${String(base).replace(/\/+$/, '')}/api/v1/registry/releases`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`registry answered ${r.status}`);
    const body = await r.json();
    const rows = [];
    for (const s of body.services || []) {
        for (const p of pkgs) {
            const installed = p === 'openvibe-contracts' ? s.contracts_version : (s.packages || {})[p];
            rows.push({ service: s.id, repo: null, package: p, spec: installed || null, error: s.release ? null : (s.error || 'no release.json') });
        }
    }
    return rows;
}

/**
 * Findings for each pin against the published tags. tagsByPackage[pkg] is the full tag list, or
 * { tags, complete: false } when only the latest is known (--latest): then no pin is called unpublished.
 */
function assess(rows, tagsByPackage) {
    return rows.map((row) => {
        const t = tagsByPackage[row.package];
        const tags = Array.isArray(t) ? t : (t && t.tags) || [];
        const complete = Array.isArray(t) ? tags.length > 0 : !!(t && t.complete && t.tags.length);
        const latest = latestOf(tags);
        if (row.error && !row.spec) return { ...row, latest: latest && latest.tag, state: 'unknown' };
        if (!row.spec) return { ...row, latest: latest && latest.tag, state: 'not-pinned' };
        const pin = parsePin(row.spec);
        if (!pin) return { ...row, latest: latest && latest.tag, state: 'unparsed' };
        const published = !complete || tags.some(x => (parsePin(x) || {}).version === pin.version);
        return { ...row, pinned: pin.tag, latest: latest && latest.tag, state: published ? driftOf(pin.parts, latest ? latest.parts : null) : 'unpublished' };
    });
}

function report(findings, { json = false, actions = !!process.env.GITHUB_ACTIONS, out = console } = {}) {
    if (json) { out.log(JSON.stringify({ findings }, null, 2)); return; }
    const warn = findings.filter(f => f.state === 'behind' || f.state === 'unpublished');
    for (const f of findings) {
        const where = f.repo ? `${f.service} (${f.repo})` : f.service;
        const what = f.state === 'behind' ? `pins ${f.pinned}, latest is ${f.latest}`
            : f.state === 'unpublished' ? `pins ${f.pinned}, which is not a published tag (latest ${f.latest})`
            : f.state === 'current' ? `pins ${f.pinned} (latest)`
            : f.state === 'ahead' ? `pins ${f.pinned}, newer than the latest tag ${f.latest}`
            : f.state === 'not-pinned' ? 'does not depend on it at the root'
            : `${f.state}${f.error ? ': ' + f.error : ''}`;
        out.log(`${f.state === 'behind' || f.state === 'unpublished' ? 'WARN' : '    '} ${f.package} ${where}: ${what}`);
        if (actions && (f.state === 'behind' || f.state === 'unpublished')) out.log(`::warning title=${f.package} drift::${where} ${what}`);
    }
    out.log(`${warn.length} warning(s) across ${new Set(findings.map(f => f.service)).size} service(s).`);
}

async function main(argv = process.argv.slice(2), { fetchImpl = fetch, env = process.env, out = console } = {}) {
    const opt = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };
    const pkgOpt = opt('package') || 'openvibe-contracts';
    const pkgs = pkgOpt === 'all' ? Object.keys(PACKAGES) : [pkgOpt];
    for (const p of pkgs) if (!PACKAGES[p]) throw new Error(`unknown package ${p}`);
    const tagsByPackage = {};
    for (const p of pkgs) {
        if (opt('latest') && pkgs.length === 1) { tagsByPackage[p] = { tags: [opt('latest')], complete: false }; continue; }
        try { tagsByPackage[p] = await fetchTags(PACKAGES[p], { fetchImpl, env }); } catch (err) { out.log(`WARN could not list ${PACKAGES[p]} tags: ${err.message}`); tagsByPackage[p] = []; }
    }
    const rows = opt('registry') ? await pinsFromRegistry(opt('registry'), pkgs, { fetchImpl })
        : opt('dir') ? pinsFromDir(opt('dir'), pkgs)
        : await pinsFromGithub(pkgs, { fetchImpl, env });
    const findings = assess(rows, tagsByPackage);
    report(findings, { json: argv.includes('--json'), actions: !!env.GITHUB_ACTIONS, out });
    const warned = findings.some(f => f.state === 'behind' || f.state === 'unpublished');
    return argv.includes('--strict') && warned ? 1 : 0;
}

if (require.main === module) {
    main().then((code) => process.exit(code)).catch((err) => {
        // A drift check that cannot run is itself only a warning.
        console.log(`::warning title=contracts drift::drift check could not run: ${err.message}`);
        process.exit(process.argv.includes('--strict') ? 1 : 0);
    });
}

module.exports = { main, assess, repositories, specIn, pinsFromDir, pinsFromGithub, pinsFromRegistry, fetchTags, PACKAGES };
