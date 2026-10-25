import pytest
import json
from douyin_settle_recon.shopdesk import ShopDesk, ShopDeskError


def test_shop_list_timeout_reads_atomic_store_only_when_pool_is_alive(tmp_path):
    b=ShopDesk(tmp_path/'agent-bridge.json');calls=[]
    (tmp_path/'shops.json').write_text(json.dumps([
        {'id':'shop-1','name':'最新店名','platform':'抖店','note':'private'},
        {'id':'shop-2','name':'其他平台','platform':'淘宝'}]))
    def call(method,**kwargs):
        calls.append(method)
        if method=='list_shops':raise ShopDeskError('timed out','BRIDGE_TIMEOUT')
        return {'version':2,'active':0}
    b.call=call
    assert b.shops()==[{'id':'shop-1','name':'最新店名','platform':'抖店'}]
    assert calls==['list_shops','exploration_status']
    (tmp_path/'shops.json').write_text('[]')
    with pytest.raises(ShopDeskError) as error:b.shops()
    assert error.value.code=='SHOP_LIST_UNAVAILABLE'


@pytest.mark.parametrize('code',[None,'BRIDGE_TIMEOUT','FORBIDDEN'])
def test_shop_list_does_not_present_an_offline_store_as_live(tmp_path,code):
    b=ShopDesk(tmp_path/'agent-bridge.json')
    (tmp_path/'shops.json').write_text(json.dumps([{'id':'shop','name':'店铺','platform':'抖店'}]))
    def call(*args,**kwargs):raise ShopDeskError('offline or rejected',code)
    b.call=call
    with pytest.raises(ShopDeskError):b.shops()

def test_busy_waits_without_closing(monkeypatch):
    b=ShopDesk();calls=[];now=[0]
    monkeypatch.setattr('douyin_settle_recon.shopdesk.time.monotonic',lambda:now[0])
    monkeypatch.setattr('douyin_settle_recon.shopdesk.time.sleep',lambda n:now.__setitem__(0,now[0]+n))
    def call(method,args=None,**kwargs):
        calls.append((method,args))
        if method=='exploration_status':return {'version':2}
        if len(calls)<4:raise ShopDeskError('full','EXPLORATION_BUSY')
        return {'id':'mine'}
    b.call=call
    assert b.start('a','https://fxg.jinritemai.com/')=='mine'
    assert now[0]==2
    assert [m for m,a in calls]==['exploration_status']+['start_exploration']*3
    b.command=lambda eid,method:(eid,method)
    assert b.close('mine')==('mine','finance_close')

def test_busy_timeout_and_other_errors_are_finite(monkeypatch):
    b=ShopDesk();b._pool_checked=True;now=[0]
    monkeypatch.setattr('douyin_settle_recon.shopdesk.time.monotonic',lambda:now[0])
    monkeypatch.setattr('douyin_settle_recon.shopdesk.time.sleep',lambda n:now.__setitem__(0,now[0]+n))
    def busy(*args,**kwargs):raise ShopDeskError('full','EXPLORATION_BUSY')
    b.call=busy
    with pytest.raises(ShopDeskError) as err:b.start('a','url',wait_timeout=2)
    assert err.value.code=='EXPLORATION_WAIT_TIMEOUT';assert now[0]==2
    def other(*args,**kwargs):raise ShopDeskError('invalid','INVALID')
    b.call=other
    with pytest.raises(ShopDeskError) as err:b.start('a','url')
    assert err.value.code=='INVALID';assert now[0]==2

def test_requires_pool_before_opening():
    b=ShopDesk();calls=[]
    b.call=lambda method,**kwargs:calls.append(method) or {'version':1}
    with pytest.raises(ShopDeskError):b.start('a','url')
    assert calls==['exploration_status']


def test_snapshot_is_readable_while_navigation_has_no_body():
    import json
    import subprocess
    from douyin_settle_recon.collect import UI
    class Bridge:
        def evaluate(self, eid, expression):
            script = "global.document={body:null,querySelectorAll:()=>[]};global.location={href:'https://fxg.jinritemai.com/'};console.log(JSON.stringify(eval(process.argv[1])));"
            result = subprocess.run(['node', '-e', script, expression], capture_output=True, text=True, check=True)
            return json.loads(result.stdout)
    state = UI(Bridge(), 'test').snapshot()
    assert state['text'] == '' and state['inputs'] == []
