from douyin import check_platform_login
"""Read-only Douyin experience scores. CDP only supplies local session credentials.
Run with the workbench open and CDP enabled: python experience.py
No browser-page fallback during the timed HTTP stage; failures are reported.
"""
import json,time,sqlite3,os
from pathlib import Path
from datetime import datetime
from zoneinfo import ZoneInfo
from concurrent.futures import ThreadPoolExecutor
import requests
BASE='https://fxg.jinritemai.com'
ROOT=BASE+'/governance/shop/experiencescore/'
REF=BASE+'/ffa/eco/experience-score'

def score(value):
    return value if isinstance(value,(int,float)) and 0<=value<=100 else None

def parse(overview,analysis,name):
    for body in (overview,analysis):
        check_platform_login(body)
        if body.get('code')!=0 or body.get('st',0)!=0:raise ValueError('平台拒绝请求，请稍后重试')
    a=analysis['data'];o=overview['data']
    if a.get('shop_name')!=name:raise ValueError('店铺身份不匹配')
    grow=o.get('is_new_shop_score')
    if not isinstance(grow,bool):raise ValueError('体验分结构已变化')
    total=score(o.get('new_shop_info',{}).get('new_shop_score')) if grow else score(o.get('experience_score',{}).get('value'))
    if total is None:raise ValueError('未取得有效总分')
    fields={k:None if grow else score(o.get(key,{}).get('value')) for k,key in [('goods','goods_score'),('logistics','logistics_score'),('service','service_score')]}
    if not grow and any(v is None for v in fields.values()):raise ValueError('正式阶段分项缺失')
    return {'name':name,'platform_shop_id':str(a['shop_id']),'total':total,**fields,'stage':'成长阶段' if grow else '正式阶段','updated_at':datetime.fromtimestamp(o['update_time'],ZoneInfo('Asia/Shanghai')).isoformat(),'source':ROOT+'getOverviewByVersion'}

def fetch(item):
    started=time.perf_counter();s=requests.Session();s.trust_env=False
    try:
        for c in item['cookies']:s.cookies.set(c['name'],c['value'],domain=c['domain'],path=c.get('path','/'),secure=c.get('secure',True))
        s.headers.update({'User-Agent':item['ua'],'Referer':REF,'Accept':'application/json'})
        def get(endpoint,extra):
            r=s.get(ROOT+endpoint,params={'exp_version':'release','new_shop_version':'release',**extra},timeout=(5,20),allow_redirects=False)
            if r.status_code!=200:raise ValueError('平台 HTTP 请求失败')
            return r.json()
        o=get('getOverviewByVersion',{'source':'1'})
        a=get('getAnalysisScore',{'number_type':'30 '})
        result=parse(o,a,item['name'])
        return {'shop_id':item['id'],'status':'ok',**result,'http_seconds':round(time.perf_counter()-started,3)}
    except Exception as e:
        return {'shop_id':item['id'],'name':item['name'],'status':'error','error':str(e) if type(e) is ValueError else '请求或解析失败','http_seconds':round(time.perf_counter()-started,3)}
    finally:s.cookies.clear();s.close();item['cookies'].clear()

def main():
    from bridge import CDP,targets,shell
    begin=time.perf_counter();ui=shell()
    try:shops=[s for s in ui.evaluate('window.shops.list()') if s['platform']=='抖店']
    finally:ui.close()
    items=[];seen=set()
    for t in targets():
        if t.get('type')!='page' or not t['url'].startswith(BASE+'/'):continue
        c=CDP(t)
        try:
            lines=c.evaluate('document.body.innerText.split("\\n").map(s=>s.trim())')
            matches=[s for s in shops if s['name'] in lines]
            if len(matches)!=1:continue
            shop=matches[0]
            if shop['id'] in seen:raise ValueError('同店多个页面，请关闭重复页面')
            seen.add(shop['id'])
            items.append({'id':shop['id'],'name':shop['name'],'cookies':c.call('Network.getCookies',{'urls':[ROOT]})['cookies'],'ua':c.evaluate('navigator.userAgent')})
        finally:c.close()
    prep=time.perf_counter()-begin;http=time.perf_counter()
    with ThreadPoolExecutor(max_workers=3) as pool:results=list(pool.map(fetch,items))
    http=time.perf_counter()-http
    for shop in shops:
        if shop['id'] not in seen:results.append({'shop_id':shop['id'],'name':shop['name'],'status':'error','error':'请先在工作台打开该店铺'})
    save=time.perf_counter();out=Path(__file__).resolve().parents[1]/'local-data';out.mkdir(exist_ok=True,mode=0o700)
    run=datetime.now(ZoneInfo('Asia/Shanghai')).isoformat()
    with sqlite3.connect(out/'business.sqlite3') as db:
        db.execute('CREATE TABLE IF NOT EXISTS experience_snapshots (run TEXT, shop_id TEXT, data TEXT, PRIMARY KEY(run,shop_id))')
        for row in results:db.execute('INSERT INTO experience_snapshots VALUES (?,?,?)',(run,row['shop_id'],json.dumps(row,ensure_ascii=False)))
    report={'captured_at':run,'concurrency':3,'shop_count':len(shops),'success':sum(r['status']=='ok' for r in results),'prepare_seconds':round(prep,3),'python_http_seconds':round(http,3),'database_seconds':round(time.perf_counter()-save,3),'total_seconds':round(time.perf_counter()-begin,3),'results':results}
    (out/'experience-latest.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
    os.chmod(out/'experience-latest.json',0o600)
    print(json.dumps(report,ensure_ascii=False,indent=2))
if __name__=='__main__':main()
