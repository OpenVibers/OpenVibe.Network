'use strict';
// The home's "What do you want to do?" box (public/index.html's last script), run against the real intents
// (server/home/render.js INTENTS) in a small stand-in DOM: an app named clearly opens it, even in a question; a tool
// query stays a tool search; a question, a request in a sentence or a tie opens Vibe with the text filled in (plan
// track K); filler words ("find me a…") never pick an app.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { INTENTS } = require('../server/home/render');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const script = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));

function route(text) {
    const intentEls = INTENTS.map(([id, , , , href, k]) => ({ href, classList: { toggle() {} }, getAttribute: (a) => ({ 'data-id': id, 'data-k': k })[a] }));
    let onSubmit = null;
    const input = { value: text, addEventListener() {} };
    const form = { addEventListener: (ev, fn) => { if (ev === 'submit') onSubmit = fn; } };
    const location = { href: null };
    const document = { querySelector: (s) => (s === '.intent-bar' ? form : null), getElementById: (id) => (id === 'intent-q' ? input : null), querySelectorAll: () => intentEls };
    vm.runInNewContext(script, { document, location, encodeURIComponent });
    let prevented = false;
    onSubmit({ preventDefault() { prevented = true; } });
    return prevented ? location.href : 'tool search';
}
const vibe = (q) => `https://openvibe.chat/vibe?ask=${encodeURIComponent(q)}&from=${encodeURIComponent('https://openvibe.network/')}`;

const cases = [
    ['go live', 'https://openvibe.live/broadcast'],
    ['how do I go live?', 'https://openvibe.live/broadcast'],
    ['convert mp4 to mp3', 'tool search'],
    ['merge pdf', 'tool search'],
    ['find me a cheap apartment in austin', 'https://openvibe.rent/'],
    ['get help with my account', 'https://openvibe.help/'],
    ['what is the weather in paris?', vibe('what is the weather in paris?')],
    ['help me plan a birthday party for ten kids', vibe('help me plan a birthday party for ten kids')],
    ['ask vibe', vibe('ask vibe')],
    ['sourdough starter', vibe('sourdough starter')],
    ['use my ollama models', 'https://openvibe.bot/machines'],
    ['my old laptop as a desk host', 'https://openvibe.bot/machines'],
];
cases.forEach(([q, want]) => assert.strictEqual(route(q), want, `"${q}"`));
assert.strictEqual(route('   '), 'tool search', 'an empty box does nothing new');
console.log(`home intent routing: ${cases.length} queries routed`);
