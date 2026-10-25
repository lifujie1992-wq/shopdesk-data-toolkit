import {FatalAuthError, HttpResponseError} from './cloud-client.mjs';
import {captureCreateBody, loadManifest, saveManifest} from './capture-pack.mjs';

function verifyView(view, manifest) {
  for (const k of ['captureRunId', 'statDate', 'capturedAt', 'consumerRowCount', 'platformRowCount',
    'fileSize', 'fileSha256']) {
    // 日期时间允许服务端统一为 ISO；其他字段必须一致。
    const same = k === 'capturedAt' ? Date.parse(view[k]) === Date.parse(manifest[k]) : view[k] === manifest[k];
    if (!same) throw new HttpResponseError(`云端清单与本地不符: ${k}`, 409);
  }
  if (!['created', 'uploaded', 'validating', 'processing', 'processed', 'failed'].includes(view.status)) throw new HttpResponseError('未知云端批次状态', 400);
  if (view.status === 'processed') {
    if (view.consumerReceivedRows !== manifest.consumerRowCount || view.platformReceivedRows !== manifest.platformRowCount) throw new HttpResponseError('ACK 接收行数与本地不一致', 400);
    for (const [accepted, count] of [['consumerAcceptedRows', manifest.consumerRowCount], ['platformAcceptedRows', manifest.platformRowCount]]) {
      if (!Number.isSafeInteger(view[accepted]) || view[accepted] < 0 || view[accepted] > count) throw new HttpResponseError('ACK 唯一行数非法', 400);
    }
    for (const field of ['duplicateRows', 'conflictRows', 'staleRows']) {
      if (!Number.isSafeInteger(view[field]) || view[field] < 0) throw new HttpResponseError(`ACK 计数非法: ${field}`, 400);
    }
    if (view.consumerAcceptedRows + view.platformAcceptedRows + view.duplicateRows !==
        manifest.consumerRowCount + manifest.platformRowCount) throw new HttpResponseError('ACK 唯一行数+重复行数与总行数不一致', 400);
  }
  return view;
}

// 默认只上传快照文件；--complete 才允许云端校验入库。与抖店最终开票提交无关。
export async function uploadCapture({cloud, manifestPath, complete = false, log = console}) {
  const manifest = loadManifest(manifestPath);
  const body = captureCreateBody(manifest);
  let uncertain = false;
  const persist = view => {
    verifyView(view, manifest);
    manifest.status = view.status;
    manifest.cloudView = view;
    saveManifest(manifestPath, manifest);
    log.info?.({event: 'capture_cloud_status', captureRunId: manifest.captureRunId, status: view.status,
      consumerReceivedRows: view.consumerReceivedRows, platformReceivedRows: view.platformReceivedRows,
      duplicateRows: view.duplicateRows, conflictRows: view.conflictRows});
    return view;
  };
  return cloud.captureRetry(async () => {
    let view, phase = 'view';
    try {
      if (uncertain) {
        // 任何上传/提交超时后先查状态，不能盲目重传。
        try { view = persist(await cloud.captureView(manifest.captureRunId)); }
        catch (error) { if (error.status !== 404) throw error; }
      }
      if (!view) {
        phase = 'create';
        view = persist(await cloud.captureCreate(body));
      }
      if (view.status === 'processed') return view;
      if (['validating', 'processing'].includes(view.status)) throw new HttpResponseError('批次正在处理中，请稍后 --resume', 425);
      phase = 'file';
      if (view.status !== 'uploaded') view = persist(await cloud.captureFile(manifest.captureRunId, manifest.gzipPath));
      if (view.status === 'processed') return view;
      if (view.status !== 'uploaded') throw new HttpResponseError('文件上传未达到 uploaded', 400);
      if (!complete) return view;
      phase = 'complete';
      view = persist(await cloud.captureComplete(manifest.captureRunId));
      if (view.status !== 'processed') throw new HttpResponseError('批次未处理完成', 425);
      return view;
    } catch (error) {
      if (error instanceof FatalAuthError) throw error;
      if (error.status === 409) {
        const current = verifyView(await cloud.captureView(manifest.captureRunId), manifest);
        // 清单冲突不能用同 ID 的 processed 冒充本批成功，也不能持久化为本批已完成。
        if (phase !== 'create' && current.status === 'processed' && !String(error.message).includes('清单') && !String(error.message).includes('ACK')) return persist(current);
        throw error;
      }
      if (error instanceof HttpResponseError && !error.retryable) throw error;
      uncertain = true;
      throw error;
    }
  });
}
