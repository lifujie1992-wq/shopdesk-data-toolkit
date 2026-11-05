/**
 * 日期工具。业务口径统一用 Asia/Shanghai，不允许用本机时区。
 * 代码来自 jushuitan-order-details/src/api.js，行为保持一致。
 */
import { CliError } from "./errors.js";

export const SHANGHAI = "Asia/Shanghai";

export function assertDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new CliError("invalid_date", "Date must use YYYY-MM-DD format.");
  }
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.toISOString().slice(0, 10) !== value) {
    throw new CliError("invalid_date", "Date is not a valid calendar date.");
  }
  return value;
}

/** 上海时区的「现在」。 */
export function shanghaiNow(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SHANGHAI,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const v = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return { date: `${v.year}-${v.month}-${v.day}`, hour: Number(v.hour) };
}

/** 上海时区的昨天。 */
export function yesterdayShanghai(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SHANGHAI,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(now.getTime() - 86_400_000));
  const v = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${v.year}-${v.month}-${v.day}`;
}

export function shiftDate(value, days) {
  assertDate(value);
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

export function previousDate(value) {
  return shiftDate(value, -1);
}

/**
 * @param {number} days 含首尾的天数
 * @param {string} [endDate] 默认上海时区昨天
 */
export function dateRange(days = 30, endDate = yesterdayShanghai()) {
  if (!Number.isInteger(days) || days < 1 || days > 366) {
    throw new CliError("invalid_days", "--days must be 1-366.");
  }
  assertDate(endDate);
  const startDate = shiftDate(endDate, -(days - 1));
  return {
    days,
    start_date: startDate,
    end_date: endDate,
    startDateTime: `${startDate} 00:00:00`,
    endDateTime: `${endDate} 23:59:59`,
  };
}

/**
 * 静默时段保护：自动化任务在 23:00–06:59 不发请求。
 * 手工执行（JST_MANUAL=1）或显式关闭（JST_AUTOMATED!=1）时不受限。
 * 行为与 jushuitan-inventory-warning 一致。
 */
export function assertAllowedHour(now = new Date()) {
  if (process.env.JST_AUTOMATED !== "1") return;
  if (process.env.JST_MANUAL === "1") return;
  const { hour } = shanghaiNow(now);
  if (hour >= 23 || hour < 7) {
    throw new CliError(
      "quiet_hours",
      "Automated reads are disabled from 23:00 through 06:59 Asia/Shanghai.",
    );
  }
}
