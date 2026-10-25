const {WebContentsView}=require('electron');
const {EventEmitter}=require('node:events');
const secure={nodeIntegration:false,contextIsolation:true,sandbox:true};
class Tab extends EventEmitter{
 constructor(owner,{title,session,webContents,canSleep=false}){super();this.owner=owner;this.title=title;this.canSleep=canSleep;this.session=session;this.sleeping=false;this.lastUsed=Date.now();this.view=new WebContentsView({...(webContents?{webContents}:{}),webPreferences:{...secure,session}});this.webContents=this.view.webContents;this.id=String(this.webContents.id);this.view.setVisible(false);owner.window.contentView.addChildView(this.view);owner.items.set(this.id,this);
 const mounted=this.webContents;this.webContents.once('destroyed',()=>{if(this.sleeping||this.webContents!==mounted)return;owner.window.contentView.removeChildView(this.view);owner.items.delete(this.id);this.emit('closed');if(owner.active===this.id)owner.select('home');else owner.publish()});
 this.webContents.on('close',()=>{if(!this.sleeping)this.close()});
 for(const event of ['did-navigate','did-navigate-in-page','did-start-loading','did-stop-loading'])this.webContents.on(event,()=>owner.publish());
 this.webContents.on('did-fail-load',(_e,code,message,_u,main)=>{if(main&&code!==-3){this.error=message;owner.publish()}});
 this.webContents.on('did-start-loading',()=>{this.error=''});
 this.webContents.on('will-navigate',(_e,url)=>{this.requestedURL=url});
 }
 suspend(){
  if(!this.canSleep||this.sleeping||this.owner.active===this.id||this.isDestroyed())return false;
  const url=this.webContents.isLoading()?this.requestedURL||this.webContents.getURL():this.webContents.getURL();if(!isSleepableURL(url))return false;
  this.savedURL=url;this.sleeping=true;this.session.flushStorageData();this.session.cookies.flushStore().catch(()=>{});
  this.owner.window.contentView.removeChildView(this.view);this.retire(this.webContents,false);this.owner.publish();return true;
 }
 retire(wc,waitForBeforeUnload){
  if(this.canSleep&&this.session.clearStorageData)wc.once('destroyed',()=>{
   const active=[...this.owner.items.values()].some(t=>!t.sleeping&&!t.webContents.isDestroyed()&&t.session===this.session);
   if(!active)this.session.clearStorageData({storages:['serviceworkers']}).catch(()=>{});
  });
  wc.close({waitForBeforeUnload});this.closing=false;
 }
 resume(){
  if(!this.sleeping)return;this.sleeping=false;
  this.view=new WebContentsView({webPreferences:{...secure,session:this.session}});this.webContents=this.view.webContents;this.owner.window.contentView.addChildView(this.view);
  const mounted=this.webContents;this.webContents.once('destroyed',()=>{if(this.sleeping||this.webContents!==mounted)return;this.owner.window.contentView.removeChildView(this.view);this.owner.items.delete(this.id);this.emit('closed');if(this.owner.active===this.id)this.owner.select('home');else this.owner.publish()});
  this.webContents.on('close',()=>{if(!this.sleeping)this.close()});
  for(const event of ['did-navigate','did-navigate-in-page','did-start-loading','did-stop-loading'])this.webContents.on(event,()=>this.owner.publish());
  this.webContents.on('will-navigate',(_e,url)=>{this.requestedURL=url});
  this.emit('resumed');this.loadURL(this.savedURL).catch(()=>{});
 }
 isDestroyed(){return !this.sleeping&&this.webContents.isDestroyed()}
 show(){this.owner.select(this.id)}
 focus(){if(!this.isDestroyed())this.webContents.focus()}
 setTitle(title){this.title=title;this.owner.publish()}
 loadURL(url){this.requestedURL=url;const result=this.webContents.loadURL(url);this.owner.trim();return result}
 reload(){this.webContents.reload()}
 close(){if(this.sleeping){this.owner.items.delete(this.id);this.emit('closed');this.owner.publish();return}let cancelled=false;this.emit('close',{preventDefault:()=>cancelled=true});if(!cancelled&&!this.isDestroyed()&&!this.closing){this.closing=true;this.retire(this.webContents,true)}}
 destroy(){if(this.sleeping){this.close();return}if(!this.isDestroyed())this.retire(this.webContents,false)}
}
class Tabs{
 constructor(window){this.window=window;this.items=new Map();this.active='home';this.timer=setInterval(()=>this.trim(),15000);this.timer.unref();window.once('closed',()=>clearInterval(this.timer));window.on('resize',()=>this.layout());window.on('close',()=>{for(const t of this.items.values())t.destroy()});}
 create(options){const t=new Tab(this,options);this.select(t.id);return t}
 layout(){const [width,height]=this.window.getContentSize();for(const t of this.items.values()){if(t.sleeping)continue;t.view.setBounds({x:0,y:96,width,height:Math.max(0,height-96)});t.view.setVisible(this.active===t.id)}}
 select(id){if(id!=='home'&&!this.items.has(String(id)))return;const previous=this.items.get(this.active);if(previous)previous.lastUsed=Date.now();this.active=String(id);const next=this.items.get(this.active);if(next){next.resume();next.lastUsed=Date.now()}this.trim();this.layout();this.publish();const t=this.items.get(this.active);if(t)t.focus();else this.window.webContents.focus()}
 trim(){let live=[...this.items.values()].filter(t=>!t.sleeping);for(const t of live.sort((a,b)=>a.lastUsed-b.lastUsed)){if(t.id===this.active)continue;if(live.length>3||Date.now()-t.lastUsed>120000){if(t.suspend())live=live.filter(x=>x!==t)}}}
 snapshot(){const t=this.items.get(this.active);const wc=t?.webContents;return {active:this.active,items:[...this.items.values()].map(t=>({id:t.id,title:t.title,sleeping:t.sleeping,loading:!t.sleeping&&t.webContents.isLoading()})),url:wc?.getURL()||'',error:t?.error||'',back:wc?.navigationHistory.canGoBack()||false,forward:wc?.navigationHistory.canGoForward()||false}}
 publish(){if(!this.window.isDestroyed()&&!this.window.webContents.isDestroyed())this.window.webContents.send('tabs-changed',this.snapshot())}
 action(action,id){if(action==='select')return this.select(id);if(action==='close')return this.items.get(String(id))?.close();const wc=this.items.get(this.active)?.webContents;if(!wc)return;if(action==='reload')wc.reload();if(action==='back'&&wc.navigationHistory.canGoBack())wc.navigationHistory.goBack();if(action==='forward'&&wc.navigationHistory.canGoForward())wc.navigationHistory.goForward()}
 popup(parent,onChild){parent.webContents.setWindowOpenHandler(details=>{if(!details.url.startsWith('https://')&&details.url!=='about:blank')return {action:'deny'};return {action:'allow',createWindow:options=>{const child=this.create({title:parent.title+' · 子页面',session:parent.webContents.session,webContents:options.webContents});onChild(child);if(details.disposition==='background-tab')child.loadURL(details.url).catch(()=>{});return child.webContents}}})}
}
function isSleepableURL(value){try{const u=new URL(value);return u.protocol==='https:'&&((u.hostname==='fxg.jinritemai.com'&&['/ffa/mshop/homepage/index','/ffa/eco/experience-score'].includes(u.pathname))||(u.hostname==='mms.pinduoduo.com'&&u.pathname==='/home/'))}catch{return false}}
module.exports={Tabs,isSleepableURL};
