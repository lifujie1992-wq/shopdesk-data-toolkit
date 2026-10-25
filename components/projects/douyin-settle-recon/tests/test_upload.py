from recon_samples import empty_collection
import gzip
import hashlib
import json
from contextlib import contextmanager
from datetime import datetime, timezone, timedelta
from email.parser import BytesParser
from email.policy import default
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading

import pytest
import xlsxwriter

from douyin_settle_recon import upload
from douyin_settle_recon.cli import main
from douyin_settle_recon.model import DataError, sha256
from douyin_settle_recon.pipeline import build
from test_local_pipeline import TEMPLATE


@pytest.fixture(autouse=True)
def isolate_credentials_and_locks(tmp_path,monkeypatch):
    for key in ['RECON_API_BASE','INVOICE_ACCOUNT_ID','INVOICE_WORKER_TOKEN','INVOICE_AGENT_WORKBENCH_BASE_URL','INVOICE_AGENT_ACCOUNT_ID','INVOICE_AGENT_WORKER_TOKEN']:
        monkeypatch.delenv(key,raising=False)
    monkeypatch.setattr(Path,'home',classmethod(lambda cls:tmp_path/'home'))
    monkeypatch.setenv('XDG_CACHE_HOME',str(tmp_path/'cache'))
    monkeypatch.setattr(upload,'fetch_shop_identity',fake_identity)


def fake_identity(uuid,expected_id=None):
    assert uuid=='volatile-login-id'
    return {'platform':'douyin','shop_id':'87755028','shop_name':'测试中文店铺',
            'source':'official_platform_bootstrap','observed_at':'2026-10-23T00:00:00+00:00'}


def make_run(directory,run_id='run-1',conclusion='待确认',filename='202609【抖音】测试中文店铺.xlsx'):
    root=directory/run_id;root.mkdir(parents=True)
    report=root/filename
    wb=xlsxwriter.Workbook(report);wb.add_worksheet('管家账户').write_formula('J7','=SUM(J11:J14)',None,19.48)
    from douyin_settle_recon.qianchuan import COLUMNS,TOTAL_FORMULAS
    wb.add_worksheet('结算账单').write_row(0,0,['结算时间','订单号','子订单号','结算金额'])
    q=wb.add_worksheet('千川账户');q.write_row(0,0,COLUMNS);q.write_row(1,0,['总计']+[0]*10+['-']*3)
    summary=wb.add_worksheet('核对汇总');summary.write_row(0,0,['店铺编码','资金账户','费用类型','金额'])
    for rn,category in [(44,'非赠款消耗'),(45,'巨量千川充值')]:
        summary.write_row(rn-1,1,['千川账户',category]);summary.write_array_formula(f'D{rn}',TOTAL_FORMULAS[f'D{rn}'],None,0)
    summary.write('L6','千川账户');summary.write_formula('N6','=SUMIF(B:D,L6,D:D)',None,0)
    for coord in ['H2','H3','H4']:summary.write_formula(coord,'=0',None,0)
    wb.close()
    # A cache alias must not become the transmitted filename.
    zipped=root/'cached-report.gz'
    with zipped.open('wb') as stream:
        with gzip.GzipFile(filename='',mode='wb',fileobj=stream,mtime=0) as f:f.write(report.read_bytes())
    (root/'manifest.json').write_text(json.dumps({'run_id':run_id,'month':'2026-09','conclusion':conclusion,
        'shop':{'platform_shop_id':'87755028','shop_name':'测试中文店铺','shopdesk_shop_uuid':'volatile-login-id'},
        'report':report.name,'report_gzip':zipped.name,
        'artifacts':[{'path':p.name,'size':p.stat().st_size,'sha256':sha256(p)} for p in [report,zipped]]},ensure_ascii=False))
    (root/'result.json').write_text(json.dumps({'context':{'created_at':'2026-10-18T18:20:00+00:00','qianchuan_result':{'status':'success_empty'}}}))
    return root


def config(base='http://127.0.0.1:1'):
    return upload.UploadConfig(base,'account-1','worker-secret-do-not-log')


def receipt(metadata,status=201,duplicate=False):
    return upload.Response(status,json.dumps({'code':'OK','data':{'stored':True,'duplicate':duplicate,'report_id':'rpt-1',
        'local_run_id':metadata['local_run_id'],'excel_sha256':metadata['report']['sha256'],
        'download_url':'/recon/files/random-file-key'}}).encode())


@contextmanager
def server(*,drop_first=False,query_status=200,head_size_delta=0,corrupt_download=False,query_platform=None):
    requests=[];stored={};excel_store={}
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args):pass
        def do_POST(self):
            body=self.rfile.read(int(self.headers['Content-Length']))
            message=BytesParser(policy=default).parsebytes(('Content-Type: '+self.headers['Content-Type']+'\r\n\r\n').encode()+body)
            parts=list(message.iter_parts())
            data=json.loads(next(p.get_payload(decode=True) for p in parts if p.get_param('name',header='content-disposition')=='metadata'))
            file=next(p for p in parts if p.get_param('name',header='content-disposition')=='file')
            requests.append({'path':self.path,'headers':self.headers,'parts':parts,'metadata':data,'file':file})
            duplicate=data['local_run_id'] in stored;stored[data['local_run_id']]=data
            excel_store[data['local_run_id']]=gzip.decompress(file.get_payload(decode=True))
            if drop_first and len(requests)==1:
                self.close_connection=True
                return
            response=receipt(data,200 if duplicate else 201,duplicate)
            self.send_response(response.status);self.send_header('Content-Type','application/json')
            self.send_header('Content-Length',str(len(response.body)));self.end_headers();self.wfile.write(response.body)
        def do_HEAD(self):
            excel=next(reversed(excel_store.values()))
            self.send_response(200);self.send_header('Content-Length',str(len(excel)+head_size_delta));self.end_headers()
        def do_GET(self):
            data=next(reversed(stored.values()))
            if self.path.startswith('/api/douyin-recon/v1/reports/'):
                response=json.loads(receipt(data,200,False).body);response['data']['metadata']=dict(data)
                if query_platform is not None:response['data']['metadata']['platform']=query_platform
                body=json.dumps(response).encode();status=query_status
            else:
                body=next(reversed(excel_store.values()))
                if corrupt_download:body=body[:-1]+bytes([body[-1]^1])
                status=200
            self.send_response(status);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
    httpd=ThreadingHTTPServer(('127.0.0.1',0),Handler)
    thread=threading.Thread(target=httpd.serve_forever,daemon=True);thread.start()
    try:yield f'http://127.0.0.1:{httpd.server_port}',requests
    finally:httpd.shutdown();httpd.server_close();thread.join()


def read_task(queue):return upload.queue_status(queue)[0]


@pytest.mark.parametrize('filename',['202609【抖音】测试中文店铺.xlsx','2026-09【抖音】Y-测试中文店铺.xlsx','202609【抖音】Y-测试中文店铺.xlsx'])
def test_real_curl_multipart_unicode_filename_headers_receipt_and_duplicate(tmp_path,monkeypatch,filename):
    root=make_run(tmp_path,filename=filename);queue=tmp_path/'queue'
    with server() as (base,requests):
        cfg=config(base)
        original=upload.subprocess.run
        calls=[]
        def inspect(args,**kwargs):
            calls.append(args)
            assert cfg.token not in ' '.join(args)
            assert cfg.token.encode() in kwargs['input']
            return original(args,**kwargs)
        monkeypatch.setattr(upload.subprocess,'run',inspect)
        task=upload.enqueue_run(root,cfg,queue_dir=queue)
        result=upload.drain_queue(cfg,queue_dir=queue)
        assert result['ok'] and result['tasks'][0]['state']=='uploaded'
        request=requests[0];metadata=request['metadata'];file=request['file']
        assert request['path']=='/api/douyin-recon/v1/reports'
        assert len(request['parts'])==2
        assert request['headers']['X-Invoice-Account-Id']==cfg.account_id
        assert request['headers']['X-Invoice-Worker-Token']==cfg.token
        assert request['headers']['Authorization'] is None and request['headers']['Content-Encoding'] is None
        assert file.get_content_type()=='application/gzip'
        assert file.get_filename()==metadata['upload']['filename']==filename+'.gz'
        assert metadata['report']['filename']==filename
        assert metadata['shop_name']=='测试中文店铺'
        assert hashlib.sha256(file.get_payload(decode=True)).hexdigest()==metadata['upload']['sha256']
        assert hashlib.sha256(gzip.decompress(file.get_payload(decode=True))).hexdigest()==metadata['report']['sha256']
        assert metadata['reconciliation_date']=='2026-10-19' and metadata['reconciliation_month']=='2026-09'
        assert metadata['shop_id']=='87755028' and metadata['reconciliation_status']=='pending'
        assert metadata['platform']=='douyin'
        saved=json.loads(Path(result['tasks'][0]['receipt_path']).read_text())
        assert saved['download_url']==base+'/recon/files/random-file-key'
        assert saved['stored'] is True and saved['duplicate'] is False
        # Existing success is retained without re-uploading on a routine queue drain.
        assert upload.drain_queue(cfg,queue_dir=queue)['ok'] and len(calls)==1
        duplicate=upload.post_report(cfg,Path(task['metadata_path']),Path(task['gzip_path']))
        assert duplicate.status==200
        assert upload._receipt(duplicate,metadata,cfg)['duplicate'] is True
        assert requests[1]['metadata']==metadata
    for path in queue.rglob('*'):
        if path.is_file():assert cfg.token.encode() not in path.read_bytes()


def test_metadata_matches_supplied_openapi(tmp_path):
    metadata,_,_=upload.prepare_metadata(make_run(tmp_path))
    spec=json.loads((Path(__file__).parents[1]/'doc/mac-douyin-recon-upload.openapi.json').read_text())
    schemas=spec['components']['schemas']
    for value,name in [(metadata,'UploadMetadata'),(metadata['report'],'ReportFile'),(metadata['upload'],'UploadFile')]:
        schema=schemas[name]
        assert set(schema['required'])<=set(value)<=set(schema['properties'])
        for key,val in value.items():
            rule=schema['properties'][key]
            if rule.get('type')=='string':assert isinstance(val,str)
            if rule.get('type')=='integer':assert type(val) is int and val>=rule['minimum']
            if 'enum' in rule:assert val in rule['enum']
    assert metadata['upload']['filename']==metadata['report']['filename']+'.gz'


@pytest.mark.parametrize('conclusion,expected',[('完全一致','matched'),('存在差异','different'),('待确认','pending')])
def test_conclusion_is_not_confused_with_storage_success(tmp_path,conclusion,expected):
    metadata,_,_=upload.prepare_metadata(make_run(tmp_path,conclusion=conclusion))
    assert metadata['reconciliation_status']==expected


def test_new_build_records_beijing_execution_date(tmp_path):
    result=build([],month='2026-09',shop_name='测试店',platform_shop_id='87755028',output=tmp_path/'runs',template=TEMPLATE,collection_context={'collection':empty_collection()})
    root=Path(result['run_dir']);manifest=json.loads((root/'manifest.json').read_text());context=json.loads((root/'result.json').read_text())['context']
    expected=datetime.fromisoformat(context['created_at']).astimezone(timezone(timedelta(hours=8))).date().isoformat()
    assert manifest['reconciliation_date']==expected
    assert upload.prepare_metadata(root)[0]['reconciliation_date']==expected


def test_frozen_run_metadata_and_account_cannot_change(tmp_path):
    root=make_run(tmp_path);queue=tmp_path/'queue';cfg=config()
    task=upload.enqueue_run(root,cfg,queue_dir=queue)
    frozen=Path(task['metadata_path']).read_bytes()
    assert upload.enqueue_run(root,cfg,queue_dir=queue)==task
    assert Path(task['metadata_path']).read_bytes()==frozen
    for kwargs in [{'reconciliation_date':'2026-10-20'},{'shop_id':'different-shop'}]:
        with pytest.raises(DataError,match='immutable'):upload.enqueue_run(root,cfg,queue_dir=queue,**kwargs)
    with pytest.raises(DataError,match='different upload account'):
        upload.enqueue_run(root,upload.UploadConfig(cfg.base_url,'account-2','new-token'),queue_dir=queue)
    assert 'worker-secret' not in repr(cfg)


@pytest.mark.parametrize('change',['excel','gzip','metadata'])
def test_local_corruption_never_sends_or_marks_success(tmp_path,change):
    root=make_run(tmp_path);queue=tmp_path/'queue';cfg=config()
    task=upload.enqueue_run(root,cfg,queue_dir=queue)
    path=Path(task[{'excel':'report_path','gzip':'gzip_path','metadata':'metadata_path'}[change]])
    if change=='metadata':
        data=json.loads(path.read_text());data['reconciliation_date']='2026-10-20';path.write_text(json.dumps(data))
    else:path.write_bytes(path.read_bytes()+b'corrupted')
    def never(*args):raise AssertionError('corrupt inputs must not be sent')
    result=upload.drain_queue(cfg,queue_dir=queue,transport=never)
    assert not result['ok'] and result['tasks'][0]['state']=='failed'
    assert result['tasks'][0]['last_error']['code']=='LOCAL_VALIDATION_FAILED'
    assert not Path(task['metadata_path']).with_name('receipt.json').exists()


def test_gzip_containing_other_excel_is_rejected_even_with_valid_manifest_hashes(tmp_path):
    root=make_run(tmp_path);manifest=json.loads((root/'manifest.json').read_text())
    zipped=root/manifest['report_gzip'];zipped.write_bytes(gzip.compress(b'not this workbook'))
    for artifact in manifest['artifacts']:
        if artifact['path']==zipped.name:artifact.update(size=zipped.stat().st_size,sha256=sha256(zipped))
    (root/'manifest.json').write_text(json.dumps(manifest))
    with pytest.raises(DataError,match='gzip contents'):upload.prepare_metadata(root)


@pytest.mark.parametrize('status',[400,401,404,405,409,413,415,422])
def test_permanent_http_errors_do_not_auto_retry_and_do_not_log_token(tmp_path,status):
    queue=tmp_path/'queue';cfg=config();upload.enqueue_run(make_run(tmp_path),cfg,queue_dir=queue)
    def fail(*args):return upload.Response(status,json.dumps({'code':'UNAUTHORIZED','message':cfg.token}).encode())
    result=upload.drain_queue(cfg,queue_dir=queue,transport=fail)
    assert not result['ok'];task=result['tasks'][0]
    assert task['attempts']==1 and task['state']=='failed' and task['next_attempt_at'] is None
    assert cfg.token not in json.dumps(task)
    assert not upload.drain_queue(cfg,queue_dir=queue,transport=lambda *a:pytest.fail('no auto retry'))['ok']
    # Token rotation on the same account is allowed; the original metadata survives.
    new_cfg=upload.UploadConfig(cfg.base_url,cfg.account_id,'rotated-worker-token')
    def success(config,metadata,*args):return receipt(json.loads(metadata.read_text()),200,True)
    assert upload.drain_queue(new_cfg,queue_dir=queue,retry_failed=True,transport=success)['ok']


def test_retry_after_and_bounded_backoff_are_durable(tmp_path,monkeypatch):
    queue=tmp_path/'queue';cfg=config();task=upload.enqueue_run(make_run(tmp_path),cfg,queue_dir=queue)
    frozen=Path(task['metadata_path']).read_bytes()
    now=[datetime(2026,10,19,0,0,tzinfo=timezone.utc)]
    monkeypatch.setattr(upload,'_now',lambda:now[0]);monkeypatch.setattr(upload.random,'uniform',lambda *a:0)
    responses=[upload.Response(429,b'{}','45'),upload.Response(502,b'<html>gateway</html>'),upload.Response(503,b'{}'),upload.Response(500,b'{}')]
    calls=[]
    def fail(*args):calls.append(1);return responses.pop(0)
    for attempt,delay in [(1,45),(2,120),(3,600),(4,None)]:
        result=upload.drain_queue(cfg,queue_dir=queue,transport=fail);t=result['tasks'][0]
        assert t['attempts']==attempt and Path(task['metadata_path']).read_bytes()==frozen
        if delay:
            due=datetime.fromisoformat(t['next_attempt_at']);assert (due-now[0]).total_seconds()==delay
            upload.drain_queue(cfg,queue_dir=queue,transport=lambda *a:pytest.fail('too early'))
            now[0]=due
        else:assert t['state']=='failed'
    assert len(calls)==4


@pytest.mark.parametrize('change',['stored','run','hash','empty-id','duplicate','download','json'])
def test_success_http_with_unconfirmed_receipt_remains_retryable(tmp_path,change):
    queue=tmp_path/'queue';cfg=config();upload.enqueue_run(make_run(tmp_path),cfg,queue_dir=queue)
    def invalid(config,metadata,*args):
        response=receipt(json.loads(metadata.read_text()));data=json.loads(response.body)
        if change=='stored':data['data']['stored']=1
        elif change=='run':data['data']['local_run_id']='other-run'
        elif change=='hash':data['data']['excel_sha256']='0'*64
        elif change=='empty-id':data['data']['report_id']=''
        elif change=='duplicate':data['data']['duplicate']='false'
        elif change=='download':data['data']['download_url']='javascript:alert(1)'
        response.body=b'not json' if change=='json' else json.dumps(data).encode()
        return response
    result=upload.drain_queue(cfg,queue_dir=queue,transport=invalid)
    assert result['tasks'][0]['state']=='retry_wait'
    assert result['tasks'][0]['last_error']['code']=='UNCONFIRMED_RECEIPT'


def test_lost_response_reposts_same_run_and_receives_duplicate(tmp_path,monkeypatch):
    queue=tmp_path/'queue';root=make_run(tmp_path)
    with server(drop_first=True) as (base,requests):
        cfg=config(base);upload.enqueue_run(root,cfg,queue_dir=queue)
        first=upload.drain_queue(cfg,queue_dir=queue)
        assert first['tasks'][0]['state']=='retry_wait'
        due=datetime.fromisoformat(first['tasks'][0]['next_attempt_at'])
        monkeypatch.setattr(upload,'_now',lambda:due+timedelta(seconds=1))
        second=upload.drain_queue(cfg,queue_dir=queue)
        assert second['ok']
        saved=json.loads(Path(second['tasks'][0]['receipt_path']).read_text())
        assert saved['duplicate'] is True and saved['http_status']==200
        assert len(requests)==2 and requests[0]['metadata']==requests[1]['metadata']


def test_queue_runs_serially_keeps_other_success_and_recovers_interrupted_task(tmp_path):
    cfg=config();queue=tmp_path/'queue'
    upload.enqueue_run(make_run(tmp_path,'one'),cfg,queue_dir=queue)
    second=upload.enqueue_run(make_run(tmp_path,'two'),cfg,queue_dir=queue)
    state=Path(second['metadata_path']).with_name('task.json');t=json.loads(state.read_text());t.update(state='uploading',attempts=1,cycle_attempts=1);state.write_text(json.dumps(t))
    seen=[]
    def send(config,metadata,*args):
        data=json.loads(metadata.read_text());seen.append(data['local_run_id'])
        return upload.Response(409,b'{}') if data['local_run_id']=='one' else receipt(data,200,True)
    result=upload.drain_queue(cfg,queue_dir=queue,transport=send)
    assert seen==['one','two']
    assert {t['local_run_id']:t['state'] for t in result['tasks']}=={'one':'failed','two':'uploaded'}
    assert next(t for t in result['tasks'] if t['local_run_id']=='two')['attempts']==2


def test_same_account_lock_prevents_parallel_sender_even_with_different_queue(tmp_path):
    cfg=config();queue=tmp_path/'queue';upload.enqueue_run(make_run(tmp_path),cfg,queue_dir=queue)
    key=upload._task_key(cfg.base_url+'\n'+cfg.account_id)
    lock=Path(upload.os.environ['XDG_CACHE_HOME'])/'douyin-settle-recon/upload-locks'/(key+'.lock')
    with upload._lock(lock):
        with pytest.raises(DataError,match='another uploader'):
            upload.drain_queue(cfg,queue_dir=queue,transport=lambda *a:pytest.fail('parallel upload'))


def test_cli_dry_run_has_no_credentials_network_or_queue(tmp_path,capsys):
    root=make_run(tmp_path);queue=tmp_path/'queue'
    assert main(['upload','--run',str(root),'--dry-run','--queue-dir',str(queue)])==0
    result=json.loads(capsys.readouterr().out)
    assert result['dry_run'] is True
    assert result['reports'][0]['reconciliation_date']=='2026-10-19'
    assert not queue.exists()


def test_cli_prepare_only_freezes_without_token_then_uploads(tmp_path,monkeypatch,capsys):
    root=make_run(tmp_path);queue=tmp_path/'queue'
    with server() as (base,requests):
        monkeypatch.setenv('RECON_API_BASE',base);monkeypatch.setenv('INVOICE_ACCOUNT_ID','account-1')
        assert main(['upload','--run',str(root),'--queue-dir',str(queue),'--prepare-only'])==0
        capsys.readouterr();assert not requests
        monkeypatch.setenv('INVOICE_WORKER_TOKEN','test-token')
        assert main(['upload-queue','--queue-dir',str(queue)])==0
        assert json.loads(capsys.readouterr().out)['ok']
        assert main(['upload-status','--queue-dir',str(queue)])==0
        assert json.loads(capsys.readouterr().out)['tasks'][0]['state']=='uploaded'


def test_unstable_shopdesk_uuid_and_unknown_date_are_not_silently_used(tmp_path):
    root=make_run(tmp_path);p=root/'manifest.json';m=json.loads(p.read_text());m['shop'].pop('platform_shop_id');p.write_text(json.dumps(m))
    with pytest.raises(DataError,match='shop_id'):upload.prepare_metadata(root)
    (root/'result.json').write_text(json.dumps({'context':{'qianchuan_result':{'status':'success_empty'}}}))
    with pytest.raises(DataError,match='execution date'):upload.prepare_metadata(root,shop_id='stable-shop')
    assert upload.prepare_metadata(root,shop_id='stable-shop',reconciliation_date='2026-10-19')[0]['shop_id']=='stable-shop'


def test_private_config_environment_overrides_and_invalid_base(tmp_path,monkeypatch):
    p=tmp_path/'private.json';p.write_text(json.dumps({'INVOICE_ACCOUNT_ID':'from-file','INVOICE_WORKER_TOKEN':'hidden'}))
    monkeypatch.setenv('INVOICE_ACCOUNT_ID','from-env')
    c=upload.UploadConfig.load(p);assert c.account_id=='from-env' and c.token=='hidden'
    for base in ['https://erp.example.com/api','https://user:password@erp.example.com','https://erp.example.com/?token=x','http://remote.example.com']:
        monkeypatch.setenv('RECON_API_BASE',base)
        with pytest.raises(DataError):upload.UploadConfig.load(p)


def test_cli_generated_report_can_be_uploaded_without_separate_export(tmp_path,monkeypatch,capsys):
    source=tmp_path/'input.json';source.write_text(json.dumps({'collection':empty_collection()}))
    with server() as (base,requests):
        for key,value in [('RECON_API_BASE',base),('INVOICE_ACCOUNT_ID','account-1'),('INVOICE_WORKER_TOKEN','test-token')]:monkeypatch.setenv(key,value)
        assert main(['import','--manifest',str(source),'--shop-name','测试店','--shop','volatile-login-id','--platform-shop-id','87755028',
                     '--month','2026-09','--output',str(tmp_path/'runs'),'--upload','--queue-dir',str(tmp_path/'queue'),
                     '--template',str(TEMPLATE)])==0
        result=json.loads(capsys.readouterr().out)
        assert not Path(result['report']).exists() and result['cloud_upload']['ok']
        assert result['cloud_upload']['retention'][0]['state']=='cleaned'
        assert requests[0]['metadata']['reconciliation_month']=='2026-09'
        assert requests[0]['metadata']['local_run_id']==result['run_id']


def test_missing_credentials_stop_automatic_upload_before_collection(tmp_path,capsys):
    output=tmp_path/'should-not-exist'
    assert main(['collect','--shop','irrelevant','--upload','--output',str(output)])==2
    assert 'INVOICE_ACCOUNT_ID' in capsys.readouterr().err
    assert not output.exists()


def test_reuses_invoice_mac_config_without_copying_or_modifying_credentials(tmp_path,monkeypatch):
    path=Path.home()/'.config/invoice-mac-agent/config.json';path.parent.mkdir(parents=True)
    original=json.dumps({'workbenchBaseUrl':'https://erp.xiangduoer.com','accountId':'invoice-account',
                         'workerToken':'private-invoice-token','submitMode':'auto'})
    path.write_text(original)
    cfg=upload.UploadConfig.load()
    assert cfg.base_url=='https://erp.xiangduoer.com'
    assert cfg.account_id=='invoice-account' and cfg.token=='private-invoice-token'
    assert path.read_text()==original
    # Invoice-client environment settings override its config, just as in that client.
    monkeypatch.setenv('INVOICE_AGENT_WORKER_TOKEN','rotated-invoice-token')
    assert upload.UploadConfig.load().token=='rotated-invoice-token'
    custom=tmp_path/'upload.json';custom.write_text(json.dumps({'INVOICE_WORKER_TOKEN':'explicit-upload-token'}))
    assert upload.UploadConfig.load(custom).token=='explicit-upload-token'
    monkeypatch.setenv('INVOICE_WORKER_TOKEN','upload-env-token')
    assert upload.UploadConfig.load(custom).token=='upload-env-token'
    monkeypatch.delenv('INVOICE_WORKER_TOKEN');monkeypatch.delenv('INVOICE_AGENT_WORKER_TOKEN')
    assert upload.UploadConfig.load(path)==cfg
