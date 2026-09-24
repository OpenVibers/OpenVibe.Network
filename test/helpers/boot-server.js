'use strict';
// Boots the real server (server/index.js) in a child process for route-level tests: a scratch
// database and data directory, loopback only, a free port, no .env (the child runs in the temp dir),
// ephemeral signing keys, and no traffic off the machine (fetch to anything but loopback is refused
// by a preload). stop() kills it; logs() returns what it printed.
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');

const NO_EGRESS = `'use strict';
const real = globalThis.fetch;
globalThis.fetch = (input, init) => {
    let host = '';
    try { host = new URL(typeof input === 'string' ? input : input.url).hostname; } catch { /* */ }
    if (host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]') return real(input, init);
    return Promise.reject(new Error('test: no egress to ' + host));
};
`;

function freePort() {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.once('error', reject);
        s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    });
}

async function bootServer({ env = {}, timeoutMs = 20000 } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-boot-'));
    const guard = path.join(dir, 'no-egress.js');
    fs.writeFileSync(guard, NO_EGRESS);
    const port = await freePort();
    const childEnv = {
        PATH: process.env.PATH, HOME: dir, NODE_ENV: 'test', PORT: String(port), HOST: '127.0.0.1',
        DB_PATH: path.join(dir, 'network.db'), AVATAR_PATH: path.join(dir, 'avatars'),
        JWT_PRIVATE_KEY: path.join(dir, 'none.pem'), JWT_PUBLIC_KEY: path.join(dir, 'none.pub.pem'),
        BOOTSTRAP_PROFILE: 'local-dev', INTERNAL_API_KEY: 'k'.repeat(40),
        OV_NETWORK_INTERNAL_URL: `http://127.0.0.1:${port}`,
        OV_LIVE_INTERNAL_URL: 'http://127.0.0.1:9', OV_TOOLS_INTERNAL_URL: 'http://127.0.0.1:9',
        OV_GAMES_INTERNAL_URL: 'http://127.0.0.1:9', OV_MEDIA_INTERNAL_URL: 'http://127.0.0.1:9',
        OV_AI_INTERNAL_URL: 'http://127.0.0.1:9',
        ...env,
    };
    const child = spawn(process.execPath, ['-r', guard, path.join(ROOT, 'server', 'index.js')], { cwd: dir, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    let exited = null;
    child.on('exit', (code, sig) => { exited = { code, sig }; });
    const base = `http://127.0.0.1:${port}`;
    const t0 = Date.now();
    for (;;) {
        if (exited) throw new Error(`server exited early (${JSON.stringify(exited)}):\n${out}`);
        try { const r = await fetch(`${base}/api/health`); if (r.ok) break; } catch { /* not listening yet */ }
        if (Date.now() - t0 > timeoutMs) { child.kill('SIGKILL'); throw new Error(`server did not answer within ${timeoutMs} ms:\n${out}`); }
        await new Promise(r => setTimeout(r, 100));
    }
    return {
        base, port, dir,
        logs: () => out,
        stop: () => new Promise((resolve) => {
            if (exited) return resolve();
            child.once('exit', () => resolve());
            child.kill('SIGTERM');
            setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* */ } }, 3000).unref();
        }),
    };
}

module.exports = { bootServer, freePort, ROOT };
