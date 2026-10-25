"""Read only the current shop identity from a fresh official Douyin page."""
from datetime import datetime, timezone
import re

from .model import DataError
from .shopdesk import ShopDesk, ShopDeskError

PLATFORM = 'douyin'
IDENTITY_PAGE = 'https://fxg.jinritemai.com/ffa/fxg-bill/fund-detail-bill'


def validate_identity(identity, expected_id=None):
    if not isinstance(identity,dict) or identity.get('platform')!=PLATFORM:
        raise DataError('shop identity must come from the Douyin platform')
    shop_id=identity.get('shop_id');name=identity.get('shop_name')
    if not isinstance(shop_id,str) or not re.fullmatch(r'[1-9][0-9]*',shop_id):
        raise DataError('official platform shop ID is missing or invalid')
    if not isinstance(name,str) or not name.strip() or len(name)>255 or any(ord(c)<32 for c in name):
        raise DataError('official platform shop name is missing or invalid')
    if expected_id is not None and str(expected_id)!=shop_id:
        raise DataError('current login belongs to a different platform shop')
    return identity


def read_shop_identity(ui):
    # Navigate to a new official document, rather than reading an old workbench
    # label, a historical export task or an advertising-account profile.
    ui.bridge.command(ui.eid,'Page.navigate',{'url':IDENTITY_PAGE})
    ui.bridge.ready(ui.eid)
    def ready():
        return ui.js(r'''if(location.origin!=='https://fxg.jinritemai.com')throw Error('Shop identity requires the official Douyin origin');
const info=window.__INITIAL_USER_INFO__;
if(!info)return null;
if(info.code!==0)throw Error('Official shop identity response failed');
const d=info.data;
if(!d||!d.id||!d.shop_name)return null;
if(typeof d.id==='number'&&!Number.isSafeInteger(d.id))throw Error('Unsafe numeric platform shop ID');
const id=String(d.id);
if(window.__shop_id!=null&&String(window.__shop_id)!==id)throw Error('Official shop identity fields disagree');
const name=document.querySelector('[class*=index_shopTitle] [title]')?.getAttribute('title');
if(name&&name!==d.shop_name)return null;
// Never return the rest of __INITIAL_USER_INFO__: it also contains credentials.
return {platform:'douyin',shop_id:id,shop_name:d.shop_name};''')
    value=validate_identity(ui.wait(ready))
    return {**value,'observed_at':datetime.now(timezone.utc).isoformat(),
            'source':'official_platform_bootstrap','page':IDENTITY_PAGE}


def fetch_shop_identity(shopdesk_uuid, expected_id=None):
    if not isinstance(shopdesk_uuid,str) or not shopdesk_uuid.strip():
        raise DataError('fresh platform identity requires the ShopDesk login UUID; provide --shop when importing')
    from .collect import UI
    bridge=ShopDesk();eid=bridge.start(shopdesk_uuid,IDENTITY_PAGE)
    try:
        return validate_identity(read_shop_identity(UI(bridge,eid)),expected_id)
    finally:
        try:bridge.close(eid)
        except ShopDeskError:pass
