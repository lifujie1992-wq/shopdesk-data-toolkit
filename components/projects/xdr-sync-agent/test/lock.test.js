import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock } from "../src/lock.js";
test("process lock prevents reentry and can be released", () => {
  const dir=mkdtempSync(join(tmpdir(),"xdr-lock-")); const release=acquireLock(dir);
  assert.throws(()=>acquireLock(dir),/already_running/); release(); const release2=acquireLock(dir); release2();
});
