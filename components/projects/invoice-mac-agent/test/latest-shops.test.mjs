import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createJobRunner} from '../job-runner.mjs';

const original = {job_id:'latest-job', leaseToken:'test-lease', lease_expires_at:'2099-01-01T00:00:00Z',
  payload:{shopId:'old-session',shopName:'霖优官方旗舰店',orderId:'order-1',amount:'79.80'}};
const shop = (id='latest-session',name='霖优官方旗舰店') => ({id,name,platform:'抖店'});
function fixture(t, listing, mode='auto') {
  const stagingDir=fs.mkdtempSync(path.join(os.tmpdir(),'latest-shops-'));t.after(()=>fs.rmSync(stagingDir,{recursive:true,force:true}));
  const calls={shops:0,queries:[],uploads:[],submits:[],reports:[],logs:[]};
  const driver={listShops:async()=>({shops:await listing(++calls.shops)}),
    invoiceList:async args=>{calls.queries.push(args);return {rows:args.status_desc==='done_blue'?[]:[{shop_order_id:'order-1',invoice_amount:'79.80',invoice_status:1,invoice_status_text:'待开票'}]};},
    invoiceUploadPdf:async args=>{calls.uploads.push(args);return {ok:true,key:'tos-test'};},
    invoiceSubmit:async args=>{calls.submits.push(args);return {ok:true,submitted:true};}};
  const runner=createJobRunner({cloud:{report:async r=>{calls.reports.push(r);return {}; }},driver,
    stage:async()=>({path:path.join(stagingDir,'latest-job','test.pdf'),size:100,sha256:'test'}),
    cfg:{submitMode:mode,stagingDir,leaseSoftDeadlineMs:60000},log:{info:e=>calls.logs.push(e),warn(){}}});
  return {runner,calls};
}
test('旧ID失效时按最新唯一同名抖店执行所有步骤，保留原任务归属',async t=>{
  const f=fixture(t,()=>[shop()]);await f.runner.run(structuredClone(original));
  assert.equal(f.calls.reports[0].state,'uploaded');
  for(const x of [...f.calls.queries,...f.calls.uploads,...f.calls.submits])assert.equal(x.shop_id,'latest-session');
  assert.equal(original.payload.shopId,'old-session');
  assert(f.calls.logs.some(x=>x.event==='shop_identity_resolved'&&x.resolved_shop_id==='latest-session'));
});
test('同一ID的店铺更名时使用shopdesk当前名称',async t=>{
  const f=fixture(t,()=>[shop('old-session','霖优官方旗舰店新名称')]);await f.runner.run(structuredClone(original));
  assert.equal(f.calls.reports[0].state,'uploaded');
});
test('旧ID缺失且同名存在多个登录时不猜测，不上传',async t=>{
  const f=fixture(t,()=>[shop('a'),shop('b')]);await f.runner.run(structuredClone(original));
  assert.equal(f.calls.reports[0].state,'retryable');assert.match(f.calls.reports[0].message,/多|歧义|唯一/);assert.equal(f.calls.uploads.length,0);
});
test('当前ID与任务店名分别指向不同店铺时禁止串店',async t=>{
  const f=fixture(t,()=>[shop('old-session','另一家店'),shop()]);await f.runner.run(structuredClone(original));
  assert.equal(f.calls.uploads.length,0);assert.equal(f.calls.submits.length,0);assert.notEqual(f.calls.reports[0].state,'uploaded');
});
test('同轮下一任务重新读取最新清单，不继续复用已删除的会话',async t=>{
  let latest='first-session';const f=fixture(t,()=>[shop(latest)]);
  await f.runner.run(structuredClone(original));latest='second-session';await f.runner.run(structuredClone(original));
  assert.deepEqual(f.calls.submits.map(x=>x.shop_id),['first-session','second-session']);
});
test('订单核对后登录发生变化时暂停上传，下一轮重新核对',async t=>{
  const f=fixture(t,n=>[shop(n===1?'latest-session':'another-session')]);await f.runner.run(structuredClone(original));
  assert.equal(f.calls.reports[0].state,'retryable');assert.equal(f.calls.uploads.length,0);assert.equal(f.calls.submits.length,0);
});
test('上传后登录发生变化时禁止最终提交',async t=>{
  const f=fixture(t,n=>[shop(n<=2?'latest-session':'another-session')]);await f.runner.run(structuredClone(original));
  assert.equal(f.calls.reports[0].state,'retryable');assert.equal(f.calls.uploads.length,1);assert.equal(f.calls.submits.length,0);
});
test('最新清单缺少店铺时保留可重试，不永久失败',async t=>{
  const f=fixture(t,()=>[]);await f.runner.run(structuredClone(original));
  assert.equal(f.calls.reports[0].state,'retryable');assert.equal(f.calls.uploads.length,0);
});
test('金额不符时即使最新店铺已定位也不得上传',async t=>{
  const f=fixture(t,()=>[shop()]);const j=structuredClone(original);j.payload.amount='999';await f.runner.run(j);
  assert.equal(f.calls.reports[0].state,'failed');assert.match(f.calls.reports[0].message,/金额不匹配/);assert.equal(f.calls.uploads.length,0);
});
