from pathlib import Path
import importlib.util
import json

import openpyxl
import pytest

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('render_access_audit',ROOT/'tools/render_access_audit.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)


def audit(root,count):
    root.mkdir();(root/'shops').mkdir()
    shops=[{'id':f'shop-{n}','name':f'店铺{n}'} for n in range(count)]
    (root/'shops.json').write_text(json.dumps({'shops':shops}))
    roles=['fund','settlement','base_deposit','experience_deposit','steward','tax','history']
    for shop in shops:
        report={'shop':shop,'complete':True,'pages':[{'role':role,'page':role,'status':'accessible','reason':'页面可访问'} for role in roles]}
        (root/'shops'/(shop['id']+'.json')).write_text(json.dumps(report))


def test_new_workbench_shop_count_is_used_in_report_and_summary(tmp_path):
    root=tmp_path/'audit';audit(root,43)
    module.render(root,tmp_path/'results')
    path=tmp_path/'results/43店财务采集权限与实名认证排查表.xlsx'
    book=openpyxl.load_workbook(path,read_only=True)
    assert book['全部43店'].max_row==44
    assert '43' in book['客户处理说明']['B1'].value
    summary=json.loads((tmp_path/'results/排查汇总.json').read_text())
    assert summary['shop_count']==43 and summary['page_count']==301
    book.close()


def test_incomplete_audit_cannot_be_published_as_complete(tmp_path):
    root=tmp_path/'audit';audit(root,1)
    p=root/'shops/shop-0.json';r=json.loads(p.read_text());r['pages'].pop();p.write_text(json.dumps(r))
    with pytest.raises(SystemExit,match='incomplete'):module.render(root,tmp_path/'results')
    assert not (tmp_path/'results').exists()
