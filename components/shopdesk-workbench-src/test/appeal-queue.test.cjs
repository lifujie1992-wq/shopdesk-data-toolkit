const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const policy = require('../src/appeal-queue-policy');
const now = Date.parse('2026-10-25T12:00:00+08:00');
const review = (id, date='2026-10-24', level='差评') => ({order_id:String(id), kind:'review', shop_id:'s1', comment_date:date, level});

test('主数据和最新日志覆盖过时的候选、临时跳过名单；pending 进入终态', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appeal-queue-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  const data=path.join(dir,'business-data'), reports=path.join(dir,'appeal-reports');
  fs.mkdirSync(data); fs.mkdirSync(reports);
  const write=(dir,name,value)=>fs.writeFileSync(path.join(dir,name),JSON.stringify(value));
  write(data,'appeal-worklist-quality_returns-old.json',[{order_id:'q',apply_date:'2026-10-24',appealable:true}]);
  write(data,'quality-all-latest.json',[{order_id:'q',apply_date:'2026-10-24',appealable:false}]);
  write(data,'reviews-all-latest.json',[review('r'),review('success'),review('failed')]);
  write(reports,'skipped.json',{r:{reason:'飞鸽登录失效'}});
  write(reports,'appeal-test.json',{log:[{order:'r',at:'2026-10-24T01:00:00Z',reason:'不可举报'}]});
  write(reports,'results.json',{map:{success:{auditStatus:6},failed:{auditStatus:3}}});
  const master=policy.loadMaster(data,reports);
  const queue={items:Object.fromEntries(['q','r','success','failed'].map(id=>[id,{order_id:id,status:'pending',date:''}]))};
  policy.reconcilePending(queue,master,30,now);
  for(const it of Object.values(queue.items)) assert.equal(it.status,'gone');
  assert.equal(queue.items.q.goneReason,'不可申诉');
  assert.equal(queue.items.r.goneReason,'不可举报');
  assert.equal(queue.items.success.goneReason,'举报成功');
  assert.equal(queue.items.failed.goneReason,'举报失败');
  assert.equal(policy.reconcilePending(queue,master,30,now),0);
});

test('用业务日期过滤：边界、旧单、未知日期及秒时间戳', () => {
  assert.equal(policy.eligibility(review('r'),30,now),'');
  assert.match(policy.eligibility(review('r','2026-09-01'),30,now),/超过/);
  assert.match(policy.eligibility(review('r',''),30,now),/缺少/);
  assert.match(policy.eligibility({...review('r'),comment_time:(now-30*86400000)/1000},30,now),/超过/);
  assert.equal(policy.eligibility({...review('r'),comment_time:(now-30*86400000+1)/1000},30,now),'');
  assert.equal(policy.eligibility({kind:'quality',apply_date:'2026-10-24'},7,now),'');
  assert.match(policy.eligibility(review('r','2026-10-01'),7,now),/超过/);
});

test('1100 单跨店共用 50 条额度：差评优先，然后近期，已有稿不补写且不复活终态', () => {
  const candidates=Array.from({length:1100},(_,i)=>({...review(i,i<100?'2026-10-23':'2026-10-24',i<100?'差评':'中评'),shop_id:'s'+(i%4)}));
  const queue={items:{'0':{status:'pending'},'1':{status:'gone'},'2':{status:'submitted'},'3':{status:'rejected'},'100':{status:'confirmed'}}};
  candidates.push(review('newer','2026-10-25'));
  const out=policy.selectBatch(candidates,queue,new Map(),{maxNew:50,maxAgeDays:30},now);
  assert.equal(out.length,51); assert.equal(out[0].order_id,'100'); assert.equal(out[1].order_id,'newer');
  assert.equal(out.filter(c=>c.level==='差评').length,50);
  assert.ok(out.every(c=>!['0','1','2','3'].includes(c.order_id)));
  const limited=policy.selectBatch(candidates,queue,new Map(),{maxNew:50,maxAgeDays:30,maxPerShop:2},now);
  assert.equal(limited.length,9);
});

test('真实批次入口先清理终态，空批次不会打开店铺或提交；永久状态覆盖临时跳过', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'appeal-flow-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const data=path.join(root,'business-data'), reports=path.join(root,'appeal-reports');
  fs.mkdirSync(data); fs.mkdirSync(reports);
  fs.writeFileSync(path.join(data,'reviews-all-latest.json'),JSON.stringify([review('r')]));
  const qp=path.join(reports,'review-queue.json');
  fs.writeFileSync(qp,JSON.stringify({items:{r:{order_id:'r',status:'pending'}}}));
  fs.writeFileSync(path.join(reports,'skipped.json'),JSON.stringify({r:{reason:'飞鸽登录失效'}}));
  fs.writeFileSync(path.join(reports,'appeal-prior.json'),JSON.stringify({log:[{order:'r',reason:'不可举报',at:'2026-10-24T00:00:00Z'}]}));
  const mod={exports:{}};
  const source=fs.readFileSync(path.join(__dirname,'../src/appeal.js'),'utf8');
  vm.runInNewContext(source+'\nmodule.exports.saveSkip=saveSkip;',{
    module:mod,process:{env:process.env,nextTick:fn=>fn()},setTimeout,clearTimeout,URL,Buffer,
    require:name=> name==='electron'?{session:{},BrowserWindow:class {constructor(){throw Error('unexpected browser')}}}:
      name==='./appeal-queue-policy'?policy:require(name)
  });
  const appeal=mod.exports.createAppeal({app:{getPath:()=>root},store:{items:[]},jobs:{start:()=>{throw Error('offline')}}});
  const started=appeal.run({skipSync:true,reviewQueue:true,queueMaxAgeDays:30});
  assert.equal(started.started,true);
  for(let n=0;n<100&&appeal.snapshot().running;n++) await new Promise(r=>setTimeout(r,2));
  assert.equal(appeal.snapshot().running,false);
  assert.equal(JSON.parse(fs.readFileSync(qp)).items.r.status,'gone');
  assert.equal(appeal.snapshot().summary.failed,0);
  mod.exports.saveSkip('r','不可举报','s');
  assert.equal(JSON.parse(fs.readFileSync(path.join(reports,'skipped.json'))).r.reason,'不可举报');
  assert.ok(appeal.run({maxNewQueue:1000}).error);
});
