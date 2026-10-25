import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
const {exportShopProducts} = await import(process.env.SHOP_EXPORT_MODULE || '../src/shop-products-export.js');
const session = {cookies: []};
const payload = Buffer.concat([Buffer.from([0x50,0x4b,0x03,0x04]), Buffer.alloc(2000)]);

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'shop-night-regression-'));
  t.after(() => rmSync(dir, {recursive:true,force:true}));
  const inventoryPath = join(dir, 'inventory.sqlite');
  const db = new DatabaseSync(inventoryPath);
  db.exec("CREATE TABLE shop_directory(shop_id TEXT); INSERT INTO shop_directory VALUES('1'),('2')");db.close();
  const planPath = join(dir, 'plan.json');
  writeFileSync(planPath, JSON.stringify({batches:[{shops:['1','2']}]}));
  return {inventoryPath,planPath,outputDir:join(dir,'published')};
}

test('over-limit batch is split without losing or repeating any shops', async t => {
  const f = fixture(t), requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options={}) => {
    if (String(url).includes('MapExport.aspx')) {
      const shops = new URLSearchParams(options.body).get('shop_id');requests.push(shops);
      if (shops.includes(',')) return new Response("window.alert('导出数量超出最大限制：100 万条')", {status:200});
      return new Response('', {status:302,headers:{location:`https://files.example/${shops}.xlsx`}});
    }
    return new Response(payload);
  });
  const result = await exportShopProducts({session,...f});
  assert.equal(result.batch_count,2);
  assert.deepEqual(requests,['1,2','1','2']);
  const m = JSON.parse(readFileSync(join(f.outputDir,'manifest.json'),'utf8'));
  assert.deepEqual(m.files.flatMap(x=>x.shops), ['1','2']);
});

test('single-shop limit still fails and preserves the previous published export', async t => {
  const f = fixture(t);
  writeFileSync(f.planPath,JSON.stringify({batches:[{shops:['1']},{shops:['2']}]}));
  const {mkdirSync} = await import('node:fs');mkdirSync(f.outputDir);writeFileSync(join(f.outputDir,'old'),'keep');
  t.mock.method(globalThis,'fetch',async()=>new Response("window.alert('导出数量超出最大限制：100 万条')",{status:200}));
  await assert.rejects(exportShopProducts({session,...f}), e=>e.code==='shop_products_export_failed');
  assert.equal(readFileSync(join(f.outputDir,'old'),'utf8'),'keep');
  assert.equal(existsSync(join(f.outputDir+'.building','checkpoint.json')),true);
  assert.equal(existsSync(join(f.outputDir+'.building','manifest.json')),false);
});

test('night execution needs the shop-products-specific allowance', async t => {
  const f=fixture(t);
  const old = Object.fromEntries(['JST_AUTOMATED','JST_MANUAL','JST_SHOP_PRODUCTS_NIGHT'].map(k=>[k,process.env[k]]));
  t.after(()=>{for(const [k,v] of Object.entries(old)) v===undefined?delete process.env[k]:process.env[k]=v;});
  process.env.JST_AUTOMATED='1';delete process.env.JST_MANUAL;delete process.env.JST_SHOP_PRODUCTS_NIGHT;
  t.mock.timers.enable({apis:['Date'],now:new Date('2026-10-20T17:00:00Z').getTime()});
  t.mock.method(globalThis,'fetch',async url=>String(url).includes('MapExport.aspx')?new Response('',{status:302,headers:{location:'https://files.example/night.xlsx'}}):new Response(payload));
  await assert.rejects(exportShopProducts({session,...f}),e=>e.code==='quiet_hours');
  process.env.JST_SHOP_PRODUCTS_NIGHT='1';
  const result=await exportShopProducts({session,...f});
  assert.equal(result.batch_count,1);
});
