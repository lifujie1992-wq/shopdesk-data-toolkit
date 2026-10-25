// Conservative UI signals; platform DOM changes may require adapter updates.
const platforms={
 '抖店':{url:'https://fxg.jinritemai.com/login/common',hosts:['fxg.jinritemai.com','im.jinritemai.com'],homes:['/ffa/mshop/homepage']},
 '拼多多':{url:'https://mms.pinduoduo.com/',hosts:['mms.pinduoduo.com'],homes:['/home']},
 '快手':{url:'https://s.kwaixiaodian.com/',hosts:['s.kwaixiaodian.com']},
 '天猫':{url:'https://myseller.taobao.com/',hosts:['myseller.taobao.com','seller.tmall.com']},
 '小红书':{url:'https://ark.xiaohongshu.com/',hosts:['ark.xiaohongshu.com']},
 '视频号':{url:'https://store.weixin.qq.com/',hosts:['store.weixin.qq.com','channels.weixin.qq.com']}
};
// 登录/验证类路径、域名与文案：既用于“已登录”判定的排除，也用于识别登录页/验证页。
const LOGIN_PATH=/(?:^|[/#?=&_-])(?:login|signin|passport)(?:[/#?=&_.]|$)/i;
const VERIFY_PATH=/(?:^|[/#?=&_-])(?:verify|verification|captcha)(?:[/#?=&_.]|$)/i;
const LOGIN_HOST=/(?:^|\.)(?:passport|sso|signin|login)\./i;
const VERIFY_HOST=/(?:^|\.)(?:verify|captcha)\./i;
// 选店/主体提示须独立成行，避免把首页“商品选择，提升店铺吸引力”当成登录提示。
const LOGIN_TEXT=/扫码登录|扫描二维码|请扫码|请使用.{0,15}扫码|等待.{0,8}确认|扫码成功|安全验证|身份验证|验证码登录|密码登录|请先?登录|账号登录|手机号登录|短信登录|(?:^|\n)\s*(?:请)?选择(?:需要登录的|您要登录的|要登录的|登录|需要进入的|您要进入的|要进入的|进入|您名下的|名下的|您的|你的|账号下的|账号|一个)?(?:店铺|主体)\s*(?=$|\n|[：:])|登录(?:信息)?已失效|登录过期|请重新登录/;
const IDENTITY_TEXT=/退出登录|退出账号|切换账号|切换店铺|店铺信息|店铺设置|账号管理|商家后台|子账号/;
const COMMERCE_TEXT=[/商品管理|商品列表|商品中心/,/订单管理|订单查询|订单中心|全部订单/,/数据中心|数据概览|经营概况|数据罗盘|店铺数据|营销中心|售后管理/];
const loginHost=host=>LOGIN_HOST.test(String(host||''));
const verifyHost=host=>VERIFY_HOST.test(String(host||''));
const platformHost=(platform,host)=>!!platforms[platform]?.hosts.includes(host);
// 返回判定结果 + 依据，供“一键检测”在无法确认时说明原因。
function diagnose(platform,snapshot,hasCookie){
 const out={platform,ok:false,why:'',identity:false,commerce:0,hasCookie:!!hasCookie,host:'',path:'',textLength:0,shopName:''};
 const rule=platforms[platform];
 if(!rule){out.why='不支持的平台';return out}
 if(!snapshot){out.why='未取到页面内容';return out}
 let u;try{u=new URL(snapshot.url)}catch{out.why='页面地址无效';return out}
 out.host=u.hostname;out.path=u.pathname;out.textLength=(snapshot.text||'').length;
 if(u.protocol!=='https:'){out.why='页面不是 HTTPS';return out}
 if(!rule.hosts.includes(u.hostname)){out.why=`页面已跳转到 ${u.hostname||'未知地址'}，不在该平台后台域名内`;return out}
 if(LOGIN_PATH.test(u.pathname+u.hash)){out.why='地址仍是登录页';return out}
 const text=snapshot.text||'';
 if(LOGIN_TEXT.test(text)){out.why='页面出现登录/扫码/验证提示';return out}
 if(!hasCookie){out.why='未取到有效登录凭证（Cookie 已过期或缺失）';return out}
 out.shopName=extractShopName(snapshot)||'';
 out.identity=IDENTITY_TEXT.test(text);
 out.commerce=COMMERCE_TEXT.filter(r=>r.test(text)).length;
 if(out.identity&&out.commerce>=2){out.ok=true;out.why='已进入后台：识别到店铺身份与业务模块';return out}
 if(out.identity&&out.commerce>=1){out.ok=true;out.why='已进入后台：有店铺身份信号且业务模块已渲染';return out}
 if(out.commerce>=2&&out.shopName){out.ok=true;out.why='已进入后台：业务模块齐全且识别到店铺名';return out}
 if((rule.homes||[]).some(p=>u.pathname.startsWith(p))&&out.commerce>=1){out.ok=true;out.why='已进入平台后台首页，业务模块已渲染';return out}
 out.why=out.commerce===0?'后台页面尚未渲染出业务模块（通常是加载未完成）':'未识别到已登录的店铺身份信号';
 return out;
}
function authenticated(platform,snapshot,hasCookie){return diagnose(platform,snapshot,hasCookie).ok}
function extractShopName(snapshot){
 const names=(snapshot.shopNames||[]).map(value=>String(value).replace(/^\s*(?:当前店铺|店铺名称|店铺名|商店名称)\s*[:：]\s*/, '').replace(/\s*复制\s*修改\s*(?:店铺二维码)?\s*$/, '').trim()).filter(value=>value.length>=2&&value.length<=80&&!/[\r\n\t]|\.\.\.|…/.test(value)&&!/[<>]/.test(value)&&!/^(?:店铺名称|店铺名|当前店铺|店铺信息|店铺设置|切换店铺|全部店铺|我的店铺|商家后台|商家中心|抖店|拼多多|快手|天猫|小红书|视频号|微信小店|加载中|未知|未命名)$/.test(value));
 const unique=[...new Set(names)];return unique.length===1?unique[0]:null;
}
function takeSnapshot(){
 const visible=e=>{const s=getComputedStyle(e);return s.visibility!=='hidden'&&s.display!=='none'&&e.getClientRects().length>0};
 const leaves=Array.from(document.querySelectorAll('body, body *')).filter(e=>e.children.length===0&&visible(e));
 const text=leaves.map(e=>e.innerText||'').join('\n').slice(0,120000);
 const shopNames=[];
 const regions='header,aside,nav,[role="banner"],[class*="header" i],[class*="sidebar" i],[class*="topbar" i],[class*="shop-info" i],[class*="shopInfo"],[class*="store-info" i]';
 const nameSelectors='[data-testid="shop-name"],[data-testid="store-name"],[class*="shop-name" i],[class*="shopName"],[class*="store-name" i],[class*="storeName"],[id="shopName"],[id="storeName"]';
 const value=e=>{
  const clone=e.cloneNode(true);
  for(const child of clone.querySelectorAll('button,[role="button"],a,input,svg,img'))child.remove();
  for(const child of [...clone.querySelectorAll('*')].reverse())if(/^(?:复制|修改|编辑|店铺二维码|查看二维码)$/.test((child.textContent||'').trim()))child.remove();
  return e.getAttribute('title')||e.getAttribute('aria-label')||clone.textContent||'';
 };
 for(const e of document.querySelectorAll(nameSelectors)){if(visible(e)&&e.closest(regions))shopNames.push(value(e))}
 // Explicit current-shop labels may also appear on a shop information page.
 for(const e of leaves){
  const label=(e.innerText||'').trim();
  const match=label.match(/^(?:当前店铺|店铺名称|店铺名|商店名称)\s*[:：]\s*(.+)$/);
  if(match)shopNames.push(match[1]);
  if(/^(?:当前店铺|店铺名称|店铺名|商店名称)\s*[:：]?$/.test(label)){
   const next=e.nextElementSibling||(e.parentElement.children.length===1?e.parentElement.nextElementSibling:null);
   if(next&&visible(next))shopNames.push(value(next));
  }
 }
 return {url:location.href,text,shopNames};
}
function pddInfoLink(){
 if(location.hostname!=='mms.pinduoduo.com')return null;
 const found=[];
 for(const link of document.querySelectorAll('a[href]')){
  if((link.innerText||'').trim()!=='店铺信息'||!link.getClientRects().length)continue;
  try{const u=new URL(link.href);if(u.protocol==='https:'&&u.hostname==='mms.pinduoduo.com'&&!u.username&&!u.password)found.push(u.href)}catch{}
 }
 const unique=[...new Set(found)];return unique.length===1?unique[0]:null;
}
const snapshotScript='('+takeSnapshot.toString()+')()';
// 页面 DOM 抽不到唯一店名时的兜底：直接问抖店自己的身份接口。
// 注意：这个函数会被 toString() 注入页面，不能引用外部变量。
async function shopIdentityApi(){
 try{
  const get=async url=>{const r=await fetch(url,{credentials:'include',headers:{Accept:'application/json'}});if(!r.ok)return null;try{return await r.json()}catch(e){return null}};
  const home=await get('/pc/api/home/homepage?meet_redirect_grey=true&source=1&homepage_version=202606240&appid=1&_bid=ffa_shop');
  try{
   for(const layout of ((home&&home.data&&home.data.lay_out_data)||[])){
    for(const card of (layout.cards||[])){
     const info=card&&card.data&&card.data.shop_info_card_data&&card.data.shop_info_card_data.base_info;
     if(info&&info.name)return {name:String(info.name).trim(),shop_id:String((info.douyin_shop_info||{}).shop_id||'')};
    }
   }
  }catch(e){}
  const score=await get('/governance/shop/experiencescore/getAnalysisScore?exp_version=release&new_shop_version=release&number_type=30');
  const name=score&&score.data&&score.data.shop_name;
  return name?{name:String(name).trim(),shop_id:String(score.data.shop_id||'')}:null;
 }catch(e){return null}
}
function watchLogin({platform,windows,ses,onSuccess,onError,onProgress=()=>{},interval=1500}){
 let stopped=false,busy=false,streak=0,lastPage='',timer;const missingSince=new Map(),navigated=new Set();
 const apiNames=new Map(),apiTried=new Map();
 async function check(){if(stopped||busy)return;busy=true;try{
 let candidate='',identity=null;
 for(const w of windows()){
  if(w.isDestroyed()||w.webContents.isLoadingMainFrame())continue;
  const snapshot=await w.webContents.executeJavaScript(snapshotScript);
  const cookies=await ses.cookies.get({url:snapshot.url});
  if(authenticated(platform,snapshot,cookies.some(c=>c.value&&(!c.expirationDate||c.expirationDate>Date.now()/1000)))){
   let name=extractShopName(snapshot);
   // 抖店：官方身份接口优先（页面布局改动/多店账号都能拿到唯一的官方店名）
   if(platform==='抖店'){
    const now=Date.now();
    if(!apiNames.has(w.id)&&now-(apiTried.get(w.id)||0)>5000){
     apiTried.set(w.id,now);
     const info=await w.webContents.executeJavaScript('('+shopIdentityApi.toString()+')()').catch(()=>null);
     if(info&&info.name&&String(info.name).trim().length>=2)apiNames.set(w.id,String(info.name).trim());
    }
    const apiName=apiNames.get(w.id);
    if(apiName)name=apiName;
   }
   if(!name){
    if(!missingSince.has(w.id))missingSince.set(w.id,Date.now());
    const elapsed=Date.now()-missingSince.get(w.id);
    onProgress(elapsed>90000?'name-unavailable':'name-pending');
    if(platform==='拼多多'&&elapsed>=4500&&!navigated.has(w.id)){
     const infoURL=await w.webContents.executeJavaScript('('+pddInfoLink.toString()+')()');
     if(infoURL&&!stopped&&!w.isDestroyed()&&infoURL!==w.webContents.getURL()){
      navigated.add(w.id);onProgress('reading-info');await w.loadURL(infoURL);
     }
    }
    continue;
   }
   identity={name};candidate=w.id+':'+snapshot.url+':'+name;break;
  }
 }
 if(candidate&&candidate===lastPage)streak++;else streak=candidate?1:0;lastPage=candidate;
 if(streak>=3&&!stopped){stopped=true;clearInterval(timer);await onSuccess(identity)}
 }catch(e){streak=0;lastPage='';if(stopped)onError(e)}finally{busy=false}}
 timer=setInterval(check,interval);check();return ()=>{stopped=true;clearInterval(timer)};
}
module.exports={platforms,authenticated,diagnose,extractShopName,watchLogin,takeSnapshot,pddInfoLink,shopIdentityApi,LOGIN_PATH,VERIFY_PATH,LOGIN_HOST,VERIFY_HOST,LOGIN_TEXT,loginHost,verifyHost,platformHost};
