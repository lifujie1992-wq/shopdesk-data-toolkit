// Self-contained: serialized into the already authenticated ERP tab.
export async function readPage(input) {
  function fail(code, message) { const e = new Error(message); e.code = code; throw e; }
  function find(w) {
    try {
      if (w.location.pathname.toLowerCase() === '/app/order/order/list.aspx' && w.jTable) return w;
      for (let i = 0; i < w.frames.length; i++) { const f = find(w.frames[i]); if (f) return f; }
    } catch {}
  }
  const w = find(window);
  if (!w) fail('order_page_required', '请在聚水潭中打开「常用 → 订单」，等待列表加载后重试。');
  const baseBody = new URLSearchParams(w.$.createPostData());
  const ajaxToken = baseBody.get('__ajax_token');
  function formBody(doc) {
    const body = new URLSearchParams();
    for (const el of Array.from(doc.forms[0]?.elements || [])) {
      if (!el.name || ['submit', 'button', 'file'].includes(el.type)) continue;
      if (['checkbox', 'radio'].includes(el.type) && !el.checked) continue;
      body.append(el.name, el.value);
    }
    if (ajaxToken) body.set('__ajax_token', ajaxToken);
    return body;
  }
  async function rpc(url, doc, method, args, target = 'ACall1', overrides = {}) {
    const allowed = ['LoadDataToJSON', 'LoadDataToJSONPage', 'ReloadOrder', 'LoadAfterSale', 'GetOrderActionList'];
    if (!allowed.includes(method)) fail('method_not_allowed', '只允许经过验证的读取方法。');
    const u = new URL(url);
    u.searchParams.set('am___', method);
    u.searchParams.set('ts___', Date.now());
    const body = doc === w.document ? new URLSearchParams(baseBody) : formBody(doc);
    body.set('__CALLBACKID', target);
    body.set('__CALLBACKPARAM', JSON.stringify({ Method: method, Args: args.map(x => x == null ? null : String(x)), ...(target === 'ACall1' ? { CallControl: '{page}' } : {}) }));
    const ev = doc.forms[0]?.elements.__EVENTVALIDATION;
    if (ev) body.set('__EVENTVALIDATION', ev.value);
    for (const [k, v] of Object.entries(overrides)) body.set(k, v);
    const r = await w.fetch(u.href, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest' }, body: body.toString(), signal: AbortSignal.timeout(40000) });
    const text = await r.text();
    const i = text.indexOf('|');
    if (!r.ok || i < 1 || i > 5 || !/^\d+$/.test(text.slice(0, i))) fail('invalid_callback', `接口 ${method} 未返回有效回调（HTTP ${r.status}），请检查登录状态。`);
    let envelope;
    try { envelope = JSON.parse(text.slice(i + 1 + Number(text.slice(0, i)))); } catch { fail('invalid_callback', `接口 ${method} 回调解析失败。`); }
    if (envelope.GotoLogin || envelope.ExceptionMessage === '{not_logged_in}') fail('not_logged_in', '聚水潭登录已失效，请在 Chrome 重新登录。');
    if (!envelope.IsSuccess) fail('api_error', `${method}: ${envelope.ExceptionMessage || envelope.Message || '请求失败'}`);
    let data = envelope.ReturnValue;
    if (typeof data === 'string') { try { data = JSON.parse(data); } catch {} }
    return data;
  }
  function assignment(scripts, name) {
    // Parse JSON literals only. Never execute downloaded page code.
    const match = new RegExp('(?:^|[;\\n\\r])\\s*(?:var\\s+)?' + name + '\\s*=\\s*', 'm').exec(scripts);
    if (!match) return null;
    const start = match.index + match[0].length;
    let depth = 0, quoted = false, escaped = false;
    for (let i = start; i < scripts.length; i++) {
      const c = scripts[i];
      if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue; }
      if (c === '"') quoted = true;
      else if (c === '{' || c === '[') depth++;
      else if ((c === '}' || c === ']') && --depth === 0) return JSON.parse(scripts.slice(start, i + 1));
    }
    fail('invalid_bootstrap', `页面 ${name} 数据格式发生变化。`);
  }
  const filters = input.id ? [{ k: 'o_id', v: input.id, c: '=' }] : (input.filters ?? JSON.parse(JSON.stringify(w.jTable.Filter)));
  const sort = input.sort ?? JSON.parse(JSON.stringify(w.jTable.OrderBy));
  const pageSize = [20, 50, 100, 200, 500, 1000, 1500, 2000].find(n => n >= (input.limit || 20)) || 2000;
  if (input.command === 'count') {
    const result = await rpc(w.location.href, w.document, 'LoadDataToJSONPage', [1, JSON.stringify(filters), JSON.stringify(sort)], 'JTable1', {
      _jt_page_size: String(pageSize), _jt_page_action: '2', _jt_page_increament_enabled: 'false', _jt_page_count_enabled: 'true',
    });
    if (!Number.isSafeInteger(result?.dp?.DataCount) || result.dp.DataCount < 0) fail('count_unavailable', '接口未返回有效总数。');
    return { total: result.dp.DataCount, pagination: result.dp, source: w.location.pathname };
  }
  const columns = input.includeColumns === false ? [] : JSON.parse(JSON.stringify(w.jTable.Config.flds));
  const list = await rpc(w.location.href, w.document, 'LoadDataToJSON', [input.page || 1, JSON.stringify(filters), JSON.stringify(sort)], 'JTable1', {
    _jt_page_size: String(pageSize), _jt_page_increament_enabled: 'false', _jt_page_action: '1', _jt_page_count_enabled: 'true',
  });
  if (!list || typeof list !== 'object') fail('invalid_list', '订单列表返回格式发生变化。');
  const mapped = list.datas ? list : w.jTable.DataMapping(list);
  if (!Array.isArray(mapped.datas)) fail('invalid_list', '订单列表没有 datas 数组。');
  if (input.command === 'login-status') return { logged_in: true, source: w.location.pathname, sample_rows: mapped.datas.length };
  const rows = mapped.datas.slice(0, input.limit || 20);
  const output = { version: 1, captured_at: new Date().toISOString(), source: 'https://www.erp321.com/app/order/order/list.aspx', filters, sort, page: input.page || 1, requested_limit: input.limit || 20, page_size: pageSize, returned_rows: mapped.datas.length, pagination: mapped.dp, columns, rows, details: [] };
  if (input.command === 'list') return output;
  if (input.id && !rows.length) fail('order_not_found', '未找到该内部订单号。');
  for (const row of rows) {
    if (!row.o_id_en) fail('missing_detail_link', '列表缺少 o_id_en，不能构造已验证的详情链接。');
    const url = new URL('/app/order/order/OrderEditorNew.aspx', w.location.origin);
    url.search = new URLSearchParams({ order_id: row.o_id_en, archive: 'false', owner_co_id: String(row.real_co_id || row.owner_co_id || row.co_id), fromList: 'true' }).toString();
    const response = await w.fetch(url.href, { credentials: 'include', signal: AbortSignal.timeout(40000) });
    const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
    const scripts = Array.from(doc.scripts).filter(s => !s.src).map(s => s.textContent).join('\n');
    let order = assignment(scripts, '_OrderData');
    if (!response.ok || !order?.o_id) fail('invalid_detail', '无法读取销售订单详情，请检查登录及订单权限。');
    if (String(order.o_id) !== String(row.o_id)) fail('wrong_order', '详情订单号与列表不一致。');
    const refreshed = await rpc(url.href, doc, 'ReloadOrder', ['true']);
    if (String(refreshed?.o_id) !== String(row.o_id)) fail('wrong_order', '刷新详情订单号与列表不一致。');
    order = { ...order, ...refreshed };
    const actions = await rpc(url.href, doc, 'GetOrderActionList', [order.o_id, '', 'false']);
    if (actions != null && !Array.isArray(actions)) fail('invalid_actions', '订单日志返回格式发生变化。');
    order.actions = actions ?? [];
    const aftersales = await rpc(url.href, doc, 'LoadAfterSale', []);
    const fieldLabels = {};
    for (const el of doc.querySelectorAll('[id]')) {
      if (!Object.hasOwn(order, el.id)) continue;
      const label = el.previousElementSibling?.textContent.trim();
      if (label && label.length < 50 && /[:：]$/.test(label)) fieldLabels[el.id] = label.replace(/[:：]$/, '');
    }
    output.details.push({ o_id: String(order.o_id), order, revenue: assignment(scripts, '_RevenueStatisticsData'), extensions: assignment(scripts, '_ExtDatas'), extension_model: assignment(scripts, '_extDatasModelData'), aftersales, field_labels: fieldLabels, source: url.origin + url.pathname });
  }
  return output;
}
