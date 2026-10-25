import fs from 'node:fs';
import path from 'node:path';

export function createState(file) {
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});

  function loadAll() {
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      const jobs = Array.isArray(value?.jobs) ? value.jobs : value ? [value] : [];
      if (jobs.some(job => typeof job.job_id !== 'string' || typeof job.leaseToken !== 'string')) throw Error('任务恢复清单格式无效');
      return jobs;
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw new Error(`运行状态读取失败: ${error.message}`);
    }
  }

  function saveAll(jobs) {
    if (!jobs.length) { clear(); return; }
    const value = {jobs: jobs.map(job => ({
      job_id: String(job.job_id),
      leaseToken: String(job.leaseToken),
      lease_expires_at: job.lease_expires_at || null,
      saved_at: new Date().toISOString(),
    }))};
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(value), {mode: 0o600});
    fs.renameSync(temp, file);
    fs.chmodSync(file, 0o600);
  }

  function clear() {
    fs.rmSync(file, {force: true});
  }

  return {
    load: () => loadAll()[0] || null,
    loadAll,
    save: job => saveAll([job]),
    saveAll,
    remove: jobId => saveAll(loadAll().filter(job => job.job_id !== jobId)),
    clear,
  };
}
