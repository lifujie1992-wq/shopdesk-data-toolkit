// 结构化日志：stdout + 文件，经 sanitizeLog 脱敏
import fs from 'node:fs';
import path from 'node:path';
import { sanitizeLog } from './redact.mjs';

export function createLogger(logDir) {
  fs.mkdirSync(logDir, {recursive: true, mode: 0o700});
  fs.chmodSync(logDir, 0o700);
  const logFile = path.join(logDir, 'agent.log');
  const stream = fs.createWriteStream(logFile, {flags: 'a', mode: 0o600});
  stream.once('open', () => fs.chmodSync(logFile, 0o600));

  function write(level, rec) {
    const line = JSON.stringify({ ts: new Date().toISOString(), level, ...sanitizeLog(rec) });
    stream.write(line + '\n');
    if (level === 'error') process.stderr.write(line + '\n');
    else process.stdout.write(line + '\n');
  }

  return {
    info: (rec) => write('info', rec),
    warn: (rec) => write('warn', rec),
    error: (rec) => write('error', rec),
  };
}
