import { spawn } from "node:child_process";

function redact(value) {
  return String(value || "").split(/\r?\n/).map((line) => {
    if (/cookie|authorization|api[_ -]?key|token|receiver|buyer_message|remark/i.test(line)) return "[REDACTED]";
    return line.replace(/([A-Za-z0-9_.-]*(?:secret|password|passwd|session)[A-Za-z0-9_.-]*\s*[=:]\s*)\S+/gi, "$1[REDACTED]");
  }).join("\n").slice(-8_000);
}

function commandError(message, command, args, result) {
  return Object.assign(new Error(message), { diagnostic: {
    executable: command, args: [...args], exit_code: result.code,
    signal: result.signal || null, timed_out: result.timedOut,
    stdout: redact(result.stdout), stderr: redact(result.stderr),
  }});
}

export function runProcess(command, args, { timeoutMs = 1_200_000, input, env, maxOutput = 1_000_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, env: env || process.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const append = (current, chunk) => (current + chunk.toString("utf8")).slice(-maxOutput);
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.on("error", reject);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, timeoutMs);
    timer.unref();
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

export async function runJson(command, args, options) {
  const result = await runProcess(command, args, options);
  if (result.timedOut) throw commandError("command_timeout", command, args, result);
  let value;
  try {
    const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
    value = JSON.parse(lines.at(-1) || "");
  } catch {
    throw commandError(`invalid_json_output (exit ${result.code ?? "signal"})`, command, args, result);
  }
  if (result.code !== 0 || value?.ok !== true) {
    const code = value?.error?.code || `exit_${result.code ?? "signal"}`;
    throw commandError(`command_failed:${String(code).replace(/[^A-Za-z0-9_.-]/g, "_")}`, command, args, result);
  }
  return value.data;
}
