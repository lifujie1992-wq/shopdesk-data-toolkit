from douyin import check_platform_login
"""Verified read-only shipped refund-only aftersale counts; no order PII persisted."""
import time,requests
from datetime import datetime,timedelta
from zoneinfo import ZoneInfo
from experience import ROOT as SCORE_ROOT
BASE='https://fxg.jinritemai.com'
API=BASE+'/after_sale/pc/list'
REFERER=BASE+'/ffa/merchant-aftersale-workbench/aftersale/list'

def period(days=30):
    now=datetime.now(ZoneInfo('Asia/Shanghai'))
    start=(now-timedelta(days=days-1)).replace(hour=0,minute=0,second=0,microsecond=0)
    end=now.replace(hour=23,minute=59,second=59,microsecond=0)
    return {'start':start.isoformat(),'end':end.isoformat(),'start_epoch':int(start.timestamp()),'end_epoch':int(end.timestamp())}

def parse(body):
    check_platform_login(body)
    if body.get('code')!=0 or body.get('st',0)!=0:raise ValueError('平台拒绝请求，请稍后重试')
    total=body.get('total');data=body.get('data',{})
    if type(total) is not int or total<0 or not isinstance(data.get('items'),list):raise ValueError('售后接口结构变化，未计入')
    if total<len(data['items']):raise ValueError('售后总数与列表不一致')
    return total

def fetch(item,span):
    started=time.perf_counter();s=requests.Session();s.trust_env=False
    try:
        for c in item['cookies']:s.cookies.set(c['name'],c['value'],domain=c['domain'],path=c.get('path','/'),secure=c.get('secure',True))
        s.headers.update({'User-Agent':item['ua'],'Referer':REFERER,'Accept':'application/json'})
        r=s.get(SCORE_ROOT+'getAnalysisScore',params={'exp_version':'release','new_shop_version':'release','number_type':'30 '},timeout=(5,20),allow_redirects=False)
        if r.status_code!=200:raise ValueError('店铺身份接口请求失败')
        identity=r.json()
        check_platform_login(identity)
        if identity.get('code')!=0 or identity.get('st',0)!=0 or identity.get('data',{}).get('shop_name')!=item['name']:raise ValueError('店铺身份校验失败')
        body={'pageSize':10,'page':1,'order_by':['status_deadline asc'],'conf_version':'v13','search_receiver':'','after_sale_status':'','after_sale_type':'refund','reason':'','negotiate_status':'','order_flag':[],'order_logistics_state':[],'apply_time_start':span['start_epoch'],'apply_time_end':span['end_epoch'],'shop_hit_gray_info':{'list_v1':{'hit':True}}}
        r=s.post(API,params={'appid':'1','_bid':'ffa_aftersale','aid':'4272','aftersale_platform_source':'fxg'},json=body,timeout=(5,20),allow_redirects=False)
        if r.status_code!=200:raise ValueError('售后 HTTP 请求失败')
        total=parse(r.json())
        return {'shop_id':item['id'],'name':item['name'],'status':'ok','count':total,'unit':'售后单','filter':'已发货退款','status_filter':'全部售后状态','time_basis':'售后申请时间','period':span,'captured_at':datetime.now(ZoneInfo('Asia/Shanghai')).isoformat(),'source':API,'http_seconds':round(time.perf_counter()-started,3)}
    except Exception as e:
        return {'shop_id':item['id'],'name':item['name'],'status':'error','error':str(e) if type(e) is ValueError else '请求或解析失败','http_seconds':round(time.perf_counter()-started,3)}
    finally:s.cookies.clear();s.close();item['cookies'].clear()
