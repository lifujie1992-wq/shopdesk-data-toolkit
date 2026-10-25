import importlib.util
import json
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('counts', Path(__file__).resolve().parents[1] / 'bin/scrape_counts.py')
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)

class PoolTests(unittest.TestCase):
    def test_busy_waits_then_opens_without_closing_any_page(self):
        now, calls = [0], []
        def call(payload):
            calls.append(payload)
            return {'error':'busy','code':'EXPLORATION_BUSY'} if len(calls)<3 else {'result':{'id':'own'}}
        budget = {'remaining':120}
        result = c.acquire_page(call, {'id':'a'}, budget, clock=lambda:now[0], sleep=lambda n:now.__setitem__(0,now[0]+n))
        self.assertEqual(result['result']['id'],'own')
        self.assertEqual(budget['remaining'],118)
        self.assertTrue(all(x['method']=='start_exploration' for x in calls))

    def test_wait_budget_is_bounded_and_nonbusy_does_not_retry(self):
        now, calls = [0], []
        def busy(payload):
            calls.append(payload)
            return {'error':'busy','code':'EXPLORATION_BUSY'}
        budget={'remaining':2}
        result=c.acquire_page(busy,{'id':'a'},budget,clock=lambda:now[0],sleep=lambda n:now.__setitem__(0,now[0]+n))
        self.assertEqual(result['code'],'EXPLORATION_WAIT_TIMEOUT')
        self.assertEqual((len(calls),budget['remaining']),(3,0))
        calls.clear()
        result=c.acquire_page(lambda p: calls.append(p) or {'error':'login','code':'OTHER'}, {'id':'a'}, budget)
        self.assertEqual(result['code'],'OTHER');self.assertEqual(len(calls),1)

    def test_login_failure_closes_only_returned_page(self):
        calls=[]
        def call(payload,**kwargs):
            calls.append(payload)
            if payload['method']=='start_exploration':return {'result':{'id':'own'}}
            if payload['method']=='exploration_command':
                return {'result':{'result':{'result':{'value':json.dumps({'u':'https://fxg.jinritemai.com/login','s':'complete'})}}}}
            return {'result':{}}
        with patch.object(c.time,'sleep'):
            self.assertEqual(c.fetch_shop(call,{'id':'a'})['status'],'needs_login')
        self.assertEqual(calls[-1],{'method':'close_exploration','args':{'id':'own'}})

    def test_failed_shops_retry_once_at_round_end_and_final_result_replaces_failure(self):
        order=[]
        def fetch(call,shop,budget):
            order.append(shop['id'])
            return {'status':'error','error':'full'} if order==['a'] else {'status':'ok','counts':{k:0 for k in c.DB_COLS}}
        with patch.object(c,'log'):
            records=c.collect_shops(None,[{'id':'a'},{'id':'b'}],quiet=True,fetch=fetch)
        self.assertEqual(order,['a','b','a']);self.assertEqual(len(records),2)
        self.assertTrue(all(r['status']=='ok' for r in records))
        run={'run_id':'x','finished_at':'now','shops':records,'shops_total':2,'shops_ok':2}
        self.assertEqual(c.final_status(run)['exit_code'],0)
        with patch.object(c,'log'):
            records=c.collect_shops(None,[{'id':'a','name':'A'}],quiet=True,fetch=lambda *_:{'status':'error','error':'timeout'})
        run.update(shops=records,shops_total=1,shops_ok=0)
        status=c.final_status(run)
        self.assertEqual(status['exit_code'],2);self.assertTrue(status['retry_complete'])
        self.assertEqual(status['errors'],[{'shop':'A','reason':'timeout'}])

if __name__=='__main__':unittest.main()
