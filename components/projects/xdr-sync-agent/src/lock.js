import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function acquireLock(stateDir) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const path = join(stateDir, "agent.lock");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeFileSync(fd, `${process.pid}\n`, "utf8");
      return () => { try { closeSync(fd); } catch {} try { unlinkSync(path); } catch {} };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let pid = 0;
      try { pid = Number(readFileSync(path, "utf8").trim()); } catch {}
      if (Number.isInteger(pid) && pid > 1 && alive(pid)) throw new Error(`agent_already_running:${pid}`);
      try { unlinkSync(path); } catch {}
    }
  }
  throw new Error("could_not_acquire_lock");
}
