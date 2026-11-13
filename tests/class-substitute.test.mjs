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
  // 검수 M2: 담당(코치) 확인이 먼저, 대타는 담당을 통과 못 했을 때만(코치 없음 · 담당 아님 두 갈래 모두)
  const fn = access.slice(access.indexOf("export async function requireStaffClassAccess"), access.indexOf("export async function requireStaffSeasonalSessionAccess"));
  assert.match(fn, /if \(!access\.coachId\) \{\s*if \(await substituteFallback\(\)\) return access;\s*throw/);
  assert.match(fn, /if \(!rows\[0\]\) \{\s*if \(await substituteFallback\(\)\) return access;\s*throw/);
  assert.ok(fn.indexOf("await prisma.$queryRawUnsafe") < fn.lastIndexOf("substituteFallback()"), "담당 조회 뒤에 대타");
  // 대타 조회 오류 = 거부(담당 선생님 경로에 영향 없음)
  assert.match(access, /\)\.catch\(\(\) => \[\] as Array<\{ date: string \}>\);/);
  assert.match(access, /\)\.catch\(\(\) => \[\] as Array<\{ classId: string \}>\);/);
  assert.match(access, /substituteAllowedNow\(rows\[0\]\?\.date, onDate\)/);
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

// L1: 학생 정보 시트(보호자 번호 포함)는 대타에게 연다 — 막는 것은 «공지용 연락처 액션»(loadStaffClassContacts)이다.
test("대타에게 주지 않는 기능 — 수업 공지·공지용 연락처 액션·청구는 대타 날짜를 넘기지 않는다", () => {
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
  assert.match(rules.SUBSTITUTE_TEACHER_SQL, /u\.role = 'INSTRUCTOR'/);
  assert.match(rules.SUBSTITUTE_TEACHER_SQL, /g\.role = 'INSTRUCTOR' AND g\.status = 'ACTIVE'/);
  assert.match(rules.SUBSTITUTE_TEACHER_SQL, /u\."withdrawnAt" IS NULL/);
  // 기사님(DRIVER) 역할만으로는 통과하지 않는다 — 조건에 DRIVER 가 없다
  assert.doesNotMatch(rules.SUBSTITUTE_TEACHER_SQL, /DRIVER/);
});

test("마이그레이션 — 유니크(날짜·반)·RLS ENABLE+FORCE·브라우저 키 차단", () => {
  const sql = read("prisma/migrations/20261113230000_class_substitute/migration.sql");
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS "ClassSubstitute_date_classId_key"\s+ON public\."ClassSubstitute" \(date, "classId"\)/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /REVOKE ALL ON TABLE public\."ClassSubstitute" FROM anon, authenticated/);
  assert.match(read("prisma/schema.prisma"), /model ClassSubstitute \{/);
});

test("보안 HIGH 1 — 지난 대타 지정 + 그날 기록 ID 로 다음 날 접근 거부(유예 없음)", () => {
  const nov14Noon = Date.UTC(2026, 10, 14, 3, 0, 0); // 2026-11-14 12:00 KST
  const nov15Morning = Date.UTC(2026, 10, 14, 23, 0, 0); // 2026-11-15 08:00 KST (UTC 로는 아직 11-14)
  // 그날에는 그날 기록으로 열린다
  assert.equal(rules.substituteAllowedNow("2026-11-14", "2026-11-14", nov14Noon), true);
  // 다음 날: 지정도 기록도 11-14 지만 오늘이 11-15 → 거부
  assert.equal(rules.substituteAllowedNow("2026-11-14", "2026-11-14", nov15Morning), false);
  // 몇 달 뒤에도 거부
  assert.equal(rules.substituteAllowedNow("2026-11-01", "2026-11-01", Date.UTC(2027, 1, 1, 3, 0, 0)), false);
  // KST 자정에 바로 닫힌다
  const closeAt = Date.UTC(2026, 10, 14, 15, 0, 0); // 2026-11-15 00:00 KST
  assert.equal(rules.substituteAllowedNow("2026-11-14", "2026-11-14", closeAt - 1), true);
  assert.equal(rules.substituteAllowedNow("2026-11-14", "2026-11-14", closeAt), false);
  // 오늘 대타여도 다른 날 기록은 거부
  assert.equal(rules.substituteAllowedNow("2026-11-14", "2026-11-07", nov14Noon), false);
  // 미리 지정한 내일 대타는 오늘 열리지 않는다
  assert.equal(rules.substituteAllowedNow("2026-11-15", "2026-11-15", nov14Noon), false);
});

test("보안 HIGH 1·2 — 판정 함수 한 곳이 오늘만·선생님 역할을 판정 시점에 다시 본다", () => {
  const access = read("src/lib/staff-class-access.ts");
  const fn = access.slice(access.indexOf("async function hasClassSubstitute"), access.indexOf("export async function getSubstituteClassIds"));
  // DB 조회 전에 오늘인지 먼저 거른다
  assert.ok(fn.indexOf("substituteAllowedNow(onDate, onDate)") > 0 && fn.indexOf("substituteAllowedNow(onDate, onDate)") < fn.indexOf("$queryRawUnsafe"));
  // 역할 재확인(탈퇴 제외 포함) — 관리자 지정과 같은 조건
  assert.match(fn, /JOIN "User" u ON u\.id = cs\."substituteUserId" AND \$\{SUBSTITUTE_TEACHER_SQL\}/);
  // 홈 목록도 같은 규칙(오늘만 + 역할 재확인)
  const list = access.slice(access.indexOf("export async function getSubstituteClassIds"), access.indexOf("export async function requireStaffClassAccess"));
  assert.match(list, /onDate !== todayKst\(\)/);
  assert.match(list, /JOIN "User" u ON u\.id = cs\."substituteUserId" AND \$\{SUBSTITUTE_TEACHER_SQL\}/);
  // 대타 분기는 이 함수 하나만 거친다
  assert.equal((access.match(/hasClassSubstitute\(/g) || []).length, 2, "정의 1 + 호출 1");
});

test("검수 M1 — 그날 특강 회차가 연결된 반은 대타 지정을 거부한다", () => {
  assert.equal(rules.SEASONAL_SUBSTITUTE_MESSAGE, "그날 특강 회차가 있는 반은 대타 대신 특강 담당 강사를 바꿔 주세요.");
  const src = read("src/app/actions/class-substitute-admin.ts");
  // 출석 명단의 특강 전환(getStaffSessionStudents 폴백)과 같은 조건: 연결 반 + 회차 KST 날짜
  assert.match(src, /o\."linkedClassId" = \$1\s+AND \(sd\."startsAt" AT TIME ZONE 'Asia\/Seoul'\)::date = \$2::date/);
  assert.match(src, /if \(seasonalRows\[0\]\) return \{ ok: false, message: SEASONAL_SUBSTITUTE_MESSAGE \}/);
  // 저장(INSERT)보다 먼저 거른다
  assert.ok(src.indexOf("seasonalRows[0]") < src.indexOf('INSERT INTO "ClassSubstitute"'));
  const roster = read("src/lib/staff-session-queries.ts");
  assert.match(roster, /WHERE o\."linkedClassId" = \$1\s+AND \(sd\."startsAt" AT TIME ZONE 'Asia\/Seoul'\)::date = \$2::date/, "명단 폴백 조건이 바뀌면 이 검사도 같이 고친다");
});

test("검수 M2 — 마이그레이션 전(표 없음)에도 스태프 관리 화면은 빈 목록으로 뜬다", () => {
  const data = read("src/lib/staff/classSubstituteData.ts");
  assert.match(data, /42P01/);
  assert.match(data, /if \(isMissingTable\(error\)\) return \[\] as ClassSubstituteItem\[\];\s*throw error;/);
});
