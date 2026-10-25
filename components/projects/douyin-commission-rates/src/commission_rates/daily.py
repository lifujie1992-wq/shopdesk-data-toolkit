from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

from .model import CaptureError, adapter_hash, atomic_json, digest, now
from .publish import snapshot, upload
from .source import load_targets
from .runner import collect_all as collect
from .store import Store, lock


def daily(db_path,config_path):
    config_path=Path(config_path).resolve()
    cfg=json.loads(config_path.read_text())
    def local(value):
        p=Path(value).expanduser()
        return p if p.is_absolute() else config_path.parent/p
    state=local(cfg.get('state_dir','../data'))
    with lock(db_path):
        store=Store(db_path)
        batch=None
        try:
            current=datetime.fromisoformat(now())
            last=store.db.execute('SELECT * FROM batch_runs ORDER BY started_at DESC,batch_id DESC LIMIT 1').fetchone()
            shops=json.loads(local(cfg['shops']).read_text())
            compatible=bool(last and last['config_hash']==digest(shops)
                            and last['expected_links']==cfg.get('expected_links',70460)
                            and last['adapter_hash']==adapter_hash())
            if compatible and datetime.fromisoformat(last['started_at']).date()==current.date():
                batch=last['batch_id']
            else:
                batch=store.new_batch(load_targets(local(cfg['facts'])),shops,
                                      str(local(cfg['facts'])),cfg.get('expected_links',70460))
            if not store.batch(batch)['complete']:
                completed_shops=0
                def after_shop(shop_id,report):
                    nonlocal completed_shops
                    completed_shops+=1
                    if cfg.get('incremental_publish') and cfg.get('publish') and completed_shops%4==0 and report['found']:
                        import subprocess,sys
                        helper=Path(__file__).resolve().parents[2]/'tools/publish_active_batch.py'
                        try:
                            subprocess.run([sys.executable,str(helper),'--batch',batch,
                                            '--config',str(config_path),'--db',str(Path(db_path).resolve())],check=True)
                        except subprocess.CalledProcessError:
                            # Collection continues; the final publication still retries the complete collected state.
                            print(json.dumps({'stage':'incremental_publish','status':'failed',
                                              'batch_id':batch,'shop_id':shop_id}),flush=True)
                collect(store,batch,report_dir=state/'runs'/batch,workers=cfg.get('workers',1),on_shop=after_shop)
                try: store.accept(batch,cfg.get('acceptance_reference'))
                except CaptureError:
                    if not cfg.get('publish_partial'):
                        report=store.report(batch)
                        atomic_json(state/'daily-status.json',{'at':now(),'status':'needs_review','batch_id':batch,'report':report})
                        print(json.dumps(report,ensure_ascii=False));return 2
            result=snapshot(store,batch,state/'publications',allow_partial=cfg.get('publish_partial',False),
                            reason=cfg.get('partial_release_reason'))
            if cfg.get('publish'): result=upload(result['snapshot'],cfg['server'])
            state_status='published' if cfg.get('publish') else 'prepared'
            if result['publication_mode']=='partial': state_status+='_partial'
            atomic_json(state/'daily-status.json',{'at':now(),'status':state_status,
                                                  'batch_id':batch,'result':result})
            return 0
        except Exception:
            atomic_json(state/'daily-status.json',{'at':now(),'status':'failed','batch_id':batch})
            raise
        finally: store.close()
