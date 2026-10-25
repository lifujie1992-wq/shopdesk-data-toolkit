// 配置来源优先级：环境变量 > ~/.config/invoice-mac-agent/config.json > 默认值
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CONFIG_PATH = path.join(os.homedir(), '.config', 'invoice-mac-agent', 'config.json');
const SHOPDESK_BRIDGE_PATH = path.join(os.homedir(), 'Library', 'Application Support', 'shopdesk', 'agent-bridge.json');
const ENV_KEYS = {
  workbenchBaseUrl: 'INVOICE_AGENT_WORKBENCH_BASE_URL',
  accountId: 'INVOICE_AGENT_ACCOUNT_ID',
  workerToken: 'INVOICE_AGENT_WORKER_TOKEN',
  submitMode: 'INVOICE_AGENT_SUBMIT_MODE',
  pollIntervalMs: 'INVOICE_AGENT_POLL_INTERVAL_MS',
  maxJobs: 'INVOICE_AGENT_MAX_JOBS',
  maxJobsPerRun: 'INVOICE_AGENT_MAX_JOBS_PER_RUN',
  maxRunMs: 'INVOICE_AGENT_MAX_RUN_MS',
  retryBackoffMs: 'INVOICE_AGENT_RETRY_BACKOFF_MS',
  maxRetryBackoffMs: 'INVOICE_AGENT_MAX_RETRY_BACKOFF_MS',
  leaseSoftDeadlineMs: 'INVOICE_AGENT_LEASE_SOFT_DEADLINE_MS',
  requestTimeoutMs: 'INVOICE_AGENT_REQUEST_TIMEOUT_MS',
  downloadTimeoutMs: 'INVOICE_AGENT_DOWNLOAD_TIMEOUT_MS',
  bridgeTimeoutMs: 'INVOICE_AGENT_BRIDGE_TIMEOUT_MS',
  stagingDir: 'INVOICE_AGENT_STAGING_DIR',
  logDir: 'INVOICE_AGENT_LOG_DIR',
  captureEnabled: 'INVOICE_AGENT_CAPTURE_ENABLED',
  captureSourceMachine: 'INVOICE_AGENT_CAPTURE_SOURCE_MACHINE',
  captureStateDir: 'INVOICE_AGENT_CAPTURE_STATE_DIR',
  captureRetentionDays: 'INVOICE_AGENT_CAPTURE_RETENTION_DAYS',
  captureShopdeskDir: 'INVOICE_AGENT_CAPTURE_SHOPDESK_DIR',
  captureUploadAllFailedBatch: 'INVOICE_AGENT_CAPTURE_UPLOAD_ALL_FAILED_BATCH',
  captureRequestTimeoutMs: 'INVOICE_AGENT_CAPTURE_REQUEST_TIMEOUT_MS',
};

function defaults() {
  return {
    workbenchBaseUrl: '',
    accountId: '',
    workerToken: '',
    submitMode: 'dry-run',
    captureEnabled: false,
    captureSourceMachine: 'mac-invoice-agent',
    captureStateDir: path.join(os.homedir(), '.local', 'share', 'invoice-mac-agent', 'capture'),
    captureRetentionDays: 7,
    captureShopdeskDir: path.join(os.homedir(), 'Library', 'Application Support', 'shopdesk'),
    captureUploadAllFailedBatch: true,
    captureRequestTimeoutMs: 30_000,
    pollIntervalMs: 60_000,
    maxJobs: 1,
    maxJobsPerRun: 20,
    maxRunMs: 480_000,
    retryBackoffMs: 300_000,
    maxRetryBackoffMs: 1_800_000,
    leaseSoftDeadlineMs: 60_000,
    requestTimeoutMs: 30_000,
    downloadTimeoutMs: 120_000,
    bridgeTimeoutMs: 180_000,
    stagingDir: path.join(os.homedir(), '.local', 'share', 'invoice-mac-agent', 'staging'),
    logDir: path.join(os.homedir(), '.local', 'share', 'invoice-mac-agent', 'logs'),
  };
}

function assertPrivateFile(file) {
  const stat = fs.statSync(file);
  if ((stat.mode & 0o077) !== 0) throw Error(`配置文件权限必须为 0600: ${file}`);
}

export function loadConfig(env = process.env) {
  const cfg = defaults();
  try {
    assertPrivateFile(CONFIG_PATH);
    Object.assign(cfg, JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`配置文件读取失败 ${CONFIG_PATH}: ${error.message}`);
  }
  const types = defaults();
  for (const [key, envName] of Object.entries(ENV_KEYS)) {
    if (env[envName] !== undefined && env[envName] !== '') {
      if (typeof types[key] === 'boolean') {
        if (!['true', 'false'].includes(env[envName])) throw Error(`${envName} 必须为 true/false`);
        cfg[key] = env[envName] === 'true';
      } else cfg[key] = typeof types[key] === 'number' ? Number(env[envName]) : env[envName];
    }
  }
  if (Object.hasOwn(cfg, 'claimBatchSize') || env.INVOICE_AGENT_CLAIM_BATCH_SIZE !== undefined) {
    throw new Error('claimBatchSize 已移除，请使用 maxJobs（环境变量 INVOICE_AGENT_MAX_JOBS）设置每次领取数量');
  }
  return cfg;
}

export function assertConfig(cfg) {
  for (const key of ['workbenchBaseUrl', 'accountId', 'workerToken']) {
    if (typeof cfg[key] !== 'string' || !cfg[key].trim()) throw new Error(`缺少必填配置: ${key}`);
  }
  let base;
  try { base = new URL(cfg.workbenchBaseUrl); } catch { throw Error('workbenchBaseUrl 必须是有效 URL'); }
  if (base.protocol !== 'https:') throw Error('workbenchBaseUrl 必须使用 HTTPS');
  if (cfg.workerToken.length < 24) throw Error('workerToken 长度不能少于 24 字符');
  if (!['dry-run', 'upload-only', 'auto'].includes(cfg.submitMode)) {
    throw new Error(`submitMode 非法（须为 dry-run/upload-only/auto）: ${cfg.submitMode}`);
  }
  if (!Number.isInteger(cfg.maxJobs) || cfg.maxJobs < 1 || cfg.maxJobs > 20) throw new Error(`maxJobs 非法（1-20）: ${cfg.maxJobs}`);
  if (!Number.isInteger(cfg.maxJobsPerRun) || cfg.maxJobsPerRun < 1 || cfg.maxJobsPerRun > 20) throw new Error('maxJobsPerRun 必须为1-20的整数');
  for (const key of ['maxRunMs', 'retryBackoffMs', 'maxRetryBackoffMs']) {
    if (!Number.isSafeInteger(cfg[key]) || cfg[key] < 1000) throw new Error(`${key} 必须是不小于1000的整数`);
  }
  if (cfg.maxRetryBackoffMs < cfg.retryBackoffMs) throw new Error('maxRetryBackoffMs 不能小于 retryBackoffMs');
  for (const key of ['pollIntervalMs', 'leaseSoftDeadlineMs', 'requestTimeoutMs', 'downloadTimeoutMs', 'bridgeTimeoutMs']) {
    if (!Number.isFinite(cfg[key]) || cfg[key] < 1000) throw Error(`${key} 必须是不小于 1000 的数字`);
  }
  return cfg;
}

export function assertCaptureConfig(cfg, {dryRun = false} = {}) {
  if (!dryRun) assertConfig(cfg);
  if (typeof cfg.captureEnabled !== 'boolean') throw Error('captureEnabled 必须为布尔值');
  if (cfg.captureUploadAllFailedBatch !== true) throw Error('captureUploadAllFailedBatch 必须为 true（保留失败审计）');
  for (const k of ['captureStateDir', 'captureShopdeskDir']) {
    if (typeof cfg[k] !== 'string' || !path.isAbsolute(cfg[k])) throw Error(`${k} 必须为绝对路径`);
  }
  if (!Number.isInteger(cfg.captureRequestTimeoutMs) || cfg.captureRequestTimeoutMs < 1000) throw Error('captureRequestTimeoutMs 必须是不小于 1000 的整数');
  if (typeof cfg.captureSourceMachine !== 'string' || !cfg.captureSourceMachine.trim()) throw Error('captureSourceMachine 不能为空');
  return cfg;
}

export function assertCaptureCleanupConfig(cfg) {
  if (typeof cfg.captureStateDir !== 'string' || !path.isAbsolute(cfg.captureStateDir) || path.resolve(cfg.captureStateDir) === path.parse(cfg.captureStateDir).root) {
    throw Error('清理目录 captureStateDir 必须是非根目录的绝对路径');
  }
  if (!Number.isInteger(cfg.captureRetentionDays) || cfg.captureRetentionDays < 1 || cfg.captureRetentionDays > 3650) {
    throw Error('captureRetentionDays 必须为1-3650的整数');
  }
  return cfg;
}

export function loadShopdeskBridge() {
  assertPrivateFile(SHOPDESK_BRIDGE_PATH);
  const bridge = JSON.parse(fs.readFileSync(SHOPDESK_BRIDGE_PATH, 'utf8'));
  if (!Number.isInteger(Number(bridge.port)) || !bridge.token) throw new Error('agent-bridge.json 缺少 port/token');
  return {port: Number(bridge.port), token: String(bridge.token)};
}

export function configPath() {
  return CONFIG_PATH;
}
