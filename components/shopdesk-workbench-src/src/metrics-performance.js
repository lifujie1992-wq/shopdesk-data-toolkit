function parallelism(memoryBytes,cpuCount){return Math.max(1,Math.min(cpuCount,memoryBytes>=28*2**30?6:memoryBytes>=12*2**30?4:2))}
function isDataRequest(platform,url){
 let u;try{u=new URL(url)}catch{return false}
 if(platform==='抖店')return u.hostname==='fxg.jinritemai.com'&&(/^\/pc\/api\/home\/homepage$|^\/byteshop\/home\/strong_dep$|^\/compass_api\//).test(u.pathname);
 if(platform==='拼多多')return u.hostname==='mms.pinduoduo.com'&&!/\/heartbeat\/|\/msgBox\/|\/pv\/log\/|\/api\/server\/_stm$|\/api\/log\//.test(u.pathname);
 return true;
}
function isCoreRequest(platform,url){try{const u=new URL(url);return platform==='抖店'?u.hostname==='fxg.jinritemai.com'&&u.pathname==='/pc/api/home/homepage':u.hostname==='mms.pinduoduo.com'&&u.pathname==='/merchant-web-service/leon'}catch{return false}}
class Readiness{
 constructor(platform,started=Date.now()){this.platform=platform;this.started=started;this.lastActivity=started;this.pending=new Map();this.coreComplete=false;this.version=0;this.coreFailed=false}
 event(method,p,now=Date.now()){
  if(method==='Network.requestWillBeSent'&&['XHR','Fetch'].includes(p.type)&&isDataRequest(this.platform,p.request.url)){const core=isCoreRequest(this.platform,p.request.url);if(core){this.coreComplete=false;this.coreFailed=false}this.pending.set(p.requestId,{core,status:null});this.lastActivity=now;this.version++;}
  if(method==='Network.responseReceived'&&this.pending.has(p.requestId))this.pending.get(p.requestId).status=p.response.status;
  if(['Network.loadingFinished','Network.loadingFailed'].includes(method)&&this.pending.has(p.requestId)){const r=this.pending.get(p.requestId);this.pending.delete(p.requestId);this.lastActivity=now;this.version++;if(r.core){if(method==='Network.loadingFinished'&&r.status>=200&&r.status<300)this.coreComplete=true;else this.coreFailed=true}}
 }
 ready(now=Date.now()){return this.coreComplete&&!this.coreFailed&&!this.pending.size&&now-this.lastActivity>=900&&now-this.started>=(this.platform==='拼多多'?5000:3000)}
}
module.exports={parallelism,isDataRequest,isCoreRequest,Readiness};
