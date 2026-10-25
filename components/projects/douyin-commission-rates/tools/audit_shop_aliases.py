#!/usr/bin/env python3
"""Verify ERP/shop renames by exact target product IDs in authenticated inventories."""
import json
import sqlite3
from pathlib import Path
from commission_rates.source import Buyin
from commission_rates.model import PROMOTED,UNPROMOTED,atomic_json,now

ROOT=Path(__file__).resolve().parents[1]
config=json.loads((ROOT/'data/shop-mappings.json').read_text())
readiness=json.loads((ROOT/'data/readiness.json').read_text())
missing={r['shop_id'] for r in readiness['shops'] if not r['mapped_shopdesk_session']}
db=sqlite3.connect((ROOT/'data/jst-commission-rates.sqlite').resolve().as_uri()+'?mode=ro',uri=True)
targets=[]
for sid in sorted(missing):
    targets.extend({'shop_id':sid,'platform_link_id':r[0]} for r in db.execute(
        'SELECT DISTINCT platform_link_id FROM batch_targets WHERE shop_id=? ORDER BY platform_link_id DESC LIMIT 4',(sid,)))
path=ROOT/'data/alias-audit.json'
result=json.loads(path.read_text()) if path.exists() else {'started_at':now(),'targets':targets,'shops':[]}
finished={r['bridge_shop_id'] for r in result['shops']}
source=Buyin()
try:
    for shop in config['shops']:
        if shop['bridge_shop_id'] in finished:continue
        entry={'bridge_shop_id':shop['bridge_shop_id'],'shop_name':shop['shop_name'],'matches':[]}
        try:
            identity=source.open(shop);entry['platform_shop_id']=identity['platform_shop_id']
            wanted={r['platform_link_id'] for r in targets}
            promoted=source.pages(PROMOTED,{'status':0,'product_info':','.join(sorted(wanted))},wanted)
            rest=wanted-{r['product_id'] for r in promoted}
            unpromoted=source.pages(UNPROMOTED,{'title':','.join(sorted(rest)),'is_new_platform':'true',
                                             'is_opportunity_product':'false'},rest) if rest else []
            hits={r['product_id'] for r in promoted+unpromoted}
            entry['matches']=[r for r in targets if r['platform_link_id'] in hits]
        except Exception as exc:
            entry['error']=type(exc).__name__
        finally:
            source.close()
        entry['checked_at']=now();result['shops'].append(entry);atomic_json(path,result)
        print(json.dumps(entry,ensure_ascii=False),flush=True)
finally:source.close();db.close()
