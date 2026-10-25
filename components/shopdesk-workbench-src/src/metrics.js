const DEFINITIONS={sales:{label:'成交金额',unit:'元',scope:'realtime'},orders:{label:'成交订单',unit:'单',scope:'realtime'},shipping:{label:'待发货',unit:'单',scope:'pending'},aftersales:{label:'待处理售后',unit:'单',scope:'pending'},refund7:{label:'7 日退款金额 · 抖店',unit:'元',scope:'7day'},ad:{label:'投放花费',unit:'元',scope:'realtime'}};
function number(raw){const s=String(raw||'').trim().replace(/[,，\s]/g,'');const m=s.match(/^[¥￥]?(-?\d+(?:\.\d+)?)(万|亿)?(?:元|单|笔|人|件)?$/);return m?Number(m[1])*(m[2]==='万'?10000:m[2]==='亿'?1e8:1):null}
function value(lines,label){const i=lines.indexOf(label);if(i<0)return null;const next=lines[i+1];if(/^[¥￥]$/.test(next||''))return number(next+lines[i+2]);return number(next)}
function day(at=Date.now()){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(at))}
function parse(platform,text,name){
 const lines=text.split('\n').map(s=>s.trim()).filter(Boolean);
 const {pageIssue,loginError}=require('./login-health');const issue=pageIssue('',text);if(issue)throw loginError(issue);
 if(!lines.includes(name))throw Error('无法核对当前店铺身份：页面上找不到“'+name+'”，店铺可能已在平台上改名，请把店铺名称改成平台现名');
 const metrics={},sourceLabels={};const put=(key,items,label)=>{metrics[key]=value(items,label);sourceLabels[key]=label};
 if(platform==='抖店'){
  const start=lines.indexOf('经营数据'),end=lines.indexOf('抢占搜索流量',start);if(start<0)throw Error('未找到经营数据区域');const main=lines.slice(start,end<0?undefined:end);
  if(!main.includes('实时'))throw Error('经营数据不是实时口径，请切回实时后重试');
  put('sales',main,'成交金额');put('orders',main,'成交订单数');put('ad',main,'投放消耗（店铺被投）');
  put('shipping',lines.slice(0,start),'待发货');put('aftersales',lines.slice(0,start),'待处理售后');
  const refund=lines.findIndex(s=>s.startsWith('7日退款金额'));metrics.refund7=refund<0?null:number(lines[refund].replace(/^7日退款金额[:：]?\s*/,''))??number(lines[refund+1]);sourceLabels.refund7='7日退款金额';
 }else if(platform==='拼多多'){
  const start=lines.findIndex(s=>s==='实时数据'||s.includes('实时数据更新时间'));if(start<0)throw Error('未找到实时经营区域');const end=lines.indexOf('累计趋势图',start),main=lines.slice(start,end<0?start+60:end);
  if(!main.includes('实时'))throw Error('未核对到实时数据口径');
  put('sales',main,'成交金额');put('orders',main,'成交订单数');put('ad',main,'推广花费');put('shipping',lines.slice(0,start),'待发货');
  // PDD homepage does not identify this as the same pending-merchant definition.
  metrics.pddAftersales=value(lines.slice(0,start),'退款/售后');sourceLabels.pddAftersales='退款/售后';
 }else throw Error('该平台经营数据尚未适配');
 for(const [key,v]of Object.entries(metrics))if(v!==null&&(!Number.isFinite(v)||v<0||(['orders','shipping','aftersales','pddAftersales'].includes(key)&&!Number.isInteger(v))))metrics[key]=null;
 if(metrics.sales===null||metrics.orders===null){
  // 抖店会把部分账号的金额/订单数脱敏成 ****：这是平台行为，不是页面没加载完
  const masked=main.some(l=>/^\*{2,}$/.test(l));
  throw Error(masked?'平台已隐藏本店经营数据（显示为 ****），与采集程序无关，请到抖店后台确认该账号的数据/资金查看权限':'成交数据仍在加载或页面结构变化，未计入汇总');
 }
 return {metrics,sourceLabels,period:'平台实时',date:day()};
}
function aggregate(state,shops,now=Date.now()){
 const sums=Object.fromEntries(Object.keys(DEFINITIONS).map(k=>[k,{value:0,count:0}]));let included=0;const seen=new Set();
 for(const shop of shops){const r=state.results[shop.id];const key=shop.platform+'\0'+shop.name;if(seen.has(key))continue;
  if(!r||r.runId!==state.runId||!['ok','partial'].includes(r.status)||r.data?.date!==day(now))continue;seen.add(key);included++;
  for(const k of Object.keys(sums)){const v=r.data.metrics[k];if(typeof v==='number'&&Number.isFinite(v)){sums[k].value+=v;sums[k].count++}}
 }for(const sum of Object.values(sums))sum.value=Math.round(sum.value*100)/100;
 return {sums,included,total:shops.length};
}
module.exports={DEFINITIONS,number,parse,aggregate,day};
