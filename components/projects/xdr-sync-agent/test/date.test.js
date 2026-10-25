import test from "node:test";
import assert from "node:assert/strict";
import { todayShanghai, yesterdayShanghai } from "../src/date.js";
test("Shanghai dates ignore host timezone and cross UTC day", () => {
  const instant = new Date("2026-09-06T16:30:00Z");
  assert.equal(todayShanghai(instant), "2026-09-07");
  assert.equal(yesterdayShanghai(instant), "2026-09-06");
});
