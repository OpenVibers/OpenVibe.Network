'use strict';
// What the browser check (OpenVibe.Host scripts/browser-check.js, WS-Q task 3) found on Network's pages stays
// fixed: /login has a canonical URL, a no-JS note, named password toggles and AA contrast; the /updates site
// filter's current chip reads at AA; the home page's JSON-LD site list is named by its visible heading.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const lum = (hex) => {
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.replace('#', '').slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

const login = fs.readFileSync(path.join(__dirname, '..', 'public', 'login.html'), 'utf8');
assert.deepStrictEqual(login.match(/<link rel="canonical"[^>]*>/g), ['<link rel="canonical" href="https://openvibe.network/login">']);
assert.match(login, /<noscript><p class="panel-note">Signing in and creating an account need JavaScript/);
const toggles = login.match(/<button[^>]*class="toggle-password"[^>]*>/g);
assert.ok(toggles.length >= 3 && toggles.every((b) => /aria-label="Show password"/.test(b)), 'every password toggle has a name');
assert.match(login, /btn\.setAttribute\('aria-label', input\.type === 'password' \? 'Show password' : 'Hide password'\)/);
const token = (name) => login.match(new RegExp(`--${name}:(#[0-9a-f]{6})`, 'i'))[1];
for (const bg of ['bg', 'bg-card', 'bg-input']) assert.ok(ratio(token('text-muted'), token(bg)) >= 4.5, `muted text on --${bg} reads at 4.5:1`);
assert.match(login, /\.tab-bar button\.active\{background:var\(--accent-dark\);color:#fff;/);
assert.ok(ratio(token('accent-dark'), '#ffffff') >= 4.5, 'the active tab reads at 4.5:1');

const updates = fs.readFileSync(path.join(__dirname, '..', 'server', 'updates', 'routes.js'), 'utf8');
assert.match(updates, /\.up-sites a\[aria-current\]\{background:var\(--accent-strong,#1d4ed8\);border-color:var\(--accent-strong,#1d4ed8\);color:var\(--on-accent-strong,#fff\)\}/);

const home = require('../server/home/render').render().html;
const heading = home.match(/<h2 id="h-sites">([^<]*)<\/h2>/)[1];
assert.ok(home.includes(`"@type":"ItemList","name":${JSON.stringify(heading)}`), `the ItemList is named "${heading}"`);
console.log('page checks: login, updates filter and home JSON-LD ok');
process.exit(0);
