import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPAIR_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REPAIR_CONFIG = join(REPAIR_ROOT, 'config/failure-repair.json');
export const REPAIR_STATE = join(REPAIR_ROOT, 'var/failure-repair');
export const incidentKey = id => createHash('sha256').update(id).digest('hex');
export function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}
export function scrub(value, secrets = []) {
  let text = String(value ?? '');
  for (const secret of secrets.filter(Boolean)) text = text.split(secret).join('[已隐藏]');
  return text
    .replace(/https:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/[^\s"']+/gi, '[机器人地址已隐藏]')
    .replace(/\bBearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [已隐藏]')
    .replace(/\b(?:Cookie|Authorization|u_sso_token|(?:api[_-]?)?key|password|passwd|secret|(?:access[_-]?|refresh[_-]?)?token)\b["']?\s*[:=]\s*[^\r\n]+/gi, '[鉴权信息已隐藏]')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[私钥已隐藏]')
    .replace(/\bsk-[A-Za-z0-9_-]{15,}/g, '[API密钥已隐藏]');
}
export function loadRepairConfig(path = REPAIR_CONFIG) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { enabled: false };
}
export function enqueueIncident(event, { configPath = REPAIR_CONFIG, stateDir = REPAIR_STATE, now = Date.now } = {}) {
  const config = loadRepairConfig(configPath);
  if (!config.enabled || event.test || event.resolution || ['com.xdr.failure-watch', 'com.xdr.failure-repair'].includes(event.task)) return null;
  const key = incidentKey(event.id), path = join(stateDir, 'incidents', key + '.json');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const safe = { ...event, reason: scrub(event.reason).slice(0, 12000), phase: scrub(event.phase).slice(0, 500) };
  const record = { key, event: safe, state: 'queued', attempts: 0, created_at: new Date(now()).toISOString() };
  try { writeFileSync(path, JSON.stringify(record, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  return key;
}
