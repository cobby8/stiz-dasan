// 방학특강 회차 기록에 정규반 명단 출석이 들어가지 않게 못박는다.
// 왜: 특강 출석은 좌석(SpecialProgramEnrollmentDate) 기준이고, 출석이 생긴 회차는 특강 날짜를 지우거나 옮길 수 없게 막힌다.
//
// 2026-11-17: 반 상세의 «수업 기록» 창(SessionLogModal·saveSessionLog·/api/admin/session-detail)을 없앴다.
// 예전엔 그 창이 특강 회차 기록을 열 때 출석 칸을 숨기고 서버가 한 번 더 막는지를 봤다.
// 이제 반 상세 목록의 특강 회차 기록은 리포트 편집으로만 열리므로, 남은 두 길을 본다:
//   ① 리포트 편집 저장(saveSessionReport)은 출석을 아예 쓰지 않는다
//   ② 출결 저장(saveAttendance)의 특강 갈래는 특강 좌석 명단에 있는 학생만 저장한다
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const admin = readFileSync(new URL("../src/app/actions/admin.ts", import.meta.url), "utf8");
const detail = readFileSync(new URL("../src/app/admin/classes/[id]/ClassDetailClient.tsx", import.meta.url), "utf8");

function body(name) {
  const start = admin.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, `${name} 를 찾지 못함`);
  const end = admin.indexOf("\nexport ", start + 10);
  return admin.slice(start, end === -1 ? undefined : end);
}

test("리포트 편집 저장은 출석을 쓰지 않는다(특강 회차 기록을 고쳐도 정규반 출석이 생기지 않는다)", () => {
  const b = body("saveSessionReport");
  assert.match(b, /UPDATE "Session" SET/);
  assert.doesNotMatch(b, /"Attendance"/);
});

test("출결 저장의 특강 갈래는 특강 좌석 명단에 있는 학생만 저장한다", () => {
  const b = body("saveAttendance");
  const seasonalStart = b.indexOf("if (sessionDateId) {");
  const regularStart = b.indexOf("findOrCreateRegularSession(tx");
  assert.ok(seasonalStart >= 0 && regularStart > seasonalStart, "특강 갈래가 정규 갈래보다 먼저 갈라져야 한다");
  const seasonal = b.slice(seasonalStart, regularStart);
  assert.match(seasonal, /const rosterStudentIds = await getAdminSeasonalRosterStudentIds\(sessionDateId\);/);
  assert.match(seasonal, /const allowedRecords = records\.filter\(\(record\) => rosterStudentIds\.has\(record\.studentId\)\);/);
  assert.match(seasonal, /for \(const rec of allowedRecords\) \{\s*const saved = await prisma\.\$queryRawUnsafe<\{ id: string \}\[\]>\(\s*`INSERT INTO "Attendance"/);
  // 특강 갈래는 반드시 여기서 끝난다 — 아래 정규 갈래(정규반 명단 출석)로 흘러내리지 않는다
  assert.match(seasonal, /return \{ ok: true as const, absenceMessages: \[\] as string\[\] \};\s*\}\s*try \{/);
});

test("정규반 명단 출석을 특강 회차 기록에 넣을 수 있던 창과 그 전용 조회·저장이 남아 있지 않다", () => {
  assert.equal(existsSync(new URL("../src/app/admin/classes/[id]/SessionLogModal.tsx", import.meta.url)), false);
  assert.equal(existsSync(new URL("../src/app/api/admin/session-detail/route.ts", import.meta.url)), false);
  assert.doesNotMatch(admin, /export async function saveSessionLog\(/);
  assert.doesNotMatch(detail, /SessionLogModal|session-detail|saveSessionLog/);
});

test("반 상세: 새 기록은 출결 화면으로, 기존 기록은 리포트 편집으로 보낸다(창을 열지 않는다)", () => {
  assert.match(detail, /const ATTENDANCE_HREF = "\/admin\/attendance";/);
  assert.match(detail, /href=\{ATTENDANCE_HREF\}[\s\S]{0,200}출결 화면에서 기록하기/);
  assert.match(detail, /href=\{reportEditHref\(s\.id\)\}[\s\S]*리포트 편집/);
  assert.doesNotMatch(detail, /next\/dynamic|AdminModal/);
});
