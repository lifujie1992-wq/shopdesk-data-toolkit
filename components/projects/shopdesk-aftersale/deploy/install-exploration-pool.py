#!/usr/bin/env python3
"""Patch only exploration ownership and its bridge routing in the deployed app."""
import argparse, hashlib, json, os, shutil, subprocess, tempfile, time, urllib.error, urllib.request
from pathlib import Path

p=argparse.ArgumentParser();p.add_argument('--install',action='store_true');args=p.parse_args()
home=Path.home();app=home/'店铺工作台.app';archive=app/'Contents/Resources/app.asar';plist=app/'Contents/Info.plist'
source=home/'shopdesk-workbench-src/src';out=Path(__file__).resolve().parent/'exploration-pool';out.mkdir(exist_ok=True)
base_hash=hashlib.sha256(archive.read_bytes()).hexdigest()
asar=next((home/'.npm/_npx').glob('*/node_modules/@electron/asar/lib/asar.js'))
stage=Path(tempfile.mkdtemp(prefix='shopdesk-exploration-pool-'))/'app'
subprocess.run(['node','--input-type=module','-e','const a=await import(process.argv[1]);a.extractAll(process.argv[2],process.argv[3]);',str(asar),str(archive),str(stage)],check=True)
before={str(f.relative_to(stage)):hashlib.sha256(f.read_bytes()).hexdigest() for f in stage.rglob('*') if f.is_file()}
for name in ['exploration.js','finance-extension.cjs']:shutil.copy2(source/name,stage/'src'/name)
f=stage/'src/agent-api.js';s=f.read_text()
replacements=[("if(method==='close_exploration')return exploration.close();", "if(method==='close_exploration')return exploration.close(args);\n if(method==='exploration_status')return exploration.status();"),
 ("const task=queue.then(()=>dispatch(method,args));queue=task.catch(()=>{});", "const isolated=['start_exploration','exploration_command','close_exploration','exploration_status'].includes(method);\n   const task=isolated?Promise.resolve().then(()=>dispatch(method,args)):queue.then(()=>dispatch(method,args));if(!isolated)queue=task.catch(()=>{});"),
 ("JSON.stringify({error:e.message})", "JSON.stringify({error:e.message,...(e.code?{code:e.code}:{})})")]
for old,new in replacements:
 if old not in s and new in s:continue
 assert s.count(old)==1,old
 s=s.replace(old,new)
f.write_text(s)
f=stage/'src/main.js';s=f.read_text();old='exploration?.close()';new='exploration?.closeAll()'
assert s.count(old)==1 or new in s
f.write_text(s.replace(old,new))
after={str(f.relative_to(stage)):hashlib.sha256(f.read_bytes()).hexdigest() for f in stage.rglob('*') if f.is_file()}
changed=sorted(k for k in before.keys()|after.keys() if before.get(k)!=after.get(k))
assert set(changed)<=set('src/'+n for n in ['exploration.js','finance-extension.cjs','agent-api.js','main.js'])
for name in changed:subprocess.run(['node','--check',str(stage/name)],check=True)
packed=out/'app.asar'
subprocess.run(['node','--input-type=module','-e','const a=await import(process.argv[1]);await a.createPackage(process.argv[2],process.argv[3]);',str(asar),str(stage),str(packed)],check=True)
(out/'manifest.json').write_text(json.dumps({'source_sha256':base_hash,'changed':changed,'packed_sha256':hashlib.sha256(packed.read_bytes()).hexdigest()},indent=2))
print('Prepared; only changed:',', '.join(changed),flush=True)
if not args.install:raise SystemExit(0)
bridge=home/'Library/Application Support/shopdesk/agent-bridge.json';cfg=json.loads(bridge.read_text());opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
def call(method):
 req=urllib.request.Request('http://127.0.0.1:%d/call'%cfg['port'],data=json.dumps({'method':method,'args':{}}).encode(),headers={'Authorization':'Bearer '+cfg['token'],'Content-Type':'application/json'})
 with opener.open(req,timeout=5) as response:result=json.load(response)
 if 'error' in result:raise RuntimeError('Workbench refused idle check: '+method)
 return result['result']
for method in ['auto_appeal_status','backfill_status','get_metrics','login_scan_status']:
 if call(method).get('running'):raise SystemExit('Active business task; archive staged only')
try:
 pool=call('exploration_status')
except urllib.error.HTTPError as exc:
 if exc.code!=400:raise
else:
 if pool.get('active'):raise SystemExit('Exploration task active; archive staged only')
for name in ['agent-results.json','metrics.json']:
 f=bridge.with_name(name)
 if f.exists():
  value=json.loads(f.read_text())
  if isinstance(value,dict) and (value.get('running') or any(isinstance(v,dict) and v.get('status')=='running' for v in value.values())):raise SystemExit('Persisted task active: '+name)
proc=subprocess.run(['ps','-axo','pid,command'],capture_output=True,text=True,check=True).stdout
for line in proc.splitlines():
 if ('scrape_counts.py' in line or 'audit_finance.py' in line or 'douyin_settle_recon.cli' in line) and 'python' in line.lower():raise SystemExit('External collection active; archive staged only')
pid=int(cfg['pid']);actual=subprocess.run(['ps','-p',str(pid),'-o','comm='],capture_output=True,text=True,check=True).stdout.strip()
assert actual==str(app/'Contents/MacOS/店铺工作台'),'Unexpected bridge process'
assert hashlib.sha256(archive.read_bytes()).hexdigest()==base_hash,'App changed during preparation'
backup=out/time.strftime('backup-%Y%m%d-%H%M%S');backup.mkdir()
shutil.copy2(archive,backup/'app.asar');shutil.copy2(plist,backup/'Info.plist')
subprocess.run(['osascript','-e','tell application id "local.shopdesk.desktop" to quit'],check=True,timeout=15)
for _ in range(40):
 try:os.kill(pid,0)
 except ProcessLookupError:break
 time.sleep(.25)
else:raise SystemExit('Workbench did not exit; original archive untouched')
try:
 shutil.copy2(packed,archive)
 raw=packed.read_bytes();header_size=int.from_bytes(raw[12:16],'little');digest=hashlib.sha256(raw[16:16+header_size]).hexdigest()
 subprocess.run(['/usr/libexec/PlistBuddy','-c','Set :ElectronAsarIntegrity:Resources/app.asar:hash '+digest,str(plist)],check=True)
 subprocess.run(['codesign','--force','--deep','--sign','-',str(app)],check=True,capture_output=True)
except Exception:
 shutil.copy2(backup/'app.asar',archive);shutil.copy2(backup/'Info.plist',plist)
 subprocess.run(['codesign','--force','--deep','--sign','-',str(app)],capture_output=True)
 subprocess.run(['open',str(app)]);raise
subprocess.run(['open',str(app)],check=True)
print('Installed; backup:',backup,flush=True)
