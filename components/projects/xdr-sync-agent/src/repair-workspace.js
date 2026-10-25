import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { atomicJson, scrub } from './failure-incidents.js';

const EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.py', '.sh', '.ts', '.tsx', '.jsx', '.css', '.html', '.md', '.toml']);
const EXCLUDED = /^(?:\.|var$|data$|logs?$|node_modules$|dist$|build$|coverage$|downloads?$|backups?$|__pycache__$|venv$|output$|runs$|doc$|项目文档索引$)/i;
const SECRET = /(?:^|[-_.])(?:auth|cookies?|tokens?|secrets?|credentials?|passwords?|sessions?)(?:[-_.]|$)/i;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const fileHash = path => hash(readFileSync(path));

export function sourceFiles(root) {
  const files = [];
  function walk(dir) {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      if (item.isSymbolicLink() || EXCLUDED.test(item.name)) continue;
      const path = join(dir, item.name), rel = relative(root, path);
      if (item.isDirectory()) { if (!['config', 'configs'].includes(item.name)) walk(path); }
      else if (item.isFile() && (!SECRET.test(item.name) || /\.(?:js|mjs|cjs|py|sh|ts)$/.test(item.name)) &&
        (EXTENSIONS.has(extname(item.name)) || extname(item.name) === '.json' || ['requirements.txt'].includes(item.name)) && statSync(path).size < 2 * 1024 * 1024) files.push(rel);
    }
  }
  walk(root);
  return files.sort();
}
export function snapshotProject(root, workdir, project = {}) {
  root = realpathSync(root);
  mkdirSync(workdir, { recursive: true, mode: 0o700 });
  const files = {}, maxBytes = 40 * 1024 * 1024; let size = 0;
  for (const rel of sourceFiles(root)) {
    const source = join(root, rel), dest = join(workdir, rel), bytes = readFileSync(source);
    size += bytes.length; if (size > maxBytes) throw new Error('source_snapshot_too_large');
    mkdirSync(dirname(dest), { recursive: true, mode: 0o700 }); copyFileSync(source, dest);
    files[rel] = { sha256: hash(bytes), mode: statSync(source).mode & 0o777 };
  }
  // Dependencies are shared for reads. The OS sandbox denies writes through these links.
  for (const name of ['node_modules', '.venv']) if (existsSync(join(root, name))) symlinkSync(realpathSync(join(root, name)), join(workdir, name), 'dir');
  const assets = [];
  for (const rel of project.validationAssets || []) {
    const source = safeTarget(root, rel), target = join(workdir, rel);
    if (!existsSync(source) || statSync(source).size > 64 * 1024 * 1024) throw new Error('validation_asset_unavailable:' + rel);
    mkdirSync(dirname(target), { recursive: true }); symlinkSync(source, target);
    assets.push({ path: rel, sha256: fileHash(source) });
  }
  return { root, files, assets, total_bytes: size };
}
export function changedFiles(snapshot, workdir, project) {
  const present = sourceFiles(workdir), changes = [];
  for (const rel of Object.keys(snapshot.files)) if (!existsSync(join(workdir, rel))) throw new Error('source_deletion_rejected:' + rel);
  for (const rel of present) {
    const before = snapshot.files[rel];
    if (before?.sha256 === fileHash(join(workdir, rel))) continue;
    if (!/\.(?:js|mjs|cjs|py|sh|ts|tsx|jsx|css|html)$/.test(rel) ||
        /(?:^|\/)(?:config|configs|schema|rules|mappings?|retention|workbook_layout)(?:[/.]|$)/i.test(rel) ||
        /(?:^|\/)(?:AGENTS\.md|package\.json|pyproject\.toml)$/.test(rel) ||
        SECRET.test(rel.split('/').at(-1))) throw new Error('protected_file_change:' + rel);
    if ((/(?:^|\/)(?:test|tests)\//.test(rel) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(rel)) && before) throw new Error('existing_test_change_rejected:' + rel);
    if ((project.protectedPaths || []).includes(rel)) throw new Error('protected_file_change:' + rel);
    if (!project.allowPrefixes.some(p => rel.startsWith(p))) throw new Error('outside_edit_allowlist:' + rel);
    changes.push({ path: rel, before: before?.sha256 || null, after: fileHash(join(workdir, rel)), mode: before?.mode || 0o644 });
  }
  // Detect modifications to manifest/instructions too: these files are part of sourceFiles.
  if (changes.length > 10 || changes.reduce((n, c) => n + statSync(join(workdir, c.path)).size, 0) > 160 * 1024) throw new Error('patch_too_large');
  return changes;
}

export function runProcess(file, args, { cwd, input = '', timeoutMs = 60000, env = {}, onOutput = () => {}, maxOutput = 1024 * 1024 } = {}) {
  return new Promise(resolvePromise => {
    let output = '', timedOut = false, spawnError = null, forced;
    const child = spawn(file, args, { cwd, detached: true, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR || '/tmp', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const capture = b => { const s = b.toString(); output = (output + s).slice(-maxOutput); onOutput(scrub(s)); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    const kill = signal => { try { process.kill(-child.pid, signal); } catch {} };
    const stop = () => { kill('SIGTERM'); forced = setTimeout(() => kill('SIGKILL'), 1500); forced.unref(); };
    const shutdown = () => { kill('SIGKILL'); process.exit(143); }; process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    child.once('error', () => { spawnError = 'process_start_failed'; });
    child.stdin.on('error', () => {}); child.stdin.end(input);
    child.once('close', (code, signal) => {
      clearTimeout(timer); if (forced) clearTimeout(forced);
      // A shell/test may have left background descendants holding no pipe handles.
      kill('SIGKILL'); process.removeListener('SIGTERM', shutdown); process.removeListener('SIGINT', shutdown);
      resolvePromise({ code, signal, timedOut, error: spawnError, output: scrub(output) });
    });
  });
}
export function sandboxCommand(command, workdir, tempdir) {
  if (process.platform !== 'darwin') throw new Error('validation_sandbox_requires_macos');
  const roots = [realpathSync(workdir), realpathSync(tempdir)];
  const rules = roots.map(p => `(subpath ${JSON.stringify(p)})`).join(' ');
  return ['/usr/bin/sandbox-exec', ['-p', `(version 1)(allow default)(deny network*)(deny file-write*)(allow file-write* ${rules} (literal "/dev/null"))`, ...command]];
}
export async function validateWorkspace(project, snapshot, workdir, changes, { runner = runProcess, timeoutMs = 180000 } = {}) {
  for (const asset of snapshot.assets || []) if (!existsSync(join(workdir, asset.path)) || fileHash(join(workdir, asset.path)) !== asset.sha256) return { passed: false, results: [], reason: 'validation_asset_changed' };
  const tempdir = join(workdir, '.validation-tmp'); mkdirSync(tempdir, { recursive: true, mode: 0o700 });
  const env = { PATH: process.env.PATH, PYTHONPATH: join(workdir, 'src') + ':' + workdir, PYTHONDONTWRITEBYTECODE: '1',
    PYTEST_DISABLE_PLUGIN_AUTOLOAD: '1', TMPDIR: tempdir, XDR_VALIDATION_SANDBOX: '1', XDR_FAILURE_REPAIR_DISABLED: '1', XDR_AGENT_CONFIG: join(tempdir, 'absent-config.json') };
  const results = [];
  const commands = [];
  for (const c of changes) {
    const path = join(workdir, c.path);
    if (/\.[cm]?js$/.test(path)) commands.push([process.execPath, '--check', path]);
    else if (path.endsWith('.py')) commands.push(['/usr/bin/python3', '-c', 'import ast,sys; ast.parse(open(sys.argv[1]).read(), filename=sys.argv[1])', path]);
    else if (path.endsWith('.sh')) commands.push(['/bin/bash', '-n', path]);
  }
  commands.push(...project.tests.map(command => command.map(arg => arg.replaceAll('{workspace}', workdir).replaceAll('{root}', snapshot.root).replaceAll('{node}', process.execPath))));
  if (!project.tests.length) return { passed: false, results: [], reason: 'no_registered_tests' };
  const deadline = Date.now() + timeoutMs;
  for (const command of commands) {
    const left = deadline - Date.now(); if (left <= 0) return { passed: false, results, reason: 'validation_timeout' };
    const [file, args] = sandboxCommand(command, workdir, tempdir);
    const result = await runner(file, args, { cwd: workdir, timeoutMs: left, env });
    results.push({ command, ...result });
    if (result.code !== 0 || result.timedOut || result.error) return { passed: false, results, reason: 'validation_failed' };
  }
  return { passed: true, results };
}

function safeTarget(root, rel) {
  if (!rel || resolve(root, rel) !== join(root, rel) || rel.startsWith('/') || rel.split('/').includes('..')) throw new Error('unsafe_patch_path');
  let current = root;
  for (const part of rel.split('/')) { current = join(current, part); if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('symlink_target_rejected'); }
  return join(root, rel);
}
export function applyPatch(snapshot, workdir, changes, runDir) {
  // Reject stale source even if a person changed an unrelated source file during diagnosis.
  for (const [rel, record] of Object.entries(snapshot.files)) {
    const path = safeTarget(snapshot.root, rel);
    if (!existsSync(path) || fileHash(path) !== record.sha256) throw new Error('source_changed_during_repair:' + rel);
  }
  for (const asset of snapshot.assets || []) if (fileHash(safeTarget(snapshot.root, asset.path)) !== asset.sha256) throw new Error('source_changed_during_repair:' + asset.path);
  const journal = { root: snapshot.root, state: 'applying', changes }, path = join(runDir, 'deployment.json');
  for (const change of changes) {
    if (fileHash(safeTarget(workdir, change.path)) !== change.after) throw new Error('candidate_changed_after_validation');
    const target = safeTarget(snapshot.root, change.path), backup = join(runDir, 'backup', change.path);
    if (!change.before && existsSync(target)) throw new Error('new_file_collision');
    if (change.before) { mkdirSync(dirname(backup), { recursive: true, mode: 0o700 }); copyFileSync(target, backup); }
  }
  atomicJson(path, journal);
  try {
    for (const change of changes) {
      const target = safeTarget(snapshot.root, change.path), tmp = target + `.repair-${process.pid}.tmp`;
      mkdirSync(dirname(target), { recursive: true }); copyFileSync(join(workdir, change.path), tmp); chmodSync(tmp, change.mode); renameSync(tmp, target);
    }
    journal.state = 'applied'; atomicJson(path, journal);
  } catch (error) { rollbackPatch(runDir); throw error; }
  return journal;
}
export function rollbackPatch(runDir) {
  const path = join(runDir, 'deployment.json');
  if (!existsSync(path)) return { state: 'nothing_to_rollback' };
  const journal = JSON.parse(readFileSync(path, 'utf8')), conflicts = [];
  for (const change of journal.changes) {
    const target = safeTarget(journal.root, change.path);
    if (!existsSync(target)) { if (change.before) conflicts.push(change.path); continue; }
    const current = fileHash(target);
    if (current === change.before) continue;
    if (current !== change.after) { conflicts.push(change.path); continue; }
    if (change.before) { const tmp = target + `.rollback-${process.pid}.tmp`; copyFileSync(join(runDir, 'backup', change.path), tmp); chmodSync(tmp, change.mode); renameSync(tmp, target); }
    else rmSync(target);
  }
  journal.state = conflicts.length ? 'rollback_conflict' : 'rolled_back'; journal.conflicts = conflicts; atomicJson(path, journal); return journal;
}
