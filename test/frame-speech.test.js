'use strict';
/**
 * POST /api/frame/speech (server/frame/speech.js; Shared 4.308.0's ov-speak.js "OpenVibe voices"; the owner, 11-17:
 * "read out it's messages using text to speech if configured"): the person's words go to OpenVibe.AI's
 * /v1/audio/speech with the Frame's service token on behalf of that person, and the audio comes back. Bad words, a
 * voice that is no voice id and a speed out of range are refused in words; AI's own 402 is said as the Balance story;
 * anything else from AI is a 502; 120 a minute a person.
 *   node test/frame-speech.test.js
 */
const assert = require('assert');
const crypto = require('crypto');
const { createSpeech, MAX_TEXT } = require('../server/frame/speech');

(async () => {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const calls = [];
    let answer = () => new Response(Buffer.from('ID3fake-mp3'), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    const fetchImpl = async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return answer(); };
    let t = 1_000_000;
    const sp = createSpeech({ privateKey, issuer: 'https://openvibe.network', aiUrl: 'http://ai.test/', fetchImpl, now: () => t, log: { warn() {} } });

    // Refused in words, AI never asked.
    assert.deepStrictEqual(await sp.speak({ subject: 'usr_A', text: '  ' }), { status: 400, error: 'text is the words to read' });
    assert.strictEqual((await sp.speak({ subject: 'usr_A', text: 'x'.repeat(MAX_TEXT + 1) })).status, 413);
    assert.strictEqual((await sp.speak({ subject: 'usr_A', text: 'Hi', voice: 'Bad Voice!' })).status, 400);
    assert.strictEqual((await sp.speak({ subject: 'usr_A', text: 'Hi', speed: 3 })).status, 400);
    assert.strictEqual(calls.length, 0);

    // The words, on the person's behalf, in the default voice; the audio back.
    const ok = await sp.speak({ subject: 'usr_A', text: 'The build passed.', speed: 1.25 });
    assert.deepStrictEqual([ok.type, ok.audio.toString()], ['audio/mpeg', 'ID3fake-mp3']);
    const c = calls[0];
    assert.strictEqual(c.url, 'http://ai.test/v1/audio/speech');
    assert.deepStrictEqual(c.body, { model: 'tts-1', input: 'The build passed.', voice: 'gc_wave_queen', response_format: 'mp3', speed: 1.25, on_behalf_of: { type: 'user', id: 'usr_A' } });
    const claims = JSON.parse(Buffer.from(c.init.headers.Authorization.split(' ')[1].split('.')[1], 'base64url').toString());
    assert.deepStrictEqual([claims.sub, claims.cap, claims.aud], ['svc:network', ['ai.run.create'], ['openvibe.ai']], 'the Frame\'s own service token');
    assert.strictEqual((await sp.speak({ subject: 'usr_A', text: 'Again.', voice: 'gc_wave_brit' })) && calls[1].body.voice, 'gc_wave_brit');

    // AI's answers: the Balance story in words; anything else is a 502; unreachable is a 502.
    answer = () => new Response(JSON.stringify({ error: { message: 'Your free AI allowance is spent for today.' } }), { status: 402, headers: { 'content-type': 'application/json' } });
    assert.deepStrictEqual(await sp.speak({ subject: 'usr_A', text: 'Hi' }), { status: 402, error: 'Your free AI allowance is spent for today.' });
    answer = () => new Response('oops', { status: 500 });
    assert.deepStrictEqual(await sp.speak({ subject: 'usr_A', text: 'Hi' }), { status: 502, error: 'The voice did not answer; try again in a moment' });
    answer = () => { throw new Error('ECONNREFUSED'); };
    assert.strictEqual((await sp.speak({ subject: 'usr_A', text: 'Hi' })).status, 502);

    // 120 a minute a person; another person has their own; the next minute is new.
    answer = () => new Response(Buffer.from('mp3'), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    t += 61_000;
    for (let i = 0; i < 120; i += 1) assert.ok((await sp.speak({ subject: 'usr_B', text: 'Hi' })).audio, `request ${i + 1}`);
    assert.strictEqual((await sp.speak({ subject: 'usr_B', text: 'Hi' })).status, 429);
    assert.ok((await sp.speak({ subject: 'usr_C', text: 'Hi' })).audio, 'someone else');
    t += 60_000;
    assert.ok((await sp.speak({ subject: 'usr_B', text: 'Hi' })).audio, 'the next minute');
    console.log('frame-speech: the words on the person\'s behalf in an OpenVibe voice, refusals in words, AI\'s 402 said, 120 a minute');
})().catch((e) => { console.error(e); process.exit(1); });
