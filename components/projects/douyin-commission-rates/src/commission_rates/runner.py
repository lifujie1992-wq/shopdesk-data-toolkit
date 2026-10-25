"""Collect shops while leaving one shared ShopDesk slot for other collectors."""
from concurrent.futures import ThreadPoolExecutor,as_completed
from .source import Buyin,collect
from .store import Store
from .model import CaptureError


def collect_all(store,batch,*,report_dir=None,workers=1,on_shop=None):
    # Both exploration slots are shared with aftersale and finance collection.
    # Clamp old two-worker configs too: a long batch must not occupy both slots.
    workers=max(1,min(1,int(workers)))
    shops=[r[0] for r in store.db.execute('''SELECT shop_id FROM capture_tasks
      WHERE batch_id=? AND status<>'done' GROUP BY shop_id ORDER BY count(*) DESC,shop_id''',(batch,))]
    def worker(shop_id):
        local=Store(store.path)
        try:
            result=collect(local,batch,Buyin(),only_shop=shop_id)
            return shop_id,result
        finally:local.close()
    try:
        with ThreadPoolExecutor(max_workers=workers) as pool:
            jobs={pool.submit(worker,sid):sid for sid in shops}
            for future in as_completed(jobs):
                sid,result=future.result()
                if on_shop:on_shop(sid,result)
    finally:
        store.finish_collection(batch)
        if report_dir:store.write_report(batch,report_dir)
    return store.report(batch)
