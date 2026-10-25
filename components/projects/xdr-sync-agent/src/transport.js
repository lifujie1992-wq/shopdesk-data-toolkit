import { basename } from "node:path";
import { runJson, runProcess } from "./process.js";
import { validAgent, validDataset, validUuid, PHASES } from "./validation.js";

const READY = /^[0-9a-f-]{36}\.(inventory|spu_live|orders|sales|order_page|paid_orders|profit_analysis|profit_facts|shop_products|doudian|doudian_client|doudian_invoice|unshipped_orders|jst_purple_orders)\.(full|patch)\.sqlite\.gz\.(partial|ready)$/i;
const SHA = /^[0-9a-f-]{36}\.(inventory|spu_live|orders|sales|order_page|paid_orders|profit_analysis|profit_facts|shop_products|doudian|doudian_client|doudian_invoice|unshipped_orders|jst_purple_orders)\.(full|patch)\.sha256\.(partial|ready)$/i;

export class Transport {
  constructor(config, agentId) { this.config = config; this.agentId = validAgent(agentId); }
  sshArgs(remoteArgs) {
    return ["-i", this.config.server.identity_file, "-p", String(this.config.server.port),
      "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
      `${this.config.server.user}@${this.config.server.host}`, this.config.server.ctl, ...remoteArgs];
  }
  async ctl(args, timeoutMs = 30_000) {
    return runJson("ssh", this.sshArgs(args), { timeoutMs });
  }
  lease(tasks = null, excludeTasks = null) {
    const args = ["agent-lease", "--agent", this.agentId];
    for (const task of tasks || []) args.push("--tasks", task);
    for (const task of excludeTasks || []) args.push("--exclude-tasks", task);
    return this.ctl(args);
  }
  heartbeat(jobId, phase) {
    validUuid(jobId); if (!PHASES.has(phase)) throw new Error("invalid phase");
    return this.ctl(["agent-heartbeat", "--job", jobId, "--agent", this.agentId, "--phase", phase]);
  }
  async upload(jobId, dataset, dataPath, shaPath) {
    validUuid(jobId); validDataset(dataset);
    const dataName = basename(dataPath); const shaName = basename(shaPath);
    if (!READY.test(dataName) || !dataName.endsWith(".partial")) throw new Error("invalid upload filename");
    if (!SHA.test(shaName) || !shaName.endsWith(".partial")) throw new Error("invalid sha filename");
    const common = ["-O", "-i", this.config.server.identity_file, "-P", String(this.config.server.port),
      "-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];
    for (const path of [dataPath, shaPath]) {
      const args = [...common, path, `${this.config.server.user}@${this.config.server.host}:${this.config.server.incoming}/${basename(path)}`];
      const result = await runProcess("scp", args, { timeoutMs: 300_000 });
      if (result.code !== 0) {
        throw Object.assign(new Error(`scp_failed:${result.code ?? "signal"}`), { diagnostic: {
          executable: "scp", args, exit_code: result.code, signal: result.signal || null,
          timed_out: result.timedOut,
          stdout: (result.stdout || "").slice(-2000), stderr: (result.stderr || "").slice(-2000),
        }});
      }
    }
    return this.ctl(["agent-upload-ready", "--job", jobId, "--agent", this.agentId,
      "--dataset", dataset, "--data", dataName, "--sha", shaName], 300_000);
  }
  apply(jobId, dataset) {
    validUuid(jobId); validDataset(dataset);
    const timeoutMs = (this.config.command_timeout_seconds ?? 1_200) * 1000;
    return this.ctl(["agent-apply", "--job", jobId, "--agent", this.agentId, "--dataset", dataset], timeoutMs);
  }
  complete(jobId) { validUuid(jobId); return this.ctl(["agent-complete", "--job", jobId, "--agent", this.agentId]); }
  fail(jobId, code) { validUuid(jobId); return this.ctl(["agent-fail", "--job", jobId, "--agent", this.agentId, "--error", String(code).replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 160)]); }
  enqueue(task, source = "manual") {
    if (!["manual", "auto"].includes(source)) throw new Error("invalid enqueue source");
    return this.ctl(["enqueue", task, "--source", source]);
  }
  status() { return this.ctl(["status", "--json"]); }
}
