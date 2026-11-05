import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {callListApi,spuLiveParams} from '../src/api.js';
import {exportSpuInventoryToSqlite} from '../src/sqlite-export.js';
import * as Errors from '../src/errors.js';
const {CliError}=Errors;
const session={cookies:[{name:'u_sso_token',value:'SECRET_COOKIE'},{name:'u_id',value:'1'},{name:'u_co_id',value:'2'}]};
function output(t){const root=mkdtempSync(join(tmpdir(),'spu-api-recovery-'));t.after(()=>rmSync(root,{recursive:true,force:true}));return join(root,'spu.sqlite');}
const page=(id,total=1)=>({total,data:[{spu_id:id,children:[{sku_id:id+'-sku'}]}]});

test('API errors retain failed page, HTTP status and error code without response data or credentials',async t=>{
  t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({code:500,success:false,msg:'系统异常，请稍后再试',data:{token:'SECRET_RESPONSE'}}),{status:200}));
  await assert.rejects(callListApi(session,'purchase_alarm_sku_detail',{...spuLiveParams(7,100),token:'SECRET_PARAMETER'}),error=>{
    assert.equal(error.code,'api_error');assert.equal(error.diagnostic.http_status,200);assert.equal(error.diagnostic.api_code,'purchase_alarm_sku_detail');
    assert.equal(error.diagnostic.page_num,7);assert.equal(error.diagnostic.page_size,100);assert.equal(error.diagnostic.response.code,500);
    for(const secret of ['SECRET_COOKIE','SECRET_RESPONSE','SECRET_PARAMETER'])assert.equal(JSON.stringify(error.diagnostic).includes(secret),false);
    return true;
  });
});
test('SPU system exceptions retry only the failed page, preserving earlier completed pages',async t=>{
  const calls=[],progress=[];let second=0;
  const result=await exportSpuInventoryToSqlite({session:{},outputPath:output(t),pageSize:1,concurrency:1,retryDelaysMs:[0,0],onProgress:p=>progress.push(p),
    fetchPage:async p=>{calls.push(p);if(p===2&&++second<=2)throw new CliError('api_error','系统异常，请稍后再试');return page('spu-'+p,2);}});
  assert.deepEqual(calls,[1,2,2,2]);assert.equal(result.fetched_spu,2);assert.equal(result.fetched_sku,2);assert.equal(progress.filter(p=>p.event==='retry').length,2);
});
test('exhausted retries retain the old complete snapshot and report the exact failed page',async t=>{
  const path=output(t);await exportSpuInventoryToSqlite({session:{},outputPath:path,pageSize:1,fetchPage:async()=>page('old')});let calls=0;
  await assert.rejects(exportSpuInventoryToSqlite({session:{},outputPath:path,pageSize:1,retryDelaysMs:[0,0],fetchPage:async()=>{calls++;throw new CliError('api_error','系统异常，请稍后再试');}}),e=>{
    assert.equal(e.diagnostic.page_num,1);assert.equal(e.diagnostic.attempts,3);return true;
  });
  assert.equal(calls,3);const db=new DatabaseSync(path,{readOnly:true});try{assert.equal(db.prepare('SELECT spu_id FROM spu_inventory').get().spu_id,'old');}finally{db.close();}
});
test('login, permissions and ordinary API errors are not retried by SPU collection',async t=>{
  for(const error of [new CliError('not_logged_in','未登录'),new CliError('api_error','参数错误'),new CliError('api_error','系统异常，请稍后再试',{http_status:403})]){
    let calls=0;await assert.rejects(exportSpuInventoryToSqlite({session:{},outputPath:output(t),retryDelaysMs:[0,0],fetchPage:async()=>{calls++;throw error;}}));assert.equal(calls,1);
  }
});
test('generic API callers still make one request for an ordinary system error',async t=>{
  let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response(JSON.stringify({code:500,success:false,msg:'系统异常，请稍后再试'}));});
  await assert.rejects(callListApi(session,'purchase_alarm_sku_detail',spuLiveParams(1,100)));assert.equal(calls,1);
});
test('CLI error serialization includes safe diagnostics and redacts secrets',()=>{
  const error=new CliError('api_error','系统异常，请稍后再试',{api_code:'purchase_alarm_sku_detail',http_status:200,page_num:9,page_size:100,attempts:3,response:{code:500,success:false,message:'Authorization: Bearer SECRET_HEADER',data:{token:'SECRET_DATA'}},token:'SECRET_FIELD'});
  const result=Errors.errorResult(error);assert.equal(result.ok,false);assert.equal(result.error.code,'api_error');assert.equal(result.error.diagnostic.page_num,9);
  for(const secret of ['SECRET_HEADER','SECRET_DATA','SECRET_FIELD'])assert.equal(JSON.stringify(result).includes(secret),false);
});
