import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const action = await readFile("src/app/actions/parent-operations-request.ts", "utf8");
const form = await readFile("src/app/request/[token]/ParentRequestForm.tsx", "utf8");

test("사용 완료 링크와 관리자 취소 링크를 구분해 안내한다", () => {
  assert.match(action, /l\."lastUsedAt"/);
  assert.match(action, /row\.lastUsedAt \? "USED" : "INVALID"/);
  assert.match(form, /context\.linkStatus === "USED"/);
  assert.match(form, /이미 요청을 접수했습니다/);
  assert.match(form, /원장님 검토 대기 중입니다/);
});

test("학부모가 항목을 고치면 자연어 해석 시점의 오래된 경고를 제거한다", () => {
  assert.match(form, /warnings: \[\], blockingQuestions: \[\]/);
  assert.match(form, /return \{ \.\.\.next, warnings: \[\], blockingQuestions/);
});

test("모바일 확인 화면에 변경 전후와 요청별 상세 입력 안내를 제공한다", () => {
  for (const text of ["변경 전", "변경 후", "탑승 정보", "변경할 연락처", "확인할 청구 정보"]) {
    assert.ok(form.includes(text), `${text} 안내가 필요합니다.`);
  }
  assert.match(form, /grid-cols-\[1fr_auto_1fr\]/);
  assert.match(form, /실제 시간은 배차 확정 후 안내됩니다/);
  assert.match(form, /새 번호를 숫자만 적어 주세요/);
});

test("승인 전에는 외부 변경과 청구가 없다는 안내를 유지한다", () => {
  assert.match(form, /승인 전에는 수업·셔틀·청구 정보가 변경되지 않습니다/);
  assert.match(form, /청구서와 안내 문자도 별도 승인 전까지 보류됩니다/);
});
