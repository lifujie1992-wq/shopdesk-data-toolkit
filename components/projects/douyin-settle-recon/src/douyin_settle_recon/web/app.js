const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fmt = (v) => v === null || v === undefined ? "—" : Number(v).toLocaleString("zh-CN", {minimumFractionDigits:2,maximumFractionDigits:2});
const num = (v) => v !== null && v !== "" && typeof v !== "boolean" && Number.isFinite(Number(v));
const descriptions = {
  fees:"以预期表为基准，按资金账户和费用类型匹配；差额 = 实际 − 预期。",
  checks:"对比货款结算金额、结算账单金额及两者校验差额。",
  balances:"逐账户检查期初余额、本期发生额、期末余额和余额校验。",
  identity:"检查汇总中每一个费用项目的店铺编码，缺失编码会单独列出。",
  processed:"按动账流水号逐行核对加工字段，包括结算金额、订单收入、费用类型和资金账户。",
  funds:"按动账流水号匹配原始资金账单，核对所有共同字段和新增、缺失字段。",
  settlement:"按子订单号、订单号和结算时间匹配，检查每笔结算金额及明细字段。",
  deposit:"按操作单号匹配保证金流水，检查操作时间、金额和交易状态。",
  evidence:"比较余额账单、管家账户的数值；实际表中的“原始记录”也会自动匹配。",
  template:"与月度账单处理模版比较固定表头和公式；此页的预期值来自模版。",
  issues:"查看本次运行生成的异常和内部检查结论，辅助定位来源与处理原因。"
};
let catalog, entry, group="fees", filter="diff", offset=0, rowQuery="", generation=0, results=new Map(), timers=new Map(), pageData;
let notesAvailable=true, searchTimer, toastTimer;

async function api(path, options) {
  const response=await fetch(path,options);const value=await response.json();
  if(!response.ok || value.error) throw new Error(value.error || `请求失败 (${response.status})`);
  return value;
}
function toast(message) {$("toast").textContent=message;$("toast").classList.remove("hidden");clearTimeout(toastTimer);toastTimer=setTimeout(()=>$("toast").classList.add("hidden"),4500);}
function params(g=group, extra={}) {return new URLSearchParams({id:entry.id,group:g,...extra}).toString();}
function noteKey() {return `douyin-review:${entry.id}:${entry.run_id}:${group}`;}
function readNote() {
  try {$("review-note").value=localStorage.getItem(noteKey())||"";$("note-status").textContent="仅保存在当前浏览器";}
  catch {notesAvailable=false;$("review-note").value="";$("note-status").textContent="当前浏览器无法保存备注";}
}
function renderCatalog() {
  const query=$("shop-search").value.trim().toLowerCase();
  const entries=catalog.entries.filter(e=>`${e.shop} ${e.month} ${e.name}`.toLowerCase().includes(query));
  $("shop-count").textContent=`${entries.length} / ${catalog.entries.length}`;
  $("catalog").innerHTML=entries.map(e=>`<button class="catalog-entry ${entry?.id===e.id?"active":""}" data-entry="${esc(e.id)}"><strong>${esc(e.shop)}</strong><small>${esc(e.month)} · ${e.versions} 次运行</small>${e.has_expected?"":"<div class='mini-status'>缺少匹配的预期表</div>"}</button>`).join("") || '<div class="no-results">没有匹配的账单</div>';
}
function renderTabs() {
  $("tabs").innerHTML=[...catalog.groups,{id:"issues",label:"运行异常"}].map(g=>{
    const r=results.get(g.id);const state=r?.state;
    const label=state==="ready"?(r.different?`${r.different} 项差异`:"一致"):state==="loading"?"核对中":state==="error"?"失败":g.id==="issues"?"来源":"未核对";
    return `<button role="tab" aria-selected="${group===g.id}" class="tab ${group===g.id?"active":""} ${r?.different?"has-diff":""}" data-group="${g.id}">${esc(g.label)}<span class="tab-count ${state==="ready"?(r.different?"diff":"same"):""}">${esc(label)}</span></button>`;
  }).join("");
}
function updateMetrics() {
  const r=results.get("fees");
  if(r?.state==="ready") {
    $("metric-total").textContent=r.total;$("metric-same").textContent=r.same;$("metric-diff").textContent=r.different;
    $("metric-expected").textContent=fmt(r.expected_total);
    const delta=r.actual_total===null || r.expected_total===null?null:Number(r.actual_total)-Number(r.expected_total);
    $("metric-delta").textContent=delta===null?"不完整":(delta>0?"+":"")+fmt(delta);$("metric-delta").className=delta===null || Math.abs(delta)>=.005?"red":"green";
  }
  const ready=[...results.values()].filter(r=>r.state==="ready");
  const done=ready.length, diff=ready.filter(r=>r.different).length;
  const unfinished=catalog.groups.length-done;
  $("overview-notice").classList.toggle("warning",diff>0 || !entry.has_expected);
  if(!entry.has_expected) $("overview-notice").textContent="未找到 doc 中匹配的预期表（文件名支持追加“-预期结果”）。请补充预期账单后重新读取，当前不能判定结果是否正确。";
  else if(r?.state==="ready") $("overview-notice").innerHTML=`<strong>${r.different?`费用分类有 ${r.different} 项金额不一致`:'费用分类金额一致'}</strong>，实际净发生额 ${fmt(r.actual_total)} 元。已完成 ${done} / ${catalog.groups.length} 个核对项目${diff?`，其中 ${diff} 个项目有差异`:""}。${unfinished?`其余 ${unfinished} 个项目尚未完成核对。`:"所有列出的项目均已完成，截图内容仍需人工确认。"}<br><span>费用合计相同仍可能存在分类抵消；请结合各项目差异和运行异常判断。</span>`;
  else if(r?.state==="error") $("overview-notice").textContent=r.error;
  else $("overview-notice").textContent="正在读取汇总数据。明细文件较大时，首次核对需要一些时间。";
}
function cancelPolls() {for(const timer of timers.values())clearTimeout(timer);timers.clear();}
async function loadCatalog() {
  $("rescan").disabled=true;
  try {
    const next=await api("/api/catalog");catalog=next;
    const selected=catalog.entries.find(e=>e.id===entry?.id) || catalog.entries.find(e=>e.id===new URLSearchParams(location.search).get("bill")) || catalog.entries[0];
    if(!selected) {
      generation++;cancelPolls();entry=null;$("workspace").classList.add("hidden");$("empty").classList.remove("hidden");
      $("empty").innerHTML=`<strong>还没有找到汇总结果</strong>将 <code>YYYYMM【抖音】Y-店铺名.xlsx</code> 放在运行目录下，再点击“重新读取”。<br>扫描目录：${next.run_roots.map(esc).join("、")}<br>预期表放在 doc 目录，文件名可追加“-预期结果”，raw / rules 内的源文件不会被选作结果。`;
      renderCatalog();return;
    }
    await selectEntry(selected.id);
  } catch(error) {toast(error.message);$("empty").classList.remove("hidden");$("empty").textContent=error.message;}
  finally {$("rescan").disabled=false;}
}
async function selectEntry(id) {
  generation++;cancelPolls();entry=catalog.entries.find(e=>e.id===id);results=new Map();offset=0;rowQuery="";$("row-search").value="";
  $("empty").classList.add("hidden");$("workspace").classList.remove("hidden");
  $("shop-name").textContent=entry.shop;$("filename").textContent=entry.name;$("month").textContent=entry.month;
  $("run-id").textContent=entry.run_id;$("version-info").textContent=`已自动选取最新版本 · 共 ${entry.versions} 次运行`;
  $("file-paths").innerHTML=`<div><b>预期表</b>${esc(entry.expected_path || "未找到匹配的预期表")}</div><div><b>实际表</b>${esc(entry.actual_path)}</div><div><b>模版</b>${esc(catalog.template)}</div>`;
  $("open-expected").disabled=!entry.has_expected;$("check-all").disabled=!entry.has_expected;
  for(const id of ["total","same","diff","expected","delta"]) $("metric-"+id).textContent="—";
  renderCatalog();updateMetrics();
  const target=new URLSearchParams(location.search).get("group");
  group=catalog.groups.some(g=>g.id===target) || target==="issues" ? target : "fees";
  selectGroup(group);
  if(entry.has_expected) for(const g of ["fees","checks","balances","identity","evidence","template"]) requestGroup(g);
}
function selectGroup(id) {
  clearTimeout(searchTimer);
  group=id;offset=0;rowQuery="";$("row-search").value="";pageData=null;
  const url=new URL(location.href);url.searchParams.set("bill",entry.id);url.searchParams.set("group",id);history.replaceState(null,"",url);
  $("group-title").textContent=id==="issues"?"运行异常":catalog.groups.find(g=>g.id===id).label;
  $("group-description").textContent=descriptions[id];
  $("export").href="/api/export?"+params();$("export").classList.toggle("hidden",id==="issues");
  $("row-search").disabled=id==="issues";$("scope").textContent="";readNote();renderTabs();
  const detail=catalog.groups.find(g=>g.id===id)?.kind==="table";
  document.querySelector('[data-filter="all"]').classList.toggle("hidden",detail || id==="issues");
  document.querySelector('.filters').classList.toggle("hidden",id==="issues");
  if(detail){filter="diff";document.querySelectorAll('[data-filter]').forEach(el=>el.classList.toggle("selected",el.dataset.filter==="diff"));}
  if(id==="issues"){loadIssues();return;}
  if(!entry.has_expected){$("comparison").innerHTML='<div class="error-state">缺少匹配的预期表，无法开始核对。</div>';$("group-status").innerHTML='<span class="pill pending">缺少预期表</span>';$("pagination").classList.add("hidden");return;}
  showLoading();requestGroup(id,true);
}
function showLoading() {
  $("comparison").innerHTML='<div class="loading"><span class="spinner"></span>正在核对，请稍候…<br><small>读取 Excel 后按业务编号匹配，首次明细核对可能需要几十秒。</small></div>';
  $("group-status").innerHTML='<span class="pill pending">核对中</span>';$("pagination").classList.add("hidden");
}
async function requestGroup(id,visible=false) {
  if(!entry?.has_expected)return;
  if(timers.has(id)){if(!visible)return;clearTimeout(timers.get(id));timers.delete(id);}
  const gen=generation;const queryKey=`${filter}|${offset}|${rowQuery}`;
  const current=id===group;
  try {
    const data=await api("/api/compare?"+params(id,current?{status:filter,offset,q:rowQuery,limit:100}:{}));
    if(gen!==generation)return;
    if(current && queryKey!==`${filter}|${offset}|${rowQuery}`){requestGroup(id,true);return;}
    results.set(id,data);renderTabs();updateMetrics();
    if(data.state==="loading") {
      const timer=setTimeout(()=>{timers.delete(id);requestGroup(id);},1200);timers.set(id,timer);
    }
    if(id===group) {
      if(!current){requestGroup(id,true);return;}
      if(data.state==="ready") {pageData=data;renderComparison(data);}
      else if(data.state==="error"){$("comparison").innerHTML=`<div class="error-state">${esc(data.error)}</div>`;$("group-status").innerHTML='<span class="pill diff">核对失败</span>';}
    }
  } catch(error) {
    if(gen!==generation)return;
    results.set(id,{state:"error",error:error.message});renderTabs();updateMetrics();
    if(id===group){$("comparison").innerHTML=`<div class="error-state">${esc(error.message)}<br>可点击“重新读取”重试。</div>`;$("group-status").innerHTML='<span class="pill diff">读取失败</span>';}
  }
}
function valueCell(value,field) {
  if(value===null || value===undefined)return '<span class="null">空值</span>';
  const monetary=num(value) && !/单号|流水号|编号|编码|ID/.test(field);
  const display=monetary?fmt(value):String(value);
  return `<div class="value ${monetary?"numeric":""} ${display.length>150?"cell-preview":""}">${esc(display)}</div>${display.length>150?'<button class="cell-button" data-expand>展开内容</button>':""}`;
}
function renderComparison(data) {
  $("diff-count").textContent=data.different;$("all-count").textContent=data.differences_only?"差异清单":data.total;
  $("group-status").innerHTML=`<span class="pill ${data.different?"diff":"same"}">${data.different?`${data.different} 项差异`:"本项目一致"}</span>`;
  if(!data.items.length) {
    const noMatch=!!rowQuery;
    $("comparison").innerHTML=`<div class="success-empty">${noMatch?"":'<span class="checkmark">✓</span>'}${noMatch?"没有匹配的核对项":data.different===0?"本项目未发现差异":filter==="same"?"当前列表没有一致项目":"当前筛选下没有记录"}${data.differences_only?`<br><small>已逐项比较 ${Number(data.checked_cells).toLocaleString()} 个单元格；明细页仅存储差异记录。</small>`:""}</div>`;
  } else {
    $("comparison").innerHTML=`<div class="table-wrap"><table><thead><tr><th>项目 / 业务编号</th><th>字段</th><th>预期值</th><th>实际值</th><th>实际 − 预期</th><th>核对结论</th></tr></thead><tbody>${data.items.map(r=>`<tr class="row-${r.status}"><td class="item-label">${esc(r.label)}${r.account?`<small>${esc(r.account)}</small>`:""}${group==="fees" && r.status==="diff"?`<button class="cell-button" data-drill="${esc(r.label)}">查看相关资金差异 →</button>`:""}</td><td>${esc(r.field)}</td><td>${valueCell(r.expected,r.field)}<div class="location" title="${esc(r.expected_location)}">${esc(r.expected_location)}</div></td><td class="value-actual">${valueCell(r.actual,r.field)}<div class="location" title="${esc(r.actual_location)}">${esc(r.actual_location)}</div></td><td class="delta ${r.status==="same"?"green":""}">${r.delta===null?"—":(Number(r.delta)>0?"+":"")+fmt(r.delta)}</td><td><span class="pill ${r.status}">${r.status==="same"?"一致":"不一致"}</span>${r.reason?`<div class="reason">${esc(r.reason)}</div>`:""}</td></tr>`).join("")}</tbody></table></div>`;
  }
  $("pagination").classList.toggle("hidden",data.filtered<=100);
  $("page-info").textContent=`第 ${data.filtered?data.offset+1:0}–${Math.min(data.offset+data.items.length,data.filtered)} 项，共 ${data.filtered.toLocaleString()} 项`;
  $("prev").disabled=data.offset===0;$("next").disabled=data.offset+data.items.length>=data.filtered;
  const notes=[];
  if(data.differences_only)notes.push(`预期 ${data.expected_rows.toLocaleString()} 行 · 实际 ${data.actual_rows.toLocaleString()} 行 · 已比较 ${data.checked_cells.toLocaleString()} 个单元格 · 业务键：${data.key_fields.join("＋")||"原始行号"} · 预期重复业务键 ${data.duplicate_keys} 组。`);
  if(data.note)notes.push(data.note);
  if(group==="template")notes.push("模版内的历史示例数据不作为金额基准；金额预期来自匹配的预期结果表。公式文本按模版原样比较。");
  if(["fees","checks","balances"].includes(group))notes.push("Excel 公式使用文件中已保存的计算缓存。这里不会重算公式；缺失缓存按空值显示。预期表浮点尾差按分四舍五入。");
  if(data.sheets)notes.push(`<details class="sheet-info"><summary>工作表清单：预期 ${data.sheets.expected.length} 个 / 实际 ${data.sheets.actual.length} 个</summary><div>预期：${data.sheets.expected.map(esc).join("、")}</div><div>实际：${data.sheets.actual.map(esc).join("、")}</div><div>新增工作表列在此处供查看，核对范围以本页项目为准。</div></details>`);
  $("scope").innerHTML=notes.map(n=>`<div>${n}</div>`).join("");
  $("last-checked").textContent="核对时间 "+(data.compared_at||"").replace("T"," ");
}
async function loadIssues() {
  const gen=generation;showLoading();
  try {
    const data=await api("/api/issues?"+params());if(gen!==generation || group!=="issues")return;
    $("pagination").classList.add("hidden");$("diff-count").textContent=data.issues.length;$("all-count").textContent=data.issues.length;
    $("group-status").innerHTML=`<span class="pill ${data.issues.length?"diff":"pending"}">${data.available?`运行状态：${esc(data.context.conclusion||"未记录")}`:"无运行异常文件"}</span>`;
    if(!data.available){$("comparison").innerHTML='<div class="success-empty">此运行目录没有 result.json，无法读取运行异常。可继续核对 Excel。</div>';return;}
    const translations={unmapped_scene:"费用场景未匹配",missing_balance:"缺少余额证据",unmapped_category:"费用类型未匹配",missing_monthly_balance:"缺少月度余额",unmapped_deposit_operation:"保证金操作未匹配"};
    $("comparison").innerHTML=`<div class="issues-summary">${data.checks.map(c=>`<div>${esc(c["项目"])}：<b>${esc(c["状态"])}</b>${c["差异"]!==null?` · 差额 ${fmt(c["差异"])} 元`:""}</div>`).join("")}</div><div class="table-wrap"><table><thead><tr><th>异常类型</th><th>场景 / 账户</th><th>金额</th><th>说明</th><th>来源</th></tr></thead><tbody>${data.issues.map(r=>`<tr><td>${esc(translations[r.code]||r.code)}<div class="inline-code">${esc(r.code)}</div></td><td>${esc(r.scene||r.account||r.category||"—")}</td><td>${r.amount===undefined?"—":fmt(r.amount)}</td><td>${esc(r.message)}</td><td class="location">${esc(r.source?.sheet||"")}${r.source?.row?`! 第 ${esc(r.source.row)} 行`:""}</td></tr>`).join("")}</tbody></table></div>`;
    $("scope").textContent="这些异常由原运行程序记录。修正输入或规则并重新运行后，点击“重新读取”查看最新账单。";
  }catch(error){if(gen===generation && group==="issues")$("comparison").innerHTML=`<div class="error-state">${esc(error.message)}</div>`;}
}
async function openFile(side) {
  if(!entry || (side==="expected" && !entry.has_expected))return;
  const button=$("open-"+side);button.disabled=true;
  try{await api("/api/open",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:entry.id,side})});toast(`已用系统默认表格应用打开${side==="expected"?"预期表":"最新结果"}`);}
  catch(error){toast(error.message+"；可展开文件路径后手动打开。");}
  finally{button.disabled=false;}
}

$("shop-search").addEventListener("input",renderCatalog);
$("catalog").addEventListener("click",e=>{const b=e.target.closest("[data-entry]");if(b)selectEntry(b.dataset.entry);});
$("tabs").addEventListener("click",e=>{const b=e.target.closest("[data-group]");if(b)selectGroup(b.dataset.group);});
$("rescan").addEventListener("click",loadCatalog);
$("open-expected").addEventListener("click",()=>openFile("expected"));$("open-actual").addEventListener("click",()=>openFile("actual"));
$("show-paths").addEventListener("click",()=>{$("file-paths").classList.toggle("hidden");$("show-paths").textContent=$("file-paths").classList.contains("hidden")?"查看文件路径":"收起文件路径";});
$("check-all").addEventListener("click",()=>{for(const g of catalog.groups)requestGroup(g.id);toast("所有核对项目已加入队列，可切换标签查看进度。");});
document.querySelector(".stat.danger").addEventListener("click",()=>selectGroup("fees"));
document.querySelector(".filters").addEventListener("click",e=>{
  const b=e.target.closest("[data-filter]");if(!b)return;filter=b.dataset.filter;offset=0;
  document.querySelectorAll("[data-filter]").forEach(el=>el.classList.toggle("selected",el===b));
  if(group!=="issues")requestGroup(group,true);
});
$("row-search").addEventListener("input",()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{rowQuery=$("row-search").value;offset=0;requestGroup(group,true);},220);});
$("prev").addEventListener("click",()=>{offset=Math.max(0,offset-100);requestGroup(group,true);});
$("next").addEventListener("click",()=>{offset+=100;requestGroup(group,true);});
$("comparison").addEventListener("click",e=>{
  if(e.target.hasAttribute("data-expand")){e.target.previousElementSibling.classList.toggle("expanded");e.target.textContent=e.target.previousElementSibling.classList.contains("expanded")?"收起内容":"展开内容";}
  if(e.target.hasAttribute("data-drill")){
    const category=e.target.dataset.drill;selectGroup("processed");rowQuery=category;$("row-search").value=category;requestGroup("processed",true);
    $("group-title").scrollIntoView({behavior:"smooth",block:"start"});
  }
});
$("review-note").addEventListener("input",()=>{
  if(!notesAvailable)return;
  const key=noteKey(),value=$("review-note").value;
  try{localStorage.setItem(key,value);$("note-status").textContent="备注已保存在当前浏览器";}
  catch{$("note-status").textContent="保存失败，请复制备注留存";}
});
$("export").addEventListener("click",e=>{if(results.get(group)?.state!=="ready"){e.preventDefault();toast("请等待本项目核对完成后再导出。");}});
document.addEventListener("keydown",e=>{
  if(e.ctrlKey||e.metaKey||e.altKey||e.isComposing||["INPUT","TEXTAREA","SELECT"].includes(document.activeElement.tagName)||document.activeElement.isContentEditable)return;
  if(e.key.toLowerCase()==="p"){e.preventDefault();openFile("expected");}
  if(e.key.toLowerCase()==="o"){e.preventDefault();openFile("actual");}
});
loadCatalog();
