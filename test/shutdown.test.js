'use strict';
// A restart drains instead of cutting (roadmap WS-P lifecycle): on SIGTERM the server stops taking
// connections, closes idle keep-alive ones and exits 0, promptly, even with a keep-alive client connected.
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
        const t0 = Date.now();
        child.kill('SIGTERM');
        const r = await Promise.race([exited, new Promise((res) => setTimeout(() => res({ timeout: true }), 8000))]);
        assert.ok(!r.timeout, 'exits within 8 s with an idle keep-alive connection open');
        assert.deepStrictEqual([r.code, r.signal], [0, null], `a clean exit, not a kill: ${JSON.stringify(r)}\n${out.slice(-800)}`);
        assert.ok(/SIGTERM: closing/.test(out), 'says it is closing');
        console.log(`shutdown: exited 0 in ${Date.now() - t0} ms`);
        agent.destroy();
    } finally {
        if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
        fs.rmSync(dir, { recursive: true, force: true });
    }
    console.log('shutdown: all checks passed');
})().catch((err) => { console.error(err); process.exitCode = 1; });
