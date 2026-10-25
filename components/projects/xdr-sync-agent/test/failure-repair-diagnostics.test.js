import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {projectFor,repairOnce} from '../src/failure-repair.js';
import {enqueueIncident,atomicJson} from '../src/failure-incidents.js';

test('upload and diff failures use the sync agent project while source fetching retains its collector project',()=>{
  const config={projects:{xdr:{root:'/fixture/agent'},inventory:{root:'/fixture/inventory'}},tasks:[{match:'^sync_spu_live$',project:'inventory'}]};
  for(const phase of ['uploading','diffing','waiting_apply']) assert.equal(projectFor({task:'sync_spu_live',phase},config).name,'xdr');
  assert.equal(projectFor({task:'sync_spu_live',phase:'fetching_spu_live'},config).name,'inventory');
  assert.equal(projectFor({task:'sync_spu_live',reason:'scp_failed:1'},config).name,'xdr');
});

test('diagnosis receives only matching job stderr and redacts credentials without dropping evidence',async t=>{
  const root=mkdtempSync(join(tmpdir(),'repair-diagnostics-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const project=join(root,'project');mkdirSync(join(project,'src'),{recursive:true});writeFileSync(join(project,'src/value.js'),'export const value=1;');
  const diagnostic=join(root,'diagnostics.jsonl');
  const job='36d40278-c1dc-4b2c-bdff-166a40b65c00';
  writeFileSync(diagnostic,[
    JSON.stringify({job_id:'other-job',task:'sync_spu_live',stderr:'UNRELATED_OTHER_JOB'}),
    JSON.stringify({job_id:job,task:'sync_orders',stderr:'UNRELATED_OTHER_TASK'}),
    JSON.stringify({job_id:job,task:'sync_spu_live',phase:'uploading',executable:'scp',args:['-O','--token','PRIVATE_TOKEN','--password=PRIVATE_PASSWORD','local.partial','host:/incoming/part'],exit_code:1,stdout:'Authorization: Bearer PRIVATE_HEADER',stderr:'Connection timed out during banner exchange\nlost connection'}),
    '{truncated',
  ].join('\n'));
  const configPath=join(root,'config.json'),stateDir=join(root,'state');
  atomicJson(configPath,{enabled:true,maxAttempts:1,timeoutSeconds:30,inventory:join(root,'inventory.json'),workerDiagnosticLogs:[diagnostic],workerStatuses:[],
    projects:{xdr:{root:project,autoApply:false,tests:[],allowPrefixes:['src/']}},tasks:[{match:'^sync_spu_live$',project:'xdr'}]});
  const event={id:'cloud-job:'+job,job_id:job,task:'sync_spu_live',phase:'uploading',reason:'scp_failed:1'};
  enqueueIncident(event,{configPath,stateDir});let context;
  await repairOnce({configPath,stateDir,alertState:join(root,'alerts'),alertConfig:join(root,'absent.json'),probe:async()=>null,notify:async()=>{},deliver:async()=>[],
    agent:async args=>{context=args.context;return {category:'transient',outcome:'no_change',cause:'SSH handshake timed out',evidence:[],fix:'No source change',conclusion:'Transient network failure',confidence:'high'};}});
  const evidence=JSON.stringify(context);
  assert.match(evidence,/Connection timed out during banner exchange/);assert.match(evidence,/lost connection/);assert.match(evidence,/scp/);
  for(const secret of ['PRIVATE_TOKEN','PRIVATE_PASSWORD','PRIVATE_HEADER','UNRELATED_OTHER_JOB','UNRELATED_OTHER_TASK']) assert.equal(evidence.includes(secret),false,secret);
});
