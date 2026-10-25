const {BrowserWindow,session}=require('electron');const fs=require('node:fs');const {parse,aggregate,DEFINITIONS}=require('./metrics');
const path=require('node:path');const python=require('./python-worker');const {day}=require('./metrics');
const os=require('node:os');const {parallelism,Readiness}=require('./metrics-performance');
const {pageIssue,loginError,errorIssue}=require('./login-health');
const HOMES={'抖店':'https://fxg.jinritemai.com/ffa/mshop/homepage/index','拼多多':'https://mms.pinduoduo.com/home/'};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function axText(nodes){const map=new Map(nodes.map(n=>[n.nodeId,n])),out=[];function walk(n){if(!n)return;if(!n.ignored&&n.role?.value==='StaticText')out.push(n.name?.value||'');for(const id of n.childIds||[])walk(map.get(id))}walk(nodes[0]);return out.join('\n')}
function createMetricsService({file,store,onChange,loginHealth}){
 let state={runId:null,results:{},running:false,completed:0,total:0,startedAt:null,finishedAt:null},cancelled=false;const collectors=new Set();
 try{const saved=JSON.parse(fs.readFileSync(file,'utf8'));if(saved.results)state={...state,...saved,running:false};for(const r of Object.values(state.results))if(r.status==='loading')Object.assign(r,{status:'error',error:'上次更新中断，请重试'});}catch{}
 const snapshot=()=>({...state,definitions:DEFINITIONS,summary:aggregate(state,store.items),shops:store.items.map(s=>({id:s.id,name:s.name,platform:s.platform,group:s.group}))});
 function publish(){onChange(snapshot())}
 function persist(){fs.writeFileSync(file+'.tmp',JSON.stringify(state),{mode:0o600});fs.renameSync(file+'.tmp',file)}
 async function collectCDP(shop){
  const url=HOMES[shop.platform];if(!url)throw Error('该平台尚未适配，不计入汇总');
  const w=new BrowserWindow({show:false,width:1440,height:1100,webPreferences:{session:session.fromPartition('persist:shop-'+shop.id),nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});collectors.add(w);
  const wc=w.webContents;wc.session.setPermissionRequestHandler((_wc,_p,cb)=>cb(false));wc.session.setPermissionCheckHandler(()=>false);wc.setWindowOpenHandler(()=>({action:'deny'}));wc.on('will-navigate',(e,to)=>{if(!to.startsWith('https://'))e.preventDefault()});
  let lastError='页面加载超时',deadline=Date.now()+40000,readiness=new Readiness(shop.platform);
  const d=wc.debugger;const timeout=setTimeout(()=>{if(!w.isDestroyed())w.destroy()},40000);
  d.on('message',(_e,method,p)=>readiness.event(method,p));
  try{
   await w.loadURL('about:blank');d.attach('1.3');
   await d.sendCommand('Network.enable');await d.sendCommand('Page.enable');await d.sendCommand('Page.navigate',{url});
   let signature='',stable=0,lastVersion=-1;const started=Date.now();
   while(Date.now()<deadline){
    if(cancelled)throw Error('已取消');await delay(400);if(w.isDestroyed())throw Error(cancelled?'已取消':'采集超时：'+lastError);
    try{
     const current=wc.getURL(),issue=pageIssue(current);if(issue)throw loginError(issue);
     const tree=await d.sendCommand('Accessibility.getFullAXTree');const text=axText(tree.nodes);if(new URL(current).hostname!==new URL(url).hostname)throw Error('页面跳转至其他页面，未能读取经营数据');
     const data=parse(shop.platform,text,shop.name);const sig=JSON.stringify(data.metrics);stable=sig===signature&&lastVersion===readiness.version?stable+1:0;signature=sig;lastVersion=readiness.version;
     if(stable>=3&&readiness.ready())return {...data,durationMs:Date.now()-started,capturedAt:new Date().toISOString(),sourceURL:new URL(current).origin+new URL(current).pathname};
    }catch(e){if(errorIssue(e))throw e;if(w.isDestroyed())throw Error(cancelled?'已取消':'采集超时：'+lastError);lastError=e.message;}
   }throw Error(lastError==='页面加载超时'?lastError:'未能完成稳定读取：'+lastError);
  }finally{clearTimeout(timeout);collectors.delete(w);if(!w.isDestroyed()){if(d.isAttached())d.detach();w.destroy()}}
 }
 async function collect(shop){
  if(shop.platform==='抖店'){
   try{
    const ses=session.fromPartition('persist:shop-'+shop.id);const cookies=await ses.cookies.get({url:'https://fxg.jinritemai.com/pc/api/home/homepage'});
    if(!cookies.length)throw loginError('needs_login');const began=Date.now();
    const data=await python.call({action:'fetch',cookies,userAgent:ses.getUserAgent(),name:shop.name});
    if(cancelled)throw Error('已取消');if(data.identity?.name!==shop.name)throw Error('店铺身份未通过校验');
    return {metrics:data.metrics,sourceLabels:data.source_labels,period:'平台实时',date:day(data.captured_at),capturedAt:data.captured_at,sourceURL:data.source_url,transport:'python_http',durationMs:Date.now()-began};
   }catch(e){
    if(cancelled)throw Error('已取消');
    const issue=errorIssue(e);
    // 直连接口说得更具体的原因（数据被平台脱敏、店铺改名等）要保留下来，
    // 否则会被 CDP 回退的"采集超时"盖掉，看日志会误以为只是加载慢。
    const pyReason=String(e?.message||'');
    const pySpecific=/平台已隐藏|与平台不一致|已改名/.test(pyReason);
    // 直连接口（python requests）报「未登录」不足以判定掉线：会话轮换/风控/限流都会让
    // code=10008 误命中，历史上出现过一次 40 家里 39 家同时「登录已失效」的假警报。
    // 所以只要直连判登录类错误，一律再用 CDP 真页面复核一次，页面确实停在登录/验证页才算数。
    try{
     const result=await collectCDP(shop);
     return {...result,transport:'cdp',fallback:true,verifyFailed:!!issue};
    }catch(inner){
     if(cancelled)throw Error('已取消');
     const verified=errorIssue(inner);
     if(verified)throw loginError(verified);          // 真页面也确认掉线 → 采信
     if(issue)throw Error('登录状态未能确认（接口报'+loginError(issue).message+'，但页面未取到登录页），未计入汇总');
     if(pySpecific)throw Error(pyReason);             // 直连已给出明确原因，优先上报它
     throw inner;                                     // 与页面无关的失败，照原样上报
    }
   }
  }
  return {...await collectCDP(shop),transport:'cdp'};
 }
 async function saveDatabase(shop){
  const r=state.results[shop.id];try{await python.call({action:'record',dataDir:path.join(path.dirname(file),'business-data'),record:{runId:state.runId,id:shop.id,name:shop.name,platform:shop.platform,status:r.status,data:r.status==='ok'?r.data:null,error:r.error||null}},{timeout:15000});}
  catch{state.databaseError='SQLite 写入失败，结果已保存在工作台本地缓存';}
 }

 async function start(){
  if(state.running)return snapshot();cancelled=false;const shops=store.items.map(s=>({...s}));state={...state,runId:Date.now().toString(),running:true,cancelled:false,error:null,databaseError:null,completed:0,total:shops.length,concurrency:Math.min(shops.length,parallelism(os.totalmem(),os.availableParallelism())),startedAt:new Date().toISOString(),finishedAt:null};persist();publish();
  let cursor=0;const duplicates=new Set();const ids=shops.map(s=>{const key=s.platform+'\0'+s.name;const dup=duplicates.has(key);duplicates.add(key);return {...s,duplicate:dup}});
  async function worker(){while(cursor<ids.length&&!cancelled){const shop=ids[cursor++],observedAt=Date.now();state.results[shop.id]={...state.results[shop.id],status:'loading',runId:state.runId,error:null,errorCode:null};publish();try{if(shop.duplicate)throw Error('同平台同名店铺重复，避免重复累计');if(!store.items.some(s=>s.id===shop.id))throw Error('店铺已删除');const data=await collect(shop);state.results[shop.id]={status:'ok',runId:state.runId,data,attemptedAt:new Date().toISOString()};loginHealth?.record(shop.id,'authenticated',observedAt);}catch(e){const issue=errorIssue(e);state.results[shop.id]={...state.results[shop.id],status:'error',error:issue?loginError(issue).message:e.message,errorCode:issue?loginError(issue).code:null,attemptedAt:new Date().toISOString()};if(issue)loginHealth?.record(shop.id,issue,observedAt)}await saveDatabase(shop);state.completed++;persist();publish();}}
  Promise.all(Array.from({length:state.concurrency},()=>worker())).catch(e=>{state.error=e.message}).finally(()=>{state.running=false;state.finishedAt=new Date().toISOString();state.durationMs=Date.now()-new Date(state.startedAt).getTime();state.cancelled=cancelled;persist();publish()});return snapshot();
 }
 return {snapshot,start,cancel(){cancelled=true;python.cancel();for(const w of collectors)if(!w.isDestroyed())w.destroy();publish()},close(){cancelled=true;python.cancel();for(const w of collectors)if(!w.isDestroyed())w.destroy()}};
}
module.exports={createMetricsService,axText};
