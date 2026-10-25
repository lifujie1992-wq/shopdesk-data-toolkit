const {BrowserWindow, session} = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const INVOICE_URL = 'https://fxg.jinritemai.com/ffa/morder/receipt/list';
const MAX_PDF_BYTES = 10 * 1024 * 1024;
const secure = {
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: true,
  backgroundThrottling: false,
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function pageHealth() {
  const url = String(location.href || '');
  const text = (document.body ? document.body.innerText : '').slice(0, 5000);
  const login = /passport\.jinritemai\.com|\/login(?:\/|\?|$)/i.test(url)
    || /扫码登录|验证码登录|密码登录|登录已失效|请先登录|重新登录/.test(text);
  return {
    login: !login,
    pageOk: !login && location.hostname === 'fxg.jinritemai.com',
    url,
  };
}

async function pageInvoiceList(cfg) {
  try {
    const query = new URLSearchParams({
      invoice_status_desc: String(cfg.status_desc || 'wait_blue'),
      page: '0',
      pageSize: '20',
      shop_order_id: String(cfg.shop_order_id),
    });
    const response = await fetch('/order/invoice/list?' + query, {credentials: 'include'});
    const text = await response.text();
    let json;
    try { json = JSON.parse(text); } catch { return {ok: false, code: 'INVALID_JSON', msg: '发票列表响应不是 JSON', rows: [], total: 0}; }
    const rows = Array.isArray(json.data) ? json.data.map(row => ({
      shop_order_id: String(row.shop_order_id || ''),
      registation_id: String(row.registation_id || ''),
      title: String(row.title || ''),
      tax_no: String(row.tax_no || ''),
      invoice_amount: String(row.invoice_amount || ''),
      invoice_status: Number(row.invoice_status),
      invoice_status_text: String((row.invoice_status_info && row.invoice_status_info.invoice_status_text) || row.invoice_status_text || ''),
      order_status: Number(row.order_status),
      order_status_text: String(row.order_status_text || ''),
      invoice_type_text: String(row.invoice_type_text || ''),
      apply_time: String(row.apply_time || ''),
      operations: Array.isArray(row.operations) ? row.operations.map(String) : [],
    })) : [];
    return {
      ok: response.ok && Number(json.code) === 0,
      code: json.code,
      msg: String(json.msg || ''),
      rows,
      total: Number(json.total || rows.length),
    };
  } catch (error) {
    return {ok: false, code: 'FETCH_ERROR', msg: String(error && error.message || error), rows: [], total: 0};
  }
}

async function pageInvoiceDetail(cfg) {
  try {
    const query = new URLSearchParams({shop_order_id: String(cfg.shop_order_id)});
    const response = await fetch('/order/invoice/detail?' + query, {credentials: 'include'});
    const text = await response.text();
    let json;
    try { json = JSON.parse(text); } catch { return {ok: false, code: 'INVALID_JSON', msg: '发票详情响应不是 JSON', data: null}; }
    return {
      ok: response.ok && Number(json.code) === 0,
      code: json.code,
      msg: String(json.msg || ''),
      data: json.data || null,
    };
  } catch (error) {
    return {ok: false, code: 'FETCH_ERROR', msg: String(error && error.message || error), data: null};
  }
}

async function pageInvoiceUploadPdf(cfg) {
  try {
    const binary = atob(String(cfg.base64 || ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const fileName = String(cfg.file_name || 'invoice.pdf');
    const form = new FormData();
    form.append('file', new File([bytes], fileName, {type: 'application/pdf'}));
    form.append('shop_order_id', String(cfg.shop_order_id));
    form.append('invoice_status_type', String(cfg.invoice_status_type));
    form.append('file_name', fileName);
    const response = await fetch('/order/invoice/upload_pdf', {
      method: 'POST',
      credentials: 'include',
      body: form,
    });
    const text = await response.text();
    let json;
    try { json = JSON.parse(text); } catch { return {ok: false, code: 'INVALID_JSON', msg: '上传响应不是 JSON', key: null}; }
    const key = json.data && json.data.key ? String(json.data.key) : null;
    return {
      ok: response.ok && Number(json.code) === 0 && Boolean(key),
      code: json.code,
      msg: String(json.msg || ''),
      key,
    };
  } catch (error) {
    return {ok: false, code: 'FETCH_ERROR', msg: String(error && error.message || error), key: null};
  }
}

async function pageInvoiceSubmit(cfg) {
  try {
    const response = await fetch('/order/invoice/save', {
      method: 'POST',
      credentials: 'include',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        shop_order_id: String(cfg.shop_order_id),
        blue_invoice_key: cfg.blue_invoice_key || null,
        invoice_status_type: Number(cfg.invoice_status_type),
        invoice_file_list: [{tos_key: String(cfg.tos_key), file_name: String(cfg.file_name)}],
      }),
    });
    const text = await response.text();
    let json;
    try { json = JSON.parse(text); } catch { return {ok: false, code: 'INVALID_JSON', msg: '提交响应不是 JSON'}; }
    return {
      ok: response.ok && Number(json.code) === 0,
      code: json.code,
      msg: String(json.msg || ''),
    };
  } catch (error) {
    return {ok: false, code: 'FETCH_ERROR', msg: String(error && error.message || error)};
  }
}

async function pageInvoiceCounts() {
  try {
    const response = await fetch('/order/invoice/get_counts', {credentials: 'include'});
    const text = await response.text();
    const json = JSON.parse(text);
    return {ok: response.ok && Number(json.code) === 0, code: json.code, msg: String(json.msg || '')};
  } catch (error) {
    return {ok: false, code: 'FETCH_ERROR', msg: String(error && error.message || error)};
  }
}

function createInvoice({store}) {
  function assertOrderArgs(args) {
    if (!args || typeof args.shop_id !== 'string' || !args.shop_id) throw Error('shop_id is required');
    if (typeof args.shop_order_id !== 'string' || !args.shop_order_id.trim()) throw Error('shop_order_id is required');
    const shop = store.get(args.shop_id);
    if (shop.platform !== '抖店') throw Error('发票回传仅支持抖店');
    return shop;
  }

  async function execute(wc, fn, cfg) {
    return wc.executeJavaScript(`(${fn.toString()})(${JSON.stringify(cfg || {})})`, true);
  }

  async function withPage(shopId, requireLogin, action) {
    const shop = store.get(shopId);
    if (shop.platform !== '抖店') throw Error('发票回传仅支持抖店');
    const ses = session.fromPartition('persist:shop-' + shopId);
    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: {...secure, session: ses},
    });
    win.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
    const permit = url => {
      try {
        const u = new URL(url);
        return u.protocol === 'https:' && (u.hostname === 'jinritemai.com' || u.hostname.endsWith('.jinritemai.com'));
      } catch { return false; }
    };
    win.webContents.on('will-navigate', (event, url) => { if (!permit(url)) event.preventDefault(); });
    win.webContents.on('will-redirect', (event, url) => { if (!permit(url)) event.preventDefault(); });
    try {
      await win.loadURL(INVOICE_URL);
      await sleep(1500);
      const health = await execute(win.webContents, pageHealth, {});
      if (requireLogin && (!health.login || !health.pageOk)) throw Error('抖店登录失效或发票页面不可用');
      return await action(win.webContents, health);
    } finally {
      if (!win.isDestroyed()) win.destroy();
    }
  }

  async function list(args) {
    assertOrderArgs(args);
    return withPage(args.shop_id, true, async wc => {
      const result = await execute(wc, pageInvoiceList, {
        shop_order_id: args.shop_order_id,
        status_desc: args.status_desc || 'wait_blue',
      });
      if (!result.ok) throw Error(`抖店发票列表查询失败: ${result.code ?? ''} ${result.msg || ''}`.trim());
      return {rows: result.rows, total: result.total};
    });
  }

  async function detail(args) {
    assertOrderArgs(args);
    return withPage(args.shop_id, true, async wc => {
      const result = await execute(wc, pageInvoiceDetail, {shop_order_id: args.shop_order_id});
      if (!result.ok) throw Error(`抖店发票详情查询失败: ${result.code ?? ''} ${result.msg || ''}`.trim());
      return result.data;
    });
  }

  async function uploadPdf(args) {
    assertOrderArgs(args);
    if (typeof args.pdf_path !== 'string' || !path.isAbsolute(args.pdf_path)) throw Error('pdf_path must be an absolute path');
    const realPath = fs.realpathSync(args.pdf_path);
    const stat = fs.statSync(realPath);
    if (!stat.isFile()) throw Error('pdf_path is not a file');
    if (stat.size < 5 || stat.size > MAX_PDF_BYTES) throw Error('PDF 文件大小无效或超过 10MB');
    const bytes = fs.readFileSync(realPath);
    if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') throw Error('文件不是有效 PDF');
    const fileName = path.basename(realPath);

    return withPage(args.shop_id, true, async wc => {
      const detailResult = await execute(wc, pageInvoiceDetail, {shop_order_id: args.shop_order_id});
      if (!detailResult.ok) throw Error(`抖店发票详情查询失败: ${detailResult.code ?? ''} ${detailResult.msg || ''}`.trim());
      const uploadInfo = detailResult.data && detailResult.data.upload_info || {};
      const invoiceStatusType = Number(uploadInfo.invoice_status_type);
      if (!Number.isFinite(invoiceStatusType)) throw Error('抖店发票详情缺少 invoice_status_type');
      const limitMb = Number(detailResult.data && detailResult.data.status_info && detailResult.data.status_info.limit_size) || 10;
      if (stat.size > limitMb * 1024 * 1024) throw Error(`PDF 文件超过平台 ${limitMb}MB 限制`);

      const listResult = await execute(wc, pageInvoiceList, {
        shop_order_id: args.shop_order_id,
        status_desc: 'wait_blue',
      });
      const snapshot = listResult.ok
        ? listResult.rows.find(row => row.shop_order_id === args.shop_order_id) || null
        : null;
      const uploaded = await execute(wc, pageInvoiceUploadPdf, {
        shop_order_id: args.shop_order_id,
        invoice_status_type: invoiceStatusType,
        file_name: fileName,
        base64: bytes.toString('base64'),
      });
      return {
        ok: Boolean(uploaded.ok),
        key: uploaded.key || null,
        snapshot,
        errorCode: uploaded.ok ? null : String(uploaded.code ?? 'UPLOAD_FAILED'),
        errorMsg: uploaded.ok ? null : String(uploaded.msg || '抖店发票上传失败'),
        screenshot: null,
      };
    });
  }

  async function submit(args) {
    assertOrderArgs(args);
    if (typeof args.tos_key !== 'string' || !args.tos_key) throw Error('tos_key is required');
    if (typeof args.file_name !== 'string' || !args.file_name) throw Error('file_name is required');
    return withPage(args.shop_id, true, async wc => {
      const detailResult = await execute(wc, pageInvoiceDetail, {shop_order_id: args.shop_order_id});
      if (!detailResult.ok) throw Error(`抖店发票详情查询失败: ${detailResult.code ?? ''} ${detailResult.msg || ''}`.trim());
      const uploadInfo = detailResult.data && detailResult.data.upload_info || {};
      const invoiceStatusType = Number(uploadInfo.invoice_status_type);
      if (!Number.isFinite(invoiceStatusType)) throw Error('抖店发票详情缺少 invoice_status_type');
      const saveResult = await execute(wc, pageInvoiceSubmit, {
        shop_order_id: args.shop_order_id,
        tos_key: args.tos_key,
        file_name: args.file_name,
        invoice_status_type: invoiceStatusType,
        blue_invoice_key: uploadInfo.blue_invoice_key || args.blue_invoice_key || null,
      });

      let verified = false;
      for (let attempt = 0; attempt < 6; attempt++) {
        const done = await execute(wc, pageInvoiceList, {
          shop_order_id: args.shop_order_id,
          status_desc: 'done_blue',
        });
        verified = Boolean(done.ok && done.rows.some(row => row.shop_order_id === args.shop_order_id));
        if (verified) break;
        await sleep(1000);
      }
      return {
        ok: verified,
        submitted: Boolean(saveResult.ok && verified),
        alreadySubmitted: Boolean(!saveResult.ok && verified),
        errorCode: verified ? null : String(saveResult.code ?? 'VERIFY_FAILED'),
        errorMsg: verified ? null : String(saveResult.msg || (saveResult.ok ? '提交响应成功，但列表未确认已开票' : '抖店发票提交失败')),
      };
    });
  }

  async function health(args) {
    if (!args || typeof args.shop_id !== 'string' || !args.shop_id) throw Error('shop_id is required');
    const shop = store.get(args.shop_id);
    if (shop.platform !== '抖店') return {login: false, pageOk: false};
    return withPage(args.shop_id, false, async (wc, healthResult) => {
      if (!healthResult.login || !healthResult.pageOk) return {login: false, pageOk: false};
      const counts = await execute(wc, pageInvoiceCounts, {});
      return {login: true, pageOk: Boolean(counts.ok)};
    });
  }

  return {list, detail, uploadPdf, submit, health};
}

module.exports = {createInvoice};
