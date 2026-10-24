import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const schema = await readFile("prisma/schema.prisma", "utf8");
const migration = await readFile("prisma/migrations/20260722143000_add_student_shuttle_locations/migration.sql", "utf8");
const passengerMigration = await readFile("prisma/migrations/20260722172000_extend_shuttle_passengers_for_students/migration.sql", "utf8");
const service = await readFile("src/lib/shuttle/service.ts", "utf8");
const route = await readFile("src/app/api/admin/shuttle/route.ts", "utf8");
// 옛 노선 편성 화면 삭제(2026-10-02) — 학생별 위치 저장은 학생 상세 화면이 맡는다.
const studentDetail = await readFile("src/app/admin/students/[id]/StudentDetailClient.tsx", "utf8");

test("student shuttle locations are stored separately for pickup and dropoff", () => {
  assert.match(schema, /model StudentShuttleLocation/);
  assert.match(schema, /shuttleLocations\s+StudentShuttleLocation\[\]/);
  assert.match(schema, /@@unique\(\[studentId, kind\]\)/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS "StudentShuttleLocation"/);
  assert.match(migration, /CHECK \(kind IN \('PICKUP', 'DROPOFF'\)\)/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
});

test("admin API can save student pickup and dropoff locations", () => {
  assert.match(service, /export async function updateStudentShuttleLocation/);
  assert.match(service, /ON CONFLICT \("studentId", kind\) DO UPDATE/);
  assert.match(service, /SHUTTLE_LOCATION_CONSENT_VERSION/);
  assert.match(route, /resource === "studentLocation"/);
  assert.match(route, /updateStudentShuttleLocation\(actor, id, data\)/);
});

test("class based shuttle candidates are derived from sessions and enrollments", () => {
  assert.match(service, /export async function getClassBasedShuttleCandidates/);
  assert.match(service, /JOIN "Enrollment" e ON e\."classId" = c\.id AND e\.status = 'ACTIVE'/);
  assert.match(service, /LEFT JOIN "StudentShuttleLocation" pickup/);
  assert.match(service, /classBasedCandidates/);
});

test("student detail saves per-student pickup and dropoff locations", () => {
  assert.match(studentDetail, /resource: "studentLocation"/);
  assert.match(studentDetail, /"PICKUP" \| "DROPOFF"/);
});

test("class based candidates can be preview optimized before route creation", () => {
  assert.match(service, /export async function previewClassBasedShuttlePlacement/);
  assert.match(service, /SHUTTLE_ACADEMY_LATITUDE/);
  assert.match(service, /SHUTTLE_ACADEMY_LONGITUDE/);
  assert.match(service, /optimizeWaypointOrderWithTmap\(\{/);
  assert.match(route, /resource === "classCandidates"/);
  assert.match(route, /previewClassBasedShuttlePlacement\(actor, data\)/);
});

test("class based placement can create draft route passengers for regular students", () => {
  assert.match(schema, /sourceType\s+String\s+@default\("SPECIAL_PROGRAM"\)/);
  assert.match(schema, /studentId\s+String\?/);
  assert.match(schema, /sessionId\s+String\?/);
  assert.match(schema, /locationKind\s+String\?/);
  assert.match(schema, /shuttleRequestId\s+String\?/);
  assert.match(passengerMigration, /ALTER COLUMN "shuttleRequestId" DROP NOT NULL/);
  assert.match(passengerMigration, /"sourceType" = 'REGULAR_CLASS'/);
  assert.match(service, /export async function createClassBasedShuttleRouteDraft/);
  assert.match(service, /'REGULAR_CLASS'/);
  assert.match(route, /action === "createRouteDraft"/);
});
