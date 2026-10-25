const {app,BrowserWindow,ipcMain,session,dialog,Menu,clipboard,shell}=require('electron');
require('./stealth').install();
const path=require('node:path');
const {Tabs}=require('./tabs');
const {startAgentAPI,createDispatcher}=require('./agent-api');
let agentAPI,agentError=null,metricsService,collectors,jobs,exploration,loginHealth,loginScan,appeal,appealWeb,backfill,invoice;
const {createMetricsService}=require('./metrics-service');
function agentStatus(){return agentAPI?.getStatus()||{ready:false,error:agentError,history:[],callCount:0,lastMcpAt:null}}
function emitAgent(){if(manager&&!manager.isDestroyed())manager.webContents.send('agent-status',agentStatus())}
const {Store,valid}=require('./store');
const {randomUUID}=require('node:crypto');
const {platforms,watchLogin}=require('./login');
const pending=new Map();
function loginEvent(data){if(manager&&!manager.isDestroyed()){const target=manager.webContents;const send=()=>{if(!target.isDestroyed())target.send('login-status',data)};if(target.isLoadingMainFrame())target.once('did-finish-load',send);else send()}}
let manager,store,tabs;const windows=new Map();
if(process.env.SHOPDESK_TEST_DATA)app.setPath('userData',process.env.SHOPDESK_TEST_DATA);
const secure={nodeIntegration:false,contextIsolation:true,sandbox:true};
function emit(){if(manager&&!manager.isDestroyed())manager.webContents.send('changed')}
function guard(w){
 w.webContents.on('will-navigate',(e,url)=>{if(!url.startsWith('https://'))e.preventDefault()});
 w.webContents.on('will-redirect',(e,url)=>{if(!url.startsWith('https://'))e.preventDefault()});
}
async function runCollector(key){const j=jobs.start(key);for(;;){const state=jobs.get(j.id);if(state.status!=='running'){if(state.status!=='done')throw Error(state.error||'查询未完成');return state.result}await new Promise(r=>setTimeout(r,200))}}
function syncExperience(){return runCollector('builtin:experience')}
function syncShippedRefunds(){return runCollector('builtin:shipped_refunds')}
function openShop(id){
 const s=store.get(id);let w=windows.get(id);
 if(w&&!w.isDestroyed()){w.show();w.focus();return}
 const ses=session.fromPartition('persist:shop-'+id);
 ses.setPermissionRequestHandler((_wc,_permission,cb)=>cb(false));
 ses.setPermissionCheckHandler(()=>false);
 w=tabs.create({title:s.name,session:ses,canSleep:true});
 windows.set(id,w);function attachShop(){guard(w);loginHealth.watch(s,w);
 w.webContents.on('page-title-updated',e=>{e.preventDefault();w.setTitle(s.name)});
 function configurePopup(parent){tabs.popup(parent,child=>{guard(child);configurePopup(child);w.once('closed',()=>{if(!child.isDestroyed())child.destroy()})})}
 configurePopup(w);}
 attachShop();w.on('resumed',attachShop);
 w.on('closed',()=>{windows.delete(id);ses.flushStorageData();ses.cookies.flushStore().catch(()=>{});emit()});
 w.webContents.on('did-fail-load',(_e,code,description,_url,main)=>{if(main&&code!==-3)dialog.showMessageBox(manager,{type:'warning',message:'店铺页面加载失败',detail:description+'\n请检查网络，或编辑店铺后台网址后重新打开。'})});
 w.loadURL(s.url).catch(()=>{});s.lastOpened=Date.now();store.save();emit();
}
function reloginShop(id){
 const shop=store.get(id);openShop(id);const w=windows.get(id);
 const homes={'抖店':'https://fxg.jinritemai.com/ffa/mshop/homepage/index','拼多多':'https://mms.pinduoduo.com/home/'};
 if(require('./login-health').pageIssue(w.webContents.getURL())!=='needs_verification')w.loadURL(homes[shop.platform]||shop.url).catch(()=>{});
}
async function flygeProbe(shopId,url,expression){
 const shop=store.get(shopId);const u=new URL(String(url));
 if(u.protocol!=='https:'||!['im.jinritemai.com','fxg.jinritemai.com','pigeon.jinritemai.com'].includes(u.hostname))throw Error('仅支持抖店官方页面');
 const ses=session.fromPartition('persist:shop-'+shopId);
 const w=new BrowserWindow({show:false,width:1120,height:820,webPreferences:{...secure,session:ses}});guard(w);
 const wc=w.webContents;let info={};
 try{await wc.loadURL(u.href).catch(()=>{});await new Promise(r=>setTimeout(r,6000));
  info=await wc.executeJavaScript(expression?String(expression):'({url:location.href,title:document.title,text:(document.body?document.body.innerText:"").replace(/\\s+/g," ").slice(0,1500)})').catch(e=>({error:String((e&&e.message)||e)}));
 }finally{if(!w.isDestroyed())w.destroy();}
 return info;
}
async function flygeCheck(key,shopId){
 const fs=require('node:fs');
 const snap=jobs.snapshot();
 const job=(snap.jobs||[]).find(j=>j.key===key&&j.status==='done'&&j.result);
 if(!job)throw Error('请先完成该查询，再核查飞鸽');
 const groups=new Map();
 for(const shop of job.result.results||[])for(const c of shop.candidates||[])if(c.flyge_url&&c.order_id&&(!shopId||shop.shop_id===shopId)){if(!groups.has(shop.shop_id))groups.set(shop.shop_id,{shop_id:shop.shop_id,shop_name:shop.name,items:[]});groups.get(shop.shop_id).items.push({order_id:c.order_id,url:c.flyge_url,shop_id:shop.shop_id,shop_name:shop.name})}
 const shopList=[...groups.values()];const total=shopList.reduce((n,g)=>n+g.items.length,0);
 if(!total)throw Error('当前工单没有可核查的飞鸽会话');
 const outDir=path.join(app.getPath('userData'),'business-data','appeal-pack');
 const safe=s=>String(s||'').replace(/[\\/:*?"<>|\s]/g,'_');
 const annotations={};let done=0;
 const extract='(()=>{const wraps=[...document.querySelectorAll(".msgItemWrap")];const msgs=wraps.map(w=>({buyer:!!w.querySelector(".messageNotMe"),txt:(w.innerText||"").replace(/\\s+/g," ").trim().slice(0,200)}));const buyer=msgs.filter(m=>m.buyer);return {ready:wraps.length>0,total:msgs.length,buyerCount:buyer.length,buyerMsgs:buyer.map(m=>m.txt).slice(0,20),excerpt:msgs.map(m=>(m.buyer?"【买家】":"【商家】")+m.txt).join(" | ").slice(0,1200)}})()';
 const one=async(it)=>{
  const ses=session.fromPartition('persist:shop-'+it.shop_id);
  const w=new BrowserWindow({show:false,width:1120,height:880,webPreferences:{...secure,session:ses,backgroundThrottling:false}});guard(w);
  const wc=w.webContents;const at=new Date().toISOString();
  try{
   await wc.loadURL(it.url).catch(()=>{});
   let info=null;
   for(let i=0;i<12;i++){await new Promise(r=>setTimeout(r,1500));const cur=await wc.executeJavaScript(extract).catch(()=>null);if(cur&&cur.ready){info=cur;if(cur.buyerCount>0)break}}
   if(!info)info={ready:false,total:0,buyerCount:0,buyerMsgs:[],excerpt:''};
   let shot='';
   try{const img=await wc.capturePage();const dir=path.join(outDir,safe(it.shop_name),safe(it.order_id));fs.mkdirSync(dir,{recursive:true});shot=path.join(dir,'飞鸽会话.png');fs.writeFileSync(shot,img.toPNG())}catch{}
   return {flyge_checked:true,flyge_at:at,flyge_ready:!!info.ready,flyge_has_chat:(info.buyerCount||0)>0,flyge_buyer_count:info.buyerCount||0,flyge_shot:shot,flyge_excerpt:info.excerpt||''};
  }catch(e){return {flyge_checked:true,flyge_at:at,flyge_error:String((e&&e.message)||e)}}
  finally{if(!w.isDestroyed())w.destroy()}
 };
 const runShop=async(g)=>{for(const it of g.items){annotations[it.order_id]=await one(it);done++;if(manager&&!manager.isDestroyed())manager.webContents.send('flyge-progress',{done,total,key})}};
 let c=0;const worker=async()=>{while(c<shopList.length){const g=shopList[c++];await runShop(g)}};
 await Promise.all(Array.from({length:Math.min(3,shopList.length)},worker));
 jobs.annotate(key,annotations);
 return {checked:total,dir:outDir};
}
async function appealWorklist(key,shopId){
 const snap=jobs.snapshot();
 const job=(snap.jobs||[]).find(j=>j.key===key&&j.status==='done'&&j.result);
 if(!job)throw Error('请先完成该查询，再生成工单');
 const items=[];
 for(const shop of job.result.results||[]){
  if(shopId&&shop.shop_id!==shopId)continue;
  for(const c of shop.candidates||[])items.push({shop_id:shop.shop_id,shop:shop.name,...c});
 }
 return {key,title:job.title,total:job.result.total_candidates||items.length,file:job.result.worklist_file||'',worklist_dir:path.join(app.getPath('userData'),'business-data','appeal-pack'),items};
}
function beginLogin(data){
 const rule=platforms[data.platform];if(!rule)throw Error('请选择支持的平台');
 const fields=valid({...data,name:data.platform+' · 等待扫码',url:rule.url});
 const id=randomUUID(),ses=session.fromPartition('persist:shop-'+id);
 ses.setPermissionRequestHandler((_wc,_p,cb)=>cb(false));ses.setPermissionCheckHandler(()=>false);
 const root=tabs.create({title:fields.platform+' · 扫码添加',session:ses});
 const children=new Set([root]);let completed=false,saving=false,stop=()=>{};
 pending.set(id,{root,name:fields.name});
 const attach=w=>{guard(w);tabs.popup(w,child=>{children.add(child);attach(child);child.on('closed',()=>children.delete(child))})};attach(root);
 const notify=(state,message)=>loginEvent({id,name:fields.name,state,message});
 const save=async identity=>{
  fields.name=identity.name;
  if(root.isDestroyed())return;saving=true;
  try{ses.flushStorageData();await ses.cookies.flushStore();
   if(root.isDestroyed())return;
   const record={...fields,id,favorite:false,createdAt:Date.now(),lastOpened:null,loginSavedAt:Date.now()};
   store.items.push(record);try{store.save()}catch(e){store.items=store.items.filter(x=>x.id!==id);throw e}
   completed=true;pending.delete(id);stop();
   for(const w of children)if(!w.isDestroyed())w.destroy();
   emit();if(!manager||manager.isDestroyed())createManager();else{manager.show();manager.focus()}
   notify('saved','保存成功');
  }finally{saving=false}
 };
 let lastProgress='';
 function monitor(){stop=watchLogin({platform:fields.platform,windows:()=>[...children],ses,onSuccess:save,onProgress:state=>{if(lastProgress===state)return;lastProgress=state;const message=state==='reading-info'?'登录已识别，正在自动打开店铺信息页读取名称':state==='name-unavailable'?'登录状态已保留，暂未识别到唯一完整的店铺名称；请在店铺信息页检查后刷新重试':'登录已识别，正在读取店铺名称';const p=pending.get(id);if(p)p.message=message;root.setTitle(fields.platform+' · 正在读取店铺名称');notify('name-pending',message)},onError:async e=>{notify('error','登录已识别，但保存失败：'+e.message);if(!root.isDestroyed()){const {response}=await dialog.showMessageBox(manager,{type:'error',message:'保存失败',detail:e.message,buttons:['重试保存','暂不保存'],defaultId:0,cancelId:1});if(response===0&&!root.isDestroyed())monitor()}}})}monitor();
 root.on('close',e=>{if(saving&&!completed)e.preventDefault()});
 root.on('closed',()=>{stop();pending.delete(id);for(const w of children)if(!w.isDestroyed())w.destroy();if(!completed){ses.clearStorageData().then(()=>ses.clearCache()).catch(()=>{});notify('cancelled','已取消添加，未保存店铺')}});
 root.webContents.on('did-fail-load',(_e,code,description,_url,main)=>{if(main&&code!==-3&&!root.isDestroyed()){notify('error','登录页面加载失败，请检查网络后重试');dialog.showMessageBox(manager,{type:'warning',message:'登录页面加载失败',detail:description,buttons:['重新加载','关闭'],defaultId:0,cancelId:1}).then(({response})=>{if(!root.isDestroyed()){if(response===0)root.reload();else root.close()}})}});
 root.loadURL(rule.url).catch(()=>{});return {id,name:fields.name};
}
function createManager(){manager=new BrowserWindow({width:1220,height:820,minWidth:940,minHeight:620,title:'店铺工作台',icon:path.join(__dirname,'assets','app-icon.png'),backgroundColor:'#f5f6fa',webPreferences:{...secure,preload:path.join(__dirname,'preload.js')}});tabs=new Tabs(manager);manager.on('closed',()=>metricsService?.close());manager.loadFile(path.join(__dirname,'index.html'));manager.webContents.on('did-finish-load',()=>tabs.publish());manager.webContents.setWindowOpenHandler(()=>({action:'deny'}));manager.webContents.on('will-navigate',e=>e.preventDefault())}
if(!app.requestSingleInstanceLock()){app.quit()}else{
 app.on('second-instance',()=>{if(manager&&!manager.isDestroyed()){manager.show();manager.focus()}});
 app.whenReady().then(()=>{
 if(process.platform==='darwin')app.dock?.setIcon(path.join(__dirname,'assets','app-icon.png'));
 try{store=new Store(path.join(app.getPath('userData'),'shops.json'))}catch(e){dialog.showErrorBox('无法读取店铺数据','为避免覆盖已有数据，应用已停止。\n'+e.message);app.quit();return}
 Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'店铺工作台',submenu:[{role:'about'},{role:'quit'}]},{label:'编辑',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},{label:'窗口',submenu:[{label:'刷新当前页面',accelerator:'CmdOrCtrl+R',click:()=>tabs.active==='home'?manager.webContents.reload():tabs.action('reload')},{label:'关闭当前标签',accelerator:'CmdOrCtrl+W',click:()=>tabs.active==='home'?manager.close():tabs.action('close',tabs.active)},{role:'minimize'},{role:'close'}]}]));
 loginHealth=require('./login-health').createLoginHealth({store,onChange:emit,onStatus:(id,status)=>{if(status==='authenticated')loginScan?.clear(id)}});
 loginScan=require('./login-scan').createLoginScan({store,loginHealth,onChange:data=>{if(manager&&!manager.isDestroyed())manager.webContents.send('login-scan',data)}});
 metricsService=createMetricsService({loginHealth,file:path.join(app.getPath('userData'),'metrics.json'),store,onChange:data=>{if(manager&&!manager.isDestroyed())manager.webContents.send('metrics-updated',data)}});
 collectors=require('./collectors').createCollectors();
 jobs=require('./collector-jobs').createJobs({collectors,store,metrics:metricsService,loginHealth,onChange:data=>{if(manager&&!manager.isDestroyed())manager.webContents.send('collector-jobs',data)}});
 appeal=require('./appeal').createAppeal({store,jobs,app});
 backfill=require('./backfill').createBackfill({app,store});
 invoice=require('./invoice').createInvoice({store});
 appealWeb=require('./appeal-web').createAppealWeb({app,appeal});
 appealWeb.start().catch(()=>{});
 exploration=require('./exploration').createExploration({store});
 const handle=(name,fn)=>ipcMain.handle(name,async(e,...args)=>{if(!manager||e.sender!==manager.webContents||e.senderFrame!==manager.webContents.mainFrame)throw Error('未授权');return fn(...args)});
 handle('collectors-list',()=>jobs.list());handle('collector-start',key=>jobs.start(key));handle('collector-jobs',()=>jobs.snapshot());handle('collector-cancel',id=>jobs.cancel(id));
 handle('collectors-import',async()=>{const r=await dialog.showOpenDialog(manager,{title:'选择可信的采集模块文件夹',properties:['openDirectory']});if(r.canceled)return {cancelled:true};await collectors.install(r.filePaths[0]);return jobs.list()});
 handle('metrics-status',()=>metricsService.snapshot());handle('metrics-start',()=>metricsService.start());handle('metrics-cancel',()=>metricsService.cancel());
 handle('login-scan-status',()=>loginScan.snapshot());handle('login-scan-start',()=>loginScan.start());handle('login-scan-cancel',()=>loginScan.cancel());handle('login-scan-shop',id=>loginScan.scanOne(id));
 handle('export-skill',async()=>{const {canceled,filePath}=await dialog.showSaveDialog(manager,{title:'下载 Codex Skill',defaultPath:path.join(app.getPath('downloads'),'shopdesk-operator.zip'),filters:[{name:'Codex Skill 压缩包',extensions:['zip']}]});if(canceled||!filePath)return {cancelled:true};const source=app.isPackaged?path.join(process.resourcesPath,'skill-package','shopdesk-operator.zip'):path.join(__dirname,'..','skill-package','shopdesk-operator.zip');await require('node:fs/promises').copyFile(source,filePath);return {saved:true,path:filePath}});
 handle('agent-status',agentStatus);handle('agent-test',()=>{if(!agentAPI)throw Error('接口尚未启动');return agentAPI.test()});handle('agent-copy',text=>{if(typeof text!=='string'||text.length>2000)throw Error('无效内容');clipboard.writeText(text)});
 handle('tabs-list',()=>tabs.snapshot());handle('tabs-action',(action,id)=>tabs.action(action,id));
 handle('list',()=>store.items.map(s=>({...s,opened:windows.has(s.id)})));handle('appeal-start',opts=>appeal.run(opts||{}));handle('appeal-status',()=>appeal.snapshot());handle('appeal-sync-results',opts=>appeal.syncResults(opts||{}));handle('appeal-web-url',()=>({url:appealWeb.url()}));handle('open-appeal-web',()=>{shell.openExternal(appealWeb.url());return {opened:true}});handle('flyge-check',key=>flygeCheck(key));handle('open-flyge',(shopId,url)=>{const shop=store.get(shopId);const u=new URL(String(url));if(u.protocol!=='https:'||!['im.jinritemai.com','fxg.jinritemai.com'].includes(u.hostname))throw Error('仅支持打开抖店官方页面');const ses=session.fromPartition('persist:shop-'+shopId);const w=new BrowserWindow({width:1120,height:820,title:'飞鸽 · '+shop.name,webPreferences:{...secure,session:ses}});guard(w);w.loadURL(u.href).catch(()=>{});return {opened:true}});
 handle('save',data=>{if(!data.id)throw Error('请通过扫码流程添加店铺');store.upsert(data);emit()});handle('begin-login',beginLogin);handle('pending-logins',()=>[...pending].map(([id,p])=>({id,name:p.name,message:p.message})));handle('focus-login',id=>{const p=pending.get(id);if(p){p.root.show();p.root.focus()}});handle('open',openShop);handle('relogin',reloginShop);
 handle('favorite',id=>{const s=store.get(id);s.favorite=!s.favorite;store.save();emit()});
 handle('remove',async id=>{const s=store.get(id);const {response}=await dialog.showMessageBox(manager,{type:'warning',message:'删除所选店铺？',detail:'将关闭该店铺窗口并清除本机登录数据，此操作不可撤销。',buttons:['取消','删除店铺'],defaultId:0,cancelId:0});if(response!==1)return;const w=windows.get(id);if(w)w.destroy();const ses=session.fromPartition('persist:shop-'+id);await ses.clearStorageData();await ses.clearCache();store.items=store.items.filter(x=>x.id!==id);store.save();emit()});
 createManager();startAgentAPI({stateFile:path.join(app.getPath('userData'),'agent-bridge.json'),dispatch:createDispatcher({store,windows,openShop,metrics:metricsService,experience:syncExperience,refunds:syncShippedRefunds,jobs,collectors,exploration,flygeProbe,flygeCheck,appealWorklist,appeal,appealWeb,backfill,invoice,loginHealth,loginScan}),onStatus:emitAgent}).then(api=>{agentAPI=api;emitAgent()}).catch(e=>{agentError=e.message;emitAgent();dialog.showErrorBox('Codex 接口启动失败',e.message)});app.on('activate',()=>{if(!manager||manager.isDestroyed())createManager()});
 }).catch(e=>{dialog.showErrorBox('启动失败',e.message);app.quit()});
 app.on('will-quit',()=>{metricsService?.close();loginScan?.close();jobs?.close();exploration?.closeAll();require('./python-worker').cancel(null);agentAPI?.close()});
 app.on('window-all-closed',()=>app.quit());
}
