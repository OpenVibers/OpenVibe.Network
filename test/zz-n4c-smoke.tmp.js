const path = require('path');
const fs = require('fs'), os = require('os');
async function bootServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n4b-boot-'));
  const k = require('crypto').generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  fs.writeFileSync(path.join(dir, 'none.pem'), k.privateKey); fs.writeFileSync(path.join(dir, 'none.pub.pem'), k.publicKey);
  const port = 30000 + Math.floor(Math.random() * 20000);
  Object.assign(process.env, { NODE_ENV: 'test', PORT: String(port), HOST: '127.0.0.1', PGLITE_DIR: path.join(dir, 'pglite'), AVATAR_PATH: path.join(dir, 'avatars'),
    JWT_PRIVATE_KEY: path.join(dir, 'none.pem'), JWT_PUBLIC_KEY: path.join(dir, 'none.pub.pem'), BOOTSTRAP_PROFILE: 'local-dev', INTERNAL_API_KEY: 'k'.repeat(40),
    OV_NETWORK_INTERNAL_URL: `http://127.0.0.1:${port}` });
  const cp = require.resolve(path.resolve('server/config.js')); const config = require(cp); delete require.cache[cp]; Object.assign(config, require(cp));
  let out = '';
  for (const st of [process.stdout, process.stderr]) { const w = st.write.bind(st); st.write = (c, ...r) => { out += String(c); return w(c, ...r); }; }
  const { app, server } = await require(path.resolve('server/index.js')).ready;
  if (!server.listening) await new Promise((r) => server.once('listening', r));
  return { base: `http://127.0.0.1:${server.address().port}`, app, logs: () => out, stop: () => new Promise((r) => server.close(() => r())) };
}
(async () => {
  const s = await bootServer();
  const db = s.app.locals.db;
  const { ids } = require('openvibe-contracts');
  await db.prepare("UPDATE oauth_clients SET client_secret = 'bot-smoke' WHERE client_id = 'bot'").run();
  const sub = `usr_${ids.ulid()}`;
  await db.prepare("INSERT INTO users (id, username, password_hash, subject_id) VALUES (9901, 'smoke', 'x', ?)").run(sub);
  const j = async (m, p, body, h = {}) => { const r = await fetch(s.base + p, { method: m, headers: { 'content-type': 'application/json', ...h }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, cc: r.headers.get('cache-control'), body: await r.json().catch(() => null) }; };
  const tok = async (id, secret, audience) => { const r = await fetch(s.base + '/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret, audience }) }); return { status: r.status, cc: r.headers.get('cache-control'), body: await r.json() }; };
  const A = { authorization: `Bearer ${(await tok('bot', 'bot-smoke', 'openvibe.network')).body.access_token}` };
  const mint = await j('POST', '/internal/node-pairings', { owner: { kind: 'user', subject: sub }, ref: 'smoke' }, A);
  const red = await j('POST', '/api/v1/node-pairing', { pairing: mint.body.pairing_id, code: mint.body.code, name: 'Smoke' });
  const nt = await tok(red.body.principal, red.body.credential, 'openvibe.network');
  console.error('NODE TOKEN', nt.status, nt.cc, nt.body.scope);
  const claims = JSON.parse(Buffer.from(nt.body.access_token.split('.')[1], 'base64url').toString());
  console.error('CLAIMS', JSON.stringify({ ...claims, sub: claims.sub.replace(/nod_\w+/, 'nod_<ULID>'), jti: claims.jti.slice(0, 8) + '…' }));
  console.error('BAD', (await tok(red.body.principal, 'x', 'openvibe.network')).status, (await tok(red.body.principal, red.body.credential, 'openvibe.chat')).status);
  const N = { authorization: `Bearer ${nt.body.access_token}` };
  const doc = { node_id: red.body.node_id, cpu: { cores: 4 }, arch: 'arm64', memory_mb: 4096, storage: { capacity_gb: 64, available_gb: 32, kind: 'ssd' }, network: { ingress_mbps: 100, egress_mbps: 20 }, regions: ['us-west'], tags: [], costs: { per_hour_usd: 0 }, capabilities: [], agent_version: '0.1.0', updated_at: '2026-10-02T00:00:00Z' };
  const put = await j('PUT', '/api/v1/node/self/capabilities', doc, N);
  console.error('PUT caps', put.status, put.cc, JSON.stringify(put.body));
  const mm = await j('PUT', '/api/v1/node/self/capabilities', { ...doc, node_id: 'n-other' }, N);
  console.error('PUT mismatch', mm.status, mm.body.code);
  const rot = await j('POST', '/api/v1/node/self/credential', null, N);
  console.error('ROTATE', rot.status, rot.cc, Object.keys(rot.body));
  console.error('NEW/OLD', (await tok(red.body.principal, rot.body.credential, 'openvibe.network')).status, (await tok(red.body.principal, red.body.credential, 'openvibe.network')).status);
  const bt = await j('PUT', '/api/v1/node/self/capabilities', doc, A);
  console.error('SVC', bt.status, bt.body.code);
  await j('POST', `/internal/node-principals/${red.body.principal}/revoke`, null, A);
  const rv = await j('POST', '/api/v1/node/self/credential', null, N);
  console.error('REVOKED', rv.status, rv.body.code);
  console.error('LEAK', [red.body.credential, rot.body.credential].some((c) => s.logs().includes(c)));
  await s.stop(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
