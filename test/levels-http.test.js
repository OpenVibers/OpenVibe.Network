'use strict';
const assert = require('assert');
const express = require('express');
const { getDb } = require('../server/db/database');
const { publicRouter, settingsRouter, internalRoutes } = require('../server/levels/routes');
const { gate } = require('../server/public-cors');
(async () => {
    const db = getDb(); const subject = require('openvibe-contracts').ids.newId('user');
    const user = await db.prepare("INSERT INTO users(username,password_hash,subject_id) VALUES ('levels_http','unused',?) RETURNING id").get(subject);
    const auth = (req,res,next) => { if (req.headers.authorization !== 'Bearer test-person') return res.sendStatus(401); req.user = user; next(); };
    const app = express(); app.locals.db = db; app.use(express.json());
    app.use(gate((_req,_res,next) => next()));
    app.use('/api/v1/levels', publicRouter({ db, requireAuth: auth }));
    app.use('/api/v1/me/levels', settingsRouter({ db, requireAuth: auth }));
    const internal = express.Router();
    internalRoutes(internal, { guard: cap => (req,res,next) => {
        assert.equal(cap,'network.levels.award');
        if(req.headers.authorization !== 'Bearer test-service') return res.sendStatus(403);
        req.principal = { sub:'svc:quest' };next();
    }}); app.use('/internal',internal);
    const server = app.listen(0,'127.0.0.1'); await new Promise(r => server.once('listening',r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = (path,options) => fetch(base+path,options);
    try {
        let r = await get('/api/v1/levels/people/levels_http'); assert.equal(r.status,200); assert.equal(r.headers.get('access-control-allow-origin'),'*'); assert.equal(r.headers.get('cache-control'),'public, max-age=30');
        r = await get('/api/v1/levels/batch?subjects='+subject);assert.deepEqual(await r.json(),{levels:{[subject]:1}});
        r = await get('/api/v1/levels/board',{headers:{Authorization:'Bearer test-person'}});assert.equal(r.headers.get('cache-control'),'private, max-age=30'); assert.match(r.headers.get('vary'),/Authorization/); assert((await r.json()).all_time.me);
        const award = {subject,reason:'quest.completed',amount:25,idempotency_key:'http-completion'};
        const options = {method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer test-service'},body:JSON.stringify(award)};
        assert.equal((await get('/internal/levels/award',{...options,headers:{'Content-Type':'application/json'}})).status,403);
        assert.equal((await get('/internal/levels/award',options)).status,201);
        r = await get('/internal/levels/award',options); assert.equal(r.status,409); assert.equal((await r.json()).code,'levels.duplicate');
        r = await get('/api/v1/me/levels',{method:'PUT',headers:{'Content-Type':'application/json',Authorization:'Bearer test-person'},body:'{"leaderboard":false}'});assert.equal(r.status,200);
        r = await get('/api/v1/levels/board',{headers:{Authorization:'Bearer test-person'}});assert.equal((await r.json()).all_time.me,null);
        await db.prepare('UPDATE users SET is_banned = 1 WHERE id = ?').run(user.id);
        assert.equal((await get('/api/v1/levels/people/levels_http')).status,404);
        r = await get('/api/v1/levels/batch?subjects='+subject);assert.deepEqual(await r.json(),{levels:{}});
        console.log('levels HTTP: public CORS/cache, private own rank, capability gate, duplicate 409, opt-out and banned exclusion passed');
    } finally { server.close(); }
    process.exit(0);
})().catch(e => { console.error(e);process.exit(1); });
