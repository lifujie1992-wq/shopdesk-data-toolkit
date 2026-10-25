const {spawn}=require('node:child_process');const path=require('node:path');const {app}=require('electron');
const processes=new Map();
function command(){return app.isPackaged?{exe:path.join(process.resourcesPath,'python-sync','shopdesk-sync-worker','shopdesk-sync-worker'),args:[]}:{exe:path.join(__dirname,'..','.venv','bin','python'),args:[path.join(__dirname,'..','python-sync','runtime.py')]}}
function call(request,{timeout=30000,signal,module:collector,group='metrics',onProgress=()=>{}}={}){return new Promise((resolve,reject)=>{
 if(signal?.aborted){reject(Error('查询已取消'));return}
 const root=collector?.root||require('./collectors').builtinRoot();const entry=collector?.entry||'worker.py';
 const {exe,args}=command();const child=spawn(exe,args,{stdio:['pipe','pipe','pipe'],windowsHide:true,env:{...process.env,PYTHONNOUSERSITE:'1'}});processes.set(child,group);let output='',settled=false;
 const abort=()=>{child.kill();finish(Error('查询已取消'))};
 const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);processes.delete(child);error?reject(error):resolve(result)};
 const timer=setTimeout(()=>{child.kill();finish(Error('采集模块超时'))},timeout);signal?.addEventListener('abort',abort,{once:true});
 child.on('error',()=>finish(Error('内置运行环境无法启动')));let progressBuffer='';child.stderr.on('data',chunk=>{progressBuffer+=chunk;if(progressBuffer.length>20000){progressBuffer='';return}let at;while((at=progressBuffer.indexOf('\n'))>=0){const line=progressBuffer.slice(0,at);progressBuffer=progressBuffer.slice(at+1);try{const p=JSON.parse(line);if(p.event==='progress'&&Number.isInteger(p.completed)&&Number.isInteger(p.total)&&p.completed>=0&&p.completed<=p.total)onProgress(p)}catch{}}});child.stdin.on('error',()=>{});
 child.stdout.on('data',chunk=>{output+=chunk;if(output.length>2000000){child.kill();finish(Error('采集模块返回过大'))}});
 child.on('close',()=>{try{const reply=JSON.parse(output);if(!reply.ok)finish(Error(reply.error||'接口采集失败'));else finish(null,reply.result)}catch{finish(Error('采集模块返回异常'))}});
 child.stdin.end(JSON.stringify({...request,_module_root:root,_module_entry:entry}));
 })}
function cancel(group='metrics'){for(const [p,g]of processes)if(group===null||group===g)p.kill()}
module.exports={call,cancel};
