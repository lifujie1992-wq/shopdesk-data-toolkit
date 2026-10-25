"""Bounded UI-driven collection in ShopDesk's existing isolated shop session.

Official controls create the exports. Files are captured by the additive ShopDesk
extension and copied locally. No cookies, signed download links or browser tokens
are exported to the Python process.
"""
from __future__ import annotations

from datetime import datetime, timezone, timedelta
from decimal import Decimal
import fcntl
import json
from pathlib import Path
import re
import shutil
import time
import uuid

from .model import DataError, decimal, dump_json, month_bounds, safe_name, sha256
from .pipeline import build
from .shopdesk import ShopDesk, ShopDeskError
from .identity import read_shop_identity, validate_identity
from .collection_status import collection_error, qianchuan_denied

URL='https://fxg.jinritemai.com/ffa/fxg-bill/fund-detail-bill'
KINDS={'fund':('资金账单','货款账户'),'settlement':('结算账单',None),
       'base_deposit':('基础保证金','基础保证金账户'),
       'experience_deposit':('体验保证金','体验保证金账户'),
       'steward':('管家账户','管家账户'),'tax':('涉税信息报送数据',None),
       'qianchuan':('千川账户','千川账户')}

JS_HELPERS=r'''
const visible=e=>e.getClientRects().length>0 && getComputedStyle(e).visibility!=='hidden';
const text=e=>(e.innerText||e.textContent||'').trim();
const exact=(value,root=document)=>[...root.querySelectorAll('button,a,[role="tab"],span,div')]
 .filter(e=>visible(e)&&text(e)===value).sort((a,b)=>a.querySelectorAll('*').length-b.querySelectorAll('*').length);
const click=(value,root=document)=>{const e=exact(value,root)[0];if(!e)throw Error('Missing visible control: '+value);e.click();return true;};
'''


class UI:
    def __init__(self,bridge,eid):self.bridge=bridge;self.eid=eid
    def js(self,body,arg=None):
        return self.bridge.evaluate(self.eid,'(()=>{'+JS_HELPERS+'const arg='+json.dumps(arg,ensure_ascii=False)+';'+body+'})()')
    def click(self,label):return self.js('return click(arg);',label)
    def open_wallet(self):
        # The official card uses nested button/span labels and opens a new tab.
        # Keep that observed official URL in this task's isolated page instead.
        return self.js(r'''const label=exact('管家账户')[0]||exact('抖店钱包')[0];if(!label)return false;
const original=window.open;window.open=function(url,...rest){const u=new URL(url,location.href);
if(u.origin===location.origin&&u.pathname==='/ffa/fund-control/butler-account'){location.assign(u.href);return null;}
return original.call(this,url,...rest);};
let p=label;for(let i=0;i<6&&p;i++,p=p.parentElement){for(const name of ['详情','查看详情']){
const matches=exact(name,p),leaves=matches.filter(e=>!matches.some(n=>n!==e&&e.contains(n)));
if(leaves.length===1){leaves[0].click();return true;}}}window.open=original;return false;''')
    def snapshot(self):
        return self.js('return {url:location.href,text:(document.body?.innerText||"").slice(-14000),inputs:[...document.querySelectorAll("input")].filter(visible).map(e=>({placeholder:e.placeholder,value:e.value}))};')
    def wait(self,fn,timeout=35):
        end=time.monotonic()+timeout
        while time.monotonic()<end:
            result=fn()
            if result:return result
            time.sleep(.5)
        raise ShopDeskError('finance UI condition did not become ready')
    def capture(self,root,label,month,*,width=1920,height=1080):
        data=self.bridge.command(self.eid,'finance_capture',{'width':width,'height':height})
        target=root/'screenshots'/(safe_name(label)+'-'+uuid.uuid4().hex[:8]+'.png');target.parent.mkdir(parents=True,exist_ok=True)
        shutil.copy2(data['path'],target)
        return {'path':str(target),'sheet':label,'captured_at':data['captured_at'],'balance_as_of':None,
                'requested_month':month,'note':'Live ShopDesk screenshot; current balance is not assumed to be historical month-end.'}
    def rows(self):
        return self.js('return [...document.querySelectorAll("tbody tr")].filter(visible).map(e=>[...e.querySelectorAll("td")].map(text)).filter(r=>r.length);')
    def month_row(self,month):
        return self.js('const r=[...document.querySelectorAll("tbody tr")].filter(visible).filter(e=>[...e.querySelectorAll("td")].some(c=>text(c)===arg));return r.length?r.map(e=>[...e.querySelectorAll("td")].map(text))[0]:null;',month)
    def month_summary(self):
        return self.js(r'''const rows=[...document.querySelectorAll('tbody tr')].filter(visible)
 .map(e=>[...e.querySelectorAll('td')].map(text)).filter(r=>r.some(c=>/^\d{4}-\d{2}$/.test(c)));
const content=document.body?.innerText||'';
if(/暂无权限|无访问权限|权限不足|没有访问该页面的权限|登录已失效|请先完成实名认证|请完成安全验证/.test(content))throw Error('Official monthly page is restricted: '+content.slice(-1200));
const totals=[...content.matchAll(/共\s*([\d,]+)\s*条/g)];
const next=[...document.querySelectorAll('[aria-label="下一页"],[title="下一页"],li[class*="pagination-next"],button[class*="pagination-next"]')].find(visible);
const disabled=e=>e.disabled||e.getAttribute('aria-disabled')==='true'||/disabled/.test(e.className||'');
return {rows,total:totals.length?Number(totals.at(-1)[1].replaceAll(',','')):null,
 loading:[...document.querySelectorAll('[aria-busy="true"],[class*="spin-spinning"],[class*="loading-mask"]')].some(visible),
 empty:[...document.querySelectorAll('tbody')].some(visible)&&/暂无数据|无数据/.test(content),
 next:!!next&&!disabled(next)};''')
    def next_month_page(self):
        return self.js(r'''const e=[...document.querySelectorAll('[aria-label="下一页"],[title="下一页"],li[class*="pagination-next"],button[class*="pagination-next"]')].find(visible);
if(!e||e.disabled||e.getAttribute('aria-disabled')==='true'||/disabled/.test(e.className||''))throw Error('Monthly pagination control is unavailable');e.click();return true;''')
    def select_month(self,month):
        start,end=month_bounds(month)
        # Official input onChange handlers must see the native value setter. Verify after query.
        self.js(r'''const inputs=[...document.querySelectorAll('input')].filter(visible).filter(e=>/开始|结束/.test(e.placeholder));
if(inputs.length<2)throw Error('No verified date range controls');
const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
for(let i=0;i<2;i++){const e=inputs[i];setter.call(e,arg[i]);e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true}));e.dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',code:'Enter',bubbles:true}));}return true;''',[start.strftime('%Y-%m-%d 00:00:00'),(end-timedelta(seconds=1)).strftime('%Y-%m-%d %H:%M:%S')])
        self.bridge.command(self.eid,'events')
        self.click('查询')
        def verified_query():
            events=self.bridge.command(self.eid,'events').get('events',[])
            for event in events:
                if event.get('method')!='Network.requestWillBeSent':continue
                body=event.get('body')
                if isinstance(body,dict):
                    st=body.get('start_time',body.get('startTime',body.get('begin_time')))
                    en=body.get('end_time',body.get('endTime'))
                    if st is not None and en is not None:
                        expected_start=start.strftime('%Y-%m-%d')
                        expected_end=(end-timedelta(seconds=1)).strftime('%Y-%m-%d')
                        if str(st).startswith(expected_start) and str(en).startswith(expected_end):return True
                        raise ShopDeskError('date control did not update the official query; refusing a wrong-period export')
            return False
        self.wait(verified_query,timeout=15)
    def request(self,path,body=None):
        # Only same-origin verified finance routes are used by this collector.
        return self.bridge.evaluate(self.eid,'(async()=>{const c=new AbortController(),t=setTimeout(()=>c.abort(),6500);try{'+
            'const r=await fetch('+json.dumps(path)+',{credentials:"include",signal:c.signal'+
            (',method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify('+json.dumps(body,ensure_ascii=False)+')' if body is not None else '')+
            '});const j=await r.json();if(!r.ok)throw Error("Official finance HTTP "+r.status);'+
            'const clean=x=>Array.isArray(x)?x.map(clean):x&&typeof x==="object"?Object.fromEntries(Object.entries(x).filter(([k])=>!/url|link|token|sign|cookie|password/i.test(k)).map(([k,v])=>[k,clean(v)])):x;return clean(j);'+
            '}finally{clearTimeout(t)}})()')

    def download(self,root,trigger,timeout=120):
        self.bridge.command(self.eid,'finance_arm_download')
        try:
            trigger()
            end=time.monotonic()+timeout
            while time.monotonic()<end:
                items=self.bridge.command(self.eid,'finance_downloads').get('items',[])
                if any(i['state'] in ['cancelled','interrupted'] for i in items):
                    raise ShopDeskError('official download was interrupted')
                if items and all(i['state']=='completed' for i in items):
                    files=[]
                    for item in items:
                        source=Path(item['path'])
                        if not source.is_file() or source.stat().st_size==0:raise ShopDeskError('empty downloaded file')
                        target=root/'downloads'/safe_name(item['name']);target.parent.mkdir(parents=True,exist_ok=True)
                        if target.exists() and sha256(target)!=sha256(source):
                            target=target.with_name(source.stem[:12]+'-'+target.name)
                        shutil.copy2(source,target);files.append(target)
                    return files
                time.sleep(.8)
            raise ShopDeskError('no completed official download within timeout')
        finally:self.bridge.command(self.eid,'finance_finish_download')


def _period_matches(report,month):
    start,end=month_bounds(month)
    if report.get('start_time') and report.get('end_time'):
        return report['start_time']==start.strftime('%Y-%m-%d %H:%M:%S') and report['end_time']==(end-timedelta(seconds=1)).strftime('%Y-%m-%d %H:%M:%S')
    return report.get('date_type')=='MONTH' and report.get('bill_date') in [month,month.replace('-','')]


def _reports(ui,page=0):
    result=ui.request(f'/settlement/settlement/downloadItemList?page={page}&size=20')
    if result.get('code') not in [0,'0']:raise ShopDeskError('official historical report list failed')
    return result.get('data',[])


def _report_ready(ui,ticket,month,manifest,timeout=120):
    def ready():
        reports=_reports(ui)
        found=[r for r in reports if r.get('download_id')==ticket]
        if not found:return False
        r=found[0]
        if not _period_matches(r,month):raise ShopDeskError('official report has a different accounting period')
        incoming=str(r.get('shop_id') or '')
        known=manifest['shop'].get('platform_shop_id')
        if known and str(known)!=incoming:raise ShopDeskError('official report belongs to a different platform shop')
        if incoming:manifest['shop']['platform_shop_id']=incoming
        if r.get('status') in ['FAILED','INVALID']:raise ShopDeskError('official report failed or expired')
        return r if r.get('status')=='SUCCESS' else False
    return ui.wait(ready,timeout=timeout)


def _generate_month_report(ui,kind,month):
    # The official dialog permits one generation per minute. Respect it across
    # subjects and previous collection attempts, rather than losing a subject
    # to an ignored/limited generation click.
    created=[r.get('create_time') for r in _reports(ui) if r.get('create_time')]
    if created:
        try:
            latest=datetime.strptime(max(created),'%Y-%m-%d %H:%M:%S').replace(tzinfo=timezone(timedelta(hours=8)))
            remaining=61-(datetime.now(timezone.utc)-latest).total_seconds()
        except ValueError:remaining=0
        if 0<remaining<=61:
            deadline=time.monotonic()+remaining
            while time.monotonic()<deadline:time.sleep(min(.5,max(0,deadline-time.monotonic())))
    ui.bridge.command(ui.eid,'events')
    ui.js(r'''const rows=[...document.querySelectorAll('tbody tr')].filter(visible).filter(e=>[...e.querySelectorAll('td')].some(c=>text(c)===arg));
const r=rows.find(e=>exact('生成报表',e).length||exact('下载明细',e).length);if(!r)throw Error('No export action for requested month');
for(const label of ['生成报表','下载明细'])if(exact(label,r).length){click(label,r);return true;}''',month)
    def confirm_or_started():
        return ui.js(r'''if(document.body.innerText.includes('1分钟内只能生成一次')){
if(exact('生成').length){click('生成');return true;}}
for(const d of [...document.querySelectorAll('[role="dialog"],[role="alertdialog"],[class*="modal-content"],[class*="ModalContent"]')].filter(visible)){
for(const label of ['生成','生成报表','下载明细','确定'])if(exact(label,d).length){click(label,d);return true;}}
return location.pathname.includes('history-report');''')
    ui.wait(confirm_or_started,timeout=12)
    requests={}
    def receipt():
        for event in ui.bridge.command(ui.eid,'events').get('events',[]):
            if event.get('method')=='Network.requestWillBeSent' and '/download_item' in event.get('url',''):
                requests[event['requestId']]=event.get('body') or {}
        for rid,payload in requests.items():
            try:
                data=ui.bridge.command(ui.eid,'Network.getResponseBody',{'requestId':rid})['result']
                response=json.loads(data['body'])
            except (ShopDeskError,KeyError,ValueError):continue
            if response.get('download_id'):
                return {'download_id':response['download_id'],'request':payload}
            if response.get('msg') not in ['success','',None]:raise ShopDeskError('official report generation: '+str(response['msg']))
        return False
    return ui.wait(receipt,timeout=25)


def _month_summary_result(ui,month):
    """Confirm absence from the complete official list, including pagination."""
    seen={};previous=None;expected_total=None
    for _ in range(120):
        def ready():
            state=ui.month_summary()
            signature=json.dumps(state.get('rows',[]),ensure_ascii=False)
            if state.get('loading') or signature==previous:return False
            if state.get('rows') or state.get('empty') and state.get('total')==0:return state
            return False
        state=ui.wait(ready)
        for row in state['rows']:
            dates=[c for c in row if re.fullmatch(r'\d{4}-\d{2}',c)]
            if len(dates)!=1:raise ShopDeskError('ambiguous monthly statement date')
            if dates[0]==month:return {'row':row,'month':month}
            seen[dates[0]]=row
        total=state.get('total')
        if type(total) is not int or total<0:raise ShopDeskError('monthly statement total is not confirmed')
        if expected_total is not None and expected_total!=total:raise ShopDeskError('monthly statement list changed during pagination')
        expected_total=total
        if len(seen)==total:
            return {'row':None,'month':month,'visible_months':sorted(seen),'total':total,'complete_list':True}
        if len(seen)>total or not state.get('next'):raise ShopDeskError('monthly statement list is incomplete')
        previous=json.dumps(state['rows'],ensure_ascii=False)
        ui.next_month_page()
    raise ShopDeskError('monthly statement pagination exceeded limit')


def _ledger_rows(ui):
    """A one-cell empty-state row is UI decoration, not a transaction."""
    return [r for r in ui.rows() if any(str(v).strip() for v in r)
            and not (len([v for v in r if str(v).strip()])==1 and
                     next(str(v).strip() for v in r if str(v).strip()) in ['暂无数据','暂无记录','无数据'])]


def _monthly(ui,kind,month,root,manifest):
    label,account=KINDS[kind]
    target=URL if kind=='fund' else 'https://fxg.jinritemai.com/ffa/fxg-bill/settlement-detail-bill'
    if target.split('.com',1)[1] not in ui.snapshot()['url']:
        ui.bridge.command(ui.eid,'Page.navigate',{'url':target});ui.bridge.ready(ui.eid)
    marker='资金流水明细' if kind=='fund' else '结算明细'
    ui.wait(lambda:marker in ui.snapshot()['text'])
    ui.click('月汇总');summary=_month_summary_result(ui,month);row=summary['row']
    manifest['screenshots'].append(ui.capture(root,label+'月汇总',month))
    if row is None:
        manifest['collection'].append({'role':kind,'status':'no_activity','reason':'target_month_absent',
                                       'query':summary,'evidence':ui.snapshot()})
        return
    if kind=='fund':
        if len(row)<7:raise ShopDeskError('monthly funding columns changed')
        def money(s):return str(decimal(re.sub(r'[¥￥,\s]','',s)))
        count=int(row[1].replace(',',''))
        manifest['balances'].append({'account':'货款账户','period':month,'kind':'monthly',
            'opening':money(row[5]),'closing':money(row[6]),'movement':money(row[4]),'expected_count':count,
            'source':{'type':'official_monthly_ui','shopdesk_shop_uuid':manifest['shop']['shopdesk_shop_uuid'],'row':row}})
        if count==0:
            manifest['collection'].append({'role':kind,'status':'no_activity','evidence':row});return
    else:
        if len(row)<6:raise ShopDeskError('monthly settlement columns changed')
        if int(row[2].replace(',',''))==0 and int(row[4].replace(',',''))==0:
            manifest['collection'].append({'role':kind,'status':'no_activity','evidence':row});return
    ticket=None
    # Reuse only exact-period, exact-type, all-account tasks. Never an arbitrary latest card.
    expected_type={'fund':'CHARGE_BILL_ITEM','settlement':'SHOP_SETTLE_ORDERS'}[kind]
    candidates=[r for r in _reports(ui) if r.get('download_type')==expected_type and _period_matches(r,month)
                and r.get('status') in ['SUCCESS','PROCESSING'] and not r.get('account_type')]
    if candidates:ticket=max(candidates,key=lambda r:r.get('create_time',''))['download_id']
    if not ticket:ticket=_generate_month_report(ui,kind,month)['download_id']
    report=_report_ready(ui,ticket,month,manifest)
    if report.get('download_type')!=expected_type:raise ShopDeskError('official report has a different bill type')
    paths=ui.download(root,lambda:ui.bridge.command(ui.eid,'finance_download_report',{'download_id':ticket}))
    for path in paths:manifest['inputs'].append({'path':str(path),'sha256':sha256(path),'role':kind,'account':account,'platform_report_id':ticket})
    manifest['collection'].append({'role':kind,'status':'downloaded','month_row':row,'platform_report':report})


def _entities(ui,kind):
    if kind=='tax':
        _tax_control(ui,'选择主体')
        ui.wait(lambda:ui.js("return [...document.querySelectorAll('.aurora-select-item-option[title]')].some(visible);"),timeout=12)
        options={}
        for _ in range(30):
            page=ui.js(r'''const ids=new Map([...document.querySelectorAll('[role=option][aria-label]')].map(e=>[e.getAttribute('aria-label'),text(e)]));
return [...document.querySelectorAll('.aurora-select-item-option[title]')].filter(visible).map(e=>({name:e.title,id:ids.get(e.title)||null}));''')
            for e in page:options[e['name']]=e
            more=ui.js(r'''const h=[...document.querySelectorAll('.rc-virtual-list-holder,.aurora-select-dropdown [style*=overflow]')].filter(visible).find(e=>e.scrollHeight>e.clientHeight+1);
if(!h||h.scrollTop+h.clientHeight>=h.scrollHeight-2)return false;h.scrollTop+=h.clientHeight;h.dispatchEvent(new Event('scroll',{bubbles:true}));return true;''')
            if not more:break
            time.sleep(.15)
        if not options:raise ShopDeskError('no verified tax subjects')
        # Close the list without changing its selected subject.
        _tax_control(ui,'选择主体')
        return list(options.values())
    # Click a subject control, enumerate only its visible options, and re-open for each selection.
    opened=ui.js(r'''const labels=arg==='tax'?['商户主体','主体','当前主体']:['当前主体'];
const wallet=document.querySelector('[data-testid="subject-switch-select"]');
if(wallet&&visible(wallet)){const input=wallet.querySelector('[role=combobox]');
if(input?.getAttribute('aria-expanded')!=='true'){const c=wallet.querySelector('.fund-control-select-content');c.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));c.click();}return true;}
for(const label of labels){const leaf=[...document.querySelectorAll('label,span,div')].filter(visible).filter(e=>e.children.length===0&&text(e).startsWith(label)).sort((a,b)=>text(a).length-text(b).length)[0];
if(leaf){let p=leaf;for(let i=0;i<4&&p;i++,p=p.parentElement){const control=p.querySelector('[role="combobox"],.auxo-select-selector,.arco-select-view,[class*="selectSelector"]');if(control){control.click();return true;}}
leaf.parentElement.click();return true;}}
return false;''',kind)
    if not opened:raise ShopDeskError('needs_entity_profile: no verified subject dropdown; not treating current subject as all subjects')
    def options():
        return ui.js(r'''let els=[...document.querySelectorAll('[role="option"]')].filter(visible);
if(!els.length)els=[...document.querySelectorAll('[class*="dropdown"] [class*="option"],[class*="dropdown"] span')].filter(e=>visible(e)&&e.children.length===0&&/公司|企业|个体|合作社/.test(text(e)));
return [...new Map(els.filter(e=>text(e)&&text(e)!=='全部').map(e=>[text(e),{name:text(e),id:e.getAttribute('data-value')||e.getAttribute('value')||null}])).values()];''')
    entities=ui.wait(options,timeout=12)
    return entities


def _select_entity(ui,entity,kind):
    if kind=='steward' and entity.get('single_subject'):
        proof=ui.request('/account/center/subjectChangeList?req_source=dou_dian_pc')
        if proof.get('code')!=0 or proof.get('data')!=[]:
            raise ShopDeskError('wallet single-subject scope is no longer verified')
        return
    # The first dropdown may still be open; otherwise re-open it through the same control.
    body=r'''let els=[...document.querySelectorAll('[role="option"],[class*="dropdown"] [class*="option"],[class*="dropdown"] span')].filter(e=>visible(e)&&text(e)===arg);
const e=els.sort((a,b)=>a.querySelectorAll('*').length-b.querySelectorAll('*').length)[0];if(!e)return false;e.click();return true;'''
    if not ui.js(body,entity['name']):
        if kind=='tax':_tax_control(ui,'选择主体')
        else:_entities(ui,kind)
        if not ui.js(body,entity['name']):raise ShopDeskError('subject option disappeared')
    ui.wait(lambda:ui.js("const t=document.body?.innerText||'';const p=t.indexOf('当前主体');return p>=0?t.slice(p,p+400).includes(arg):[...document.querySelectorAll('[role=combobox],.auxo-select-selection-item,.arco-select-view-value,.aurora-select-content-value')].filter(visible).some(e=>text(e).includes(arg));",entity['name']),timeout=20)


def _tax_control(ui,label,opened=None):
    return ui.wait(lambda:ui.js(r'''let p=exact(arg.label)[0];for(let i=0;i<6&&p;i++,p=p.parentElement){const input=p.querySelector('[role=combobox]');
if(input){if(arg.opened!==null&&(input.getAttribute('aria-expanded')==='true')===arg.opened)return true;
const c=input.parentElement;c.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));c.click();return true;}}return false;''',{'label':label,'opened':opened}),timeout=15)


def _select_tax_month(ui,month):
    ui.wait(lambda:ui.js("if(!exact('按月度看').length)return false;return click('按月度看');"),timeout=20)
    # Remove the officially rendered selection chips in this control. Iterating
    # a cached list of years is unsafe while a subject switch remounts the menu.
    for _ in range(120):
        state=ui.wait(lambda:ui.js(r'''let p=exact('选择时间')[0];for(let i=0;i<6&&p;i++,p=p.parentElement){
if(!p.querySelector('[role=combobox]'))continue;
const chips=[...p.querySelectorAll('.aurora-select-selection-item[title]')].filter(e=>/^\d{4}年\d+月$/.test(e.title));
if(!chips.length)return {remaining:0};
const chip=chips.find(visible),remove=chip?.querySelector('.aurora-select-selection-item-remove');
if(!remove)return null;const before=chips.map(e=>e.title);remove.click();return {remaining:chips.length,before};}return null;'''))
        if not state['remaining']:break
        ui.wait(lambda:ui.js(r'''let p=exact('选择时间')[0];for(let i=0;i<6&&p;i++,p=p.parentElement){
if(p.querySelector('[role=combobox]'))return JSON.stringify([...p.querySelectorAll('.aurora-select-selection-item[title]')]
.map(e=>e.title).filter(t=>/^\d{4}年\d+月$/.test(t)))!==JSON.stringify(arg);}return false;''',state['before']))
    else:raise ShopDeskError('too many selected tax months to clear safely')
    year=month[:4]+'年';label=str(int(month[5:]))+'月'
    def choose_year():
        _tax_control(ui,'选择时间',opened=True)
        return ui.js("const e=[...document.querySelectorAll('.aurora-cascader-menu-item[title]')].find(e=>visible(e)&&e.title===arg);if(!e)return false;e.click();return true;",year)
    ui.wait(choose_year,timeout=12)
    def choose_month():
        return ui.js("const e=[...document.querySelectorAll('.aurora-cascader-menu-item[title]')].find(e=>visible(e)&&e.title===arg);if(!e)return false;if(e.getAttribute('aria-checked')!=='true')e.click();return true;",label)
    ui.wait(choose_month,timeout=12)
    _tax_control(ui,'选择时间',opened=False)


def _tax_export(ui,month,root,manifest,entity):
    month_label=f'{int(month[:4])}年{int(month[5:])}月'
    ui.wait(lambda:ui.js("return exact('按月度看').length>0&&exact('选择时间').length>0;"))
    _select_tax_month(ui,month)
    ui.bridge.command(ui.eid,'events');ui.click('查询')
    request={}
    def queried():
        for e in ui.bridge.command(ui.eid,'events').get('events',[]):
            if e.get('method')=='Network.requestWillBeSent' and '/bill_center/domestic/shop/query_item' in e.get('url',''):
                p=e.get('body') or {}
                if p.get('query_type')=='TAX_BILL':request.update({'id':e['requestId'],'body':p})
        if not request:return False
        p=request['body']
        if p.get('date_type')!='MONTH' or p.get('bill_date')!=[month.replace('-','')]:raise ShopDeskError('tax query period was not applied')
        if entity.get('id') and entity['id']!=str(p.get('member_id')):raise ShopDeskError('tax query subject differs from selected subject')
        entity['id']=str(p['member_id'])
        try:response=json.loads(ui.bridge.command(ui.eid,'Network.getResponseBody',{'requestId':request['id']})['result']['body'])
        except (ShopDeskError,KeyError,ValueError):return False
        if response.get('code') not in ['100000',0,'0']:raise ShopDeskError('official tax query failed')
        return response
    response=ui.wait(queried,timeout=20)
    manifest['screenshots'].append({**ui.capture(root,'涉税账单-'+entity['name'],month),'entity_id':entity['id'],'entity_name':entity['name']})
    if not response.get('data'):
        manifest['collection'].append({'role':'tax','status':'no_activity','entity':entity,'query':request['body'],'total':response.get('total')});return
    ui.wait(lambda:ui.month_row(month_label))
    candidates=[r for r in _reports(ui) if r.get('download_type')=='TAX_BILL_ITEM' and _period_matches(r,month) and str(r.get('member_id'))==entity['id'] and r.get('status') in ['SUCCESS','PROCESSING']]
    ticket=max(candidates,key=lambda r:r.get('create_time',''))['download_id'] if candidates else _generate_month_report(ui,'tax',month_label)['download_id']
    report=_report_ready(ui,ticket,month,manifest)
    if report.get('download_type')!='TAX_BILL_ITEM' or str(report.get('member_id'))!=entity['id']:raise ShopDeskError('tax report subject/type mismatch')
    paths=ui.download(root,lambda:ui.bridge.command(ui.eid,'finance_download_report',{'download_id':ticket}))
    for path in paths:manifest['inputs'].append({'path':str(path),'sha256':sha256(path),'role':'tax','entity_id':entity['id'],'entity_name':entity['name'],'platform_report_id':ticket})
    manifest['collection'].append({'role':'tax','status':'downloaded','entity':entity,'platform_report':report})


def _account_export(ui,kind,month,root,manifest,entity=None):
    if kind=='tax':return _tax_export(ui,month,root,manifest,entity)
    if kind=='steward':return _wallet_export(ui,month,root,manifest,entity)
    label,account=KINDS[kind]
    suffix='-'+safe_name(entity['name']) if entity else ''
    shot=ui.capture(root,label+suffix+'余额',month)
    if entity:shot.update({'entity_id':entity.get('id'),'entity_name':entity['name']})
    manifest['screenshots'].append(shot)
    if kind=='tax':
        ui.js("if(exact('按月度看').length)click('按月度看');return true;")
        ui.js(r'''const inputs=[...document.querySelectorAll('input')].filter(visible).filter(e=>/月份|月度|日期/.test(e.placeholder)||/^\d{4}-\d{2}$/.test(e.value));
if(inputs.length!==1)throw Error('Tax month selector not uniquely identified');const e=inputs[0];Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,arg);e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return true;''',month)
        ui.click('查询')
    else:ui.select_month(month)
    ui.wait(lambda:bool(_ledger_rows(ui)) or any(s in ui.snapshot()['text'] for s in ['暂无数据','共 0 条','共0条']))
    snap=ui.snapshot()
    if not _ledger_rows(ui) and any(s in snap['text'] for s in ['暂无数据','共 0 条','共0条']):
        manifest['collection'].append({'role':kind,'status':'no_activity','entity':entity,'evidence':snap});return
    files=ui.download(root,lambda:ui.js("for(const label of ['导出明细','下载明细','生成报表'])if(exact(label).length){click(label);return true;}throw Error('Missing official export control');"))
    for path in files:
        item={'path':str(path),'role':kind,'account':account}
        if entity:item.update({'entity_id':entity.get('id'),'entity_name':entity['name']})
        manifest['inputs'].append(item)
    manifest['collection'].append({'role':kind,'status':'downloaded','entity':entity})


def _wallet_balance(page_text):
    # Read only the labelled total in the wallet card, never a withdrawal,
    # frozen amount or a transaction balance further down the page.
    matches=re.findall(r'(?:^|\n)\s*总金额\s*[¥￥]\s*([\d,]+\.\d{2})(?=\s|$)',page_text)
    if len(matches)!=1:return None
    return {'status':'opened','total':str(decimal(matches[0].replace(',',''))),'kind':'current',
            'source':'official_page','label':'总金额'}


def _wallet_entities(ui):
    if ui.js("return !![...document.querySelectorAll('[data-testid=subject-switch-select]')].find(visible);"):
        return _entities(ui,'steward')
    proof=ui.request('/account/center/subjectChangeList?req_source=dou_dian_pc')
    if proof.get('code')==0 and proof.get('data')==[]:
        return [{'name':'当前店铺主体','id':None,'single_subject':True,
                 'subject_scope_proof':{'route':'/account/center/subjectChangeList','code':0,'data':[]}}]
    # A missing dropdown alone never proves that there is only one subject.
    return _entities(ui,'steward')


def _wallet_query(ui):
    ui.js(r'''window.__walletQueryProof=[];
if(!window.__walletProofInstalled){window.__walletProofInstalled=true;
const open=XMLHttpRequest.prototype.open,send=XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.open=function(method,url,...rest){this.__walletProofPath=new URL(url,location.href).pathname;return open.call(this,method,url,...rest);};
XMLHttpRequest.prototype.send=function(body){if(this.__walletProofPath==='/shop/be/bic/queryAccountFlows'){
const p=new URLSearchParams(body),proof={params:{}};
for(const key of ['start_time','end_time','member_id','member_type','page','size'])if(p.has(key))proof.params[key]=p.get(key);
window.__walletQueryProof.push(proof);this.addEventListener('load',()=>{proof.http_status=this.status;
try{const j=JSON.parse(this.responseText);proof.code=j.code;proof.total=j.data?.Total;
proof.account_times=Array.isArray(j.data?.AccountFlow)?j.data.AccountFlow.map(r=>r.AccountTime):[];
proof.completed=true;}catch{proof.error='Invalid official wallet response';proof.completed=true;}},{once:true});}
return send.call(this,body);};}return true;''')
    ui.click('查询')
    proof=ui.wait(lambda:ui.js('return window.__walletQueryProof.find(p=>p.completed)||null;'),timeout=20)
    if proof.get('http_status')!=200 or proof.get('code')!=0 or proof.get('error'):
        raise ShopDeskError('official wallet query failed')
    return proof


def _wallet_report_matches(report,month):
    start,end=month_bounds(month);zone=timezone(timedelta(hours=8))
    return (report.get('account_desc')=='管家' and report.get('task_status')=='SUCCESS'
            and isinstance(report.get('start_time'),int) and isinstance(report.get('end_time'),int)
            and report['start_time']<=int(start.replace(tzinfo=zone).timestamp())
            and report['end_time']>=int(end.replace(tzinfo=zone).timestamp())-1)


def _wallet_reports(ui,path):
    response=ui.request(path)
    if response.get('code')!=0:raise ShopDeskError('official wallet report list failed')
    records=response.get('data')
    # The official endpoint uses null when no export has ever been generated.
    # This means an export must be generated, never that the ledger is empty.
    if records is None:return []
    if not isinstance(records,list):raise ShopDeskError('unexpected official wallet history schema')
    return records


def _wallet_report_download(ui,month,root,manifest,entity,proof):
    """Use the wallet's own history and actual download control, not fund history."""
    wallet_url=ui.snapshot()['url']
    def restore():
        ui.bridge.command(ui.eid,'Page.navigate',{'url':wallet_url});ui.bridge.ready(ui.eid)
        # The page heading renders before its subject selector. Selecting at
        # that point incorrectly reports a missing multi-subject profile.
        if not entity.get('single_subject'):
            ui.wait(lambda:ui.js("return !![...document.querySelectorAll('[data-testid=subject-switch-select]')].find(visible);"))
        _select_entity(ui,entity,'steward')
        ui.wait(lambda:ui.js("return [...document.querySelectorAll('[role=tab]')].some(e=>visible(e)&&text(e)==='余额明细');"))
        ui.js("const t=[...document.querySelectorAll('[role=tab]')].find(e=>visible(e)&&text(e)==='余额明细');if(!t)throw Error('Wallet ledger unavailable');t.click();return true;")
        ui.wait(lambda:'生成报表' in ui.snapshot()['text'])
    def history():
        ui.js(r'''const original=window.open;let opened=false;
window.open=function(value,...rest){const u=new URL(value,location.href);
if(u.origin===location.origin&&u.pathname==='/ffa/fund-control/account-flow-history'){
opened=true;location.assign(u.href);return null;}return original.call(this,value,...rest);};
const b=[...document.querySelectorAll('button')].find(e=>visible(e)&&text(e)==='历史报表');
if(!b)throw Error('Missing wallet-specific history control');b.click();if(!opened)window.open=original;return opened;''')
        ui.wait(lambda:'/account-flow-history' in ui.snapshot()['url'])
        ui.wait(lambda:'30天' in ui.snapshot()['text'])
        params=ui.js(r'''const p=new URL(location.href).searchParams;return Object.fromEntries(
['uid_type','member_type','merchant_uid','member_id'].map(k=>[k,p.get(k)||'']));''')
        if (params['member_id']!=(proof['params'].get('member_id') or '')
            or params['member_type']!=(proof['params'].get('member_type') or '') or not params['merchant_uid']):
            raise ShopDeskError('wallet report history belongs to a different subject')
        from urllib.parse import urlencode
        return '/settlement/account/queryFlowTasks?'+urlencode({**params,'page':1,'page_size':10,'req_source':'dou_dian_pc'})
    def reports(path):
        return [r for r in _wallet_reports(ui,path) if _wallet_report_matches(r,month)]
    try:
        path=history();candidates=reports(path)
        if not candidates:
            restore();again=_wallet_query(ui)
            for key in ['start_time','end_time','member_id','member_type']:
                if again['params'].get(key)!=proof['params'].get(key):raise ShopDeskError('wallet export scope changed before generation')
            ui.click('生成报表')
            ui.wait(lambda:'5分钟内只能生成一次' in ui.snapshot()['text'])
            ui.js("const b=[...document.querySelectorAll('button')].find(e=>visible(e)&&text(e)==='生成');if(!b)throw Error('Missing wallet generation confirmation');b.click();return true;")
            ui.wait(lambda:'生成报表？' not in ui.snapshot()['text'])
            path=history();candidates=ui.wait(lambda:reports(path),timeout=90)
        report=min(candidates,key=lambda r:r['end_time']-r['start_time'])
        ticket=report['task_id']
        if not re.fullmatch(r'FL\d{16,40}',ticket):raise ShopDeskError('Invalid official wallet report ID')
        dates=[datetime.fromtimestamp(report[k],timezone(timedelta(hours=8))).strftime('%Y/%m/%d %H:%M:%S')
               for k in ['create_time','start_time','end_time']]
        # Polling the API does not update the React card that was first
        # rendered as PROCESSING. Reload its verified subject-specific history
        # and wait for this exact report's download control before arming.
        history_url=ui.snapshot()['url']
        ui.bridge.command(ui.eid,'Page.navigate',{'url':history_url});ui.bridge.ready(ui.eid)
        ui.wait(lambda:ui.js(r'''return [...document.querySelectorAll('.bg-background-module')].filter(visible)
.some(e=>arg.every(d=>text(e).includes(d))&&text(e).includes('管家账户')&&text(e).includes('可下载')
&&[...e.querySelectorAll('button')].some(b=>visible(b)&&text(b)==='下载'));''',dates),timeout=25)
        def trigger():
            # Official buttons create target=_blank anchors, which the isolated
            # workbench correctly blocks. Capture this exact report's anchor in
            # the renderer, fetch its bytes there and download a blob in-page.
            # Signed URLs and authentication never leave the browser.
            return ui.bridge.evaluate(ui.eid,'(async()=>{'+JS_HELPERS+'const ticket='+json.dumps(ticket)+r''';
const original=HTMLAnchorElement.prototype.click;let target;
HTMLAnchorElement.prototype.click=function(){const u=new URL(this.href,location.href);
if(u.protocol==='https:'&&/^lf[0-9]+-account-detail-sign\.bytetos\.com$/.test(u.hostname)
&&u.pathname==='/caijing-account-detail-download/'+ticket+'.zip'){target=u.href;return;}
return original.call(this);};
try{const cards=[...document.querySelectorAll('.bg-background-module')].filter(visible);
const dates='''+json.dumps(dates)+r''';
const card=cards.find(e=>dates.every(d=>text(e).includes(d))&&text(e).includes('管家账户')&&text(e).includes('可下载'));
const b=card&&[...card.querySelectorAll('button')].find(e=>text(e)==='下载');if(!b)throw Error('Matching wallet download card missing');b.click();
const deadline=Date.now()+5000;while(!target&&Date.now()<deadline)await new Promise(r=>setTimeout(r,50));
if(!target)throw Error('Official wallet download link unavailable');
const c=new AbortController(),timer=setTimeout(()=>c.abort(),6000);let blob;
try{const r=await fetch(target,{signal:c.signal});if(!r.ok)throw Error('Wallet file HTTP '+r.status);blob=await r.blob();}finally{clearTimeout(timer);}
if(!blob.size||blob.size>64*1024*1024)throw Error('Unexpected wallet export size');
const a=document.createElement('a'),url=URL.createObjectURL(blob);a.href=url;a.download=ticket+'.zip';document.body.appendChild(a);
a.dispatchEvent(new MouseEvent('click',{bubbles:true}));a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);return {started:true,size:blob.size};
}finally{HTMLAnchorElement.prototype.click=original;}})()''')
        paths=ui.download(root,trigger)
        for path in paths:manifest['inputs'].append({'path':str(path),'sha256':sha256(path),'role':'steward','account':'管家账户',
            'entity_id':entity['id'],'entity_name':entity['name'],'platform_report_id':ticket,'export_scope':'verified_window_containing_requested_month'})
        manifest['collection'].append({'role':'steward','status':'downloaded','entity':entity,'query':proof,
            'platform_report':report,'export_scope':'verified_window_containing_requested_month','calculation_month':month})
    finally:restore()


def _wallet_export(ui,month,root,manifest,entity):
    state=ui.wait(lambda:ui.js("const t=document.body?.innerText||'';if(t.includes('开通抖店钱包')&&exact('去开通').length)return 'not_opened';return [...document.querySelectorAll('[role=tab]')].some(e=>visible(e)&&text(e)==='余额明细')?'ledger':null;"))
    if state=='not_opened':
        manifest['screenshots'].append({**ui.capture(root,'管家账户-'+entity['name']+'未开通',month),
                                      'entity_name':entity['name'],'entity_id':entity.get('id'),
                                      'wallet_balance':{'status':'not_opened','total':None,'kind':'current','source':'official_page'}})
        manifest['collection'].append({'role':'steward','status':'not_opened','entity':entity,
            'evidence':'该主体官方页面明确显示“开通抖店钱包／去开通”；未执行开通操作，不作为已核实的历史余额。'})
        return
    ui.js(r'''const tab=[...document.querySelectorAll('[role=tab]')].find(e=>visible(e)&&text(e)==='余额明细');
if(!tab)throw Error('Missing wallet balance ledger tab');if(tab.getAttribute('aria-selected')!=='true')tab.click();return true;''')
    ui.wait(lambda:ui.js("return [...document.querySelectorAll('[role=tab]')].some(e=>text(e)==='余额明细'&&e.getAttribute('aria-selected')==='true');"))
    # The bridge intentionally hides non-JSON form bodies. Observe only the
    # official query's non-secret scope fields and aggregate response in-page.
    # No requests are synthesized, and authentication stays in the renderer.
    proof=_wallet_query(ui)
    start,end=month_bounds(month)
    params=proof['params']
    try:
        query_start=int(params['start_time']);query_end=int(params['end_time'])
    except (ValueError,KeyError):raise ShopDeskError('wallet query has no verified time window') from None
    zone=timezone(timedelta(hours=8))
    requested_start=int(start.replace(tzinfo=zone).timestamp()*1000)
    requested_end=int(end.replace(tzinfo=zone).timestamp()*1000)-1
    if query_start>requested_start or query_end<requested_end:
        raise ShopDeskError('wallet query window does not cover the requested month')
    entity['id']=params.get('member_id') or None
    balance=ui.wait(lambda:_wallet_balance(ui.snapshot()['text']))
    shot={**ui.capture(root,'管家账户-'+entity['name']+'余额',month),
          'entity_name':entity['name'],'entity_id':entity['id'],'query':proof,'wallet_balance':balance}
    manifest['screenshots'].append(shot)
    times=proof.get('account_times',[])
    complete_page=isinstance(proof.get('total'),int) and len(times)==proof['total']
    in_month=[]
    if complete_page:
        for value in times:
            try:
                at=datetime.fromisoformat(value)
                at=at.replace(tzinfo=zone) if at.tzinfo is None else at.astimezone(zone)
                millis=int(at.timestamp()*1000)
            except (ValueError,TypeError):raise ShopDeskError('wallet row has no verified accounting timestamp') from None
            if not query_start<=millis<=query_end:raise ShopDeskError('wallet row is outside the verified query window')
            if requested_start<=millis<=requested_end:in_month.append(value)
    if complete_page and not in_month:
        manifest['collection'].append({'role':'steward','status':'no_activity','entity':entity,
            'query':proof,'export_scope':'verified_window_containing_requested_month',
            'evidence':'All rows of the official query were examined in a verified window covering the entire requested month; none is dated in that month.'})
        return
    _wallet_report_download(ui,month,root,manifest,entity,proof)


def _account(ui,kind,month,root,manifest):
    label,account=KINDS[kind]
    if kind in ['base_deposit','experience_deposit']:
        ui.bridge.command(ui.eid,'Page.navigate',{'url':'https://fxg.jinritemai.com/ffa/content/shop_deposit'})
        ui.bridge.ready(ui.eid);ui.wait(lambda:'交易流水' in ui.snapshot()['text'])
        ui.js(r'''const tabs=[...document.querySelectorAll('[role="tab"]')].filter(e=>visible(e)&&text(e)===arg);
if(tabs.length!==1)throw Error('Cannot uniquely identify deposit account tab');tabs[0].click();return true;''',label)
        # The verified official exporter supports the unfiltered ledger. Preserve
        # all history verbatim and filter by 操作时间 in the calculation layer.
        # Never claim a synthetic input value changed the platform's query.
        ui.wait(lambda:ui.js("return [...document.querySelectorAll('[role=tab]')].some(e=>visible(e)&&text(e)===arg&&e.getAttribute('aria-selected')==='true');",label))
        dates=ui.js("return [...document.querySelectorAll('input')].filter(e=>visible(e)&&/开始|结束/.test(e.placeholder)).map(e=>e.value);")
        if len(dates)!=2 or any(dates):raise ShopDeskError('deposit full-history export requires empty date filters')
        ui.js("const e=[...document.querySelectorAll('button')].find(e=>visible(e)&&text(e).replace(/\\s/g,'')==='查询');if(!e)throw Error('Missing deposit query');e.click();return true;")
        ui.wait(lambda:bool(_ledger_rows(ui)) or '暂无数据' in ui.snapshot()['text'])
        manifest['screenshots'].append(ui.capture(root,label+'余额',month))
        if not _ledger_rows(ui) and '暂无数据' in ui.snapshot()['text']:
            manifest['collection'].append({'role':kind,'status':'no_activity','export_scope':'all_history','evidence':ui.snapshot()});return
        paths=ui.download(root,lambda:ui.click('导出明细'))
        for path in paths:manifest['inputs'].append({'path':str(path),'sha256':sha256(path),'role':kind,'account':account,'export_scope':'all_history'})
        manifest['collection'].append({'role':kind,'status':'downloaded','export_scope':'all_history','calculation_month':month})
        return
    if kind=='steward':
        ui.bridge.command(ui.eid,'Page.navigate',{'url':'https://fxg.jinritemai.com/ffa/fund-control/account-center'})
        ui.bridge.ready(ui.eid)
        def wallet_ready():
            text=ui.snapshot()['text']
            if '需要实名认证后访问' in text:raise ShopDeskError('needs_real_name_verification: 账户中心提示账号未实名认证，无法访问管家账户')
            return '管家账户' in text or '抖店钱包' in text or '货款账户' in text
        ui.wait(wallet_ready)
        if not ui.open_wallet():
            # An unopened current subject has only “去开通” on the card.
            # Read the already verified official wallet route to enumerate all
            # subjects; never click that account-opening control.
            ui.bridge.command(ui.eid,'Page.navigate',{'url':'https://fxg.jinritemai.com/ffa/fund-control/butler-account?source=account_center'})
            ui.bridge.ready(ui.eid)
        ui.wait(lambda:ui.js("const t=document.body?.innerText||'';return [...document.querySelectorAll('[role=tab]')].some(e=>visible(e)&&text(e)==='余额明细')||(t.includes('开通抖店钱包')&&exact('去开通').length>0);"))
    else:
        ui.bridge.command(ui.eid,'Page.navigate',{'url':'https://fxg.jinritemai.com/ffa/fxg-bill/tax-bill'})
        ui.bridge.ready(ui.eid);ui.wait(lambda:'选择主体' in ui.snapshot()['text'])
    entities=_wallet_entities(ui) if kind=='steward' else _entities(ui,kind)
    manifest.setdefault('entities',[]).extend({'role':kind,**e} for e in entities)
    for entity in entities:
        if any(c.get('role')==kind and c.get('status') in ['downloaded','no_activity','not_opened'] and c.get('entity',{}).get('name')==entity['name'] for c in manifest['collection']):continue
        try:
            if kind=='tax' and 'tax-bill' not in ui.snapshot()['url']:
                ui.bridge.command(ui.eid,'Page.navigate',{'url':'https://fxg.jinritemai.com/ffa/fxg-bill/tax-bill'})
                ui.bridge.ready(ui.eid);ui.wait(lambda:'选择主体' in ui.snapshot()['text'])
            _select_entity(ui,entity,kind)
            _account_export(ui,kind,month,root,manifest,entity)
        except (ShopDeskError,DataError) as exc:
            manifest['collection'].append({'role':kind,'status':'error','entity':entity,'error':str(exc)})
        finally:dump_json(root/'collection.json',manifest)


def collect_and_build(*,kinds,resume=None,on_checkpoint=None,**options):
    requested=[k.strip() for k in kinds if k.strip()]
    if not requested or any(k not in KINDS for k in requested):raise DataError('unknown or empty collection kinds')
    month_bounds(options['month'])
    if not options.get('shopdesk_shop_uuid'):raise DataError('collect requires --shop with a ShopDesk UUID; use recon shops')
    b=ShopDesk();shops=b.shops();shop=next((s for s in shops if s['id']==options['shopdesk_shop_uuid']),None)
    if not shop:raise DataError('shop UUID is not present in ShopDesk')
    options['shop_name']=options.get('shop_name') or shop['name']
    work=options['output'].resolve()/('collection-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-'+uuid.uuid4().hex[:6])
    work.mkdir(parents=True,exist_ok=False)
    lock_path=options['output'].resolve()/'.shopdesk-collection.lock'
    manifest={'schema_version':'1.0','shop':{k:options.get(k) for k in ['shop_id','shopdesk_shop_uuid','platform_shop_id']},
              'month':options['month'],'inputs':[],'screenshots':[],'balances':[],'collection':[],'requested_kinds':requested}
    completed=set()
    if resume:
        previous=json.loads(resume.read_text())
        if previous.get('month')!=options['month'] or previous.get('shop',{}).get('shopdesk_shop_uuid')!=shop['id']:
            raise DataError('resume manifest belongs to a different shop or month')
        by_role={}
        for result in previous.get('collection',[]):by_role.setdefault(result['role'],[]).append(result)
        completed={role for role,results in by_role.items() if results and all(r.get('status') in ['downloaded','no_activity','not_opened'] for r in results)}
        successful=[r for r in previous.get('collection',[]) if r.get('status') in ['downloaded','no_activity','not_opened']]
        for item in previous.get('inputs',[]):
            if item.get('role') in completed or any(r.get('role')==item.get('role') and r.get('entity',{}).get('name')==item.get('entity_name') and item.get('entity_name') for r in successful):
                source=Path(item['path'])
                if not source.is_absolute():source=resume.parent/source
                if not source.is_file():raise DataError('resumed input file is missing')
                if item.get('sha256') and sha256(source)!=item['sha256']:raise DataError('resumed input hash differs')
                manifest['inputs'].append({**item,'path':str(source.resolve())})
        manifest['screenshots']=previous.get('screenshots',[])
        manifest['balances']=previous.get('balances',[])
        manifest['shop']=previous['shop']
        manifest['collection']=successful
        manifest['previous_attempts']=[r for r in previous.get('collection',[]) if r.get('status') not in ['downloaded','no_activity','not_opened']]
    def checkpoint(result=None):
        dump_json(work/'collection.json',manifest)
        if on_checkpoint:on_checkpoint({'collection_manifest':str(work/'collection.json'),**({'result':result} if result else {})})
    checkpoint()
    with lock_path.open('w') as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:raise ShopDeskError('another finance collection owns the local bridge lock') from None
        eid=b.start(shop['id'],URL);ui=UI(b,eid)
        dump_json(work/'session.json',{'shop':shop,'exploration':{'id':eid},'month':options['month']})
        try:
            b.ready(eid)
            identity=validate_identity(read_shop_identity(ui),manifest['shop'].get('platform_shop_id'))
            if manifest['shop'].get('shop_id') and str(manifest['shop']['shop_id'])!=identity['shop_id']:
                raise DataError('configured shop_id differs from the current platform shop ID')
            manifest['shop'].update(platform='douyin',platform_shop_id=identity['shop_id'],shop_id=identity['shop_id'],
                                    shop_name=identity['shop_name'],identity=identity,shopdesk_shop_name=shop['name'])
            options.update(shop_name=identity['shop_name'],platform_shop_id=identity['shop_id'],shop_id=identity['shop_id'])
            checkpoint()
            try:b.command(eid,'finance_capabilities')
            except ShopDeskError as exc:raise ShopDeskError('ShopDesk needs the reviewed download/screenshot extension; run tools/install_shopdesk_extension.py --install while idle') from exc
            for kind in requested:
                if kind in completed:continue
                try:
                    if kind in ['fund','settlement']:_monthly(ui,kind,options['month'],work,manifest)
                    elif kind=='qianchuan':
                        from .collect_qianchuan import collect_all as collect_qianchuan
                        collect_qianchuan(ui,options['month'],work,manifest)
                    else:_account(ui,kind,options['month'],work,manifest)
                except (ShopDeskError,DataError) as exc:
                    manifest['collection'].append(collection_error(kind,exc))
                checkpoint()
            identity=validate_identity(read_shop_identity(ui),manifest['shop']['platform_shop_id'])
            manifest['shop'].update(shop_name=identity['shop_name'],identity=identity)
            options['shop_name']=identity['shop_name']
            checkpoint()
        finally:
            try:b.close(eid)
            except ShopDeskError:pass
    # A resumed failed attempt may have captured the same account twice.
    # Keep its latest capture in the report; earlier attempt files remain intact.
    manifest['screenshots']=list({(s.get('sheet'),s.get('entity_name'),s.get('requested_month')):s
                                  for s in manifest['screenshots']}.values())
    checkpoint()
    if not manifest['inputs'] and not (set(requested)<={r.get('role') for r in manifest['collection']} and
                                      all(r.get('status') in ['no_activity','not_opened'] or qianchuan_denied(r) for r in manifest['collection'])):
        raise ShopDeskError(f'no official bill files collected; inspect {work / "collection.json"}')
    result=build([],manifest_path=work/'collection.json',collection_context={'collection':manifest['collection'],'requested_kinds':requested,'collection_manifest':str(work/'collection.json')},**options)
    result['collection_manifest']=str(work/'collection.json')
    checkpoint(result)
    return result
