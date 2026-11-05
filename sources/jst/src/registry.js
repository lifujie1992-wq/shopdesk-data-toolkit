/**
 * 模块自动发现。
 *
 * 约定：`sources/jst/src/<命令名>/index.js` 导出一个对象
 *   { name, description, usage?, run(argv), selfHandled?, selfHelp? }
 * 放进这个目录就自动成为 `jst <命令名>`，不需要改 bin/jst.js。
 *
 * 这样新脚本的落地成本只有「建目录写 index.js」，不用碰分发器，
 * 也就不会出现「加了脚本忘了注册」或者「注册冲突」。
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * @param {string} root sources/jst/src 的绝对路径
 * @returns {Promise<Array<{command: string, description: string, run: Function}>>}
 */
export async function discoverModules(root) {
  if (!existsSync(root)) return [];
  const modules = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
    const index = join(root, entry.name, 'index.js');
    if (!existsSync(index)) continue;
    let mod;
    try {
      mod = await import(pathToFileURL(index).href);
    } catch (error) {
      process.stderr.write(`[registry] 跳过 ${entry.name}：${error.message}\n`);
      continue;
    }
    if (typeof mod.run !== 'function') continue;
    modules.push({
      command: mod.name ?? entry.name,
      description: mod.description ?? "",
      ...(mod.usage ? { usage: mod.usage } : {}),
      ...(mod.selfHandled ? { selfHandled: true } : {}),
      ...(mod.selfHelp ? { selfHelp: true } : {}),
      run: mod.run,
    });
  }
  return modules.sort((a, b) => a.command.localeCompare(b.command));
}
