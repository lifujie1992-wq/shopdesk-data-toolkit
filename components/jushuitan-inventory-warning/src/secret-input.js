import { CliError } from "./errors.js";

export async function readSecret(prompt) {
  if (!process.stdin.isTTY) {
    let value = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) value += chunk;
    return value.trim();
  }

  process.stderr.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  return new Promise((resolve, reject) => {
    let value = "";
    const finish = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      process.stderr.write("\n");
    };
    const onData = (chunk) => {
      if (chunk === "\u0003") {
        finish();
        reject(new CliError("cancelled", "Cookie import cancelled."));
        return;
      }
      if (chunk.includes("\r") || chunk.includes("\n")) {
        value += chunk.split(/[\r\n]/, 1)[0];
        finish();
        resolve(value.replace(/\u001b\[200~/g, "").replace(/\u001b\[201~/g, "").trim());
        return;
      }
      value += chunk;
    };
    process.stdin.on("data", onData);
  });
}
