import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync("src/lib/operational-driver-resolution.ts", "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { buildDriverLookupContext, selectRosterDriverIds } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

test("월말 다음날과 BOTH는 요청 날짜의 월·요일·양방향(명단 방향 포함)을 그대로 사용한다", () => {
  assert.deepEqual(buildDriverLookupContext("2026-09-30", "BOTH"), {
    serviceMonth: "2026-09", dayOfWeek: "Wed", weekday: 3, directions: ["PICKUP", "DROPOFF"], rosterDirections: ["BOARD", "ALIGHT"],
  });
  assert.deepEqual(buildDriverLookupContext("2026-10-01", "PICKUP"), {
    serviceMonth: "2026-10", dayOfWeek: "Thu", weekday: 4, directions: ["PICKUP"], rosterDirections: ["BOARD"],
  });
  assert.deepEqual(buildDriverLookupContext("2026-10-01", "DROPOFF")?.rosterDirections, ["ALIGHT"]);
});

test("연말·윤년·일요일 요일과 잘못된 날짜", () => {
  assert.equal(buildDriverLookupContext("2026-12-31")?.dayOfWeek, "Thu");
  assert.equal(buildDriverLookupContext("2027-01-03")?.weekday, 0);
  assert.equal(buildDriverLookupContext("2028-02-29")?.dayOfWeek, "Tue");
  assert.equal(buildDriverLookupContext("2026-02-30"), null);
  assert.equal(buildDriverLookupContext("2026-9-1"), null);
});

test("그날 명단에 학생이 없거나 기사 계정이 없으면 기사 알림을 보류한다", () => {
  assert.deepEqual(selectRosterDriverIds([]), { driverIds: [], needsConfirmation: true });
  assert.deepEqual(selectRosterDriverIds([null, "", "  "]), { driverIds: [], needsConfirmation: true });
});

test("명단에 학생이 있으면 현재 기사 역할 전원에게, 같은 기사는 한 번만", () => {
  assert.deepEqual(selectRosterDriverIds(["driver-1", "driver-2", "driver-1"]), { driverIds: ["driver-1", "driver-2"], needsConfirmation: false });
});
