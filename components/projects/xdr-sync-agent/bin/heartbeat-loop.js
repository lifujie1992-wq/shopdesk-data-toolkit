#!/usr/bin/env node
// 独立心跳看门狗。
//
// 背景：daemon 主进程在 diff 阶段会调用 buildTransfer()，里面用 node:sqlite
// 的同步 API 对 GB 级库做 join/insert，会把事件循环整体阻塞几分钟到几十分钟。
// 这期间主进程里的 setInterval 心跳根本发不出去，而服务端租约只有 180s
// （LEASE_SECONDS），于是任务被 clean_expired 判成 lease_expired，接着下一次
// 阶段切换的 await heartbeat 抛 "lease owner mismatch"，整个任务失败。
//
// 这个脚本跑在独立进程/独立事件循环里，不受主进程阻塞影响，负责在整个任务
// 期间持续续租。父进程退出（正常 kill 或崩溃）后自动结束。
//
// 用法：node heartbeat-loop.js <jobId> <statusJsonPath> <parentPid>
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { loadConfig } from "../src/config.js";
import { Transport } from "../src/transport.js";

const [jobId, statusPath, parentPidRaw] = process.argv.slice(2);
const parentPid = Number(parentPidRaw);
const INTERVAL_MS = 15_000;

const config = loadConfig();
const agentId = (config.agent_id || `mac-${hostname()}`).replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64);
const transport = new Transport(config, agentId);

function parentAlive() {
  if (!Number.isInteger(parentPid) || parentPid <= 0) return true;
  try { process.kill(parentPid, 0); return true; } catch { return false; }
}

// 心跳里的 phase 只是展示用；从 daemon 写的 status.json 里读当前阶段，
// 读不到就退回合法的 "idle"，绝不能因为解析失败就不发心跳。
function currentPhase() {
  try {
    const s = JSON.parse(readFileSync(statusPath, "utf8"));
    if (s && s.job_id === jobId && typeof s.phase === "string" && s.phase) return s.phase;
  } catch { /* ignore */ }
  return "idle";
}

let inFlight = false;
async function tick() {
  if (!parentAlive()) process.exit(0);
  if (inFlight) return; // 上一轮 ssh 还没回来就跳过，避免堆积
  inFlight = true;
  try {
    await transport.heartbeat(jobId, currentPhase());
  } catch {
    // 单次失败（网络抖动等）忽略，下一轮继续；租约窗口有 180s，够重试多次。
  } finally {
    inFlight = false;
  }
}

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

await tick();
setInterval(tick, INTERVAL_MS);
