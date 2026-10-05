'use strict';
// The consent screen on /login (public/js/login.js renderConsent, plan T2 §9): a third-party app's requested
// capabilities from GET /oauth/client-info, sensitive ones marked, refused ids named, nothing parsed as HTML, and
// a first-party app shows no box. Runs the function itself against a minimal DOM.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'login.html'), 'utf8');
const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'login.js'), 'utf8');

assert.match(html, /<section class="oauth-consent" id="oauth-consent" aria-label="What this app asks for" hidden><\/section>/, 'the box is on the page, hidden until the app is known');
assert.ok(html.indexOf('id="oauth-consent"') < html.indexOf('id="auth-tabs"'), 'above every way of signing in');
assert.match(js, /scope: params\.get\('scope'\) \|\| ''/, 'client-info is asked about the requested scope');

// Pull renderConsent out of login.js and run it.
const start = js.indexOf('function renderConsent(info) {');
assert.ok(start > 0, 'renderConsent exists');
let depth = 0, end = start;
for (let i = js.indexOf('{', start); i < js.length; i++) {
    if (js[i] === '{') depth++;
    else if (js[i] === '}' && --depth === 0) { end = i + 1; break; }
}
const source = js.slice(start, end);
assert.ok(!/innerHTML/.test(source), 'built from DOM nodes only');

class Node {
    constructor(tag) { this.tagName = tag; this.children = []; this.className = ''; this.hidden = true; this._text = ''; }
    set textContent(v) { this._text = String(v); this.children = []; }
    get textContent() { return this._text + this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join(''); }
    append(...kids) { this.children.push(...kids); }
    replaceChildren() { this.children = []; this._text = ''; }
    findAll(pred, out = []) { for (const c of this.children) if (typeof c !== 'string') { if (pred(c)) out.push(c); c.findAll(pred, out); } return out; }
}
function run(info) {
    const box = new Node('section');
    const document = { getElementById: (id) => (id === 'oauth-consent' ? box : null), createElement: (t) => new Node(t) };
    vm.runInNewContext(`${source}; renderConsent(info);`, { document, info });
    return box;
}

{
    const box = run({ name: 'Clip<b>Tool</b>', third_party: true, redirect_host: 'cliptool.example', capabilities: [
        { id: 'media.object.read', name: 'Read your media', description: 'See the videos and files in your library.', sensitive: false },
        { id: 'media.object.delete', name: 'Delete your media', description: 'Remove videos and files for good.', sensitive: true },
    ], refused: ['network.admin'] });
    assert.strictEqual(box.hidden, false, 'shown for a third-party app');
    const text = box.textContent;
    assert.ok(text.includes('Clip<b>Tool</b>') && text.includes('(cliptool.example)'), 'the app name is text, never markup');
    assert.ok(text.includes('If you continue, it can:'));
    const items = box.findAll((n) => n.tagName === 'li');
    assert.strictEqual(items.length, 2);
    assert.strictEqual(items[1].className, 'sensitive', 'the sensitive capability is marked');
    assert.ok(items[1].textContent.includes('Sensitive') && !items[0].textContent.includes('Sensitive'));
    assert.ok(text.includes('it will not get: ') && box.findAll((n) => n.tagName === 'code')[0].textContent === 'network.admin', 'refused ids are named');
}
{
    const box = run({ name: 'Quiet', third_party: true, capabilities: [], refused: [] });
    assert.strictEqual(box.hidden, false);
    assert.ok(box.textContent.includes('it will only learn which OpenVibe account you are'), 'nothing asked, nothing given');
    assert.strictEqual(box.findAll((n) => n.tagName === 'li').length, 0);
}
{
    const box = run({ name: 'OpenVibe.Live', third_party: false, capabilities: [] });
    assert.strictEqual(box.hidden, true, 'a first-party site shows no consent box');
}
console.log('consent ui: all checks passed');
