const {platforms,authenticated,extractShopName,takeSnapshot,LOGIN_PATH,VERIFY_PATH,loginHost,verifyHost}=require('./login');
const MESSAGES={needs_login:'登录已失效，请重新扫码登录',needs_verification:'需要完成平台验证，请打开店铺处理'};
function pageIssue(url,text=''){
 let route='',host='';try{const u=new URL(url);route=u.pathname+u.hash;host=u.hostname}catch{}
 if(verifyHost(host)||VERIFY_PATH.test(route)||/安全验证|身份验证|请完成.{0,8}验证/.test(text))return 'needs_verification';
 if(loginHost(host)||LOGIN_PATH.test(route)||/扫码登录|验证码登录|密码登录|请先?登录|账号登录|登录(?:信息)?已失效|登录过期|请重新登录/.test(text))return 'needs_login';
 return null;
}
function loginError(status){return Object.assign(Error(MESSAGES[status]),{code:status==='needs_login'?'LOGIN_REQUIRED':'VERIFICATION_REQUIRED'})}
function errorIssue(error){
 const code=error?.code||'',message=String(error?.message||error||'');
 if(code==='LOGIN_REQUIRED'||message.startsWith('LOGIN_REQUIRED:'))return 'needs_login';
 if(code==='VERIFICATION_REQUIRED'||message.startsWith('VERIFICATION_REQUIRED:'))return 'needs_verification';
 // Ambiguous identity, network, HTTP and generic platform errors are not proof of expiry.
 return null;
}
function createLoginHealth({store,onChange=()=>{},onStatus=()=>{}}){
 function record(id,status,observedAt=Date.now()){
  const shop=store.items.find(s=>s.id===id);if(!shop)return;
  const at=new Date(observedAt).toISOString(),old=shop.loginHealth;
  if(old?.checkedAt>at)return;
  shop.loginHealth={status,checkedAt:at};store.save();onChange();
  try{onStatus(id,status,at)}catch{}
 }
 function watch(shop,w){
  const wc=w.webContents;let busy=false,stopped=false,lastGood='',streak=0;
  async function check(){
   if(stopped||busy||wc.isDestroyed()||w.sleeping||wc.isLoadingMainFrame())return;
   busy=true;const began=Date.now();
   try{
    const u=new URL(wc.getURL());if(u.protocol!=='https:')return;
    const onLoginDomain=loginHost(u.hostname)||verifyHost(u.hostname);
    if(!platforms[shop.platform]?.hosts.includes(u.hostname)&&!onLoginDomain)return;
    let issue=pageIssue(u.href),snapshot;
    if(!issue){snapshot=await wc.executeJavaScript('('+takeSnapshot.toString()+')()');issue=pageIssue(snapshot.url,snapshot.text)}
    if(stopped||wc.isDestroyed()||wc.isLoadingMainFrame()||wc.getURL()!==u.href)return;
    if(issue){streak=0;lastGood='';if(shop.loginHealth?.status!==issue)record(shop.id,issue,began);return}
    // A cookie or a cached shop name alone is insufficient to clear an expiry warning.
    const cookies=await wc.session.cookies.get({url:snapshot.url});
    const identity=extractShopName(snapshot)===shop.name||snapshot.text.split('\n').some(s=>s.trim()===shop.name);
    const good=identity&&authenticated(shop.platform,snapshot,cookies.some(c=>c.value&&(!c.expirationDate||c.expirationDate>Date.now()/1000)));
    const signature=good?snapshot.url+'\0'+shop.name:'';
    streak=signature&&signature===lastGood?streak+1:good?1:0;lastGood=signature;
    if(streak>=2&&!stopped&&!wc.isDestroyed()&&!wc.isLoadingMainFrame()&&wc.getURL()===snapshot.url&&shop.loginHealth?.status!=='authenticated')record(shop.id,'authenticated',began);
   }catch{}finally{busy=false}
  }
  const timer=setInterval(check,3000);timer.unref();
  wc.on('did-stop-loading',check);wc.on('did-navigate-in-page',check);
  const stop=()=>{stopped=true;clearInterval(timer);wc.removeListener('did-stop-loading',check);wc.removeListener('did-navigate-in-page',check)};
  wc.once('destroyed',stop);check();return stop;
 }
 return {record,watch};
}
module.exports={MESSAGES,pageIssue,loginError,errorIssue,createLoginHealth};
