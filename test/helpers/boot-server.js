'use strict';
// Boots the real server (server/index.js) for route-level tests. Two modes:
//   bootServer()               IN THIS PROCESS (the Media pattern, ADR-035): it uses the same process
//                              database the preload opened (test/helpers/pg-preload.mjs), so a test can
//                              seed rows and call the routes against one database. A route dump is
//                              written by a preload that patches express's listen; a net guard keeps
//                              every client on loopback. Callers end with process.exit(0).
//   bootServer({ child: true }) a CHILD process with its own PGlite directory (PGLITE_DIR), for a
//                              standalone server whose database nobody else needs (a second, bare boot).
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { routeDumpEnv } = require('../security-crawl');

const ROOT = path.join(__dirname, '..', '..');

function freePort() {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.once('error', reject);
        s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    });
}

async function bootServer({ env = {}, child = false, timeoutMs = 60000 } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-boot-'));
    const port = await freePort();
    const dump = routeDumpEnv(dir);
    const baseEnv = {
        NODE_ENV: 'test', PORT: String(port), HOST: '127.0.0.1', PGLITE_DIR: path.join(dir, 'pglite'),
        AVATAR_PATH: path.join(dir, 'avatars'),
        JWT_PRIVATE_KEY: path.join(dir, 'none.pem'), JWT_PUBLIC_KEY: path.join(dir, 'none.pub.pem'),
        BOOTSTRAP_PROFILE: 'local-dev', INTERNAL_API_KEY: 'k'.repeat(40),
        OV_NETWORK_INTERNAL_URL: `http://127.0.0.1:${port}`,
        OV_LIVE_INTERNAL_URL: 'http://127.0.0.1:9', OV_TOOLS_INTERNAL_URL: 'http://127.0.0.1:9',
        OV_GAMES_INTERNAL_URL: 'http://127.0.0.1:9', OV_MEDIA_INTERNAL_URL: 'http://127.0.0.1:9',
        OV_AI_INTERNAL_URL: 'http://127.0.0.1:9',
    };

    if (child) {
        const childEnv = { PATH: process.env.PATH, HOME: dir, ...baseEnv, ...dump, ...env };
        const proc = spawn(process.execPath, ['-r', dump.NODE_OPTIONS.replace('--require ', ''), path.join(ROOT, 'server', 'index.js')], { cwd: dir, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        proc.stdout.on('data', (d) => { out += d; });
        proc.stderr.on('data', (d) => { out += d; });
        let exited = null;
        proc.on('exit', (code, sig) => { exited = { code, sig }; });
        const base = `http://127.0.0.1:${port}`;
        const t0 = Date.now();
        for (;;) {
            if (exited) throw new Error(`server exited early (${JSON.stringify(exited)}):\n${out}`);
            try { const r = await fetch(`${base}/api/health`); if (r.ok) break; } catch { /* not listening yet */ }
            if (Date.now() - t0 > timeoutMs) { proc.kill('SIGKILL'); throw new Error(`server did not answer within ${timeoutMs} ms:\n${out}`); }
            await new Promise(r => setTimeout(r, 100));
        }
        return {
            base, port, dir, logs: () => out,
            stop: () => new Promise((resolve) => {
                if (exited) return resolve();
                proc.once('exit', () => resolve());
                proc.kill('SIGTERM');
                setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* */ } }, 3000).unref();
            }),
        };
    }

    // In-process: the route-dump + no-egress preload, then env, then the server module.
    require(dump.NODE_OPTIONS.replace('--require ', ''));
    Object.assign(process.env, baseEnv, dump, env);
    // The preload (test/helpers/pg-preload.mjs) loads server/config.js before a test's environment exists.
    // Refresh that same object in place — every module holds this reference — so the booted server reads
    // the test's env (ports, keys, ADMIN_USERNAME), not the runner's.
    const configPath = require.resolve(path.join(ROOT, 'server', 'config.js'));
    const config = require(configPath);
    delete require.cache[configPath];
    Object.assign(config, require(configPath));
    let out = '';
    for (const stream of [process.stdout, process.stderr]) {
        const write = stream.write.bind(stream);
        stream.write = (chunk, ...rest) => { out += String(chunk); return write(chunk, ...rest); };
    }
    const t0 = Date.now();
    const { app, server } = await require(path.join(ROOT, 'server', 'index.js')).ready;
    if (!server.listening) await new Promise((r) => server.once('listening', r));
    if (Date.now() - t0 > timeoutMs) throw new Error(`server did not answer within ${timeoutMs} ms:\n${out}`);
    return {
        base: `http://127.0.0.1:${server.address().port}`, port: server.address().port, dir, app, server,
        logs: () => out,
        stop: () => new Promise((resolve) => { server.close(() => resolve()); }),
    };
}

module.exports = { bootServer, freePort, ROOT };
