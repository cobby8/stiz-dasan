import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

// 대타 선생님 지정(f4, 2026-11-13) — 그 날짜에만 대타 선생님이 그 반 출석부를 연다.
// 날짜 판정은 자정 경계(KST 00:00 = UTC 15:00 전날)에서 틀리기 쉬워 경계 시각을 직접 넣어 실행한다.
const rules = await loadTsModule("src/lib/staff/classSubstitute.ts");
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("대타 권한은 지정한 그 날짜에만 — 다른 날은 거부", () => {
  assert.equal(rules.substituteGrantsAccess("2026-11-14", "2026-11-14"), true);
  assert.equal(rules.substituteGrantsAccess("2026-11-14", "2026-11-13"), false);
  assert.equal(rules.substituteGrantsAccess("2026-11-14", "2026-11-15"), false);
  // 잘못된 값은 언제나 거부(권한이 넓어지는 쪽으로 흐르지 않게)
  assert.equal(rules.substituteGrantsAccess(undefined, "2026-11-14"), false);
  assert.equal(rules.substituteGrantsAccess("2026-11-14", ""), false);
  assert.equal(rules.substituteGrantsAccess("2026-02-30", "2026-02-30"), false);
  assert.equal(rules.substituteGrantsAccess("2026-11-14T00:00", "2026-11-14T00:00"), false);
});

test("KST 자정 경계 — 서버(UTC) 시계로도 한국 날짜 기준으로 열리고 닫힌다", () => {
  // 2026-11-14(KST) 대타
  const kstMidnight = Date.UTC(2026, 10, 13, 15, 0, 0); // = 2026-11-14 00:00 KST
  assert.equal(rules.substituteActiveNow("2026-11-14", kstMidnight - 1), false, "KST 11-13 23:59:59.999 에는 아직 아니다");
  assert.equal(rules.substituteActiveNow("2026-11-14", kstMidnight), true, "KST 11-14 00:00 부터 열린다");
  // UTC 로는 아직 11-13 이지만 KST 로는 11-14 오전 8시 — 열려 있어야 한다(toISOString 사고 방지)
  assert.equal(rules.substituteActiveNow("2026-11-14", Date.UTC(2026, 10, 13, 23, 0, 0)), true);
  const nextKstMidnight = Date.UTC(2026, 10, 14, 15, 0, 0); // = 2026-11-15 00:00 KST
  assert.equal(rules.substituteActiveNow("2026-11-14", nextKstMidnight - 1), true, "KST 11-14 23:59:59.999 까지");
  assert.equal(rules.substituteActiveNow("2026-11-14", nextKstMidnight), false, "KST 11-15 00:00 에 닫힌다");
});

test("관리자 지정 입력 확인 — 지난 날짜·요일 불일치 거부", () => {
  // 2026-11-14 = 토요일
  assert.equal(rules.validateSubstituteInput({ date: "2026-11-14", classDayOfWeek: "Sat", today: "2026-11-13" }), null);
  assert.equal(rules.validateSubstituteInput({ date: "2026-11-13", classDayOfWeek: "Fri", today: "2026-11-13" }), null, "오늘은 지정 가능");
  assert.match(rules.validateSubstituteInput({ date: "2026-11-12", classDayOfWeek: "Thu", today: "2026-11-13" }), /지난 날짜/);
  assert.match(rules.validateSubstituteInput({ date: "2026-11-14", classDayOfWeek: "Mon", today: "2026-11-13" }), /요일/);
  assert.match(rules.validateSubstituteInput({ date: "2026-13-01", classDayOfWeek: "Mon", today: "2026-11-13" }), /날짜/);
  // 연말·윤년 요일
  assert.equal(rules.validateSubstituteInput({ date: "2027-01-01", classDayOfWeek: "Fri", today: "2026-12-31" }), null);
  assert.equal(rules.validateSubstituteInput({ date: "2028-02-29", classDayOfWeek: "Tue", today: "2028-02-28" }), null);
});

test("접근 판정 한 곳 — 출석부 열기·저장 경로가 같은 대타 판정을 쓴다", () => {
  const access = read("src/lib/staff-class-access.ts");
  // 대타 확인은 코치 연결 확인보다 먼저(코치 연결 없는 선생님도 대타로는 들어온다)
  const fn = access.slice(access.indexOf("export async function requireStaffClassAccess"));
  assert.ok(fn.indexOf("hasClassSubstitute") > 0 && fn.indexOf("hasClassSubstitute") < fn.indexOf("access.coachId"));
  assert.match(access, /substituteGrantsAccess\(rows\[0\]\?\.date, onDate\)/);
  // 수업 기록 단위 권한(출석 저장·종료·취소·메모·사진)은 «그 기록의 날짜»로 대타를 본다
  assert.match(access, /requireStaffClassAccess\(rows\[0\]\.classId, context, \{ substituteDate: String\(rows\[0\]\.date\) \}\)/);

  const actions = read("src/app/actions/staff-sessions.ts");
  assert.match(actions, /requireStaffClassAccess\(classId, undefined, \{ substituteDate: date \}\)/, "수업 시작");
  assert.match(actions, /requireStaffClassAccess\(input\.classId, undefined, \{ substituteDate: input\.date \}\)/, "수업 계획");

  const queries = read("src/lib/staff-session-queries.ts");
  assert.match(queries, /getSubstituteClassIds\(access, dateKey\)/, "홈 오늘 수업 목록");
  assert.match(queries, /else await requireStaffSessionAccess\(sessionId\)/, "출석부 열기");
  assert.match(queries, /substituteDate: sessionKinds\[0\]\?\.date/, "출석 명단");

  const photo = read("src/app/api/staff/sessions/[sessionId]/photos/[photoId]/route.ts");
  assert.match(photo, /substituteDate: sessionDate/);
});

test("대타에게 주지 않는 기능 — 공지·연락처·청구는 대타 날짜를 넘기지 않는다", () => {
  assert.match(read("src/app/actions/staff-notices.ts"), /requireStaffClassAccess\(classId\);/);
  assert.match(read("src/lib/staff-contacts.ts"), /requireStaffClassAccess\(classId\);/);
  assert.match(read("src/lib/staff-class-billing.ts"), /requireStaffClassAccess\(normalizedClassId\);/);
});

test("관리자 지정·취소는 requireAdmin, 대타는 선생님 계정만", () => {
  const src = read("src/app/actions/class-substitute-admin.ts");
  assert.match(src, /^"use server";/);
  assert.match(src, /await requireAdmin\(\)/);
  assert.equal((src.match(/const gate = await adminGate\(\);/g) || []).length, 2);
  assert.match(src, /SUBSTITUTE_TEACHER_SQL/);
  const data = read("src/lib/staff/classSubstituteData.ts");
  assert.match(data, /u\.role = 'INSTRUCTOR'/);
  assert.match(data, /g\.role = 'INSTRUCTOR' AND g\.status = 'ACTIVE'/);
  assert.match(data, /u\."withdrawnAt" IS NULL/);
});

test("마이그레이션 — 유니크(날짜·반)·RLS ENABLE+FORCE·브라우저 키 차단", () => {
  const sql = read("prisma/migrations/20261113230000_class_substitute/migration.sql");
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS "ClassSubstitute_date_classId_key"\s+ON public\."ClassSubstitute" \(date, "classId"\)/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /REVOKE ALL ON TABLE public\."ClassSubstitute" FROM anon, authenticated/);
  assert.match(read("prisma/schema.prisma"), /model ClassSubstitute \{/);
});
