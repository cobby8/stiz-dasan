import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync("src/lib/operational-driver-resolution.ts", "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { buildDriverLookupContext, selectAssignedDriverIds } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

test("월말 다음날과 BOTH는 요청 날짜의 월·요일·양방향을 그대로 사용한다", () => {
  assert.deepEqual(buildDriverLookupContext("2026-09-30", "BOTH"), {
    serviceMonth: "2026-09", dayOfWeek: "Wed", directions: ["PICKUP", "DROPOFF"],
  });
  assert.deepEqual(buildDriverLookupContext("2026-10-01", "PICKUP"), {
    serviceMonth: "2026-10", dayOfWeek: "Thu", directions: ["PICKUP"],
  });
});

test("학생을 찾지 못하면 기사 알림을 보류한다", () => {
  assert.deepEqual(selectAssignedDriverIds([]), { driverIds: [], needsConfirmation: true });
});

test("미배정 또는 DRIVER가 아닌 사용자는 기사로 확정하지 않는다", () => {
  assert.equal(selectAssignedDriverIds([{ direction: "PICKUP", driverUserId: null, validDriverId: null }]).needsConfirmation, true);
  assert.equal(selectAssignedDriverIds([{ direction: "PICKUP", driverUserId: "coach-1", validDriverId: null }]).needsConfirmation, true);
});

test("같은 방향에서 복수 기사와 매칭되면 누구에게도 보내지 않는다", () => {
  assert.deepEqual(selectAssignedDriverIds([
    { direction: "PICKUP", driverUserId: "driver-1", validDriverId: "driver-1" },
    { direction: "PICKUP", driverUserId: "driver-2", validDriverId: "driver-2" },
  ]), { driverIds: [], needsConfirmation: true });
});

test("양방향 고유 기사는 유지하고 같은 기사는 한 번만 반환한다", () => {
  assert.deepEqual(selectAssignedDriverIds([
    { direction: "PICKUP", driverUserId: "driver-1", validDriverId: "driver-1" },
    { direction: "DROPOFF", driverUserId: "driver-2", validDriverId: "driver-2" },
  ]), { driverIds: ["driver-1", "driver-2"], needsConfirmation: false });
  assert.deepEqual(selectAssignedDriverIds([
    { direction: "PICKUP", driverUserId: "driver-1", validDriverId: "driver-1" },
    { direction: "DROPOFF", driverUserId: "driver-1", validDriverId: "driver-1" },
  ]), { driverIds: ["driver-1"], needsConfirmation: false });
});
