'use strict';
// GET /api/v1/me/receipts, mounted in the real app: the person's own token reaches Mail, Mail's answer is passed on,
// and Inbox AI off stays empty. The card's rendering is in test/my-receipts.test.js.
//   node --import ./test/helpers/pg-preload.mjs test/my-receipts-route.test.js
const assert = require('assert');
const http = require('http');
const { bootServer } = require('./helpers/boot-server');
const { signToken } = require('../server/auth/routes');

(async () => {
    const asked = [];
    let mode = 'on';
    const mail = http.createServer((req, res) => {
        asked.push({ url: req.url, auth: req.headers.authorization });
        res.setHeader('content-type', 'application/json');
        res.setHeader('cache-control', 'no-store');
        if (mode === 'down') { res.statusCode = 503; return res.end('{}'); }
        if (mode === 'off') return res.end(JSON.stringify({ enabled: false, receipts: [] }));
        return res.end(JSON.stringify({ enabled: true, receipts: [{
            thread_id: 'thr_1', message_id: 'msg_1', merchant: 'Shop', subject: 'Your order',
            summary: 'Order delivered', received_at: '2026-11-08T09:30:00Z',
        }] }));
    });
    await new Promise((r) => mail.listen(0, '127.0.0.1', r));

    const srv = await bootServer({ env: { OV_MAIL_INTERNAL_URL: `http://127.0.0.1:${mail.address().port}` } });
    try {
        const db = srv.app.locals.db;
        const config = srv.app.locals.config;
        await db.prepare("INSERT INTO users (id, username, email, password_hash, email_verified) VALUES (92, 'receipts', 'receipts@example.test', 'x', 1)").run();
        const user = await db.prepare('SELECT * FROM users WHERE id = 92').get();
        const token = signToken(user, srv.app.locals.privateKey, config);
        const get = (headers = {}) => fetch(`${srv.base}/api/v1/me/receipts`, { headers });

        let r = await get({ authorization: `Bearer ${token}` });
        let d = await r.json();
        assert.strictEqual(r.status, 200);
        assert.strictEqual(d.enabled, true);
        assert.strictEqual(d.receipts.length, 1);
        assert.strictEqual(d.receipts[0].message_id, 'msg_1');
        const receiptRequest = asked.find((request) => request.url === '/api/v1/me/mail/receipts');
        assert.ok(receiptRequest, 'the real app reached Mail');
        assert.strictEqual(receiptRequest.auth, `Bearer ${token}`, "with the person's own token");

        mode = 'off';
        r = await get({ authorization: `Bearer ${token}` });
        d = await r.json();
        assert.deepStrictEqual(d, { enabled: false, receipts: [] }, 'Inbox AI off: no receipts and the flag to say so');

        mode = 'down';
        r = await get({ authorization: `Bearer ${token}` });
        assert.strictEqual(r.status, 502, 'Mail away: the card stays out');

        r = await get();
        assert.strictEqual(r.status, 401, 'no person, no receipts');
    } finally {
        await srv.stop();
        mail.close();
        console.log('my-receipts-route: the real route forwards the person token and passes Mail states through ok');
    }
})().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
