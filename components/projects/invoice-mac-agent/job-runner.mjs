import path from 'node:path';
import {FatalAuthError, LeaseConflictError} from './cloud-client.mjs';
import {PdfIntegrityError, cleanupStage} from './pdf-stage.mjs';
import {redactMessage} from './redact.mjs';
import {resolveLatestShop} from './latest-shops.mjs';

export function amountToCents(value) {
  const normalized = String(value ?? '').replace(/[,，￥¥元\s]/g, '');
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? Math.round(number * 100) : null;
}

function transientMessage(message) {
  return /网络|超时|稍后|繁忙|频繁|系统异常|登录|不可用|连接|timeout|network|fetch/i.test(String(message || ''));
}

function validateJob(job) {
  if (!job || typeof job.job_id !== 'string' || !job.job_id) throw Error('任务缺少 job_id');
  if (typeof job.leaseToken !== 'string' || !job.leaseToken) throw Error('任务缺少 leaseToken');
  if (!job.payload || typeof job.payload !== 'object') throw Error('任务缺少 payload');
  if (job.payload.businessType && job.payload.businessType !== 'consumer_order') throw Error('当前 Mac 回传仅支持消费者发票，平台账单不可按消费者订单执行');
  if (job.payload.subOrderNo != null && typeof job.payload.subOrderNo !== 'string') throw Error('子订单号必须为字符串');
  if (typeof job.payload.shopId !== 'string' || !job.payload.shopId) throw Error('任务缺少 payload.shopId');
  if (typeof job.payload.orderId !== 'string' || !job.payload.orderId) throw Error('任务缺少 payload.orderId');
  if (amountToCents(job.payload.amount) === null) throw Error('任务金额格式无效');
}

export function createJobRunner({cloud, stage, driver, cfg, log, now = Date.now}) {
  if (!['dry-run', 'upload-only', 'auto'].includes(cfg.submitMode)) throw Error('非法 submitMode，拒绝执行回传');
  async function currentShop(payload) {
    const response = await driver.listShops();
    return resolveLatestShop(response?.shops, payload);
  }
  async function verifySession(payload, phase) {
    try {
      const {shop} = await currentShop(payload);
      if (shop.id !== payload.shopId || String(shop.name || '').trim() !== payload.shopName) {
        return {state: 'retryable', message: `${phase}shopdesk登录记录已变化，下一轮使用最新店铺重新核对`};
      }
      return null;
    } catch (error) {
      return {state: 'retryable', message: `${phase}无法确认shopdesk最新登录: ${error.message}`};
    }
  }
  async function report(job, decision) {
    const message = redactMessage(decision.message, 500);
    try {
      const result = await cloud.report({
        job_id: job.job_id,
        leaseToken: job.leaseToken,
        state: decision.state,
        message,
      });
      log.info({event: 'job_reported', job_id: job.job_id, state: decision.state, idempotent: Boolean(result.idempotent)});
      return {status: 'reported', state: decision.state, result};
    } catch (error) {
      if (error instanceof LeaseConflictError) {
        log.warn({event: 'job_stale', job_id: job.job_id, error: error.message});
        return {status: 'stale', state: null};
      }
      throw error;
    }
  }

  async function alreadySubmitted(payload) {
    const done = await driver.invoiceList({
      shop_id: payload.shopId,
      shop_order_id: payload.orderId,
      status_desc: 'done_blue',
    });
    return (done.rows || []).some(row => String(row.shop_order_id) === payload.orderId &&
      (!payload.subOrderNo || String(row.sub_order_no || '') === payload.subOrderNo));
  }

  async function decide(job, stagedRef) {
    try {
      validateJob(job);
    } catch (error) {
      return {state: 'failed', message: error.message};
    }
    let payload = {...job.payload};
    const expiresAt = Date.parse(job.lease_expires_at || '');
    const leaseTooShort = () => Number.isFinite(expiresAt) && expiresAt - now() <= cfg.leaseSoftDeadlineMs;
    if (leaseTooShort()) {
      return {state: 'retryable', message: '任务租约剩余时间不足，已放弃本次处理'};
    }

    try {
      stagedRef.value = await stage(cloud, job, cfg.stagingDir);
      log.info({event: 'pdf_staged', job_id: job.job_id, size: stagedRef.value.size, sha256: stagedRef.value.sha256});
    } catch (error) {
      if (error instanceof FatalAuthError) throw error;
      if (error instanceof PdfIntegrityError) return {state: 'failed', message: error.message};
      return {state: 'retryable', message: `发票原件下载失败: ${error.message}`};
    }

    let resolved;
    try {
      resolved = await currentShop(payload);
    } catch (error) {
      return {state: error.retryable === false ? 'failed' : 'retryable', message: `店铺工作台最新登录匹配失败: ${error.message}`};
    }
    const {shop, matchedBy} = resolved;
    payload = {...payload, shopId: shop.id, shopName: String(shop.name || '').trim()};
    log.info({event: 'shop_identity_resolved', job_id: job.job_id, requested_shop_id: job.payload.shopId,
      requested_shop_name: job.payload.shopName || '', resolved_shop_id: payload.shopId,
      resolved_shop_name: payload.shopName, matched_by: matchedBy});

    let list;
    try {
      list = await driver.invoiceList({
        shop_id: payload.shopId,
        shop_order_id: payload.orderId,
        status_desc: 'wait_blue',
      });
    } catch (error) {
      return {state: 'retryable', message: `待开票列表查询失败: ${error.message}`};
    }
    const exact = (list.rows || []).filter(row => String(row.shop_order_id) === payload.orderId &&
      (!payload.subOrderNo || String(row.sub_order_no || '') === payload.subOrderNo));
    if (exact.length === 0) {
      try {
        if (await alreadySubmitted(payload)) return {state: 'uploaded', message: '订单已在抖店显示已开票（幂等确认）'};
      } catch (error) {
        return {state: 'retryable', message: `订单状态确认失败: ${error.message}`};
      }
      return {state: 'failed', message: `待开票列表未找到订单 ${payload.orderId}`};
    }
    if (exact.length !== 1) return {state: 'failed', message: `待开票列表订单 ${payload.orderId} 返回 ${exact.length} 条记录`};
    const snapshot = exact[0];
    if (snapshot.invoice_status_text !== '待开票' || Number(snapshot.invoice_status) !== 1) {
      return {state: 'failed', message: `订单状态不是待开票: ${snapshot.invoice_status_text || snapshot.invoice_status}`};
    }
    const taskAmount = amountToCents(payload.amount);
    const platformAmount = amountToCents(snapshot.invoice_amount);
    if (platformAmount === null || Math.abs(platformAmount - taskAmount) > 1) {
      return {state: 'failed', message: `发票金额不匹配: 任务=${payload.amount}, 抖店=${snapshot.invoice_amount}`};
    }

    if (cfg.submitMode === 'dry-run') {
      return {state: 'retryable', message: 'dry-run 核对通过，未上传、未提交'};
    }

    let upload;
    if (leaseTooShort()) return {state: 'retryable', message: '上传前租约剩余时间不足，留待重新领取'};
    const beforeUpload = await verifySession(payload, '上传前');
    if (beforeUpload) return beforeUpload;
    if (leaseTooShort()) return {state: 'retryable', message: '上传前租约剩余时间不足，留待重新领取'};
    try {
      upload = await driver.invoiceUploadPdf({
        shop_id: payload.shopId,
        shop_order_id: payload.orderId,
        pdf_path: stagedRef.value.path,
      });
    } catch (error) {
      return {state: 'retryable', message: `发票上传调用失败: ${error.message}`};
    }
    if (!upload?.ok || !upload.key) {
      const message = upload?.errorMsg || '抖店未返回上传文件 key';
      return {
        state: transientMessage(message) ? 'retryable' : 'failed',
        message: `发票上传失败: ${upload?.errorCode || ''} ${message}`.trim(),
      };
    }
    log.info({event: 'invoice_pdf_uploaded', job_id: job.job_id, mode: cfg.submitMode});
    if (cfg.submitMode === 'upload-only') {
      try {
        const pending = await driver.invoiceList({shop_id: payload.shopId, shop_order_id: payload.orderId, status_desc: 'wait_blue'});
        const stillPending = (pending.rows || []).some(row => String(row.shop_order_id) === payload.orderId &&
          (!payload.subOrderNo || String(row.sub_order_no || '') === payload.subOrderNo) &&
          row.invoice_status_text === '待开票' && Number(row.invoice_status) === 1);
        log.info({event: 'upload_only_verified', job_id: job.job_id, stillPending});
        return {state: 'retryable', message: stillPending ? 'upload-only 上传成功，已确认仍待开票，未提交' : 'upload-only 上传成功，未提交；待开票状态需人工复核'};
      } catch {
        return {state: 'retryable', message: 'upload-only 上传成功，未提交；状态复核请求失败'};
      }
    }

    const submitArgs = {
      shop_id: payload.shopId,
      shop_order_id: payload.orderId,
      tos_key: upload.key,
      file_name: path.basename(stagedRef.value.path),
    };
    if (leaseTooShort()) return {state: 'retryable', message: '提交前租约剩余时间不足，未执行最终提交'};
    const beforeSubmit = await verifySession(payload, '提交前');
    if (beforeSubmit) return beforeSubmit;
    if (leaseTooShort()) return {state: 'retryable', message: '提交前租约剩余时间不足，未执行最终提交'};
    let submit;
    try {
      submit = await driver.invoiceSubmit(submitArgs);
    } catch (error) {
      try {
        if (await alreadySubmitted(payload)) return {state: 'uploaded', message: '抖店开票成功（提交异常后幂等确认）'};
      } catch {}
      return {state: 'retryable', message: `抖店提交失败: ${error.message}`};
    }
    if (submit?.ok || submit?.submitted || submit?.alreadySubmitted) {
      return {state: 'uploaded', message: submit.alreadySubmitted ? '抖店开票成功（幂等确认）' : '抖店开票成功'};
    }
    try {
      if (await alreadySubmitted(payload)) return {state: 'uploaded', message: '抖店开票成功（列表确认）'};
    } catch (error) {
      return {state: 'retryable', message: `提交后状态确认失败: ${error.message}`};
    }
    return {state: 'retryable', message: `抖店提交失败: ${submit?.errorCode || ''} ${submit?.errorMsg || '未知错误'}`.trim()};
  }

  async function run(job) {
    const stagedRef = {value: null};
    log.info({event: 'job_started', job_id: job?.job_id, mode: cfg.submitMode,
      requested_shop_id: job?.payload?.shopId, requested_shop_name: job?.payload?.shopName});
    let decision;
    try {
      decision = await decide(job, stagedRef);
      log.info({event: 'job_decision', job_id: job?.job_id, state: decision.state, message: redactMessage(decision.message)});
      return await report(job, decision);
    } finally {
      if (job?.job_id) cleanupStage(job.job_id, cfg.stagingDir);
    }
  }

  // Compatibility with worker-round callers; each task now reads the live list.
  return {run, resetShopCache: () => {}};
}
