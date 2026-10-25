from douyin_settle_recon.cloud_sync import sync_result


def test_balance_block_does_not_hide_synced_fees_and_checks():
    result=sync_result({'sync':{'state':'blocked','is_current':True,'sheets':[
        {'name':'费用汇总','state':'synced'},{'name':'数据校验','state':'synced'},
        {'name':'余额校验','state':'blocked','error':'余额缺失'}]}})
    assert result['fees_and_checks_synced'] and result['sheets']['余额校验']['state']=='blocked'


def test_archived_or_stale_reports_are_not_assumed_to_have_synced_fees():
    assert not sync_result({'stored':True})['fees_and_checks_synced']
    assert not sync_result({'sync':'unavailable'})['fees_and_checks_synced']
    assert not sync_result({'sync':{'is_current':False,'sheets':[
        {'name':'费用汇总','state':'synced'},{'name':'数据校验','state':'synced'}]}})['fees_and_checks_synced']
    assert not sync_result({'sync':{'is_current':True,'sheets':[
        {'name':'费用汇总','state':'blocked'},{'name':'数据校验','state':'synced'}]}})['fees_and_checks_synced']


def test_synced_partial_sheet_does_not_mean_all_account_fees_are_complete():
    result=sync_result({'sync':{'is_current':True,'sheets':[
        {'name':'费用汇总','state':'synced'},{'name':'数据校验','state':'synced'}]}},partial_accounts=['千川账户'])
    assert result['fees_and_checks_synced'] and not result['complete_fees_synced']
    assert result['partial_accounts']==['千川账户']
