const Database=require('better-sqlite3');const express=require('express');const assert=require('assert');
const db=new Database(':memory:');db.exec("CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT);CREATE TABLE audit_log(id INTEGER PRIMARY KEY, user_id INT, action TEXT, details TEXT, ip TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);INSERT INTO users VALUES(1,'alex'),(2,'mod')");
process.env.OWNER_USERNAME=process.env.OWNER_USERNAME||'alex';
const {createDomainRoutes}=require('../server/domains/routes');
const {ownerName}=require('../server/auth/owner-guard');
const owner=ownerName();
const auth=(req,res,next)=>{const w=req.headers['x-as'];if(!w)return res.status(401).json({error:'auth'});req.user=w==='owner'?{id:1,username:owner,role:'admin'}:{id:2,username:'mod',role:'admin'};next();};
const cat={getCatalog:async()=>({source:'live',catalog:{tools:[{id:'yt',hosts:{canonical:'youtube-downloader.openvibe.tools',short:'yt.openvibe.tools',aliases:[]}}],families:[]}})};
const r=createDomainRoutes(db,auth,{catalog:cat,checkDomain:async()=>({ok:true})});
const app=express();app.use(express.json());app.use('/api/domains',r.publicRouter);app.use('/api/admin/domains',r.adminRouter);
const s=app.listen(0,async()=>{const b='http://127.0.0.1:'+s.address().port;const j=async(m,p,as,body)=>{const x=await fetch(b+p,{method:m,headers:{'content-type':'application/json',...(as?{'x-as':as}:{})},body:body?JSON.stringify(body):undefined});return{s:x.status,j:await x.json().catch(()=>null)}};
let x=await j('GET','/api/admin/domains');assert.equal(x.s,401);
x=await j('GET','/api/admin/domains','admin');assert.equal(x.s,403,'admin non-owner refused');
x=await j('POST','/api/admin/domains','admin',{tool_id:'yt',host:'evil.com',role:'canonical'});assert.equal(x.s,403);
x=await j('POST','/api/admin/domains','owner',{tool_id:'yt',host:'YoutubeDownloadOnline.com',role:'canonical'});assert.equal(x.s<300,true,JSON.stringify(x.j));
x=await j('POST','/api/admin/domains','owner',{tool_id:'yt',host:'other.com',role:'canonical'});assert.ok(x.s<300);
x=await j('POST','/api/admin/domains','owner',{tool_id:'nope',host:'a.com',role:'alias'});assert.equal(x.s,400);
x=await j('POST','/api/admin/domains','owner',{tool_id:'yt',host:'bad host/../',role:'alias'});assert.equal(x.s,400);
x=await j('POST','/api/admin/domains','owner',{tool_id:'yt',host:'youtubedownloader.openvibe.tools',role:'mirror'});assert.ok(x.s<300,'mirror role accepted: '+JSON.stringify(x.j));
x=await j('POST','/api/admin/domains','owner',{tool_id:'yt',host:'ytmirror.example.com',role:'mirror'});assert.ok(x.s<300,'a tool may have several mirrors');
x=await j('GET','/api/domains');console.log(x.s,JSON.stringify(x.j.domains));
assert.equal(x.j.domains.filter(d=>d.role==='canonical').length,1);
assert.equal(x.j.domains.filter(d=>d.role==='mirror').length,2);
// an old table (CHECK without 'mirror') is rebuilt in place, rows kept
{const D=require('better-sqlite3');const old=new D(':memory:');old.exec("CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT);CREATE TABLE audit_log(id INTEGER PRIMARY KEY,user_id INT,action TEXT,details TEXT,ip TEXT);CREATE TABLE tool_domains (id INTEGER PRIMARY KEY AUTOINCREMENT, tool_id TEXT NOT NULL, host TEXT NOT NULL UNIQUE, role TEXT NOT NULL DEFAULT 'alias' CHECK (role IN ('canonical', 'short', 'alias')), enabled INTEGER NOT NULL DEFAULT 1, note TEXT, created_by INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);INSERT INTO tool_domains (tool_id,host,role) VALUES ('yt','keep.example.com','alias')");require('../server/domains/routes').ensureSchema(old);old.prepare("INSERT INTO tool_domains (tool_id,host,role) VALUES ('yt','m.example.com','mirror')").run();assert.equal(old.prepare('SELECT COUNT(*) c FROM tool_domains').get().c,2,'rows survive the rebuild');}
console.log('audit rows',db.prepare('select count(*) c from audit_log').get().c);console.log('domains: all checks passed');s.close();});
