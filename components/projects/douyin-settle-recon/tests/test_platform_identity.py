import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from douyin_settle_recon import identity, upload
from douyin_settle_recon.model import DataError, sha256
from test_upload import make_run, config, server


def official(name='平台新店名',shop_id='87755028'):
    return {'platform':'douyin','shop_id':shop_id,'shop_name':name,
            'source':'official_platform_bootstrap','observed_at':'2026-10-23T00:00:00+00:00'}


@pytest.fixture(autouse=True)
def locks(tmp_path,monkeypatch):monkeypatch.setenv('XDG_CACHE_HOME',str(tmp_path/'cache'))


@pytest.mark.parametrize('change',[{'platform':'taobao'},{'shop_id':''},{'shop_id':'REPLACE_WITH_CLOUD_SHOP_ID'},
                                  {'shop_id':87755028},{'shop_name':''},{'shop_name':'店\n铺'}])
def test_invalid_or_wrong_platform_identity_is_rejected(change):
    with pytest.raises(DataError):identity.validate_identity({**official(),**change})


def test_current_login_cannot_silently_rebind_an_existing_shop():
    with pytest.raises(DataError,match='different platform shop'):identity.validate_identity(official(), '999')


def test_identity_is_read_from_a_fresh_official_document_and_owned_page_is_closed(monkeypatch):
    calls=[]
    class Bridge:
        def start(self,uuid,url):calls.append(('start',uuid,url));return 'owned'
        def command(self,eid,method,params):calls.append((method,params));return {}
        def ready(self,eid):pass
        def evaluate(self,eid,script):
            assert '__INITIAL_USER_INFO__' in script and 'return {platform:' in script
            return official()
        def close(self,eid):calls.append(('close',eid))
    monkeypatch.setattr(identity,'ShopDesk',Bridge)
    assert identity.fetch_shop_identity('login','87755028')['shop_name']=='平台新店名'
    assert ('Page.navigate',{'url':identity.IDENTITY_PAGE}) in calls
    assert calls[-1]==('close','owned')
    with pytest.raises(DataError):identity.fetch_shop_identity('login','wrong-shop')
    assert calls[-1]==('close','owned')


def test_latest_name_is_transmitted_and_retries_freeze_it(monkeypatch,tmp_path):
    state={'name':'改名后的店铺'};calls=[]
    def refresh(uuid,expected):calls.append((uuid,expected));return official(state['name'])
    monkeypatch.setattr(upload,'fetch_shop_identity',refresh)
    with server() as (base,requests):
        run=make_run(tmp_path);queue=tmp_path/'queue';cfg=config(base)
        task=upload.enqueue_run(run,cfg,queue_dir=queue)
        metadata=json.loads(Path(task['metadata_path']).read_text())
        assert metadata['platform']=='douyin' and metadata['shop_id']=='87755028'
        assert metadata['shop_name']=='改名后的店铺'
        assert json.loads((Path(task['metadata_path']).parent/'shop-identity.json').read_text())['shop_name']=='改名后的店铺'
        state['name']='再次改名'
        assert upload.enqueue_run(run,cfg,queue_dir=queue)==task
        assert len(calls)==1
        assert upload.drain_queue(cfg,queue_dir=queue)['ok']
        assert requests[0]['metadata']==metadata
        second=upload.enqueue_run(make_run(tmp_path,'run-2'),cfg,queue_dir=queue)
        latest=json.loads(Path(second['metadata_path']).read_text())
        assert latest['shop_id']==metadata['shop_id'] and latest['shop_name']=='再次改名'


@pytest.mark.parametrize('kind',['different_login','manual_override','placeholder'])
def test_wrong_shop_never_enters_upload_queue(monkeypatch,tmp_path,kind):
    run=make_run(tmp_path)
    monkeypatch.setattr(upload,'fetch_shop_identity',lambda *args:official(shop_id='999' if kind=='different_login' else '87755028'))
    if kind=='placeholder':
        p=run/'manifest.json';m=json.loads(p.read_text());m['shop']['shop_id']='REPLACE_WITH_CLOUD_SHOP_ID';p.write_text(json.dumps(m))
    with pytest.raises(DataError,match='shop'):
        upload.enqueue_run(run,config(),queue_dir=tmp_path/'queue',**({'shop_id':'manual-id'} if kind=='manual_override' else {}))
    assert not list((tmp_path/'queue').glob('tasks/*/task.json'))


def test_old_queued_request_keeps_original_fields_and_does_not_refresh_identity(monkeypatch,tmp_path):
    run=make_run(tmp_path);queue=tmp_path/'queue'
    monkeypatch.setattr(upload,'fetch_shop_identity',lambda *args:official())
    task=upload.enqueue_run(run,config(),queue_dir=queue)
    path=Path(task['metadata_path']);metadata=json.loads(path.read_text());metadata.pop('platform')
    metadata['shop_name']='旧请求的名称';path.write_text(json.dumps(metadata))
    task['metadata_sha256']=sha256(path)
    task_path=next(queue.glob('tasks/*/task.json'));task_path.write_text(json.dumps(task))
    monkeypatch.setattr(upload,'fetch_shop_identity',lambda *args:pytest.fail('An existing run must not refresh identity'))
    upload.enqueue_run(run,config(),queue_dir=queue)
    assert json.loads(path.read_text())==metadata
