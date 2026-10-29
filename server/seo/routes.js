'use strict';
// Crawl files for the public front door, mounted before express.static.
const cache = require('openvibe-shared/cache-policy');
const express = require('express');
const fs = require('fs');
const path = require('path');
const seo = require('openvibe-shared/seo');

const HOST = 'https://openvibe.network';
// This is read once at boot if there is no release manifest.
const FALLBACK_LASTMOD = fs.statSync(path.join(__dirname, '../home/render.js')).mtime.toISOString();

// Public HTML routes; sign-in, account and admin pages are omitted, and so is /status: a live page that changes every
// poll and says noindex, nofollow (status/routes.js), so listing it only spent crawl on a page engines skip.
const PAGES = [
    { path: '/', changefreq: 'daily', priority: 1.0 },
    { path: '/updates', changefreq: 'daily', priority: 0.8 },
    { path: '/stats', changefreq: 'daily', priority: 0.7 },
    { path: '/bot', changefreq: 'monthly', priority: 0.4 },
    { path: '/terms', changefreq: 'yearly', priority: 0.3 },
    { path: '/privacy', changefreq: 'yearly', priority: 0.3 },
    { path: '/dmca', changefreq: 'yearly', priority: 0.2 },
];

function robotsTxt() {
    return seo.robotsTxt({ sitemaps: [`${HOST}/sitemap.xml`] }) + `# Agent manifest: ${HOST}/.well-known/agent.json\n`;
}

function sitemapXml({ release = null } = {}) {
    const lastmod = release?.full()?.released_at || FALLBACK_LASTMOD;
    const day = String(lastmod).slice(0, 10);
    return seo.sitemapXml(PAGES.map((page) => ({ loc: `${HOST}${page.path}`, lastmod: day, changefreq: page.changefreq, priority: page.priority })));
}

// RFC 9116. Contact, Expires and Canonical are required. Policy is listed only while
// https://openvibe.network/security answers 200 (checked 2026-10-29); it is this site's own policy page.
// Expires is the date the file must be refreshed by: one year on, a person re-reads and re-commits it.
const SECURITY_EXPIRES = '2027-10-29T00:00:00.000Z';
const SECURITY_CONTACT = 'mailto:security@openvibe.network';
const SECURITY_POLICY = 'https://openvibe.network/security';

function securityTxt(baseUrl = HOST) {
    const origin = String(baseUrl).replace(/\/+$/, '');
    return [
        `Contact: ${SECURITY_CONTACT}`,
        `Expires: ${SECURITY_EXPIRES}`,
        'Preferred-Languages: en',
        `Canonical: ${origin}/.well-known/security.txt`,
        `Policy: ${SECURITY_POLICY}`,
        '',
    ].join('\n');
}

function createSeoRoutes({ release = null, baseUrl = HOST } = {}) {
    const r = express.Router();
    const robots = robotsTxt();
    const sitemap = sitemapXml({ release });
    const security = securityTxt(baseUrl);
    r.get('/robots.txt', (_req, res) => {
        res.set('Content-Type', 'text/plain; charset=utf-8').set('Cache-Control', cache.htmlHeaders({ maxAge: 3600 })).send(robots);
    });
    r.get('/sitemap.xml', (_req, res) => {
        res.set('Content-Type', 'application/xml; charset=utf-8').set('Cache-Control', cache.htmlHeaders({ maxAge: 3600 })).send(sitemap);
    });
    r.get('/.well-known/security.txt', (_req, res) => {
        res.set('Content-Type', 'text/plain; charset=utf-8').set('Cache-Control', 'public, max-age=86400').send(security);
    });
    return r;
}

module.exports = { createSeoRoutes, robotsTxt, sitemapXml, securityTxt, PAGES, HOST, SECURITY_EXPIRES };
