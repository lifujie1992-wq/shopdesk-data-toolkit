/**
 * 数据落位的唯一出口。
 *
 * 现在：SQLite 散落在 ~，最大 1.2GB，还有明文 cookie 在根目录。
 * 之后：全部走 SHOPDESK_DATA，默认 ~/shopdesk-data/。
 * 迁移期用 legacyDataPath() 映射旧位置，软链切换。
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const HOME = homedir();

/** 数据根目录。设 SHOPDESK_DATA 可整体搬走（例如外置盘）。 */
export const DATA_ROOT = process.env.SHOPDESK_DATA
  ? resolve(process.env.SHOPDESK_DATA)
  : join(HOME, "shopdesk-data");

/** 数据集 → 目录。第一段是数据源，第二段是业务域。 */
export const DATASETS = Object.freeze({
  "jst/orders": "jst/orders",
  "jst/sales": "jst/sales",
  "jst/inventory": "jst/inventory",
  "jst/order-page": "jst/order-page",
  "jst/aftersales": "jst/aftersales",
  "jst/purple": "jst/purple",
  "jst/profit": "jst/profit",
  "doudian/metrics": "doudian/metrics",
  "doudian/reviews": "doudian/reviews",
  "doudian/invoice": "doudian/invoice",
  archive: "archive",
});

/**
 * @param {keyof typeof DATASETS | string} dataset
 * @param {string} [file]
 */
export function resolveDataPath(dataset, file) {
  const dir = DATASETS[dataset] ?? dataset;
  return file ? join(DATA_ROOT, dir, file) : join(DATA_ROOT, dir);
}

/**
 * 旧位置映射。迁移期用于「同一份数据两个路径都能访问」。
 * 阶段 4 结束后可删除。
 */
export const LEGACY_PATHS = Object.freeze({
  "jst-order-details.sqlite": "jst/orders/order-details.sqlite",
  "jst-order-item-details.sqlite": "jst/orders/order-item-details.sqlite",
  "jst-sales-performance.sqlite": "jst/sales/sales-performance.sqlite",
  "jst-inventory-full.sqlite": "jst/inventory/inventory-full.sqlite",
  "jst-aftersales.sqlite": "jst/aftersales/aftersales.sqlite",
  "jst-refund-export.sqlite": "jst/aftersales/refund-export.sqlite",
  "jst-purple-orders.sqlite": "jst/purple/purple-orders.sqlite",
  "jst-profit-facts.sqlite": "jst/profit/profit-facts.sqlite",
});

/** 旧家目录文件 → 新路径。未登记的原样返回。 */
export function migrateLegacyPath(path) {
  const name = path.split("/").pop();
  return LEGACY_PATHS[name] ? resolveDataPath(LEGACY_PATHS[name]) : path;
}
