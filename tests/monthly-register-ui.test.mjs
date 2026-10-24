import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const ui = readFileSync("src/app/admin/finance/monthly-register/MonthlyRegisterClient.tsx", "utf8");
const modelSource = readFileSync("src/lib/billing/monthly-register.ts", "utf8");
const model = {};
new Function("exports", ts.transpileModule(modelSource, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
} }).outputText)(model);
// React 렌더링이나 브라우저 대신 실제 화면의 순수 입력 변환 함수만 실행한다.
const helpers = ui.slice(ui.indexOf("function readAmount("), ui.indexOf("export default function MonthlyRegisterClient"));
const { readAmount, buildDraft } = new Function("validateMonthlyRegisterDraft",
  `${ts.transpileModule(helpers, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText}; return { readAmount, buildDraft };`,
)(model.validateMonthlyRegisterDraft);
const target = { studentId: "student-1", month: "2026-09" };
const editor = () => ({ classes: [{ classId: "class-1", status: "ACTIVE", periodStart: "2026-09-01", periodEnd: "2026-09-30",
  baseAmount: "100000", discountAmount: "10000", carryAmount: "5000", prorationAmount: "5000", basis: "근거 확인" }],
  shuttleAmount: "10000", shuttleBasis: "월 1회 이용" });

test("화면 입력은 빈금액을0으로 바꾸지 않고 정수·날짜·상태를 서버와 같은 기준으로 검증한다", () => {
  for (const value of ["", " ", "-1", "1.5", "1e3", "1,000", "Infinity", "9007199254740992"]) {
    assert.throws(() => readAmount(value, "금액"));
  }
  assert.equal(readAmount("0", "금액"), 0);
  const draft = buildDraft(editor(), target, " 저장 사유 ");
  assert.equal(draft.reason, "저장 사유");
  assert.equal(model.calculateMonthlyRegister(draft).totalAmount, 90000);
  for (const patch of [{ baseAmount: "" }, { periodStart: "" }, { periodEnd: "2026-09-31" }, { status: "PAUSED" }, { basis: " " }, { discountAmount: "110000" }]) {
    const bad = editor(); Object.assign(bad.classes[0], patch);
    assert.throws(() => buildDraft(bad, target, "사유"));
  }
  assert.throws(() => buildDraft(editor(), target, " "));
  assert.throws(() => buildDraft({ ...editor(), shuttleBasis: " " }, target, "사유"));
  assert.throws(() => buildDraft({ ...editor(), classes: [] }, target, "사유"));
});

test("여러 반의 금액과 학생월 셔틀비를 한 번 계산하고 입력은 변경하지 않는다", () => {
  const input = editor();
  input.classes.push({ ...input.classes[0], classId: "class-2" });
  const before = structuredClone(input);
  const draft = buildDraft(input, target, "다반 확인");
  assert.equal(model.calculateMonthlyRegister(draft).totalAmount, 170000);
  assert.deepEqual(input, before);
  input.classes[1].classId = "class-1";
  assert.throws(() => buildDraft(input, target, "다반 확인"), /중복/);
});

test("확정은 저장된버전·금액만, 재열기 후 편집과 누락반 검사를 유지한다 (소스 계약)", () => {
  assert.match(ui, /action === "CONFIRM" && \(dirty \|\| !view\.record\)/);
  assert.match(ui, /action === "SAVE_DRAFT" && confirmed/);
  assert.match(ui, /action === "REOPEN" && !confirmed/);
  assert.match(ui, /action === "SAVE_DRAFT" \? buildDraft\(editor, target, reason\) : view\.record!\.payload/);
  assert.match(ui, /\["ACTIVE", "PAUSED"\]\.includes\(candidate\.status\)/);
  assert.match(ui, /expectedVersion: preview\.version/);
  assert.match(ui, /preview\.action === "SAVE_DRAFT" \? \{ payload: preview\.payload \} : \{\}/);
  assert.match(ui, /위 내용을 확인했고/);
  assert.match(ui, /청구서 발행·수납·문자 발송은 하지 않습니다/);
});

test("대상변경·중복클릭·쓰기off·응답오류를 잠그고 실패 시 자동 재시도하지 않는다 (소스 계약)", () => {
  assert.match(ui, /preview\.target\.studentId !== target\?\.studentId/);
  assert.match(ui, /preview\.version !== \(view\.record\?\.version \?\? 0\)/);
  assert.match(ui, /!preview \|\| !view\?\.writesEnabled \|\| posting\.current \|\| !ready/);
  assert.match(ui, /posting\.current = true; setSaving\(true\)/);
  assert.match(ui, /cache: "no-store", signal: controller\.signal/);
  assert.match(ui, /id !== requestId\.current \|\| controller\.signal\.aborted/);
  assert.match(ui, /setNeedsRefresh\(true\); setPreview\(null\)/);
  assert.match(ui, /자동 재시도하지 않습니다/);
  assert.match(ui, /setPreview\(null\); setView\(null\); setReload/);
  assert.doesNotMatch(ui, /setInterval|localStorage|sessionStorage/);
});

test("미저장·사유·미리보기·결과 불확실 상태에 이탈 경고를 연결하고 정리한다 (소스 계약)", () => {
  assert.match(ui, /hasUnsavedWork = dirty \|\| Boolean\(reason\.trim\(\)\) \|\| Boolean\(preview\)/);
  assert.match(ui, /if \(!hasUnsavedWork && !saving && !needsRefresh\) return/);
  assert.match(ui, /window\.addEventListener\("beforeunload", warnBeforeUnload\)/);
  assert.match(ui, /window\.removeEventListener\("beforeunload", warnBeforeUnload\)/);
  assert.match(ui, /event\.returnValue = ""/);
  assert.match(ui, /document\.addEventListener\("click", guardLink, true\)/);
  assert.match(ui, /document\.removeEventListener\("click", guardLink, true\)/);
  assert.doesNotMatch(ui, /popstate|history\.pushState|history\.replaceState/);
});

test("저장 시작부터 검증된 재조회까지 링크 이동을 차단하고 동기 중복 보호를 유지한다 (소스 계약)", () => {
  assert.match(ui, /posting\.current \|\| saving \|\| \(needsRefresh && loading\)/);
  assert.match(ui, /event\.preventDefault\(\); event\.stopImmediatePropagation\(\)/);
  assert.match(ui, /저장 결과를 확인 중입니다.*이동해 주세요/);
  const saveStart = ui.slice(ui.indexOf('posting.current = true;'), ui.indexOf('const response = await fetch("/api/admin/finance/monthly-register"'));
  assert.match(saveStart, /setNeedsRefresh\(true\)/);
  // 저장 응답만으로 잠금을 풀지 않고, 대상이 일치하는 GET 응답만 해제한다.
  assert.equal((ui.match(/setNeedsRefresh\(false\)/g) ?? []).length, 1);
  assert.ok(ui.indexOf('조회 대상과 반환된 장부가 다릅니다') < ui.indexOf('setNeedsRefresh(false)'));
  assert.doesNotMatch(ui.slice(ui.indexOf('async function executePreview()')), /setNeedsRefresh\(false\)/);
});
