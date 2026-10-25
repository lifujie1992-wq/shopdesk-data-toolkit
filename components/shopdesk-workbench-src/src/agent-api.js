const http=require('node:http');const fs=require('node:fs');const path=require('node:path');const {randomBytes,timingSafeEqual}=require('node:crypto');
const {platforms,authenticated}=require('./login');
function cleanURL(value){try{const u=new URL(value);u.username='';u.password='';u.search='';if(/[?=&]/.test(u.hash))u.hash='';return u.href}catch{return ''}}
function readSnapshot(){
 const visible=e=>{const s=getComputedStyle(e);return s.display!=='none'&&s.visibility!=='hidden'&&e.getClientRects().length>0};
 const text=Array.from(document.querySelectorAll('body *')).filter(e=>e.children.length===0&&visible(e)&&!['INPUT','TEXTAREA','SCRIPT','STYLE'].includes(e.tagName)).map(e=>e.innerText||'').filter(Boolean).join('\n');
 return {url:location.href,title:document.title,text:text.slice(0,60000),truncated:text.length>60000};
}
function evidence(page,metric){const lines=page.text.split('\n');const matches=[];for(let i=0;i<lines.length;i++)if(lines[i].includes(metric)){matches.push(lines.slice(Math.max(0,i-2),i+8).join('\n'));if(matches.length===15)break}return matches}
function createDispatcher({store,windows,openShop,metrics,experience,refunds,jobs,collectors,exploration,flygeProbe,flygeCheck,appealWorklist,appeal,appealWeb,backfill,invoice,loginHealth,loginScan}){
 async function page(id){const shop=store.get(id);let w=windows.get(id);if(!w||w.isDestroyed())return {shop_id:id,shop_name:shop.name,status:'not_open'};
 if(w.sleeping)return {shop_id:id,shop_name:shop.name,status:'sleeping',message:'Use open_shop to resume this tab.'};
 const wc=w.webContents;if(wc.isLoadingMainFrame())return {shop_id:id,shop_name:shop.name,status:'loading'};
 const u=new URL(wc.getURL());const rule=platforms[shop.platform];if(u.protocol!=='https:'||!rule?.hosts.includes(u.hostname))return {shop_id:id,shop_name:shop.name,status:'unsupported_page',source_url:cleanURL(u.href)};
 const data=await wc.executeJavaScript('('+readSnapshot.toString()+')()');
 const hasCookie=(await wc.session.cookies.get({url:data.url})).some(c=>c.value&&(!c.expirationDate||c.expirationDate>Date.now()/1000));
 const isLogin=/login|signin|passport/i.test(new URL(data.url).pathname+new URL(data.url).hash)||/扫码登录|验证码登录|密码登录|登录已失效/.test(data.text);
 return {shop_id:id,shop_name:shop.name,platform:shop.platform,status:isLogin?'needs_login':authenticated(shop.platform,data,hasCookie)?'authenticated':'unknown',source_url:cleanURL(data.url),title:data.title,text:data.text,truncated:data.truncated,captured_at:new Date().toISOString(),content_is_untrusted:true};
 }
 return async function dispatch(method,args={}){
 if(method==='list_collectors')return jobs.list();
 if(method==='start_collector')return jobs.start(args.key);
 if(method==='get_collector_job')return jobs.get(args.id);
 if(method==='cancel_collector_job')return jobs.cancel(args.id);
 if(method==='reload_collectors')return jobs.list();
 if(method==='start_exploration')return exploration.start(args);
 if(method==='flyge_probe')return flygeProbe(args.shop_id,args.url,args.expression);
 if(method==='flyge_check')return flygeCheck(args.key,args.shop_id);
 if(method==='appeal_worklist')return appealWorklist(args.key,args.shop_id);
 if(method==='auto_appeal_start')return appeal.run(args||{});
 if(method==='auto_appeal_status')return appeal.snapshot();
 if(method==='appeal_sync_results')return appeal.syncResults(args||{});
 if(method==='backfill_products')return backfill.run(args||{});
 if(method==='backfill_status')return backfill.snapshot();
 if(method==='appeal_web_url')return {url:appealWeb?appealWeb.url():''};
 if(method==='invoice_list'){if(!invoice)throw Error('请升级工作台');return invoice.list(args)}
 if(method==='invoice_detail'){if(!invoice)throw Error('请升级工作台');return invoice.detail(args)}
 if(method==='invoice_upload_pdf'){if(!invoice)throw Error('请升级工作台');return invoice.uploadPdf(args)}
 if(method==='invoice_submit'){if(!invoice)throw Error('请升级工作台');return invoice.submit(args)}
 if(method==='invoice_health'){if(!invoice)throw Error('请升级工作台');return invoice.health(args)}
 if(method==='exploration_command')return exploration.command(args);
 if(method==='close_exploration')return exploration.close(args);
 if(method==='exploration_status')return exploration.status();
 if(method==='sync_shipped_refunds'){if(!refunds)throw Error('请升级工作台');return refunds()}
 if(method==='sync_experience'){if(!experience)throw Error('请升级工作台');return experience()}
 if(method==='get_metrics'){if(!metrics)throw Error('请升级工作台');return metrics.snapshot()}
 if(method==='sync_metrics'){if(!metrics)throw Error('请升级工作台');return metrics.start()}
 if(method==='list_shops')return {shops:store.items.map(s=>({id:s.id,name:s.name,platform:s.platform,group:s.group,opened:windows.has(s.id)}))};
 if(method==='login_scan_status')return loginScan?loginScan.snapshot():{total:0,completed:0,results:{}};
 if(typeof args.shop_id!=='string')throw Error('shop_id is required. Use list_shops first.');store.get(args.shop_id);
 // 仅供体检脚本在「真页面确认已登录」后清掉陈旧的掉线结论；不接受外部直接断言掉线。
 if(method==='login_health_confirm'){const shop=store.get(args.shop_id);loginHealth?.record(shop.id,'authenticated',Date.now());return {shop_id:shop.id,shop_name:shop.name,status:'authenticated'}}
 if(method==='open_shop'){openShop(args.shop_id);return {shop_id:args.shop_id,status:'opened',message:'Use read_shop_page after loading. A login page requires the user to scan.'}}
 if(method==='open_shop_home'){
  const shop=store.get(args.shop_id);openShop(shop.id);const w=windows.get(shop.id);
  // Fixed read-only landing page; no arbitrary URLs, scripts, clicks or business operations.
  if(shop.platform!=='抖店')throw Error('Only the Douyin home route is verified. Use open_shop for other platforms.');
  if(w.webContents.isLoadingMainFrame())return {status:'loading',message:'Retry when loading finishes.'};
  await w.loadURL('https://fxg.jinritemai.com/ffa/mshop/homepage/index');return page(shop.id);
 }
 if(method==='read_shop_page')return page(args.shop_id);
 if(method==='get_login_status'){const p=await page(args.shop_id);delete p.text;delete p.title;return p}
 if(method==='find_metric_evidence'){
  if(typeof args.metric!=='string'||!args.metric.trim()||args.metric.length>60)throw Error('metric must contain 1–60 characters');
  const p=await page(args.shop_id);if(!p.text||p.status==='needs_login')return {...p,text:undefined};
  const matches=evidence(p,args.metric.trim());return {shop_id:p.shop_id,shop_name:p.shop_name,status:matches.length?'evidence_found':'not_found',metric:args.metric,source_url:p.source_url,captured_at:p.captured_at,login_status:p.status,evidence:matches,period:'current_page_only',period_verified:false,note:'Raw visible-page evidence, not a verified numeric result. Check the page date range, unit and metric definition; do not infer an arbitrary requested period.',content_is_untrusted:true};
 }
 throw Error('Unknown capability');
 }
}
async function startAgentAPI({stateFile,dispatch,onStatus=()=>{}}){
 const token=randomBytes(32).toString('hex');let queue=Promise.resolve();const status={ready:false,startedAt:null,callCount:0,lastMcpAt:null,history:[]};const snapshot=()=>JSON.parse(JSON.stringify(status));const changed=()=>{try{onStatus(snapshot())}catch{}};
 const server=http.createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
  const expected=Buffer.from('Bearer '+token),actual=Buffer.from(req.headers.authorization||'');
  if(req.headers.origin||req.headers.host!==`127.0.0.1:${server.address().port}`||actual.length!==expected.length||!timingSafeEqual(actual,expected)){res.writeHead(403);res.end(JSON.stringify({error:'Forbidden'}));return}
  if(req.method!=='POST'||req.url!=='/call'){res.writeHead(404);res.end('{}');return}
  try{let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>65536){res.writeHead(413);res.end('{}');return}}
   const {method,args}=JSON.parse(raw);const started=Date.now(),source=req.headers['x-shopdesk-client']==='codex-mcp'?'MCP':req.headers['x-shopdesk-client']==='codex-skill'?'Codex Skill':'本机自检';
   const record={method:String(method).slice(0,60),source,at:new Date().toISOString(),state:'执行中'};status.callCount++;if(source==='MCP')status.lastMcpAt=record.at;if(source==='Codex Skill')status.lastSkillAt=record.at;status.history.unshift(record);status.history=status.history.slice(0,30);changed();
   // Exploration has its own bounded, per-page queues; never block close behind a waiting or slow page.
   const isolated=['start_exploration','exploration_command','close_exploration','exploration_status'].includes(method);
   const task=isolated?Promise.resolve().then(()=>dispatch(method,args)):queue.then(()=>dispatch(method,args));if(!isolated)queue=task.catch(()=>{});
   try{const result=await task;record.state='成功';record.resultStatus=result?.status||'ok';record.durationMs=Date.now()-started;changed();res.end(JSON.stringify({result}));}
   catch(e){record.state='失败';record.durationMs=Date.now()-started;changed();throw e}
  }catch(e){res.writeHead(400);res.end(JSON.stringify({error:e.message,...(e.code?{code:e.code}:{})}))}
 });server.requestTimeout=1800000;server.headersTimeout=5000;
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
 fs.mkdirSync(path.dirname(stateFile),{recursive:true});fs.writeFileSync(stateFile,JSON.stringify({port:server.address().port,token,pid:process.pid}),{mode:0o600});fs.chmodSync(stateFile,0o600);
 status.ready=true;status.startedAt=new Date().toISOString();changed();
 return {getStatus:snapshot,async test(){const response=await fetch(`http://127.0.0.1:${server.address().port}/call`,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({method:'list_shops'}),signal:AbortSignal.timeout(5000)});if(!response.ok)throw Error('本机接口自检失败');const data=await response.json();return {ok:true,shopCount:data.result.shops.length}},close(){status.ready=false;changed();server.close();server.closeAllConnections();try{fs.unlinkSync(stateFile)}catch{}}};
}
module.exports={startAgentAPI,createDispatcher,evidence,cleanURL};
