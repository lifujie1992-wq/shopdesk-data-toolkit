import json
from pathlib import Path

import pytest

from douyin_settle_recon import retention, upload
from douyin_settle_recon.model import DataError
from test_upload import make_run, config, server, fake_identity


@pytest.fixture(autouse=True)
def private_locks(tmp_path,monkeypatch):
    monkeypatch.setenv('XDG_CACHE_HOME',str(tmp_path/'cache'))
    monkeypatch.setattr(upload,'fetch_shop_identity',fake_identity)


def uploaded(tmp_path,base):
    runs=tmp_path/'runs';root=make_run(runs);cfg=config(base);queue=tmp_path/'queue'
    upload.enqueue_run(root,cfg,queue_dir=queue)
    delivered=upload.drain_queue(cfg,queue_dir=queue)
    assert delivered['ok']
    return runs,root,cfg,queue,delivered['tasks'][0]


def test_query_download_and_hash_before_cleanup_then_reupload_uses_saved_archive(tmp_path):
    with server() as (base,requests):
        runs,root,cfg,queue,task=uploaded(tmp_path,base)
        result=retention.finalize_upload(task,cfg,runs_root=runs)
        assert result['state']=='cleaned' and not root.exists()
        directory=Path(task['metadata_path']).parent
        for name in ['task.json','metadata.json','receipt.json','cloud-verification.json','cleanup-plan.json']:
            assert (directory/name).is_file()
        proof=json.loads((directory/'cloud-verification.json').read_text())
        assert proof['queried'] and proof['matches_original_excel']
        assert upload.enqueue_run(root,cfg,queue_dir=queue)['cleanup']['state']=='cleaned'
        with pytest.raises(DataError,match='immutable'):upload.enqueue_run(root,cfg,queue_dir=queue,shop_id='changed-shop')
        assert len(requests)==1


def test_partial_archive_retains_sources_and_followup_uses_new_run_same_shop_month(tmp_path,monkeypatch):
    from test_report_validation import sample
    monkeypatch.setattr(upload,'fetch_shop_identity',lambda *args:{
        'platform':'douyin','shop_id':'123','shop_name':'验收测试店',
        'source':'official_platform_bootstrap','observed_at':'2026-10-25T00:00:00+00:00'})
    with server() as (base,requests):
        cfg=config(base);queue=tmp_path/'queue'
        partial=sample(tmp_path/'partial','failed');root=Path(partial['run_dir'])
        upload.enqueue_run(root,cfg,queue_dir=queue)
        delivered=upload.drain_queue(cfg,queue_dir=queue);assert delivered['ok']
        task=delivered['tasks'][0]
        assert task['partial_accounts']==['千川账户']
        result=retention.finalize_upload(task,cfg,runs_root=root.parent)
        assert result['state']=='retained_partial' and root.exists()
        assert (root/'tables.sqlite').is_file() and Path(partial['report']).is_file()
        assert retention.finalize_queue(cfg,queue_dir=queue,runs_root=root.parent)['ok']
        old_metadata=Path(task['metadata_path']).read_bytes();old_file=Path(partial['report']).read_bytes()
        full=sample(tmp_path/'full','data')
        upload.enqueue_run(Path(full['run_dir']),cfg,queue_dir=queue)
        assert upload.drain_queue(cfg,queue_dir=queue)['ok']
        assert len(requests)==2
        first,last=[r['metadata'] for r in requests]
        assert first['local_run_id']!=last['local_run_id']
        assert first['reconciliation_status']=='pending'
        for field in ['platform','shop_id','reconciliation_month']:assert first[field]==last[field]
        assert Path(task['metadata_path']).read_bytes()==old_metadata and Path(partial['report']).read_bytes()==old_file


@pytest.mark.parametrize('failure',[{'query_status':401},{'head_size_delta':1},{'corrupt_download':True}])
def test_any_cloud_verification_failure_retains_all_data(tmp_path,failure):
    with server(**failure) as (base,requests):
        runs,root,cfg,queue,task=uploaded(tmp_path,base)
        with pytest.raises(DataError):retention.finalize_upload(task,cfg,runs_root=runs)
        assert root.exists() and Path(task['report_path']).exists()
        assert not (Path(task['metadata_path']).parent/'cleanup-plan.json').exists()


def test_cloud_must_persist_and_return_the_uploaded_platform(tmp_path):
    with server(query_platform='taobao') as (base,requests):
        runs,root,cfg,queue,task=uploaded(tmp_path,base)
        with pytest.raises(DataError,match='platform'):retention.finalize_upload(task,cfg,runs_root=runs)
        assert root.exists()


def test_same_id_from_a_different_platform_is_not_a_superseded_run(tmp_path):
    with server() as (base,requests):
        runs,root,cfg,queue,task=uploaded(tmp_path,base)
        foreign=make_run(runs,'foreign-platform')
        p=foreign/'manifest.json';m=json.loads(p.read_text());m['shop']['platform']='taobao'
        m['source_artifacts']=[{'artifact_id':'same-source'}];p.write_text(json.dumps(m))
        p=root/'manifest.json';m=json.loads(p.read_text());m['source_artifacts']=[{'artifact_id':'same-source'}];p.write_text(json.dumps(m))
        retention.finalize_upload(task,cfg,runs_root=runs)
        assert foreign.exists()


def test_edited_local_workbook_is_not_deleted_even_if_cloud_is_correct(tmp_path):
    with server() as (base,requests):
        runs,root,cfg,queue,task=uploaded(tmp_path,base)
        Path(task['report_path']).write_bytes(b'user changes')
        with pytest.raises(DataError,match='local report changed'):retention.finalize_upload(task,cfg,runs_root=runs)
        assert Path(task['report_path']).read_bytes()==b'user changes'


def test_only_owned_sources_and_covered_superseded_runs_are_removed(tmp_path):
    with server() as (base,requests):
        runs,root,cfg,queue,task=uploaded(tmp_path,base)
        doc=tmp_path/'doc';doc.mkdir();(doc/'template.xlsx').write_bytes(b'user template')
        first=runs/'collection-first';first.mkdir();raw=first/'raw.csv';raw.write_text('rows')
        second=runs/'collection-second';second.mkdir()
        identity={'platform_shop_id':'87755028','shopdesk_shop_uuid':'volatile-login-id'}
        for collection,inputs in [(first,[]),(second,[{'path':str(raw)}])]:
            (collection/'collection.json').write_text(json.dumps({'shop':identity,'month':'2026-09','inputs':inputs,'screenshots':[]}))
        result=json.loads((root/'result.json').read_text());result['context']['collection_manifest']=str(second/'collection.json');(root/'result.json').write_text(json.dumps(result))
        manifest=json.loads((root/'manifest.json').read_text());manifest['source_artifacts']=[{'artifact_id':'raw-hash'}];(root/'manifest.json').write_text(json.dumps(manifest))
        old=runs/'older-run';old.mkdir();(old/'manifest.json').write_text(json.dumps({**manifest,'run_id':'older-run'}))
        other=runs/'unrelated';other.mkdir();(other/'manifest.json').write_text(json.dumps({**manifest,'month':'2026-08'}))
        retention.finalize_upload(task,cfg,runs_root=runs)
        assert not any(p.exists() for p in [root,first,second,old])
        assert other.exists() and (doc/'template.xlsx').read_bytes()==b'user template'


def test_reject_root_escape_before_deleting_anything(tmp_path):
    with server() as (base,requests):
        runs,root,cfg,queue,task=uploaded(tmp_path,base)
        with pytest.raises(DataError,match='outside'):retention.finalize_upload(task,cfg,runs_root=tmp_path/'wrong-root')
        assert root.exists()


def test_collection_platform_mismatch_cannot_be_overridden_by_same_login_uuid(tmp_path):
    with server() as (base,requests):
        runs,root,cfg,queue,task=uploaded(tmp_path,base)
        extra=runs/'collection-wrong-shop';extra.mkdir()
        (extra/'collection.json').write_text(json.dumps({'month':'2026-09','shop':{
            'platform_shop_id':'another-platform-shop','shopdesk_shop_uuid':'volatile-login-id'},'inputs':[],'screenshots':[]}))
        data=json.loads((root/'result.json').read_text());data['context']['collection_manifest']=str(extra/'collection.json');(root/'result.json').write_text(json.dumps(data))
        with pytest.raises(DataError,match='ownership'):retention.finalize_upload(task,cfg,runs_root=runs)
        assert root.exists() and extra.exists()


def test_partial_cleanup_resumes_from_saved_plan_without_local_workbook(tmp_path,monkeypatch):
    with server() as (base,requests):
        runs,root,cfg,queue,task=uploaded(tmp_path,base)
        extra=runs/'collection-extra';extra.mkdir();(extra/'collection.json').write_text(json.dumps({'month':'2026-09','shop':{'platform_shop_id':'87755028'},'inputs':[],'screenshots':[]}))
        data=json.loads((root/'result.json').read_text());data['context']['collection_manifest']=str(extra/'collection.json');(root/'result.json').write_text(json.dumps(data))
        original=retention.shutil.rmtree
        def interrupted(path):
            if path==extra:raise OSError('simulated interruption')
            original(path)
        monkeypatch.setattr(retention.shutil,'rmtree',interrupted)
        with pytest.raises(OSError):retention.finalize_upload(task,cfg,runs_root=runs)
        assert not root.exists() and extra.exists()
        monkeypatch.setattr(retention.shutil,'rmtree',original)
        assert retention.finalize_upload(task,cfg,runs_root=runs)['state']=='cleaned'
        assert not extra.exists()


@pytest.mark.parametrize('covered',[True,False])
def test_duplicate_cleanup_requires_verified_same_shop_period_and_all_input_hashes(tmp_path,covered):
    with server() as (base,requests):
        runs,root,cfg,queue,task=uploaded(tmp_path,base)
        p=root/'manifest.json';m=json.loads(p.read_text());m['source_artifacts']=[{'artifact_id':'covered-source'}];p.write_text(json.dumps(m))
        retention.finalize_upload(task,cfg,runs_root=runs)
        alias=make_run(runs,run_id='duplicate-run');p=alias/'manifest.json';m=json.loads(p.read_text())
        m['source_artifacts']=[{'artifact_id':'covered-source' if covered else 'new-source'}];p.write_text(json.dumps(m))
        task=json.loads(Path(task['metadata_path']).with_name('task.json').read_text())
        if covered:
            result=retention.cleanup_covered_duplicate(alias,task,cfg,runs_root=runs)
            assert result['state']=='cleaned' and result['source_hash_coverage_verified'] and not alias.exists()
        else:
            with pytest.raises(DataError,match='not fully covered'):retention.cleanup_covered_duplicate(alias,task,cfg,runs_root=runs)
            assert alias.exists()


def test_only_verified_collection_workbench_cache_is_deleted(tmp_path,monkeypatch):
    bridge=tmp_path/'workbench-finance';bridge.mkdir()
    monkeypatch.setattr(retention,'SHOPDESK_FINANCE_ROOT',bridge)
    owned=bridge/'12345678-1234-1234-1234-123456789abc';owned.mkdir();(owned/'raw.zip').write_bytes(b'cache')
    unrelated=bridge/'87654321-1234-1234-1234-123456789abc';unrelated.mkdir()
    with server() as (base,_):
        runs,root,cfg,queue,task=uploaded(tmp_path,base)
        collection=runs/'collection-current';collection.mkdir()
        (collection/'collection.json').write_text(json.dumps({'month':'2026-09','shop':{
            'platform_shop_id':'87755028','shopdesk_shop_uuid':'volatile-login-id'},'inputs':[],'screenshots':[]}))
        (collection/'session.json').write_text(json.dumps({'shop':{'id':'volatile-login-id'},'exploration':{'id':owned.name}}))
        p=root/'result.json';data=json.loads(p.read_text());data['context']['collection_manifest']=str(collection/'collection.json');p.write_text(json.dumps(data))
        result=retention.finalize_upload(task,cfg,runs_root=runs)
        assert not owned.exists() and unrelated.exists()
        assert str(owned) in result['deleted']
