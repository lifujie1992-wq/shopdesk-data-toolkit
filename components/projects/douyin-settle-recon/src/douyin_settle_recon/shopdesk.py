from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from pathlib import Path


class ShopDeskError(RuntimeError):
    def __init__(self, message, code=None):
        super().__init__(message)
        self.code = code


class ShopDesk:
    def __init__(self, bridge: Path | None = None):
        self.bridge = bridge or Path.home() / 'Library/Application Support/shopdesk/agent-bridge.json'
        # Loopback bridge must never consult macOS/system proxy discovery. That can
        # hang before socket timeouts apply, even for requests to 127.0.0.1.
        self._pool_checked = False
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def call(self, method: str, args: dict | None = None, timeout: float = 45):
        try:
            cfg = json.loads(self.bridge.read_text())
            port = int(cfg['port'])
            if not 1 <= port <= 65535:
                raise ValueError('invalid port')
            request = urllib.request.Request(
                f'http://127.0.0.1:{port}/call',
                data=json.dumps({'method': method, 'args': args or {}}, ensure_ascii=False).encode(),
                headers={'Authorization': 'Bearer ' + cfg['token'], 'Content-Type': 'application/json',
                         'X-ShopDesk-Client': 'codex-skill'},
            )
            with self.opener.open(request, timeout=timeout) as response:
                result = json.load(response)
        except urllib.error.HTTPError as exc:
            try:
                problem = json.load(exc)
                message = problem.get('error', 'bridge rejected request')
            except (ValueError, AttributeError):
                problem, message = {}, 'bridge rejected request'
            raise ShopDeskError(message, problem.get('code')) from None
        except (OSError, ValueError, KeyError) as exc:
            raise ShopDeskError(f'ShopDesk unavailable ({type(exc).__name__}); start the workbench first',
                                'BRIDGE_TIMEOUT' if isinstance(exc,TimeoutError) else None) from None
        if 'error' in result:
            raise ShopDeskError(result['error'], result.get('code'))
        return result['result']

    def shops(self):
        try:
            shops=self.call('list_shops',timeout=5)['shops']
        except ShopDeskError as exc:
            if exc.code!='BRIDGE_TIMEOUT':raise
            # list_shops shares a queue with unrelated long-running jobs. The
            # exploration pool is isolated, so check that it is alive before
            # reading the same atomic store used by the workbench's shop list.
            status=self.call('exploration_status',timeout=5)
            if status.get('version',0)<2:raise exc
            try:
                saved=json.loads(self.bridge.with_name('shops.json').read_text())
                if not isinstance(saved,list) or not saved:raise ValueError('empty shop store')
                fields=['id','name','platform']
                if any(not isinstance(s,dict) or any(not isinstance(s.get(k),str) or not s[k].strip() for k in fields) for s in saved):
                    raise ValueError('invalid shop store')
                if len({s['id'] for s in saved})!=len(saved):raise ValueError('duplicate shop IDs')
                shops=[{k:s[k] for k in fields} for s in saved]
            except (OSError,ValueError,KeyError):
                raise ShopDeskError('ShopDesk shop-list queue timed out and its saved shop list is unavailable','SHOP_LIST_UNAVAILABLE') from None
        return [s for s in shops if s['platform'] == '抖店']

    def start(self, shop_id, url, wait_timeout=60):
        if not self._pool_checked:
            status = self.call('exploration_status', timeout=10)
            if status.get('version', 0) < 2:
                raise ShopDeskError('Upgrade ShopDesk exploration pool before collecting', 'EXPLORATION_UPGRADE_REQUIRED')
            self._pool_checked = True
        deadline = time.monotonic() + wait_timeout
        while True:
            try:
                return self.call('start_exploration', {'shop_id': shop_id, 'url': url, 'owner': 'douyin-settle-recon'})['id']
            except ShopDeskError as exc:
                if exc.code != 'EXPLORATION_BUSY':
                    raise
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise ShopDeskError('等待后台页面名额超时', 'EXPLORATION_WAIT_TIMEOUT') from None
                time.sleep(min(1, remaining))

    def command(self, eid, method, params=None):
        return self.call('exploration_command', {'id': eid, 'method': method, 'params': params or {}})

    def evaluate(self, eid, expression):
        data = self.command(eid, 'Runtime.evaluate', {'expression': expression})['result']
        if data.get('exceptionDetails'):
            exc = data['exceptionDetails']
            raise ShopDeskError(exc.get('exception', {}).get('description', exc.get('text', 'page script failed')))
        return data.get('result', {}).get('value')

    def ready(self, eid, timeout=40):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            info = self.command(eid, 'events')
            if not info.get('loading'):
                state = self.evaluate(eid, '({url:location.href,text:document.body?.innerText?.slice(0,1000)||""})')
                if 'login' in state.get('url', '').lower() or '登录已失效' in state.get('text', ''):
                    raise ShopDeskError('needs_login: open the shop in ShopDesk and sign in')
                if state.get('text'):
                    return state
            time.sleep(.5)
        raise ShopDeskError('finance page did not become ready')

    def close(self, eid):
        # The bridge extension checks ownership; never close someone else's exploration.
        return self.command(eid, 'finance_close')
