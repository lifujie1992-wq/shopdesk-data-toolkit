// 云端 Worker API 客户端（claim / 下载 / 回传）
import fs from 'node:fs';
import path from 'node:path';

export class FatalAuthError extends Error {
  constructor(message) { super(message); this.name = 'FatalAuthError'; }
}

export class LeaseConflictError extends Error {
  constructor(message) { super(message); this.name = 'LeaseConflictError'; }
}

export class HttpResponseError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'HttpResponseError';
    this.status = status;
    this.retryable = status === 408 || status === 425 || status === 429 || status >= 500;
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function createCloudClient(cfg, log = console) {
  const baseUrl = new URL(cfg.workbenchBaseUrl);
  const baseOrigin = baseUrl.origin;
  const authHeaders = {
    'X-Invoice-Account-Id': cfg.accountId,
    'X-Invoice-Worker-Token': cfg.workerToken,
  };

  function endpoint(relativePath) {
    return new URL(relativePath, `${baseOrigin}/`).href;
  }

  async function readError(response) {
    try {
      const value = await response.json();
      return String(value.error || value.message || value.detail || `HTTP ${response.status}`);
    } catch {
      return `HTTP ${response.status}`;
    }
  }

  async function withRetry(label, maxAttempts, operation) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await operation();
      } catch (error) {
        if (error instanceof FatalAuthError || error instanceof LeaseConflictError) throw error;
        const retryable = error instanceof HttpResponseError ? error.retryable : true;
        if (!retryable || attempt >= maxAttempts) throw error;
        const delayMs = Math.min(30_000, 1000 * 2 ** (attempt - 1));
        log.warn?.({event: `${label}_retry`, attempt, delayMs, error: error.message});
        await sleep(delayMs);
      }
    }
  }

  async function claim(maxJobs = cfg.maxJobs) {
    if (!Number.isInteger(maxJobs) || maxJobs < 1 || maxJobs > cfg.maxJobs || maxJobs > 20) throw new Error('领取数量超出配置上限');
    return withRetry('claim', 5, async () => {
      const response = await fetch(endpoint('/api/invoice/worker/jobs/claim'), {
        method: 'POST',
        headers: {...authHeaders, 'Content-Type': 'application/json'},
        body: JSON.stringify({maxJobs}),
        signal: AbortSignal.timeout(cfg.requestTimeoutMs || 30_000),
      });
      if (response.status === 401 || response.status === 403) {
        throw new FatalAuthError(`鉴权失败(${response.status}): ${await readError(response)}`);
      }
      if (!response.ok) throw new HttpResponseError(`claim 失败(${response.status}): ${await readError(response)}`, response.status);
      const data = await response.json();
      return Array.isArray(data.jobs) ? data.jobs : [];
    });
  }

  async function download(job, destPath) {
    return withRetry('download', 3, async () => {
      if (!job || typeof job.fileDownloadUrl !== 'string') throw Error('任务缺少 fileDownloadUrl');
      const url = new URL(job.fileDownloadUrl, `${baseOrigin}/`);
      if (url.origin !== baseOrigin) throw Error('文件下载地址与工作台不同源');
      const response = await fetch(url, {
        method: 'GET',
        headers: authHeaders,
        signal: AbortSignal.timeout(cfg.downloadTimeoutMs || 120_000),
      });
      if (response.status === 401 || response.status === 403) {
        throw new FatalAuthError(`鉴权失败(${response.status}): ${await readError(response)}`);
      }
      if (!response.ok) throw new HttpResponseError(`下载失败(${response.status}): ${await readError(response)}`, response.status);
      const bytes = Buffer.from(await response.arrayBuffer());
      fs.mkdirSync(path.dirname(destPath), {recursive: true});
      const partial = `${destPath}.part`;
      try {
        fs.writeFileSync(partial, bytes, {mode: 0o600});
        fs.renameSync(partial, destPath);
        fs.chmodSync(destPath, 0o600);
      } finally {
        try { fs.rmSync(partial, {force: true}); } catch {}
      }
      return {path: destPath, size: bytes.length};
    });
  }

  async function report({job_id, leaseToken, state, message}) {
    return withRetry('report', 3, async () => {
      const response = await fetch(endpoint(`/api/invoice/worker/jobs/${encodeURIComponent(job_id)}/result`), {
        method: 'POST',
        headers: {...authHeaders, 'Content-Type': 'application/json'},
        body: JSON.stringify({state, message: String(message || '').slice(0, 500), leaseToken}),
        signal: AbortSignal.timeout(cfg.requestTimeoutMs || 30_000),
      });
      if (response.status === 409) {
        throw new LeaseConflictError(`租约失效(409): ${await readError(response)}`);
      }
      if (response.status === 401 || response.status === 403) {
        throw new FatalAuthError(`鉴权失败(${response.status}): ${await readError(response)}`);
      }
      if (!response.ok) throw new HttpResponseError(`回传失败(${response.status}): ${await readError(response)}`, response.status);
      return response.json();
    });
  }

  const capturePrefix = '/api/invoice/v2/sync/capture-runs';
  async function captureRequest(method, suffix, {body, filePath} = {}) {
    const headers = {...authHeaders};
    let stream;
    if (filePath) {
      headers['Content-Type'] = 'application/gzip';
      headers['Content-Length'] = String(fs.statSync(filePath).size);
      stream = fs.createReadStream(filePath);
    } else if (body !== undefined) headers['Content-Type'] = 'application/json';
    try {
      const response = await fetch(endpoint(capturePrefix + suffix), {
        method, headers, redirect: 'error',
        body: stream || (body === undefined ? undefined : JSON.stringify(body)),
        ...(stream ? {duplex: 'half'} : {}),
        signal: AbortSignal.timeout(filePath ? (cfg.downloadTimeoutMs || 120_000) : (cfg.captureRequestTimeoutMs || 30_000)),
      });
      if (response.status === 401 || response.status === 403) throw new FatalAuthError(`鉴权失败(${response.status}): ${await readError(response)}`);
      if (!response.ok) throw new HttpResponseError(`capture 失败(${response.status}): ${await readError(response)}`, response.status);
      return await response.json();
    } finally { stream?.destroy(); }
  }
  const capturePath = id => '/' + encodeURIComponent(id);
  return {claim, download, report,
    captureCreate: body => captureRequest('POST', '', {body}),
    captureFile: (id, filePath) => captureRequest('POST', capturePath(id) + '/file', {filePath}),
    captureComplete: id => captureRequest('POST', capturePath(id) + '/complete'),
    captureView: id => withRetry('capture_view', 5, () => captureRequest('GET', capturePath(id))),
    captureRetry: operation => withRetry('capture_upload', 5, operation),
  };
}
