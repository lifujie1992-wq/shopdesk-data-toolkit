"""Checkpointed all-shop monthly collection and cloud delivery.

launchd starts a cycle at 01:00 on day 1. Its hourly wake-up only continues
already due cycles; installation never starts an unsolicited historical run.
"""
from __future__ import annotations

from datetime import datetime, timedelta
import json
from pathlib import Path
import shutil
from zoneinfo import ZoneInfo

from .collect import KINDS, collect_and_build
from .model import DataError, month_bounds, sha256
from .shopdesk import ShopDesk, ShopDeskError
from .upload import UploadConfig, _atomic_json, _lock, _task_key, drain_queue, enqueue_run
from .retention import finalize_upload, cleanup_covered_duplicate
from .collection_status import deliverable

ZONE=ZoneInfo('Asia/Shanghai')
DEFAULT_STATE=Path('data/monthly')
COLLECTION_ATTEMPTS=5
COLLECTION_BACKOFF=(1800,7200,21600,86400)
TERMINAL={'uploaded','duplicate','failed'}
WAITING={'awaiting_verification'}


def now():return datetime.now(ZONE)


def previous_month(at=None):
    at=(at or now()).astimezone(ZONE)
    return (at.replace(day=1)-timedelta(days=1)).strftime('%Y-%m')


def next_month(at):
    return at.replace(year=at.year+(at.month==12),month=at.month%12+1,day=1)


def first_due(at=None):
    at=(at or now()).astimezone(ZONE)
    due=at.replace(day=1,hour=1,minute=0,second=0,microsecond=0)
    return next_month(due) if due<at else due


def configure_schedule(state_dir=DEFAULT_STATE):
    root=Path(state_dir).resolve()
    with _lock(root/'.monthly.lock'):
        path=root/'schedule.json'
        if path.exists():return json.loads(path.read_text())
        config={'schema_version':'1.0','timezone':'Asia/Shanghai','enabled_at':now().isoformat(),
                'next_due_at':first_due().isoformat()}
        _atomic_json(path,config)
        return config


def _read(path):return json.loads(path.read_text(encoding='utf-8'))


def _save(batch,path):
    batch['updated_at']=now().isoformat()
    jobs=batch['shops'];counts={status:sum(j['state']==status for j in jobs) for status in sorted({j['state'] for j in jobs})}
    batch['counts']=counts
    batch['state']=('complete' if all(j['state'] in ['uploaded','duplicate'] for j in jobs)
                    else 'awaiting_input' if any(j['state'] in WAITING for j in jobs) and all(j['state'] in TERMINAL|WAITING for j in jobs)
                    else 'failed' if all(j['state'] in TERMINAL for j in jobs) else 'running')
    _atomic_json(path,batch)


def _new_batch(root,month,shops,template):
    month_bounds(month)
    if not shops:raise DataError('ShopDesk returned no Douyin shops; will not create an empty successful cycle')
    path=root/month/'batch.json'
    if path.exists():return _read(path),path
    directory=path.parent;directory.mkdir(parents=True,exist_ok=True)
    frozen=directory/'template.xlsx';shutil.copy2(template,frozen)
    # Keep every login until the platform ID is verified. Equal display names
    # alone cannot prove that two sessions belong to the same business shop.
    unique={s['id']:s for s in shops}
    batch={'schema_version':'1.0','month':month,'created_at':now().isoformat(),'template':str(frozen),
           'template_sha256':sha256(frozen),'requested_kinds':list(KINDS),
           'shops':[{'shopdesk_shop_uuid':s['id'],'shop_name':s['name'],'state':'pending',
                     'collection_attempts':0,'next_attempt_at':None,'collection_history':[]}
                    for s in sorted(unique.values(),key=lambda s:(s['name'],s['id']))]}
    _save(batch,path)
    return batch,path


def _resume(job,month,uuid):
    p=Path(job.get('collection_manifest',''))
    if not p.is_file():return None
    data=_read(p)
    # A new login gets a fresh verified collection. Never attach an old
    # session's raw account data to an unverified replacement session.
    if data.get('month')==month and data.get('shop',{}).get('shopdesk_shop_uuid')==uuid:return p
    return None


def _complete_collection(path,kinds):
    data=_read(Path(path));receipts=data.get('collection',[])
    return (all(deliverable(r) for r in receipts)
            and set(kinds)<={r.get('role') for r in receipts})


def _fail_collection(job,error):
    job['last_error']={'phase':'collection','message':str(error)[:600]}
    if job['collection_attempts']>=COLLECTION_ATTEMPTS:
        job.update(state='failed',next_attempt_at=None)
    else:
        delay=COLLECTION_BACKOFF[min(job['collection_attempts']-1,len(COLLECTION_BACKOFF)-1)]
        job.update(state='retry_collection',next_attempt_at=(now()+timedelta(seconds=delay)).isoformat())


def _current_shop(job,shops):
    direct=next((s for s in shops if s['id']==job['shopdesk_shop_uuid']),None)
    if direct:return direct
    matches=[s for s in shops if s['name']==job['shop_name']]
    if len(matches)==1:return matches[0]
    raise ShopDeskError('original login no longer exists or its replacement is ambiguous; check this shop in ShopDesk')


def _process_batch(batch,path,shops,config,output,queue_dir,collector,*,retry_failed=False,retry_incomplete=False):
    if sha256(Path(batch['template']))!=batch['template_sha256']:raise DataError('monthly template snapshot changed')
    if retry_incomplete:
        for job in batch['shops']:
            if job.get('replenishing') and job['state'] in {'failed','retry_collection'}|WAITING:
                job.update(state='pending',collection_attempts=0,next_attempt_at=None)
            elif job.get('partial_accounts') and job['state'] in ['uploaded','verify_cloud'] and job.get('receipt_path'):
                # An archived partial report is immutable. Resume its sources
                # into a new calculation; never reuse its upload run identity.
                job.setdefault('archive_history',[]).append({k:job[k] for k in
                    ['result','receipt_path','upload_task_path','retention','cloud_sync','partial_accounts'] if k in job})
                job['previous_partial_run_id']=job['result']['run_id']
                for key in ['result','receipt_path','upload_task_path','retention','cloud_sync','collection_complete']:
                    job.pop(key,None)
                job.update(state='pending',replenishing=True,collection_attempts=0,next_attempt_at=None)
        _save(batch,path)
    if retry_failed:
        for job in batch['shops']:
            if job['state'] in {'failed','retry_collection'}|WAITING:
                if job.get('result') and job.get('collection_complete'):
                    job.update(state='alias_wait' if job.get('duplicate_of') else 'retry_upload',retry_failed_upload=True)
                else:job.update(state='pending',collection_attempts=0)
                job['next_attempt_at']=None
        _save(batch,path)
    # If one alias has already identified a platform shop, prefer continuing
    # that report/upload rather than creating another run via its second login.
    def canonical_for(job):
        return next((j for j in batch['shops'] if j is not job and j.get('platform_shop_id')==job.get('platform_shop_id')
                     and j.get('collection_complete') and not j.get('duplicate_of')),None)
    def finish_archive(job):
        try:
            task_path=job.get('upload_task_path') or str(Path(job['receipt_path']).with_name('task.json'))
            cleanup=finalize_upload(_read(Path(task_path)),config,runs_root=output)
            job.update(state='uploaded',retention=cleanup,download_url=cleanup['download_url'],next_attempt_at=None,last_error=None)
        except (DataError,OSError,ValueError,KeyError) as exc:
            job.update(state='verify_cloud',next_attempt_at=(now()+timedelta(hours=1)).isoformat(),
                       last_error={'phase':'verification_cleanup','message':str(exc)[:300]})
        sync_path=Path(task_path).with_name('cloud-sync.json')
        if sync_path.is_file():job['cloud_sync']=_read(sync_path)
        _save(batch,path)
    for job in batch['shops']:
        if job['state']=='uploaded':
            if job.get('retention',{}).get('state') not in ['cleaned','retained_partial']:finish_archive(job)
            continue
        if job['state'] in TERMINAL|WAITING:continue
        if job.get('duplicate_of'):continue
        if job.get('next_attempt_at') and datetime.fromisoformat(job['next_attempt_at'])>now():continue
        if job['state']=='verify_cloud':finish_archive(job);continue
        existing=canonical_for(job) if job.get('platform_shop_id') else None
        if existing and existing['state']=='uploaded':
            job.update(state='duplicate',duplicate_of=existing['shopdesk_shop_uuid'],
                       canonical_run_id=existing['result']['run_id'],next_attempt_at=None,last_error=None)
            _save(batch,path);continue
        # A process can stop immediately after the collector's final checkpoint.
        # Recover that completed run rather than calculating a second run ID.
        if not job.get('collection_complete') and job.get('result') and job.get('collection_manifest'):
            result=job['result'];manifest_path=Path(result['run_dir'])/'manifest.json'
            same_collection=result.get('collection_manifest')==job['collection_manifest']
            if same_collection and manifest_path.is_file() and _complete_collection(job['collection_manifest'],batch['requested_kinds']):
                platform_id=_read(manifest_path).get('shop',{}).get('platform_shop_id')
                report_manifest=_read(manifest_path)
                if platform_id and report_manifest.get('upload_ready') is not False and not job.get('replenishing'):
                    job.update(collection_complete=True,platform_shop_id=platform_id,state='ready_upload',
                               partial_accounts=report_manifest.get('partial_accounts',[]))
        if not job.get('collection_complete'):
            if not shops:
                job.update(state='retry_collection',next_attempt_at=(now()+timedelta(seconds=1800)).isoformat(),
                           last_error={'phase':'collection','message':'workbench unavailable; waiting without consuming a collection attempt'})
                _save(batch,path);continue
            job.update(state='collecting',collection_attempts=job['collection_attempts']+1,next_attempt_at=None)
            _save(batch,path)
            def checkpoint(event):
                collection=event['collection_manifest'];job['collection_manifest']=collection
                if collection not in job['collection_history']:job['collection_history'].append(collection)
                if event.get('result'):job['result']=event['result']
                _save(batch,path)
            try:
                shop=_current_shop(job,shops)
                prior=_resume(job,batch['month'],shop['id'])
                result=collector(kinds=batch['requested_kinds'],resume=prior,on_checkpoint=checkpoint,
                                 month=batch['month'],shop_name=job['shop_name'],shopdesk_shop_uuid=shop['id'],
                                 platform_shop_id=job.get('platform_shop_id'),output=output,template=Path(batch['template']))
                job['result']=result;job['collection_manifest']=result['collection_manifest']
                manifest=_read(Path(result['run_dir'])/'manifest.json')
                if manifest.get('shop',{}).get('shop_name'):job['shop_name']=manifest['shop']['shop_name']
                platform_id=manifest.get('shop',{}).get('platform_shop_id')
                if platform_id:job['platform_shop_id']=platform_id
                if not _complete_collection(job['collection_manifest'],batch['requested_kinds']):
                    data=_read(Path(job['collection_manifest']))
                    failures=[{'role':r.get('role'),'entity':r.get('entity'),'error':r.get('error')} for r in data.get('collection',[]) if not deliverable(r)]
                    job['collection_errors']=failures
                    raise DataError('collection is incomplete; partial report retained locally, retry remaining accounts before cloud delivery')
                if manifest.get('upload_ready') is False:
                    raise DataError('final Excel expense/cache validation failed; see report-validation.json, retry source collection')
                if not platform_id:raise DataError('no verified platform shop ID; cannot archive using a login UUID')
                job['partial_accounts']=manifest.get('partial_accounts',[])
                if job.get('replenishing') and job['partial_accounts']:
                    job.update(state='awaiting_verification',next_attempt_at=None,
                               last_error={'phase':'collection','message':'千川权限尚未恢复；保留已有云端部分账单，本次不重复上传，开通后使用 --retry-incomplete 补采'})
                    _save(batch,path);continue
                if job.get('replenishing') and result['run_id']==job.get('previous_partial_run_id'):
                    raise DataError('supplemented source data must use a new calculation run ID')
                job.pop('replenishing',None)
                job.update(collection_complete=True,state='ready_upload',last_error=None)
                job.pop('collection_errors',None)
                _save(batch,path)
            except (DataError,ShopDeskError,OSError,ValueError) as exc:
                _fail_collection(job,exc);_save(batch,path);continue
            except Exception as exc:
                # Unexpected per-shop adapter/payload errors must also retain
                # the checkpoint and let the remaining independent shops run.
                _fail_collection(job,f'{type(exc).__name__}: {exc}')
                job['last_error']['exception_type']=type(exc).__name__
                _save(batch,path);continue
        collection_path=Path(job.get('collection_manifest',''))
        if collection_path.is_file():
            # Retain source outcomes after verified cloud delivery cleans raw files.
            job['collection_summary']=[{k:r[k] for k in ['role','status','entity','error','reason'] if k in r}
                                       for r in _read(collection_path).get('collection',[])]
        existing=canonical_for(job)
        if existing:
            job.update(state='duplicate',duplicate_of=existing['shopdesk_shop_uuid'],canonical_run_id=existing['result']['run_id'])
            _save(batch,path);continue
        try:
            # Upload retries use the already generated run and frozen metadata.
            result=job['result']
            enqueue_run(Path(result['run_dir']),config,queue_dir=queue_dir)
            delivery=drain_queue(config,queue_dir=queue_dir,run_ids={result['run_id']},retry_failed=job.pop('retry_failed_upload',False))
            task=delivery['tasks'][0]
            job['upload_task_path']=task['task_path']
            job['next_attempt_at']=task.get('next_attempt_at')
            if delivery['ok']:
                job.update(state='uploaded',receipt_path=task['receipt_path'],last_error=None)
                finish_archive(job)
            else:
                job.update(state='failed' if task['state']=='failed' else 'retry_upload',last_error={'phase':'upload',**task.get('last_error',{})})
        except (DataError,OSError,ValueError) as exc:
            # A local configuration/identity conflict needs correction, not a new run.
            job.update(state='failed',last_error={'phase':'upload','message':str(exc)[:600]},next_attempt_at=None)
        _save(batch,path)
    # An alias is covered only when its canonical report really reached cloud.
    for job in batch['shops']:
        existing=canonical_for(job) if job.get('platform_shop_id') else None
        if job['state'] in ['retry_collection','failed'] and existing and existing['state']=='uploaded':
            job.update(state='duplicate',duplicate_of=existing['shopdesk_shop_uuid'],
                       canonical_run_id=existing['result']['run_id'],next_attempt_at=None,last_error=None)
        if job['state']=='duplicate':
            canonical=next((j for j in batch['shops'] if j['shopdesk_shop_uuid']==job['duplicate_of']),None)
            if canonical and canonical['state']=='failed':
                job.update(state='failed',last_error={'phase':'upload','message':'canonical report upload failed'})
            elif not canonical or canonical['state']!='uploaded':
                job['state']='alias_wait'
                job['next_attempt_at']=canonical.get('next_attempt_at') if canonical else None
        elif job['state']=='alias_wait':
            canonical=next((j for j in batch['shops'] if j['shopdesk_shop_uuid']==job['duplicate_of']),None)
            if canonical and canonical['state']=='uploaded':job.update(state='duplicate',next_attempt_at=None)
            elif canonical and canonical['state']=='failed':job.update(state='failed',last_error={'phase':'upload','message':'canonical report upload failed'})
        if job['state']=='duplicate' and job.get('retention',{}).get('state') not in ['cleaned','retained_partial']:
            canonical=next((j for j in batch['shops'] if j['shopdesk_shop_uuid']==job['duplicate_of']),None)
            if canonical and canonical.get('receipt_path') and job.get('result') and Path(job['result']['run_dir']).exists():
                try:
                    task=_read(Path(canonical['receipt_path']).with_name('task.json'))
                    job['retention']=cleanup_covered_duplicate(Path(job['result']['run_dir']),task,config,runs_root=output)
                except (DataError,OSError,ValueError,KeyError) as exc:job['local_cleanup_error']=str(exc)[:300]
    _save(batch,path)


def monthly_run(*,month=None,scheduled=False,dry_run=False,state_dir=DEFAULT_STATE,output=Path('data/runs'),
                template=Path('doc/【抖音】月度账单处理模版.xlsx'),queue_dir=Path('data/upload-queue'),
                upload_config=None,retry_failed=False,retry_incomplete=False,bridge=None,collector=None):
    root=Path(state_dir).resolve();output=Path(output).resolve()
    bridge=bridge or ShopDesk();collector=collector or collect_and_build
    if scheduled and month:raise DataError('--scheduled determines due months; do not pass --month')
    if scheduled and retry_incomplete:raise DataError('--retry-incomplete is a manual operation; pass --month instead of --scheduled')
    target=month or previous_month()
    month_bounds(target)
    if dry_run:
        shops=bridge.shops()
        return {'dry_run':True,'month':target,'timezone':'Asia/Shanghai','login_records':len(shops),
                'distinct_shop_names':len({s['name'] for s in shops}),'requested_kinds':list(KINDS),
                'shops':[{'id':s['id'],'name':s['name']} for s in shops],
                'deduplication':'verified platform shop ID after collection','first_due_at':first_due().isoformat()}
    config=UploadConfig.load(upload_config)
    with _lock(root/'.monthly.lock'):
        if scheduled:
            schedule_path=root/'schedule.json'
            if not schedule_path.exists():raise DataError('install the monthly schedule before scheduled execution')
            schedule=_read(schedule_path)
            pending=[p for p in sorted(root.glob('????-??/batch.json')) if _read(p)['state']=='running']
            due=datetime.fromisoformat(schedule['next_due_at'])
            if not pending and due>now():return {'ok':True,'skipped':'no monthly cycle due','next_due_at':due.isoformat()}
        else:pending=[]
        try:shops=bridge.shops()
        except ShopDeskError:
            if not pending:raise
            shops=[]  # Existing uploads can finish even while the workbench is offline.
        if scheduled:
            if due<=now() and not shops and not pending:raise DataError('no shops available for the due monthly cycle; will retry discovery')
            while due<=now() and shops:
                batch,path=_new_batch(root,previous_month(due),shops,Path(template))
                if path not in pending and batch['state']=='running':pending.append(path)
                due=next_month(due)
                schedule.update(next_due_at=due.isoformat(),last_started_at=now().isoformat())
                _atomic_json(schedule_path,schedule)
        else:
            _,path=_new_batch(root,target,shops,Path(template));pending=[path]
        results=[]
        for path in pending:
            batch=_read(path)
            _process_batch(batch,path,shops,config,output,queue_dir,collector,retry_failed=retry_failed,retry_incomplete=retry_incomplete)
            results.append({'month':batch['month'],'state':batch['state'],'counts':batch['counts'],'batch_path':str(path),
                            'partial_shops':sum(bool(j.get('partial_accounts')) for j in batch['shops'])})
        return {'ok':all(b['state']=='complete' for b in results),'batches':results,
                **({'next_due_at':schedule['next_due_at']} if scheduled else {})}
