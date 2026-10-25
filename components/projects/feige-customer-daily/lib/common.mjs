export class CaptureError extends Error {
  constructor(code, message, details = {}) { super(message); this.code = code; this.details = details; }
}
export function shanghaiDate(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
export function yesterday(now = new Date()) {
  return new Date(Date.parse(shanghaiDate(now) + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
}
export function validateDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date + 'T00:00:00Z')) ||
    new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) !== date || date > shanghaiDate()) {
    throw new CaptureError('invalid_date', '日期必须是有效的YYYY-MM-DD，且不能晚于今天。');
  }
  return date;
}
export function parseJson(text) {
  return JSON.parse(text, (_key, value, context) => typeof value === 'number' && Number.isInteger(value) &&
    !Number.isSafeInteger(value) ? context.source : value);
}
export function safeError(error) {
  return error instanceof CaptureError ? {code: error.code, message: error.message,
    ...Object.fromEntries(['http_status', 'platform_code', 'page', 'attempts'].filter(key =>
      Object.hasOwn(error.details, key)).map(key => [key, error.details[key]]))} :
    {code: 'internal_error', message: '采集发生异常，请检查本机任务和目录权限。'};
}
export function flatten(row = {}) {
  return Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'staffUserInfo').flatMap(([key, value]) => {
    if (value && typeof value === 'object' && Object.hasOwn(value, 'fieldValue')) {
      return [[key, value.fieldValue], ...(Object.hasOwn(value, 'isAlert') ? [[key + '__isAlert', value.isAlert]] : [])];
    }
    return [[key, value && typeof value === 'object' ? JSON.stringify(value) : value]];
  }));
}
export function coreMetrics(core) {
  const values = Object.fromEntries((core?.coreChartInfo?.chart_info?.data || []).map(x => [x.index_name, x.y]));
  values.avgOnlineDuration = core?.avgOnlineInfo?.index_value ?? null;
  values.avgNapDuration = core?.avgNapInfo?.index_value ?? null;
  return values;
}
export function formatDuration(value) {
  if (value === null || value === undefined || value === '') return '';
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return String(value);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(Math.floor(seconds / 3600))}时${pad(Math.floor(seconds / 60) % 60)}分${pad(Math.floor(seconds) % 60)}秒`;
}
