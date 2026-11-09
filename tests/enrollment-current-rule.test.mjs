// 2026-11-09 원장 기준 — «수강 중/재원생»은 ACTIVE(승인일)부터, 개시일은 청구 시수·출석부 회차에만.
// 이 테스트는 ① 공용 판정 함수 ② 상태 판정 SQL 이 다시 개시일로 «예정»을 만들지 않는지 ③ 개시일을 써야 하는 곳(청구·출석부)은 그대로인지 못박는다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

const rule = await loadTsModule("src/lib/enrollment/commencement.ts");
const read = (p) => readFileSync(p, "utf8");

test("개시일이 미래인 ACTIVE 수강 = 수강 중(예정 아님)", () => {
  const today = "2026-11-09";
  // 허재원 사례: 승인 등록, 개시일 2026-11-13
  assert.equal(rule.isCurrentEnrollment("ACTIVE"), true);
  assert.equal(rule.enrollmentDisplayStatus("ACTIVE", "2026-11-13", today), "ACTIVE");
  assert.equal(rule.enrollmentStartsLater("2026-11-13", today), true, "안내 문구용 «개시 전»은 유지");
  for (const s of ["PAUSED", "WITHDRAWN", null, undefined]) assert.equal(rule.isCurrentEnrollment(s), false);
  assert.equal(rule.currentEnrollmentSql("e"), "e.status = 'ACTIVE'");
  assert.throws(() => rule.currentEnrollmentSql("e; DROP"));
});

test("출석부 회차 명단은 개시일 기준 유지 — 개시일 전 회차엔 넣지 않는다", () => {
  assert.equal(rule.enrollmentHasStarted("2026-11-13", "2026-11-12"), false);
  assert.equal(rule.enrollmentHasStarted("2026-11-13", "2026-11-13"), true);
  // 서버 명단 SQL 들도 개시일 조건을 그대로 갖고 있다
  for (const p of ["src/lib/staff-session-queries.ts", "src/lib/staff-class-people.ts", "src/app/actions/staff-sessions.ts"]) {
    assert.match(read(p), /e\."startsOn" IS NULL OR e\."startsOn" <=/, `${p} 출석부 개시일 조건`);
  }
});

test("상태·인원·재원생 판정 SQL 은 개시일로 «예정»을 만들지 않고 공용 판정을 쓴다", () => {
  const queries = read("src/lib/queries.ts");
  const payloads = read("src/lib/adminReadPayloads.ts");
  const rental = read("src/lib/rental/gym-rental-service.ts");
  for (const [name, src] of [["queries", queries], ["adminReadPayloads", payloads]]) {
    assert.doesNotMatch(src, /THEN 'SCHEDULED'/, `${name}: 개시일로 SCHEDULED 를 만들지 않는다`);
    assert.match(src, /currentEnrollmentSql\("due"\)/, `${name}: 공용 판정 사용`);
  }
  const member = rental.slice(rental.indexOf("export async function listRentalMemberStudents"), rental.indexOf("export const RENTAL_MEMBER_LOGIN_MESSAGE"));
  assert.match(member, /currentEnrollmentSql\("e"\)/);
  assert.doesNotMatch(member, /startsOn/, "재원생 무료 대관은 개시일 전에도 대상");
});

test("청구 시수 계산은 개시일 기준 유지", () => {
  const billing = read("src/lib/billing/workbench-service.ts");
  assert.match(billing, /startsOn && proposedStart && startsOn > proposedStart \? startsOn : proposedStart/);
});
