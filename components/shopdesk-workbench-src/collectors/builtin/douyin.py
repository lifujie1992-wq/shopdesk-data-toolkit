import re,requests,json
from datetime import datetime
from zoneinfo import ZoneInfo
API='https://fxg.jinritemai.com/pc/api/home/homepage'
HOME='https://fxg.jinritemai.com/ffa/mshop/homepage/index'
LABELS={'成交金额':'sales','成交订单数':'orders','待发货':'shipping','待处理售后':'aftersales','投放消耗（店铺被投）':'ad'}
def check_platform_login(payload):
    if payload.get('code')==0 and payload.get('st',0)==0:return
    message=str(payload.get('msg') or payload.get('message') or '')
    if re.search(r'安全验证|身份验证|请完成.{0,8}验证',message):raise ValueError('VERIFICATION_REQUIRED: 需要完成平台验证，请打开店铺处理')
    # 只认平台明确的登录失效信号（code=10008/st=10000，或消息明确说"登录已失效"）。
    # 早先这里还匹配过宽的 "未登录"，导致接口因风控/限流返回 "xxx未登录" 时被误判成掉线；
    # 其余情况一律当作普通失败，交由调用方用真页面复核。
    if str(payload.get('code'))=='10008' and str(payload.get('st'))=='10000':raise ValueError('LOGIN_REQUIRED: 登录已失效，请重新扫码登录')
    if re.search(r'登录(?:信息)?已失效|登录已过期|登录过期|请重新登录',message):raise ValueError('LOGIN_REQUIRED: 登录已失效，请重新扫码登录')

def numeric(v):
    s=str(v).strip().replace(',','');m=re.fullmatch(r'[¥￥]?(-?\d+(?:\.\d+)?)(万|亿)?',s)
    return float(m[1])*({'万':10000,'亿':100000000}.get(m[2],1)) if m else None

def parse_home(payload,expected_name,expected_id=None):
    check_platform_login(payload)
    if payload.get('code')!=0 or payload.get('st',0)!=0:raise ValueError('平台拒绝请求，请稍后重试')
    layouts=payload.get('data',{}).get('lay_out_data');
    if not isinstance(layouts,list):raise ValueError('Dashboard schema changed')
    cards=[c for layout in layouts for c in layout.get('cards',[])]
    identity=None;values={};source_labels={};observed=[];masked=set()
    for card in cards:
        data=card.get('data') or {}
        raw=(card.get('custom_data') or {}).get('pc_refund_diagnose_data')
        if raw:
            try:
                refund=json.loads(raw).get('general_index',{})
                if any(m.get('index_display')=='7日退款金额' and m.get('index_name')=='refund_amt' for m in refund.get('basic_meta',[])):
                    val=refund['data'][0]['refund_amt']['index_value']['value']
                    if val.get('unit')==3 and isinstance(val.get('value'),(int,float)):
                        values['refund7']=round(val['value']/100,2);source_labels['refund7']='7日退款金额'
            except (ValueError,KeyError,IndexError,TypeError):pass
        info=data.get('shop_info_card_data',{}).get('base_info')
        if info:identity={'name':info.get('name'),'platform_id':str(info.get('douyin_shop_info',{}).get('shop_id',''))}
        for item in data.get('todo_list_card_data',{}).get('todo_list',[])+data.get('operating_data_card_v4_data',{}).get('compass_list',[]):
            label=item.get('title');raw=item.get('val');value=numeric(raw)
            # 抖店会对部分账号把金额/订单数脱敏成 ****：这不是采集失败，要单独说清楚
            if label in LABELS and isinstance(raw,str) and '*' in raw:masked.add(label)
            if label in LABELS:
                key=LABELS[label];values[key]=value;source_labels[key]=label
            observed.append({'label':label,'value':value})
    if not identity or identity['name']!=expected_name:raise ValueError('店铺名称与平台不一致（平台现名：%s，本地记录：%s），店铺可能已改名：请在工作台把店铺名称改成平台现名后重试'%(identity['name'] if identity else '未读取到',expected_name))
    if expected_id and identity['platform_id']!=expected_id:raise ValueError('Platform shop ID mismatch; rejected')
    if not identity['platform_id'] or identity['platform_id']=='0':identity['platform_id']=None
    if any(values.get(k) is None for k in ('sales','orders','shipping','aftersales')):
        if masked:raise ValueError('平台已隐藏本店经营数据（%s 显示为 ****），与采集程序无关，请到抖店后台确认该账号的数据/资金查看权限'%('、'.join(sorted(masked))))
        raise ValueError('Required metrics unavailable; rejected')
    if any(v is not None and v<0 for v in values.values()):raise ValueError('Invalid metric value')
    return {'identity':identity,'metrics':values,'source_labels':source_labels,'period':'平台实时 / 当前待办','captured_at':datetime.now(ZoneInfo('Asia/Shanghai')).isoformat(),'source_url':API,'observed':observed}

def direct_credentials(cookies,agent,expected_name,expected_id=None):
    # Credentials stay in memory and can only be sent to this fixed HTTPS endpoint.
    s=requests.Session();s.trust_env=False
    try:
        for cookie in cookies:s.cookies.set(cookie['name'],cookie['value'],domain=cookie['domain'],path=cookie.get('path','/'),secure=cookie.get('secure',True))
        r=s.get(API,params={'meet_redirect_grey':'true','source':'1','homepage_version':'202606240','appid':'1','_bid':'ffa_shop'},headers={'User-Agent':agent,'Accept':'application/json','Referer':HOME},allow_redirects=False,timeout=(5,20))
        if r.status_code!=200:raise ValueError('Direct HTTP status %s; use CDP fallback'%r.status_code)
        try:body=r.json()
        except ValueError:raise ValueError('Direct response was not JSON; use CDP fallback') from None
        return parse_home(body,expected_name,expected_id)
    except requests.RequestException:raise ValueError('Direct network request failed; use CDP fallback') from None
    finally:s.cookies.clear();s.close();cookies.clear()


def direct_home(c,expected_name,expected_id=None):
    cookies=c.call('Network.getCookies',{'urls':[API]})['cookies']
    return direct_credentials(cookies,c.evaluate('navigator.userAgent'),expected_name,expected_id)
