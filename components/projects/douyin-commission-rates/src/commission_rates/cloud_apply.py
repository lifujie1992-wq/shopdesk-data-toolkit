"""Dedicated publication helper, REQUEST is injected over SSH stdin; no service changes."""
import fcntl
import hashlib
import json
import os
import re
import sqlite3
from pathlib import Path
from datetime import datetime, timezone

BASE=Path('/var/lib/xdr-sync')
TARGET=BASE/'data/jst-commission-rates.sqlite'
TABLES=('commission_rates','batch_runs','batch_targets','commission_overrides','capture_tasks','capture_issues','sample_checks','publication_releases')
os.umask(0o077)


def fail(code):
    raise ValueError(code)


def validate(db,manifest):
    if db.execute('PRAGMA quick_check').fetchone()[0]!='ok' or db.execute('PRAGMA foreign_key_check').fetchone():
        fail('invalid_sqlite')
    for table in TABLES:
        if db.execute('SELECT count(*) FROM '+table).fetchone()[0]!=manifest['row_counts'][table]:
            fail('row_count_mismatch')
    metadata=json.loads(db.execute('SELECT metadata_json FROM _warehouse_publication WHERE id=1').fetchone()[0])
    for key in ('dataset','schema_version','publication_id','batch_id','row_counts','published_at','acceptance',
                'publication_mode','release_reason','available_row_count','available_shop_count'):
        if metadata.get(key)!=manifest[key]: fail('embedded_metadata_mismatch')
    batch=manifest['batch_id']
    b=db.execute('SELECT complete,expected_links FROM batch_runs WHERE batch_id=?',(batch,)).fetchone()
    if not b: fail('batch_missing')
    mode=manifest.get('publication_mode')
    if mode not in ('accepted','partial'): fail('invalid_publication_mode')
    if not db.execute('SELECT 1 FROM publication_releases WHERE batch_id=? AND release_mode=?',(batch,mode)).fetchone():
        fail('batch_not_released')
    targets,links=db.execute('SELECT count(*),count(distinct platform_link_id) FROM batch_targets WHERE batch_id=?',(batch,)).fetchone()
    found=db.execute('''SELECT count(*) FROM batch_targets t JOIN commission_rates r
     USING(batch_id,shop_id,platform,platform_link_id) WHERE batch_id=?''',(batch,)).fetchone()[0]
    if not targets or not found: fail('empty_batch')
    pending=db.execute("SELECT count(*) FROM capture_tasks WHERE batch_id=? AND status<>'done'",(batch,)).fetchone()[0]
    sampled,passed=db.execute('SELECT count(*),coalesce(sum(matches=1),0) FROM sample_checks WHERE batch_id=?',(batch,)).fetchone()
    quality=manifest['acceptance']
    if any(quality[k]!=v for k,v in {'targets':targets,'unique_links':links,'found':found,
           'coverage':found/targets,'pending_tasks':pending,'samples':sampled,'samples_passed':passed,
           'expected_links':b[1],'complete':bool(b[0])}.items()): fail('quality_metadata_mismatch')
    if mode=='accepted' and b[0]!=1: fail('batch_not_accepted')
    if mode=='accepted' and (links<b[1] or found/targets<.98): fail('coverage_gate_failed')
    if mode=='accepted' and pending: fail('incomplete_tasks')
    if mode=='partial' and (b[0] or not manifest.get('release_reason')): fail('invalid_partial_release')
    if mode=='accepted' and (sampled<10 or sampled!=passed):
        reference=db.execute('SELECT acceptance_reference,config_hash,adapter_hash FROM batch_runs WHERE batch_id=?',(batch,)).fetchone()
        ref=db.execute('SELECT complete,config_hash,adapter_hash FROM batch_runs WHERE batch_id=?',(reference[0],)).fetchone() if reference[0] else None
        if sampled or not ref or ref[0]!=1 or tuple(ref[1:])!=tuple(reference[1:]): fail('sample_gate_failed')
        n,ok=db.execute('SELECT count(*),coalesce(sum(matches=1),0) FROM sample_checks WHERE batch_id=?',(reference[0],)).fetchone()
        if n<10 or n!=ok: fail('sample_gate_failed')
    if db.execute('''SELECT 1 FROM commission_rates WHERE
     commission_enabled NOT IN (0,1) OR (commission_enabled=0 AND coalesce(commission_rate,0)<>0)
     OR (commission_enabled=1 AND commission_rate IS NULL) OR commission_rate<0 OR commission_rate>1 LIMIT 1''').fetchone():
        fail('invalid_commission')
    available,shops=db.execute('SELECT count(*),count(DISTINCT shop_id) FROM commission_rates_available_latest').fetchone()
    if not available or available!=manifest['available_row_count'] or shops!=manifest['available_shop_count']:
        fail('available_view_count_mismatch')
    if mode=='accepted' and not db.execute('SELECT 1 FROM commission_rates_latest LIMIT 1').fetchone():
        fail('empty_latest_view')


def guard_history(incoming,target):
    if not target.exists(): return
    if target.is_symlink(): fail('target_symlink')
    incoming.execute('ATTACH DATABASE ? AS prior',(target.resolve().as_uri()+'?mode=ro',))
    try:
        # Compare contents, not just counts or keys: a rate from a previous batch is immutable.
        for table in ('commission_rates','commission_overrides','batch_targets','publication_releases'):
            if incoming.execute(f'SELECT * FROM prior.{table} EXCEPT SELECT * FROM main.{table} LIMIT 1').fetchone():
                fail('would_rewrite_history')
        # Partial publications may later acquire a real manual review. Its expected values stay fixed.
        if incoming.execute('''SELECT batch_id,shop_id,platform,platform_link_id,expected_rate,expected_enabled
         FROM prior.sample_checks EXCEPT SELECT batch_id,shop_id,platform,platform_link_id,expected_rate,expected_enabled
         FROM main.sample_checks LIMIT 1''').fetchone(): fail('would_rewrite_history')
        if incoming.execute('''SELECT * FROM prior.sample_checks WHERE checked_at IS NOT NULL
         EXCEPT SELECT * FROM main.sample_checks LIMIT 1''').fetchone(): fail('would_rewrite_history')
        if incoming.execute('''SELECT batch_id FROM prior.batch_runs WHERE complete=1
         EXCEPT SELECT batch_id FROM main.batch_runs WHERE complete=1 LIMIT 1''').fetchone():
            fail('would_remove_accepted_batch')
    finally: incoming.execute('DETACH DATABASE prior')


def main(request):
    manifest=request['manifest'];publication=manifest['publication_id']
    if manifest.get('dataset')!='commission_rates' or manifest.get('schema_version')!=1 or not re.fullmatch(r'[a-f0-9-]{36}',publication):
        fail('invalid_manifest')
    stage=BASE/'incoming/commission-rates';stage.mkdir(parents=True,exist_ok=True,mode=0o700)
    source=stage/(publication+'.sqlite')
    if request['action']=='prepare': return {'ok':True,'incoming':str(source)}
    if request['action']!='apply': fail('invalid_action')
    lock=BASE/'state/commission-rates.publish.lock';lock.parent.mkdir(parents=True,exist_ok=True)
    with lock.open('a') as handle:
        fcntl.flock(handle,fcntl.LOCK_EX)
        # A lost ACK can be retried without creating a different publication.
        if TARGET.exists():
            with sqlite3.connect(TARGET.resolve().as_uri()+'?mode=ro',uri=True) as db:
                embedded=json.loads(db.execute('SELECT metadata_json FROM _warehouse_publication WHERE id=1').fetchone()[0])
            if embedded['publication_id']==publication:
                source=TARGET
        if not source.is_file() or source.is_symlink() or source.stat().st_size!=manifest['size_bytes']: fail('upload_size_mismatch')
        checksum=hashlib.sha256()
        with source.open('rb') as inp:
            for chunk in iter(lambda:inp.read(1024*1024),b''): checksum.update(chunk)
        if checksum.hexdigest()!=manifest['sha256']: fail('checksum_mismatch')
        with sqlite3.connect(source.resolve().as_uri()+'?mode=ro',uri=True) as db:
            validate(db,manifest)
            if source!=TARGET: guard_history(db,TARGET)
        TARGET.parent.mkdir(parents=True,exist_ok=True)
        import pwd,grp
        uid=pwd.getpwnam('xdrsync').pw_uid;gid=grp.getgrnam('xdrsync').gr_gid
        if source!=TARGET:
            os.chmod(source,0o640);os.chown(source,uid,gid)
            if TARGET.exists():
                backup=TARGET.with_name(TARGET.name+'.previous.'+publication)
                os.link(TARGET,backup);os.replace(backup,TARGET.with_name(TARGET.name+'.previous'))
            with source.open('rb') as inp: os.fsync(inp.fileno())
            os.replace(source,TARGET)
        receipt={**manifest,'ok':True,'path':str(TARGET),'published_at':datetime.now(timezone.utc).isoformat()}
        sidecar=Path(str(TARGET)+'.manifest.json');temporary=Path(str(sidecar)+'.'+publication)
        with temporary.open('w') as out:
            json.dump(receipt,out,ensure_ascii=False,indent=2);out.flush();os.fsync(out.fileno())
        os.chmod(temporary,0o640);os.chown(temporary,uid,gid);os.replace(temporary,sidecar)
        directory=os.open(TARGET.parent,os.O_RDONLY)
        try: os.fsync(directory)
        finally: os.close(directory)
        return receipt


if __name__=='__main__':
    try:
        print(json.dumps(main(REQUEST),ensure_ascii=False))
    except Exception as exc:
        code=str(exc) if isinstance(exc,ValueError) and re.fullmatch(r'[a-z_]+',str(exc)) else 'publication_failed'
        print(json.dumps({'ok':False,'code':code}))
