from copy import deepcopy
from datetime import datetime, timezone, timedelta

import pytest

from douyin_settle_recon.collect import _wallet_export, _wallet_balance
from douyin_settle_recon.shopdesk import ShopDeskError


def timestamp(value):
    return int(datetime.fromisoformat(value).replace(tzinfo=timezone(timedelta(hours=8))).timestamp()*1000)


class WalletUI:
    def __init__(self, proof):self.proof=proof
    def js(self, script):
        return deepcopy(self.proof) if '__walletQueryProof.find' in script else True
    def wait(self, callback, **kwargs):return callback()
    def click(self, label):assert label=='查询'
    def snapshot(self):return {'text':'可提现金额\n¥3.02\n总金额\n¥4.02\n已冻结金额\n¥1.00'}
    def capture(self, root, label, month):return {'path':str(root/'wallet.png'),'sheet':label}


def proof():
    return {'http_status':200,'code':0,'total':0,'completed':True,
            'params':{'start_time':str(timestamp('2026-07-21T00:00:00')),
                      'end_time':str(timestamp('2026-10-19T23:59:59')+999),'member_id':'subject-1'}}


def test_empty_verified_superset_proves_no_wallet_activity_in_target_month(tmp_path):
    manifest={'screenshots':[],'collection':[]};entity={'name':'测试主体'}
    _wallet_export(WalletUI(proof()),'2026-09',tmp_path,manifest,entity)
    assert manifest['collection'][0]['status']=='no_activity'
    assert manifest['collection'][0]['query']['params']['start_time']==str(timestamp('2026-07-21T00:00:00'))
    assert manifest['collection'][0]['export_scope']=='verified_window_containing_requested_month'
    assert manifest['screenshots'][0]['entity_id']=='subject-1'
    assert manifest['screenshots'][0]['wallet_balance']['total']=='4.02'
    assert manifest['screenshots'][0]['wallet_balance']['kind']=='current'


def test_wallet_total_is_labelled_and_unambiguous():
    assert _wallet_balance('可提现金额\n¥500.00\n总金额\n￥1,234.56\n已冻结金额\n¥734.56')['total']=='1234.56'
    assert _wallet_balance('账户余额（元）\n9.99\n动账金额\n100.00') is None
    assert _wallet_balance('总金额\n¥1.00\n总金额\n¥2.00') is None


@pytest.mark.parametrize('field,value', [('start_time',timestamp('2026-09-02T00:00:00')),
                                       ('end_time',timestamp('2026-09-29T23:59:59'))])
def test_empty_wallet_query_outside_requested_scope_is_never_no_activity(tmp_path,field,value):
    receipt=proof();receipt['params'][field]=str(value)
    manifest={'screenshots':[],'collection':[]}
    with pytest.raises(ShopDeskError,match='does not cover'):
        _wallet_export(WalletUI(receipt),'2026-09',tmp_path,manifest,{'name':'测试主体'})
    assert not manifest['collection'] and not manifest['screenshots']


def test_failed_official_wallet_query_cannot_become_zero_activity(tmp_path):
    receipt=proof();receipt['code']=403
    manifest={'screenshots':[],'collection':[]}
    with pytest.raises(ShopDeskError,match='query failed'):
        _wallet_export(WalletUI(receipt),'2026-09',tmp_path,manifest,{'name':'测试主体'})
    assert not manifest['collection']


def test_unopened_wallet_is_recorded_separately_without_querying_or_opening(tmp_path):
    class Unopened(WalletUI):
        def js(self,script):return 'not_opened'
        def click(self,label):raise AssertionError('An unopened account must not be opened or queried')
    manifest={'screenshots':[],'collection':[]}
    _wallet_export(Unopened({}),'2026-09',tmp_path,manifest,{'name':'未开通主体'})
    assert manifest['collection'][0]['status']=='not_opened'
    assert 'query' not in manifest['collection'][0]
    assert len(manifest['screenshots'])==1
    assert manifest['screenshots'][0]['wallet_balance']['total'] is None
    assert manifest['screenshots'][0]['wallet_balance']['status']=='not_opened'


def test_complete_superset_with_only_outside_month_rows_proves_no_monthly_activity(tmp_path):
    receipt=proof();receipt.update(total=1,account_times=['2026-07-21 16:42:26'])
    manifest={'screenshots':[],'collection':[]}
    _wallet_export(WalletUI(receipt),'2026-09',tmp_path,manifest,{'name':'测试主体'})
    assert manifest['collection'][0]['status']=='no_activity'
    assert manifest['collection'][0]['query']['total']==1


@pytest.mark.parametrize('total,times',[(1,['2026-09-21 16:42:26']),(2,['2026-07-21 16:42:26'])])
def test_in_month_rows_or_incomplete_pagination_require_official_export(tmp_path,total,times,monkeypatch):
    called=[]
    monkeypatch.setattr('douyin_settle_recon.collect._wallet_report_download',lambda *args:called.append(args))
    receipt=proof();receipt.update(total=total,account_times=times)
    manifest={'screenshots':[],'collection':[]}
    _wallet_export(WalletUI(receipt),'2026-09',tmp_path,manifest,{'name':'测试主体'})
    assert len(called)==1
    assert not manifest['collection']


def test_wallet_history_report_requires_correct_account_status_and_full_month():
    from douyin_settle_recon.collect import _wallet_report_matches
    report={'account_desc':'管家','task_status':'SUCCESS',
            'start_time':timestamp('2026-09-01T00:00:00')//1000,
            'end_time':timestamp('2026-09-30T23:59:59')//1000}
    assert _wallet_report_matches(report,'2026-09')
    for change in [{'account_desc':'货款'},{'task_status':'PROCESSING'},
                   {'start_time':report['start_time']+1},{'end_time':report['end_time']-1}]:
        assert not _wallet_report_matches({**report,**change},'2026-09')


def test_single_subject_wallet_requires_official_empty_change_list(monkeypatch):
    from douyin_settle_recon.collect import _wallet_entities,_select_entity
    class Single:
        def js(self,*a):return False
        def request(self,path):
            assert path=='/account/center/subjectChangeList?req_source=dou_dian_pc'
            return {'code':0,'data':[]}
    ui=Single();entity=_wallet_entities(ui)[0]
    assert entity['single_subject'] and entity['name']=='当前店铺主体'
    _select_entity(ui,entity,'steward')
    for bad in [{'code':401,'data':[]},{'code':0,'data':[{'name':'另一主体'}]}]:
        monkeypatch.setattr(ui,'request',lambda *a,bad=bad:bad)
        with pytest.raises(ShopDeskError,match='no longer verified'):_select_entity(ui,entity,'steward')
        monkeypatch.setattr('douyin_settle_recon.collect._entities',lambda *a:(_ for _ in ()).throw(ShopDeskError('subject dropdown required')))
        with pytest.raises(ShopDeskError,match='dropdown required'):_wallet_entities(ui)


def test_empty_wallet_export_history_is_not_a_zero_ledger_receipt():
    from types import SimpleNamespace
    from douyin_settle_recon.collect import _wallet_reports
    ui=SimpleNamespace(request=lambda path:{'code':0,'data':None,'total':0})
    assert _wallet_reports(ui,'/verified-path')==[]
    ui.request=lambda path:{'code':0,'data':{'unexpected':'schema'}}
    with pytest.raises(ShopDeskError,match='schema'):_wallet_reports(ui,'/verified-path')
    ui.request=lambda path:{'code':401,'data':None}
    with pytest.raises(ShopDeskError,match='failed'):_wallet_reports(ui,'/verified-path')
