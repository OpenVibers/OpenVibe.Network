'use strict';
// A restart drains instead of cutting (roadmap WS-P lifecycle; server/graceful.js): on SIGTERM the server
// stops taking connections, closes idle keep-alive ones, answers the request in flight (Connection: close),
// stops its timers, pollers and relay, closes the databases and exits 0 within the manifest's 10 s, promptly,
// even with a keep-alive client connected.
//   node test/shutdown.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-net-stop-'));
    const port = await freePort();
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
        env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DB_PATH: path.join(dir, 'network.db'), NODE_ENV: 'test' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
    try {
        let up = false;
        for (let i = 0; i < 100 && !up; i++) {
            up = await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.ok).catch(() => false);
            if (!up) await new Promise((r) => setTimeout(r, 100));
        }
        assert.ok(up, `the server did not start:\n${out.slice(-2000)}`);
        // A keep-alive client that finished its request and keeps the connection open.
        const agent = new http.Agent({ keepAlive: true });
        await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: '/api/health', agent }, (res) => { res.resume(); res.on('end', resolve); }).on('error', reject));
        // A request in flight: its JSON body is still coming (express.json reads it before any route answers).
        const body = Buffer.from(JSON.stringify({ probe: 'graceful-stop', pad: 'x'.repeat(64) }));
        const req = http.request({ host: '127.0.0.1', port, path: '/api/graceful-probe', method: 'POST', agent: false, headers: { 'Content-Type': 'application/json', 'Content-Length': body.length } });
        const answered = new Promise((resolve, reject) => {
            req.on('response', (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode, connection: res.headers.connection, at: Date.now() })); });
            req.on('error', reject);
        });
        req.write(body.subarray(0, 10));
        await new Promise((r) => setTimeout(r, 200));
        const t0 = Date.now();
        child.kill('SIGTERM');
        await new Promise((r) => setTimeout(r, 300));
        const refused = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) }).then(() => false, () => true);
        assert.ok(refused, 'no new connections once stopping');
        req.end(body.subarray(10));
        const a = await answered;
        assert.ok(a.at > t0, 'the request was still in flight at SIGTERM');
        assert.ok(a.status >= 200 && a.status < 600, `answered, not cut (${a.status})`);
        assert.strictEqual(a.connection, 'close');
        const r = await Promise.race([exited, new Promise((res) => setTimeout(() => res({ timeout: true }), 10000))]);
        assert.ok(!r.timeout, "exits within the manifest's 10 s with an idle keep-alive connection open");
        assert.deepStrictEqual([r.code, r.signal], [0, null], `a clean exit, not a kill: ${JSON.stringify(r)}\n${out.slice(-800)}`);
        assert.ok(/\[Network\] SIGTERM: stopping/.test(out), 'says it is stopping');
        assert.ok(/\[Network\] stopped in \d+ ms/.test(out), `ran every stop and close step\n${out.slice(-800)}`);
        assert.ok(!/stop: (stop|close) step failed/.test(out), `no step failed\n${out.slice(-1500)}`);
        console.log(`shutdown: exited 0 in ${Date.now() - t0} ms`);
        agent.destroy();
    } finally {
        if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
        fs.rmSync(dir, { recursive: true, force: true });
    }
    console.log('shutdown: all checks passed');
})().catch((err) => { console.error(err); process.exitCode = 1; });
