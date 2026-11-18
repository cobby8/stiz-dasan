// 수강 신청 폼 — «다음» 두 번 누르기로 3단계를 건너뛰던 문제(2026-11-17 한 분이 7번 제출 실패)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const form = readFileSync(new URL("../src/app/apply/enroll/EnrollApplicationForm.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("단계 이동 중에는 «다음»을 다시 받지 않고, 지금 단계의 다음 단계로만 간다", () => {
  const fn = form.slice(form.indexOf("const goNext = async () => {"), form.indexOf("const goBack = () => {"));
  assert.match(fn, /^const goNext = async \(\) => \{\s*if \(movingRef\.current\) return;/);
  assert.ok(fn.indexOf("movingRef.current = true;") < fn.indexOf("await loadExistingApplication()"));
  assert.match(fn, /setStep\(Math\.min\(step \+ 1, TOTAL_STEPS\)\);/);
  assert.doesNotMatch(fn, /setStep\(\(current\) =>/, "누적 증가는 두 번 실행되면 두 단계를 건너뛴다");
  assert.match(fn, /finally \{\s*movingRef\.current = false;/);
  assert.match(form, /onClick=\{goNext\} disabled=\{moving\}/);
});

test("제출 직전에 앞 단계를 다시 검증하고, 빠진 단계로 돌려보낸다", () => {
  const fn = form.slice(form.indexOf("const handleSubmit = () => {"), form.indexOf("const signupHref"));
  const check = fn.indexOf("const failedStep = !validateStep1() ? 1 : !validateStep2() ? 2 : !validateStep3() ? 3 : 0;");
  assert.ok(check > 0 && check < fn.indexOf("startTransition("));
  assert.match(fn, /if \(failedStep\) \{\s*setStep\(failedStep\);/);
});
