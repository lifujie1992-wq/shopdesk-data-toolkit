import json,urllib.request,os,time,datetime
ST=os.path.expanduser('~/Library/Application Support/shopdesk/agent-bridge.json')
def call(method,args=None):
    st=json.load(open(ST))
    p=json.dumps({"method":method,"args":args or {}}).encode()
    req=urllib.request.Request('http://127.0.0.1:%d/call'%st['port'],data=p,headers={'Authorization':'Bearer '+st['token'],'Content-Type':'application/json'})
    return json.load(urllib.request.urlopen(req,timeout=120))
# 等开跑
time.sleep(5)
for i in range(720):   # 最多 6 小时
    try:
        st=call('auto_appeal_status')['result']
    except Exception:
        time.sleep(30); continue
    if not st.get('running'):
        log=st.get('log',[])
        sub=[e for e in log if e.get('result')=='已提交']
        from collections import Counter
        sk=Counter(e.get('reason') for e in log if e.get('result')=='跳过')
        unf=[e for e in log if e.get('result')=='未提交']
        try: results=json.load(open(os.path.expanduser('~/Library/Application Support/shopdesk/appeal-reports/results.json')))['map']
        except Exception: results={}
        rej=Counter()
        for oid,v in results.items():
            if v.get('auditStatus')==3:
                m=(v.get('resultMsg') or '').replace('失败原因:','').split(';平台建议')[0].strip()
                rej[m]+=1
        out=[]
        out.append('申诉自动跑汇总')
        out.append('开始: %s'%st.get('startedAt'))
        out.append('结束: %s'%st.get('finishedAt'))
        out.append('候选: %s'%((st.get('summary') or {}).get('candidates')))
        out.append('')
        out.append('✅ 已提交 %d 单'%len(sub))
        for e in sub: out.append('   %s | %s | %s'%(e.get('shop'),e.get('order'),e.get('submitReason') or ''))
        out.append('')
        out.append('⏭ 跳过 %d 单'%sum(sk.values()))
        for k,v in sk.most_common(): out.append('   %s : %d'%(k,v))
        if unf:
            out.append(''); out.append('⚠️ 未提交 %d 单'%len(unf))
            for e in unf[:20]: out.append('   %s | %s'%(e.get('shop'),e.get('order')))
        if rej:
            out.append(''); out.append('❌ 平台驳回 TOP（含手动提交）')
            for k,v in rej.most_common(): out.append('   %d 条 | %s'%(v,k))
        f=os.path.expanduser('~/Desktop/申诉汇总-%s.txt'%datetime.datetime.now().strftime('%m%d-%H%M'))
        open(f,'w').write('\n'.join(out))
        print('DONE ->',f)
        break
    time.sleep(30)
