"""Business-sheet sync is separate from successful file archival."""


def sync_result(data,*,partial_accounts=()):
    sync=data.get('sync')
    if not isinstance(sync,dict):sync={}
    rows=sync.get('sheets') or []
    sheets={}
    for name in ['月度总账单汇总','费用汇总','数据校验','余额校验']:
        matches=[s for s in rows if isinstance(s,dict) and s.get('name')==name] if isinstance(rows,list) else []
        row=matches[0] if len(matches)==1 else {}
        sheets[name]={'state':row.get('state','unknown'),'error':row.get('error')}
    current=sync.get('is_current') is True
    expenses=current and sheets['费用汇总']['state']=='synced'
    checks=current and sheets['数据校验']['state']=='synced'
    return {'is_current':current,'state':sync.get('state','unknown'),'sheets':sheets,
            'partial_accounts':list(partial_accounts),'complete_fees_synced':expenses and not partial_accounts,
            'expenses_synced':expenses,'checks_synced':checks,'fees_and_checks_synced':expenses and checks}
