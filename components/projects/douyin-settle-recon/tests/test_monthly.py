from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import plistlib
from types import SimpleNamespace

import pytest

from douyin_settle_recon import monthly, scheduler
from douyin_settle_recon.collect import KINDS
from douyin_settle_recon.model import DataError
from douyin_settle_recon.shopdesk import ShopDeskError
from douyin_settle_recon.upload import UploadConfig, _atomic_json
from test_local_pipeline import TEMPLATE


@pytest.fixture
def env(tmp_path,monkeypatch):
    clock=[datetime(2026,11,1,1,0,tzinfo=monthly.ZONE)]
    monkeypatch.setattr(monthly,'now',lambda:clock[0])
    monkeypatch.setattr(monthly.UploadConfig,'load',classmethod(lambda cls,*a,**k:UploadConfig('http://127.0.0.1:1','account','test-token')))
    shops=[{'id':'login-1','name':'店铺一'},{'id':'login-2','name':'店铺二'}]
    calls=[];uploads=[];behaviors={};deliveries={};platforms={'login-1':'P1','login-2':'P2','login-3':'P1'}
    def collect(**options):
        calls.append(options);shop=options['shopdesk_shop_uuid'];attempt=sum(c['shopdesk_shop_uuid']==shop for c in calls)
        action=behaviors.get(shop)
        if action=='error':raise ShopDeskError('needs_login: sign in this shop')
        root=Path(options['output'])/f'{shop}-{attempt}';root.mkdir(parents=True)
        collection=root/'collection.json'
        receipts=[{'role':r,'status':'no_activity'} for r in KINDS]
        if action=='partial':receipts[-1]={'role':list(KINDS)[-1],'status':'error','error':'subject report is not ready'}
        if action=='qianchuan_denied':
            receipts=[r if r['role']!='qianchuan' else {'role':'qianchuan','status':'permission_denied','error':'千川入口权限不足'} for r in receipts]
        _atomic_json(collection,{'month':options['month'],'shop':{'shopdesk_shop_uuid':shop},'collection':receipts})
        _atomic_json(root/'manifest.json',{'shop':{'platform_shop_id':platforms[shop]},
                                         'partial_accounts':['千川账户'] if action=='qianchuan_denied' else []})
        result={'run_id':root.name,'run_dir':str(root),'collection_manifest':str(collection)}
        if action=='interrupt_before_build':
            options['on_checkpoint']({'collection_manifest':str(collection)})
            raise KeyboardInterrupt
        options['on_checkpoint']({'collection_manifest':str(collection),'result':result})
        if action=='interrupt':raise KeyboardInterrupt
        return result
    def enqueue(root,config,**kwargs):
        uploads.append(Path(root).name)
        return {}
    def drain(config,*,run_ids,**kwargs):
        run=next(iter(run_ids));state=deliveries.get(run,'uploaded')
        task={'state':state,'task_path':str(tmp_path/'tasks'/run),'receipt_path':str(tmp_path/'receipts'/run),
              'next_attempt_at':(clock[0]+timedelta(seconds=60)).isoformat() if state=='retry_wait' else None,
              'last_error':{'code':'RATE_LIMITED'} if state!='uploaded' else None}
        _atomic_json(Path(task['task_path']),task)
        return {'ok':state=='uploaded','tasks':[task]}
    monkeypatch.setattr(monthly,'enqueue_run',enqueue);monkeypatch.setattr(monthly,'drain_queue',drain)
    monkeypatch.setattr(monthly,'finalize_upload',lambda *a,**kw:{'state':'cleaned','download_url':'https://example.com/report.xlsx'})
    monkeypatch.setattr(monthly,'cleanup_covered_duplicate',lambda *a,**kw:{'state':'cleaned'})
    bridge=SimpleNamespace(shops=lambda:list(shops))
    options={'state_dir':tmp_path/'monthly','output':tmp_path/'runs','queue_dir':tmp_path/'queue',
             'template':TEMPLATE,'bridge':bridge,'collector':collect}
    return SimpleNamespace(clock=clock,shops=shops,calls=calls,uploads=uploads,behaviors=behaviors,
                           deliveries=deliveries,platforms=platforms,options=options,tmp=tmp_path)


def batch(e,month='2026-10'):return json.loads((e.options['state_dir']/month/'batch.json').read_text())


def test_previous_month_beijing_year_and_day_boundaries():
    assert monthly.previous_month(datetime(2026,1,1,1,tzinfo=monthly.ZONE))=='2025-12'
    assert monthly.previous_month(datetime(2025,12,31,18,tzinfo=timezone.utc))=='2025-12'
    assert monthly.previous_month(datetime(2026,3,1,1,tzinfo=monthly.ZONE))=='2026-02'
    assert monthly.previous_month(datetime(2024,3,1,1,tzinfo=monthly.ZONE))=='2024-02'
    assert monthly.first_due(datetime(2026,10,19,22,tzinfo=monthly.ZONE)).isoformat()=='2026-11-01T01:00:00+08:00'
    assert monthly.first_due(datetime(2026,12,31,22,tzinfo=monthly.ZONE)).isoformat()=='2027-01-01T01:00:00+08:00'


def test_all_shops_dynamic_previous_month_delivery_and_rerun_does_not_recollect(env):
    e=env;result=monthly.monthly_run(**e.options)
    assert result['ok'] and result['batches'][0]['counts']=={'uploaded':2}
    assert len(e.calls)==len(e.uploads)==2
    assert all(c['month']=='2026-10' and set(c['kinds'])==set(KINDS) for c in e.calls)
    frozen=batch(e)['template'];assert Path(frozen).read_bytes()==TEMPLATE.read_bytes()
    assert all(c['template']==Path(frozen) for c in e.calls)
    assert monthly.monthly_run(**e.options)['ok']
    assert len(e.calls)==len(e.uploads)==2


def test_duplicate_sessions_use_verified_platform_id_not_shop_name(env):
    e=env;e.shops.append({'id':'login-3','name':'不同显示名的重复登录'})
    result=monthly.monthly_run(**e.options)
    assert result['ok'];assert sorted(result['batches'][0]['counts'].values())==[1,2]
    assert len(e.calls)==3 and len(e.uploads)==2
    duplicate=next(j for j in batch(e)['shops'] if j['state']=='duplicate')
    assert duplicate['platform_shop_id']=='P1'
    # Identical names with different verified IDs still produce both reports.
    e.options['state_dir']=e.tmp/'second-state';e.options['output']=e.tmp/'second-runs';e.shops[:]=[{'id':'login-1','name':'相同店名'},{'id':'login-2','name':'相同店名'}]
    e.calls.clear();e.uploads.clear()
    assert monthly.monthly_run(**e.options)['ok'] and len(e.uploads)==2


def test_single_shop_failure_continues_others_and_retries_only_failed_work(env):
    e=env;e.behaviors['login-1']='error'
    result=monthly.monthly_run(**e.options)
    assert not result['ok'] and len(e.calls)==2 and len(e.uploads)==1
    jobs={j['shopdesk_shop_uuid']:j for j in batch(e)['shops']}
    assert jobs['login-1']['state']=='retry_collection' and jobs['login-2']['state']=='uploaded'
    monthly.monthly_run(**e.options);assert len(e.calls)==2
    e.clock[0]+=timedelta(minutes=31);e.behaviors.clear()
    assert monthly.monthly_run(**e.options)['ok']
    assert len(e.calls)==3 and len(e.uploads)==2


def test_partial_collection_is_checkpointed_resumed_and_not_uploaded(env):
    e=env;e.behaviors['login-1']='partial'
    monthly.monthly_run(**e.options)
    job=next(j for j in batch(e)['shops'] if j['shopdesk_shop_uuid']=='login-1')
    assert job['state']=='retry_collection' and job['collection_errors'][0]['role']==list(KINDS)[-1]
    assert e.uploads==['login-2-1']
    old=job['collection_manifest'];e.clock[0]+=timedelta(minutes=31);e.behaviors.clear()
    assert monthly.monthly_run(**e.options)['ok']
    assert e.calls[-1]['resume']==Path(old)
    assert len(next(j for j in batch(e)['shops'] if j['shopdesk_shop_uuid']=='login-1')['collection_history'])==2


def test_qianchuan_permission_denied_uploads_partial_then_supplements_only_that_shop(env):
    e=env;e.behaviors['login-1']='qianchuan_denied'
    result=monthly.monthly_run(**e.options)
    assert result['ok'] and len(e.uploads)==2
    job=next(j for j in batch(e)['shops'] if j['shopdesk_shop_uuid']=='login-1')
    assert job['state']=='uploaded' and job['partial_accounts']==['千川账户']
    old=job['result']['run_id'];collection=job['collection_manifest']
    assert monthly.monthly_run(**e.options)['ok'] and len(e.uploads)==2
    e.behaviors.clear()
    assert monthly.monthly_run(**e.options,retry_incomplete=True)['ok']
    assert len(e.uploads)==3 and len(e.calls)==3 and e.calls[-1]['resume']==Path(collection)
    job=next(j for j in batch(e)['shops'] if j['shopdesk_shop_uuid']=='login-1')
    assert job['result']['run_id']!=old and not job['partial_accounts']
    assert job['archive_history'][0]['result']['run_id']==old and job['platform_shop_id']=='P1'


def test_still_denied_supplement_does_not_reupload_same_partial_data(env):
    e=env;e.behaviors['login-1']='qianchuan_denied'
    assert monthly.monthly_run(**e.options)['ok']
    assert not monthly.monthly_run(**e.options,retry_incomplete=True)['ok']
    assert len(e.uploads)==2 and len(e.calls)==3
    assert not monthly.monthly_run(**e.options)['ok'] and len(e.calls)==3
    e.behaviors.clear()
    assert monthly.monthly_run(**e.options,retry_incomplete=True)['ok']
    assert len(e.uploads)==3 and e.uploads[-1]=='login-1-3'


def test_upload_retry_reuses_original_report_without_collecting_again(env):
    e=env;e.deliveries['login-1-1']='retry_wait'
    monthly.monthly_run(**e.options)
    assert len(e.calls)==2 and not monthly.monthly_run(**e.options)['ok']
    assert len(e.calls)==2 and len(e.uploads)==2
    e.clock[0]+=timedelta(seconds=61);e.deliveries.clear()
    assert monthly.monthly_run(**e.options)['ok']
    assert len(e.calls)==2 and e.uploads==['login-1-1','login-2-1','login-1-1']


def test_manual_recovery_can_resume_fixed_collection_before_automatic_backoff(env):
    e=env;e.behaviors['login-1']='partial'
    monthly.monthly_run(**e.options)
    old=next(j for j in batch(e)['shops'] if j['shopdesk_shop_uuid']=='login-1')['collection_manifest']
    e.behaviors.clear()
    assert monthly.monthly_run(**e.options,retry_failed=True)['ok']
    assert len(e.calls)==3 and e.calls[-1]['resume']==Path(old)
    assert len(e.uploads)==2  # The already delivered second shop is untouched.


def test_alias_does_not_create_a_new_cloud_run_when_canonical_upload_is_waiting_or_failed(env):
    e=env;e.shops.append({'id':'login-3','name':'重复登录'})
    e.deliveries['login-1-1']='retry_wait'
    assert not monthly.monthly_run(**e.options)['ok']
    assert len(e.uploads)==2
    alias=next(j for j in batch(e)['shops'] if j.get('duplicate_of'))
    assert alias['state']=='alias_wait'
    e.clock[0]+=timedelta(seconds=61);e.deliveries['login-1-1']='failed'
    assert not monthly.monthly_run(**e.options)['ok']
    assert e.uploads.count('login-3-1')==0
    e.deliveries.clear()
    assert monthly.monthly_run(**e.options,retry_failed=True)['ok']
    assert len(e.calls)==3 and all(run!='login-3-1' for run in e.uploads)


def test_completed_collector_checkpoint_survives_process_interruption(env):
    e=env;e.behaviors['login-1']='interrupt'
    with pytest.raises(KeyboardInterrupt):monthly.monthly_run(**e.options)
    assert len(e.calls)==1 and e.uploads==[]
    e.behaviors.clear()
    assert monthly.monthly_run(**e.options)['ok']
    assert len(e.calls)==2 and sorted(e.uploads)==['login-1-1','login-2-1']


def test_new_collection_checkpoint_cannot_recover_an_older_partial_workbook(env):
    e=env;e.behaviors['login-1']='partial';monthly.monthly_run(**e.options)
    e.behaviors['login-1']='interrupt_before_build'
    with pytest.raises(KeyboardInterrupt):monthly.monthly_run(**e.options,retry_failed=True)
    e.behaviors.clear()
    assert monthly.monthly_run(**e.options)['ok']
    assert len(e.calls)==4
    assert e.uploads==['login-2-1','login-1-3']  # Never publish the first, incomplete run.


def test_changed_login_does_not_reuse_unverified_old_session_data(env):
    e=env;e.behaviors['login-1']='partial';monthly.monthly_run(**e.options)
    e.shops[0]={'id':'login-new','name':'店铺一'};e.platforms['login-new']='P1'
    e.clock[0]+=timedelta(minutes=31);e.behaviors.clear()
    assert monthly.monthly_run(**e.options)['ok']
    assert e.calls[-1]['shopdesk_shop_uuid']=='login-new' and e.calls[-1]['resume'] is None
    assert e.calls[-1]['platform_shop_id']=='P1'


def test_finite_collection_attempts_and_manual_recovery(env):
    e=env;e.behaviors['login-1']='error'
    for _ in range(monthly.COLLECTION_ATTEMPTS):
        monthly.monthly_run(**e.options);e.clock[0]+=timedelta(days=2)
    jobs=batch(e)['shops'];job=next(j for j in jobs if j['shopdesk_shop_uuid']=='login-1')
    assert job['state']=='failed' and job['collection_attempts']==5
    count=len(e.calls);monthly.monthly_run(**e.options);assert len(e.calls)==count
    e.behaviors.clear();assert monthly.monthly_run(**e.options,retry_failed=True,month='2026-10')['ok']
    assert len(e.calls)==count+1


def test_schedule_install_cursor_does_not_collect_immediately_and_preserves_on_reinstall(env):
    e=env;e.clock[0]=datetime(2026,10,19,22,tzinfo=monthly.ZONE)
    settings=monthly.configure_schedule(e.options['state_dir'])
    assert settings['next_due_at']=='2026-11-01T01:00:00+08:00'
    assert monthly.monthly_run(**e.options,scheduled=True)['skipped']=='no monthly cycle due'
    assert not e.calls
    e.clock[0]=datetime(2026,11,1,1,tzinfo=monthly.ZONE)
    assert monthly.monthly_run(**e.options,scheduled=True)['ok']
    assert batch(e)['month']=='2026-10'
    assert monthly.configure_schedule(e.options['state_dir'])['next_due_at']=='2026-12-01T01:00:00+08:00'
    assert monthly.monthly_run(**e.options,scheduled=True)['skipped']=='no monthly cycle due'
    assert len(e.calls)==2


def test_missed_monthly_tick_catches_original_month_and_offline_workbench_does_not_advance_cursor(env):
    e=env;e.clock[0]=datetime(2026,10,19,22,tzinfo=monthly.ZONE);monthly.configure_schedule(e.options['state_dir'])
    e.clock[0]=datetime(2026,11,2,9,tzinfo=monthly.ZONE)
    live=e.options['bridge'].shops
    e.options['bridge'].shops=lambda:(_ for _ in ()).throw(ShopDeskError('offline'))
    with pytest.raises(ShopDeskError):monthly.monthly_run(**e.options,scheduled=True)
    assert monthly.configure_schedule(e.options['state_dir'])['next_due_at']=='2026-11-01T01:00:00+08:00'
    e.options['bridge'].shops=live
    assert monthly.monthly_run(**e.options,scheduled=True)['ok']
    assert all(c['month']=='2026-10' for c in e.calls)


def test_dry_run_has_no_state_collection_or_upload(env):
    e=env;result=monthly.monthly_run(**e.options,dry_run=True)
    assert result['month']=='2026-10' and result['login_records']==2
    assert not e.calls and not e.uploads and not e.options['state_dir'].exists()


def test_launchd_definition_calendar_absolute_paths_no_secrets_no_start_on_install(tmp_path):
    spec=scheduler.definition(tmp_path)
    assert spec['StartCalendarInterval']=={'Day':1,'Hour':1,'Minute':0}
    assert spec['StartInterval']==3600 and spec['RunAtLoad'] is False
    assert spec['EnvironmentVariables']['TZ']=='Asia/Shanghai'
    assert '--scheduled' in spec['ProgramArguments'] and '--month' not in spec['ProgramArguments']
    assert Path(spec['ProgramArguments'][0]).is_absolute()
    assert 'TOKEN' not in plistlib.dumps(spec).decode()


def test_install_registers_only_new_job_without_kickstarting(tmp_path,monkeypatch):
    root=tmp_path/'project';(root/'.venv/bin').mkdir(parents=True);(root/'.venv/bin/python').touch()
    (root/'doc').mkdir();(root/'doc/【抖音】月度账单处理模版.xlsx').write_bytes(b'template')
    monkeypatch.setattr(Path,'home',classmethod(lambda cls:tmp_path/'home'))
    monkeypatch.setattr(scheduler,'_shanghai_timezone',lambda:True)
    calls=[]
    def command(*args):
        calls.append(args)
        registered=any(c[0]=='bootstrap' for c in calls)
        return SimpleNamespace(returncode=0 if args[0]!='print' or registered else 1,stdout='state = waiting',stderr='')
    monkeypatch.setattr(scheduler,'_command',command)
    result=scheduler.install(root)
    assert result['registered'] and result['run_started'] is False
    assert result['next_due_at']==monthly.first_due().isoformat()
    assert any(c[0]=='bootstrap' for c in calls)
    assert not any(c[0] in ['kickstart','bootout'] for c in calls)
    target=Path(result['plist']);spec=plistlib.loads(target.read_bytes())
    assert spec['StartCalendarInterval']['Day']==1


def test_user_deferred_identity_check_keeps_checkpoint_and_requires_explicit_resume(env):
    e=env;e.behaviors['login-1']='partial'
    monthly.monthly_run(**e.options)
    saved=batch(e);job=next(j for j in saved['shops'] if j['shopdesk_shop_uuid']=='login-1')
    checkpoint=job['collection_manifest'];job.update(state='awaiting_verification',next_attempt_at=None)
    path=Path(e.options['state_dir'])/'2026-10'/'batch.json';monthly._save(saved,path)
    e.clock[0]+=timedelta(hours=2);e.behaviors.clear()
    assert not monthly.monthly_run(**e.options)['ok']
    assert len(e.calls)==2 and batch(e)['state']=='awaiting_input'
    assert Path(checkpoint).is_file()
    assert monthly.monthly_run(**e.options,retry_failed=True)['ok']
    assert len(e.calls)==3 and e.calls[-1]['resume']==Path(checkpoint)


def test_partial_alias_uses_full_verified_archive_from_other_authorized_login(env):
    e=env;e.platforms['login-2']='P1';e.behaviors['login-1']='partial'
    result=monthly.monthly_run(**e.options)
    assert result['ok'] and result['batches'][0]['counts']=={'duplicate':1,'uploaded':1}
    first=next(j for j in batch(e)['shops'] if j['shopdesk_shop_uuid']=='login-1')
    assert first['duplicate_of']=='login-2'
    assert e.uploads==['login-2-1'] and len(e.calls)==2
    monthly.monthly_run(**e.options)
    assert len(e.calls)==2


def test_unexpected_shop_adapter_error_is_recorded_and_other_shops_continue(env):
    e=env;real=e.options['collector']
    def broken(**options):
        if options['shopdesk_shop_uuid']=='login-1':raise TypeError('unexpected upstream null')
        return real(**options)
    result=monthly.monthly_run(**{**e.options,'collector':broken})
    assert not result['ok'] and e.uploads==['login-2-1']
    first=next(j for j in batch(e)['shops'] if j['shopdesk_shop_uuid']=='login-1')
    assert first['state']=='retry_collection' and first['last_error']['exception_type']=='TypeError'
    assert 'unexpected upstream null' in first['last_error']['message']
