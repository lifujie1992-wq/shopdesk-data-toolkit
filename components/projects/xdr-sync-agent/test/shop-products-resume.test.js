import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const {Agent}=await import(process.env.AGENT_MODULE || '../src/agent.js');
test('a reclaimed shop-products job keeps its incomplete export checkpoint',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'shop-agent-resume-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const job={id:'9a97b22c-a34b-41d6-925b-1b7f205ac04a',task:'sync_shop_products',source:'auto'};
  const building=join(dir,'work',job.id,'shop-products-export.building');mkdirSync(building,{recursive:true});writeFileSync(join(building,'checkpoint.json'),'{}');
  const config={state_dir:dir,log_dir:dir,cli:{},server:{},sales_seed:''};
  const transport={heartbeat:async()=>{},fail:async()=>{}};const agent=new Agent(config,{datasets:{}},{transport});
  let retained=false;agent.fetch=async()=>{retained=existsSync(join(building,'checkpoint.json'));throw Error('isolated-fixture-stop');};
  assert.equal(await agent.runJob(job),false);assert.equal(retained,true);
});
