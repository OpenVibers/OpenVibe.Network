'use strict';
// The admin's "Flagged speech" tab (plan §AD.11 item 3): Live's queue of transcript windows the hard floor flagged,
// read through /api/admin/streamer-mod. Each card names the channel and the line, links the recording at its moment,
// never shows words, and marks it nothing wrong, handled, or back to open.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const html = read('public/admin.html');
assert.ok(html.includes(`onclick="showTab('flagged-speech',this)"`), 'a tab beside Bans');
assert.ok(html.includes('id="sec-flagged-speech"') && html.includes('id="flagged-speech-content"') && html.includes('id="flagged-speech-filter"'));
assert.ok(/'flagged-speech': \(\) => loadFlaggedSpeech\(\)/.test(read('public/js/admin/boot.js')), 'the tab has its loader');

const els = { 'flagged-speech-content': { innerHTML: '' }, 'flagged-speech-filter': { innerHTML: '' } };
const calls = [];
const toasts = [];
let answer = null;
const ctx = {
    document: { getElementById: (id) => els[id] || null },
    window: {},
    console,
    encodeURIComponent,
    esc: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    timeAgo: () => '2h ago',
    toast: (m, k) => toasts.push([m, k]),
    api: async (p, opts) => { calls.push([p, opts || null]); if (typeof answer === 'function') return answer(p, opts); return answer; },
};
vm.createContext(ctx);
vm.runInContext(read('public/js/admin/moderation.js'), ctx);

(async () => {
    answer = {
        open: 2,
        flags: [
            { id: 7, kind: 'vod', item_id: '801', start_sec: 3725, rule: 'minors', status: 'open', created_at: '2026-11-15 14:00:00', channel: { id: 72, username: 'sam<x>' }, url: '/vod/801?t=3725' },
            { id: 6, kind: 'media', item_id: null, start_sec: 0, rule: 'mass_harm', status: 'open', created_at: '2026-11-15 13:00:00', channel: null, url: null, path: '/x/7/a.mp4' },
        ],
    };
    await ctx.loadFlaggedSpeech();
    assert.deepStrictEqual(calls[0], ['/api/admin/streamer-mod/transcript-flags?status=open&limit=100', null], 'the open queue through the moderator proxy');
    const out = els['flagged-speech-content'].innerHTML;
    assert.ok(out.includes('href="https://openvibe.live/vod/801?t=3725"'), 'the recording, opened at its moment');
    assert.ok(out.includes('Recording at 1:02:05'), 'the moment in words');
    assert.ok(out.includes('@sam&lt;x&gt;') && !out.includes('sam<x>'), 'names are escaped');
    assert.ok(out.includes('Minor, sexual') && out.includes('Mass harm'), 'the line in plain words');
    assert.ok(out.includes('<code>/x/7/a.mp4</code>'), 'a recording nobody named shows its path');
    assert.ok(out.includes("markFlaggedSpeech(7,'cleared')") && out.includes("markFlaggedSpeech(7,'handled')"), 'both decisions on an open flag');
    assert.ok(els['flagged-speech-filter'].innerHTML.includes('Open (2)'), 'the open count on its filter');

    answer = { flag: { id: 7, status: 'handled' } };
    await ctx.markFlaggedSpeech(7, 'handled');
    // (JSON: the page's objects come from the vm's realm)
    assert.strictEqual(JSON.stringify(calls.find((c) => c[1] && c[1].method === 'POST')), JSON.stringify(['/api/admin/streamer-mod/transcript-flags/7', { method: 'POST', body: { status: 'handled' } }]));
    assert.deepStrictEqual(toasts[0], ['Marked handled', 'success']);

    answer = { open: 0, flags: [{ id: 5, kind: 'clip', item_id: '9', start_sec: 12, rule: 'non_consensual', status: 'cleared', reviewed_by: 'modmia', reviewed_at: '2026-11-15 15:00:00', created_at: '2026-11-15 12:00:00', channel: { id: 72, username: 'sam' }, url: '/clip/9?t=12' }] };
    await ctx.loadFlaggedSpeech('cleared');
    assert.ok(calls.at(-1)[0].includes('status=cleared'));
    const settled = els['flagged-speech-content'].innerHTML;
    assert.ok(settled.includes('Clip at 0:12') && settled.includes('Nothing wrong by @modmia'), 'who settled it');
    assert.ok(settled.includes("markFlaggedSpeech(5,'open')") && !settled.includes("markFlaggedSpeech(5,'handled')"), 'a settled flag can only be reopened');

    answer = async () => { const e = new Error('Moderator access required'); e.status = 403; throw e; };
    await ctx.loadFlaggedSpeech('open');
    assert.ok(els['flagged-speech-content'].innerHTML.includes('Moderators and admins only.'));
    console.log('admin-flagged-speech: the queue reads, links each moment, and marks flags');
})().catch((e) => { console.error(e); process.exit(1); });
