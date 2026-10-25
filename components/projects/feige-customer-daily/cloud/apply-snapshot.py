# Dedicated Feige publication helper. REQUEST is injected as base64 JSON over SSH stdin.
import os
import re
import sys
import json
import grp
import pwd
import fcntl
import sqlite3
import hashlib
from pathlib import Path
from datetime import datetime, timezone

os.umask(0o077)

TABLES = ('staff_daily', 'shop_daily', 'shop_snapshots', 'runs', 'shop_runs')
BASE = Path('/var/lib/xdr-sync')
TARGET = BASE / 'data/feige-customer.sqlite'

def fail(code):
    raise ValueError(code)

def validate(db, manifest):
    if db.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
        fail('invalid_sqlite')
    for table in TABLES:
        schema = [{'name': c[1], 'type': c[2], 'pk': c[5]} for c in db.execute('PRAGMA table_info(' + table + ')')]
        if schema != manifest['schema'][table]:
            fail('schema_mismatch')
        if db.execute('SELECT count(*) FROM ' + table).fetchone()[0] != manifest['row_counts'][table]:
            fail('row_count_mismatch')
    if not db.execute('SELECT 1 FROM shop_snapshots LIMIT 1').fetchone():
        fail('empty_snapshot')
    mismatch = db.execute('''SELECT s.stat_date,s.shop_id FROM shop_snapshots s LEFT JOIN staff_daily d
      ON d.stat_date=s.stat_date AND d.shop_id=s.shop_id GROUP BY s.stat_date,s.shop_id
      HAVING count(d.staff_id)<>s.total_staff LIMIT 1''').fetchone()
    if mismatch:
        fail('incomplete_shop')
    for view in ('v_staff_daily', 'v_shop_daily', 'v_shop_core_daily'):
        db.execute('SELECT * FROM ' + view + ' LIMIT 1').fetchone()
    embedded = json.loads(db.execute('SELECT metadata_json FROM _warehouse_publication WHERE id=1').fetchone()[0])
    if any(embedded.get(k) != manifest[k] for k in ('dataset', 'schema_version', 'publication_id', 'row_counts', 'dates')):
        fail('embedded_metadata_mismatch')

def guard_history(incoming, target):
    if not target.exists():
        return
    if target.is_symlink():
        fail('target_symlink')
    with sqlite3.connect('file:' + str(target) + '?mode=ro', uri=True) as old:
        fresh = {(d, s): at for d, s, at in incoming.execute('SELECT stat_date,shop_id,fetched_at FROM shop_snapshots')}
        for day, shop, stamp in old.execute('SELECT stat_date,shop_id,fetched_at FROM shop_snapshots'):
            if (day, shop) not in fresh:
                fail('would_remove_history')
            if fresh[(day, shop)] < stamp:
                fail('older_snapshot')

def main(request):
    manifest = request['manifest']
    publication = manifest['publication_id']
    if manifest['dataset'] != 'feige_customer' or manifest['schema_version'] != 1 or not re.fullmatch(r'[a-f0-9-]{36}', publication):
        fail('invalid_manifest')
    stage = BASE / 'incoming/feige-customer'
    stage.mkdir(mode=0o700, parents=True, exist_ok=True)
    source = stage / (publication + '.sqlite')
    if request['action'] == 'prepare':
        return {'ok': True, 'incoming': str(source)}
    if request['action'] != 'apply':
        fail('invalid_action')
    lock = BASE / 'state/feige-customer.publish.lock'
    lock.parent.mkdir(parents=True, exist_ok=True)
    with open(lock, 'a') as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        if not source.is_file() or source.is_symlink() or source.stat().st_size != manifest['size_bytes']:
            fail('upload_size_mismatch')
        digest = hashlib.sha256()
        with open(source, 'rb') as uploaded:
            for chunk in iter(lambda: uploaded.read(1024 * 1024), b''):
                digest.update(chunk)
        sha = digest.hexdigest()
        if sha != manifest['sha256']:
            fail('checksum_mismatch')
        with sqlite3.connect('file:' + str(source) + '?mode=ro', uri=True) as db:
            validate(db, manifest)
            guard_history(db, TARGET)
        uid, gid = pwd.getpwnam('xdrsync').pw_uid, grp.getgrnam('xdrsync').gr_gid
        os.chmod(source, 0o640)
        os.chown(source, uid, gid)
        TARGET.parent.mkdir(parents=True, exist_ok=True)
        if TARGET.exists():
            backup = TARGET.with_name(TARGET.name + '.previous.' + publication)
            os.link(TARGET, backup)
            os.replace(backup, TARGET.with_name(TARGET.name + '.previous'))
        with open(source, 'rb') as synced:
            os.fsync(synced.fileno())
        os.replace(source, TARGET)
        receipt = {'ok': True, 'dataset': 'feige_customer', 'path': str(TARGET), 'sha256': sha,
                   'publication_id': publication, 'published_at': datetime.now(timezone.utc).isoformat(),
                   'row_counts': manifest['row_counts'], 'dates': manifest['dates']}
        sidecar = TARGET.with_name(TARGET.name + '.manifest.json')
        temporary = sidecar.with_name(sidecar.name + '.' + publication)
        with open(temporary, 'w', encoding='utf-8') as output:
            json.dump(receipt, output, ensure_ascii=False, indent=2)
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temporary, 0o640)
        os.chown(temporary, uid, gid)
        os.replace(temporary, sidecar)
        return receipt

if __name__ == '__main__':
    try:
        print(json.dumps(main(REQUEST), ensure_ascii=False))
    except Exception as error:
        # Do not return arbitrary SQLite/SSH exception strings or row contents.
        code = str(error) if isinstance(error, ValueError) and re.fullmatch(r'[a-z_]+', str(error)) else 'publication_failed'
        print(json.dumps({'ok': False, 'code': code}))
