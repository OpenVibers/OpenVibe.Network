'use strict';
// The AI setup's two ends (public/js/admin/ai-setup.js, 2026-11-12, the owner: "finish the guided easy step by step
// setup for owners"): it opens on Start (what is free, the credits you already get, one tap for the recommended set,
// the first job that is not ready) and ends on Finish (what is ready, what is left with a way to it, a test of every
// ready job); the stepper shows both, and Continue from Defaults leads to Finish.
//   node test/admin-ai-setup-ends.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const els = {};
const el = (id) => (els[id] ||= { id, innerHTML: '', textContent: '', className: '', disabled: false, scrollIntoView() {} });
['setup-main', 'setup-steps', 'setup-progress'].forEach(el);
const ctx = {
    esc: (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    toast() {}, api: async () => ({}), console, window: {},
    document: { getElementById: (id) => els[id] || null, querySelectorAll: () => [] },
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'admin', 'ai-setup.js'), 'utf8')
    + '\n;globalThis.__s = { set: (s) => { aiSetupState = s; }, step: () => aiSetupStep, renderAiSetup, selectAiSetupStep, nextAiSetupNotReady };', ctx);
const S = ctx.__s;
const offer = (provider, model, label) => ({ provider, model, label, price: { text: 'free' } });
S.set({
    steps: [
        { id: 'chat', name: 'Chat and writing', what: 'Turns text into an answer.', ready: true, state: 'ready', route: 'default.chat', recommended: offer('deepseek', 'deepseek-flash', 'DeepSeek Flash'), alternatives: [] },
        { id: 'decide', name: 'Decisions (routing and checks)', what: 'Answers yes/no questions.', ready: false, state: 'not_set', route: 'decide.fallback', recommended: offer('gemini', 'gemini-decision-1', 'Gemini Decision 1'), alternatives: [] },
    ],
    summary: { total: 2, ready: 1 }, defaults: [],
});

// Start: the first page, with what is free, the credits already paid for and the first job not ready.
assert.strictEqual(S.step(), 'start', 'the setup opens on Start');
S.renderAiSetup();
const start = els['setup-main'].innerHTML;
assert.match(start, /Altare Inference/);
assert.match(start, /ChatGPT Pro<\/strong> includes \$100, \$200 or \$500 of OpenAI API credit a month/);
assert.match(start, /Monthly credits/);
assert.match(start, /Use the recommended set/);
assert.match(start, /Start with Decisions \(routing and checks\)/, 'the first job that is not ready');
assert.match(els['setup-steps'].innerHTML, /Start[\s\S]*Chat and writing[\s\S]*Decisions[\s\S]*Defaults[\s\S]*Finish/, 'the stepper shows both ends');

// Finish: ready and left, a way to what is left, a test of every ready job.
S.selectAiSetupStep('done');
const done = els['setup-main'].innerHTML;
assert.match(done, /1 of 2 ready/);
assert.match(done, /onclick="selectAiSetupStep\('decide'\)">Set it/, 'what is left has a way to it');
assert.match(done, /Test every ready job/);
assert.ok(done.indexOf('Decisions') < done.indexOf('Chat and writing'), 'what is left comes first');

// Continue from Defaults leads to Finish when nothing else is left to do.
S.set({ steps: [{ id: 'chat', name: 'Chat and writing', ready: true, state: 'ready', route: 'default.chat', recommended: offer('deepseek', 'deepseek-flash', 'DeepSeek Flash'), alternatives: [] }], summary: { total: 1, ready: 1 }, defaults: [] });
S.selectAiSetupStep('defaults');
S.nextAiSetupNotReady();
assert.strictEqual(S.step(), 'done');
assert.match(els['setup-main'].innerHTML, /Everything is set/);
console.log('admin-ai-setup-ends: Start (free, granted credits, one tap, first job left), Finish (ready, left, test all), Defaults → Finish');
