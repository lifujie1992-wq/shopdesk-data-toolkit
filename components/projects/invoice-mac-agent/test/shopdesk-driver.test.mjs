import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createShopdeskInvoiceDriver, ShopdeskBridgeError} from '../shopdesk-invoice-driver.mjs';

async function serverWith(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    port: server.address().port,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

test('driver 调用本机 bridge 并发送 Bearer token', async () => {
  let request = null;
  const server = await serverWith(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    request = {authorization: req.headers.authorization, body: JSON.parse(raw)};
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({result: {rows: [], total: 0}}));
  });
  try {
    const driver = createShopdeskInvoiceDriver({
      getBridge: () => ({port: server.port, token: 'bridge-secret'}), timeoutMs: 5000,
    });
    const result = await driver.invoiceList({shop_id: 'shop-1', shop_order_id: 'order-1'});
    assert.equal(result.total, 0);
    assert.equal(request.authorization, 'Bearer bridge-secret');
    assert.equal(request.body.method, 'invoice_list');
    assert.equal(request.body.args.shop_order_id, 'order-1');
  } finally { await server.close(); }
});

test('driver 将 bridge error 转换为 ShopdeskBridgeError', async () => {
  const server = await serverWith((_req, res) => {
    res.writeHead(400, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({error: '店铺登录失效'}));
  });
  try {
    const driver = createShopdeskInvoiceDriver({
      getBridge: () => ({port: server.port, token: 'bridge-secret'}), timeoutMs: 5000,
    });
    await assert.rejects(() => driver.invoiceHealth({shop_id: 'shop-1'}), ShopdeskBridgeError);
  } finally { await server.close(); }
});
