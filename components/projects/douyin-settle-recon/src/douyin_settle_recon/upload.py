"""Durable, serial Mac Worker uploads following doc/mac-douyin-recon-upload.md.

curl builds and streams multipart bodies. Credentials are supplied on stdin,
never in process arguments, metadata, task files or receipts.
"""
from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import date, datetime, timezone, timedelta
from email.utils import parsedate_to_datetime
import fcntl
import gzip
import hashlib
import json
import math
import os
from pathlib import Path
import random
import re
import subprocess
import tempfile
import time
import unicodedata
from urllib.parse import urljoin, urlsplit
import uuid
import zipfile

from .model import DataError, sha256
from .identity import fetch_shop_identity, validate_identity

DEFAULT_BASE='https://erp.xiangduoer.com'
DEFAULT_QUEUE=Path('data/upload-queue')
UPLOAD_PATH='/api/douyin-recon/v1/reports'
BACKOFF=(30,120,600)
MAX_ATTEMPTS=4


def _now():return datetime.now(timezone.utc)


def _text(value,name,limit=128):
    if not isinstance(value,str) or not value.strip() or len(value)>limit or any(unicodedata.category(c)=='Cc' for c in value):
        raise DataError(f'invalid {name}')
    return value


def business_date(value):
    if not isinstance(value,str) or not re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}',value):
        raise DataError('reconciliation_date requires an explicit YYYY-MM-DD business date')
    try:date.fromisoformat(value)
    except ValueError:raise DataError('invalid reconciliation_date calendar date') from None
    return value


def _base(value):
    _text(value,'RECON_API_BASE',2048)
    u=urlsplit(value)
    if u.scheme not in ['http','https'] or not u.hostname or u.username or u.password or u.path not in ['', '/'] or u.query or u.fragment:
        raise DataError('RECON_API_BASE must be an HTTP(S) site root without /api or credentials')
    if u.scheme!='https' and u.hostname not in ['localhost','127.0.0.1','::1']:
        raise DataError('RECON_API_BASE requires HTTPS (HTTP is allowed for localhost testing)')
    return value.rstrip('/')


@dataclass(frozen=True)
class UploadConfig:
    base_url: str=DEFAULT_BASE
    account_id: str=''
    token: str=field(default='',repr=False)

    @classmethod
    def load(cls,path=None,*,require_token=True):
        invoice_path=Path.home()/'.config/invoice-mac-agent/config.json'
        invoice=json.loads(invoice_path.read_text(encoding='utf-8')) if invoice_path.is_file() else {}
        cfg=json.loads(Path(path).expanduser().read_text(encoding='utf-8')) if path else {}
        if not isinstance(invoice,dict) or not isinstance(cfg,dict):raise DataError('upload/Invoice Mac configuration must be a JSON object')
        aliases={'RECON_API_BASE':('workbenchBaseUrl','INVOICE_AGENT_WORKBENCH_BASE_URL'),
                 'INVOICE_ACCOUNT_ID':('accountId','INVOICE_AGENT_ACCOUNT_ID'),
                 'INVOICE_WORKER_TOKEN':('workerToken','INVOICE_AGENT_WORKER_TOKEN')}
        def get(key,default=''):
            local_key,invoice_env=aliases[key]
            if os.environ.get(key):return os.environ[key]
            if key in cfg:return cfg[key]
            if local_key in cfg:return cfg[local_key]
            return os.environ.get(invoice_env) or invoice.get(local_key,default)
        result=cls(_base(get('RECON_API_BASE',DEFAULT_BASE)),
                   _text(get('INVOICE_ACCOUNT_ID'),'INVOICE_ACCOUNT_ID',255),
                   get('INVOICE_WORKER_TOKEN'))
        if require_token:_text(result.token,'INVOICE_WORKER_TOKEN',8192)
        return result


def _atomic_json(path,value):
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True)
    temp=path.with_name('.'+path.name+'.'+uuid.uuid4().hex)
    try:
        with temp.open('x',encoding='utf-8') as stream:
            json.dump(value,stream,ensure_ascii=False,indent=2);stream.write('\n')
            stream.flush();os.fsync(stream.fileno())
        temp.replace(path)
    finally:temp.unlink(missing_ok=True)


@contextmanager
def _lock(path):
    path.parent.mkdir(parents=True,exist_ok=True)
    with path.open('a') as stream:
        try:fcntl.flock(stream,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:raise DataError('another uploader owns this queue/account; retry after it finishes') from None
        try:yield
        finally:fcntl.flock(stream,fcntl.LOCK_UN)


def _task_key(run_id):return hashlib.sha256(run_id.encode()).hexdigest()


def _run_file(root,name):
    if not isinstance(name,str):raise DataError('missing report/report_gzip in run manifest')
    p=(root/name).resolve()
    if not p.is_relative_to(root) or not p.is_file():raise DataError('report artifact missing or outside its run directory')
    return p


def _file_info(path,limit):
    size=path.stat().st_size
    if not 0<size<=limit:raise DataError(f'artifact outside upload size limit: {path.name}')
    return {'size_bytes':size,'sha256':sha256(path)}


def _verify_files(report,upload,metadata):
    if _file_info(report,200*1024**2)!={k:metadata['report'][k] for k in ['size_bytes','sha256']}:
        raise DataError('Excel changed since upload metadata was frozen; generate a new run')
    if _file_info(upload,100*1024**2)!={k:metadata['upload'][k] for k in ['size_bytes','sha256']}:
        raise DataError('gzip changed since upload metadata was frozen; restore the original artifact')
    digest=hashlib.sha256();size=0
    try:
        with gzip.open(upload,'rb') as stream:
            while block:=stream.read(1024*1024):
                size+=len(block)
                if size>metadata['report']['size_bytes']:raise DataError('gzip expands beyond declared Excel size')
                digest.update(block)
    except (OSError,EOFError):raise DataError('invalid or truncated report gzip') from None
    if size!=metadata['report']['size_bytes'] or digest.hexdigest()!=metadata['report']['sha256']:
        raise DataError('gzip contents do not match the original Excel')
    try:
        with zipfile.ZipFile(report) as z:
            if not {'[Content_Types].xml','_rels/.rels','xl/workbook.xml'}<=set(z.namelist()):raise DataError('invalid Excel workbook package')
    except zipfile.BadZipFile:raise DataError('invalid Excel ZIP package') from None


def _execution_date(root):
    # The user confirmed that the Beijing execution date is the business date.
    # Use the original run timestamp, never a retry date or filesystem mtime.
    for name in ['result.json','tables.json']:
        p=root/name
        if p.is_file():
            context=json.loads(p.read_text(encoding='utf-8')).get('context',{})
            if context.get('reconciliation_date'):return business_date(context['reconciliation_date'])
            if context.get('created_at'):
                at=datetime.fromisoformat(context['created_at'].replace('Z','+00:00'))
                if at.tzinfo is None:raise DataError('original execution timestamp must include its time zone')
                return at.astimezone(timezone(timedelta(hours=8))).date().isoformat()
    raise DataError('original execution date missing; provide --reconciliation-date YYYY-MM-DD')


def prepare_metadata(run_dir,*,reconciliation_date=None,shop_id=None,platform_identity=None):
    root=Path(run_dir).resolve();manifest=json.loads((root/'manifest.json').read_text(encoding='utf-8'))
    report=_run_file(root,manifest.get('report'))
    month=manifest.get('month')
    if not isinstance(month,str) or not re.fullmatch(r'(?!0000)[0-9]{4}-(0[1-9]|1[0-2])',month):raise DataError('invalid run month')
    filename=report.name
    _text(filename,'report.filename',252)  # Leave room for the mandatory .gz suffix.
    # Keep historical runs uploadable without renaming frozen artifacts.
    filename_pattern = (re.escape(month)+r'【抖音】Y-.+\.xlsx|'
                        +re.escape(month.replace('-',''))+r'【抖音】.+\.xlsx')
    if '\\' in filename or not re.fullmatch(filename_pattern,filename):
        raise DataError('report filename does not match its reconciliation month')
    shop=manifest.get('shop',{})
    # ShopDesk UUIDs change on re-login and must never become stable cloud IDs.
    identity=shop_id or shop.get('shop_id') or shop.get('platform_shop_id')
    name=shop.get('shop_name')
    if platform_identity is not None:
        validate_identity(platform_identity,shop.get('platform_shop_id'))
        identity=platform_identity['shop_id'];name=platform_identity['shop_name']
        for candidate in [shop_id,shop.get('shop_id')]:
            if candidate is not None and str(candidate)!=identity:
                raise DataError('configured shop_id differs from the current platform shop ID')
    identity=_text(identity,'shop_id (use --shop-id or a verified platform_shop_id)')
    if shop.get('platform','douyin')!='douyin':raise DataError('Douyin reports cannot be labelled as another platform')
    execution_date=business_date(reconciliation_date or manifest.get('reconciliation_date') or _execution_date(root))
    context=json.loads((root/'result.json').read_text()).get('context',{}) if (root/'result.json').is_file() else {}
    for key,expected in [('month',manifest.get('month')),('platform_shop_id',manifest.get('shop',{}).get('platform_shop_id'))]:
        if context.get(key) is not None and str(context[key])!=str(expected):raise DataError(f'run identity mismatch: {key}')
    from .report_validation import require_valid_report
    snapshot=json.loads((root/'rules.json').read_text()) if (root/'rules.json').is_file() else None
    validation=require_valid_report(report,context,snapshot,log_path=root/'upload-validation.json')
    upload=_run_file(root,manifest.get('report_gzip'))
    metadata={'platform':'douyin','shop_id':identity,'local_run_id':_text(manifest.get('run_id'),'local_run_id'),
              'reconciliation_date':execution_date,
              'reconciliation_month':month,
              'reconciliation_status':{'完全一致':'matched','存在差异':'different','待确认':'pending'}.get(manifest.get('conclusion'),'pending'),
              'report':{'filename':filename,**_file_info(report,200*1024**2)},
              'upload':{'filename':filename+'.gz','compression':'gzip',**_file_info(upload,100*1024**2)}}
    if name is not None:metadata['shop_name']=_text(name,'shop_name',255)
    if validation['partial_accounts']:metadata['reconciliation_status']='pending'
    artifacts={a['path']:a for a in manifest.get('artifacts',[])}
    for key,path in [('report',report),('upload',upload)]:
        recorded=artifacts.get(str(path.relative_to(root)))
        if not recorded or recorded.get('sha256')!=metadata[key]['sha256'] or recorded.get('size')!=metadata[key]['size_bytes']:
            raise DataError('report artifact differs from its original manifest; generate a new run')
    _verify_files(report,upload,metadata)
    return metadata,report,upload


def enqueue_run(run_dir,config,*,queue_dir=DEFAULT_QUEUE,reconciliation_date=None,shop_id=None):
    root=Path(run_dir).resolve();queue=Path(queue_dir).resolve()
    with _lock(queue/'.queue.lock'):
        cached=queue/'tasks'/_task_key(root.name)/'task.json'
        if not root.exists() and cached.is_file():
            task=json.loads(cached.read_text())
            if (task['state']=='uploaded' and task.get('cleanup',{}).get('state')=='cleaned'
                and task['account_id']==config.account_id and task['api_base']==config.base_url
                and Path(task['report_path']).parent==root):
                frozen=json.loads(Path(task['metadata_path']).read_text())
                if (reconciliation_date and reconciliation_date!=frozen['reconciliation_date']) or (shop_id and shop_id!=frozen['shop_id']):
                    raise DataError('upload metadata is immutable even after local cleanup')
                return task
        manifest=json.loads((root/'manifest.json').read_text(encoding='utf-8'))
        directory=queue/'tasks'/_task_key(_text(manifest.get('run_id'),'local_run_id'))
        task_path=directory/'task.json';metadata_path=directory/'metadata.json'
        previous=json.loads(task_path.read_text()) if task_path.exists() else None
        if previous and (previous['account_id']!=config.account_id or previous['api_base']!=config.base_url):
            raise DataError('this run is already bound to a different upload account/site')
        frozen=json.loads(metadata_path.read_text()) if metadata_path.exists() else None
        if previous and previous['metadata_sha256']!=sha256(metadata_path):raise DataError('frozen upload metadata was modified')
        platform_identity=None
        if frozen is None:
            source_shop=manifest.get('shop',{})
            platform_identity=fetch_shop_identity(source_shop.get('shopdesk_shop_uuid'),source_shop.get('platform_shop_id'))
            validate_identity(platform_identity,source_shop.get('platform_shop_id'))
        metadata,report,upload=prepare_metadata(root,reconciliation_date=reconciliation_date or (frozen or {}).get('reconciliation_date'),
                                              shop_id=shop_id,platform_identity=platform_identity)
        if frozen is not None:
            # A rename after enqueue must not change the idempotent request.
            # New runs refresh the official identity; retries keep their snapshot.
            if 'platform' not in frozen:metadata.pop('platform',None)
            if 'shop_name' in frozen:metadata['shop_name']=frozen['shop_name']
            else:metadata.pop('shop_name',None)
        if frozen is not None and frozen!=metadata:raise DataError('upload metadata is immutable for a run; restore original fields or generate a new run')
        if frozen is None:_atomic_json(metadata_path,metadata)
        if platform_identity is not None:_atomic_json(directory/'shop-identity.json',platform_identity)
        if previous:
            if previous['report_path']!=str(report) or previous['gzip_path']!=str(upload):
                raise DataError('queued artifact location changed; reuse the original run directory')
            return previous
        task={'schema_version':'1.0','local_run_id':metadata['local_run_id'],'account_id':config.account_id,
              'partial_accounts':json.loads((root/'upload-validation.json').read_text())['partial_accounts'],
              'api_base':config.base_url,'report_path':str(report),'gzip_path':str(upload),
              'metadata_path':str(metadata_path),'state':'pending','attempts':0,'cycle_attempts':0,
              'metadata_sha256':sha256(metadata_path),
              'created_at':_now().isoformat(),'updated_at':_now().isoformat(),'next_attempt_at':None}
        _atomic_json(task_path,task)
        return task


@dataclass
class Response:
    status: int
    body: bytes
    retry_after: str|None=None
    network_error: bool=False


def _curl_quote(value):
    return '"'+str(value).replace('\\','\\\\').replace('"','\\"').replace('\r','\\r').replace('\n','\\n')+'"'


def _form_file(path,*,filename=None,content_type):
    # curl's form parser has its own quoting, independent of the shell/config.
    quote=lambda s:'"'+str(s).replace('\\','\\\\').replace('"','\\"')+'"'
    return '@'+quote(path)+((';filename='+quote(filename)) if filename else '')+';type='+content_type


def post_report(config,metadata_path,gzip_path):
    _base(config.base_url);_text(config.account_id,'INVOICE_ACCOUNT_ID',255);_text(config.token,'INVOICE_WORKER_TOKEN',8192)
    metadata=json.loads(Path(metadata_path).read_text(encoding='utf-8'))
    with tempfile.TemporaryDirectory(prefix='recon-upload-') as directory:
        body=Path(directory)/'response';headers=Path(directory)/'headers'
        args=['curl','--disable','--silent','--show-error','--connect-timeout','10','--max-time','360',
              '--proto','=http,https','--max-filesize','1048576','--request','POST',
              '--url',config.base_url+UPLOAD_PATH,'--config','-',
              '--form','metadata='+_form_file(Path(metadata_path).resolve(),content_type='application/json'),
              '--form','file='+_form_file(Path(gzip_path).resolve(),filename=metadata['upload']['filename'],content_type='application/gzip'),
              '--output',str(body),'--dump-header',str(headers),'--write-out','%{http_code}']
        secret='\n'.join('header = '+_curl_quote(k+': '+v) for k,v in [
            ('X-Invoice-Account-Id',config.account_id),('X-Invoice-Worker-Token',config.token)])+'\n'
        try:
            process=subprocess.run(args,input=secret.encode(),capture_output=True,timeout=365)
        except subprocess.TimeoutExpired:return Response(0,b'',network_error=True)
        except FileNotFoundError:raise DataError('curl is required to stream report uploads') from None
        # Never persist stderr or untrusted response text: gateways may reflect credentials.
        status=int(process.stdout) if process.stdout.strip().isdigit() else 0
        retry_after=None
        if headers.exists():
            for line in headers.read_text(encoding='latin1').splitlines():
                if line.lower().startswith('retry-after:'):retry_after=line.split(':',1)[1].strip()
        return Response(status,body.read_bytes() if body.exists() else b'',retry_after,process.returncode!=0)


def _receipt(response,metadata,config):
    if response.network_error or response.status not in [200,201]:return None
    try:
        result=json.loads(response.body);data=result['data']
        if (result['code']!='OK' or data['stored'] is not True
            or not isinstance(data['report_id'],str) or not data['report_id'].strip()
            or data['local_run_id']!=metadata['local_run_id'] or data['excel_sha256']!=metadata['report']['sha256']
            or not isinstance(data.get('duplicate'),bool)):return None
        download=_text(data['download_url'],'download_url',4096)
        u=urlsplit(download)
        if not (u.scheme in ['http','https'] and u.netloc or download.startswith('/') and not download.startswith('//')):return None
        return {'account_id':config.account_id,'api_base':config.base_url,'local_run_id':data['local_run_id'],
                'report_id':_text(data['report_id'],'report_id',255),'stored':True,'duplicate':data['duplicate'],
                'excel_sha256':data['excel_sha256'],'download_url':urljoin(config.base_url+'/',download),
                'http_status':response.status,'received_at':_now().isoformat()}
    except (ValueError,TypeError,KeyError):return None


def _retry_delay(response,attempt):
    if response.retry_after:
        try:
            seconds=float(response.retry_after)
            if math.isfinite(seconds):return max(0,seconds)
        except ValueError:
            try:return max(0,(parsedate_to_datetime(response.retry_after)-_now()).total_seconds())
            except (ValueError,TypeError,OverflowError):pass
    return BACKOFF[min(attempt-1,len(BACKOFF)-1)]+random.uniform(0,3)


def _error(response,token=''):
    code='UNCONFIRMED_RECEIPT' if response.status in [200,201] else 'NETWORK_ERROR' if response.network_error else f'HTTP_{response.status}'
    try:
        candidate=json.loads(response.body).get('code')
        if isinstance(candidate,str) and re.fullmatch('[A-Z][A-Z_0-9]{0,79}',candidate) and response.status not in [200,201] and not (token and token in candidate):code=candidate
    except (ValueError,AttributeError):pass
    return {'http_status':response.status,'code':code}


def queue_status(queue_dir=DEFAULT_QUEUE):
    result=[]
    for path in sorted((Path(queue_dir)/'tasks').glob('*/task.json')):
        task=json.loads(path.read_text());result.append({**task,'task_path':str(path.resolve())})
    return result


def drain_queue(config,*,queue_dir=DEFAULT_QUEUE,run_ids=None,retry_failed=False,watch=False,transport=post_report):
    queue=Path(queue_dir).resolve()
    key=_task_key(config.base_url+'\n'+config.account_id)
    cache=Path(os.environ.get('XDG_CACHE_HOME',Path.home()/'.cache'))/'douyin-settle-recon/upload-locks'
    def owned(task):
        return task['account_id']==config.account_id and task['api_base']==config.base_url and (run_ids is None or task['local_run_id'] in run_ids)
    with _lock(queue/'.queue.lock'),_lock(cache/(key+'.lock')):
        if retry_failed:
            for task in queue_status(queue):
                if owned(task) and task['state']=='failed':
                    path=Path(task.pop('task_path'));task.update(state='pending',cycle_attempts=0,next_attempt_at=None)
                    _atomic_json(path,task)
        while True:
            waiting=[]
            for task in sorted(queue_status(queue),key=lambda t:t['created_at']):
                if not owned(task) or task['state'] in ['uploaded','failed']:continue
                at=datetime.fromisoformat(task['next_attempt_at']) if task.get('next_attempt_at') else _now()
                if at>_now():waiting.append(at);continue
                path=Path(task.pop('task_path'));metadata_path=Path(task['metadata_path'])
                if task['cycle_attempts']>=MAX_ATTEMPTS:
                    task.update(state='failed',last_error={'code':'ATTEMPTS_EXHAUSTED','retryable':True})
                    _atomic_json(path,task);continue
                # Persist the in-flight attempt before sending. A crash leaves
                # a retryable original task, never a fabricated success.
                task.update(state='uploading',attempts=task['attempts']+1,cycle_attempts=task['cycle_attempts']+1,
                            updated_at=_now().isoformat(),next_attempt_at=None)
                _atomic_json(path,task)
                try:
                    metadata=json.loads(metadata_path.read_text(encoding='utf-8'))
                    if sha256(metadata_path)!=task['metadata_sha256']:raise DataError('queued metadata changed')
                    if metadata['local_run_id']!=task['local_run_id']:raise DataError('queued run identity changed')
                    _verify_files(Path(task['report_path']),Path(task['gzip_path']),metadata)
                    response=transport(config,metadata_path,Path(task['gzip_path']))
                    receipt=_receipt(response,metadata,config)
                    if receipt:
                        _atomic_json(path.with_name('receipt.json'),receipt)
                        task.update(state='uploaded',receipt_path=str(path.with_name('receipt.json')),last_error=None)
                    else:
                        retryable=200<=response.status<300 or response.status in [0,429,500,502,503,504]
                        task.update(state='retry_wait' if retryable and task['cycle_attempts']<MAX_ATTEMPTS else 'failed',
                                    last_error={**_error(response,config.token),'retryable':retryable})
                        if task['state']=='retry_wait':
                            at=_now()+timedelta(seconds=_retry_delay(response,task['cycle_attempts']))
                            task['next_attempt_at']=at.isoformat();waiting.append(at)
                except (DataError,OSError,ValueError,KeyError):
                    task.update(state='failed',last_error={'code':'LOCAL_VALIDATION_FAILED','retryable':False})
                task['updated_at']=_now().isoformat();_atomic_json(path,task)
            if not watch or not waiting:break
            # Short sleeps keep Ctrl-C responsive; a new invocation reuses due times.
            time.sleep(min(1,max(0,(min(waiting)-_now()).total_seconds())))
        tasks=[t for t in queue_status(queue) if owned(t)]
        return {'ok':all(t['state']=='uploaded' for t in tasks),'queue_dir':str(queue),'tasks':tasks}
