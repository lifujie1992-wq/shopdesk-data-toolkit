#!/usr/bin/env python3
"""Recover a name-only identity mismatch after proving platform ID and target item ownership."""
import argparse,json
from pathlib import Path
from commission_rates.source import Buyin,collect
from commission_rates.store import Store,lock
from commission_rates.model import CaptureError,PROMOTED,UNPROMOTED,atomic_json,now

ROOT=Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser();p.add_argument('--batch',required=True);args=p.parse_args()
path=ROOT/'data/jst-commission-rates.sqlite'

class VerifiedRename(Buyin):
    def __init__(self,store,batch):
        super().__init__();self.store=store;self.batch=batch;self.rename=None
    def open(self,shop):
        try:return super().open(shop)
        except CaptureError as exc:
            if str(exc)!='configured shop_name does not match current session':raise
        identity=self.bridge.evaluate(self.eid,"({shop_id:String(window.__shop_id||''),shop_name:window.__INITIAL_USER_INFO__?.data?.shop_name||''})")
        if shop.get('platform_shop_id') and identity['shop_id']!=shop['platform_shop_id']:
            raise CaptureError('rename recovery cannot change platform_shop_id')
        wanted={r[0] for r in self.store.db.execute('''SELECT platform_link_id FROM batch_targets
          WHERE batch_id=? AND shop_id=? ORDER BY platform_link_id DESC LIMIT 4''',(self.batch,shop['shop_id']))}
        promoted=self.pages(PROMOTED,{'status':0,'product_info':','.join(sorted(wanted))},wanted)
        rest=wanted-{r['product_id'] for r in promoted}
        unpromoted=self.pages(UNPROMOTED,{'title':','.join(sorted(rest)),'is_new_platform':'true','is_opportunity_product':'false'},rest) if rest else []
        hits=sorted({r['product_id'] for r in promoted+unpromoted})
        if len(hits)<min(2,len(wanted)):
            raise CaptureError('rename recovery requires exact target product matches')
        self.rename={'at':now(),'shop_id':shop['shop_id'],'bridge_shop_id':shop['bridge_shop_id'],
                     'platform_shop_id':identity['shop_id'],'old_name':shop['shop_name'],
                     'new_name':identity['shop_name'],'verified_product_ids':hits}
        atomic_json(ROOT/'data'/('verified-rename-'+shop['shop_id']+'.json'),self.rename)
        self.shop={**shop,'shop_name':identity['shop_name'],'platform_shop_id':identity['shop_id']}
        print(json.dumps({'verified_rename':self.rename},ensure_ascii=False),flush=True)
        return self.shop
    def task(self,*args):
        rows,overrides,issues=super().task(*args)
        if self.rename:
            note='店铺名称与平台归属已用4个目标商品ID核实：'+self.rename['old_name']+' → '+self.rename['new_name']
            for row in rows:row['notes']=(row.get('notes')+'；' if row.get('notes') else '')+note
        return rows,overrides,issues

with lock(path):
    store=Store(path)
    config=json.loads(store.batch(args.batch)['config_json'])
    mapped={r['shop_id'] for r in config['shops']}
    shops=[r[0] for r in store.db.execute("SELECT DISTINCT shop_id FROM capture_tasks WHERE batch_id=? AND status='failed'",(args.batch,)) if r[0] in mapped]
    for sid in shops:
        source=VerifiedRename(store,args.batch)
        collect(store,args.batch,source,only_shop=sid,report_dir=ROOT/'data/runs'/args.batch)
        if source.rename:
            cfg_path=ROOT/'data/shop-mappings.json';current=json.loads(cfg_path.read_text())
            for row in current['shops']:
                if row['shop_id']==sid:
                    row['shop_name']=source.rename['new_name']
                    row['platform_shop_id']=source.rename['platform_shop_id']
                    row['mapping_basis']='平台店铺ID与4个目标商品ID核实后台名称变化；'+source.rename['at']
            atomic_json(cfg_path,current)
    print(json.dumps(store.report(args.batch),ensure_ascii=False))
    store.close()
