from __future__ import annotations

import base64
import hashlib
import json
import re
import sqlite3
import subprocess
import uuid
from pathlib import Path

from .model import CaptureError, DATASET, atomic_json, now, validate_row

TABLES=('commission_rates','batch_runs','batch_targets','commission_overrides','capture_tasks','capture_issues','sample_checks','publication_releases')
TARGET='/var/lib/xdr-sync/data/jst-commission-rates.sqlite'


def sha256(path):
    value=hashlib.sha256()
    with Path(path).open('rb') as inp:
        for chunk in iter(lambda:inp.read(1024*1024),b''): value.update(chunk)
    return value.hexdigest()


def snapshot(store,batch,output_dir,*,allow_partial=False,reason=None):
    b=store.batch(batch)
    report=store.report(batch)
    accepted=bool(b['complete'] and report['ready_to_accept'])
    if not accepted and not allow_partial:
        raise CaptureError('only accepted, fully validated batches can be published')
    mode='accepted' if accepted else 'partial'
    if mode=='partial' and (not reason or not reason.strip()):
        raise CaptureError('partial publication requires an explicit release reason')
    if not report['found']:
        raise CaptureError('cannot publish a batch with no captured links')
    if store.db.execute('PRAGMA quick_check').fetchone()[0]!='ok' or store.db.execute('PRAGMA foreign_key_check').fetchone():
        raise CaptureError('invalid SQLite source')
    for row in store.db.execute('SELECT * FROM commission_rates'):
        validate_row(dict(row))
    # Releasing data does not mark the collection or the manual review complete.
    with store.db:
        store.db.execute('INSERT OR IGNORE INTO publication_releases VALUES(?,?,?,?)',
                         (batch,mode,now(),reason or 'fully accepted batch'))
    output_dir=Path(output_dir);output_dir.mkdir(parents=True,exist_ok=True)
    publication=str(uuid.uuid4())
    # Immutable per-publication artifact, copied to the fixed target by cloud apply.
    output=output_dir/publication/'jst-commission-rates.sqlite'
    output.parent.mkdir(parents=True,mode=0o700)
    db=sqlite3.connect(output)
    try:
        store.db.backup(db)
        if db.execute('PRAGMA quick_check').fetchone()[0]!='ok': raise CaptureError('invalid SQLite snapshot')
        counts={t:db.execute('SELECT count(*) FROM '+t).fetchone()[0] for t in TABLES}
        manifest=dict(dataset=DATASET,schema_version=1,publication_id=publication,published_at=now(),
                      batch_id=batch,target=TARGET,row_counts=counts,acceptance=report,
                      publication_mode=mode,release_reason=reason or 'fully accepted batch',
                      available_row_count=db.execute('SELECT count(*) FROM commission_rates_available_latest').fetchone()[0],
                      available_shop_count=db.execute('SELECT count(DISTINCT shop_id) FROM commission_rates_available_latest').fetchone()[0])
        db.execute('CREATE TABLE IF NOT EXISTS _warehouse_publication(id INTEGER PRIMARY KEY CHECK(id=1),metadata_json TEXT NOT NULL)')
        db.execute('INSERT OR REPLACE INTO _warehouse_publication VALUES(1,?)',(json.dumps(manifest,ensure_ascii=False),))
        db.commit()
    finally: db.close()
    output.chmod(0o600)
    manifest.update(sha256=sha256(output),size_bytes=output.stat().st_size)
    atomic_json(str(output)+'.manifest.json',manifest)
    return {**manifest,'snapshot':str(output)}


def upload(snapshot_path,config):
    path=Path(snapshot_path).resolve()
    manifest=json.loads(Path(str(path)+'.manifest.json').read_text())
    if manifest.get('dataset')!=DATASET or manifest.get('target')!=TARGET:
        raise CaptureError('invalid dataset or target')
    if sha256(path)!=manifest['sha256'] or path.stat().st_size!=manifest['size_bytes']:
        raise CaptureError('local snapshot checksum/size mismatch')
    server=config.get('server',config)
    host=server['host'];port=server.get('port',22)
    if not re.fullmatch(r'[A-Za-z0-9.-]+',host) or type(port)!=int or not 0<port<65536:
        raise CaptureError('invalid SSH config')
    identity=str(Path(server['identity_file']).expanduser())
    opts=['-i',identity,'-o','BatchMode=yes','-o','ConnectTimeout=10']
    helper=Path(__file__).with_name('cloud_apply.py').read_text()
    def remote(action):
        encoded=base64.b64encode(json.dumps({'action':action,'manifest':manifest}).encode()).decode()
        script='import json,base64\nREQUEST=json.loads(base64.b64decode("'+encoded+'"))\n'+helper
        try:
            r=subprocess.run(['ssh',*opts,'-p',str(port),'root@'+host,'python3 -'],input=script,text=True,
                             capture_output=True,timeout=180,check=True)
            ack=json.loads(r.stdout)
        except (subprocess.SubprocessError,ValueError):
            raise CaptureError('cloud_transport_failed; local snapshot preserved') from None
        if not ack.get('ok'): raise CaptureError('cloud_rejected: '+ack.get('code','unknown'))
        return ack
    prepared=remote('prepare')
    try:
        subprocess.run(['scp','-O',*opts,'-P',str(port),str(path),'root@'+host+':'+prepared['incoming']],
                       capture_output=True,timeout=180,check=True)
    except subprocess.SubprocessError:
        raise CaptureError('cloud_upload_failed; local snapshot preserved') from None
    ack=remote('apply')
    if any(ack.get(k)!=manifest[k] for k in ('dataset','publication_id','sha256','row_counts','publication_mode','available_row_count')):
        raise CaptureError('cloud ACK mismatch')
    atomic_json(path.parent/'cloud-ack.json',ack)
    return ack
