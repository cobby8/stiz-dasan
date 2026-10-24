import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const schemaSource = await readFile("prisma/schema.prisma", "utf8");
const migrationSource = await readFile("prisma/migrations/20260722001000_add_shuttle_passenger_ride_status/migration.sql", "utf8");
const completionMigrationSource = await readFile("prisma/migrations/20260722093000_add_shuttle_route_completion/migration.sql", "utf8");
const completionColumnsMigrationSource = await readFile("prisma/migrations/20260722094000_add_shuttle_route_completion_columns/migration.sql", "utf8");
const serviceSource = await readFile("src/lib/shuttle/service.ts", "utf8");
const apiSource = await readFile("src/app/api/staff/shuttle/route.ts", "utf8");
const adminApiSource = await readFile("src/app/api/admin/shuttle/route.ts", "utf8");
const staffPageSource = await readFile("src/app/staff/shuttle/page.tsx", "utf8");
const staffDashboardClientSource = await readFile("src/app/staff/shuttle/StaffShuttleDashboardClient.tsx", "utf8");
const staffButtonsSource = await readFile("src/app/staff/shuttle/ShuttleRideStatusButtons.tsx", "utf8");
// 2026-10-02 옛 노선 편성 화면(ShuttleRouteAdminClient) 삭제로 그 화면을 읽던 검사는 뺐다(서버·API 검사는 유지).

test("shuttle passengers keep live ride status", () => {
  assert.match(schemaSource, /rideStatus\s+String\s+@default\("PENDING"\)/);
  assert.match(schemaSource, /rideStatusUpdatedAt\s+DateTime\?\s+@db\.Timestamptz\(6\)/);
  assert.match(schemaSource, /@@index\(\[routePlanId, rideStatus\]\)/);
  assert.match(migrationSource, /"rideStatus" TEXT NOT NULL DEFAULT 'PENDING'/);
  assert.match(migrationSource, /CHECK \("rideStatus" IN \('PENDING', 'BOARDED', 'DROPPED_OFF', 'NO_SHOW'\)\)/);
});

test("staff API validates and saves passenger ride status", () => {
  assert.match(serviceSource, /export async function updatePassengerRideStatus/);
  assert.match(serviceSource, /DRIVER_ROUTE_FORBIDDEN/);
  assert.match(serviceSource, /SHUTTLE_RIDE_STATUS_NOT_SERVICE_DATE/);
  assert.match(serviceSource, /koreaDateOnly\(route\.serviceDate\) !== koreaDateOnly\(\)/);
  assert.match(serviceSource, /PASSENGER_RIDE_STATUS_UPDATED/);
  assert.match(apiSource, /export async function PATCH/);
  assert.match(apiSource, /updatePassengerRideStatus\(staff, routeId, passengerId, body\.status\)/);
});

test("driver shuttle page can check passengers and update summary immediately", () => {
  assert.match(staffPageSource, /StaffShuttleDashboardClient/);
  assert.match(staffDashboardClientSource, /ShuttleRideStatusButtons/);
  assert.match(staffDashboardClientSource, /RideStatusPill/);
  assert.match(staffDashboardClientSource, /셔틀 기사 앱/);
  assert.match(staffDashboardClientSource, /체크 대기/);
  assert.match(staffDashboardClientSource, /체크 완료/);
  assert.match(staffDashboardClientSource, /summarizeRideStatuses/);
  assert.match(staffDashboardClientSource, /onStatusChange\(passenger\.id, status\)/);
  assert.match(staffButtonsSource, /fetch\("\/api\/staff\/shuttle"/);
  assert.match(staffButtonsSource, /onStatusChange\(nextStatus\)/);
  assert.match(staffButtonsSource, /onStatusChange\(previous\)/);
  assert.match(staffButtonsSource, /저장 중/);
  assert.match(staffButtonsSource, /저장 완료/);
  assert.match(staffButtonsSource, /BOARDED/);
  assert.match(staffButtonsSource, /DROPPED_OFF/);
  assert.match(staffButtonsSource, /NO_SHOW/);
});

test("driver shuttle page separates today and upcoming routes and refreshes safely", () => {
  assert.match(apiSource, /export async function GET/);
  assert.match(apiSource, /getStaffShuttleDashboard\(staff\)/);
  assert.match(apiSource, /SHUTTLE_DASHBOARD_FORBIDDEN/);
  assert.match(staffDashboardClientSource, /splitRoutesByDate/);
  assert.match(staffDashboardClientSource, /오늘 운행/);
  assert.match(staffDashboardClientSource, /예정된 운행/);
  assert.match(staffDashboardClientSource, /운행 당일에 탑승 상태를 체크할 수 있습니다/);
  assert.match(staffDashboardClientSource, /canCheckRideStatus/);
  assert.match(staffDashboardClientSource, /일정 확인 필요/);
  assert.match(staffDashboardClientSource, /needsReviewRoutes/);
  assert.match(staffDashboardClientSource, /refreshInFlightRef/);
  assert.match(staffDashboardClientSource, /pendingMutationsRef/);
  assert.match(staffDashboardClientSource, /mutationVersionAtStart/);
  assert.match(staffDashboardClientSource, /refreshMessage\.tone === "error"/);
  assert.match(staffButtonsSource, /onMutationStateChange\?\.\(true\)/);
  assert.match(staffButtonsSource, /onMutationStateChange\?\.\(false\)/);
  assert.match(staffDashboardClientSource, /SHUTTLE_AUTO_REFRESH_MS = 60_000/);
  assert.match(staffDashboardClientSource, /document\.visibilityState === "visible"/);
  assert.match(staffDashboardClientSource, /visibilitychange/);
  assert.match(staffDashboardClientSource, /새로고침/);
  assert.match(staffDashboardClientSource, /cache: "no-store"/);
});

test("confirmed routes can be completed only after every passenger is checked", () => {
  assert.match(schemaSource, /completedAt\s+DateTime\?\s+@db\.Timestamptz\(6\)/);
  assert.match(schemaSource, /COMPLETED/);
  assert.match(completionMigrationSource, /ADD VALUE IF NOT EXISTS 'COMPLETED'/);
  assert.match(completionColumnsMigrationSource, /"completedAt" TIMESTAMPTZ\(6\)/);
  assert.match(completionColumnsMigrationSource, /ShuttleRoutePlan_completion_check/);
  assert.match(serviceSource, /export async function completeRoute/);
  assert.match(serviceSource, /RIDE_STATUS_PENDING/);
  assert.match(serviceSource, /ROUTE_COMPLETED/);
  assert.match(adminApiSource, /case "complete"/);
});

test("admin can confirm shuttle request pickup or dropoff pins before assignment", () => {
  assert.match(serviceSource, /updateShuttleRequestLocation/);
  assert.match(serviceSource, /SHUTTLE_LOCATION_CONFIRMED/);
  assert.match(adminApiSource, /body\.resource === "shuttleRequest"/);
  assert.match(adminApiSource, /confirmLocation/);
});

test("shuttle user-facing files keep Korean text readable", () => {
  for (const source of [adminApiSource, staffDashboardClientSource, staffButtonsSource]) {
    assert.doesNotMatch(source, /�|泥|湲곗|誘명|뷀|댄뻾|곹깭/);
  }
});
