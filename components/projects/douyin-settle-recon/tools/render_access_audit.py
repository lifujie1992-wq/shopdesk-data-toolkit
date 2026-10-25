"""Produce a customer-ready workbook from saved per-shop access evidence."""
import argparse,csv,json
import math
from collections import Counter
from datetime import datetime
from pathlib import Path
import xlsxwriter
STATUS={'accessible':'可访问／查询','real_name':'账号实名认证受限','permission':'账号权限不足','login':'登录失效','verification':'安全验证／限流','unconfirmed':'待复核（非已确认权限问题）'}
IMPACT={'fund':'资金流水明细、资金月汇总、货款账户期初/期末余额及截图',
'settlement':'结算明细、结算后退款、结算金额及月汇总',
'base_deposit':'基础保证金交易流水、当前余额及截图',
'experience_deposit':'体验保证金交易流水、当前余额及截图',
'steward':'管家账户各主体交易流水、各主体当前余额及截图；管家账户月度核对不完整',
'tax':'涉税信息报送数据、各主体月度汇总与明细',
'history':'已生成报表的历史列表与下载入口；影响资金/结算/管家/涉税报表取回'}
ACTION={'real_name':'请当前登录账号的持有人在抖店完成账号实名认证。页面提示的是账号未实名，不等同于店铺经营主体未认证；完成后复查账户中心及管家账户权限。',
'permission':'请店铺主账号/管理员为当前登录子账号开通该财务页面的访问、查询、导出及报表下载权限。具体权限项名称以客户后台为准；或提供已有相应权限的账号登录。',
'login':'请客户在工作台重新登录该店铺；登录恢复后再复核页面认证及权限，不能从登录失效判断缺少哪项权限。',
'verification':'请客户完成页面安全验证；如为平台限流，待限制解除后复查。',
'unconfirmed':'需复核页面加载或主体切换；当前没有足够证据认定需要客户开权限。',
'accessible':'当前未观察到页面访问/查询拦截；不表示已验证报表生成和下载执行权限。'}


def render(root,out):
    listing=json.loads((root/'shops.json').read_text());reports=[]
    for shop in listing['shops']:
        p=root/'shops'/(shop['id']+'.json')
        reports.append(json.loads(p.read_text()) if p.exists() else {'shop':shop,'pages':[],'complete':False})
    count=len(reports)
    if not count or any(not r.get('complete') or len(r['pages'])!=7 for r in reports):
        raise SystemExit('Audit is still incomplete; do not create a customer-facing complete report yet')
    out.mkdir(parents=True,exist_ok=True);file=out/f'{count}店财务采集权限与实名认证排查表.xlsx'
    wb=xlsxwriter.Workbook(file,{'strings_to_formulas':False,'strings_to_urls':False})
    head=wb.add_format({'bold':True,'bg_color':'#DCE8F3','border':1,'text_wrap':True})
    cell=wb.add_format({'valign':'top','text_wrap':True});bad=wb.add_format({'bg_color':'#FCE4D6','valign':'top','text_wrap':True})
    ok=wb.add_format({'bg_color':'#E2F0D9','valign':'top','text_wrap':True});pending=wb.add_format({'bg_color':'#FFF2CC','valign':'top','text_wrap':True})
    title=wb.add_format({'bold':True,'font_size':15})
    counts=Counter(s for s in STATUS if any(p.get('status')==s for r in reports for p in r['pages']))
    category={s:[r['shop']['name'] for r in reports if any(p.get('status')==s for p in r['pages'])] for s in STATUS}
    observed_points={}
    for report in reports:
        for page in report['pages']:
            if page.get('permission_points'):observed_points.setdefault(page['role'],set()).update(page['permission_points'])
    # Both deposit tabs share the same verified parent page and access point.
    deposit_points=observed_points.get('base_deposit',set())|observed_points.get('experience_deposit',set())
    for role in ['base_deposit','experience_deposit']:
        if deposit_points:observed_points[role]=deposit_points
    def action_for(page):
        if page['status']=='permission':
            points=page.get('permission_points') or sorted(observed_points.get(page['role'],[]))
            specific=('；建议开通：'+'、'.join('「'+p+'」' for p in points)) if points else ''
            return '请主账号在【店铺-子账号管理-岗位管理】或【店铺-子账号管理-账号管理-修改权限】调整当前账号/岗位权限'+specific+'。具名权限点取自本次同类受限页面的明确提示。授权后还需复查实名认证，当前权限拦截不能证明账号已实名。'
        return ACTION.get(page['status'],'需复核')
    summary=wb.add_worksheet('客户处理说明');summary.set_column(0,0,26);summary.set_column(1,1,110)
    rows=[('检查范围',f'当前shopdesk工作台全部{count}个抖店登录记录'),('检查日期',datetime.now().astimezone().isoformat()),
          ('检查页面','资金账单、结算账单、基础保证金、体验保证金、账户中心及管家账户、涉税信息报送数据（逐主体查询）、历史报表'),
          ('检查方式','逐店复用现有登录态，实际访问页面、切换保证金类型、读取月汇总、枚举并查询涉税主体、观察生成报表弹窗。未确认生成报表，未逐店执行完整下载。'),
          ('分类依据','实名认证与权限问题以页面或财务接口的明确提示为依据；加载/切换失败单列待复核；当月无数据不认定为缺权限。'),
          ('统计口径','同一家店可能同时存在实名认证和权限问题，各类店铺数不能直接相加；逐店组合见“全部店铺”。'),
          ('认证说明','页面“你的账号未进行实名认证”针对当前登录账号，不能据此认定店铺经营主体没有实名。'),
          ('客户需要操作','按“需客户处理”表逐项完成认证、授权或重新登录；完成认证后，还需再次检查此前被拦截的管家详情、主体切换和报表生成下载。'),
          ('未验证的边界','无拦截仅说明本次页面与查询可用；报表生成/下载的最终执行权限及实名认证拦截后的深层权限仍需复验。')]
    rows += [(STATUS[s]+'店数',str(len(category[s]))) for s in ['real_name','permission','login','verification','unconfirmed']]
    for i,(k,v) in enumerate(rows):summary.write(i,0,k,head);summary.write(i,1,v,cell);summary.set_row(i,45 if i<9 else 25)
    grouped={}
    for report in reports:
        signature=tuple(sorted((page['status'],page['role'],page['page']) for page in report['pages'] if page['status']!='accessible'))
        grouped.setdefault(signature,[]).append(report['shop']['name'])
    groups_sheet=wb.add_worksheet('问题分组');groups_sheet.freeze_panes(1,1)
    groups_sheet.write_row(0,0,['店铺数','店铺名单','问题及受阻页面','影响的数据'],head)
    groups_sheet.set_column(0,0,10);groups_sheet.set_column(1,1,65);groups_sheet.set_column(2,3,70)
    for index,(signature,names) in enumerate(grouped.items(),1):
        description='；'.join(STATUS[status]+'：'+page for status,role,page in signature)
        effects='；'.join(dict.fromkeys(IMPACT[role] for status,role,page in signature))
        groups_sheet.write_row(index,0,[len(names),'、'.join(names),description,effects],cell)
        groups_sheet.set_row(index,160 if len(names)>10 else 120)
    all_headers=['序号','店铺','账号实名认证受限页面','明确缺权限页面','登录失效页面','安全验证/限流页面','待复核页面','影响的数据','建议客户处理','店铺UUID','检查完成时间']
    overview=wb.add_worksheet(f'全部{count}店');overview.freeze_panes(1,2)
    issue_headers=['序号','店铺','问题类型','受阻页面','页面/接口原始提示','影响的数据','客户操作','实际检查时间','证据截图','店铺UUID']
    issues=wb.add_worksheet('需客户处理');issues.freeze_panes(1,2)
    detail_headers=['店铺','检查页面','状态','实际提示/结果','影响的数据','访问地址','检查时间','备注','证据截图','店铺UUID']
    details=wb.add_worksheet('逐页核查');details.freeze_panes(1,2)
    subjects=wb.add_worksheet('涉税主体核查');subjects.freeze_panes(1,2)
    evidence=wb.add_worksheet('截图证据');evidence.set_column(0,0,45);evidence.set_column(1,1,90)
    evidence_rows={}
    sub_headers=['店铺','主体','主体ID','状态','查询月份','查询结果','官方返回码','返回提示']
    for sheet,headers in [(overview,all_headers),(issues,issue_headers),(details,detail_headers),(subjects,sub_headers)]:
        for j,h in enumerate(headers):sheet.write(0,j,h,head)
        sheet.set_row(0,30);sheet.set_column(0,len(headers)-1,24)
    overview.set_column(2,6,28);overview.set_column(7,8,70)
    issues.set_column(4,6,75);details.set_column(3,4,70);details.set_column(5,5,65);subjects.set_column(5,7,45)
    issue_rows=[];detail_rows=[];subject_rows=[];over_rows=[]
    for index,r in enumerate(reports,1):
        shop=r['shop'];pages=r['pages'];badpages=[p for p in pages if p.get('status')!='accessible'];affected=list(dict.fromkeys(IMPACT.get(p['role'],p['page']) for p in badpages));actions=list(dict.fromkeys(action_for(p) for p in badpages))
        groups={s:'、'.join(p['page'] for p in pages if p.get('status')==s) or '未发现' for s in ['real_name','permission','login','verification','unconfirmed']}
        row=[index,shop['name'],*[groups[s] for s in ['real_name','permission','login','verification','unconfirmed']],'；'.join(affected),'；'.join(actions) or '当前未发现明确认证、权限或登录拦截',shop['id'],r.get('finished_at','未完成')];over_rows.append(row)
        for p in pages:
            screenshot=str((root/p['screenshot']).resolve()) if p.get('screenshot') else ''
            if screenshot and Path(screenshot).is_file() and screenshot not in evidence_rows:
                start=len(evidence_rows)*36;evidence_rows[screenshot]=start
                evidence.write(start,0,shop['name'],title);evidence.write(start+1,0,p['page'],head)
                evidence.write(start+1,1,p.get('reason',''),cell)
                evidence.insert_image(start+3,0,screenshot,{'x_scale':.5,'y_scale':.5})
            note=p.get('export_dialog') or p.get('monthly_query') or p.get('note') or ''
            dr=[shop['name'],p['page'],STATUS[p['status']],p.get('reason',''),IMPACT.get(p['role'],''),p.get('url',''),p.get('checked_at',''),note,screenshot,shop['id']];detail_rows.append((dr,p['status']))
            if p['status']!='accessible':issue_rows.append([len(issue_rows)+1,shop['name'],STATUS[p['status']],p['page'],p.get('reason',''),IMPACT.get(p['role'],''),action_for(p),p.get('checked_at',''),screenshot,shop['id']])
            for sub in p.get('subject_checks',[]):subject_rows.append([shop['name'],sub['entity']['name'],str(sub.get('member_id') or sub['entity'].get('id') or ''),STATUS[sub['status']],','.join(sub.get('bill_date') or []),sub.get('reason',''),str(sub.get('code','')),str(sub.get('message',''))])
    for n,row in enumerate(over_rows,1):
        overview.write_row(n,0,row,cell)
        heights=[math.ceil(sum(2 if ord(c)>255 else 1 for c in str(row[k]))/70)*15+12 for k in [7,8]]
        overview.set_row(n,min(400,max(90,*heights)))
    for n,row in enumerate(issue_rows,1):
        issues.write_row(n,0,row,pending if '待复核' in row[2] else bad);issues.set_row(n,90)
        if row[8] in evidence_rows:issues.write_url(n,8,"internal:'截图证据'!A"+str(evidence_rows[row[8]]+1),string='查看截图')
    for n,(row,status) in enumerate(detail_rows,1):
        details.write_row(n,0,row,ok if status=='accessible' else pending if status=='unconfirmed' else bad);details.set_row(n,65)
        if row[8] in evidence_rows:details.write_url(n,8,"internal:'截图证据'!A"+str(evidence_rows[row[8]]+1),string='查看截图')
    for n,row in enumerate(subject_rows,1):subjects.write_row(n,0,row,ok if row[3]==STATUS['accessible'] else bad);subjects.set_row(n,40)
    for sheet,rows_,headers in [(overview,over_rows,all_headers),(issues,issue_rows,issue_headers),(details,detail_rows,detail_headers),(subjects,subject_rows,sub_headers)]:sheet.autofilter(0,0,len(rows_),len(headers)-1)
    wb.close()
    with (out/'需客户处理.csv').open('w',encoding='utf-8-sig',newline='') as f:
        w=csv.writer(f);w.writerow(issue_headers)
        for row in issue_rows:
            display=list(row)
            if display[8]:display[8]='见Excel内“截图证据”工作表'
            w.writerow(display)
    data={'checked_at':datetime.now().astimezone().isoformat(),'shop_count':len(reports),'page_count':len(detail_rows),'subject_count':len(subject_rows),'categories':category,'source':str(root.resolve()),'workbook':str(file.resolve()),'issues':issue_rows}
    (out/'排查汇总.json').write_text(json.dumps(data,ensure_ascii=False,indent=2))
    message=[f'{count}个店铺登录记录财务采集权限与实名认证排查结果',
             '检查日期：'+datetime.now().astimezone().strftime('%Y-%m-%d'),
             f'共检查{count}个店铺登录记录、{len(detail_rows)}个页面检查项、{len(subject_rows)}个涉税主体查询项。',
             f'明确提示账号未实名认证：{len(category["real_name"])}家；明确提示账号/岗位权限不足：{len(category["permission"])}家。分类可重叠。',
             f'登录失效：{len(category["login"])}家；待复核：{len(category["unconfirmed"])}家。','']
    for index,(signature,names) in enumerate(grouped.items(),1):
        message += [f'{index}、店铺名单（{len(names)}家）：'+'、'.join(names),
                    '问题：'+'；'.join(STATUS[status]+'——'+page for status,role,page in signature),
                    '影响：'+'；'.join(dict.fromkeys(IMPACT[role] for status,role,page in signature)),'']
    message += ['请客户处理：','1. 实名认证问题：由当前登录账号持有人在“资金→账户中心→立即认证”完成账号实名认证。页面提示针对登录账号，不能据此认定店铺经营主体未认证。',
                '2. 权限问题：请主账号通过“店铺→子账号管理→岗位管理”，或“店铺→子账号管理→账号管理→修改权限”，调整对应账号/岗位的权限。',
                '本次实际观察到的权限点：'+'；'.join(sorted(set().union(*observed_points.values())))+'。按各店受阻页面开通相应项。',
                '3. 同时存在两类问题的店铺需要分别处理；权限拦截后的实名认证情况，以及实名拦截后的深层权限，需要解除当前限制后再复核。','',
                '检查边界：本次验证页面访问、月度查询、主体切换和导出入口，未逐店实际生成并下载完整报表；页面可访问不能等同于最终导出/下载执行权限已通过。',
                '逐店明细、页面原话与截图证据均在同目录Excel内。']
    (out/'给客户的处理说明.txt').write_text('\n'.join(message),encoding='utf-8')
    print(json.dumps({k:v for k,v in data.items() if k not in ['issues']},ensure_ascii=False,indent=2))
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--source',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args();render(a.source.resolve(),a.output.resolve())
