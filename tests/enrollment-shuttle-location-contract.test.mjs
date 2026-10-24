import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const publicAction = fs.readFileSync("src/app/actions/public.ts", "utf8");
const adminAction = fs.readFileSync("src/app/actions/admin.ts", "utf8");
const migration = fs.readFileSync(
  "prisma/migrations/20260724050000_add_enrollment_shuttle_locations/migration.sql",
  "utf8",
);

test("regular enrollment requires both map locations and current consent", () => {
  assert.match(publicAction, /normalizeEnrollmentShuttleLocation\(data\.shuttlePickupLocationData/);
  assert.match(publicAction, /normalizeEnrollmentShuttleLocation\(data\.shuttleDropoffLocationData/);
  assert.match(publicAction, /data\.shuttleLocationConsent !== true/);
  assert.match(publicAction, /data\.shuttleLocationConsentVersion !== SHUTTLE_LOCATION_CONSENT_VERSION/);
});

test("disabling shuttle clears every location and consent field", () => {
  assert.match(publicAction, /data\.shuttleNeeded\s*\?\s*normalizeEnrollmentShuttleLocation/);
  assert.match(publicAction, /const shuttleLocationConsentVersion = data\.shuttleNeeded \? SHUTTLE_LOCATION_CONSENT_VERSION : null/);
  assert.match(publicAction, /const shuttleLocationConsentAt = data\.shuttleNeeded \? new Date\(\) : null/);
  assert.match(publicAction, /"shuttlePickupAddress" = \$27/);
  assert.match(publicAction, /"shuttleDropoffAddress" = \$35/);
});

test("database rejects partial, invalid, and unconsented map metadata", () => {
  assert.match(migration, /shuttle_pickup_coordinate_check/);
  assert.match(migration, /"shuttlePickupLatitude" BETWEEN -90 AND 90/);
  assert.match(migration, /"shuttlePickupSource" IN \('MAP_PIN', 'SEARCH', 'CURRENT_LOCATION'\)/);
  assert.match(migration, /shuttle_location_consent_check/);
  assert.match(migration, /shuttle_location_complete_check/);
  assert.match(migration, /COALESCE\("shuttleNeeded", false\) = false[\s\S]*ROW\([\s\S]*\) IS NULL/);
  assert.match(migration, /COALESCE\("shuttleNeeded", false\) = true[\s\S]*ROW\([\s\S]*\) IS NULL[\s\S]*OR \(/);
});

test("approval copies both confirmed locations atomically to the student", () => {
  assert.match(adminAction, /await prisma\.\$transaction\(async \(tx\) =>/);
  assert.match(adminAction, /SELECT \* FROM "EnrollmentApplication" WHERE id = \$1 FOR UPDATE/);
  assert.match(adminAction, /INSERT INTO "StudentShuttleLocation"/);
  assert.match(adminAction, /ON CONFLICT \("studentId", kind\) DO UPDATE/);
  assert.match(adminAction, /SHUTTLE_LOCATION_CONSENT_VERSION/);
  assert.doesNotMatch(adminAction, /ConfirmedAt.*\?\? new Date\(\)/);
  assert.match(adminAction, /upsertLocation\("PICKUP", "shuttlePickup"\)/);
  assert.match(adminAction, /upsertLocation\("DROPOFF", "shuttleDropoff"\)/);
});

test("approval validates raw coordinates and inserts guardian without abort-prone conflict handling", () => {
  assert.match(adminAction, /rawLatitude != null/);
  assert.match(adminAction, /rawLongitude != null/);
  assert.match(adminAction, /INSERT INTO "Guardian"[\s\S]*SELECT gen_random_uuid\(\)::text[\s\S]*WHERE NOT EXISTS/);
  assert.doesNotMatch(adminAction, /ON CONFLICT \("studentId"\) WHERE relation = \$2 DO NOTHING/);
});

// 2026-10-24: 관리자 수정 화면에서 셔틀을 끄면 좌표가 남아 DB 제약을 위반해 **UPDATE 가 통째로 실패**했다.
// 라벨만 비우고 좌표를 두면 관리자가 셔틀을 취소할 길이 아예 없어진다(승인 화면까지 가지도 못한다).
// 학부모 경로는 처음부터 함께 비웠고 관리자 경로만 빠져 있었다 — 한쪽만 고쳐진 전형적인 사고다.
test("admin edit also clears locations and consent when shuttle is turned off", () => {
  assert.match(adminAction, /const clearsShuttleLocation = data\.shuttleNeeded === false/);
  // 비우기는 SET 절에 직접 NULL 로 넣어야 한다(값 바인딩에 섞으면 $n 번호가 어긋난다).
  assert.match(adminAction, /clearsShuttleLocation \? SHUTTLE_LOCATION_COLUMNS\.map\(\(col\) => `"\$\{col\}" = NULL`\)/);
  // 좌표를 지운 사실은 개인정보라 이력에 남긴다.
  assert.match(adminAction, /셔틀 위치정보·동의 기록 삭제/);
});

// 컬럼 목록이 DB 제약과 어긋나면 "일부만 남은 상태"가 되어 또 UPDATE 가 거부된다.
// 양쪽에서 컬럼명을 뽑아 집합으로 비교한다 — 눈으로 읽어서는 한 개 빠진 것을 못 찾는다.
test("admin clear list matches the database check constraint exactly", () => {
  const listed = [...adminAction.matchAll(/const SHUTTLE_LOCATION_COLUMNS = \[([\s\S]*?)\] as const;/g)];
  assert.equal(listed.length, 1, "SHUTTLE_LOCATION_COLUMNS 가 한 곳에만 있어야 한다");
  const fromCode = new Set([...listed[0][1].matchAll(/"(shuttle[A-Za-z]+)"/g)].map((m) => m[1]));

  const checkBlock = /shuttle_location_complete_check[\s\S]*?COALESCE\("shuttleNeeded", false\) = false\s*AND ROW\(([\s\S]*?)\) IS NULL/.exec(migration);
  assert.ok(checkBlock, "마이그레이션에서 shuttleNeeded=false 쪽 ROW(...) 를 찾지 못했다");
  const fromDb = new Set([...checkBlock[1].matchAll(/"(shuttle[A-Za-z]+)"/g)].map((m) => m[1]));

  assert.deepEqual(
    [...fromCode].sort(),
    [...fromDb].sort(),
    "셔틀을 끌 때 비우는 컬럼이 DB 제약과 다릅니다 — 한쪽만 고치면 수정 저장이 다시 막힙니다",
  );
  assert.equal(fromDb.size, 18, "제약이 보는 컬럼 수가 바뀌었다 — 목록을 다시 맞춰야 한다");
});
