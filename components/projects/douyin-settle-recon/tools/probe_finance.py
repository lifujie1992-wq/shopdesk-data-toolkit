"""Inspect only the finance exploration owned by this explicit developer state file."""
import argparse,json,sys
from pathlib import Path
from urllib.parse import urlsplit
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'src'))
from douyin_settle_recon.shopdesk import ShopDesk
from douyin_settle_recon.collect import UI,URL
p=argparse.ArgumentParser();p.add_argument('--state',type=Path,default=Path('/tmp/douyin-finance-probe.json'));p.add_argument('--start');p.add_argument('--js');p.add_argument('--events',action='store_true');p.add_argument('--response');p.add_argument('--close',action='store_true');p.add_argument('--goto');a=p.parse_args();b=ShopDesk()
if a.start:
 eid=b.start(a.start,URL);a.state.write_text(json.dumps({'shop':{'id':a.start},'exploration':{'id':eid}}));b.ready(eid);print(json.dumps({'id':eid,'ready':True}));raise SystemExit
s=json.loads(a.state.read_text());eid=s['exploration']['id'];ui=UI(b,eid)
if a.close:result=b.close(eid)
elif a.goto:result=b.command(eid,'Page.navigate',{'url':a.goto})
elif a.events:
 d=b.command(eid,'events');result=[{**e,'url':urlsplit(e['url']).path} for e in d['events'] if 'fxg.jinritemai.com' in e.get('url','') and any(k in e['url'] for k in ['bill_center','settlement','finance','deposit','wallet'])]
elif a.response:
 result=json.loads(b.command(eid,'Network.getResponseBody',{'requestId':a.response})['result']['body'])
 def redact(v):
  if isinstance(v,dict):return {k:redact(w) for k,w in v.items() if not any(k1 in k.lower() for k1 in ['url','link','token','sign','cookie','password'])}
  if isinstance(v,list):return [redact(w) for w in v[:3]]
  return v
 result=redact(result)
else:result=ui.js(a.js or 'return {url:location.pathname,text:document.body.innerText.slice(-7000)};')
print(json.dumps(result,ensure_ascii=False))
