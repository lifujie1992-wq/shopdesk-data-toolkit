const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto'),{app}=require('electron');
const ID=/^[a-z][a-z0-9_\-]{0,49}$/;
function builtinRoot(){return app.isPackaged?path.join(process.resourcesPath,'collectors','builtin'):path.join(__dirname,'..','python-sync')}
function manifest(root){
 const m=JSON.parse(fs.readFileSync(path.join(root,'collector.json'),'utf8'));
 if(!ID.test(m.id)||typeof m.version!=='string'||typeof m.title!=='string'||!Array.isArray(m.files)||!Array.isArray(m.capabilities))throw Error('采集模块清单无效');
 if(!m.files.includes(m.entry)||m.files.length>30||m.capabilities.length>20)throw Error('采集模块文件或能力数量无效');
 for(const file of m.files){if(!/^[a-zA-Z0-9_\-]+\.py$/.test(file))throw Error('模块只允许当前目录内的 Python 文件');const f=path.join(root,file);if(fs.lstatSync(f).isSymbolicLink()||fs.statSync(f).size>2e6)throw Error('模块文件不合法')}
 const seen=new Set();for(const c of m.capabilities){if(!ID.test(c.id)||!ID.test(c.action)||seen.has(c.id)||typeof c.title!=='string'||!Array.isArray(c.platforms)||!Array.isArray(c.columns))throw Error('能力清单无效');seen.add(c.id);const u=new URL(c.cookieURL);if(u.protocol!=='https:'||u.username||u.password)throw Error('采集入口必须为 HTTPS');const rules=require('./login').platforms;if(!c.platforms.length||c.platforms.some(p=>!rules[p]?.hosts.includes(u.hostname)))throw Error('采集入口与平台不匹配');for(const col of c.columns)if(!ID.test(col.key)||typeof col.label!=='string')throw Error('结果列配置无效')}
 return {...m,root};
}
function createCollectors(){
 const home=path.join(app.getPath('userData'),'collectors');fs.mkdirSync(home,{recursive:true,mode:0o700});const registry=path.join(home,'active.json');
 function modules(){const map=new Map([['builtin',manifest(builtinRoot())]]);let refs={};if(fs.existsSync(registry))refs=JSON.parse(fs.readFileSync(registry,'utf8'));for(const [id,folder]of Object.entries(refs)){if(!ID.test(id)||!/^v-[a-f0-9-]+$/.test(folder))throw Error('模块索引无效');const m=manifest(path.join(home,folder));if(m.id!==id)throw Error('模块身份不一致');map.set(id,m)}return [...map.values()]}
 function list(){return {directory:home,modules:modules().map(({root,files,entry,...m})=>m),capabilities:modules().flatMap(m=>m.capabilities.map(c=>({...c,key:m.id+':'+c.id,module_id:m.id,version:m.version})))}}
 function resolve(key){const [id,cid]=key.split(':');const m=modules().find(m=>m.id===id);if(!m)throw Error('采集模块不存在');const c=m.capabilities.find(c=>c.id===cid);if(!c)throw Error('采集能力不存在');return {module:m,capability:c}}
 async function install(source){const m=manifest(source),folder='v-'+randomUUID(),dest=path.join(home,folder);fs.mkdirSync(dest,{mode:0o700});try{for(const f of [...m.files,'collector.json'])fs.copyFileSync(path.join(source,f),path.join(dest,f));const installed=manifest(dest);const result=await require('./python-worker').call({_validate_only:true},{module:installed,group:'validation'});if(!result.valid)throw Error('模块缺少 main 入口');const refs=fs.existsSync(registry)?JSON.parse(fs.readFileSync(registry,'utf8')):{};refs[m.id]=folder;fs.writeFileSync(registry+'.tmp',JSON.stringify(refs),{mode:0o600});fs.renameSync(registry+'.tmp',registry);return list()}catch(e){fs.rmSync(dest,{recursive:true,force:true});throw e}}
 return {list,resolve,install};
}
module.exports={createCollectors,builtinRoot,manifest};
