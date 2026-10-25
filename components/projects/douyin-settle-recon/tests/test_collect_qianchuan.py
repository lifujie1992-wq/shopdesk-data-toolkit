from copy import deepcopy
import json
from urllib.parse import urlencode

import pytest

from douyin_settle_recon.collect_qianchuan import _query, collect, DAILY_PATH
from douyin_settle_recon.shopdesk import ShopDeskError


class Bridge:
    def __init__(self,params=None,response=None,status=200):
        self.params=params or {'start_day':'2026-09-01','end_day':'2026-09-30','aadvid':'123'}
        self.response=response or {'code':1,'msg':'success','data':{'page':{'total':0},'result':[]}}
        self.status=status
    def command(self,eid,method,params=None):
        if method=='events':return {'events':[
            {'method':'Network.requestWillBeSent','requestId':'one','url':'https://qianchuan.jinritemai.com'+DAILY_PATH+'?'+urlencode(self.params)},
            {'method':'Network.responseReceived','requestId':'one','status':self.status},
            {'method':'Network.loadingFinished','requestId':'one'}]}
        if method=='Network.getResponseBody':return {'result':{'body':json.dumps(self.response)}}
        raise AssertionError(method)


class UI:
    eid='owned'
    def __init__(self,**options):self.bridge=Bridge(**options)
    def wait(self,callback,**kwargs):
        result=callback()
        if not result:raise ShopDeskError('timed out')
        return result
    def rows(self):return []
    def snapshot(self):return {'text':'暂无数据'}
    def js(self,*args):return True
    def capture(self,root,label,month,**kwargs):return {'path':str(root/'page.png'),'sheet':label}
    def download(self,*args):raise AssertionError('Must not export an unverified or empty query')


def test_query_requires_official_receipt_and_exact_bound_account():
    proof=_query(UI(),'2026-09','123')
    assert proof['total']==0 and proof['params']['aadvid']==['123']
    for change in [{'start_day':'2026-09-02'},{'end_day':'2026-09-29'},{'aadvid':'other'}]:
        params={'start_day':'2026-09-01','end_day':'2026-09-30','aadvid':'123',**change}
        with pytest.raises(ShopDeskError,match='不一致'):_query(UI(params=params),'2026-09','123')


@pytest.mark.parametrize('response',[
    {'code':401,'msg':'unauthorized','data':{'page':{'total':0},'result':[]}},
    {'code':1,'msg':'success','data':{}},
    {'code':1,'msg':'success','data':{'page':{'total':-1},'result':[]}},
])
def test_failed_or_malformed_queries_never_prove_no_activity(response):
    with pytest.raises(ShopDeskError):_query(UI(response=response),'2026-09','123')


def test_verified_empty_query_has_screenshot_and_no_invented_balances(tmp_path,monkeypatch):
    monkeypatch.setattr('douyin_settle_recon.collect_qianchuan._open',lambda ui:'123')
    monkeypatch.setattr('douyin_settle_recon.collect_qianchuan._select_month',lambda *args:None)
    manifest={'inputs':[],'screenshots':[],'collection':[]}
    collect(UI(),'2026-09',tmp_path,manifest)
    assert manifest['inputs']==[]
    assert manifest['collection'][0]['status']=='no_activity'
    assert manifest['screenshots'][0]['excel_sheet']=='千川账户'
    assert manifest['screenshots'][0]['advertiser_id']=='123'
    assert manifest['screenshots'][0]['balance_as_of'] is None


def test_http_error_is_never_empty_success():
    with pytest.raises(ShopDeskError,match='HTTP'):_query(UI(status=403),'2026-09','123')


def test_all_bound_accounts_are_collected_and_successful_accounts_resume(tmp_path,monkeypatch):
    from douyin_settle_recon.collect_qianchuan import collect_all
    monkeypatch.setattr('douyin_settle_recon.collect_qianchuan._entry',lambda ui:'choose')
    accounts=[{'id':'1','name':'账户一'},{'id':'2','name':'账户二'}]
    monkeypatch.setattr('douyin_settle_recon.collect_qianchuan._accounts',lambda ui:deepcopy(accounts))
    calls=[]
    def one(ui,month,root,manifest,*,advertiser_id,entity):
        calls.append(advertiser_id)
        if advertiser_id=='2':raise ShopDeskError('no permission')
        manifest['collection'].append({'role':'qianchuan','status':'downloaded','advertiser_id':advertiser_id,'entity':entity})
    monkeypatch.setattr('douyin_settle_recon.collect_qianchuan.collect',one)
    manifest={'inputs':[],'screenshots':[],'collection':[]}
    collect_all(UI(),'2026-09',tmp_path,manifest)
    assert calls==['1','2']
    assert [r['status'] for r in manifest['collection']]==['downloaded','error']
    assert manifest['collection'][1]['entity']['id']=='2'
    manifest['collection']=manifest['collection'][:1];calls.clear()
    collect_all(UI(),'2026-09',tmp_path,manifest)
    assert calls==['2']
    assert (tmp_path/'collection.json').exists()


def test_entry_reports_official_job_permission_denial_without_waiting_for_timeout():
    from types import SimpleNamespace
    from douyin_settle_recon.collect_qianchuan import _entry, ENTRY
    class Denied:
        eid='owned'
        bridge=SimpleNamespace(command=lambda *args:None,ready=lambda *args:None)
        def snapshot(self):return {'url':ENTRY,'text':'抱歉，你所属的岗位没有访问该页面的权限\n权限点:「流量-千川推广」'}
        def wait(self,callback):return callback()
    with pytest.raises(ShopDeskError,match='流量-千川推广'):_entry(Denied())


@pytest.mark.parametrize('total',[2,3])
def test_sparse_download_matches_official_query_count(tmp_path,monkeypatch,total):
    from decimal import Decimal
    from openpyxl import Workbook
    from test_qianchuan import COLUMNS,sparse_records
    from douyin_settle_recon.model import DataError
    rows=sparse_records([7,10]);source=tmp_path/'daily.xlsx';wb=Workbook();ws=wb.active;ws.append(COLUMNS)
    for row in rows:ws.append([float(row[k]) if isinstance(row[k],Decimal) else row[k] for k in COLUMNS])
    wb.save(source);wb.close()
    class Sparse(UI):
        def rows(self):return [['2026-09-07'],['2026-09-10']]
        def download(self,*args):return [source]
    response={'code':1,'msg':'success','data':{'page':{'total':total},'result':[{},{}]}}
    ui=Sparse(response=response)
    monkeypatch.setattr('douyin_settle_recon.collect_qianchuan._open',lambda *a,**k:'123')
    monkeypatch.setattr('douyin_settle_recon.collect_qianchuan._select_month',lambda *a:None)
    manifest={'inputs':[],'screenshots':[],'collection':[]}
    if total==2:
        collect(ui,'2026-09',tmp_path,manifest)
        assert manifest['collection'][0]['status']=='downloaded'
    else:
        with pytest.raises(DataError,match='条数'):collect(ui,'2026-09',tmp_path,manifest)
        assert not manifest['collection']


def test_registration_entry_is_normal_unopened_state_without_opening_account(tmp_path,monkeypatch):
    from douyin_settle_recon.collect_qianchuan import collect_all
    monkeypatch.setattr('douyin_settle_recon.collect_qianchuan._entry',lambda ui:'not_opened')
    manifest={'inputs':[],'screenshots':[],'collection':[]}
    collect_all(UI(),'2026-09',tmp_path,manifest)
    assert manifest['collection'][0]['status']=='not_opened'
    assert not manifest['inputs']
