"""Read-only, per-shop finance access audit through existing ShopDesk sessions.

Visits official pages and opens/cancels export dialogs, never confirms report
creation or financial operations. Saves evidence without cookies or signed URLs.
"""
from __future__ import annotations
import argparse
from collections import Counter
from datetime import datetime
import json
from pathlib import Path
import re
import sys
import time
from urllib.parse import urlsplit
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'src'))
from douyin_settle_recon.shopdesk import ShopDesk,ShopDeskError
from douyin_settle_recon.collect import UI,_entities,_select_entity,_tax_control
from douyin_settle_recon.model import dump_json,safe_name

BASE='https://fxg.jinritemai.com'
PAGES=[('fund','资金账单','/ffa/fxg-bill/fund-detail-bill'),
       ('settlement','结算账单','/ffa/fxg-bill/settlement-detail-bill'),
       ('base_deposit','基础保证金','/ffa/content/shop_deposit'),
       ('experience_deposit','体验保证金','/ffa/content/shop_deposit'),
       ('steward','账户中心／管家账户','/ffa/fund-control/account-center'),
       ('tax','涉税信息报送数据','/ffa/fxg-bill/tax-bill'),
       ('history','历史报表','/ffa/fxg-bill/history-report')]
LABELS={k:label for k,label,_ in PAGES}
PERMISSION=['暂无访问权限','暂无权限访问','无访问权限','没有访问权限','没有权限访问','您没有权限','你没有权限','当前账号无权限','当前账号暂无权限','无权访问','权限不足','没有该页面权限','无此权限','暂无此功能权限','未开通该权限','请联系主账号开通','请联系主帐号开通','所属的岗位没有访问该页面的权限','权限点:「','权限点：「']
REALNAME=['需要实名认证后访问','你的账号未进行实名认证','您的账号未进行实名认证','请先完成实名认证后','请完成实名认证后访问']
RISK=['请完成安全验证','请先通过安全验证','请完成验证码验证','访问过于频繁','操作频繁，请稍后再试']

SNAP=r'''return {path:location.pathname,ready:document.readyState,text:document.body?.innerText||'',
buttons:[...document.querySelectorAll('button,[role=button]')].filter(visible).map(e=>({text:text(e),disabled:!!e.disabled||e.getAttribute('aria-disabled')==='true'})),
tabs:[...document.querySelectorAll('[role=tab]')].filter(visible).map(e=>({text:text(e),selected:e.getAttribute('aria-selected')})),
inputs:[...document.querySelectorAll('input')].filter(visible).map(e=>({placeholder:e.placeholder,value:e.value})),
rows:[...document.querySelectorAll('tbody tr')].filter(visible).length};'''


def blocked(s):
    text=s.get('text','')
    for status,words in [('real_name',REALNAME),('permission',PERMISSION),('verification',RISK)]:
        for word in words:
            if word in text:
                lines=text.splitlines();i=next((i for i,l in enumerate(lines) if word in l),0)
                return status,'；'.join(lines[max(0,i):i+3])[:350]
    if re.search(r'/(?:account/)?login(?:/|$)',s.get('path',''),re.I) or '登录已失效' in text or ('手机号登录' in text and '密码登录' in text):
        return 'login','登录失效／需要重新登录'
    return None


def ready(s,kind):
    t=s.get('text','')
    if kind=='fund':return '资金流水明细' in t and '动账金额' in t
    if kind=='settlement':return '结算时间' in t and '结算金额' in t
    if 'deposit' in kind:return '交易流水' in t and '导出明细' in t
    if kind=='steward':return ('管家账户' in t or '抖店钱包' in t) and ('详情' in t or '账户余额' in t)
    if kind=='tax':return '选择主体' in t and '按月度看' in t and '查询' in t
    if kind=='history':return '历史报表' in t and any(w in t[t.rfind('历史报表'):] for w in ['生成时间','生成中','报表类型','任务创建时间','报表生成时间','暂无数据','下载次数','下载','已失效'])
    return False


def wait_page(u,kind,path,timeout=22):
    deadline=time.monotonic()+timeout;last={}
    while time.monotonic()<deadline:
        last=u.js(SNAP)
        if last.get('path')!=path:
            if blocked(last) and blocked(last)[0]=='login':return last
            time.sleep(.35);continue
        if blocked(last) or ready(last,kind):return last
        time.sleep(.4)
    return last


def permission_responses(b,eid):
    """Inspect only finance API failures, never response business records."""
    events=b.command(eid,'events').get('events',[]);out=[]
    for e in events:
        if e.get('method')!='Network.responseReceived':continue
        path=urlsplit(e.get('url','')).path
        if not any(k in path for k in ['/bill_center/','/settlement/','/base_margin/','/deposit/','/fund/','/account/']):continue
        if e.get('status') in [401,403]:out.append({'path':path,'http_status':e['status']})
        if e.get('mimeType')=='application/json':
            try:
                response=json.loads(b.command(eid,'Network.getResponseBody',{'requestId':e['requestId']})['result']['body'])
                if not isinstance(response,dict):continue
                msg=str(response.get('msg') or response.get('message') or response.get('error_msg') or '')
                if any(word in msg for word in PERMISSION+REALNAME+RISK+['未登录','登录失效']):
                    out.append({'path':path,'code':response.get('code',response.get('st')),'message':msg[:350]})
            except (ShopDeskError,KeyError,ValueError):pass
    return out


def inspect(u,shop,kind,label,path,root):
    r={'role':kind,'page':label,'url':BASE+path,'checked_at':datetime.now().astimezone().isoformat(),'status':'unconfirmed'}
    u.bridge.command(u.eid,'events')
    u.bridge.command(u.eid,'Page.navigate',{'url':BASE+path})
    s=wait_page(u,kind,path)
    bad=blocked(s)
    if not bad and 'deposit' in kind:
        tab='基础保证金' if kind=='base_deposit' else '体验保证金'
        u.js("const e=[...document.querySelectorAll('[role=tab]')].find(e=>visible(e)&&text(e)===arg);if(!e)throw Error('Missing deposit tab');e.click();return true;",tab)
        u.wait(lambda:u.js("return [...document.querySelectorAll('[role=tab]')].some(e=>visible(e)&&text(e)===arg&&e.getAttribute('aria-selected')==='true');",tab),timeout=10)
        u.js("const e=[...document.querySelectorAll('button')].find(e=>visible(e)&&text(e).replace(/\\s/g,'')==='查询');if(e)e.click();return true;")
        u.wait(lambda:u.js("return /共\\s*\\d+\\s*条|暂无数据|无数据/.test(document.body.innerText);"),timeout=12)
        s=u.js(SNAP);bad=blocked(s)
    r['actual_path']=s.get('path');r['controls']=s.get('buttons',[]);r['tabs']=s.get('tabs',[])
    r['permission_points']=re.findall(r'权限点[:：]\s*「([^」]+)」',s.get('text',''))
    if bad:r['status'],r['reason']=bad
    elif not ready(s,kind):r['reason']='页面未呈现可验证的业务内容；不能据此判断缺权限'
    else:
        r['status']='accessible';r['reason']='页面可访问，已观察到业务内容及相关控件'
        if kind in ['fund','settlement']:
            u.click('月汇总');s=u.wait(lambda:(x if (x:=u.js(SNAP)).get('rows',0)>0 or '暂无数据' in x.get('text','') else None),timeout=15)
            r['monthly_summary']=True
            row=u.js("return [...document.querySelectorAll('tbody tr')].filter(visible).map(e=>[...e.querySelectorAll('td')].map(text)).find(r=>r[0]===arg)||null;",'2026-09')
            r['target_month_row']=row
            if row:
                action='生成报表' if kind=='fund' else '下载明细'
                u.js("const r=[...document.querySelectorAll('tbody tr')].find(e=>visible(e)&&[...e.querySelectorAll('td')].some(c=>text(c)===arg.month));if(r&&exact(arg.action,r).length){click(arg.action,r);return true;}return false;",{'month':'2026-09','action':action})
                limit=time.monotonic()+3
                while time.monotonic()<limit:
                    modal=u.js(SNAP);bad=blocked(modal)
                    if bad:r['status'],r['reason']=bad;s=modal;break
                    if '1分钟内只能生成一次' in modal.get('text',''):
                        r['export_dialog']='官方生成报表弹窗可打开；未确认生成，未验证下载执行权限'
                        u.js("if(exact('取消').length)click('取消');return true;");break
                    time.sleep(.25)
            else:r['note']='目标月没有可见行；未以此认定缺权限'
        if kind=='tax':
            entities=_entities(u,'tax');r['entities']=entities
            # Subject enumeration and querying are read-only. A report download
            # is not asserted merely from a visible download action.
            r['subject_checks']=[]
            for entity in entities:
                try:
                    _select_entity(u,entity,'tax');u.click('按月度看')
                    u.bridge.command(u.eid,'events');u.click('查询');requests={}
                    def query_done():
                        for e in u.bridge.command(u.eid,'events').get('events',[]):
                            if e.get('method')=='Network.requestWillBeSent' and '/bill_center/domestic/shop/query_item' in e.get('url',''):
                                requests[e['requestId']]=e.get('body') or {}
                        for rid,body in requests.items():
                            if body.get('query_type')!='TAX_BILL':continue
                            try:j=json.loads(u.bridge.command(u.eid,'Network.getResponseBody',{'requestId':rid})['result']['body'])
                            except (ShopDeskError,KeyError,ValueError):continue
                            return {'member_id':body.get('member_id'),'date_type':body.get('date_type'),'bill_date':body.get('bill_date'),'code':j.get('code'),'message':j.get('msg',j.get('message')),'total':j.get('total')}
                        state=u.js(SNAP);restriction=blocked(state)
                        return {'restriction':restriction} if restriction else False
                    receipt=u.wait(query_done,timeout=12)
                    item={'entity':entity,**receipt}
                    if receipt.get('restriction'):item.update(status=receipt['restriction'][0],reason=receipt['restriction'][1])
                    elif receipt.get('code') not in ['100000',0,'0']:
                        restriction=blocked({'text':str(receipt.get('message') or '')});item.update(status=restriction[0] if restriction else 'unconfirmed',reason=str(receipt.get('message')))
                    else:item.update(status='accessible',reason='该主体月度查询成功'+('，当前月无数据' if receipt.get('total')==0 else ''))
                    r['subject_checks'].append(item)
                except ShopDeskError as exc:r['subject_checks'].append({'entity':entity,'status':'unconfirmed','reason':str(exc)})
            s=u.js(SNAP);bad=blocked(s)
            if bad:r['status'],r['reason']=bad
            else:
                failed=[x for x in r['subject_checks'] if x['status']!='accessible']
                if failed:r.update(status=failed[0]['status'],reason='部分主体查询受阻：'+'；'.join(x['entity']['name']+'：'+x['reason'] for x in failed))
                else:r['monthly_query']='全部可见主体已切换月度并查询；报表创建／下载执行未验证'
        if kind=='steward':
            clicked=u.open_wallet()
            if clicked:
                deadline=time.monotonic()+15
                while time.monotonic()<deadline:
                    s=u.js(SNAP);bad=blocked(s)
                    if bad:r['status'],r['reason']=bad;break
                    if s.get('path','').endswith('/butler-account') and '充值记录' in s.get('text',''):
                        r['detail_path']=s.get('path');r['detail_verified']=True;r['wallet_state']='opened';break
                    if s.get('path','').endswith('/butler-account') and '开通抖店钱包' in s.get('text','') and '去开通' in s.get('text',''):
                        r.update(detail_path=s.get('path'),detail_verified=True,wallet_state='not_opened',reason='钱包页面可访问，该主体尚未开通钱包；未执行开通操作');break
                    time.sleep(.4)
                if not bad and not r.get('detail_verified'):r.update(status='unconfirmed',reason='账户中心可访问，管家详情未得到可验证内容')
            else:
                unopened=u.js(r'''const label=exact('抖店钱包')[0]||exact('管家账户')[0];let p=label;
for(let i=0;i<6&&p;i++,p=p.parentElement){const t=text(p);if(t.includes('账户余额')&&!/货款账户|保证金账户|提前收款/.test(t)&&exact('去开通',p).length)return true;}return false;''')
                if unopened:r.update(wallet_state='not_opened',reason='账户中心可访问，钱包明确显示“去开通”（尚未开通，非权限拦截）；未执行开通操作')
                else:r.update(status='unconfirmed',reason='账户中心可访问，未唯一定位管家账户详情入口')
    api=permission_responses(u.bridge,u.eid);r['api_restrictions']=api
    if r['status'] in ['accessible','unconfirmed'] and api:
        for entry in api:
            msg=entry.get('message','')
            status=blocked({'text':msg})
            if status:r['status'],r['reason']=status;break
        else:
            if any(e.get('http_status')==403 for e in api):r.update(status='permission',reason='财务业务接口返回HTTP 403，需管理员检查当前账号权限；具体权限项以后台为准')
    # Save only a short business-area excerpt. Do not save the transaction table.
    t=s.get('text','');r['page_excerpt']=(t[-2500:] if r['status']!='accessible' else t[:1500])
    if r['status']!='accessible':
        try:
            shot=u.capture(root,shop['name']+'-'+kind,'2026-09');r['screenshot']=str(Path(shot['path']).relative_to(root))
        except ShopDeskError as e:r['screenshot_error']=str(e)
    return r


def run(root,limit=None):
    root.mkdir(parents=True,exist_ok=True);b=ShopDesk();shops=b.shops()
    dump_json(root/'shops.json',{'checked_at':datetime.now().astimezone().isoformat(),'shops':shops,'scope_note':'当前shopdesk全部抖店；711范围需用户确认'})
    total=0
    for i,shop in enumerate(shops,1):
        target=root/'shops'/(shop['id']+'.json')
        previous=json.loads(target.read_text()) if target.exists() else {}
        valid=[p for p in previous.get('pages',[]) if p.get('status')!='unconfirmed' and (p.get('role')!='tax' or p.get('subject_checks') or p.get('status')!='accessible')]
        if previous.get('complete') and len(valid)==len(PAGES):continue
        if limit is not None and total>=limit:break
        report={'shop':shop,'started_at':datetime.now().astimezone().isoformat(),'pages':valid,'complete':False};eid=None
        try:
            eid=b.start(shop['id'],BASE+PAGES[0][2]);u=UI(b,eid)
            dump_json(root/'active-session.json',{'shop':shop,'exploration':{'id':eid}})
            b.ready(eid)
            for kind,label,path in PAGES:
                if any(p.get('role')==kind for p in report['pages']):continue
                try:r=inspect(u,shop,kind,label,path,root)
                except (ShopDeskError,KeyError,ValueError) as e:
                    if '后台探索已关闭或过期' in str(e):raise
                    r={'role':kind,'page':label,'url':BASE+path,'status':'unconfirmed','reason':str(e),'checked_at':datetime.now().astimezone().isoformat()}
                report['pages'].append(r);dump_json(target,report)
                print(json.dumps({'index':i,'total':len(shops),'shop':shop['name'],'page':label,'status':r['status'],'reason':r.get('reason')},ensure_ascii=False),flush=True)
            report['complete']=True
        except (ShopDeskError,ValueError) as e:
            report['error']=str(e)
            if 'needs_login:' in str(e):
                report['pages']=[{'role':kind,'page':label,'url':BASE+path,'status':'login','reason':'登录失效，需客户重新登录后再检查财务页面；未判断具体页面权限','checked_at':datetime.now().astimezone().isoformat()} for kind,label,path in PAGES]
                report['complete']=True
        finally:
            if eid:
                try:b.close(eid)
                except ShopDeskError:pass
            report['finished_at']=datetime.now().astimezone().isoformat();dump_json(target,report)
        total+=1
        if report.get('error') and not report.get('complete'):
            print(json.dumps({'stopped_for_bridge_error':report['error'],'shop':shop['name']},ensure_ascii=False),flush=True);break
    print(json.dumps({'output':str(root),'finished_shops':len(list((root/'shops').glob('*.json')))},ensure_ascii=False),flush=True)

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--output',type=Path,required=True);p.add_argument('--limit',type=int);a=p.parse_args();run(a.output.resolve(),a.limit)
