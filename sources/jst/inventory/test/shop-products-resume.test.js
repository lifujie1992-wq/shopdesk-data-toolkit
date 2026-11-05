import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,readdirSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
const {exportShopProducts}=await import(process.env.SHOP_EXPORT_MODULE || '../src/shop-products-export.js');
const session={cookies:[]};
const payload=Buffer.concat([Buffer.from([0x50,0x4b,0x03,0x04]),Buffer.alloc(2000)]);
function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'shop-products-resume-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const inventoryPath=join(dir,'inventory.sqlite');const db=new DatabaseSync(inventoryPath);
  db.exec("CREATE TABLE shop_directory(shop_id TEXT);INSERT INTO shop_directory VALUES('1'),('2')");db.close();
  const planPath=join(dir,'plan.json');writeFileSync(planPath,JSON.stringify({batches:[{shops:['1']},{shops:['2']}]}));
  const outputDir=join(dir,'published');mkdirSync(outputDir);writeFileSync(join(outputDir,'previous'),'keep');
  return {dir,inventoryPath,planPath,outputDir,retryDelaysMs:[0,0]};
}
function server(t, state) {
  t.mock.method(globalThis,'fetch',async(url,options={})=>{
    if (String(url).includes('MapExport.aspx')) {
      const shop=new URLSearchParams(options.body).get('shop_id');state.requests.push(shop);
      if(state.limit && shop.includes(',')) return new Response("window.alert('导出数量超出最大限制：100 万条')",{status:200});
      if(state.fail && shop==='2') return new Response('service not available',{status:400});
      return new Response('',{status:302,headers:{location:`https://files.example/shop-${shop}.xlsx`}});
    }
    return new Response(payload);
  });
}
async function partial(t,f,state) {
  server(t,state);await assert.rejects(exportShopProducts({session,...f}));
  assert.equal(readFileSync(join(f.outputDir,'previous'),'utf8'),'keep');
  const cp=join(f.outputDir+'.building','checkpoint.json');assert.equal(existsSync(cp),true);
  assert.equal(JSON.parse(readFileSync(cp,'utf8')).files.length,1);return cp;
}
test('resume reuses the hashed first batch and only requests the unfinished batch',async t=>{
  const f=fixture(t),state={requests:[],fail:true};await partial(t,f,state);
  state.fail=false;state.requests.length=0;
  const result=await exportShopProducts({session,...f});assert.deepEqual(state.requests,['2']);assert.equal(result.files,2);
  const m=JSON.parse(readFileSync(join(f.outputDir,'manifest.json'),'utf8'));
  assert.deepEqual(m.files.flatMap(x=>x.shops),['1','2']);assert.ok(m.files.every(x=>/^[a-f0-9]{64}$/.test(x.sha256)));
});
test('resume validates file hashes before making further source requests',async t=>{
  const f=fixture(t),state={requests:[],fail:true};const cp=await partial(t,f,state);
  const saved=JSON.parse(readFileSync(cp,'utf8'));writeFileSync(join(f.outputDir+'.building',saved.files[0].name),'changed');
  state.fail=false;state.requests.length=0;
  await assert.rejects(exportShopProducts({session,...f}),e=>e.code==='invalid_shop_products_checkpoint');assert.deepEqual(state.requests,[]);
});
test('changed scope and expired checkpoints cannot be reused',async t=>{
  const f=fixture(t),state={requests:[],fail:true};const cp=await partial(t,f,state);state.requests.length=0;
  writeFileSync(f.planPath,JSON.stringify({batches:[{shops:['2']},{shops:['1']}]}));
  await assert.rejects(exportShopProducts({session,...f}),e=>e.code==='shop_products_resume_mismatch');
  writeFileSync(f.planPath,JSON.stringify({batches:[{shops:['1']},{shops:['2']}]}));
  const saved=JSON.parse(readFileSync(cp,'utf8'));saved.created_at=new Date(Date.now()-13*3600_000).toISOString();writeFileSync(cp,JSON.stringify(saved));
  await assert.rejects(exportShopProducts({session,...f}),e=>e.code==='shop_products_resume_mismatch');assert.deepEqual(state.requests,[]);
});
test('splitting a batch survives a later failure without redoing completed children',async t=>{
  const f=fixture(t),state={requests:[],fail:true,limit:true};writeFileSync(f.planPath,JSON.stringify({batches:[{shops:['1','2']}]}));
  await partial(t,f,state);assert.deepEqual(state.requests,['1,2','1','2']);state.requests.length=0;state.fail=false;
  await exportShopProducts({session,...f});assert.deepEqual(state.requests,['2']);
});
test('transient export and download errors retry with a bounded attempt count',async t=>{
  const f=fixture(t);let exports=0,downloads=0;
  t.mock.method(globalThis,'fetch',async url=>{
    if(String(url).includes('MapExport.aspx')) {exports++;return exports===1?new Response('busy',{status:503}):new Response('',{status:302,headers:{location:`https://files.example/${exports}.xlsx`}});}
    downloads++;return downloads===1?new Response('busy',{status:503}):new Response(payload);
  });
  await exportShopProducts({session,...f});assert.equal(exports,3);assert.equal(downloads,3);
});
test('persistent transient errors stop after three attempts and keep completed batches',async t=>{
  const f=fixture(t);let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response('busy',{status:503});});
  await assert.rejects(exportShopProducts({session,...f}),e=>e.code==='shop_products_export_failed');
  assert.equal(calls,3);assert.equal(readFileSync(join(f.outputDir,'previous'),'utf8'),'keep');
  assert.equal(existsSync(join(f.outputDir+'.building','checkpoint.json')),true);
});
test('login errors are reported without repeated export submissions',async t=>{
  const f=fixture(t);let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response('用户未登录');});
  await assert.rejects(exportShopProducts({session,...f}),e=>e.code==='not_logged_in');assert.equal(calls,1);
});
test('connection resets retry the failed request before continuing',async t=>{
  const f=fixture(t);let calls=0;
  t.mock.method(globalThis,'fetch',async url=>{
    if(String(url).includes('MapExport.aspx')) {
      calls++;
      if(calls===1)throw Object.assign(Error('connection reset'),{code:'ECONNRESET'});
      return new Response('',{status:302,headers:{location:`https://files.example/${calls}.xlsx`}});
    }
    return new Response(payload);
  });
  await exportShopProducts({session,...f});assert.equal(calls,3);
});
test('an unconfirmed file from an interrupted checkpoint is preserved outside the published files',async t=>{
  const f=fixture(t),state={requests:[],fail:true};await partial(t,f,state);
  writeFileSync(join(f.outputDir+'.building','unconfirmed.xlsx'),payload);state.fail=false;
  await exportShopProducts({session,...f});
  assert.equal(existsSync(join(f.outputDir,'unconfirmed.xlsx')),false);
  assert.ok(readdirSync(f.dir).some(n=>n.startsWith('published.building.unconfirmed-')));
});
test('a new job recovers a fresh failed job with the exact account and export scope',async t=>{
  const f=fixture(t),state={requests:[],fail:true};const resumeRoot=join(f.dir,'work');
  const old=join(resumeRoot,'8ae60276-946c-48ac-980c-66bff7e5701b','shop-products-export');mkdirSync(join(old,'..'),{recursive:true});renameSync(f.outputDir,old);f.outputDir=old;
  const cp=await partial(t,f,state);const saved=JSON.parse(readFileSync(cp,'utf8'));saved.owner_pid=99999999;writeFileSync(cp,JSON.stringify(saved));
  const outputDir=join(resumeRoot,'afd5616b-d45a-49d8-8a07-69ea4fce9fb7','shop-products-export');mkdirSync(join(outputDir,'..'),{recursive:true});state.fail=false;state.requests.length=0;
  await exportShopProducts({session,...f,outputDir,resumeRoot});assert.deepEqual(state.requests,['2']);
  assert.equal(readFileSync(join(old,'previous'),'utf8'),'keep');assert.equal(existsSync(old+'.building'),false);
});
test('a new job never takes files from a live collector',async t=>{
  const f=fixture(t),state={requests:[],fail:true};const resumeRoot=join(f.dir,'work');
  const old=join(resumeRoot,'8ae60276-946c-48ac-980c-66bff7e5701b','shop-products-export');mkdirSync(join(old,'..'),{recursive:true});renameSync(f.outputDir,old);f.outputDir=old;
  await partial(t,f,state);
  const outputDir=join(resumeRoot,'afd5616b-d45a-49d8-8a07-69ea4fce9fb7','shop-products-export');mkdirSync(join(outputDir,'..'),{recursive:true});state.fail=false;state.requests.length=0;
  await exportShopProducts({session,...f,outputDir,resumeRoot});assert.deepEqual(state.requests,['1','2']);assert.equal(existsSync(old+'.building'),true);
});
