"""Read the final XLSX values and formula caches before freezing an upload."""
from decimal import Decimal
from pathlib import Path
import re
import xml.etree.ElementTree as ET
import zipfile

from .model import DataError, decimal, dump_json
from .qianchuan import COLUMNS, TOTAL_FORMULAS
from .workbook_layout import NS, workbook_sheets
from .collection_status import partial_qianchuan, qianchuan_denied


def validate_report(path, context, snapshot=None):
    partial=partial_qianchuan(context)
    result={'version':1,'ready':False,'shop_id':context.get('platform_shop_id'),
            'month':context.get('month'),'qianchuan_result':context.get('qianchuan_result'),
            'expense_status':'failed','errors':[],'balance_issues':[],'values':{},
            'partial_accounts':['千川账户'] if partial else [],'complete':False}
    errors=result['errors']
    def fail(cell,message):errors.append({'cell':cell,'reason':message})
    for message in context.get('fee_source_errors',[]):fail('费用来源',message)
    for receipt in context.get('collection',[]):
        if receipt.get('status') in ['error','permission_denied'] and not (partial and qianchuan_denied(receipt)):
            fail(str(receipt.get('role')), '获取失败，具体原因见采集清单')
    try:
        with zipfile.ZipFile(path) as z:
            sheets=workbook_sheets(z)
            names=[s.get('name') for s in ET.fromstring(z.read('xl/workbook.xml')).find('m:sheets',NS)]
            if names.count('核对汇总')!=1:raise DataError('必须存在唯一的核对汇总工作表')
            if names.count('千川账户')!=1:fail('千川账户','必须存在唯一的千川账户来源页')
            strings=[]
            if 'xl/sharedStrings.xml' in z.namelist():
                strings=[''.join(t.itertext()) for t in ET.fromstring(z.read('xl/sharedStrings.xml'))]
            def cells(name):
                return {c.get('r'):c for c in ET.fromstring(z.read(sheets[name])).findall('.//m:sheetData/m:row/m:c',NS)}
            def value(c):
                if c is None:return None
                v=c.find('m:v',NS)
                if c.get('t')=='inlineStr':
                    node=c.find('m:is',NS);return ''.join(node.itertext()) if node is not None else None
                if v is None or v.text is None:return None
                if c.get('t')=='s':return strings[int(v.text)]
                return v.text
            def number(grid,coord,sheet='核对汇总'):
                c=grid.get(coord);v=value(c)
                if c is None or c.get('t','n')!='n' or v is None:
                    fail(f'{sheet}!{coord}','必须是有效数值或数值公式缓存，不能为空、文本、布尔值或错误');return None
                try:return decimal(v,blank_zero=False)
                except DataError:
                    fail(f'{sheet}!{coord}','金额不是有限数值');return None
            def unknown(grid,coord,sheet='核对汇总'):
                if value(grid.get(coord)) not in [None,'']:
                    fail(f'{sheet}!{coord}','千川无权限时金额必须留空，不能填0或使用旧金额')
                return None
            summary=cells('核对汇总')
            if [value(summary.get(c)) for c in ['A1','B1','C1','D1']]!=['店铺编码','资金账户','费用类型','金额']:
                fail('核对汇总!A1:D1','费用表头与模板不一致')
            fees={};qfees={};qcells={}
            rows=sorted({int(re.search(r'\d+$',c)[0]) for c in summary})
            for rn in rows:
                if rn==1:continue
                account=value(summary.get(f'B{rn}'));category=value(summary.get(f'C{rn}'))
                if account is None and category is None:continue
                if not account or not category:
                    fail(f'核对汇总!B{rn}:C{rn}','资金账户与费用名称必须同时存在');continue
                coord=f'D{rn}'
                amount=unknown(summary,coord) if partial and account=='千川账户' else number(summary,coord)
                fees[rn]=amount
                if account=='千川账户':
                    if category in qfees:fail(coord,'千川费用名称重复')
                    qfees[category]=amount;qcells[category]=coord
            if not fees:fail('核对汇总!B:D','费用区块为空')
            if snapshot:
                for coord,formula in snapshot.get('summary_formulas',{}).items():
                    c=summary.get(coord);f=c.find('m:f',NS) if c is not None else None
                    if f is None or '='+str(f.text)!=formula:fail(coord,'模板公式已丢失或改变')
                    if coord in snapshot.get('array_formulas',[]) and (f is None or f.get('t')!='array' or f.get('ref')!=coord):
                        fail(coord,'数组公式元数据丢失或改变')
            checks={c:number(summary,c) for c in ['H2','H3','H4']}
            def equal(coord,actual,expected):
                # XLSX stores IEEE floating-point numbers. Compare at the
                # template's 10 decimal places without changing stored amounts.
                if actual is not None and expected is not None and abs(actual-expected)>Decimal('0.00000000005'):
                    fail(coord,f'缓存与来源计算不符：{actual} != {expected}')
            selected=[fees.get(i) for i in [*range(2,10),31,37]]
            if all(v is not None for v in selected):equal('H2',checks['H2'],sum(selected,Decimal(0)))
            if checks['H2'] is not None and checks['H3'] is not None:equal('H4',checks['H4'],checks['H2']-checks['H3'])
            if '结算账单' in sheets:
                settled=Decimal(0)
                with z.open(sheets['结算账单']) as stream:
                    for _,node in ET.iterparse(stream,events=('end',)):
                        if node.tag.endswith('}row'):
                            if int(node.get('r','0'))>1:
                                for c in node:
                                    if re.fullmatch(r'D[0-9]+',c.get('r','')):
                                        amount=number({c.get('r'):c},c.get('r'),'结算账单')
                                        if amount is not None:settled+=amount
                            node.clear()
                equal('H3',checks['H3'],settled)
            else:fail('H3','缺少结算账单来源页')

            if '千川账户' in sheets:
                qstate=context.get('qianchuan_result',{})
                if not partial and qstate.get('status') not in ['success_data','success_empty']:
                    fail('千川账户',qstate.get('reason') or '获取状态不明确，不能当作正常空数据')
                q=cells('千川账户')
                if [value(q.get(f'{chr(65+i)}1')) for i in range(14)]!=COLUMNS:fail('千川账户!A1:N1','日结报表列位置或名称不一致')
                totals=[c for c in q if re.fullmatch(r'A[0-9]+',c) and value(q[c])=='总计']
                if partial:
                    for coord,c in q.items():
                        if re.fullmatch(r'[A-N][0-9]+',coord) and int(re.search(r'\d+$',coord)[0])>1:
                            unknown(q,coord,'千川账户')
                    for coord in ['Q4','R4']:unknown(q,coord,'千川账户')
                elif len(totals)!=1:fail('千川账户!A:A','缺少唯一且精确匹配的总计行')
                expected={}
                if len(totals)==1:
                    rn=totals[0][1:];values={c:number(q,f'{c}{rn}','千川账户') for c in ['C','D','I']}
                    if all(v is not None for v in values.values()):
                        expected={'非赠款消耗':-values['C'],'巨量千川充值':values['I']-values['D']}
                    if qstate.get('status')=='success_empty':
                        for col in 'BCDEFGHIJK':equal(f'千川账户!{col}{rn}',number(q,f'{col}{rn}','千川账户'),Decimal(0))
                for category,formula in zip(['非赠款消耗','巨量千川充值'],TOTAL_FORMULAS.values()):
                    coord=qcells.get(category)
                    if not coord:fail('核对汇总!B:D',f'千川费用行缺失：{category}');continue
                    f=summary[coord].find('m:f',NS)
                    if f is None or '='+str(f.text)!=formula:fail(coord,'千川原模板公式丢失或改变')
                    equal(coord,qfees[category],expected.get(category))
                    result['values'][coord]=str(qfees[category]) if qfees[category] is not None else None
                accounts=[c for c in summary if re.fullmatch(r'L[0-9]+',c) and value(summary[c])=='千川账户']
                if len(accounts)!=1:fail('核对汇总!L:L','缺少唯一的千川账户汇总行')
                else:
                    rn=accounts[0][1:];coord='N'+rn
                    movement=unknown(summary,coord) if partial else number(summary,coord)
                    if partial:
                        for col in ['M','O','P']:unknown(summary,col+rn)
                    f=summary[coord].find('m:f',NS) if coord in summary else None
                    if f is None or f.text!=f'SUMIF(B:D,L{rn},D:D)':fail(coord,'千川发生额汇总公式变化')
                    if qfees and all(v is not None for v in qfees.values()):equal(coord,movement,sum(qfees.values(),Decimal(0)))
                    result['values'][coord]=str(movement) if movement is not None else None
                for coord in ['Q4','R4']:
                    c=q.get(coord)
                    if c is None or c.get('t','n')!='n' or value(c) is None:result['balance_issues'].append(f'千川账户!{coord}余额未知')
            for rn in range(2,7 if '千川账户' in sheets else 6):
                for col in ['M','O','P']:
                    c=summary.get(f'{col}{rn}')
                    if c is None or c.get('t','n')!='n' or value(c) is None:result['balance_issues'].append(f'核对汇总!{col}{rn}余额核对缺少依据')
            for check in context.get('balance_validation',[]):result['balance_issues'].append(check)
    except (OSError,ValueError,KeyError,zipfile.BadZipFile,ET.ParseError) as exc:
        fail('工作簿',str(exc))
    result['ready']=not errors
    result['complete']=not errors and not partial
    result['expense_status']='failed' if errors else 'partial' if partial else 'passed'
    return result


def require_valid_report(path,context,snapshot=None,*,log_path=None):
    result=validate_report(path,context,snapshot)
    if log_path:dump_json(Path(log_path),result)
    if not result['ready']:
        raise DataError('上传前费用校验失败：'+'；'.join(e['cell']+' '+e['reason'] for e in result['errors'][:10]))
    return result
