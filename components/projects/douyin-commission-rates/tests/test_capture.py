import csv
import json
import sqlite3
from pathlib import Path

import pytest

from commission_rates import cloud_apply
from commission_rates.model import CaptureError, PROMOTED, UNPROMOTED, normalize, normalize_overrides, now, rate, validate_row
from commission_rates.publish import snapshot
from commission_rates.source import Buyin, load_targets, canonical_name
from commission_rates.store import Store, lock

SHOP={'shop_id':'14132514','shop_name':'测试店','platform_shop_id':'87755028','bridge_shop_id':'session'}
ITEM='3834480513620508784'


def raw(item=ITEM,percent=11,status=2):
    return {'product_id':item,'promotion_id':'3834483318225764783','status':status,'open_status':2,
            'title':'样例商品','cos_info':{'cos_ratio':percent},
            'strategy_info':{'all_strategy_id':'7668968505605095722','strategy_kol_num':0}}


def normalized(item=ITEM,percent=11):
    return normalize(raw(item,percent),SHOP,PROMOTED,now())


@pytest.fixture
def store(tmp_path):
    result=Store(tmp_path/'history.sqlite')
    yield result
    result.close()


def create(store,n=10,expected=None):
    targets=[{'shop_id':SHOP['shop_id'],'platform':'抖音','platform_link_id':str(int(ITEM)+i)} for i in range(n)]
    batch=store.new_batch(targets,{'shops':[SHOP]},'fixture',expected or n)
    task=store.db.execute('SELECT * FROM capture_tasks WHERE batch_id=?',(batch,)).fetchone()
    return batch,task


def save(store,batch,task,percent=11):
    rows=[normalized(item,percent) for item in json.loads(task['link_ids_json'])]
    store.save_task(batch,task,rows,[],[])
    store.finish_collection(batch)


def manual_check(store,batch,tmp_path,wrong=False):
    path=tmp_path/(batch+'.csv');rows=store.sample(batch,path)
    for row in rows:
        row.update(observed_rate=row['expected_rate'] if not wrong else .99,
                   observed_enabled=row['expected_enabled'],checked_by='fixture reviewer',
                   checked_at=now(),evidence='fixture://manual-comparison')
    with path.open('w',encoding='utf-8-sig',newline='') as out:
        w=csv.DictWriter(out,fieldnames=list(rows[0]));w.writeheader();w.writerows(rows)
    store.import_checks(batch,path)
    return path


def test_zero_enabled_is_distinct_from_disabled():
    enabled=normalize(raw(percent=0),SHOP,PROMOTED,now())
    disabled=normalize({'product_id':ITEM,'promotion_status':0,'cos_ratio':0,'shop_id':'87755028'},SHOP,UNPROMOTED,now())
    assert (enabled['commission_enabled'],enabled['commission_rate'])==(1,0)
    assert (disabled['commission_enabled'],disabled['commission_rate'])==(0,None)
    disabled['commission_rate']=.01
    with pytest.raises(CaptureError):validate_row(disabled)


@pytest.mark.parametrize('bad',[None,True,-1,101,'NaN','Infinity'])
def test_invalid_percentage(bad):
    with pytest.raises(CaptureError):rate(bad)


def test_ids_are_exact_and_platform_link_is_product_id():
    r=normalized()
    assert r['platform_link_id']==ITEM and r['platform_link_id']!=r['promotion_id']
    r=raw();r['product_id']=float(ITEM)
    with pytest.raises(CaptureError):normalize(r,SHOP,PROMOTED,now())
    assert normalized()['shop_id']=='14132514' and normalized()['platform_shop_id']=='87755028'
    r=raw();r['shop_id']='999'
    with pytest.raises(CaptureError):normalize(r,SHOP,PROMOTED,now())


def test_public_directed_and_ad_rates_stay_separate():
    r=raw();r.update(cos_ratio_low=5,cos_ratio_up=20);r['cos_info']['cos_ratio_ad']=5
    base=normalize(r,SHOP,PROMOTED,now())
    rows=[dict(strategy_id='123',status=1,valid_kol_range=2,cos_ratio={'cos_ratio':14},kol_infos=[{'uid':'12345'}])]
    overrides=normalize_overrides(rows,base)
    assert base['commission_rate']==.11 and base['ad_commission_rate']==.05
    assert base['extra_rate']==.03 and overrides[0]['commission_rate']==.14
    base=normalized()
    normalize_overrides([dict(strategy_id=str(i),status=1,valid_kol_range=2,
        cos_ratio={'cos_ratio':r},kol_infos=[{'uid':str(i)}]) for i,r in [(1,13),(2,14)]],base)
    assert base['extra_rate'] is None


def test_invalid_link_retains_previous_and_does_not_assume_zero():
    previous={**normalized(),'batch_id':'old'}
    r=normalize(raw(percent=18,status=6),SHOP,PROMOTED,now(),previous)
    assert r['commission_rate']==.11 and r['link_status']=='失效'
    assert r['carried_from_batch']=='old' and r['rate_captured_at']==previous['rate_captured_at']
    assert normalize(raw(status=4),SHOP,PROMOTED,now())['link_status']=='下架'
    with pytest.raises(CaptureError):normalize(raw(status=99),SHOP,PROMOTED,now())
    r=raw();r['strategy_info']={}
    with pytest.raises(CaptureError):normalize(r,SHOP,PROMOTED,now())


def test_task_rollback_keeps_resume_consistent(store):
    batch,task=create(store)
    with pytest.raises(sqlite3.IntegrityError):store.save_task(batch,task,[normalized(),normalized()],[],[])
    assert store.db.execute('SELECT count(*) FROM commission_rates').fetchone()[0]==0
    assert store.db.execute('SELECT status FROM capture_tasks').fetchone()[0]=='pending'
    save(store,batch,task)
    assert store.report(batch)['pending_tasks']==0


def test_history_and_latest_only_accepted(store,tmp_path):
    first,task=create(store);save(store,first,task,11)
    assert store.db.execute('SELECT count(*) FROM commission_rates_latest').fetchone()[0]==0
    manual_check(store,first,tmp_path);store.accept(first)
    second,task=create(store);save(store,second,task,15)
    with store.db:store.db.execute("UPDATE batch_runs SET started_at='2099-01-01T00:00:00+08:00' WHERE batch_id=?",(second,))
    assert store.db.execute('SELECT DISTINCT commission_rate FROM commission_rates_latest').fetchone()[0]==.11
    store.accept(second,first)
    assert store.db.execute('SELECT count(*) FROM commission_rates').fetchone()[0]==20
    assert store.db.execute('SELECT DISTINCT commission_rate FROM commission_rates_latest').fetchone()[0]==.15
    with pytest.raises(CaptureError):store.save_task(first,task,[],[],[])


def test_unreviewed_or_false_manual_results_block_publication(store,tmp_path):
    batch,task=create(store);save(store,batch,task)
    with pytest.raises(CaptureError):store.accept(batch)
    with pytest.raises(CaptureError):snapshot(store,batch,tmp_path/'pub')
    manual_check(store,batch,tmp_path,wrong=True)
    with pytest.raises(CaptureError):store.accept(batch)
    sampled=store.sample(batch,tmp_path/'again.csv',seed=1)
    assert len(sampled)==10 and all(r['matches']==0 for r in sampled)


def test_universe_not_shrunk_to_successful_subset(store,tmp_path):
    batch,task=create(store,expected=70460);save(store,batch,task);manual_check(store,batch,tmp_path)
    assert store.report(batch)['coverage']==1 and not store.report(batch)['ready_to_accept']


def test_snapshot_manifest_and_cloud_history_guard(store,tmp_path):
    batch,task=create(store);save(store,batch,task);manual_check(store,batch,tmp_path);store.accept(batch)
    result=snapshot(store,batch,tmp_path/'pub')
    assert result['row_counts']['commission_rates']==10 and result['published_at'].endswith('+08:00')
    db=sqlite3.connect(Path(result['snapshot']).as_uri()+'?mode=ro',uri=True)
    cloud_apply.validate(db,result);cloud_apply.guard_history(db,store.path);db.close()
    db=sqlite3.connect(Path(result['snapshot']).as_uri(),uri=True);db.execute('UPDATE commission_rates SET commission_rate=.5');db.commit()
    with pytest.raises(ValueError,match='would_rewrite_history'):cloud_apply.guard_history(db,store.path)
    db.close()


def test_reuse_review_requires_same_adapter_and_shop_config(store,tmp_path):
    batch,task=create(store);save(store,batch,task);manual_check(store,batch,tmp_path);store.accept(batch)
    second,task=create(store);save(store,second,task)
    with store.db:store.db.execute("UPDATE batch_runs SET adapter_hash='changed' WHERE batch_id=?",(second,))
    with pytest.raises(CaptureError):store.accept(second,batch)
    assert store.batch(second)['acceptance_reference'] is None


def test_pagination_rejects_ignored_filter_repeated_and_empty_pages():
    source=Buyin()
    source.request=lambda *a: {'code':0,'st':0,'data':[raw()],'total':2,'current':1}
    with pytest.raises(CaptureError,match='ignored exact'):source.pages(PROMOTED,{}, {ITEM})
    source.request=lambda path,q: {'code':0,'st':0,'data':[raw()],'total':2,'current':q['page']}
    with pytest.raises(CaptureError,match='repeated'):source.pages(PROMOTED,{})
    source.request=lambda *a: {'code':0,'st':0,'data':[],'total':1,'current':1}
    with pytest.raises(CaptureError,match='incomplete'):source.pages(PROMOTED,{})


def test_target_scope_shipped_douyin_and_ambiguous_erp_code(tmp_path):
    path=tmp_path/'facts.sqlite';db=sqlite3.connect(path)
    db.execute('CREATE TABLE order_profit_facts(shop_id,platform,platform_link_id,spu_id,actual_shipped_qty,shipped_at)')
    db.executemany('INSERT INTO order_profit_facts VALUES(?,?,?,?,?,?)',[
        ('1','抖音',ITEM,'spu-a',1,None),('1','抖音',ITEM,'spu-b',1,None),
        ('2','淘宝','2','x',1,None),('3','抖音','3','y',0,None),('4','抖音','4','z',None,'2026-10-18')])
    db.commit();db.close();rows=load_targets(path)
    assert len(rows)==2 and rows[0]['platform_link_id']==ITEM and rows[0]['internal_item_code'] is None
    assert canonical_name('Y-兹伊翰官方旗舰店-晓婷（英豪）')=='兹伊翰官方旗舰店'
    assert canonical_name('Y-DLIN-DLING服饰旗舰店-伟洲')=='DLIN-DLING服饰旗舰店'
    assert canonical_name('DLIN-DLING服饰旗舰店')=='DLIN-DLING服饰旗舰店'


def test_single_writer_lock(tmp_path):
    with lock(tmp_path/'db'):
        with pytest.raises(CaptureError):
            with lock(tmp_path/'db'):pass


def test_recurring_reference_validates_on_cloud_and_stays_immutable(store,tmp_path):
    first,task=create(store);save(store,first,task);manual_check(store,first,tmp_path);store.accept(first)
    second,task=create(store);save(store,second,task,13);store.accept(second,first)
    result=snapshot(store,second,tmp_path/'pub')
    with sqlite3.connect(Path(result['snapshot']).as_uri()+'?mode=ro',uri=True) as db:
        cloud_apply.validate(db,result)
    with pytest.raises(CaptureError,match='immutable'):store.sample(second,tmp_path/'late.csv')


def test_missing_result_is_issue_not_disabled_record(store):
    batch,task=create(store,n=1)
    source=Buyin();source.shop=SHOP
    source.pages=lambda *args,**kwargs: []
    rows,extra,issues=source.task(store,batch,task)
    assert rows==[] and extra==[]
    assert issues==[(ITEM,'not_found_in_promoted_or_unpromoted_inventory')]


def test_explicit_unpromoted_result_is_captured(store):
    batch,task=create(store,n=1)
    source=Buyin();source.shop=SHOP
    def pages(path,*args,**kwargs):
        return [] if path==PROMOTED else [{'product_id':ITEM,'promotion_status':0,'cos_ratio':0}]
    source.pages=pages
    rows,extra,issues=source.task(store,batch,task)
    assert len(rows)==1 and rows[0]['commission_enabled']==0 and rows[0]['commission_rate'] is None
    assert issues==[]


def test_partial_release_keeps_quality_flags_and_exposes_only_released_batch(store,tmp_path):
    first,task=create(store);save(store,first,task,11)
    second,task=create(store,expected=70460);save(store,second,task,13)
    with pytest.raises(CaptureError,match='reason'):
        snapshot(store,second,tmp_path/'pub',allow_partial=True)
    result=snapshot(store,second,tmp_path/'pub',allow_partial=True,reason='user requests current results immediately')
    assert result['publication_mode']=='partial' and result['available_row_count']==10
    assert not result['acceptance']['complete'] and result['acceptance']['expected_links']==70460
    assert store.db.execute('SELECT count(*) FROM commission_rates_latest').fetchone()[0]==0
    rows=store.db.execute('SELECT DISTINCT batch_id,commission_rate,batch_complete FROM commission_rates_available_latest').fetchall()
    assert [tuple(r) for r in rows]==[(second,.13,0)]
    with sqlite3.connect(Path(result['snapshot']).as_uri()+'?mode=ro',uri=True) as db:
        cloud_apply.validate(db,result)
        cloud_apply.guard_history(db,store.path)


def test_partial_publication_allows_real_review_later_without_rewriting_rates(store,tmp_path):
    batch,task=create(store);save(store,batch,task);store.sample(batch,tmp_path/'sample.csv')
    old=snapshot(store,batch,tmp_path/'pub',allow_partial=True,reason='release existing rows')
    manual_check(store,batch,tmp_path);store.accept(batch)
    accepted=snapshot(store,batch,tmp_path/'pub')
    with sqlite3.connect(Path(accepted['snapshot']).as_uri()+'?mode=ro',uri=True) as db:
        cloud_apply.validate(db,accepted)
        cloud_apply.guard_history(db,Path(old['snapshot']))


def test_partial_release_cannot_fabricate_complete_or_hide_coverage(store,tmp_path):
    batch,task=create(store,expected=70460);save(store,batch,task)
    result=snapshot(store,batch,tmp_path/'pub',allow_partial=True,reason='release existing rows')
    # A crafted manifest and matching embedded metadata still cannot claim accepted status.
    result['publication_mode']='accepted'
    result['row_counts']['publication_releases']+=1
    path=Path(result['snapshot'])
    with sqlite3.connect(path) as db:
        db.execute('UPDATE _warehouse_publication SET metadata_json=?',(json.dumps(result),))
        db.execute("INSERT INTO publication_releases VALUES(?,'accepted',?,'fabricated')",(batch,now()))
    with sqlite3.connect(path.as_uri()+'?mode=ro',uri=True) as db:
        with pytest.raises(ValueError,match='batch_not_accepted'):
            cloud_apply.validate(db,result)


def test_daily_partial_policy_publishes_without_forging_acceptance(tmp_path,monkeypatch):
    from commission_rates import daily as daily_module
    target_path=tmp_path/'targets.json'
    target_path.write_text(json.dumps([{'shop_id':SHOP['shop_id'],'platform':'抖音','platform_link_id':str(int(ITEM)+i)} for i in range(10)]))
    shops=tmp_path/'shops.json';shops.write_text(json.dumps({'shops':[SHOP]}))
    config=tmp_path/'daily.json'
    config.write_text(json.dumps({'facts':str(target_path),'shops':str(shops),'state_dir':str(tmp_path/'state'),
                                 'expected_links':70460,'publish':True,'publish_partial':True,
                                 'partial_release_reason':'explicit user instruction','server':{}}))
    def fake_collect(store,batch,*args,**kwargs):
        for task in store.db.execute("SELECT * FROM capture_tasks WHERE batch_id=? AND status<>'done'",(batch,)).fetchall():
            save(store,batch,task)
        return store.report(batch)
    uploads=[]
    def fake_upload(path,config):
        metadata=json.loads(Path(str(path)+'.manifest.json').read_text())
        uploads.append(metadata)
        return {**metadata,'ok':True}
    monkeypatch.setattr(daily_module,'collect',fake_collect)
    monkeypatch.setattr(daily_module,'upload',fake_upload)
    db_path=tmp_path/'daily.sqlite'
    assert daily_module.daily(db_path,config)==0
    assert uploads[0]['publication_mode']=='partial' and not uploads[0]['acceptance']['complete']
    status=json.loads((tmp_path/'state/daily-status.json').read_text())
    assert status['status']=='published_partial'
    with sqlite3.connect(db_path) as db:
        assert db.execute('SELECT complete FROM batch_runs').fetchone()[0]==0
        assert db.execute('SELECT count(*) FROM commission_rates_available_latest').fetchone()[0]==10


def test_unpromoted_legacy_rate_needs_independent_empty_active_strategy_evidence():
    raw_row={'product_id':ITEM,'promotion_status':99,'promotion_id':'','cos_ratio':8,'is_pass':2}
    with pytest.raises(CaptureError):normalize(raw_row,SHOP,UNPROMOTED,now())
    result=normalize({**raw_row,'_capture_active_strategy_count':0},SHOP,UNPROMOTED,now())
    assert result['commission_enabled']==0 and result['commission_rate'] is None
    assert 'cos_ratio' in result['notes']
    with pytest.raises(CaptureError):normalize({**raw_row,'_capture_active_strategy_count':1},SHOP,UNPROMOTED,now())


@pytest.mark.parametrize('workers',[1,2,8])
def test_workers_leave_one_shared_slot_and_use_separate_connections(store,monkeypatch,workers):
    from commission_rates import runner
    from threading import Lock
    import time
    batch,task=create(store)
    other={**SHOP,'shop_id':'999'}
    with store.db:
        store.db.execute('INSERT INTO capture_tasks(batch_id,shop_id,task_id,link_ids_json,updated_at) VALUES(?,?,?,?,?)',
                         (batch,'999',0,json.dumps([ITEM]),now()))
    called=[]
    active=peak=0
    guard=Lock()
    def fake_collect(local,batch,source,only_shop):
        nonlocal active,peak
        assert local is not store
        with guard:
            active+=1
            peak=max(peak,active)
            called.append(only_shop)
        try:
            time.sleep(.05)
            return local.report(batch)
        finally:
            with guard:active-=1
    monkeypatch.setattr(runner,'collect',fake_collect)
    runner.collect_all(store,batch,workers=workers)
    assert sorted(called)==['14132514','999']
    assert peak==1


def test_incremental_upload_failure_does_not_skip_final_publication(tmp_path,monkeypatch):
    from commission_rates import daily as daily_module
    import subprocess
    targets=tmp_path/'targets.json'
    targets.write_text(json.dumps([{'shop_id':SHOP['shop_id'],'platform':'抖音','platform_link_id':ITEM}]))
    shops=tmp_path/'shops.json';shops.write_text(json.dumps({'shops':[SHOP]}))
    config=tmp_path/'daily.json'
    config.write_text(json.dumps({'facts':str(targets),'shops':str(shops),'state_dir':str(tmp_path/'state'),
      'expected_links':70460,'publish':True,'publish_partial':True,'incremental_publish':True,
      'partial_release_reason':'explicit user instruction','server':{}}))
    def fake_collect(store,batch,*args,**kwargs):
        task=store.db.execute('SELECT * FROM capture_tasks WHERE batch_id=?',(batch,)).fetchone()
        save(store,batch,task)
        for i in range(4):kwargs['on_shop'](str(i),store.report(batch))
        return store.report(batch)
    def reject(*args,**kwargs):raise subprocess.CalledProcessError(1,args[0])
    monkeypatch.setattr(subprocess,'run',reject)
    monkeypatch.setattr(daily_module,'collect',fake_collect)
    published=[]
    def upload(path,config):
        m=json.loads(Path(str(path)+'.manifest.json').read_text());published.append(m);return m
    monkeypatch.setattr(daily_module,'upload',upload)
    assert daily_module.daily(tmp_path/'db.sqlite',config)==0
    assert len(published)==1 and published[0]['available_row_count']==1
