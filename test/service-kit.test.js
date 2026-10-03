'use strict';
// Network's graceful shutdown is the shared service kit (roadmap WS-P lifecycle; openvibe-sdk/service):
// the local shutdown copy is gone and server/index.js wires gracefulStop/within from the SDK with
// Network's own numbers. The behavioural check below runs a stop and proves Network's stop and close steps
// run in order and a clean stop exits 0; shutdown.test.js proves the same wiring on the real server.
//   node test/service-kit.test.js
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { gracefulStop, within } = require('openvibe-sdk/service');

const root = path.join(__dirname, '..');
const index = fs.readFileSync(path.join(root, 'server', 'index.js'), 'utf8');

// Static: the wiring is the SDK's, with today's Network values.
assert.ok(/const \{ gracefulStop, within \} = require\('openvibe-sdk\/service'\)/.test(index), "server/index.js imports gracefulStop and within from openvibe-sdk/service");
assert.ok(!/require\(['"]\.\/graceful['"]\)/.test(index), 'server/index.js no longer requires ./graceful');
assert.ok(!fs.existsSync(path.join(root, 'server', 'graceful' + '.js')), 'the local shutdown copy is deleted');
assert.ok(/name: 'Network', server, drainMs: 8000, deadlineMs: 10000, deadlineExitCode: 1/.test(index), 'drainMs 8000, deadlineMs 10000, deadlineExitCode 1');
// The stop and close step lists are still Network's, in today's order.
const stopAt = index.indexOf('stop: [');
const closeAt = index.indexOf('close: [');
assert.ok(stopAt > 0 && closeAt > stopAt, 'the stop list precedes the close list');
for (const marker of ['ecosystem.stop()', 'deployDrift.stop()', 'libraryTags.stop()', 'frameService.stop()']) {
    assert.ok(index.indexOf(marker) > stopAt && index.indexOf(marker) < closeAt, `stop step ${marker} is in the stop list`);
}
for (const marker of ["require('./developer/event-relay').stopRelay(db)", 'analytics.destroy()', 'db.close()', 'valkey && valkey.close()']) {
    assert.ok(index.indexOf(marker) > closeAt, `close step ${marker} is in the close list`);
}

(async () => {
    const server = http.createServer((req, res) => { res.end('ok'); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const order = [];
    let code = null;
    const { stop, stopping } = gracefulStop({
        name: 'ServiceKit', server, drainMs: 8000, deadlineMs: 10000, deadlineExitCode: 1, signals: false,
        exit: (c) => { code = c; },
        stop: [() => order.push('stop:one'), async () => order.push('stop:two')],
        close: [() => order.push('close:one'), async () => order.push('close:two')],
    });
    assert.strictEqual(stopping(), false, 'not stopping before the signal');
    const stopped = await stop('SIGTERM');
    assert.deepStrictEqual(order, ['stop:one', 'stop:two', 'close:one', 'close:two'], 'the stop then close steps run in order');
    assert.strictEqual(code, 0, 'a clean stop exits 0');
    assert.strictEqual(stopped, 0, 'stop() resolves with the exit code');
    assert.strictEqual(stopping(), true, 'stopping() is true once stop() has run');

    // within() bounds a step and swallows its rejection (a best-effort stop step is never a reason to fail the stop).
    const t0 = Date.now();
    await within(50, new Promise(() => {}));
    assert.ok(Date.now() - t0 < 2000, 'within returns at its bound');
    await within(50, Promise.reject(new Error('a slow step rejected')));

    console.log('service-kit: all checks passed');
})().catch((err) => { console.error(err); process.exitCode = 1; });
