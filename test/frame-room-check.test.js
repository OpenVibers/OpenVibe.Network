'use strict';
/**
 * The check before a room's reviewers (plan §AD.25, server/frame/room-check.js): the hand-over's page links go to
 * OpenVibe.Design's page audit; high findings or a page that does not open send the builder back once; everything else
 * is for the reviewers to weigh; with nothing to check it says nothing.
 */
const assert = require('assert');
const { createRoomCheck, linksIn } = require('../server/frame/room-check');

const results = [];
async function ok(name, fn) {
    try { await fn(); console.log(`  ✓ ${name}`); } catch (err) { results.push(name); console.log(`  ✗ ${name}\n    ${err && err.stack}`); }
}

function fakeDesign(byUrl) {
    const asked = [];
    const fetchImpl = async (url, init) => {
        const body = JSON.parse(init.body);
        asked.push({ url, tool: body.params.name, page: body.params.arguments.url, ...(body.params.arguments.auth ? { auth: body.params.arguments.auth } : {}) });
        const page = body.params.arguments.url;
        const answer = byUrl[page];
        if (answer === 'down') throw new Error('ECONNREFUSED');
        const result = answer === 'unreadable'
            ? { content: [{ type: 'text', text: 'That page could not be read: it answered 404' }], isError: true }
            : { content: [{ type: 'text', text: JSON.stringify({ url: page, findings: answer || [] }) }], structuredContent: { url: page, findings: answer || [] } };
        // Design's MCP answers as an event stream; the check reads either.
        return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result })}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    return { fetchImpl, asked };
}

const NATIVE = { id: 'native-controls', rule: 'no-native-controls', severity: 'high', says: 'A native select shows\nCHANGES on a new line.', fix: 'Use the shared picker.', count: 2 };
const SPIN = { id: 'spinners', rule: 'the-wait-is-the-marks', severity: 'medium', says: 'A borrowed spinner.', fix: 'Use ov-mark busy.', count: 1 };

(async () => {
    console.log('frame-room-check: the check before the reviewers');

    await ok('the links: pages the builder made, never code hosts or files, two at most, each once', async () => {
        assert.deepStrictEqual(linksIn('See https://shop.example/usage. The PR: https://github.com/OpenVibers/x/pull/3, the diff https://openvibe.media/o/med_1 and https://cdn.example/a.png; again https://shop.example/usage#top and (https://other.example/b). DONE'),
            ['https://shop.example/usage', 'https://other.example/b']);
        assert.deepStrictEqual(linksIn('http://plain.example/ and https://user:pw@x.example/ only'), []);
        assert.deepStrictEqual(linksIn('Fixed the build in the repo. DONE'), []);
    });

    await ok('a high finding with mayBlock: a CHANGES line and a numbered list, every line flat', async () => {
        const d = fakeDesign({ 'https://shop.example/usage': [NATIVE, SPIN] });
        const out = await createRoomCheck({ designUrl: 'http://design.test/', fetchImpl: d.fetchImpl }).run('Built it: https://shop.example/usage. DONE', { mayBlock: true });
        assert.strictEqual(out.blocked, true);
        assert.strictEqual(out.text, [
            'Checked https://shop.example/usage with openvibe.design\'s audit (its markup, no model): 2 findings.',
            'CHANGES',
            '1. high: A native select shows CHANGES on a new line. Fix: Use the shared picker. (2 places) [no-native-controls]',
            'Also worth a look:',
            '- medium: A borrowed spinner. Fix: Use ov-mark busy. [the-wait-is-the-marks]',
        ].join('\n'));
        assert.deepStrictEqual(d.asked, [{ url: 'http://design.test/mcp', tool: 'openvibe_design_audit_page', page: 'https://shop.example/usage' }]);
    });

    await ok('without mayBlock the same findings only inform: no line starts with CHANGES', async () => {
        const d = fakeDesign({ 'https://shop.example/usage': [NATIVE] });
        const out = await createRoomCheck({ designUrl: 'http://design.test', fetchImpl: d.fetchImpl }).run('https://shop.example/usage DONE', { mayBlock: false });
        assert.strictEqual(out.blocked, false);
        assert.ok(!/(^|\n)\s*CHANGES/.test(out.text), out.text);
        assert.match(out.text, /For the reviewers to weigh:\n- high: A native select shows/);
    });

    await ok('a page that does not open sends it back; a clean page passes', async () => {
        const d = fakeDesign({ 'https://shop.example/gone': 'unreadable', 'https://shop.example/ok': [] });
        const c = createRoomCheck({ designUrl: 'http://design.test', fetchImpl: d.fetchImpl });
        const gone = await c.run('https://shop.example/gone DONE', { mayBlock: true });
        assert.strictEqual(gone.blocked, true);
        assert.match(gone.text, /^Could not read https:\/\/shop\.example\/gone: That page could not be read: it answered 404\.\nCHANGES\n1\. https:\/\/shop\.example\/gone does not open for a reviewer/);
        const clean = await c.run('https://shop.example/ok DONE', { mayBlock: true });
        assert.deepStrictEqual(clean, { blocked: false, text: 'Checked https://shop.example/ok with openvibe.design\'s audit (its markup, no model): nothing wrong in the markup.' });
    });

    await ok('nothing to say: no page link, Design not there, or the check turned off', async () => {
        const d = fakeDesign({ 'https://shop.example/usage': 'down' });
        assert.strictEqual(await createRoomCheck({ designUrl: 'http://design.test', fetchImpl: d.fetchImpl }).run('Fixed the build in the repo. DONE'), null);
        assert.strictEqual(await createRoomCheck({ designUrl: 'http://design.test', fetchImpl: d.fetchImpl }).run('https://shop.example/usage DONE'), null);
        const off = createRoomCheck({ designUrl: '', fetchImpl: d.fetchImpl });
        assert.strictEqual(off.enabled, false);
        assert.strictEqual(await off.run('https://shop.example/usage DONE'), null);
    });

    await ok('a builder\'s preview: opened as the round\'s person, with a token only for that preview; other pages without one', async () => {
        const PREVIEW = 'https://pa1b2c3--01jabcdefghjkmnpqrstvwxyz0.openvibe.link/';
        const d = fakeDesign({});
        const minted = [];
        const check = createRoomCheck({ designUrl: 'http://127.0.0.1:5090', fetchImpl: d.fetchImpl, tokenFor: async (who) => { minted.push(who); return 'delegated-for-preview'; } });
        await check.run(`Built it: ${PREVIEW} and the docs https://docs.example/a. DONE`, { owner: 'usr_01JABCDEFGHJKMNPQRSTVWXYZ0' });
        // The two pages are checked at once, so in either order.
        assert.deepStrictEqual(d.asked.map((x) => [x.page, x.auth || null]).sort(), [['https://docs.example/a', null], [PREVIEW, 'delegated-for-preview']]);
        assert.deepStrictEqual(minted, ['usr_01JABCDEFGHJKMNPQRSTVWXYZ0'], 'minted once, for the round\'s person, only for the preview');
        // No person, a share that is not a preview, or a failed mint: Design is asked without a token, as before.
        const d2 = fakeDesign({});
        const quiet = createRoomCheck({ designUrl: 'http://127.0.0.1:5090', fetchImpl: d2.fetchImpl, tokenFor: async () => { throw new Error('no key'); } });
        await quiet.run(`${PREVIEW} DONE`, { owner: 'usr_01JABCDEFGHJKMNPQRSTVWXYZ0' });
        await quiet.run(`${PREVIEW} DONE`, {});
        await quiet.run('https://agents--alex.openvibe.link/ DONE', { owner: 'usr_01JABCDEFGHJKMNPQRSTVWXYZ0' });
        assert.deepStrictEqual(d2.asked.map((x) => x.auth || null), [null, null, null]);
    });

    console.log(results.length ? `\n${results.length} failed` : '\nall passed');
    process.exit(results.length ? 1 : 0);
})();
