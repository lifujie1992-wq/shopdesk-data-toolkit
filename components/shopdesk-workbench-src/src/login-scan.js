const {BrowserWindow,session}=require('electron');
const {diagnose,extractShopName,takeSnapshot}=require('./login');
const {pageIssue}=require('./login-health');
// Prefer the platform merchant home so a valid session is recognized even when
// the stored URL points at a deep login page. Fall back to the saved URL.
const HOMES={'抖店':'https://fxg.jinritemai.com/ffa/mshop/homepage/index','拼多多':'https://mms.pinduoduo.com/home/'};
const LABELS={checking:'检测中',authenticated:'登录正常',needs_login:'登录已失效',needs_verification:'需要平台验证',unknown:'未能确认',error:'检测失败',cancelled:'已取消'};
const UNCLEAR=['unknown','error'];
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function createLoginScan({store,loginHealth,onChange=()=>{},concurrency=2,loadTimeoutMs=45000,settleMs=15000,retrySettleMs=25000}){
 let state={running:false,total:0,completed:0,startedAt:null,finishedAt:null,durationMs:null,runId:null,cancelled:false,concurrency,retry:null,results:{}};
 const windows=new Set();let cancelled=false;
 const snapshot=()=>({...state,shops:store.items.map(s=>({id:s.id,name:s.name,platform:s.platform,group:s.group}))});
 function publish(){try{onChange(snapshot())}catch{}}
 function remember(id,status,observedAt){if(status==='authenticated'||status==='needs_login'||status==='needs_verification')loginHealth?.record(id,status,observedAt)}
 // 在隐藏窗口里观察店铺后台：优先判“已登录”，其次判登录页/验证页（连续两帧一致才下结论）。
 // rounds 给多轮时限时，除第一轮外每轮前会重新加载页面（用于单店复检）。
 async function probe(shop,{rounds,reload=false}={}){
  const limits=rounds&&rounds.length?rounds:[settleMs];
  const ses=session.fromPartition('persist:shop-'+shop.id);
  ses.setPermissionRequestHandler((_wc,_p,cb)=>cb(false));ses.setPermissionCheckHandler(()=>false);
  const w=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{session:ses,nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
  windows.add(w);const wc=w.webContents;
  wc.setWindowOpenHandler(()=>({action:'deny'}));
  wc.on('will-navigate',(e,url)=>{if(!url.startsWith('https://'))e.preventDefault()});
  const target=HOMES[shop.platform]||shop.url;
  const guard=setTimeout(()=>{if(!w.isDestroyed())w.destroy()},limits.reduce((a,b)=>a+b,0)+loadTimeoutMs);
  let lastSnapshot=null,lastDiagnose=null,usedRounds=0,retried=false;
  try{
   await wc.loadURL(target).catch(()=>{});
   for(let i=0;i<limits.length;i++){
    if(i>0||(reload&&i===0)){retried=true;await delay(600);await wc.loadURL(target).catch(()=>{})}
    usedRounds=i+1;
    const deadline=Date.now()+limits[i];let issueStreak=0,lastIssue=null;
    while(Date.now()<deadline){
     if(cancelled)throw Object.assign(Error('已取消'),{cancelled:true});
     if(w.isDestroyed())throw Error('检测窗口已关闭');
     if(wc.isLoadingMainFrame()){await delay(250);continue}
     let s;try{s=await wc.executeJavaScript('('+takeSnapshot.toString()+')()')}catch{await delay(300);continue}
     lastSnapshot=s;
     const issue=pageIssue(s.url,s.text);
     if(issue){
      issueStreak=issue===lastIssue?issueStreak+1:1;lastIssue=issue;
      if(issueStreak>=2)return {status:issue,detectedName:extractShopName(s)||'',url:s.url,reason:issue==='needs_verification'?'页面要求完成平台验证':'页面停留在登录页',rounds:usedRounds,retried};
      await delay(400);continue;
     }
     issueStreak=0;lastIssue=null;
     const cookies=await ses.cookies.get({url:s.url});
     const hasCookie=cookies.some(c=>c.value&&(!c.expirationDate||c.expirationDate>Date.now()/1000));
     const d=diagnose(shop.platform,s,hasCookie);lastDiagnose=d;
     if(d.ok)return {status:'authenticated',detectedName:d.shopName||'',url:s.url,reason:d.why,rounds:usedRounds,retried};
     await delay(400);
    }
    if(lastSnapshot){const issue=pageIssue(lastSnapshot.url,lastSnapshot.text);if(issue)return {status:issue,detectedName:extractShopName(lastSnapshot)||'',url:lastSnapshot.url,reason:'页面停留在登录页',rounds:usedRounds,retried}}
   }
   const d=lastDiagnose||{};
   const text=lastSnapshot?.text||'';
   const reason=!lastSnapshot?'页面在限定时间内没有返回内容（可能加载失败）':!text.trim()?'页面内容为空，通常是加载失败或网络异常':(d.why||'未能确认登录状态');
   return {status:'unknown',detectedName:lastSnapshot?(extractShopName(lastSnapshot)||''):'',url:w.isDestroyed()?'':wc.getURL(),reason,rounds:usedRounds,retried,diagnose:d&&{commerce:d.commerce,identity:d.identity,hasCookie:d.hasCookie,textLength:d.textLength,host:d.host}};
  }finally{clearTimeout(guard);windows.delete(w);if(!w.isDestroyed())w.destroy()}
 }
 async function runShop(shop,{count=true,rounds,reload}={}){
  const began=Date.now();
  try{
   const r=await probe(shop,{rounds,reload});
   state.results[shop.id]={status:r.status,message:LABELS[r.status],detectedName:r.detectedName,url:r.url,reason:r.reason,rounds:r.rounds,retried:!!r.retried,diagnose:r.diagnose,checkedAt:new Date().toISOString(),durationMs:Date.now()-began};
   remember(shop.id,r.status,began);
  }catch(e){
   const status=e?.cancelled?'cancelled':'error';
   state.results[shop.id]={status,message:e?.cancelled?LABELS.cancelled:(e.message||LABELS.error),reason:e?.cancelled?'检测已取消':(e.message||LABELS.error),detectedName:'',url:'',checkedAt:new Date().toISOString(),durationMs:Date.now()-began};
  }
  if(count)state.completed++;publish();
 }
 // 一批店铺按并发跑完；返回时 state.results 已写好
 async function pass(shops,{rounds,reload=false,count=true,label='',onDone=()=>{}}={}){
  if(!shops.length)return;
  let cursor=0;
  const worker=async()=>{while(cursor<shops.length&&!cancelled){
   const shop=shops[cursor++];
   state.results[shop.id]={status:'checking',message:label?label+'…':LABELS.checking,checkedAt:null,detectedName:'',url:''};publish();
   await runShop(shop,{count,rounds,reload});onDone();
  }};
  await Promise.all(Array.from({length:Math.min(state.concurrency,Math.max(shops.length,1))},worker));
 }
 async function start(){
  if(state.running)return snapshot();
  cancelled=false;const shops=store.items.map(s=>({...s}));
  state={running:true,total:shops.length,completed:0,startedAt:new Date().toISOString(),finishedAt:null,durationMs:null,runId:Date.now().toString(),cancelled:false,concurrency:Math.min(concurrency,Math.max(shops.length,1)),retry:null,results:{}};
  publish();
  const started=Date.now();
  await pass(shops,{rounds:[settleMs]});
  // 没得出结论的店（多为页面没加载完）自动进第二轮复检：此时机器空闲，给更长的观察窗
  if(!cancelled){
   const unclear=shops.filter(s=>UNCLEAR.includes(state.results[s.id]?.status));
   if(unclear.length){
    state.retry={total:unclear.length,completed:0};publish();
    await pass(unclear,{rounds:[retrySettleMs],count:false,label:'复检',onDone:()=>{state.retry.completed++;publish()}});
   }
  }
  state.running=false;state.cancelled=cancelled;state.finishedAt=new Date().toISOString();state.durationMs=Date.now()-started;publish();return snapshot();
 }
 // 单店复检：只重测一家，不必为一家店重扫全部
 async function scanOne(id){
  const shop=store.items.find(s=>s.id===id);if(!shop)throw Error('店铺不存在或已被删除');
  if(state.running)throw Error('正在批量检测，请等本轮结束或先点“停止检测”');
  if(!state.total||!state.startedAt){state.total=store.items.length||1;state.startedAt=new Date().toISOString()}
  state.results[id]={status:'checking',message:'复检…',checkedAt:null,detectedName:'',url:''};publish();
  try{await runShop(shop,{count:false,rounds:[settleMs,retrySettleMs],reload:true})}finally{if(!state.finishedAt)state.finishedAt=new Date().toISOString();publish()}
  return snapshot();
 }
 // 后台常驻监听确认已登录后，清掉该店陈旧的“未能确认”，避免旧结论盖住真实状态
 function clear(id){const r=state.results?.[id];if(r&&r.status!=='authenticated'){delete state.results[id];publish()}}
 function cancel(){cancelled=true;const at=new Date().toISOString();for(const s of store.items)if(!state.results[s.id])state.results[s.id]={status:'cancelled',message:LABELS.cancelled,checkedAt:at,detectedName:'',url:'',durationMs:0};for(const w of windows)if(!w.isDestroyed())w.destroy();publish();return snapshot()}
 function close(){cancelled=true;for(const w of windows)if(!w.isDestroyed())w.destroy();windows.clear()}
 return {snapshot,start,scanOne,clear,cancel,close};
}
module.exports={createLoginScan,LABELS};
