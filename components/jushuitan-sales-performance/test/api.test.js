import assert from "node:assert/strict";
import test from "node:test";

import { assertDate, previousDate, yesterdayShanghai } from "../src/api.js";

test("validates report dates", () => {
  assert.equal(assertDate("2026-09-05"), "2026-09-05");
  assert.throws(() => assertDate("2026-02-30"), (error) => error.code === "invalid_date");
});

test("calculates previous date across month boundaries", () => {
  assert.equal(previousDate("2026-03-01"), "2026-02-28");
});

test("calculates yesterday in Asia/Shanghai", () => {
  assert.equal(yesterdayShanghai(new Date("2026-09-06T01:00:00Z")), "2026-09-05");
});
