#!/usr/bin/env python3
"""Release a consistent SQLite backup while the collector continues appending rows."""
import argparse,json,sqlite3,tempfile
from pathlib import Path
from commission_rates.model import now,atomic_json
from commission_rates.store import Store,lock
from commission_rates.publish import snapshot,upload

ROOT=Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser();p.add_argument('--batch',required=True)
p.add_argument('--config',type=Path,default=ROOT/'config/daily.json')
p.add_argument('--db',type=Path,default=ROOT/'data/jst-commission-rates.sqlite');args=p.parse_args()
cfg=json.loads(args.config.read_text())
db_path=args.db.resolve()
reason=cfg['partial_release_reason']
with lock(ROOT/'data/incremental-publication'):
    state_path=ROOT/'data/incremental-source-state.json'
    def fingerprint():
        info=db_path.stat()
        return {'db':str(db_path),'batch_id':args.batch,'size':info.st_size,
                'mtime_ns':info.st_mtime_ns,'reason':reason}
    if state_path.exists():
        prior=json.loads(state_path.read_text())
        if prior['source']==fingerprint():
            print(json.dumps({'skipped':'source_unchanged','publication_id':prior['publication_id']}),flush=True)
            raise SystemExit(0)
    # SQLite serializes this append-only release against collector transactions. No task/rate is edited.
    with sqlite3.connect(db_path,timeout=30) as src:
        src.execute('PRAGMA foreign_keys=ON')
        if not src.execute('SELECT 1 FROM commission_rates WHERE batch_id=? LIMIT 1',(args.batch,)).fetchone():
            raise RuntimeError('batch has no captured rows')
        src.execute('INSERT OR IGNORE INTO publication_releases VALUES(?,?,?,?)',(args.batch,'partial',now(),reason))
        src.commit()
        source_fingerprint=fingerprint()
        with tempfile.TemporaryDirectory(prefix='commission-snapshot-') as temporary:
            frozen=Path(temporary)/'frozen.sqlite'
            with sqlite3.connect(frozen) as dst:src.backup(dst)
            store=Store(frozen)
            try:prepared=snapshot(store,args.batch,ROOT/'data/publications',allow_partial=True,reason=reason)
            finally:store.close()
    receipt=upload(prepared['snapshot'],cfg)
    atomic_json(ROOT/'data/incremental-cloud-status.json',receipt)
    atomic_json(state_path,{'source':source_fingerprint,'publication_id':receipt['publication_id']})
    print(json.dumps({k:receipt[k] for k in ('publication_id','publication_mode','available_row_count','available_shop_count','published_at')},ensure_ascii=False))
