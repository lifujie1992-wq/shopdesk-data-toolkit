/**
 * CLI 骨架：一个数据源一个命令，子命令分发。
 *
 * 输出契约与旧脚本完全一致（xdr-sync-agent 和 agent 都按这个解析）：
 *   成功 {"ok":true,"data":...}
 *   失败 {"ok":false,"error":{"code","message"}}
 */
import { CliError, EXIT, toErrorPayload } from "./errors.js";

export function ok(data) {
  process.stdout.write(`${JSON.stringify({ ok: true, data })}\n`);
}

export function fail(error) {
  const payload = toErrorPayload(error);
  process.stdout.write(`${JSON.stringify({ ok: false, error: { code: payload.code, message: payload.message } })}\n`);
  process.exitCode = payload.exitCode ?? EXIT.failure;
}

function renderHelp({ name, description, commands }) {
  const lines = [`Usage: ${name} <command> [options]`, ""];
  if (description) lines.push(description, "");
  lines.push("Commands:");
  const width = Math.max(...Object.keys(commands).map((c) => c.length), 7);
  for (const [command, spec] of Object.entries(commands)) {
    lines.push(`  ${command.padEnd(width)}  ${spec.description ?? ""}`);
  }
  lines.push("", "  -h, --help   Show help");
  return lines.join("\n");
}

/**
 * @param {{name: string, description?: string, commands: Record<string, {description?: string, usage?: string, run: (args: string[], ctx: object) => any}>}} program
 */
export function createProgram(program) {
  return program;
}

/**
 * @param {ReturnType<typeof createProgram>} program
 * @param {string[]} [argv]
 */
export async function run(program, argv = process.argv.slice(2)) {
  const { name, commands } = program;
  const [command, ...rest] = argv;

  if (!command || command === "-h" || command === "--help") {
    process.stdout.write(`${renderHelp(program)}\n`);
    return;
  }

  const spec = commands[command];
  if (!spec) {
    fail(new CliError("unknown_command", `Unknown command: ${command}. Try ${name} --help`));
    return;
  }

  if (rest.includes("-h") || rest.includes("--help")) {
    if (spec.selfHelp) {
      const data = await spec.run(rest, { program });
      if (data !== undefined && !spec.selfHandled) ok(data);
      return;
    }
    const usage = spec.usage ? `Usage: ${name} ${command} ${spec.usage}` : renderHelp(program);
    process.stdout.write(`${usage}\n`);
    return;
  }

  try {
    const data = await spec.run(rest, { program });
    if (data !== undefined && !spec.selfHandled) ok(data);
  } catch (error) {
    fail(error);
  }
}

/**
 * 声明式参数解析。
 * @param {string[]} args
 * @param {Record<string, {type?: "string"|"number"|"boolean", default?: any, min?: number, max?: number, short?: string, values?: string[]}>} spec
 * @param {{allowUnknown?: boolean, allowPositionals?: boolean}} [options]
 */
export function parseFlags(args, spec = {}, options = {}) {
  const { allowUnknown = false, allowPositionals = false } = options;
  const byShort = new Map();
  for (const [name, def] of Object.entries(spec)) {
    if (def.short) byShort.set(def.short, name);
  }

  const values = {};
  for (const [name, def] of Object.entries(spec)) {
    if (def.default !== undefined) values[name] = def.default;
  }
  const positionals = [];
  const seen = new Set();

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    let name;
    let inline;

    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      const raw = eq === -1 ? token.slice(2) : token.slice(2, eq);
      name = raw;
      if (eq !== -1) inline = token.slice(eq + 1);
    } else if (token.startsWith("-") && token.length === 2) {
      name = byShort.get(token.slice(1));
      if (!name) {
        if (allowUnknown) continue;
        throw new CliError("invalid_arguments", `Unknown option: ${token}`);
      }
    } else {
      if (!allowPositionals) {
        throw new CliError("invalid_arguments", `Unexpected argument: ${token}`);
      }
      positionals.push(token);
      continue;
    }

    const def = spec[name];
    if (!def) {
      if (allowUnknown) continue;
      throw new CliError("invalid_arguments", `Unknown option: --${name}`);
    }

    const type = def.type ?? "string";
    if (type === "boolean") {
      values[name] = inline === undefined ? true : inline !== "false";
      seen.add(name);
      continue;
    }

    const raw = inline ?? args[i + 1];
    if (raw === undefined || (inline === undefined && raw.startsWith("--"))) {
      throw new CliError("invalid_arguments", `--${name} requires a value.`);
    }
    if (inline === undefined) i += 1;

    if (type === "number") {
      const value = Number(raw);
      if (!Number.isInteger(value)) {
        throw new CliError("invalid_arguments", `--${name} must be an integer.`);
      }
      if (def.min !== undefined && value < def.min) {
        throw new CliError("invalid_arguments", `--${name} must be >= ${def.min}.`);
      }
      if (def.max !== undefined && value > def.max) {
        throw new CliError("invalid_arguments", `--${name} must be <= ${def.max}.`);
      }
      values[name] = value;
    } else {
      if (def.values && !def.values.includes(raw)) {
        throw new CliError(
          "invalid_arguments",
          `--${name} must be one of: ${def.values.join(", ")}.`,
        );
      }
      values[name] = raw;
    }
    seen.add(name);
  }

  values.__provided = (name) => seen.has(name);
  values.__positionals = positionals;
  return values;
}
