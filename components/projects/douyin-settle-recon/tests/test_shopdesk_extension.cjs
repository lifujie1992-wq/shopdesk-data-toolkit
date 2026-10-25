const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createFinanceExtension}=require('../shopdesk/finance-extension.cjs');
function setup(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'finance-extension-test-'));
 const session=new EventEmitter();
 const owner={id:'11111111-1111-4111-8111-111111111111',shop:{id:'shop'},window:{webContents:{id:4,session,getURL:()=> 'https://fxg.jinritemai.com/ffa/fxg-bill/fund-detail-bill',capturePage:async()=>({toPNG:()=>Buffer.from('pngbytes'),getSize:()=>({width:1280,height:900})})}}};
 let closed=false;
 const ext=createFinanceExtension({app:{getPath:()=>root},current:()=>closed?null:owner,safeURL:()=>{},close:()=>{closed=true}});
 return {root,session,owner,ext};
}
test('capture stores the original PNG in a controlled folder and validates owner',async()=>{
 const {ext,owner,root}=setup();
 await assert.rejects(ext.command('different','finance_capture'),/owned/);
 const shot=await ext.command(owner.id,'finance_capture',{path:'/tmp/not-allowed.png'});
 assert.ok(shot.path.startsWith(root));assert.equal(fs.readFileSync(shot.path).toString(),'pngbytes');
 assert.equal(shot.shop_id,'shop');
 fs.rmSync(root,{recursive:true});
});
test('a stalled screenshot releases the caller instead of blocking the bridge forever',async(t)=>{
 const {ext,owner,root}=setup();
 owner.window.webContents.capturePage=()=>new Promise(()=>{});
 t.mock.timers.enable({apis:['setTimeout']});
 const pending=ext.command(owner.id,'finance_capture');
 const rejected=assert.rejects(pending,/screenshot timed out/);
 t.mock.timers.tick(8000);await rejected;
 assert.equal((await ext.command(owner.id,'finance_capabilities')).capture,true);
 await ext.command(owner.id,'finance_close');fs.rmSync(root,{recursive:true});
});
test('download listener ignores other windows and reports actual completion',async()=>{
 const {ext,owner,root,session}=setup();
 await ext.command(owner.id,'finance_arm_download');
 const item=new EventEmitter();let saved;
 item.getFilename=()=> '../../statement.xlsx';item.getTotalBytes=()=>7;item.getReceivedBytes=()=>7;item.setSavePath=p=>saved=p;item.isDone=()=>true;
 session.emit('will-download',{},item,{id:99});assert.equal(saved,undefined);
 session.emit('will-download',{},item,{id:4});assert.ok(saved.startsWith(root));
 fs.writeFileSync(saved,'xlsxbytes');item.emit('done',{},'completed');
 const result=await ext.command(owner.id,'finance_downloads');assert.equal(result.items.length,1);assert.equal(result.items[0].state,'completed');
 await ext.command(owner.id,'finance_finish_download');assert.equal(session.listenerCount('will-download'),0);
 fs.rmSync(root,{recursive:true});
});
test('closing the owned session releases its listeners and cancels unfinished downloads',async()=>{
 const {ext,owner,root,session}=setup();let cancelled=false;
 await ext.command(owner.id,'finance_arm_download');
 const item=new EventEmitter();item.getFilename=()=> 'x.csv';item.getTotalBytes=()=>8;item.getReceivedBytes=()=>1;item.setSavePath=()=>{};item.isDone=()=>false;item.cancel=()=>{cancelled=true};
 session.emit('will-download',{},item,{id:4});
 await ext.command(owner.id,'finance_close');assert.equal(cancelled,true);assert.equal(session.listenerCount('will-download'),0);
 await assert.rejects(ext.command(owner.id,'finance_capabilities'),/owned/);
 fs.rmSync(root,{recursive:true});
});
test('official report download keeps signed URLs inside Electron and rejects other hosts',async()=>{
 const {ext,owner,root}=setup();let downloaded;
 owner.window.webContents.executeJavaScript=async()=> 'https://lf3-tos-bill-center-sign.bytetos.com/file.csv?signature=private';
 owner.window.webContents.downloadURL=url=>downloaded=url;
 await ext.command(owner.id,'finance_arm_download');
 await assert.rejects(ext.command(owner.id,'finance_download_report',{download_id:'arbitrary'}),/Invalid official report/);
 const result=await ext.command(owner.id,'finance_download_report',{download_id:'DL202610181732251540952605'});
 assert.equal(result.started,true);assert.ok(downloaded.includes('signature=private'));
 assert.ok(!JSON.stringify(result).includes('private'));
 owner.window.webContents.executeJavaScript=async()=> 'https://example.com/file.csv';
 await assert.rejects(ext.command(owner.id,'finance_download_report',{download_id:'DL202610181732251540952605'}),/Unverified/);
 await ext.command(owner.id,'finance_close');fs.rmSync(root,{recursive:true});
});
test('wide finance captures keep every daily statement column and bound viewport sizes',async()=>{
 const {ext,owner,root}=setup();let viewport;
 owner.window.setContentSize=(width,height)=>viewport={width,height};
 await ext.command(owner.id,'finance_capture',{width:2560,height:1080});
 assert.deepEqual(viewport,{width:2560,height:1080});
 await assert.rejects(ext.command(owner.id,'finance_capture',{width:99999}),/Invalid finance capture viewport/);
 await ext.command(owner.id,'finance_close');fs.rmSync(root,{recursive:true});
});
