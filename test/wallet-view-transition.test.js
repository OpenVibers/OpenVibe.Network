'use strict';
// The wallet opts into cross-document view transitions (the shared kit.css) and, signed out, replaces itself with
// /login, which does not load the kit and so does not opt in. Chrome aborts the transition and leaves an uncaught
// InvalidStateError on the sign-in page ("ViewTransition opt-in disabled", 11-01). Wallet's common.js skips the
// transition on a replace navigation (a redirect, not a page move) and handles the transition's promises, the same
// way Shared's account switcher does. The file is loaded in a small fake browser, as in signin-bounce-replace.test.js.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'wallet', 'common.js'), 'utf8');

function load() {
    const listeners = {};
    const sandbox = {
        console, JSON, Object, String, Number, Math, Array, Promise, Error, URL, URLSearchParams, Date,
        decodeURIComponent, encodeURIComponent,
        document: { cookie: '' },
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        location: { origin: 'https://openvibe.network', pathname: '/wallet', search: '' },
        addEventListener(type, fn) { listeners[type] = fn; },
        setTimeout() {}, clearTimeout() {},
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.runInNewContext(SRC, sandbox, { filename: 'common.js' });
    return listeners;
}

function fakeTransition() {
    const seen = { handled: [], skipped: 0 };
    const promise = (name) => ({ catch() { seen.handled.push(name); } });
    return {
        seen,
        transition: {
            finished: promise('finished'),
            ready: promise('ready'),
            updateCallbackDone: promise('updateCallbackDone'),
            skipTransition() { seen.skipped++; },
        },
    };
}

(async () => {
    // 1. The redirect (a replace navigation) is skipped before it can be aborted, and its promises are handled.
    {
        const listeners = load();
        assert.strictEqual(typeof listeners.pageswap, 'function', 'the pageswap listener is installed');
        assert.strictEqual(typeof listeners.pagereveal, 'function', 'the pagereveal listener is installed');
        const { seen, transition } = fakeTransition();
        listeners.pageswap({ viewTransition: transition, activation: { navigationType: 'replace' } });
        assert.deepStrictEqual(seen.handled.sort(), ['finished', 'ready', 'updateCallbackDone'], 'all three promises are handled');
        assert.strictEqual(seen.skipped, 1, 'a replace navigation skips its transition');
    }

    // 2. A normal page move keeps its transition: the promises are handled, skipTransition is not called.
    {
        const listeners = load();
        const { seen, transition } = fakeTransition();
        listeners.pageswap({ viewTransition: transition, activation: { navigationType: 'push' } });
        assert.strictEqual(seen.skipped, 0, 'a push navigation keeps its transition');
        assert.strictEqual(seen.handled.length, 3, 'and its promises are still handled');
    }

    // 3. The arriving page handles the transition it was given too.
    {
        const listeners = load();
        const { seen, transition } = fakeTransition();
        listeners.pagereveal({ viewTransition: transition });
        assert.strictEqual(seen.handled.length, 3, 'pagereveal promises are handled');
        assert.strictEqual(seen.skipped, 0, 'arriving is not a redirect');
    }

    // 4. Nothing to do without a transition, or without an activation.
    {
        const listeners = load();
        assert.doesNotThrow(() => listeners.pageswap({ activation: { navigationType: 'replace' } }));
        assert.doesNotThrow(() => listeners.pageswap({ viewTransition: {}, activation: null }));
        assert.doesNotThrow(() => listeners.pageswap(null));
        assert.doesNotThrow(() => listeners.pagereveal({}));
    }

    // 5. A real rejected promise is handled, not left as an unhandled rejection on the sign-in page.
    {
        const listeners = load();
        const transition = {
            finished: Promise.reject(new Error('Transition was aborted because of invalid state')),
            ready: Promise.resolve(),
            updateCallbackDone: Promise.resolve(),
            skipTransition() {},
        };
        listeners.pageswap({ viewTransition: transition, activation: { navigationType: 'push' } });
        await new Promise((resolve) => setImmediate(resolve));
    }

    console.log('wallet-view-transition: ok');
})().catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exitCode = 1;
});
