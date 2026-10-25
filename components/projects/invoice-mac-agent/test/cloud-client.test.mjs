import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCloudClient, FatalAuthError, LeaseConflictError } from '../cloud-client.mjs';

function mockFetch(handler) {
  const old = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = old; };
}

test('claim 成功返回 jobs，且带正确鉴权头', async () => {
  let seenHeaders = null;
  const restore = mockFetch(async (url, opts) => {
    seenHeaders = opts.headers;
    assert.match(String(url), /\/api\/invoice\/worker\/jobs\/claim$/);
    return new Response(JSON.stringify({ jobs: [{ job_id: 'job-1', leaseToken: 'lt-1' }] }), { status: 200 });
  });
  try {
    const client = createCloudClient({
      workbenchBaseUrl: 'https://example.com/', accountId: 'account-001', workerToken: 'secret', maxJobs: 1,
    });
    const jobs = await client.claim();
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].leaseToken, 'lt-1');
    assert.equal(seenHeaders['X-Invoice-Account-Id'], 'account-001');
    assert.equal(seenHeaders['X-Invoice-Worker-Token'], 'secret');
  } finally { restore(); }
});

test('claim 401/403 抛 FatalAuthError（不重试）', async () => {
  let calls = 0;
  const restore = mockFetch(async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: '代理 Token 无效' }), { status: 401 });
  });
  try {
    const client = createCloudClient({ workbenchBaseUrl: 'https://x', accountId: 'a', workerToken: 't', maxJobs: 1 });
    await assert.rejects(() => client.claim(), FatalAuthError);
    assert.equal(calls, 1); // 不重试
  } finally { restore(); }
});

test('claim允许小批量领取且不能超过maxJobs上限', async () => {
  const counts = [];
  const restore = mockFetch(async (_url, opts) => {
    counts.push(JSON.parse(opts.body).maxJobs);
    return Response.json({jobs: []});
  });
  try {
    const client = createCloudClient({workbenchBaseUrl: 'https://x', maxJobs: 20});
    await client.claim(3);
    await client.claim();
    await assert.rejects(() => client.claim(21));
    await assert.rejects(() => client.claim(0));
    assert.deepEqual(counts, [3, 20]);
  } finally { restore(); }
});

test('report 409 抛 LeaseConflictError', async () => {
  const restore = mockFetch(async () => new Response(JSON.stringify({ error: '租约已失效' }), { status: 409 }));
  try {
    const client = createCloudClient({ workbenchBaseUrl: 'https://x', accountId: 'a', workerToken: 't', maxJobs: 1 });
    await assert.rejects(
      () => client.report({ job_id: 'j', leaseToken: 'lt', state: 'uploaded', message: 'ok' }),
      LeaseConflictError,
    );
  } finally { restore(); }
});

test('report 成功返回 idempotent', async () => {
  let body = null;
  const restore = mockFetch(async (url, opts) => {
    body = JSON.parse(opts.body);
    return new Response(JSON.stringify({ state: 'uploaded', idempotent: true }), { status: 200 });
  });
  try {
    const client = createCloudClient({ workbenchBaseUrl: 'https://x', accountId: 'a', workerToken: 't', maxJobs: 1 });
    const r = await client.report({ job_id: 'j', leaseToken: 'lt', state: 'uploaded', message: 'ok' });
    assert.equal(r.idempotent, true);
    assert.equal(body.leaseToken, 'lt');
    assert.equal(body.state, 'uploaded');
  } finally { restore(); }
});
