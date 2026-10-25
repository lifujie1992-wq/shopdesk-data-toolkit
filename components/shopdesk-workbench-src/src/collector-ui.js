(()=>{
 let catalog=[],jobs=[],selected='builtin:experience';
 const fmt=(v,f)=>v===null||v===undefined?'—':f==='date'?new Date(v).toLocaleString('zh-CN'):f==='money'&&typeof v==='number'?'¥'+v.toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2}):String(v);
 function draw(){
  $('#collectorButtons').innerHTML=catalog.map(c=>{const j=jobs.find(j=>j.key===c.key),busy=j?.status==='running';return `<article class="collector-card ${selected===c.key?'active':''}"><button class="collector-select" data-collector-select="${esc(c.key)}"><strong>${esc(c.title)}</strong><span>${esc(c.description)}</span></button><div><small>${c.version?'模块 v'+esc(c.version):'全部已添加店铺'}</small><button ${busy?'disabled':''} data-collector-run="${esc(c.key)}">${busy?'查询中…':'查询最新'}</button>${busy?`<button data-collector-cancel="${esc(j.id)}">取消</button>`:''}</div></article>`}).join('');
  const c=catalog.find(c=>c.key===selected),j=jobs.find(j=>j.key===selected),r=j?.result;
  $('#collectorResultTitle').textContent=c?.title||j?.title||'查询结果';$('#collectorResultScope').textContent=c?.description||j?.description||'';
  $('#collectorResultBadge').textContent=!j?'尚未查询':({running:'正在查询',done:'查询完成',cancelled:'已取消',error:'查询失败',interrupted:'上次运行中断'})[j.status]||j.status;
  $('#collectorProgress').textContent=j?.status==='running'?`${j.stage}${j.total?' · '+j.completed+' / '+j.total+' 家':''}`:j?.error?privateText(j.error):'';
  $('#collectorResultMeta').textContent=r?`${r.success??0} / ${r.shop_count??0} 家成功 · 耗时 ${(r.total_seconds??j.duration_seconds??0).toFixed(2)} 秒 · 采集于 ${new Date(r.captured_at||j.finished_at).toLocaleString('zh-CN')}${r.period?' · 申请时间 '+new Date(r.period.start).toLocaleDateString('zh-CN')+' 至 '+new Date(r.period.end).toLocaleDateString('zh-CN'):''}${typeof r.total_count==='number'?' · 成功店铺合计 '+r.total_count+' 条':''}`:'';
  const cols=j?.columns||c?.columns||[];$('#collectorResultHead').innerHTML=r?'<tr><th>店铺</th>'+cols.map(col=>'<th>'+esc(col.label)+'</th>').join('')+'<th>状态</th></tr>':'';
  const rows=r?.results||[];$('#collectorResultBody').innerHTML=rows.map(row=>`<tr><td><strong>${esc(shopName(row.name))}</strong></td>${cols.map(col=>`<td>${row.status==='ok'?esc(fmt(row[col.key],col.format)):'—'}</td>`).join('')}<td class="${row.status==='ok'?'result-ok':'result-error'}">${row.status==='ok'?'已更新':esc(privateText(row.error||'未取得数据'))}</td></tr>`).join('');
  $('#collectorEmpty').hidden=!!rows.length;$('#collectorEmpty').textContent=j?.status==='running'?'正在后台采集，你可以继续操作其他页面。':j?.status==='done'?'没有符合平台条件的店铺。':j?.error?'本次未得到结果，请处理提示后重试。':'点击「查询最新」获取数据。';
  renderWorklist();
 }
 function worklistRows(r){const out=[];for(const shop of (r?.results||[]))for(const it of (shop.candidates||[]))out.push({shop:shop.name,shop_id:shop.shop_id,...it});return out}
 function flygeCell(row,i){
  if(row.flyge_error)return '<span class="wl-warn">核查失败</span>';
  if(row.flyge_checked){
   if(row.flyge_ready===false)return `<span class="wl-warn">未加载</span> <button data-flyge="${i}">查看</button>`;
   return row.flyge_has_chat?`<span class="wl-bad">买家留言 ${row.flyge_buyer_count} 条</span> <button data-flyge="${i}">查看</button>`:`<span class="wl-ok">买家未联系</span> <button data-flyge="${i}">查看</button>`;
  }
  return row.flyge_url?`<button data-flyge="${i}">飞鸽</button>`:'—';
 }
 function renderWorklist(){
  const box=$('#collectorWorklist');if(!box)return;box.__rows=[];
  const j=jobs.find(x=>x.key===selected),r=j?.result;
  const isQuality=selected==='builtin:quality_returns',isReview=selected==='builtin:negative_reviews';
  if(!(isQuality||isReview)||!r){box.innerHTML='';return}
  const rows=worklistRows(r),total=r.total_candidates||rows.length;
  box.innerHTML=`<div class="worklist-head"><h3>申诉工单</h3><small>候选 ${total} 条</small></div>`
   +`<p class="metricNote">明细太多，已移到本地网页查看（标注「可申诉 / 已申诉」，可筛选搜索）。</p>`
   +`<div class="worklist-tools"><button class="primary" data-open-appeal="1">打开申诉工单</button><button data-flyge-check="1">自动核查飞鸽</button><button data-appeal-run="1">立即自动申诉</button></div>`
   +`<div id="flygeProgress" class="metricNote"></div>`;
 }
 window.renderCollectorResults=draw;
 document.querySelector('#collectorWorklist').onclick=e=>{const open=e.target.closest('[data-open-appeal]'),fc=e.target.closest('[data-flyge-check]'),ar=e.target.closest('[data-appeal-run]');if(open)run(()=>window.shops.openAppealWeb());if(fc)run(async()=>{fc.disabled=true;$('#flygeProgress').textContent='飞鸽核查中，请稍候…';try{const res=await window.shops.flygeCheck(selected);$('#flygeProgress').textContent='飞鸽核查完成：共 '+res.checked+' 条';}catch(err){$('#flygeProgress').textContent='核查失败：'+privateText(err.message)}finally{fc.disabled=false}});if(ar)run(async()=>{ar.disabled=true;$('#flygeProgress').textContent='自动申诉已启动（后台运行，约几分钟），完成后点「打开申诉工单」查看。';try{await window.shops.appealStart({kinds:[selected==='builtin:negative_reviews'?'reviews':'quality'],submit:true})}catch(err){$('#flygeProgress').textContent='启动失败：'+privateText(err.message)}finally{ar.disabled=false}})};
 window.shops.onFlygeProgress?.(d=>{const p=document.querySelector('#flygeProgress');if(p)p.textContent='飞鸽核查中 '+d.done+' / '+d.total+' …'});
 window.refreshCollectors=async()=>{try{const [c,j]=await Promise.all([window.shops.collectors(),window.shops.collectorJobs()]);catalog=c.capabilities;jobs=j.jobs;if(!catalog.some(c=>c.key===selected))selected=catalog[0]?.key;$('#collectorModuleList').textContent=c.modules.map(m=>m.title+' v'+m.version).join(' · ');draw()}catch(e){$('#collectorModuleStatus').textContent=privateText(e.message)}};
 $('#collectorButtons').onclick=e=>{const select=e.target.closest('[data-collector-select]'),start=e.target.closest('[data-collector-run]'),cancel=e.target.closest('[data-collector-cancel]');if(select){selected=select.dataset.collectorSelect;draw()}if(start)run(async()=>{selected=start.dataset.collectorRun;const j=await window.shops.startCollector(selected);jobs=[j,...jobs.filter(x=>x.key!==selected)];draw()});if(cancel)run(()=>window.shops.cancelCollector(cancel.dataset.collectorCancel))};
 window.shops.onCollectorJobs(s=>{jobs=s.jobs;draw()});
 $('#reloadCollectors').onclick=()=>run(async()=>{await window.refreshCollectors();$('#collectorModuleStatus').textContent='已重新加载，下次查询使用最新模块。'});
 $('#importCollectors').onclick=()=>run(async()=>{$('#importCollectors').disabled=true;try{const r=await window.shops.importCollectors();if(!r.cancelled){await window.refreshCollectors();$('#collectorModuleStatus').textContent='模块已生效，无需重启。'}}finally{$('#importCollectors').disabled=false}});
 window.refreshCollectors();
})();
