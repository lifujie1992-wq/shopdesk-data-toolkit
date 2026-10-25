import {
  closeSync,
  createReadStream,
  readdirSync,
  mkdtempSync,
  lstatSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { DatabaseSync } from "node:sqlite";

import { cookieHeader } from "./chrome-session.js";
import { CliError } from "./errors.js";

const EXPORT_BASE_URL = "https://www-do.erp321.com/app/item/itemsku/MapExport.aspx";
const REFERER = "https://www.erp321.com/app/item/itemtool/itemContrast.aspx";
const EXPORT_LOG_URL = "https://www.erp321.com/app/common/export/export_log.aspx?_float=true";
const XLSX_PREFIX = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

function assertAllowedTime(now = new Date()) {
  if (process.env.JST_AUTOMATED !== "1" || process.env.JST_MANUAL === "1"
    || process.env.JST_SHOP_PRODUCTS_NIGHT === "1") return;
  const hour = Number(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    hourCycle: "h23",
  }).format(now));
  if (hour >= 23 || hour < 7) {
    throw new CliError(
      "quiet_hours",
      "Automated reads are disabled from 23:00 through 06:59 Asia/Shanghai.",
    );
  }
}

function cookieValue(session, name) {
  return session.cookies.find((cookie) => cookie.name === name)?.value ?? "";
}

export function shopIdsFromInventory(path) {
  if (!path || !existsSync(path)) {
    throw new CliError("inventory_required", "A complete inventory SQLite file is required.");
  }
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = db.prepare(
      "SELECT shop_id FROM shop_directory WHERE shop_id <> '0' ORDER BY shop_id",
    ).all();
    const ids = rows.map((row) => String(row.shop_id)).filter((id) => /^\d+$/.test(id));
    if (!ids.length) {
      throw new CliError("shop_directory_empty", "No exportable shops were found in shop_directory.");
    }
    return ids;
  } finally {
    db.close();
  }
}

function responseFilename(location, fallback) {
  try {
    const disposition = new URL(location).searchParams.get("response-content-disposition") || "";
    const match = disposition.match(/filename\s*=\s*(.+)$/i);
    const encoded = match?.[1]?.replace(/^["']|["']$/g, "");
    const value = encoded ? decodeURIComponent(encoded) : null;
    if (value && /^[^/\\]+\.(?:xlsx|zip)$/i.test(value)) return value;
  } catch {}
  const name = basename(new URL(location).pathname);
  return /^[^/\\]+\.(?:xlsx|zip)$/i.test(name) ? name : fallback;
}

function decodeHtml(value) {
  return value.replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function hiddenValue(html, name, required = true) {
  for (const tag of html.match(/<input\b[^>]*>/gi) || []) {
    const foundName = tag.match(/\bname\s*=\s*(["'])(.*?)\1/i)?.[2];
    if (foundName !== name) continue;
    const value = tag.match(/\bvalue\s*=\s*(["'])(.*?)\1/i)?.[2];
    return value == null ? "" : decodeHtml(value);
  }
  if (!required) return null;
  throw new CliError("shop_products_filter_failed", `Missing ${name} in shop-product page.`);
}

function parseCallback(text) {
  const separator = text.indexOf("|");
  const prefixLength = Number(text.slice(0, separator));
  if (separator <= 0 || !Number.isInteger(prefixLength)) return null;
  return JSON.parse(text.slice(separator + 1 + prefixLength));
}

function requestHeaders(session) {
  return {
    cookie: cookieHeader(session),
    origin: "https://www.erp321.com",
    referer: REFERER,
    u_co_id: cookieValue(session, "u_co_id"),
    u_id: cookieValue(session, "u_id"),
  };
}

async function filterToken(session, shopId, filters, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const page = await fetch(REFERER, {
      signal: controller.signal,
      headers: { ...requestHeaders(session), accept: "text/html" },
    });
    const html = await page.text();
    if (!page.ok || html.includes("用户未登录")) {
      throw new CliError("not_logged_in", "The complete ERP session is missing or expired.");
    }
    const search = [{ k: "shop_id", v: shopId, c: "@=" }, ...filters];
    const callback = {
      Method: "SetSearchConditionToCache",
      Args: [JSON.stringify(search)],
      CallControl: "{page}",
    };
    const body = new URLSearchParams({
      __VIEWSTATE: hiddenValue(html, "__VIEWSTATE"),
      __VIEWSTATEGENERATOR: hiddenValue(html, "__VIEWSTATEGENERATOR"),
      __EVENTVALIDATION: hiddenValue(html, "__EVENTVALIDATION"),
      shop_id: shopId,
      __CALLBACKID: "JTable1",
      __CALLBACKPARAM: JSON.stringify(callback),
    });
    const response = await fetch(
      `${REFERER}?ts___=${Date.now()}&am___=SetSearchConditionToCache`,
      {
        method: "POST",
        signal: controller.signal,
        headers: {
          ...requestHeaders(session),
          accept: "*/*",
          "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
          "x-requested-with": "XMLHttpRequest",
        },
        body,
      },
    );
    const text = await response.text();
    const result = parseCallback(text);
    if (!response.ok || !result?.IsSuccess || !result.ReturnValue) {
      throw new CliError(
        "shop_products_filter_failed",
        `Could not cache shop-product filter: ${result?.ExceptionMessage || text.slice(-200)}`,
      );
    }
    return String(result.ReturnValue);
  } catch (error) {
    if (error.name === "AbortError") {
      throw new CliError("shop_products_export_timeout", "Shop-product filter timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function exportLogCall(session, method, args, callControl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const page = await fetch(EXPORT_LOG_URL, {
      signal: controller.signal,
      headers: { ...requestHeaders(session), referer: EXPORT_LOG_URL, accept: "text/html" },
    });
    const html = await page.text();
    if (!page.ok || html.includes("用户未登录")) {
      throw new CliError("not_logged_in", "The complete ERP session is missing or expired.");
    }
    const values = {
      __VIEWSTATE: hiddenValue(html, "__VIEWSTATE"),
      __VIEWSTATEGENERATOR: hiddenValue(html, "__VIEWSTATEGENERATOR"),
      __CALLBACKID: "JTable1",
      __CALLBACKPARAM: JSON.stringify({
        Method: method,
        Args: args.map(String),
        ...(callControl ? { CallControl: callControl } : {}),
      }),
    };
    const validation = hiddenValue(html, "__EVENTVALIDATION", false);
    if (validation != null) values.__EVENTVALIDATION = validation;
    const response = await fetch(
      `${EXPORT_LOG_URL}&ts___=${Date.now()}&am___=${encodeURIComponent(method)}`,
      {
        method: "POST",
        signal: controller.signal,
        headers: {
          ...requestHeaders(session),
          referer: EXPORT_LOG_URL,
          accept: "*/*",
          "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
          "x-requested-with": "XMLHttpRequest",
        },
        body: new URLSearchParams(values),
      },
    );
    const text = await response.text();
    const result = parseCallback(text);
    if (!response.ok || !result?.IsSuccess) {
      throw new CliError(
        "shop_products_async_export_failed",
        `Export log call ${method} failed: ${result?.ExceptionMessage || text.slice(-200)}`,
      );
    }
    return result.ReturnValue;
  } finally {
    clearTimeout(timer);
  }
}

async function listExportLogs(session, timeoutMs) {
  const value = await exportLogCall(
    session, "LoadDataToJSON", ["1", "[]", "{}"], null, timeoutMs,
  );
  return JSON.parse(value).datas || [];
}

function shanghaiTimestamp(value) {
  return Date.parse(`${String(value).replace(" ", "T")}+08:00`);
}

async function waitForAsyncExport(session, requestedAt, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const logs = await listExportLogs(session, Math.min(timeoutMs, 60_000));
    const record = logs
      .filter((item) => item.export_type === "店铺商品资料"
        && shanghaiTimestamp(item.created) >= requestedAt - 60_000)
      .sort((left, right) => Number(right.auto_id) - Number(left.auto_id))[0];
    if (record) {
      if (["生成文件失败", "已取消"].includes(record.status)) {
        throw new CliError(
          "shop_products_async_export_failed",
          record.message || `Async export ${record.auto_id} ended with ${record.status}.`,
        );
      }
      if (["等待下载", "文件已生成，可下载", "下载完成"].includes(record.status)) {
        const location = await exportLogCall(
          session, "CheckAndGetExportData", [record.auto_id], "{page}", 60_000,
        );
        if (location) return String(location);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  throw new CliError(
    "shop_products_async_export_timeout",
    "Timed out waiting for the asynchronous shop-product export.",
  );
}

async function requestBatch(session, batch, timeoutMs) {
  assertAllowedTime();
  const shopIds = batch.shops;
  const filtered = batch.filters?.length > 0;
  const token = filtered ? await filterToken(session, shopIds[0], batch.filters, timeoutMs) : null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `${EXPORT_BASE_URL}?dt=${filtered ? "filteritems" : ""}&exporttype=`;
    const response = await fetch(url, {
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        accept: "*/*",
        "content-type": "application/x-www-form-urlencoded",
        ...requestHeaders(session),
      },
      body: new URLSearchParams({
        shop_id: shopIds.join(","),
        ...(token ? { s: token } : {}),
      }),
    });
    const location = response.headers.get("location");
    if (response.status === 302 && location) return location;

    const requestedAt = Date.now();
    const text = (await response.text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    if (text.includes("用户未登录")) {
      throw new CliError(
        "not_logged_in",
        "The complete ERP session is missing or expired. Run: jst-inventory auth sync",
      );
    }
    if (text.includes("导出请求成功") && text.includes("导出记录")) {
      return await waitForAsyncExport(session, requestedAt, timeoutMs);
    }
    throw new CliError(
      "shop_products_export_failed",
      `Export returned HTTP ${response.status}: ${text.slice(-300)}`,
    );
  } catch (error) {
    if (error.name === "AbortError") {
      throw new CliError("shop_products_export_timeout", "Shop-product export timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function validSpreadsheet(path) {
  if (statSync(path).size < 1_000) return false;
  const prefix = Buffer.alloc(4);
  const handle = openSync(path, "r");
  try {
    return readSync(handle, prefix, 0, prefix.length, 0) === prefix.length
      && prefix.equals(XLSX_PREFIX);
  } finally {
    closeSync(handle);
  }
}

async function download(location, output, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(location, { signal: controller.signal });
    if (!response.ok || !response.body) {
      throw new CliError(
        "shop_products_download_failed",
        `Download returned HTTP ${response.status}.`,
      );
    }
    await pipeline(response.body, createWriteStream(output, { mode: 0o600 }));
  } catch (error) {
    rmSync(output, { force: true });
    if (error.name === "AbortError") {
      throw new CliError("shop_products_download_timeout", "Shop-product download timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
  if (!validSpreadsheet(output)) {
    rmSync(output, { force: true });
    throw new CliError(
      "invalid_shop_products_export",
      "Downloaded shop-product export is not a valid XLSX/ZIP file.",
    );
  }
}

async function fileSha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function transientFailure(error) {
  const networkCode = error.code || error.cause?.code;
  return ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "ENETUNREACH", "EAI_AGAIN", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"].includes(networkCode)
    || error.name === "TypeError" && /fetch failed|network|socket/i.test(error.message)
    || /^(shop_products_(export|download)_timeout|shop_products_async_export_timeout)$/.test(error.code || "")
    || /^(shop_products_(export|download)_failed)$/.test(error.code || "")
      && /HTTP (429|5[0-9]{2})/.test(error.message);
}

function ownerIsRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
}

function recoverPreviousJob(root, building, scope) {
  if (resolve(root) !== resolve(dirname(dirname(building))) || existsSync(building)) return;
  const candidates = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/i.test(entry.name)) continue;
    const previous = join(root, entry.name, "shop-products-export.building");
    const checkpoint = join(previous, "checkpoint.json");
    try {
      if (!lstatSync(previous).isDirectory() || lstatSync(previous).isSymbolicLink()
        || !lstatSync(checkpoint).isFile() || lstatSync(checkpoint).isSymbolicLink()) continue;
      const saved = JSON.parse(readFileSync(checkpoint, "utf8"));
      const age = Date.now() - Date.parse(saved.created_at);
      if (saved.version !== 1 || saved.scope !== scope || !Array.isArray(saved.files)
        || !saved.files.length || !Number.isFinite(age) || age < 0 || age > 12 * 3600_000
        || ownerIsRunning(saved.owner_pid)) continue;
      candidates.push({ previous, completed: saved.files.length, age });
    } catch { /* A partial or unrelated job is not a resumable export. */ }
  }
  candidates.sort((a,b) => b.completed - a.completed || a.age - b.age);
  if (candidates.length) renameSync(candidates[0].previous, building);
}

function validateBatches(batches, shops) {
  if (!Array.isArray(batches) || batches.some(batch => !Array.isArray(batch.shops)
    || !batch.shops.length || !Array.isArray(batch.filters))) {
    throw new CliError("invalid_export_plan", "Invalid shop-product batches.");
  }
  const coverage = new Map(shops.map((shop) => [shop, []]));
  for (const batch of batches || []) {
    for (const shop of batch.shops || []) coverage.get(shop)?.push(batch);
  }
  const validCoverage = [...coverage.values()].every((entries) => {
    if (entries.length === 1) return entries[0].filters.length === 0;
    if (entries.some((entry) => entry.shops.length !== 1)) return false;
    const byListing = new Map([["0", []], ["1", []]]);
    for (const entry of entries) {
      const enabled = entry.filters.filter((filter) => filter.k === "enabled");
      const stock = entry.filters.filter((filter) => filter.k === "shop_qty");
      if (enabled.length !== 1 || enabled[0].c !== "="
        || !byListing.has(String(enabled[0].v))
        || enabled.length + stock.length !== entry.filters.length
        || stock.some((filter) => ![">=", "<="].includes(filter.c))) return false;
      const lowerFilters = stock.filter((filter) => filter.c === ">=");
      const upperFilters = stock.filter((filter) => filter.c === "<=");
      if (lowerFilters.length > 1 || upperFilters.length > 1) return false;
      const lower = lowerFilters.length ? Number(lowerFilters[0].v) : -Infinity;
      const upper = upperFilters.length ? Number(upperFilters[0].v) : Infinity;
      if (!Number.isInteger(lower) && lower !== -Infinity) return false;
      if (!Number.isInteger(upper) && upper !== Infinity) return false;
      if (lower > upper) return false;
      byListing.get(String(enabled[0].v)).push({ lower, upper });
    }
    for (const ranges of byListing.values()) {
      ranges.sort((left, right) => left.lower - right.lower);
      if (!ranges.length || ranges[0].lower !== -Infinity
        || ranges.at(-1).upper !== Infinity) return false;
      for (let index = 1; index < ranges.length; index += 1) {
        if (ranges[index].lower !== ranges[index - 1].upper + 1) return false;
      }
    }
    return true;
  });
  if (!Array.isArray(batches) || batches.some((batch) => !batch.shops?.length)
    || batches.some((batch) => batch.shops.some((shop) => !coverage.has(shop)))
    || !validCoverage) {
    throw new CliError("invalid_export_plan", "Shop-product export plan does not match shop_directory.");
  }
}

export async function exportShopProducts({
  session,
  inventoryPath,
  outputDir,
  batchSize = 7,
  planPath,
  timeoutMs = 14_400_000,
  onProgress = () => {},
  retryDelaysMs = [5_000, 15_000],
  resumeRoot,
}) {
  const shops = shopIdsFromInventory(inventoryPath);
  let batches;
  if (planPath) {
    const plan = JSON.parse(readFileSync(planPath, "utf8"));
    batches = plan.batches?.map((batch) => ({
      shops: batch.shops?.map(String),
      filters: batch.filters || [],
    }));
    validateBatches(batches, shops);
  } else {
    batches = [];
    for (let index = 0; index < shops.length; index += batchSize) {
      batches.push({ shops: shops.slice(index, index + batchSize), filters: [] });
    }
  }

  validateBatches(batches, shops);
  const scope = createHash("sha256").update(JSON.stringify({
    shops, batches, company: cookieValue(session, "u_co_id"), user: cookieValue(session, "u_id"),
  })).digest("hex");
  const building = `${outputDir}.building`;
  const checkpointPath = join(building, "checkpoint.json");
  if (resumeRoot) recoverPreviousJob(resumeRoot, building, scope);
  mkdirSync(building, { recursive: true, mode: 0o700 });
  if (!lstatSync(building).isDirectory() || lstatSync(building).isSymbolicLink()) throw new CliError("invalid_shop_products_checkpoint", "Export staging directory must be owned and regular.");
  let createdAt = new Date().toISOString();
  const files = [];
  if (existsSync(checkpointPath)) {
    const saved = JSON.parse(readFileSync(checkpointPath, "utf8"));
    const age = Date.now() - Date.parse(saved.created_at);
    if (saved.version !== 1 || saved.scope !== scope || !Number.isFinite(age)
      || age < 0 || age > 12 * 60 * 60 * 1000 || !Array.isArray(saved.files)) {
      throw new CliError("shop_products_resume_mismatch", "Saved export scope or collection time does not match; files retained.");
    }
    validateBatches(saved.batches, shops);
    if (saved.files.length > saved.batches.length) throw new CliError("invalid_shop_products_checkpoint", "Too many completed export files.");
    for (const [index, item] of saved.files.entries()) {
      const path = join(building, item.name || "");
      if (!item.name || basename(item.name) !== item.name || !/\.(xlsx|zip)$/i.test(item.name)
        || item.batch !== index + 1 || JSON.stringify(item.shops) !== JSON.stringify(saved.batches[index].shops)
        || JSON.stringify(item.filters) !== JSON.stringify(saved.batches[index].filters)
        || !existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()
        || statSync(path).size !== item.bytes || !validSpreadsheet(path)
        || !/^[0-9a-f]{64}$/.test(item.sha256 || "") || await fileSha256(path) !== item.sha256) {
        throw new CliError("invalid_shop_products_checkpoint", "Saved export file failed scope/size/hash validation; files retained.");
      }
      files.push(item);
    }
    batches = saved.batches;
    createdAt = saved.created_at;
    onProgress({ event: "resumed", completed: files.length, total: batches.length });
  }
  // A crash can occur after a file download but before its checkpoint write.
  // Keep those unconfirmed files outside the directory that will be imported.
  const confirmed = new Set(files.map(item => item.name));
  const unconfirmed = readdirSync(building).filter(name => /\.(xlsx|zip)$/i.test(name) && !confirmed.has(name));
  if (unconfirmed.length) {
    const retained = mkdtempSync(building + ".unconfirmed-");
    for (const name of unconfirmed) renameSync(join(building, name), join(retained, name));
  }
  function checkpoint() {
    const temporary = checkpointPath + ".tmp";
    writeFileSync(temporary, JSON.stringify({ version: 1, scope, owner_pid: process.pid, created_at: createdAt,
      updated_at: new Date().toISOString(), batches, files }, null, 2) + "\n", { mode: 0o600 });
    renameSync(temporary, checkpointPath);
  }
  async function retry(operation, batch) {
    for (let attempt = 0; ; attempt += 1) {
      try { return await operation(); }
      catch (error) {
        if (!transientFailure(error) || attempt >= retryDelaysMs.length) throw error;
        onProgress({ event: "retry", batch, attempt: attempt + 1,
          delay_ms: retryDelaysMs[attempt], code: error.code || "network_error" });
        await new Promise(resolve => setTimeout(resolve, retryDelaysMs[attempt]));
      }
    }
  }
  checkpoint();
  try {
    for (let index = files.length; index < batches.length; index += 1) {
      let location;
      try {
        location = await retry(() => requestBatch(session, batches[index], timeoutMs), index + 1);
      } catch (error) {
        const batch = batches[index];
        // Historical counts are estimates. Split only a confirmed source limit,
        // preserving complete, disjoint shop coverage and serial execution.
        if (error.code !== "shop_products_export_failed"
          || !/导出数量超出最大限制.*100\s*万条/.test(error.message)
          || batch.shops.length < 2 || batch.filters.length) throw error;
        const middle = Math.ceil(batch.shops.length / 2);
        batches.splice(index, 1,
          { shops: batch.shops.slice(0, middle), filters: [] },
          { shops: batch.shops.slice(middle), filters: [] });
        checkpoint();
        index -= 1;
        continue;
      }
      const fallback = `shop-products-batch-${String(index + 1).padStart(3, "0")}.xlsx`;
      let name = responseFilename(location, fallback);
      if (files.some((file) => file.name === name)) name = `${index + 1}-${name}`;
      const path = join(building, name);
      await retry(() => download(location, path, timeoutMs), index + 1);
      const item = {
        batch: index + 1,
        shops: batches[index].shops,
        filters: batches[index].filters,
        name,
        bytes: statSync(path).size,
        sha256: await fileSha256(path),
        captured_at: new Date().toISOString(),
      };
      files.push(item);
      checkpoint();
      onProgress({ completed: index + 1, total: batches.length, ...item });
    }

    const manifest = {
      version: 1,
      captured_at: new Date().toISOString(),
      shop_count: shops.length,
      batch_size: planPath ? null : batchSize,
      batch_count: batches.length,
      files,
    };
    writeFileSync(
      join(building, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { mode: 0o600 },
    );
    rmSync(outputDir, { recursive: true, force: true });
    mkdirSync(dirname(outputDir), { recursive: true, mode: 0o700 });
    renameSync(building, outputDir);
    rmSync(join(outputDir, "checkpoint.json"), { force: true });
    return {
      output_dir: outputDir,
      shop_count: shops.length,
      batch_count: batches.length,
      files: files.length,
      bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    };
  } catch (error) {
    // Keep completed, hashed batches for this exact scope. Publication happens
    // only after every planned batch has downloaded and passed validation.
    throw error;
  }
}
