const $=s=>document.querySelector(s);let pendingLogins=[],records=[],view='all',groupFilter='',timer;
let selected=new Set(),visibleRows=[];
let namesVisible=false,editNameDraft='';
let loginScanState=null;
function shopName(name){if(namesVisible)return String(name||'');const a=Array.from(String(name||''));if(a.length<2)return '＊';return a[0]+'＊＊＊'+a[a.length-1]}
function privateText(value){let text=String(value||'');if(!namesVisible)for(const s of [...records].sort((a,b)=>b.name.length-a.name.length))text=text.split(s.name).join(shopName(s.name));return text}
function tabTitle(value){return namesVisible?value:shopName(value)}
function syncNameEditor(){const input=$('#name');input.value=namesVisible?editNameDraft:shopName(editNameDraft);input.readOnly=!namesVisible;input.setAttribute('aria-label',namesVisible?'店铺名称':'店铺名称已脱敏，点击显示完整店名后可编辑')}
function toggleNames(){namesVisible=!namesVisible;document.querySelectorAll('[data-toggle-names]').forEach(b=>{b.textContent=namesVisible?'隐藏店名':'显示完整店名';b.setAttribute('aria-pressed',String(namesVisible))});render();renderPending();renderTabs(tabState);if(metricsState)renderMetrics(metricsState);if(loginScanState)renderLoginScan(loginScanState);if($('#editor').open)syncNameEditor();$('#toast').style.display='none';window.renderCollectorResults?.()}

let customGroups=JSON.parse(localStorage.getItem('shopdesk-groups')||'[]');
const platformMarks={'抖店':['douyin','♪'],'拼多多':['pdd','拼'],'快手':['kuaishou','快'],'天猫':['tmall','猫'],'小红书':['red','小红书'],'视频号':['wechat','▶']};
function platformBadge(p){const [key,mark]=platformMarks[p]||['other','店'];return `<span class="platform-icon ${key}" aria-hidden="true">${mark}</span><span>${esc(p)}</span>`}
function allGroups(){return [...new Set(['未分组',...customGroups,...records.map(s=>s.group)])]}

const esc=s=>String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function toast(s){$('#toast').textContent=privateText(s);$('#toast').style.display='block';clearTimeout(timer);timer=setTimeout(()=>$('#toast').style.display='none',5000)}
async function run(fn){try{await fn()}catch(e){toast(e.message)}}
async function refresh(){records=await window.shops.list();pendingLogins=await window.shops.pending();renderPending();render();renderTabs(tabState);if(metricsState)renderMetrics(metricsState)}
function shopIssue(s){return ['needs_login','needs_verification'].includes(s?.loginHealth?.status)?s.loginHealth.status:null}
function issueLabel(issue){return issue==='needs_verification'?'需要平台验证':'登录失效'}
function loginAction(issue){return issue==='needs_verification'?'去验证':'重新登录'}
const loginStateLabels={checking:'检测中…',authenticated:'登录正常',needs_login:'登录失效',needs_verification:'需要验证',unverified:'未确认（此前正常）',unknown:'未能确认',error:'检测失败',cancelled:'已取消',saved:'会话已保存',none:'待登录'};
const scanUnclear=r=>!!r&&['unknown','error'].includes(r.status);
const fmtTime=v=>v?new Date(v).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'';
function loginStateInfo(s){
 const r=loginScanState?.results?.[s.id];
 const health=s.loginHealth;
 if(r&&r.status){
  // 本次检测没得出结论（多为页面加载超时）：不覆盖后台常驻监听确认过的状态，只标注“未确认”
  if(scanUnclear(r)&&health?.status)return {status:health.status==='authenticated'?'unverified':health.status,checkedAt:health.checkedAt,reason:r.reason,scanCheckedAt:r.checkedAt,scanStatus:r.status};
  return {status:r.status,checkedAt:r.checkedAt,detectedName:r.detectedName,reason:r.reason,scanStatus:r.status};
 }
 if(health?.status)return {status:health.status,checkedAt:health.checkedAt};
 if(s.loginSavedAt)return {status:'saved',checkedAt:s.loginSavedAt};
 return {status:'none',checkedAt:null};
}
function canRescan(s){const info=loginStateInfo(s);return ['unknown','unverified','error'].includes(info.status)}
function loginStateCell(s){
 const info=loginStateInfo(s);
 const cls=info.status==='authenticated'?'ok':info.status==='needs_login'?'bad':(info.status==='needs_verification'||info.status==='error')?'warn':info.status==='checking'?'checking':'muted';
 const label=loginStateLabels[info.status]||info.status;
 const time=info.checkedAt?`<small>${fmtTime(info.checkedAt)}</small>`:'';
 const why=info.reason||'未知原因';
 const tip=info.scanStatus?`本次检测未得出结论：${why}（${fmtTime(info.scanCheckedAt)}）。这里显示的是上次确认的状态。`:(['unknown','error'].includes(info.status)?`本次检测未得出结论：${why}。可点行内“重测”单独再检一次，不必整批重扫。`:'');
 return `<span class="login-state ${cls}"${tip?` title="${esc(tip)}"`:''}>${esc(label)}${time}</span>`;
}
function render(){
 $('#total').textContent=$('#count').textContent=records.length;$('#opened').textContent=records.filter(s=>s.opened).length;$('#favorites').textContent=records.filter(s=>s.favorite).length;
 const platform=$('#platformFilter').value;$('#platformFilter').innerHTML='<option value="">全部平台</option>'+[...new Set([...Object.keys(platformMarks),...records.map(s=>s.platform)])].map(p=>`<option value="${esc(p)}">${esc(p)}</option>`).join('');$('#platformFilter').value=platform;
 $('#groups').innerHTML=allGroups().map(g=>`<button class="nav ${groupFilter===g?'active':''}" data-group="${esc(g)}">▤ <span class="group-name">${esc(g)}</span><span>${records.filter(s=>s.group===g).length}</span></button>`).join('');
 $('#platformNav').innerHTML=Object.keys(platformMarks).map(p=>`<button class="nav platform-nav ${platform===p?'active':''}" data-platform="${esc(p)}">${platformBadge(p)}<span class="nav-count">${records.filter(s=>s.platform===p).length}</span></button>`).join('');
 $('#groupOptions').innerHTML=allGroups().map(g=>`<option value="${esc(g)}"></option>`).join('');

 document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',!groupFilter&&b.dataset.view===view));
 const title=groupFilter||({all:'全部店铺',favorite:'常用店铺',opened:'已打开'})[view];$('#title').textContent=$('#breadcrumb').textContent=title;
 const q=$('#search').value.trim().toLowerCase();const rows=records.filter(s=>(!groupFilter||s.group===groupFilter)&&(view!=='favorite'||s.favorite)&&(view!=='opened'||s.opened)&&(!platform||s.platform===platform)&&[s.name,s.note,s.platform,s.group].join(' ').toLowerCase().includes(q)).sort((a,b)=>$('#sort').value==='name'?a.name.localeCompare(b.name,'zh'):Number(b.lastOpened||0)-Number(a.lastOpened||0));
 $('#results').textContent=`共 ${rows.length} 家店铺`;$('#empty').hidden=rows.length>0;$('#empty h2').textContent=records.length?'没有匹配的店铺':'把第一家店铺添加进来';$('#empty p').hidden=!!records.length;$('#addEmpty').hidden=!!records.length;
 visibleRows=rows;selected=new Set([...selected].filter(id=>records.some(s=>s.id===id)));
 $('#selectionCount').textContent=`已选 ${selected.size} 家`;$('#batchGroup').disabled=!selected.size;
 $('#selectAll').checked=!!rows.length&&rows.every(s=>selected.has(s.id));$('#selectAll').indeterminate=rows.some(s=>selected.has(s.id))&&!$('#selectAll').checked;
 $('#grid').innerHTML=rows.map(s=>`<tr class="${selected.has(s.id)?'checked':''}"><td><input type="checkbox" data-check="${s.id}" ${selected.has(s.id)?'checked':''} aria-label="选择 ${esc(shopName(s.name))}"></td><td><button class="shop-name" data-action="open" data-id="${s.id}" title="${esc(shopName(s.name))}">${esc(shopName(s.name))}</button>${s.note?`<small class="row-note" title="${esc(privateText(s.note))}">${esc(privateText(s.note))}</small>`:''}</td><td><div class="platform-cell">${platformBadge(s.platform)}</div></td><td><button class="group-tag" data-assign="${s.id}" title="更改分组">${esc(s.group)} ▾</button></td><td>${loginStateCell(s)}</td><td><span class="row-state ${s.opened?'live':''}">${s.opened?'● 已打开':'未打开'}</span><small class="last-open">${s.lastOpened?new Date(s.lastOpened).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'尚未打开'}</small></td><td><div class="row-actions"><button class="star ${s.favorite?'selected':''}" data-action="favorite" data-id="${s.id}" aria-label="${s.favorite?'取消收藏':'收藏店铺'}">${s.favorite?'★':'☆'}</button><button class="enter" data-action="${shopIssue(s)?'relogin':'open'}" data-id="${s.id}">${shopIssue(s)?loginAction(shopIssue(s)):s.opened?'进入':'打开'}</button>${canRescan(s)?`<button class="rescan" data-action="rescan" data-id="${s.id}" title="只重新检测这家店铺的登录状态">重测</button>`:''}<button data-action="edit" data-id="${s.id}">编辑</button><button class="remove" data-action="remove" data-id="${s.id}" aria-label="删除 ${esc(shopName(s.name))}">删除</button></div></td></tr>`).join('');
 $('#shopTable').hidden=!rows.length;

}
function edit(s={}){$('#form').reset();$('#formError').textContent='';$('#shopId').value=s.id||'';for(const k of ['name','platform','group','url','note'])$('#'+k).value=s[k]||'';$('#dialogTitle').textContent=s.id?'编辑店铺':'添加店铺';editNameDraft=s.name||'';syncNameEditor();document.querySelectorAll('.advanced').forEach(e=>e.hidden=!s.id);$('#platform').disabled=!!s.id;$('#submitShop').textContent=s.id?'保存修改':'确定，去扫码';$('#editor').showModal();(s.id?$('#name'):$('#platform')).focus()}
$('#add').onclick=$('#addEmpty').onclick=()=>edit();$('#cancel').onclick=()=>$('#editor').close();
function renderPending(){$('#loginPending').hidden=!pendingLogins.length;$('#loginPending').innerHTML=pendingLogins.map(p=>`<div>◌ ${esc(shopName(p.name))}：${esc(p.message||'等待扫码登录，成功后自动读取店铺名称并保存')} <button data-login="${p.id}">查看登录标签 ↗</button></div>`).join('')}
$('#loginPending').onclick=e=>{const b=e.target.closest('[data-login]');if(b)run(()=>window.shops.focusLogin(b.dataset.login))};
window.shops.onLogin(d=>{pendingLogins=pendingLogins.filter(p=>p.id!==d.id);if(d.state==='error'||d.state==='name-pending')pendingLogins.push({id:d.id,name:d.name,message:d.message});renderPending();toast(d.state==='saved'?d.name+' · 保存成功':d.message);run(refresh)});
$('#form').onsubmit=async e=>{e.preventDefault();const data={id:$('#shopId').value};for(const k of ['name','platform','group','url','note'])data[k]=$('#'+k).value;if(data.id)data.name=editNameDraft;$('#submitShop').disabled=true;try{if(data.id){await window.shops.save(data);toast('修改已保存')}else{await window.shops.beginLogin(data);toast('请在新标签扫码；进入店铺后台后将自动保存')}$('#editor').close();await refresh()}catch(e){$('#formError').textContent=e.message}finally{$('#submitShop').disabled=false}};
$('#grid').onclick=e=>{const b=e.target.closest('[data-action]');if(!b)return;if(b.dataset.action==='edit')edit(records.find(s=>s.id===b.dataset.id));else if(b.dataset.action==='rescan'){b.disabled=true;run(async()=>{try{renderLoginScan(await window.shops.scanLoginShop(b.dataset.id));const after=loginStateInfo(records.find(s=>s.id===b.dataset.id)||{});toast('重测完成：'+(loginStateLabels[after.status]||after.status)+(after.reason?' · '+after.reason:''))}catch(err){toast(err.message||'重测失败')}})}else run(()=>window.shops[b.dataset.action](b.dataset.id))};
 document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>{view=b.dataset.view;groupFilter='';render()});$('#groups').onclick=e=>{const b=e.target.closest('[data-group]');if(b){groupFilter=b.dataset.group;view='all';render()}};
$('#search').oninput=render;$('#platformFilter').onchange=render;$('#sort').onchange=render;window.shops.onChange(()=>run(refresh));run(refresh);

const entries={'抖店':'https://fxg.jinritemai.com/','拼多多':'https://mms.pinduoduo.com/','快手':'https://s.kwaixiaodian.com/','天猫':'https://myseller.taobao.com/','小红书':'https://ark.xiaohongshu.com/','视频号':'https://store.weixin.qq.com/'};
$('#platform').onchange=()=>{$('#url').value=entries[$('#platform').value]||''};

let tabState={active:'home',items:[]};
function renderTabs(state){const previous=tabState.active;tabState=state;document.body.classList.toggle('browsing',state.active!=='home');$('#browserTools').hidden=state.active==='home';$('#homeTab').classList.toggle('selected',state.active==='home');$('#shopTabs').innerHTML=state.items.map(t=>`<div class="tab ${state.active===t.id?'selected':''}"><button role="tab" aria-selected="${state.active===t.id}" data-select-tab="${t.id}" title="${esc(tabTitle(t.title))}">${t.sleeping?'☾':t.loading?'◌':'▣'} ${esc(tabTitle(t.title))}</button><button class="closeTab" data-close-tab="${t.id}" aria-label="关闭 ${esc(tabTitle(t.title))}">×</button></div>`).join('');$('#pageAddress').textContent=state.url;$('#pageAddress').title=state.url;$('#pageError').textContent=state.error?'加载失败，请刷新重试':'';$('#goBack').disabled=!state.back;$('#goForward').disabled=!state.forward;if(previous!==state.active)$('#shopTabs .selected')?.scrollIntoView({block:'nearest',inline:'nearest'})}
$('#homeTab').onclick=$('#returnHome').onclick=()=>run(()=>window.shops.tabAction('select','home'));
$('#shopTabs').onclick=e=>{const c=e.target.closest('[data-close-tab]'),s=e.target.closest('[data-select-tab]');if(c)run(()=>window.shops.tabAction('close',c.dataset.closeTab));else if(s)run(()=>window.shops.tabAction('select',s.dataset.selectTab))};
$('#goBack').onclick=()=>run(()=>window.shops.tabAction('back'));$('#goForward').onclick=()=>run(()=>window.shops.tabAction('forward'));$('#reloadTab').onclick=()=>run(()=>window.shops.tabAction('reload'));window.shops.onTabs(renderTabs);run(async()=>renderTabs(await window.shops.tabs()));

const capabilityNames={sync_shipped_refunds:'近30天已发货仅退款',sync_experience:'查询体验分',get_metrics:'读取经营汇总',sync_metrics:'更新经营数据',list_shops:'列出店铺',open_shop:'打开店铺',open_shop_home:'打开抖店首页',get_login_status:'检查登录状态',read_shop_page:'读取页面',find_metric_evidence:'查找指标原文'};
function renderAgent(s){$('#agentReady').textContent=s.ready?'本机接口已启动':s.error?'接口启动失败':'接口正在启动';$('#agentLight').style.color=s.ready?'#389577':'#a4abba';$('#agentRecent').textContent=s.lastSkillAt?'最近收到 Skill 调用：'+new Date(s.lastSkillAt).toLocaleString('zh-CN'):s.lastMcpAt?'最近收到 MCP 调用：'+new Date(s.lastMcpAt).toLocaleString('zh-CN'):'尚未收到 MCP 调用';$('#agentTest').disabled=!s.ready;$('#agentCallCount').textContent='本次启动 '+s.callCount+' 次';$('#agentCalls').innerHTML=s.history.length?s.history.map(c=>`<div class="agentCall"><div><strong>${esc(capabilityNames[c.method]||c.method)}</strong><small>${esc(c.source)} · ${new Date(c.at).toLocaleTimeString('zh-CN')}${c.durationMs!=null?' · '+c.durationMs+' ms':''}</small></div><span class="callState ${c.state==='失败'?'failed':''}">${esc(c.state)}${c.resultStatus&&c.resultStatus!=='ok'?' · '+esc(c.resultStatus):''}</span></div>`).join(''):'尚无调用。可以先点击“检测本机接口”。';if(s.error)$('#agentTestResult').textContent=s.error}
async function showAgent(){await window.shops.tabAction('select','home');renderAgent(await window.shops.agentStatus());$('#agentPanel').showModal();window.refreshCollectors?.()}
$('#agentNav').onclick=$('#agentTop').onclick=()=>run(showAgent);$('#closeAgent').onclick=()=>$('#agentPanel').close();$('#agentPanel').onclick=e=>{const b=e.target.closest('[data-prompt]');if(b)run(async()=>{await window.shops.agentCopy(b.dataset.prompt);toast('指令已复制，粘贴到 Codex 即可')})};$('#agentTest').onclick=()=>run(async()=>{$('#agentTest').disabled=true;try{const result=await window.shops.agentTest();$('#agentTestResult').textContent='本机接口正常，可读取 '+result.shopCount+' 家店铺。安装 Skill 后，可在 Codex 中发送指令验证连接。'}finally{renderAgent(await window.shops.agentStatus())}});window.shops.onAgent(renderAgent);

let assignIds=[];
function showGroups(ids=[]){assignIds=ids;$('#groupTitle').textContent=ids.length?'移动到分组':'新建分组';$('#groupHelp').textContent=ids.length?`将 ${ids.length} 家店铺移入以下分组，也可以输入新分组名称。`:'输入团队、品类或业务分组名称，创建后可批量移入店铺。';$('#targetGroup').value='';$('#groupError').textContent='';$('#groupDialog').showModal();$('#targetGroup').focus()}
$('#newGroup').onclick=()=>showGroups();$('#batchGroup').onclick=()=>showGroups([...selected]);$('#cancelGroup').onclick=()=>$('#groupDialog').close();
$('#selectAll').onchange=e=>{for(const s of visibleRows){if(e.target.checked)selected.add(s.id);else selected.delete(s.id)}render()};
$('#grid').addEventListener('change',e=>{const id=e.target.dataset.check;if(id){if(e.target.checked)selected.add(id);else selected.delete(id);render()}});
$('#grid').addEventListener('click',e=>{const b=e.target.closest('[data-assign]');if(b)showGroups([b.dataset.assign])});
$('#platformNav').onclick=e=>{const b=e.target.closest('[data-platform]');if(b){$('#platformFilter').value=$('#platformFilter').value===b.dataset.platform?'':b.dataset.platform;render()}};
$('#groupForm').onsubmit=async e=>{e.preventDefault();const group=$('#targetGroup').value.trim();if(!group)return;$('#saveGroup').disabled=true;try{for(const id of assignIds){const shop=records.find(s=>s.id===id);if(shop)await window.shops.save({...shop,group})}customGroups=[...new Set([...customGroups,group])];localStorage.setItem('shopdesk-groups',JSON.stringify(customGroups));selected.clear();$('#groupDialog').close();await refresh();toast(assignIds.length?'分组已更新':'分组已创建，可勾选店铺批量移入')}catch(e){$('#groupError').textContent=e.message}finally{$('#saveGroup').disabled=false}};

let metricsState=null;
function metricNumber(v,money=false){return typeof v==='number'?(money?'¥':'')+v.toLocaleString('zh-CN',{minimumFractionDigits:money?2:0,maximumFractionDigits:2}):'—'}
function renderMetrics(s){metricsState=s;const {summary}=s;$('#updateMetrics').disabled=s.running;$('#cancelMetrics').hidden=!s.running;$('#updateMetrics').textContent=s.running?'正在更新…':'↻ 更新全部店铺';
 $('#metricsCoverage').textContent=`全部 ${summary.total} 家 · 本次已计入 ${summary.included} 家`;
 $('#metricCards').innerHTML=Object.entries(s.definitions).map(([key,d])=>{const sum=summary.sums[key];return `<article><span>${esc(d.label)}</span><strong>${sum.count?metricNumber(sum.value,d.unit==='元'):'—'}</strong><small>${sum.count} 家有数据 · ${d.scope==='realtime'?'平台实时':d.scope==='7day'?'近 7 日':'当前待办'}</small></article>`}).join('');
 const failures=s.shops.filter(shop=>s.results[shop.id]?.runId===s.runId&&s.results[shop.id]?.status==='error');const errors=failures.length;
 render();
 $('#metricProgress').textContent=s.running?`更新进度 ${s.completed} / ${s.total} · 并行 ${s.concurrency||2} 家 · ${s.shops.filter(shop=>s.results[shop.id]?.status==='loading').map(shop=>shopName(shop.name)).join('、')}`:s.finishedAt?`${s.cancelled?'更新已停止':'最近更新结束'}：${new Date(s.finishedAt).toLocaleString('zh-CN')}${s.durationMs!=null?' · 耗时 '+(s.durationMs/1000).toFixed(1)+' 秒':''} · ${errors} 家未成功${errors?'，请查看各店明细':''}${s.databaseError?' · '+s.databaseError:''}`:'数据尚未采集，更新时将在后台读取各店，不影响当前 Tab。';
 $('#metricDetailRows').innerHTML=s.shops.map(shop=>{const r=s.results[shop.id],record=records.find(s=>s.id===shop.id),issue=shopIssue(record),recovered=['LOGIN_REQUIRED','VERIFICATION_REQUIRED'].includes(r?.errorCode)&&record?.loginHealth?.status==='authenticated',current=r?.runId===s.runId&&r?.status==='ok'&&r?.data?.date===new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()),m=current?r.data.metrics:{};return `<tr><td><strong>${esc(shopName(shop.name))}</strong><small>${esc(shop.platform)}</small></td>${['sales','orders','ad','shipping'].map(k=>`<td>${metricNumber(m[k],['sales','ad'].includes(k))}</td>`).join('')}<td>${metricNumber(m.aftersales??m.pddAftersales)}${shop.platform==='拼多多'?'<small>平台“退款/售后”<br>不并入待处理汇总</small>':''}</td><td>${metricNumber(m.refund7,true)}</td><td class="metric-status"><span class="${r?.status==='error'?'metric-error':''}">${issue?issueLabel(issue):r?.status==='loading'?'更新中':r?.status==='error'?(recovered?'登录已恢复，待更新':esc(r.error)):current?(r.data?.transport==='python_http'?'已更新 · 接口同步':'已更新 · 页面采集'):r?.data?'旧数据，待更新':'尚未更新'}</span><small>${r?.attemptedAt?new Date(r.attemptedAt).toLocaleString('zh-CN'):''}</small></td><td><button ${issue?'data-login-shop':'data-metric-shop'}="${shop.id}">${issue?loginAction(issue):'打开店铺'}</button></td></tr>`}).join('');
}
$('#updateMetrics').onclick=()=>run(async()=>renderMetrics(await window.shops.updateMetrics()));$('#cancelMetrics').onclick=()=>run(()=>window.shops.cancelMetrics());
$('#metricDetails').onclick=()=>run(async()=>{await window.shops.tabAction('select','home');renderMetrics(await window.shops.metrics());$('#metricsDialog').showModal()});$('#closeMetrics').onclick=()=>$('#metricsDialog').close();$('#metricDetailRows').onclick=e=>{const b=e.target.closest('[data-metric-shop]');if(b){$('#metricsDialog').close();run(()=>window.shops.open(b.dataset.metricShop))}};
window.shops.onMetrics(renderMetrics);window.shops.onChange(()=>run(async()=>renderMetrics(await window.shops.metrics())));run(async()=>renderMetrics(await window.shops.metrics()));

function renderLoginScan(s){
 loginScanState=s;const scanning=s.running;$('#checkLogins').disabled=scanning;$('#checkLogins').textContent=scanning?'正在检测…':'⟳ 一键检测登录状态';$('#cancelLoginScan').hidden=!scanning;
 if(!s.total){$('#loginScanSummary').textContent='尚未检测 · 一键检查所有店铺后台登录是否仍有效';render();return}
 const counts={authenticated:0,needs_login:0,needs_verification:0,unknown:0,error:0,checking:0,cancelled:0};for(const r of Object.values(s.results||{}))if(counts[r.status]!==undefined)counts[r.status]++;
 if(scanning)$('#loginScanSummary').textContent=`检测中 ${s.completed} / ${s.total} 家 · 正常 ${counts.authenticated} · 登录失效 ${counts.needs_login} · 需要验证 ${counts.needs_verification}${s.retry?` · 复检 ${s.retry.completed} / ${s.retry.total}`:''}`;
 else{const unclear=counts.unknown+counts.error;$('#loginScanSummary').textContent=`最近检测：${new Date(s.finishedAt||Date.now()).toLocaleString('zh-CN')}${s.durationMs!=null?' · 耗时 '+(s.durationMs/1000).toFixed(1)+' 秒':''} · 正常 ${counts.authenticated} · 登录失效 ${counts.needs_login} · 需要验证 ${counts.needs_verification} · 未得出结论 ${unclear}${unclear?'（多为页面加载超时，不代表掉登录；点行内“重测”可单独复检）':''}`}
 render();
}
$('#checkLogins').onclick=()=>run(async()=>renderLoginScan(await window.shops.startLoginScan()));$('#cancelLoginScan').onclick=()=>run(async()=>renderLoginScan(await window.shops.cancelLoginScan()));
window.shops.onLoginScan(renderLoginScan);run(async()=>renderLoginScan(await window.shops.loginScan()));

$('#downloadSkill').onclick=()=>run(async()=>{$('#downloadSkill').disabled=true;try{const r=await window.shops.exportSkill();if(r.saved)$('#skillExportResult').textContent='已保存：'+r.path;}finally{$('#downloadSkill').disabled=false}});

$('#name').oninput=()=>{if(namesVisible)editNameDraft=$('#name').value};
document.querySelectorAll('[data-toggle-names]').forEach(b=>b.onclick=toggleNames);

document.addEventListener('click',e=>{const b=e.target.closest('[data-login-shop]');if(!b)return;$('#metricsDialog').close();run(async()=>{await window.shops.relogin(b.dataset.loginShop);toast('请在该店铺标签完成扫码或验证，确认登录后提醒会自动清除')})});
