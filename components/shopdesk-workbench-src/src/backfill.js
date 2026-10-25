// 补跑商品名/商品编码：读历史工单文件 → 按店铺分组 → Python 接口匹配 → 回写文件
const fs = require('node:fs');
const path = require('node:path');
const {session} = require('electron');
const {builtinRoot} = require('./collectors');

function createBackfill({app, store}){
  const dataDir = () => path.join(app.getPath('userData'), 'business-data');
  const readJson = f => { try{ return JSON.parse(fs.readFileSync(f,'utf8')) }catch(e){ return null } };
  const cookieURL = 'https://fxg.jinritemai.com/';
  let state = {id:null, running:false, startedAt:null, finishedAt:null, log:[], summary:null};

  function persist(){
    if(!state.id) return;
    try{
      const dir = path.join(app.getPath('userData'), 'appeal-reports');
      fs.mkdirSync(dir, {recursive:true});
      fs.writeFileSync(path.join(dir, 'backfill-'+state.id+'.json'), JSON.stringify(state,null,2), {mode:0o600});
    }catch(e){}
  }
  const log = e => { state.log.push({at:new Date().toISOString(), ...e}); persist(); };

  function worklistFiles(){
    try{
      return fs.readdirSync(dataDir()).filter(f =>
        (f.startsWith('appeal-worklist-quality_returns-') || f.startsWith('appeal-worklist-negative_reviews-') || f.startsWith('reviews-all-')) && f.endsWith('.json')
      ).sort();
    }catch(e){ return [] }
  }

  function missingInfo(r){
    const name = String(r.product_name || '').trim();
    const pid = String(r.product_id || '').trim();
    return {name:!name, pid:!pid, any: !name || !pid};
  }

  function collectTargets(files){
    const shops = new Map();   // shopId -> {name, quality: Map, review: Set}
    for(const f of files){
      const recs = readJson(path.join(dataDir(), f));
      if(!Array.isArray(recs)) continue;
      for(const r of recs){
        const oid = r.order_id; if(!oid) continue;
        const shopId = r.shop_id; if(!shopId) continue;
        if(!missingInfo(r).any) continue;
        let s = shops.get(shopId);
        if(!s){ s = {name:r.shop||shopId, quality:new Map(), review:new Set()}; shops.set(shopId, s); }
        if(r.after_sale_id) s.quality.set(oid, r.after_sale_id);
        else s.review.add(oid);
        // 同一单号既在品退又在中差评时，品退的售后详情更准；中差评那边作为兜底
        if(r.after_sale_id) s.review.delete(oid);
      }
    }
    return shops;
  }

  function applyMatch(files, matched){
    let updatedFiles = 0, updatedRows = 0;
    const backupDir = path.join(dataDir(), 'backup-backfill-'+Date.now());
    for(const f of files){
      const fp = path.join(dataDir(), f);
      const recs = readJson(fp);
      if(!Array.isArray(recs)) continue;
      let changed = false;
      for(const r of recs){
        const m = matched[r.order_id];
        if(!m) continue;
        if(m.product_name && !String(r.product_name||'').trim()){ r.product_name = m.product_name; changed = true; updatedRows++; }
        if(m.product_id && !String(r.product_id||'').trim()){ r.product_id = m.product_id; changed = true; updatedRows++; }
      }
      if(changed){
        try{ fs.mkdirSync(backupDir, {recursive:true}); fs.copyFileSync(fp, path.join(backupDir, f)); }catch(e){}
        fs.writeFileSync(fp, JSON.stringify(recs, null, 1), {mode:0o600});
        updatedFiles++;
      }
    }
    return {updatedFiles, updatedRows, backupDir};
  }

  async function run({onlyMissing=true, dryRun=false, shopIds=null, maxOrdersPerShop=0}={}){
    if(state.running) return {error:'已有补跑任务在运行', id:state.id};
    state = {id:String(Date.now()), running:true, log:[], startedAt:new Date().toISOString(), finishedAt:null, summary:null};
    const files = worklistFiles();
    log({step:'读取工单文件', 文件数:files.length});
    const shopsMap = collectTargets(files);
    if(shopIds && Array.isArray(shopIds) && shopIds.length){ for(const k of [...shopsMap.keys()]) if(!shopIds.includes(k)) shopsMap.delete(k); }
    if(maxOrdersPerShop>0){ for(const s of shopsMap.values()){ if(s.quality.size>maxOrdersPerShop){ s.quality=new Map([...s.quality].slice(0,maxOrdersPerShop)); } if(s.review.size>maxOrdersPerShop){ s.review=new Set([...s.review].slice(0,maxOrdersPerShop)); } } }
    log({step:'待补店铺', 店铺数:shopsMap.size, 品退单: [...shopsMap.values()].reduce((n,s)=>n+s.quality.size,0), 中差评单: [...shopsMap.values()].reduce((n,s)=>n+s.review.size,0)});

    const shops = [];
    for(const [shopId, s] of shopsMap){
      const shop = store.items.find(x=>x.id===shopId);
      if(!shop || shop.platform!=='抖店'){ log({step:'跳过非抖店店铺', shop:shopId}); continue; }
      try{
        const ses = session.fromPartition('persist:shop-'+shopId);
        const cookies = await ses.cookies.get({url: cookieURL});
        if(!cookies.length){ log({step:'无登录态', shop:s.name}); continue; }
        shops.push({id:shopId, name:s.name, cookies, ua: ses.getUserAgent(),
          _targets: {quality: Object.fromEntries(s.quality), review: [...s.review]}});
      }catch(e){ log({step:'读取登录态失败', shop:s.name, err:String(e.message||e)}); }
    }
    log({step:'准备接口调用', 有效店铺:shops.length});

    let allMatched = {};
    if(shops.length){
      try{
        const python = require('./python-worker');
        const result = await python.call(
          {action:'backfill_products', shops, dataDir: dataDir()},
          {module:{root: builtinRoot(), entry:'worker.py'}, group:'agent', timeout: Math.max(60000, Math.ceil(shops.length/3)*90000)}
        );
        if(!result || !Array.isArray(result.results)) throw Error('采集模块未返回结果');
        for(const r of result.results){
          if(r.status!=='ok'){ log({step:'店铺补跑失败', shop:r.name, err:r.error}); continue; }
          allMatched = Object.assign(allMatched, r.matched||{});
          log({step:'店铺补跑完成', shop:r.name, 匹配:Object.keys(r.matched||{}).length, 未匹配:(r.missing||[]).length});
        }
      }catch(e){ log({step:'接口匹配异常', err:String(e.message||e)}); }
    }

    let applied = {updatedFiles:0, updatedRows:0};
    if(!dryRun){
      applied = applyMatch(files, allMatched);
      log({step:'回写完成', 更新文件:applied.updatedFiles, 更新行:applied.updatedRows, 备份目录:applied.backupDir});
    } else {
      log({step:'演练模式(未回写)', 将更新行: Object.keys(allMatched).length});
    }

    state.running = false; state.finishedAt = new Date().toISOString();
    state.summary = {matched:Object.keys(allMatched).length, updatedFiles:applied.updatedFiles, updatedRows:applied.updatedRows, backupDir:applied.backupDir, dryRun:!!dryRun};
    persist();
    return state.summary;
  }

  const snapshot = () => JSON.parse(JSON.stringify(state));
  return {run, snapshot};
}

module.exports = {createBackfill};
