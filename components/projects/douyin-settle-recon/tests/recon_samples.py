from datetime import timedelta
from douyin_settle_recon.model import month_bounds


def q_receipt(total=0,month='2026-09',account='123'):
    start,end=month_bounds(month)
    return {'role':'qianchuan','status':'no_activity' if total==0 else 'downloaded','advertiser_id':account,
            'entity':{'id':account,'name':'测试广告账户'},'query':{'total':total,'code':1,'params':{
                'aadvid':[account],'start_day':[start.strftime('%Y-%m-%d')],
                'end_day':[(end-timedelta(days=1)).strftime('%Y-%m-%d')]}}}


def empty_collection(month='2026-09'):
    from douyin_settle_recon.collect import KINDS
    return [q_receipt(month=month) if k=='qianchuan' else {'role':k,'status':'no_activity'} for k in KINDS]
