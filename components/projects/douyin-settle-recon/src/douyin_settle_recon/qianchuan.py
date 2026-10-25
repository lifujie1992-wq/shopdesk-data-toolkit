"""Validate official daily statements and keep template accounting semantics."""
from datetime import timedelta
from decimal import Decimal

from .model import Column, DataError, Row, Table, decimal, month_bounds, parse_time

COLUMNS = ['日期','余额总消耗(元)','非赠款消耗(元)','赠款消耗(元)',
           '消返红包消耗(元)','立减红包消耗(元)','共享钱包消耗(元)','共享赠款消耗(元)',
           '总存入(元)','总转入(元)','总转出(元)','总余额(元)','赠款余额(元)','非赠款余额(元)']
TOTAL_FORMULAS = {
    'D44': '=-INDEX(千川账户!C:C,MATCH("总计",千川账户!A:A,0))',
    'D45': '=IFERROR(INDEX(千川账户!I:I,MATCH("总计",千川账户!A:A,0))-INDEX(千川账户!D:D,MATCH("总计",千川账户!A:A,0)),"")',
}


def statement(tables, month, *, verified_counts=None):
    """Return actual statement dates; reject ambiguous totals and wrong periods.

    Keep source ordering, including 总计. Q4/R4 are selected by calendar date,
    independently of the platform's ascending/descending display preference.
    """
    tables=list(tables)
    if not tables:raise DataError('千川账户缺少日结报表')
    if len(tables)>1:
        accounts=[t.rows[0].source.get('entity_id') if t.rows else None for t in tables]
        if not all(accounts) or len(set(accounts))!=len(accounts):raise DataError('千川多份报表必须来自不同且明确标识的广告账户')
        views=[];results=[];daily={};coverage={};total=dict.fromkeys(COLUMNS[1:11],Decimal(0))
        for table in tables:
            view,result=statement([table],month,verified_counts=verified_counts);views.append(view);results.append(result)
            for row in view.rows:
                if row.values['日期']=='总计':
                    for key in total:total[key]+=row.values[key]
                else:
                    day=row.values['日期'];values=daily.setdefault(day,dict.fromkeys(COLUMNS[1:],Decimal(0)))
                    coverage[day]=coverage.get(day,0)+1
                    for key in values:
                        incoming=row.values[key]
                        values[key]=None if values[key] is None or incoming is None else values[key]+incoming
        for day in daily:
            if coverage[day]!=len(tables):
                for key in COLUMNS[11:]:daily[day][key]='-'
        source={'kind':'qianchuan_aggregate','accounts':accounts}
        records=[Row({'日期':'总计',**total,**dict.fromkeys(COLUMNS[11:],'-')},source)]
        records.extend(Row({'日期':day,**daily[day]},{**source,'date':day}) for day in sorted(daily,reverse=True))
        combined=Table('qianchuan_monthly','千川账户',views[0].columns,records,role='qianchuan_monthly')
        result={key:sum((r[key] for r in results),Decimal(0)) for key in ['consumption','recharge']}
        result.update({key:sum((r[key] for r in results),Decimal(0)) if all(r[key] is not None for r in results) else None
                       for key in ['grant','cash']})
        result.update(date=results[0]['date'],source={'accounts':[r['source'] for r in results]},accounts=accounts,
                      data_status='no_activity' if all(r.get('data_status')=='no_activity' for r in results) else 'data')
        return combined,result
    table=tables[0]
    if [c.key for c in table.columns]!=COLUMNS:raise DataError('千川账户日结报表列与模板不一致')
    start,end=month_bounds(month);last=(end-timedelta(days=1)).date()
    records=[];totals=[];daily={}
    for row in table.rows:
        raw=row.values;label=raw.get('日期')
        if label is None or str(label).strip()=='':
            if all(v is None or v=='' or v==0 for v in raw.values()):continue
            raise DataError('千川账户存在缺少日期的数据行')
        total=isinstance(label,str) and label.strip()=='总计'
        if not total:
            day=parse_time(label)
            if day.tzinfo is not None or not start<=day<end:
                raise DataError('千川账户日结报表包含目标月份之外的日期')
            day=day.date()
            if day in daily:raise DataError('千川账户日结报表日期重复')
        values={'日期':'总计' if total else day.isoformat()}
        for key in COLUMNS[1:]:
            value=raw.get(key)
            if key in COLUMNS[11:] and (value is None or str(value).strip() in ['', '-']):
                values[key]='-' if total else None
            else:values[key]=decimal(value,blank_zero=False)
        typed=Row(values,row.source,row.row_id);records.append(typed)
        if total and label!='总计':raise DataError('千川总计标签必须精确为“总计”')
        if total:totals.append(values)
        else:daily[day]=values
    account=table.rows[0].source.get('entity_id') if table.rows else None
    expected=(verified_counts or {}).get(account)
    if expected is not None and (type(expected) is not int or expected<0 or len(daily)!=expected):
        raise DataError('千川下载明细条数与官方同月查询记录数不一致')
    if not records and expected!=0:
        raise DataError('千川报表只有表头或零行，缺少平台确认当月无发生的依据')
    if records and not daily and expected!=0:
        raise DataError('千川报表只有总计，缺少平台确认当月无发生的依据')
    if not totals and daily and expected==len(daily):
        values={'日期':'总计',**{k:sum((v[k] for v in daily.values()),Decimal(0)) for k in COLUMNS[1:11]},**dict.fromkeys(COLUMNS[11:],'-')}
        records.insert(0,Row(values,{'kind':'verified_detail_total','entity_id':account,'verified_count':expected}))
        totals.append(values)
    if not records:
        values={'日期':'总计',**dict.fromkeys(COLUMNS[1:11],Decimal(0)),**dict.fromkeys(COLUMNS[11:],'-')}
        records.append(Row(values,{'kind':'empty_official_statement'}));totals.append(values)
    if len(totals)!=1:raise DataError('千川账户日结报表缺少唯一的总计行')
    # The official export can omit inactive days, including the calendar month
    # end. Validate amounts against the returned rows rather than a day count.
    for key in COLUMNS[1:11]:
        if sum((v[key] for v in daily.values()),Decimal(0))!=totals[0][key]:
            raise DataError(f'千川账户总计与每日明细不符：{key}')
    result=Table('qianchuan_monthly','千川账户',
                 [Column(k,k,'string' if k=='日期' else 'decimal') for k in COLUMNS],records,role='qianchuan_monthly')
    closing=daily.get(last)
    return result,{'consumption':-totals[0]['非赠款消耗(元)'],
                   'recharge':totals[0]['总存入(元)']-totals[0]['赠款消耗(元)'],
                   'grant':closing['赠款余额(元)'] if closing else None,'cash':closing['非赠款余额(元)'] if closing else None,
                   'date':last.isoformat(),'source':next((r.source for r in records if r.values['日期']==last.isoformat()),{}),
                   'latest_record_date':max(daily).isoformat() if daily else None,
                   'data_status':'data' if daily else 'no_activity'}


def query_count(receipt, month):
    """Accept only the successful official query for this account and full month."""
    query=receipt.get('query',{});params=query.get('params',{})
    start,end=month_bounds(month)
    account=receipt.get('advertiser_id') or receipt.get('entity',{}).get('id')
    if (query.get('code')!=1 or type(query.get('total')) is not int or query['total']<0
        or not account or params.get('aadvid')!=[account]
        or params.get('start_day')!=[start.strftime('%Y-%m-%d')]
        or params.get('end_day')!=[(end-timedelta(days=1)).strftime('%Y-%m-%d')]):
        raise DataError('千川缺少同账户、完整月份的成功查询依据')
    return query['total']


def prepare(dataset, required):
    from .collection_status import qianchuan_denied
    tables=dataset.table('qianchuan')
    if not required and not tables:return None
    receipts=[r for r in dataset.context.get('collection',[]) if r.get('role')=='qianchuan']
    month=dataset.context['month']
    log={'shop_id':dataset.context.get('platform_shop_id'),'month':month,'status':'failed',
         'row_count':sum(sum(str(r.values.get('日期','')).strip()!='总计' for r in t.rows) for t in tables),
         'reason':''}
    dataset.context['qianchuan_result']=log
    try:
        if any(qianchuan_denied(r) for r in receipts):
            dataset.context['qianchuan_access']='permission_denied'
            raise DataError('千川无访问权限，金额未知；其他有效来源可先上传，千川等待补采')
        if any(r.get('status') not in ['downloaded','no_activity','not_opened'] for r in receipts):
            raise DataError('千川存在获取失败的账户，需重试；具体原因见采集清单')
        expected_accounts=set(dataset.context.get('qianchuan_expected_accounts',[]))
        if expected_accounts and expected_accounts!={r.get('advertiser_id') or r.get('entity',{}).get('id') for r in receipts}:
            raise DataError('千川绑定账户未全部取得查询结果')
        counts={};empty=[]
        for r in receipts:
            if r['status']=='not_opened':
                evidence=r.get('evidence',{})
                if '/account/register' not in evidence.get('url','') or '立即免费开户' not in evidence.get('text',''):
                    raise DataError('千川未开通状态缺少官方页面依据，无法确认空数据')
                empty.append(r);continue
            count=query_count(r,month)
            if r['status']=='no_activity':
                if count!=0:raise DataError('千川空数据状态与平台查询条数不一致')
                empty.append(r)
            elif count==0:raise DataError('千川下载状态与平台空查询冲突')
            else:counts[r.get('advertiser_id') or r['entity']['id']]=count
        if receipts and not counts and empty:
            empty_accounts={r.get('advertiser_id') or r.get('entity',{}).get('id') for r in empty if r['status']=='no_activity'}
            for t in tables:
                account=t.rows[0].source.get('entity_id') if t.rows else None
                if t.rows and account not in empty_accounts:raise DataError('千川零发生报表与成功空查询账户不一致')
                statement([t],month,verified_counts={account:0})
            tables=[]
        if receipts:
            ids=[t.rows[0].source.get('entity_id') if t.rows else None for t in tables]
            if set(ids)!=set(counts) or len(ids)!=len(counts):
                raise DataError('千川下载报表与成功查询的账户未完整对应')
        if not tables and empty:
            source={'kind':'official_empty_query','receipts':empty}
            table=Table.from_records('qianchuan_monthly','千川账户',
                [{'日期':'总计',**dict.fromkeys(COLUMNS[1:11],Decimal(0)),**dict.fromkeys(COLUMNS[11:],'-')}],
                role='qianchuan_monthly',fields=COLUMNS)
            result={'consumption':Decimal(0),'recharge':Decimal(0),'grant':None,'cash':None,
                'date':(month_bounds(month)[1]-timedelta(days=1)).date().isoformat(),
                'source':source,'data_status':'no_activity'}
        else:
            table,result=statement(tables,month,verified_counts=counts)
        dataset.tables.append(table)
        if empty:result['grant']=result['cash']=None
        if result.get('data_status')!='no_activity' and not any('千川' in (i.get('excel_sheet') or i.get('target_sheet') or i.get('sheet') or '') for i in dataset.context.get('images',[])):
            dataset.issue('qianchuan_screenshot_missing','千川账户缺少日结报表明细页面截图',account='千川账户')
        dataset.context['qianchuan']=result
        log.update(status='success_empty' if result['data_status']=='no_activity' else 'success_data',
                   row_count=sum(r.values['日期']!='总计' for r in table.rows),reason='官方查询确认无发生' if empty and not tables else '有效日结报表校验通过')
        return result
    except DataError as exc:
        log['reason']=str(exc)
        dataset.issue('qianchuan_permission_denied' if dataset.context.get('qianchuan_access') else 'qianchuan_statement_invalid',str(exc),account='千川账户')
        return None
