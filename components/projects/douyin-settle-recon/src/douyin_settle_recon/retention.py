"""Verify the cloud archive, then remove owned local run data.

Upload metadata, receipts, verification and cleanup journals remain in the queue.
No source template, credential file or path outside the configured run root is removed.
"""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import shutil
import time
from urllib.parse import quote, urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler, urlopen
from urllib.error import HTTPError, URLError

from .model import DataError, sha256
from .upload import Response, UPLOAD_PATH, _atomic_json, _lock, _receipt, queue_status

SHOPDESK_FINANCE_ROOT=Path.home()/'Library/Application Support/shopdesk/business-data/finance'


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):return None


def _read(path):return json.loads(Path(path).read_text(encoding='utf-8'))


def verify_cloud(task,config):
    if task['state']!='uploaded':raise DataError('local cleanup requires a confirmed upload')
    if task['account_id']!=config.account_id or task['api_base']!=config.base_url:raise DataError('archive belongs to another account/site')
    metadata_path=Path(task['metadata_path']);metadata=_read(metadata_path)
    if sha256(metadata_path)!=task['metadata_sha256']:raise DataError('frozen upload metadata changed')
    receipt=_read(task['receipt_path'])
    if receipt.get('local_run_id')!=metadata['local_run_id'] or receipt.get('excel_sha256')!=metadata['report']['sha256'] or receipt.get('stored') is not True:
        raise DataError('saved upload receipt does not confirm this report')
    # Query by report_id with the same Mac Worker identity. Do not forward
    # credentials across redirects or to the public download endpoint.
    request=Request(config.base_url+UPLOAD_PATH+'/'+quote(receipt['report_id'],safe=''),
        headers={'X-Invoice-Account-Id':config.account_id,'X-Invoice-Worker-Token':config.token})
    try:
        started=time.monotonic()
        with build_opener(NoRedirect()).open(request,timeout=30) as response:
            body=response.read(1024*1024+1)
            if len(body)>1024*1024:raise DataError('cloud report query response exceeds limit')
            verified=_receipt(Response(response.status,body),metadata,config)
        if not verified or verified['report_id']!=receipt['report_id']:raise DataError('cloud report query did not confirm the archived run')
        stored=json.loads(body)['data']['metadata']
        for key in ['shop_id','local_run_id','reconciliation_date','reconciliation_month','report']:
            if stored.get(key)!=metadata[key]:raise DataError('cloud stored metadata differs from the uploaded snapshot')
        if stored.get('shop_name')!=metadata.get('shop_name') or stored.get('reconciliation_status','pending')!=metadata.get('reconciliation_status','pending'):
            raise DataError('cloud stored business fields differ from the uploaded snapshot')
        if 'platform' in metadata and stored.get('platform')!=metadata['platform']:
            raise DataError('cloud platform differs from the uploaded snapshot')
        from .cloud_sync import sync_result
        sync=sync_result(json.loads(body)['data'],partial_accounts=task.get('partial_accounts',[]))
        _atomic_json(metadata_path.with_name('cloud-sync.json'),{'report_id':receipt['report_id'],**sync})
        url=verified['download_url'];parsed=urlsplit(url)
        if parsed.username or parsed.password:raise DataError('invalid public cloud download URL')
        with urlopen(Request(url,method='HEAD'),timeout=30) as response:
            if response.status!=200 or int(response.headers.get('Content-Length','-1'))!=metadata['report']['size_bytes']:
                raise DataError('cloud download HEAD does not match the Excel size')
        digest=hashlib.sha256();size=0
        with urlopen(url,timeout=30) as response:
            if response.status!=200:raise DataError('cloud Excel download is not available')
            while block:=response.read(1024*1024):
                if time.monotonic()-started>360:raise DataError('cloud verification exceeded 360 seconds; local data retained')
                size+=len(block)
                if size>metadata['report']['size_bytes']:raise DataError('cloud download exceeds declared Excel size')
                digest.update(block)
        if size!=metadata['report']['size_bytes'] or digest.hexdigest()!=metadata['report']['sha256']:
            raise DataError('cloud downloaded Excel hash/size mismatch; local data retained')
    except HTTPError as exc:raise DataError(f'cloud verification HTTP {exc.code}; local data retained') from None
    except (URLError,TimeoutError,OSError):raise DataError('cloud verification connection failed; local data retained') from None
    verification={'verified':True,'queried':True,'verified_at':datetime.now(timezone.utc).isoformat(),
        'local_run_id':metadata['local_run_id'],'report_id':receipt['report_id'],'download_url':url,
        'size_bytes':size,'sha256':digest.hexdigest(),'matches_original_excel':True,'cloud_sync':sync}
    _atomic_json(metadata_path.with_name('cloud-verification.json'),verification)
    return verification


def _owned(path,runs_root):
    path=Path(path)
    if path.is_symlink() or path.parent.resolve()!=runs_root or path.resolve()==runs_root:
        raise DataError('refusing cleanup outside a direct owned run directory')
    return path


def _plan_paths(plan,runs_root):
    paths=[_owned(Path(p),runs_root) for p in plan['roots']]
    for value in plan.get('bridge_roots',[]):
        p=Path(value)
        if not re.fullmatch(r'[a-f0-9-]{36}',p.name):raise DataError('invalid owned workbench session directory')
        paths.append(_owned(p,SHOPDESK_FINANCE_ROOT.resolve()))
    return paths


def _build_plan(task,runs_root,metadata=None):
    metadata=metadata or _read(task['metadata_path']);run=Path(task['report_path']).parent
    _owned(run,runs_root)
    if run.name!=task['local_run_id']:raise DataError('run directory does not match the archived run ID')
    manifest=_read(run/'manifest.json');result=_read(run/'result.json')
    if manifest['run_id']!=metadata['local_run_id'] or manifest['month']!=metadata['reconciliation_month']:
        raise DataError('local run does not match the cloud archive')
    source_shop=manifest['shop'];platform=source_shop.get('platform_shop_id');uuid=source_shop.get('shopdesk_shop_uuid')
    if source_shop.get('platform','douyin')!=metadata.get('platform','douyin'):
        raise DataError('local run platform does not match the cloud archive')
    if not platform:raise DataError('cleanup requires a verified platform shop identity')
    collections={};bridge_roots=[];todo=[]
    source=result.get('context',{}).get('collection_manifest') or task.get('collection_manifest')
    if source:todo.append(Path(source))
    while todo:
        file=todo.pop();directory=file.parent
        if str(directory) in collections:continue
        if directory.parent.resolve()!=runs_root or not directory.name.startswith('collection-') or not file.is_file():continue
        _owned(directory,runs_root);data=_read(file);shop=data.get('shop',{})
        same_owner=(str(shop['platform_shop_id'])==str(platform)) if shop.get('platform_shop_id') else bool(uuid and shop.get('shopdesk_shop_uuid')==uuid)
        same_owner=same_owner and shop.get('platform','douyin')==source_shop.get('platform','douyin')
        if data.get('month')!=metadata['reconciliation_month'] or not same_owner:
            raise DataError('collection cleanup ownership/period mismatch')
        collections[str(directory)]=True
        session=directory/'session.json'
        if session.is_file():
            owner=_read(session);eid=owner.get('exploration',{}).get('id','')
            if owner.get('shop',{}).get('id')==shop.get('shopdesk_shop_uuid') and re.fullmatch(r'[a-f0-9-]{36}',eid):
                bridge_roots.append(str(_owned(SHOPDESK_FINANCE_ROOT/eid,SHOPDESK_FINANCE_ROOT.resolve())))
        for item in data.get('inputs',[])+data.get('screenshots',[]):
            p=Path(item['path']);p=p if p.is_absolute() else file.parent/p
            for parent in p.parents:
                if parent.parent==runs_root:
                    todo.append(parent/'collection.json');break
    sources={a.get('artifact_id') for a in manifest.get('source_artifacts',[]) if a.get('artifact_id')}
    roots=[str(run)]
    # Superseded local attempts may share these very same downloaded inputs.
    # Remove only same-shop/month runs whose source hashes are all covered.
    for candidate in runs_root.glob('*/manifest.json'):
        other=candidate.parent
        if other==run:continue
        old=_read(candidate)
        if (old.get('month')!=manifest['month'] or str(old.get('shop',{}).get('platform_shop_id'))!=str(platform)
            or old.get('shop',{}).get('platform','douyin')!=source_shop.get('platform','douyin')):continue
        old_sources={a.get('artifact_id') for a in old.get('source_artifacts',[]) if a.get('artifact_id')}
        if old_sources and old_sources<=sources:
            _owned(other,runs_root);roots.append(str(other))
    roots+=list(collections)
    return {'local_run_id':metadata['local_run_id'],'runs_root':str(runs_root),'roots':list(dict.fromkeys(roots)),
            'bridge_roots':list(dict.fromkeys(bridge_roots)),
            'source_shop':source_shop,'source_artifacts':list(sources),'collection_manifest':source,
            'month':manifest['month'],'source_counts':result.get('table_counts',{}),
            'checks':result.get('checks',[]),'conclusion':manifest.get('conclusion')}


def cleanup_covered_duplicate(run_dir,canonical_task,config,*,runs_root=Path('data/runs')):
    """Remove a duplicate login's output only when all its input hashes are covered."""
    run=Path(run_dir);runs_root=Path(runs_root).resolve();_owned(run,runs_root)
    directory=Path(canonical_task['metadata_path']).parent
    journal=directory/('duplicate-cleanup-'+hashlib.sha256(run.name.encode()).hexdigest()+'.json')
    with _lock(directory/'.cleanup.lock'):
        previous=_read(journal) if journal.exists() else None
        if previous and previous['state']=='cleaned':return previous
        proof=verify_cloud(canonical_task,config)
        if _read(directory/'task.json').get('cleanup',{}).get('state')=='retained_partial':
            return {'state':'retained_partial','download_url':proof['download_url'],
                    'reason':'canonical report awaits Qianchuan supplementation; keep shared sources'}
        canonical=_read(directory/'cleanup-plan.json');metadata=_read(canonical_task['metadata_path'])
        if previous:plan=previous['plan']
        else:
            manifest=_read(run/'manifest.json')
            sources={a.get('artifact_id') for a in manifest.get('source_artifacts',[]) if a.get('artifact_id')}
            if (manifest.get('month')!=metadata['reconciliation_month']
                or str(manifest.get('shop',{}).get('platform_shop_id'))!=str(canonical['source_shop']['platform_shop_id'])
                or manifest.get('shop',{}).get('platform','douyin')!=metadata.get('platform','douyin')
                or not sources or not sources<=set(canonical['source_artifacts'])):
                raise DataError('duplicate source data is not fully covered by the verified archive; retained')
            artifacts={a['path']:a for a in manifest['artifacts']}
            for name in [manifest['report'],manifest['report_gzip']]:
                p=run/name
                if p.stat().st_size!=artifacts[name]['size'] or sha256(p)!=artifacts[name]['sha256']:
                    raise DataError('duplicate report was edited; retained')
            local_task={**canonical_task,'local_run_id':manifest['run_id'],'report_path':str(run/manifest['report'])}
            plan=_build_plan(local_task,runs_root,{**metadata,'local_run_id':manifest['run_id']})
        if Path(plan['runs_root'])!=runs_root or plan['local_run_id']!=run.name:raise DataError('duplicate cleanup journal mismatch')
        record={'state':'cleaning','plan':plan,'canonical_run_id':canonical_task['local_run_id'],
                'download_url':proof['download_url'],'source_hash_coverage_verified':True}
        _atomic_json(journal,record)
        for p in _plan_paths(plan,runs_root):
            if p.exists():shutil.rmtree(p)
        record.update(state='cleaned',cleaned_at=datetime.now(timezone.utc).isoformat());_atomic_json(journal,record)
        return record


def finalize_upload(task,config,*,runs_root=Path('data/runs')):
    """Cloud query + public HEAD/GET + SHA-256, followed by bounded cleanup."""
    directory=Path(task['metadata_path']).parent;task_path=directory/'task.json';runs_root=Path(runs_root).resolve()
    with _lock(directory/'.cleanup.lock'):
        task=_read(task_path)
        if task.get('cleanup',{}).get('state') in ['cleaned','retained_partial']:return task['cleanup']
        verification=verify_cloud(task,config)
        plan_path=directory/'cleanup-plan.json'
        plan=_read(plan_path) if plan_path.exists() else _build_plan(task,runs_root)
        if plan['local_run_id']!=task['local_run_id'] or Path(plan['runs_root'])!=runs_root:
            raise DataError('cleanup journal belongs to another run/root')
        # Never delete an edited local Excel that no longer matches its archive.
        metadata=_read(task['metadata_path'])
        for key,kind in [('report_path','report'),('gzip_path','upload')]:
            p=Path(task[key])
            if p.exists() and (p.stat().st_size!=metadata[kind]['size_bytes'] or sha256(p)!=metadata[kind]['sha256']):
                raise DataError('local report changed after upload; local data retained')
        result_path=Path(task['report_path']).parent/'result.json'
        from .collection_status import partial_qianchuan
        if result_path.is_file() and partial_qianchuan(_read(result_path).get('context',{})):
            task.update(source_shop=plan['source_shop'],collection_manifest=plan['collection_manifest'],
                        cleanup={'state':'retained_partial','download_url':verification['download_url'],'deleted':[],
                                 'reason':'千川无权限；保留有效来源，供权限恢复后补采',
                                 'verification_path':str(directory/'cloud-verification.json')})
            _atomic_json(task_path,task)
            return task['cleanup']
        paths=_plan_paths(plan,runs_root)
        if not plan_path.exists():_atomic_json(plan_path,plan)
        task.update(source_shop=plan['source_shop'],collection_manifest=plan['collection_manifest'],
                    cleanup={'state':'cleaning','download_url':verification['download_url'],'deleted':[]})
        _atomic_json(task_path,task)
        deleted=[]
        for p in paths:
            if p.exists():shutil.rmtree(p)
            deleted.append(str(p))
            task['cleanup']['deleted']=deleted;_atomic_json(task_path,task)
        task['cleanup'].update(state='cleaned',cleaned_at=datetime.now(timezone.utc).isoformat(),
                               verification_path=str(directory/'cloud-verification.json'))
        _atomic_json(task_path,task)
        return task['cleanup']


def finalize_queue(config,*,queue_dir=Path('data/upload-queue'),runs_root=Path('data/runs'),run_ids=None):
    results=[]
    for task in queue_status(queue_dir):
        if task['state']!='uploaded' or task['account_id']!=config.account_id or task['api_base']!=config.base_url:continue
        if run_ids is not None and task['local_run_id'] not in run_ids:continue
        try:results.append({'local_run_id':task['local_run_id'],**finalize_upload(task,config,runs_root=runs_root)})
        except (DataError,OSError,ValueError,KeyError) as exc:
            results.append({'local_run_id':task['local_run_id'],'state':'retained','error':str(exc)[:300]})
    return {'ok':all(r['state'] in ['cleaned','retained_partial'] for r in results),'reports':results}
