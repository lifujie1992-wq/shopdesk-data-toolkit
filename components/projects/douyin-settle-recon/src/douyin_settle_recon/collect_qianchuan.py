"""Official Qianchuan controls in the shop's existing ShopDesk partition."""
from datetime import timedelta
import json
import re
from urllib.parse import parse_qs, urlsplit

from .model import DataError, sha256, month_bounds
from .shopdesk import ShopDeskError
from .collection_status import collection_error

ENTRY='https://fxg.jinritemai.com/ffa/ad/promotion-v2?utm_source=qianchuan-origin-entrance&utm_medium=doudian-pc&utm_campaign=tuiguangtab'
DAILY_PATH='/cg_trade/finance/backend/finance/transaction'


def _accounts(ui):
    return ui.js(r'''return [...document.querySelectorAll('div')].filter(e=>visible(e)&&e.children.length===0&&/^ID:\s*\d+$/.test(text(e)))
.map(e=>({id:text(e).replace(/^ID:\s*/,''),name:e.parentElement.querySelector('[class*="name-"]')?.innerText||''}));''')


def _entry(ui):
    # Account selection in the promotion app can stay blank when it is mounted
    # in the wide viewport left by a preceding finance capture. Restore the
    # workbench's normal geometry before opening this different application.
    ui.bridge.command(ui.eid,'finance_capture',{'width':1280,'height':900})
    ui.bridge.command(ui.eid,'Page.navigate',{'url':ENTRY});ui.bridge.ready(ui.eid)
    def entry_ready():
        state=ui.snapshot()
        if '/account/choose' in state['url'] and '请选择千川账户' in state['text']:
            return 'choose' if _accounts(ui) else False
        if any(s in state['text'] for s in ['暂无权限','无访问权限','权限不足','没有访问该页面的权限']):raise ShopDeskError('千川入口权限不足：请确认账号具有「流量-千川推广」权限')
        if '/account/register' in state['url'] and '免费开通巨量千川账户' in state['text'] and '立即免费开户' in state['text']:
            return 'not_opened'
        return 'detail' if '账户明细' in state['text'] or ('/product/create' in state['url'] and '千川账户：' in state['text']) else False
    return ui.wait(entry_ready)


def _open(ui,advertiser_id=None,*,bound=False):
    if bound:
        account=advertiser_id
        if not re.fullmatch(r'\d+',account or ''):raise ShopDeskError('千川绑定广告账户ID无效')
        ui.bridge.command(ui.eid,'Page.navigate',{'url':'https://qianchuan.jinritemai.com/finance?aavid='+account})
    else:
        state=_entry(ui)
        current=parse_qs(urlsplit(ui.snapshot()['url']).query).get('aavid',[''])[0]
        if state=='detail' and advertiser_id and current!=advertiser_id:
            ui.click('切换');ui.wait(lambda:bool(_accounts(ui)));state='choose'
        if state=='choose':
            accounts=_accounts(ui)
            selected=next((a for a in accounts if a['id']==advertiser_id),None) if advertiser_id else accounts[0] if len(accounts)==1 else None
            if selected is None:raise ShopDeskError('千川存在多个绑定账户，需要明确本次核对的广告账户')
            ui.js(r'''const e=[...document.querySelectorAll('div')].find(e=>visible(e)&&e.children.length===0&&text(e).replace(/\s/g,'')==='ID:'+arg);
    if(!e)throw Error('Requested advertiser is not bound to this shop');e.click();return true;''',selected['id'])
            ui.wait(lambda:parse_qs(urlsplit(ui.snapshot()['url']).query).get('aavid')==[selected['id']] and '千川账户：' in ui.snapshot()['text'])
        state=ui.snapshot();account=parse_qs(urlsplit(state['url']).query).get('aavid',[''])[0]
        if not re.fullmatch(r'\d+',account):raise ShopDeskError('千川入口没有明确绑定的广告账户ID')
        if advertiser_id and account!=advertiser_id:raise ShopDeskError('千川选中账户与指定账户不一致')
        # The official link helper uses a temporary anchor. Keep its full SSO route
        # inside the renderer, including its selected account, instead of losing the
        # popup to ShopDesk's general popup guard.
        has_detail=ui.js("return exact('账户明细').length>0;")
        if not has_detail:
            # Unused bound accounts omit the fund card in the promotion app. The
            # already observed official finance route still accepts their bound ID.
            ui.bridge.command(ui.eid,'Page.navigate',{'url':'https://qianchuan.jinritemai.com/finance?aavid='+account})
        else:ui.js(r'''const original=HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click=function(){const u=new URL(this.href,location.href);
    if(u.hostname==='qianchuan.jinritemai.com'&&u.protocol==='https:'){location.assign(u.href);return;}
    return original.call(this);};
    const open=window.open;window.open=function(url,...rest){const u=new URL(url,location.href);
    if(u.hostname==='qianchuan.jinritemai.com'&&u.protocol==='https:'){location.assign(u.href);return null;}
    return open.call(this,url,...rest);};click('账户明细');return true;''')
    def destination():
        state=ui.snapshot();url=urlsplit(state['url'])
        if url.hostname!='qianchuan.jinritemai.com':return False
        if url.path=='/login':raise ShopDeskError('needs_login: 千川需要登录或重新确认绑定账户')
        got=parse_qs(url.query).get('aavid',[''])[0]
        if got!=account:raise ShopDeskError('千川财务页面与抖店绑定广告账户不一致')
        return ui.js("return [...document.querySelectorAll('iframe')].map(e=>e.src).find(s=>s.includes('/cg_trade/finance'))||false;")
    try:frame=ui.wait(destination)
    except ShopDeskError as exc:
        if '仅能进入' in str(exc):raise ShopDeskError('ShopDesk needs the Qianchuan finance host patch; run tools/install_shopdesk_extension.py --install while idle') from exc
        raise
    parsed=urlsplit(frame);params=parse_qs(parsed.query)
    if parsed.scheme!='https' or parsed.hostname!='qianchuan.jinritemai.com' or not parsed.path.startswith('/cg_trade/finance') or params.get('aadvid')!=[account]:
        raise ShopDeskError('千川财务嵌入页面账户不一致')
    ui.bridge.command(ui.eid,'Page.navigate',{'url':frame});ui.bridge.ready(ui.eid)
    ui.wait(lambda:'流水对账' in ui.snapshot()['text'])
    ui.js("const e=document.querySelector('button[aria-label=\"关闭充值中心升级提示\"]');if(e)e.click();return true;")
    ui.click('流水对账');ui.wait(lambda:'日结报表' in ui.snapshot()['text'])
    ui.click('日结报表')
    ui.wait(lambda:any(i['placeholder']=='开始时间 ~ 结束时间' for i in ui.snapshot()['inputs']))
    return account


def _select_month(ui,month):
    start,end=month_bounds(month);last=end-timedelta(days=1)
    ui.js("const e=[...document.querySelectorAll('input')].find(e=>visible(e)&&e.placeholder==='开始时间 ~ 结束时间');if(!e)throw Error('Missing daily date picker');e.click();return true;")
    ui.wait(lambda:ui.js("return !!document.querySelector('.byted-finance-date-picker-popper');"))
    target=start.year*12+start.month
    for _ in range(240):
        title=ui.js("const p=document.querySelector('.byted-finance-date-view.byted-finance-date-position-start');return p?.querySelector('.byted-finance-date-title')?.innerText;")
        match=re.search(r'(\d{4})年\s*(\d{1,2})月',title or '')
        if not match:raise ShopDeskError('千川日期选择器月份无法识别')
        current=int(match[1])*12+int(match[2])
        if current==target:break
        # Start panel exposes previous month; end panel exposes next month.
        selector=('.byted-finance-date-position-start .byted-finance-icon-left' if current>target
                  else '.byted-finance-date-position-end .byted-finance-icon-right')
        ui.js("const e=document.querySelector(arg);if(!e)throw Error('Missing calendar month navigation');e.parentElement.click();return true;",selector)
        ui.wait(lambda:ui.js("return document.querySelector('.byted-finance-date-view.byted-finance-date-position-start .byted-finance-date-title')?.innerText!==arg;",title))
    else:raise ShopDeskError('千川日期超出可选择范围')
    ui.bridge.command(ui.eid,'events')
    for day in [1,last.day]:
        ui.js(r'''const p=document.querySelector('.byted-finance-date-view.byted-finance-date-position-start');
const cells=[...p.querySelectorAll('.byted-finance-date-item')].filter(e=>text(e)===String(arg)&&!/grid-prev|grid-next|disabled/.test(e.className));
if(cells.length!==1)throw Error('Requested daily date is unavailable');cells[0].click();return true;''',day)
    ui.js('document.body.click();return true;')
    expected=f'{start:%Y-%m-%d} ~ {last:%Y-%m-%d}'
    ui.wait(lambda:any(i['value']==expected for i in ui.snapshot()['inputs']))


def _query(ui,month,account):
    start,end=month_bounds(month);last=end-timedelta(days=1);requests={};finished=set();statuses={}
    def ready():
        for event in ui.bridge.command(ui.eid,'events').get('events',[]):
            if event.get('method')=='Network.requestWillBeSent' and urlsplit(event.get('url','')).path==DAILY_PATH:
                params=parse_qs(urlsplit(event['url']).query)
                if params.get('start_day')!=[start.strftime('%Y-%m-%d')] or params.get('end_day')!=[last.strftime('%Y-%m-%d')] or params.get('aadvid')!=[account]:
                    raise ShopDeskError('千川实际日结查询月份或广告账户不一致')
                requests[event['requestId']]=params
            if event.get('method')=='Network.loadingFinished':finished.add(event['requestId'])
            if event.get('method')=='Network.responseReceived':statuses[event['requestId']]=event.get('status')
        for rid,params in requests.items():
            if rid not in finished:continue
            if statuses.get(rid)!=200:raise ShopDeskError('千川官方日结查询 HTTP 失败')
            try:data=json.loads(ui.bridge.command(ui.eid,'Network.getResponseBody',{'requestId':rid})['result']['body'])
            except (KeyError,ValueError,ShopDeskError):continue
            if data.get('code')!=1 or data.get('msg')!='success':raise ShopDeskError('千川官方日结查询失败')
            payload=data.get('data',{});total=payload.get('page',{}).get('total')
            if type(total) is not int or total<0 or not isinstance(payload.get('result'),list):raise ShopDeskError('千川日结响应格式变化')
            return {'params':params,'total':total,'code':data['code']}
        return False
    return ui.wait(ready,timeout=25)


def collect(ui,month,root,manifest,*,advertiser_id=None,entity=None):
    account=_open(ui,advertiser_id,bound=True) if entity and advertiser_id else _open(ui,advertiser_id) if advertiser_id else _open(ui)
    entity=entity or {'id':account,'name':account}
    _select_month(ui,month)
    proof=_query(ui,month,account)
    def rendered():
        rows=ui.rows()
        dates=[r[0].strip() for r in rows if r and re.fullmatch(r'\d{4}-\d{2}-\d{2}',r[0].strip())]
        if proof['total']==0:return not dates and '暂无数据' in ui.snapshot()['text']
        return bool(dates) and all(day.startswith(month+'-') for day in dates)
    ui.wait(rendered)
    ui.js("const e=document.querySelector('button[aria-label=\"关闭充值中心升级提示\"]');if(e)e.click();return true;")
    shot={**ui.capture(root,'千川账户日结报表-'+account,month,width=2560),'excel_sheet':'千川账户','advertiser_id':account,
          'entity_id':account,'entity_name':entity['name'],
          'query':proof,'balance_as_of':None,'note':'官方千川日结报表明细；月末余额由同月下载文件按日期提取。'}
    manifest['screenshots'].append(shot)
    if proof['total']==0:
        manifest['collection'].append({'role':'qianchuan','status':'no_activity','advertiser_id':account,'entity':entity,'query':proof})
        return
    def trigger():
        start,end=month_bounds(month)
        return ui.js(r'''const follow=url=>{const u=new URL(url,location.href);
if(u.origin!==location.origin||u.pathname!=='/cg_trade/finance/backend/finance/transaction/download'
||u.searchParams.get('start_day')!==arg.start||u.searchParams.get('end_day')!==arg.end||u.searchParams.get('aadvid')!==arg.account)
throw Error('Qianchuan download account or period differs from verified query');
location.assign(u.href);};
window.open=function(url){follow(url);return null;};
HTMLAnchorElement.prototype.click=function(){follow(this.href);};
for(const label of ['下载明细','导出明细','下载报表','导出报表','导出']){
const e=exact(label)[0];if(e){e.click();return true;}}
const icons=[...document.querySelectorAll('[class*="daily-index-module__download-wrap"] img')].filter(visible);
if(icons.length===1){icons[0].click();return true;}
throw Error('Missing official Qianchuan daily export control');''',
                     {'start':start.strftime('%Y-%m-%d'),'end':(end-timedelta(days=1)).strftime('%Y-%m-%d'),'account':account})
    paths=ui.download(root,trigger)
    for path in paths:manifest['inputs'].append({'path':str(path),'sha256':sha256(path),'role':'qianchuan','account':'千川账户','advertiser_id':account,
                                                'entity_id':account,'entity_name':entity['name']})
    # Validate the real downloaded workbook before calling collection complete.
    from .model import Dataset
    from .parse import import_file
    from .qianchuan import statement
    check=Dataset({'month':month})
    for path in paths:import_file(check,path,root/'validation',role='qianchuan',account='千川账户')
    view,_=statement(check.table('qianchuan'),month,verified_counts={None:proof['total']})
    if sum(r.values['日期']!='总计' for r in view.rows)!=proof['total']:
        raise DataError('千川下载明细条数与官方同月查询记录数不一致')
    manifest['collection'].append({'role':'qianchuan','status':'downloaded','advertiser_id':account,'entity':entity,'query':proof})


def collect_all(ui,month,root,manifest):
    from .model import dump_json
    state=_entry(ui)
    if state=='not_opened':
        shot=ui.capture(root,'千川账户未开通',month)
        shot.update(excel_sheet='千川账户',query={'total':0},note='官方开户页可访问，当前没有可用账户数据；正常未开通状态。')
        manifest['screenshots'].append(shot)
        manifest['collection'].append({'role':'qianchuan','status':'not_opened','evidence':ui.snapshot()})
        dump_json(root/'collection.json',manifest)
        return
    if state=='detail':
        if ui.js("return exact('切换').length===1;"):
            ui.click('切换');ui.wait(lambda:bool(_accounts(ui)))
            accounts=_accounts(ui)
        else:
            account=parse_qs(urlsplit(ui.snapshot()['url']).query).get('aavid',[''])[0]
            if not re.fullmatch(r'\d+',account):raise ShopDeskError('千川入口没有明确绑定的广告账户ID')
            accounts=[{'id':account,'name':account}]
    else:accounts=_accounts(ui)
    if not accounts or len({a['id'] for a in accounts})!=len(accounts):raise ShopDeskError('千川绑定账户列表为空或重复')
    manifest.setdefault('entities',[]).extend({'role':'qianchuan',**a} for a in accounts)
    for entity in accounts:
        if any(r.get('role')=='qianchuan' and r.get('advertiser_id')==entity['id'] and r.get('status') in ['downloaded','no_activity'] for r in manifest['collection']):continue
        try:collect(ui,month,root,manifest,advertiser_id=entity['id'],entity=entity)
        except (ShopDeskError,DataError) as exc:
            manifest['collection'].append(collection_error('qianchuan',exc,advertiser_id=entity['id'],entity=entity))
        finally:dump_json(root/'collection.json',manifest)
