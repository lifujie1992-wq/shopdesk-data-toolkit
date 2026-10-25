"""Exercise real selector JavaScript against a remounting cascader DOM."""
import json
import subprocess

import pytest

from douyin_settle_recon.collect import UI, _select_tax_month


DOM=r'''
let state=JSON.parse(process.argv[1]);
global.MouseEvent=class {};
global.getComputedStyle=e=>({visibility:'visible'});
const node=(text,extra={})=>({innerText:text,textContent:text,children:[],
 getClientRects(){return [1]},querySelectorAll(){return []},querySelector(){return null},...extra});
const label=node('选择时间'),view=node('按月度看',{click(){state.view='MONTH'}});
const content=node('',{dispatchEvent(){},click(){state.open=!state.open}});
const combo=node('',{parentElement:content,getAttribute:k=>k==='aria-expanded'?String(state.open):null});
const wrapper=node('',{querySelector:s=>s==='[role=combobox]'?combo:null,
 querySelectorAll:s=>s==='.aurora-select-selection-item[title]'?state.selected.map(title=>node(title,{
 title,querySelector:s=>s==='.aurora-select-selection-item-remove'?node('',{click(){
 state.selected=state.selected.filter(x=>x!==title);state.open=false;state.removed.push(title);
 }}):null})):[]});
label.parentElement=wrapper;
global.document={querySelectorAll(s){
 if(s==='.aurora-cascader-menu-item[title]'){
  if(!state.open)return [];
  if(state.remount){state.remount=false;state.open=false;return [];}
  const years=['2025年','2026年'].map(title=>node(title,{title,click(){state.year=title;state.yearClicks.push(title)}}));
  const months=state.year?Array.from({length:12},(_,i)=>{const title=(i+1)+'月';return node(title,{title,
   getAttribute:k=>k==='aria-checked'?String(state.selected.includes(state.year+title)):null,
   click(){state.selected.push(state.year+title);state.open=false;}})}):[];
  return [...years,...months];
 }
 if(state.viewRemount>0){state.viewRemount--;return [label];}
 return [label,view];
}};
let value=eval(process.argv[2]);console.log(JSON.stringify({state,value}));
'''


class DOMBridge:
    def __init__(self,remount,view_remount=False):
        self.state={'selected':['2025年12月','2026年8月'],'open':False,'remount':remount,'removed':[],'yearClicks':[],
                    'viewRemount':1 if view_remount else 0}
    def evaluate(self,eid,expression):
        result=subprocess.run(['node','-e',DOM,json.dumps(self.state),expression],capture_output=True,text=True,check=True)
        output=json.loads(result.stdout);self.state=output['state'];return output.get('value')


class TaxUI(UI):
    def wait(self,callback,**kwargs):
        for _ in range(8):
            result=callback()
            if result:return result
        raise AssertionError('selector never became ready')


@pytest.mark.parametrize('remount',[False,True])
@pytest.mark.parametrize('view_remount',[False,True])
def test_month_selection_clears_other_years_and_recovers_when_menu_remounts(remount,view_remount):
    bridge=DOMBridge(remount,view_remount);ui=TaxUI(bridge,'test')
    _select_tax_month(ui,'2026-09')
    assert bridge.state['selected']==['2026年9月']
    assert bridge.state['removed']==['2025年12月','2026年8月']
    assert bridge.state['yearClicks']==['2026年']
    assert bridge.state['view']=='MONTH' and bridge.state['open'] is False
