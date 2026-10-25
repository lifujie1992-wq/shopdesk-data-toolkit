import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

// 采集、恢复及清理共用此排他锁；不自动抢占已有锁。
export function acquireCaptureLock(stateDir) {
  fs.mkdirSync(stateDir, {recursive: true, mode: 0o700});
  fs.chmodSync(stateDir, 0o700);
  const file = path.join(stateDir, 'capture.lock');
  const owner = JSON.stringify({pid: process.pid, startedAt: new Date().toISOString(), nonce: randomUUID()});
  let fd;
  try { fd = fs.openSync(file, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') return null; throw error; }
  try { fs.writeFileSync(fd, owner); } finally { fs.closeSync(fd); }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { if (fs.readFileSync(file, 'utf8') === owner) fs.unlinkSync(file); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  };
}
