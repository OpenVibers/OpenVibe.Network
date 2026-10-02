'use strict';
// Crawl files for the public front door, mounted before express.static.
const express = require('express');
const fs = require('fs');
const path = require('path');
const seo = require('openvibe-shared/seo');

const HOST = 'https://openvibe.network';
// This is read once at boot if there is no release manifest.
const FALLBACK_LASTMOD = fs.statSync(path.join(__dirname, '../home/render.js')).mtime.toISOString();

// Public HTML routes; sign-in, account and admin pages are omitted.
const PAGES = [
    { path: '/', changefreq: 'daily', priority: 1.0 },
    { path: '/status', changefreq: 'daily', priority: 0.8 },
    { path: '/updates', changefreq: 'daily', priority: 0.8 },
    { path: '/terms', changefreq: 'yearly', priority: 0.3 },
    { path: '/privacy', changefreq: 'yearly', priority: 0.3 },
    { path: '/dmca', changefreq: 'yearly', priority: 0.2 },
];

function robotsTxt() {
    return seo.robotsTxt({ sitemaps: [`${HOST}/sitemap.xml`] });
}

function sitemapXml({ release = null } = {}) {
    const lastmod = release?.full()?.released_at || FALLBACK_LASTMOD;
    const day = String(lastmod).slice(0, 10);
    return seo.sitemapXml(PAGES.map((page) => ({ loc: `${HOST}${page.path}`, lastmod: day, changefreq: page.changefreq, priority: page.priority })));
}

function createSeoRoutes({ release = null } = {}) {
    const r = express.Router();
    const robots = robotsTxt();
    const sitemap = sitemapXml({ release });
    r.get('/robots.txt', (_req, res) => {
        res.set('Content-Type', 'text/plain; charset=utf-8').set('Cache-Control', 'public, max-age=3600').send(robots);
    });
    r.get('/sitemap.xml', (_req, res) => {
        res.set('Content-Type', 'application/xml; charset=utf-8').set('Cache-Control', 'public, max-age=3600').send(sitemap);
    });
    return r;
}

module.exports = { createSeoRoutes, robotsTxt, sitemapXml, PAGES, HOST };
