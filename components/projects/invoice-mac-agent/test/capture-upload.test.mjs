import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createCloudClient, FatalAuthError} from '../cloud-client.mjs';
import {packCapture, captureCreateBody, sha256} from '../capture-pack.mjs';
import {uploadCapture} from '../capture-upload.mjs';
const log = {info() {}, warn() {}};
function setup(t, handler) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-upload-test-'));
  const packed = packCapture({rows: [], shopResults: [{shopId: 's', businessType: 'consumer_order', status: 'success', isComplete: true, rowCount: 0, errorCode: null, errorMessage: null}], stateDir: dir});
  const original = globalThis.fetch;
  const requests = [];
  const body = captureCreateBody(packed.manifest);
  const view = status => ({...body, status, consumerReceivedRows: 0, platformReceivedRows: 0, consumerAcceptedRows: 0, platformAcceptedRows: 0, duplicateRows: 0, conflictRows: 0, staleRows: 0});
  globalThis.fetch = async (url, opts) => {
    requests.push({url: String(url), ...opts});
    assert.equal(opts.headers['X-Invoice-Account-Id'], 'acct');
    assert.equal(opts.headers['X-Invoice-Worker-Token'], 'secret');
    if (String(url).endsWith('/file')) {
      const chunks = [];
      for await (const chunk of opts.body) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      assert.equal(sha256(bytes), body.fileSha256);
      assert.equal(opts.headers['Content-Type'], 'application/gzip');
      assert.equal(opts.duplex, 'half');
    }
    return handler(String(url), opts, view, requests);
  };
  t.after(() => { globalThis.fetch = original; fs.rmSync(dir, {recursive: true, force: true}); });
  const cloud = createCloudClient({workbenchBaseUrl: 'https://example.com', accountId: 'acct', workerToken: 'secret'}, log);
  return {...packed, cloud, requests, body};
}
test('默认create/file停在uploaded，不调用complete；resume复用原清单', async t => {
  let uploaded = false;
  const env = setup(t, (url, opts, view) => {
    assert.ok(!url.endsWith('/complete'));
    if (url.endsWith('/file')) { uploaded = true; return Response.json(view('uploaded')); }
    assert.deepEqual(JSON.parse(opts.body), env.body);
    return Response.json(view(uploaded ? 'uploaded' : 'created'));
  });
  const result = await uploadCapture({...env, log});
  assert.equal(result.status, 'uploaded');
  assert.equal((await uploadCapture({...env, log})).status, 'uploaded');
  assert.equal(env.requests.filter(r => r.url.endsWith('/file')).length, 1);
});
test('file响应丢失先GET，uploaded不重传文件，complete核对ACK', async t => {
  const env = setup(t, (url, opts, view) => {
    if (opts.method === 'GET') return Response.json(view('uploaded'));
    if (url.endsWith('/file')) throw new TypeError('network response lost');
    if (url.endsWith('/complete')) return Response.json(view('processed'));
    return Response.json(view('created'));
  });
  const result = await uploadCapture({...env, complete: true, log});
  assert.equal(result.status, 'processed');
  assert.equal(env.requests.filter(r => r.url.endsWith('/file')).length, 1);
  assert.deepEqual(env.requests.map(r => r.method), ['POST', 'POST', 'GET', 'POST']);
});
test('complete响应丢失后GET processed，不重复上传/提交', async t => {
  const env = setup(t, (url, opts, view) => {
    if (opts.method === 'GET') return Response.json(view('processed'));
    if (url.endsWith('/file')) return Response.json(view('uploaded'));
    if (url.endsWith('/complete')) throw new DOMException('timeout', 'TimeoutError');
    return Response.json(view('created'));
  });
  assert.equal((await uploadCapture({...env, complete: true, log})).status, 'processed');
  assert.equal(env.requests.filter(r => r.url.endsWith('/complete')).length, 1);
});
test('401不重试', async t => {
  const env = setup(t, () => Response.json({error: 'invalid'}, {status: 401}));
  await assert.rejects(() => uploadCapture({...env, log}), FatalAuthError);
  assert.equal(env.requests.length, 1);
});
test('create409即便同ID已processed也不能冒充本批成功', async t => {
  const env = setup(t, (_url, opts, view) => opts.method === 'GET' ? Response.json(view('processed')) : Response.json({error: '批次 ID 已被不同店铺采集结果使用'}, {status: 409}));
  await assert.rejects(() => uploadCapture({...env, complete: true, log}), /409/);
  assert.equal(env.requests.length, 2);
});
test('400/413不重试、不complete', async t => {
  for (const status of [400, 413]) {
    await t.test(String(status), async t => {
      const env = setup(t, () => Response.json({error: 'bad'}, {status}));
      await assert.rejects(() => uploadCapture({...env, complete: true, log}));
      assert.equal(env.requests.length, 1);
    });
  }
});
