'use strict';
// node.openvibe.network, served by Network (the owner, 2026-11-06: the Node gets its own subdomain, "because it
// looks nicer"). The Host header decides: on this host '/' is the Node's page, '/install' answers with the
// installer of the latest release, and the page has its Markdown twin and its llms.txt, like Network's other pages.
//
// The route is mounted before the agent layer, so the Node's page is not answered by Network's home renderer.

const { markdownTwin, linkHeaderTags } = require('openvibe-shared/agent-layer');
const page = require('./page');
const release = require('./release');

const HOST = page.HOST;
const SITE = page.SITE;

/** The request's host, lowercased, without the port. */
function hostOf(req) {
    return String((req.headers && req.headers.host) || '').split(':')[0].toLowerCase();
}

/** The Node's llms.txt: what the page is, how to install it, and where the docs are. */
function llmsTxt() {
    return [
        '# OpenVibe Node',
        '',
        '> OpenVibe Node is one program (openvibe-node) that runs on your computer, server, phone or robot. It connects out to OpenVibe, needs no open ports, keeps a local kill switch, and does nothing you did not turn on.',
        '',
        '## The page',
        '',
        `- [OpenVibe Node: your computer on the network](${SITE}/): what it is, what it does today (run your agents and code, offer your models or GPU and earn credits, drive robots, stream an agent's desk, keep your memory read-only), how to install it on each OS, and what it never does`,
        '',
        '## Install',
        '',
        `- [Install the Node](${SITE}/install): the latest release's installer, as a script to run`,
        '',
        '```sh',
        page.INSTALL_LINE,
        '```',
        '',
        '## The docs',
        '',
        `- [Install](${page.DOCS}/install.md): every OS, every option, and what the installer does`,
        `- [Your computer for your agents](${page.DOCS}/computer.md): the computer plugin, its levels and the live screen`,
        `- [A machine that runs your jobs](${page.DOCS}/worker.md): the sandbox the job runner uses`,
        `- [The protocol](${page.DOCS}/protocol.md): the wire format between the Node and OpenVibe.Bot`,
        `- [Your memory](${page.DOCS}/memory.md): what the collectors read and how it is uploaded`,
        '- [The source on GitHub](https://github.com/OpenVibers/OpenVibe.Node)',
        '',
    ].join('\n');
}

/**
 * The Node's routes. Returns null for a request that is not for this host, so the router can be mounted early
 * and every other host falls through to Network's own pages.
 */
function createNodeRoutes({ releaseId } = {}) {
    const router = require('express').Router();

    router.use(async (req, res, next) => {
        if (hostOf(req) !== HOST) return next();
        const url = new URL(req.url, SITE);
        const path = url.pathname;
        const isTwin = path === '/index.md' || path.endsWith('.md') || url.searchParams.get('format') === 'markdown'
            || (req.headers.accept && req.accepts(['html', 'text/markdown']) === 'text/markdown');

        // The installer: the latest release's own asset, so `curl -fsSL https://node.openvibe.network/install | sh`
        // installs that release. The same cached answer the page shows.
        if (path === '/install') {
            let rel;
            try { rel = await release.latest(); } catch { rel = release.FALLBACK; }
            const target = rel && rel.installUrl ? rel.installUrl : release.FALLBACK.installUrl;
            return res.set('Cache-Control', 'public, max-age=600').redirect(302, target);
        }

        if (path === '/llms.txt') {
            return res.type('text/plain').set('Cache-Control', 'public, max-age=3600').send(llmsTxt());
        }

        // The crawl files of this host, so a crawler on node.openvibe.network is told about this page and not
        // about Network's (the apex serves its own).
        if (path === '/robots.txt') {
            const robots = require('openvibe-shared/seo').robotsTxt({ sitemaps: [`${SITE}/sitemap.xml`] });
            return res.type('text/plain').set('Cache-Control', 'public, max-age=3600').send(robots);
        }
        if (path === '/sitemap.xml') {
            const xml = require('openvibe-shared/seo').sitemapXml([{ loc: `${SITE}/`, changefreq: 'weekly', priority: 1.0 }]);
            return res.type('application/xml').set('Cache-Control', 'public, max-age=3600').send(xml);
        }

        if (path !== '/' && path !== '/index.md' && path !== '/index.html') return next();

        let rel;
        try { rel = await release.latest(); } catch { rel = release.FALLBACK; }
        const html = page.render({ release: rel, releaseId });
        const canonical = `${SITE}/`;
        const links = linkHeaderTags(canonical, `${SITE}/llms.txt`);
        res.setHeader('Link', [res.getHeader('Link'), links.header].filter(Boolean).join(', '));
        res.setHeader('Vary', [res.getHeader('Vary'), 'Accept'].filter(Boolean).join(', '));
        res.setHeader('Cache-Control', 'public, max-age=600');
        if (isTwin) {
            res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
            return res.end(req.method === 'HEAD' ? undefined : markdownTwin({ html, title: 'OpenVibe Node: your computer on the network', canonical }));
        }
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.end(req.method === 'HEAD' ? undefined : html);
    });

    return router;
}

module.exports = { createNodeRoutes, llmsTxt, hostOf, HOST, SITE };
