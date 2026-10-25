"""Prepare a minimal additive patch to the DEPLOYED ShopDesk archive.

This deliberately does not run ShopDesk's broad build/deploy script or install/restart
anything. The resulting archive can be installed with --install only when the bridge
responds and reports no running business jobs.
"""
import argparse,json,subprocess,sys,tempfile,shutil,os,time
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'src'))
from douyin_settle_recon.shopdesk import ShopDesk

ROOT=Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser();p.add_argument('--install',action='store_true');p.add_argument('--recover-unresponsive',action='store_true',help='recover only the verified hung ShopDesk process after persisted idle checks');a=p.parse_args()
app=Path.home()/'店铺工作台.app';archive=app/'Contents/Resources/app.asar'
asar_candidates=list((Path.home()/'.npm/_npx').glob('*/node_modules/@electron/asar/lib/asar.js'))
if not asar_candidates:raise SystemExit('Install @electron/asar first')
asar=asar_candidates[0]
work=Path(tempfile.mkdtemp(prefix='shopdesk-finance-patch-'));stage=work/'app'
js='''const asar=await import(process.argv[1]);asar.extractAll(process.argv[2],process.argv[3]);'''
subprocess.run(['node','--input-type=module','-e',js,str(asar),str(archive),str(stage)],check=True)
f=stage/'src/exploration.js';s=f.read_text()
if 'createFinanceExtension' not in s:
 s=s.replace(' let current;', " let current;\n const finance=require('./finance-extension.cjs').createFinanceExtension({app:require('electron').app,current:()=>current,safeURL,close});")
 s=s.replace('function close(){if(current){', 'function close(){if(current){finance.cleanup(current.id);')
 needle=' const allowed=['
 assert s.count(needle)==1
 s=s.replace(needle," if(method.startsWith('finance_'))return finance.command(id,method,params);\n"+needle)
 f.write_text(s)
# The official 抖店 账户明细 link opens this separate finance host. Keep the
# exception local to Douyin explorations; no wildcard or arbitrary popup URL.
if "const qianchuan = shop.platform" not in s:
 needle="!platforms[shop.platform]?.hosts.includes(u.hostname)"
 if s.count(needle)!=1:raise SystemExit('Cannot identify exploration host guard; patch not prepared')
 s=s.replace(needle,"!(qianchuan || platforms[shop.platform]?.hosts.includes(u.hostname))")
 s=s.replace("const u = new URL(url);", "const u = new URL(url);\n    const qianchuan = shop.platform === '抖店' && u.hostname === 'qianchuan.jinritemai.com';",1)
 f.write_text(s)
shutil.copy2(ROOT/'shopdesk/finance-extension.cjs',stage/'src/finance-extension.cjs')
# Existing pool routing is preserved; the extension resolves ownership by page id.
out=ROOT/'data/shopdesk-patch';out.mkdir(parents=True,exist_ok=True)
packed=out/'app.asar'
subprocess.run(['node','--input-type=module','-e','const a=await import(process.argv[1]);await a.createPackage(process.argv[2],process.argv[3]);',str(asar),str(stage),str(packed)],check=True)
# Keep a reviewable source mirror without touching ShopDesk's other modified files.
shutil.copy2(f,ROOT/'shopdesk/exploration.patched.js')
print('Prepared archive:',packed)
if not a.install:raise SystemExit(0)
b=ShopDesk()
responsive=True
try:
 for method in ['auto_appeal_status','backfill_status','get_metrics','login_scan_status']:
  state=b.call(method,timeout=3)
  if state.get('running'):raise SystemExit('ShopDesk is busy; patch prepared but not installed')
except Exception:
 responsive=False
 if not a.recover_unresponsive:raise SystemExit('ShopDesk not responding; patch remains staged')
result_file=Path.home()/'Library/Application Support/shopdesk/agent-results.json'
if result_file.exists():
 persisted=json.loads(result_file.read_text())
 if any(j.get('status')=='running' for j in persisted.values()):raise SystemExit('Collector task is active; not installed')
metrics_file=result_file.with_name('metrics.json')
if metrics_file.exists() and json.loads(metrics_file.read_text()).get('running'):raise SystemExit('Metrics task is active; not installed')
cfg=json.loads(b.bridge.read_text());pid=int(cfg['pid'])
actual=subprocess.run(['ps','-p',str(pid),'-o','comm='],capture_output=True,text=True).stdout.strip()
if actual!=str(app/'Contents/MacOS/店铺工作台'):raise SystemExit('Bridge PID does not match the expected ShopDesk executable')
backup=out/time.strftime('backup-%Y%m%d-%H%M%S');backup.mkdir()
shutil.copy2(archive,backup/'app.asar');plist=app/'Contents/Info.plist';shutil.copy2(plist,backup/'Info.plist')
if responsive:
 closed=subprocess.run(['osascript','-e','tell application id "local.shopdesk.desktop" to quit'],capture_output=True,text=True,timeout=10)
 if closed.returncode:raise SystemExit('macOS cancelled ShopDesk quit; patch remains staged and no files were replaced')
else:
 # Explicit recovery mode is limited to this exact unresponsive app PID, with idle records.
 os.kill(pid,15)
for _ in range(20):
 try:os.kill(pid,0)
 except ProcessLookupError:break
 time.sleep(.25)
else:
 if not responsive and a.recover_unresponsive:
  os.kill(pid,9)
  for _ in range(20):
   try:os.kill(pid,0)
   except ProcessLookupError:break
   time.sleep(.1)
  else:raise SystemExit('Hung ShopDesk PID did not terminate; no files replaced')
 else:raise SystemExit('ShopDesk did not exit; original app remains installed')
try:
 shutil.copy2(packed,archive)
 raw=packed.read_bytes();header_size=int.from_bytes(raw[12:16],'little')
 import hashlib
 digest=hashlib.sha256(raw[16:16+header_size]).hexdigest()
 subprocess.run(['/usr/libexec/PlistBuddy','-c',f'Set :ElectronAsarIntegrity:Resources/app.asar:hash {digest}',str(plist)],check=True)
 subprocess.run(['codesign','--force','--deep','--sign','-',str(app)],check=True,capture_output=True)
except Exception:
 shutil.copy2(backup/'app.asar',archive);shutil.copy2(backup/'Info.plist',plist)
 subprocess.run(['codesign','--force','--deep','--sign','-',str(app)],capture_output=True)
 subprocess.run(['open',str(app)]);raise
subprocess.run(['open',str(app)],check=True)
print('Minimal extension installed; backup:',backup,flush=True)
