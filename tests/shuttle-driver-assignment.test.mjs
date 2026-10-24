import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const schemaSource = await readFile("prisma/schema.prisma", "utf8");
const migrationSource = await readFile("prisma/migrations/20260721234500_add_shuttle_route_driver/migration.sql", "utf8");
const serviceSource = await readFile("src/lib/shuttle/service.ts", "utf8");
const staffShuttleSource = await readFile("src/app/staff/shuttle/page.tsx", "utf8");

test("shuttle routes can be assigned to DRIVER users", () => {
  // prisma format 이 열을 맞추면서 공백 개수가 바뀐다. 지켜야 할 것은 필드의 존재·타입이다.
  assert.match(schemaSource, /driverUserId\s+String\?/);
  assert.match(schemaSource, /driver\s+User\?\s+@relation\("ShuttleRouteDriver"/);
  assert.match(schemaSource, /drivenShuttleRoutePlans\s+ShuttleRoutePlan\[\]\s+@relation\("ShuttleRouteDriver"\)/);
  assert.match(migrationSource, /ADD COLUMN IF NOT EXISTS "driverUserId" TEXT/);
  assert.match(migrationSource, /"ShuttleRoutePlan_driverUserId_fkey"/);
});

test("server validates driver assignment and requires it before confirmation", () => {
  assert.match(serviceSource, /async function ensureDriver/);
  assert.match(serviceSource, /role: "DRIVER"/);
  assert.match(serviceSource, /DRIVER_UNAVAILABLE/);
  assert.match(serviceSource, /DRIVER_REQUIRED/);
  assert.match(serviceSource, /driverUserId: source\.driverUserId/);
});

// 2026-10-02 옛 노선 편성 화면(ShuttleRouteAdminClient) 삭제로 그 화면을 읽던 검사는 뺐다(서버·API 검사는 유지).

test("staff shuttle page shows assigned confirmed routes", () => {
  assert.match(staffShuttleSource, /getStaffShuttleDashboard\(staff\)/);
  assert.match(serviceSource, /export async function getStaffShuttleDashboard/);
  assert.match(serviceSource, /status: ShuttleRoutePlanStatus\.CONFIRMED/);
  assert.match(serviceSource, /driverUserId: actor\.appUserId/);
});
