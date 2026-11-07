// Local visual and submission-contract proof with synthetic API responses; see docs/admin-clarity-review.md.
// Local visual and submission-contract proof with synthetic API responses; see docs/admin-clarity-review.md.
// Playwright and Chrome come from the local workstation; override ADMIN_PROOF_PLAYWRIGHT to point elsewhere.
const playwright=process.env.ADMIN_PROOF_PLAYWRIGHT || '/home/workstation/openvibe/work/OpenVibe.Games/node_modules/playwright';
const {chromium}=require(playwright);
const fs=require('fs');const path=require('path');
const root=path.resolve(__dirname, '..');
const base=process.env.ADMIN_PROOF_URL || 'http://127.0.0.1:4897';
const baseline=process.env.ADMIN_PROOF_BASELINE || '/tmp/admin-clarity-before-public';
const out=process.env.ADMIN_PROOF_OUT || path.join(root, '..', 'shots', 'admin-clarity');fs.mkdirSync(out,{recursive:true});
const phase=process.argv[2]||'after';
const onlyChecks=process.env.ADMIN_PROOF_CHECKS === '1';
const settings=[['payments_enabled','false','boolean'],['bucks_per_usd','100','number'],['bucks_min_purchase_bucks','100','number'],['sub_price_usd','4.99','number'],['sub_streamer_share_pct','70','number'],['sub_site_route_fee_pct','10','number'],['stripe_enabled','false','boolean'],['paypal_enabled','false','boolean'],['ccbill_enabled','false','boolean'],['crypto_enabled','false','boolean'],['site_name','OpenVibe.Live','string'],['chat_slowmode_seconds','0','number'],['max_vod_size_mb','5120','number'],['ai_viewers_default_settings_json','{"enabled":false,"maxViewers":3}','json']].map(([key,value,type])=>({key,value,type,description:'Setting published by Live.'}));
const fixtures={
'/api/auth/me':{user:{id:'demo-owner',username:'design-review',display_name:'Design review',role:'admin',is_owner:true}},
'/api/admin/health':{health:{users:124,active_sessions:18,uptime:12600,memory:{heapUsed:123000000,heapTotal:240000000,rss:350000000},ses_enabled:false}},
'/api/admin/streamer/stats':{stats:{streams:{live:2,total:24}}},
'/api/admin/settings':{settings:Object.fromEntries([['registration_open','true','boolean'],['platform_name','OpenVibe','string'],['notification_max_age_days','90','number'],['email_enabled','false','boolean']].map(([key,value,type])=>[key,{value,type}]))},
'/api/admin/streamer/settings':{settings},
'/api/admin/discord':{settings:{discord_dedupe_minutes:'15'},status:{connected:false},sources:{discord_bot_token:{env:'DISCORD_BOT_TOKEN'},discord_oauth_client_secret:{env:'DISCORD_OAUTH_CLIENT_SECRET'}}},
'/api/admin/users':{users:[{id:'demo-1',username:'alex',display_name:'Alex Example',email:'alex@example.com',role:'user',created_at:'2026-11-01',last_seen:'2026-11-07',is_banned:false}],total:1},
'/api/admin/streamer/streams':{streams:[{id:'demo-stream',username:'alex',title:'An example community broadcast',protocol:'webrtc',viewer_count:12,started_at:'2026-11-07'}]},
'/api/admin/streamer/moderators':{moderators:[]},
'/api/admin/streamer-pastes/admin/stats':{stats:{}},'/api/admin/streamer-pastes/config':{config:{maxSizeKb:512,maxPerUserPerDay:50}},
'/api/admin/streamer/storage':{disk:{total:10000000000,used:4000000000,available:6000000000},dataTotal:{bytes:3000000000,files:24},breakdown:[{name:'recordings',bytes:3000000000,files:24}]},
'/api/admin/streamer/storage/vods':{vods:[],total:0},
'/api/admin/email':{email:{enabled:false,from_email:'noreply@example.com',from_name:'OpenVibe'},metrics:{}},
'/api/admin/deploy/prerequisites':{ok:true,prerequisites:{certbotInstalled:true,nginxInstalled:true},config:{certMode:'manual',nginxMode:'preview',domainsConfigured:1}},
'/api/admin/deploy/config':{ok:true,config:{certMode:'manual',nginxMode:'preview',nginxSitesPath:'/etc/nginx/sites-enabled'}},
'/api/admin/deploy/certs':{ok:true,certs:[]},'/api/admin/deploy/domains':{ok:true,domains:[]},
'/api/admin/analytics/overview':{overview:{totals:{total_pageviews:1200,total_api_calls:400,total_unique_visitors:90,total_errors:4,avg_response_ms:120},services:[],dailyTrend:[]}},
'/api/admin/analytics/insights':{insights:{generated_at:'2026-11-07T04:00:00Z',users:{new_1d:4,new_7d:18,total:124},totals:{requests:1600,server_errors:4},services:[],top_routes:[]}},
'/api/admin/domains':{domains:[]},'/api/admin/domains/catalog':{source:'live',families:[{id:'tools',name:'Tools'}],tools:[]},
'/api/admin/events/deliveries':{deliveries:[],counts:{dead:0,failed:0,pending:0}},
'/api/admin/url-registry':{entries:[{key:'OV_LIVE_URL',label:'Live public address',type:'string',value:'https://openvibe.live',source:'default'}]},
};
const panels=[['dashboard'],['users'],['streams'],['moderators'],['settings'],['settings','discord'],['settings','streamer'],['settings','urls'],['payments'],['pastes'],['storage'],['notifications'],['email'],['deploy'],['deploy','config'],['deploy','certs'],['deploy','domains'],['analytics'],['grants'],['eventsops'],['domains']];
(async()=>{
 const b=await chromium.launch({executablePath:'/usr/bin/google-chrome',args:['--no-sandbox']});const results=[];
 for(const width of (onlyChecks ? [1280] : [390,1280]))for(const scheme of (onlyChecks ? ['dark'] : ['dark','light'])){
 const page=await b.newPage({viewport:{width,height:900},colorScheme:scheme,deviceScaleFactor:1,isMobile:width<700,hasTouch:width<700});const errors=[];const writes=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(({scheme})=>{localStorage.setItem('ov_token','local-design-fixture');localStorage.setItem('ov_theme',JSON.stringify({id:scheme,variables:scheme==='light'?{'--bg-primary':'#f7f8fc','--bg-secondary':'#eef1f6','--bg-card':'#ffffff','--bg-input':'#ffffff','--text-primary':'#202737','--text':'#202737','--text-secondary':'#455166','--text-muted':'#566176','--border':'#c9cfda','--accent-light':'#1759b0','--bg-elev':'#eef1f6'}:{'--bg-primary':'#0d0d14','--text-muted':'#a1a1b5'}}));},{scheme});
 await page.route('**/*',async route=>{
 const u=new URL(route.request().url());
 if(u.pathname.startsWith('/api/') && route.request().method() !== 'GET') writes.push({path:u.pathname,method:route.request().method(),body:route.request().postDataJSON()});
 if(u.pathname.startsWith('/api/'))return route.fulfill({json:fixtures[u.pathname]||{ok:true,entries:[],items:[],changes:[],grants:[],settings:[],voices:[]}});
 // Do not load production notifications or make remote requests during local review.
 if(u.hostname==='openvibe.live'||u.hostname==='openvibe.network')return route.fulfill({status:200,body:'',contentType:'application/javascript'});
 if(phase==='before'&&u.hostname==='127.0.0.1'){
 const rel=u.pathname.startsWith('/admin')?'admin.html':u.pathname.slice(1);const file=path.join(baseline,rel);
 if(fs.existsSync(file)&&fs.statSync(file).isFile())return route.fulfill({path:file});
 }
 return route.continue();});
 await page.goto(base+'/admin',{waitUntil:'networkidle'});
 for(const [tab,sub]of (onlyChecks ? [] : panels)){
 await page.evaluate(async({tab,sub})=>{showTab(tab);if(sub){if(tab==='settings')showSettingsSub(sub);if(tab==='deploy')showDeploySubTab(sub);}}, {tab,sub});
 await page.waitForTimeout(350);
 await page.evaluate(()=>window.scrollTo(0,0));
 const audit=await page.evaluate(()=>{
 const visible=e=>e.getAttribute('aria-hidden') !== 'true' && e.checkVisibility() && !!(e.offsetWidth||e.offsetHeight||e.getClientRects().length);
 const controls=[...document.querySelectorAll('.section.active button,.section.active input,.section.active select,.section.active textarea,.section.active summary')].filter(visible);
 return {docWidth:document.documentElement.scrollWidth,small:controls.filter(e=>{const r=e.getBoundingClientRect();return r.height<43.5||r.width<43.5}).map(e=>({id:e.id,label:e.getAttribute('aria-label')||e.textContent.slice(0,40),w:Math.round(e.getBoundingClientRect().width),h:Math.round(e.getBoundingClientRect().height)})),pageTextErrors:[...document.querySelectorAll('.section.active .muted')].filter(e=>/Error:|not defined|Cannot read/.test(e.textContent)).map(e=>e.textContent)};});
 const name=[phase,tab,sub,width,scheme].filter(Boolean).join('-');
 await page.screenshot({path:path.join(out,name+'.png'),fullPage:true});
 results.push({name,...audit});
 }
 if(onlyChecks){
 // All API traffic is fulfilled above. These interactions never write to the local or production database.
 await page.evaluate(async()=>{
   await loadToolsSettings(); document.getElementById('ts-notification_max_age_days').value='30'; await saveToolsSettings();
   await loadPayments(); document.getElementById('pay-stripe_enabled').checked=true; await savePayments();
   await loadDiscordSettings(); document.querySelector('[data-key=discord_dedupe_minutes]').value='20'; await saveDiscordSettings();
   await loadStreamerSettings(); document.getElementById('ss-chat_slowmode_seconds').value='5'; await saveStreamerSettings();
   await loadUsers(); const select=document.querySelector('#users-content select'); select.value='global_mod'; select.dispatchEvent(new Event('change'));
 });
 await page.waitForTimeout(300);
 const beforeInvalid=writes.length;
 await page.evaluate(async()=>{await loadStreamerSettings();document.getElementById('ss-ai_viewers_default_settings_json').value='{invalid';await saveStreamerSettings();});
 if(writes.length!==beforeInvalid)throw new Error('Invalid JSON sent a write');
 const disclosed=await page.evaluate(()=>{const field=document.getElementById('ss-ai_viewers_default_settings_json');return [...(function*(e){for(;e;e=e.parentElement)if(e.tagName==='DETAILS')yield e;})(field)].every(e=>e.open);});
 if(!disclosed)throw new Error('Invalid JSON field remained inside a closed section');
 results.push({writes,invalidJsonBlocked:true,invalidJsonDisclosed:true});
 }
 results.push({width,scheme,errors});await page.close();
 }
 await b.close();fs.writeFileSync(path.join(out,phase+(onlyChecks ? '-requests' : '-audit')+'.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results.filter(r=>r.name && r.docWidth>Number(r.name.match(/-(390|1280)-/)[1])||r.small?.length||r.errors?.length||r.pageTextErrors?.length),null,2));
})().catch(e=>{console.error(e);process.exit(1)});
