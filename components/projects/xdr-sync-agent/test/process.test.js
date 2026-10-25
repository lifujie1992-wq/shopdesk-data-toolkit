import test from "node:test";
import assert from "node:assert/strict";
import { runJson } from "../src/process.js";
test("failure diagnostic records executable args exit and redacts output", async () => {
  const args = ["-e", "process.stdout.write('{\"ok\":false,\"error\":{\"code\":\"api_error\",\"message\":\"busy\"}}\\n');process.stderr.write('Cookie: secret\\n');process.exit(7)"];
  await assert.rejects(runJson(process.execPath, args), (error) => {
    assert.equal(error.diagnostic.executable, process.execPath);
    assert.deepEqual(error.diagnostic.args, args);
    assert.equal(error.diagnostic.exit_code, 7);
    assert.match(error.diagnostic.stdout, /api_error/);
    assert.equal(error.diagnostic.stderr.trim(), "[REDACTED]");
    return true;
  });
});
