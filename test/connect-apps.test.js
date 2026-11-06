'use strict';
// The catalogue (Compute plan E7, server/connect/apps): ten app definitions, one file each. Every
// definition says the auth kind, the walkthrough with its links, the test call and the actions, each
// with a name, a JSON Schema for its input, a risk level and the fixed request it makes. A definition
// that is broken is refused when the catalogue loads, so a mistake here never becomes a capability.
//   node test/connect-apps.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const registry = require('../server/connect/apps');
const schema = require('../server/connect/schema');

(async () => {
    const quiet = console.log;
    console.log = () => {};
    let failures = 0;
    const check = async (name, fn) => { try { await fn(); quiet('  ✓', name); } catch (e) { failures++; quiet('  ✗', name, '\n     ', (e.stack || String(e)).split('\n').slice(0, 6).join('\n      ')); } };

    try {
        await check('the catalogue is ten apps, one file each', async () => {
            const files = fs.readdirSync(path.join(__dirname, '..', 'server', 'connect', 'apps')).filter((f) => f.endsWith('.js') && f !== 'index.js');
            assert.strictEqual(files.length, 10, 'ten definition files');
            const apps = registry.all();
            assert.strictEqual(apps.length, 10);
            const keys = apps.map((a) => a.key).sort();
            assert.deepStrictEqual(keys, ['ai', 'discord', 'github', 'google', 'linear', 'notion', 'slack', 'steam', 'todoist', 'trello']);
            assert.strictEqual(new Set(keys).size, 10, 'every app has its own key');
        });

        await check('every definition is whole: the auth kind, the walkthrough with its links, the test call', async () => {
            for (const def of registry.all()) {
                const problems = registry.validateDefinition(def);
                assert.deepStrictEqual(problems, [], def.key + ': ' + problems.join(', '));
                assert.ok(['token', 'api_key', 'bot_token', 'byok_link'].includes(def.auth.kind), def.key);
                assert.ok(def.walkthrough.length >= 3, def.key + ' has a walkthrough');
                for (const step of def.walkthrough) {
                    if (step.link) assert.ok(String(step.link).startsWith('https://'), def.key + ' links are https');
                }
                if (def.auth.kind !== 'byok_link') {
                    assert.ok(def.test && def.test.method && def.test.path, def.key + ' has a test call');
                    assert.ok(def.apiHost && !def.apiHost.includes('/'), def.key + ' has a fixed host');
                }
            }
        });

        await check('every action has a name, a schema, a risk and a fixed request', async () => {
            let actions = 0;
            for (const def of registry.all()) {
                for (const action of def.actions || []) {
                    actions += 1;
                    assert.ok(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/.test(action.name), action.name);
                    assert.ok(action.input && action.input.type === 'object', action.name + ' has an object schema');
                    assert.ok(['read', 'write', 'send', 'delete', 'pay'].includes(action.risk), action.name + ' has a risk');
                    assert.ok(action.request && action.request.method && action.request.path, action.name + ' has a request');
                    assert.ok(!String(action.request.path).includes('://'), action.name + ' names no URL');
                    assert.ok(!/\{[^}]*\}/.test(action.request.path.replace(/\{[a-z_]+\}/g, '')), action.name + ' has no stray placeholder');
                    // The schema must accept a good input and refuse a bad one.
                    const good = {};
                    for (const [k, v] of Object.entries(action.input.properties || {})) {
                        if (Array.isArray(v.enum) && v.enum.length) { good[k] = v.enum[0]; continue; }
                        if (v.type === 'integer' || v.type === 'number') { good[k] = 1; continue; }
                        if (v.type === 'boolean') { good[k] = true; continue; }
                        if (v.type === 'array') { good[k] = []; continue; }
                        if (v.type === 'object') { good[k] = {}; continue; }
                        if (v.pattern) {
                            const sample = String(v.pattern).includes('17') ? '12345678901234567' : (String(v.pattern).includes('2,10') ? 'es' : 'x');
                            if (new RegExp(v.pattern).test(sample)) { good[k] = sample; continue; }
                            continue;   // a pattern this test cannot satisfy: the field is left out
                        }
                        good[k] = 'x';
                    }
                    const verdict = schema.validate(action.input, good);
                    assert.strictEqual(verdict.valid, true, action.name + ' accepts a good input: ' + JSON.stringify(verdict.errors || []));
                    assert.strictEqual(schema.validate(action.input, { nope: 1 }).valid, false, action.name + ' refuses an unknown field');
                }
            }
            assert.ok(actions >= 30, 'the catalogue has its actions: ' + actions);
        });

        await check('the send, delete and pay actions are the ones that ask', async () => {
            const asks = [];
            for (const def of registry.all()) {
                for (const action of def.actions || []) if (['send', 'delete', 'pay'].includes(action.risk)) asks.push(action.name);
            }
            assert.ok(asks.length >= 8, 'the catalogue has actions that ask: ' + asks.length);
            assert.ok(asks.some((n) => n.endsWith('.comment') || n.includes('message') || n.includes('comment')), asks.join(', '));
        });

        await check('the summaries name the ten apps and their auth kinds', async () => {
            const list = registry.summaries();
            assert.strictEqual(list.length, 10);
            for (const app of list) {
                assert.ok(app.name && app.blurb, app.key);
                assert.ok(app.auth_kind, app.key);
                assert.ok(Array.isArray(app.actions), app.key);
            }
            const ai = list.find((a) => a.key === 'ai');
            assert.strictEqual(ai.auth_kind, 'byok_link', 'the provider keys live in OpenVibe.AI');
            assert.ok(ai.byok && ai.byok.providers.length === 2, 'OpenAI and Anthropic');
        });
    } finally {
        console.log = quiet;
    }
    console.log(failures ? `\n${failures} failed` : '\nconnect apps: all checks passed');
    process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
