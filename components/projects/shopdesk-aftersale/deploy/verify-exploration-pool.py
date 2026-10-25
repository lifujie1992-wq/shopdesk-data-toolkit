"""Read-only integration: wait while both slots are occupied; never close others' pages."""
import importlib.util,sys,time,threading
from pathlib import Path
spec=importlib.util.spec_from_file_location('counts',Path(__file__).resolve().parents[1]/'bin/scrape_counts.py');c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
port,token=c.load_bridge();call=c.make_caller(port,token,reload_bridge=True)
shops=call({'method':'list_shops'})['result']['shops'];shop=next(s for s in shops if s['platform']=='抖店')
owned=[]
try:
 initial=call({'method':'exploration_status'})['result']['active']
 if initial:raise SystemExit('Existing task pages active; defer integration until idle')
 for owner in ['pool-verification','finance-verification']:
  owned.append(call({'method':'start_exploration','args':{'shop_id':shop['id'],'url':c.LIST_URL,'owner':owner}})['result']['id'])
 busy=call({'method':'start_exploration','args':{'shop_id':shop['id'],'url':c.LIST_URL}})
 assert busy.get('code')=='EXPLORATION_BUSY',busy
 result=[]
 worker=threading.Thread(target=lambda:result.append(c.fetch_shop(call,shop)));worker.start()
 time.sleep(3)
 assert worker.is_alive(),'collector did not wait for capacity'
 a=owned.pop(0);assert call({'method':'close_exploration','args':{'id':a}})['result']['closed']
 worker.join(60);assert not worker.is_alive(),'collector did not complete'
 assert result[0]['status']=='ok',result
 assert call({'method':'exploration_command','args':{'id':owned[0],'method':'finance_capabilities'}})['result']['owned_close']
 status=call({'method':'exploration_status'})['result'];assert status['active']==1 and status['pages'][0]['id']==owned[0],status
 print('PASS: capacity=2; third busy; collector waited then succeeded; finance page survived other-page collection/close',flush=True)
finally:
 for eid in owned:call({'method':'close_exploration','args':{'id':eid}})
