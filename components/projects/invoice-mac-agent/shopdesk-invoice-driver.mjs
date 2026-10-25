export class ShopdeskBridgeError extends Error {
  constructor(message, {status = 0, retryable = true} = {}) {
    super(message);
    this.name = 'ShopdeskBridgeError';
    this.status = status;
    this.retryable = retryable;
  }
}

export function createShopdeskInvoiceDriver(options) {
  const getBridge = typeof options === 'function'
    ? options
    : options?.getBridge
      ? options.getBridge
      : () => options;
  const timeoutMs = options?.timeoutMs || 180_000;

  async function call(method, args = {}) {
    const bridge = await getBridge();
    if (!bridge || !Number.isInteger(Number(bridge.port)) || !bridge.token) {
      throw new ShopdeskBridgeError('店铺工作台 bridge 配置无效');
    }
    let response;
    try {
      response = await fetch(`http://127.0.0.1:${Number(bridge.port)}/call`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${bridge.token}`,
          'Content-Type': 'application/json',
          'X-Shopdesk-Client': 'invoice-mac-agent',
        },
        body: JSON.stringify({method, args}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new ShopdeskBridgeError(`店铺工作台不可用: ${error.message}`);
    }
    let data;
    try { data = await response.json(); } catch { throw new ShopdeskBridgeError(`店铺工作台响应不是 JSON (HTTP ${response.status})`); }
    if (!response.ok || data.error) {
      throw new ShopdeskBridgeError(String(data.error || `店铺工作台调用失败 (HTTP ${response.status})`), {
        status: response.status,
        retryable: response.status >= 500 || response.status === 400,
      });
    }
    if (!Object.hasOwn(data, 'result')) throw new ShopdeskBridgeError('店铺工作台响应缺少 result');
    return data.result;
  }

  return {
    listShops: () => call('list_shops'),
    invoiceList: args => call('invoice_list', args),
    invoiceDetail: args => call('invoice_detail', args),
    invoiceUploadPdf: args => call('invoice_upload_pdf', args),
    invoiceSubmit: args => {
      if (options?.allowSubmit === false) throw new ShopdeskBridgeError('安全限制：当前运行禁止最终提交', {retryable: false});
      return call('invoice_submit', args);
    },
    invoiceHealth: args => call('invoice_health', args),
  };
}
