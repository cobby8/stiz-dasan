import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../src/lib/staff-class-people.ts", import.meta.url),
  "utf8",
);
const action = readFileSync(
  new URL("../src/app/actions/staff-class-people.ts", import.meta.url),
  "utf8",
);

test("담당 수업 권한을 확인하고 개인정보를 캐시하지 않는다", () => {
  assert.match(source, /noStore\(\)/);
  // f4: 대타 판정 날짜(substituteDate)를 함께 넘길 수 있다 — 권한 확인 자체는 그대로 반드시 거친다.
  assert.match(source, /requireStaffClassAccess\(classId[,)]/);
  assert.doesNotMatch(source, /console\.(?:log|error)/);
});

test("학생, 복수 보호자, 출결, 청구 요약을 한 번의 묶음 조회로 가져온다", () => {
  // 지켜야 할 것은 "학생 수만큼 쿼리가 늘지 않는다"(N+1 방지)이지 정확히 1개가 아니다.
  // 방학특강 회차를 찾는 고정 개수의 조회가 뒤에 추가됐다.
  const queryCount = source.match(/prisma\.\$queryRawUnsafe/g)?.length ?? 0;
  assert.ok(queryCount <= 5, `묶음 조회가 풀린 것 같습니다(${queryCount}개)`);
  // 학생 목록을 돌면서 조회하면 N+1 이 된다.
  assert.doesNotMatch(source, /for \(const student[\s\S]{0,200}\$queryRawUnsafe/);
  assert.match(source, /WITH active_students AS/);
  assert.match(source, /jsonb_agg/);
  assert.match(source, /recent_attendance AS/);
  assert.match(source, /billing_summary AS/);
});

test("활성 수강생과 해당 수업 결제만 노출한다", () => {
  assert.match(source, /e\.status = 'ACTIVE'/);
  assert.match(source, /p\."classId" = \$1/);
  assert.match(source, /se\."classId" = \$1/);
});

test("UI용 Server Action은 입력을 제한하고 조회 결과만 직렬화해 반환한다", () => {
  assert.match(action, /^"use server";/);
  assert.match(action, /export async function loadStaffClassPeople/);
  // 방학특강 회차(sessionDateId)를 함께 넘기도록 인자가 늘었다.
  assert.match(action, /getStaffClassPeople\(classId, sessionId, sessionDateId\)/);
  assert.match(action, /Promise<LoadStaffClassPeopleResult>/);
  assert.doesNotMatch(action, /prisma/);
});
