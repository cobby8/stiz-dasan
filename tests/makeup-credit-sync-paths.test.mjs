import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 보강권 동기화 경로 고정 테스트(2026-10-05).
// 사고: Session 에 없는 "startsAt" 을 조회해 정규 결석 보강권이 한 장도 발급되지 않았고(결석 546건 · 보강권 1장),
//       관리자 출석 화면은 보강권 함수를 아예 부르지 않았다.

const creditService = readFileSync("src/lib/makeup/credit-service.ts", "utf8");
const adminActions = readFileSync("src/app/actions/admin.ts", "utf8");
const rallyzSync = readFileSync("src/app/actions/rallyz-attendance-sync.ts", "utf8");

/** 함수 본문(다음 export 직전까지)을 잘라 낸다. */
function functionBody(source, name) {
  const start = source.indexOf(`export async function ${name}(`);
  assert.notEqual(start, -1, `${name} 함수가 없습니다`);
  const next = source.indexOf("\nexport ", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

test("정규 보강권은 Session 의 date 컬럼에서 결석일을 읽는다(startsAt 컬럼은 없다)", () => {
  // 주석은 빼고 실제 코드만 본다(주석에 사고 설명으로 "startsAt" 이 적혀 있다).
  const body = functionBody(creditService, "syncCreditForRegularSession")
    .split(/\r?\n/).filter((line) => !line.trim().startsWith("//")).join("\n");
  assert.doesNotMatch(body, /"startsAt"/);
  assert.match(body, /to_char\("date", 'YYYY-MM-DD'\)/);
  // 무tz 컬럼에 KST 자정이 담겨 있어 시간대 변환을 걸면 하루 밀린다.
  assert.doesNotMatch(body, /AT TIME ZONE/);
});

test("관리자 출석 저장(정규)은 보강권을 try/catch 안에서 맞춘다", () => {
  const body = functionBody(adminActions, "saveAttendance");
  assert.match(body, /try \{\s*await syncCreditForRegularSession\(\{ sessionId, studentId: rec\.studentId, status: rec\.status \}\);\s*\} catch/);
});

test("관리자 출석 저장(방학특강)은 좌석을 찾아 보강권을 try/catch 안에서 맞춘다", () => {
  const body = functionBody(adminActions, "saveAttendance");
  assert.match(body, /try \{\s*await syncAdminSeasonalMakeupCredit\(sessionDateId, rec\.studentId, rec\.status\);\s*\} catch/);
  // 좌석 → syncCreditForSeasonalSeat 로 코치 화면과 같은 sourceKey(SEASONAL:{좌석id})가 된다.
  const helperStart = adminActions.indexOf("async function syncAdminSeasonalMakeupCredit(");
  assert.notEqual(helperStart, -1);
  const helper = adminActions.slice(helperStart, adminActions.indexOf("export async function saveAttendance(", helperStart));
  assert.match(helper, /"SpecialProgramEnrollmentDate" e/);
  assert.match(helper, /e\.status = 'SCHEDULED'/);
  assert.match(helper, /if \(!seats\[0\]\) return;/);
  assert.match(helper, /syncCreditForSeasonalSeat\(\{ enrollmentDateId: seats\[0\]\.id, studentId, status \}\)/);
});

test("랠리즈 출결 적용도 트랜잭션 뒤에 보강권을 try/catch 안에서 맞춘다", () => {
  const body = functionBody(rallyzSync, "applyRallyzAttendanceSync");
  assert.match(body, /try \{\s*await syncCreditForRegularSession\(target\);\s*\} catch/);
});

// ── 발급 시작일(앞으로만) 판정 ──
// credit-service.ts 는 @/lib/prisma 별칭을 import 해 테스트에서 바로 불러올 수 없다.
// 그래서 외부 의존이 없는 "발급 시작일 판정" 블록만 잘라 타입을 지우고 실행한다.
async function loadIssueGate() {
  const { stripTypeScriptTypes } = await import("node:module");
  const startMark = "// ── 발급 시작일 판정";
  const endMark = "// ── 발급 시작일 판정 끝 ──";
  const start = creditService.indexOf(startMark);
  const end = creditService.indexOf(endMark);
  assert.ok(start !== -1 && end > start, "발급 시작일 판정 블록이 없습니다");
  const js = stripTypeScriptTypes(creditService.slice(start, end));
  return import(`data:text/javascript,${encodeURIComponent(js)}`);
}

test("보강권 발급은 2026-10-05 결석부터 — 그 전 결석은 발급하지 않는다", async () => {
  const { MAKEUP_CREDIT_ISSUE_FROM_YMD, isMakeupCreditIssuableYmd } = await loadIssueGate();
  assert.equal(MAKEUP_CREDIT_ISSUE_FROM_YMD, "2026-10-05");
  assert.equal(isMakeupCreditIssuableYmd("2026-10-04"), false, "기준일 하루 전");
  assert.equal(isMakeupCreditIssuableYmd("2026-09-30"), false);
  assert.equal(isMakeupCreditIssuableYmd("2026-10-05"), true, "기준일 당일");
  assert.equal(isMakeupCreditIssuableYmd("2026-10-06"), true);
  assert.equal(isMakeupCreditIssuableYmd("2027-01-01"), true, "연도가 바뀌어도");
  assert.equal(isMakeupCreditIssuableYmd(""), false, "날짜가 없으면 발급하지 않는다");
});

test("발급 판정은 ABSENT 분기에만 걸린다(회수는 날짜와 무관)", () => {
  const body = functionBody(creditService, "syncMakeupCreditForAttendance");
  const absentBranch = body.slice(body.indexOf('if (input.status === "ABSENT")'), body.indexOf("revokeMakeupCredit("));
  assert.match(absentBranch, /if \(!isMakeupCreditIssuableYmd\(input\.absenceYmd\)\) return \{ action: "none" \};/);
  // 정규·특강 좌석 모두 이 함수를 거쳐야 같은 기준이 적용된다.
  assert.match(functionBody(creditService, "syncCreditForRegularSession"), /return syncMakeupCreditForAttendance\(/);
  assert.match(functionBody(creditService, "syncCreditForSeasonalSeat"), /return syncMakeupCreditForAttendance\(/);
});
