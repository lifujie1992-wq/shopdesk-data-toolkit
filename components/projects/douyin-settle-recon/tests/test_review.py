from pathlib import Path
import os
import pytest

from openpyxl import Workbook

from douyin_settle_recon.review import (
    ReviewStore, csv_data, equivalent, finish, item, page_result,
    summary_compare, table_compare,
)


def workbook(sheet, headers, records):
    wb = Workbook()
    ws = wb.active
    ws.title = sheet
    ws.append(headers)
    for record in records:
        ws.append(record)
    return wb


def test_money_noise_empty_values_and_long_identifiers():
    assert equivalent(1567953.8400003, 1567953.84, "金额")
    assert equivalent(-0.0000004, 0, "余额")
    assert not equivalent(None, 0, "金额")
    assert not equivalent(10.01, 10.02, "金额")
    assert equivalent("\t'2026080214443332433446860177", "2026080214443332433446860177", "动账流水号")
    assert not equivalent("00123", "123", "订单号")
    assert not equivalent("12345678901234567890", "12345678901234567891", "订单号")


def test_table_matches_reordered_columns_and_duplicate_keys_without_losing_records():
    expected=workbook("资金账单",["动帐流水号","金额","费用类型"],
                      [["0001",10,"收入"],["0001",20,"收入"],["0002",0,"退款"]])
    actual=workbook("资金账单",["费用类型","金额","动账流水号"],
                    [["收入",20,"0001"],["收入",10.00000001,"0001"],["退款",None,"0002"],
                     ["收入",20,"0001"]])
    result=table_compare(expected,actual,"资金账单")
    assert result["different"]==2
    assert result["duplicate_keys"]==1
    assert result["expected_rows"]==3 and result["actual_rows"]==4
    assert {r["reason"] for r in result["items"]}=={"实际为空（空值不按 0 处理）","实际新增此行"}
    zero_difference=next(r for r in result["items"] if r["field"]=="金额")
    assert zero_difference["expected_location"]=="资金账单!B4"
    assert zero_difference["actual_location"]=="资金账单!B4"


def test_new_missing_fields_and_rows_are_explicit():
    expected=workbook("结算账单",["子订单号","订单号","结算时间","金额","店铺劵"],
                      [["01","02","2026-08-01",10,3],["03","04","2026-08-01",20,0]])
    actual=workbook("结算账单",["子订单号","订单号","结算时间","新列","店铺券"],
                    [["01","02","2026-08-01",None,3]])
    result=table_compare(expected,actual,"结算账单")
    assert result["different"]==3
    assert {r["reason"] for r in result["items"]}=={"实际缺少字段","实际新增字段","实际缺少此行"}
    assert all(r["field"]!="店铺券" for r in result["items"])


def test_coexisting_aliases_match_exact_header_without_false_missing_amounts():
    expected=workbook("结算账单",["子订单号","订单号","结算时间","店铺券"],
                      [["01","02","2026-08-01",20]])
    actual=workbook("结算账单",["子订单号","订单号","结算时间","店铺劵","店铺券"],
                    [["01","02","2026-08-01",None,20]])
    result=table_compare(expected,actual,"结算账单")
    assert result["different"]==1
    assert result["items"][0]["field"]=="店铺劵"
    assert result["items"][0]["reason"]=="实际新增字段"
    assert result["matched_rows"]==1


def test_summary_aligns_accounts_and_categories_and_does_not_mask_offsetting_errors():
    headers=["店铺编码","资金账户","费用类型","金额"]
    expected=workbook("核对汇总",headers,[[1,"货款账户","收入",100],[1,"货款账户","费用",-10]])
    actual=workbook("核对汇总",headers,[[1,"货款账户","费用",-11],[1,"货款账户","收入",101]])
    result=summary_compare(expected,actual,"fees")
    assert result["different"]==2
    assert result["expected_total"]==result["actual_total"]=="90.00"
    assert result["items"][0]["actual_location"]=="核对汇总!D3"


def test_data_in_unnamed_columns_is_not_silently_ignored():
    expected=workbook("资金账单",["动账流水号"],[["01"]])
    actual=workbook("资金账单",["动账流水号",None],[["01",123]])
    result=table_compare(expected,actual,"资金账单")
    assert result["different"]==1
    assert result["items"][0]["field"]=="未命名列（B）"


def test_blank_amounts_do_not_appear_as_complete_zero_totals():
    headers=["店铺编码","资金账户","费用类型","金额"]
    expected=workbook("核对汇总",headers,[[1,"货款账户","收入",0]])
    actual=workbook("核对汇总",headers,[[1,"货款账户","收入",None]])
    result=summary_compare(expected,actual,"fees")
    assert result["different"]==1
    assert result["expected_total"]=="0.00"
    assert result["actual_total"] is None


@pytest.mark.parametrize('name',['202608【抖音】测试店.xlsx','2026-08【抖音】Y-测试店.xlsx','202608【抖音】Y-测试店.xlsx'])
def test_latest_run_discovery_excludes_source_copies_and_keeps_missing_expected(tmp_path,name):
    older=tmp_path/"runs/20261001T000000Z-old"/name
    newer=tmp_path/"data/runs/20261002T000000Z-new"/name
    raw=tmp_path/"data/runs/20261003T000000Z-source/raw"/name
    for p in (older,newer,raw):
        p.parent.mkdir(parents=True,exist_ok=True);p.touch()
    os.utime(older,(1900000000,1900000000))
    store=ReviewStore(tmp_path)
    catalog=store.catalog()
    assert len(catalog["entries"])==1
    selected=catalog["entries"][0]
    assert selected["actual_path"]==str(newer)
    assert selected["versions"]==2
    assert selected['month']=='2026-08' and selected['shop']=='测试店'
    assert selected["has_expected"] is False
    store.pool.shutdown()


def test_pagination_search_and_csv_export_prevents_formula_injection():
    rows=[item("费用",1,2,"汇总!D2","汇总!D2"),item("相同",2,2),item("=BAD()","=X()","@X()")]
    result={"state":"ready",**finish(rows)}
    page=page_result(result,{"status":["diff"],"q":["D2"],"limit":["1"]})
    assert page["filtered"]==1 and page["different"]==2
    assert page["items"][0]["label"]=="费用"
    exported=csv_data(result).decode("utf-8-sig")
    assert "相同" not in exported
    assert "'=BAD()" in exported and "'=X()" in exported and "'@X()" in exported


def test_balance_evidence_accepts_template_sheet_name():
    from douyin_settle_recon.review import evidence_compare
    expected=workbook("余额账单",[],[]);expected.active["F27"]=28400.13
    actual=workbook("余额截图",[],[]);actual.active["F27"]=28400.13
    result=evidence_compare(expected,actual)
    assert result["different"]==0
    assert result["items"][0]["actual_location"]=="余额截图!F27"
