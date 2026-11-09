// 신청함 연결(통합 2026-11-10) — A) «상담» 탭 상세 칸 버튼 · B) «변경» 탭 휴원 승인 전 수강료 처리
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

const nodeRequire = createRequire(import.meta.url);
const read = (path) => readFileSync(path, "utf8");
// tsx/ts 를 CommonJS 로 바꿔 불러온다(다른 테스트와 같은 방식)
const load = (path, mocks = {}) => {
  const absolute = resolve(path);
  const compiled = ts.transpileModule(read(absolute), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    fileName: absolute,
  }).outputText;
  const module = new Module(absolute);
  module.filename = absolute;
  module.paths = Module._nodeModulePaths(resolve("."));
  module.require = (name) => (name in mocks ? mocks[name] : nodeRequire(name));
  module._compile(compiled, absolute);
  return module.exports;
};

const client = read("src/app/admin/inbox/InboxClient.tsx");
const box = read("src/app/admin/inbox/PauseSettlementBox.tsx");
const changes = read("src/app/admin/enrollment-changes/EnrollmentChangesClient.tsx");
const plan = load("src/lib/enrollment/pause-settlement-plan.ts");
const parts = load("src/app/admin/inbox/PauseSettlementBox.tsx", { "@/lib/enrollment/pause-settlement-plan": plan });

// ── A) 상담 ──────────────────────────────────────────────────────────────
test("A 상담: updateConsultRequest 연결 — ref.actions 에 있는 버튼만, 취소는 확인 한 번", () => {
  assert.match(client, /import \{ updateConsultRequest \} from "@\/app\/actions\/consult"/);
  assert.match(client, /const allowed = new Set\(\(row\.ref\?\.actions \?\? ""\)\.split\(","\)\.filter\(Boolean\)\)/);
  for (const action of ["CANCELED", "NOTE", "CONTACTED", "DONE"]) {
    assert.match(client, new RegExp(`allowed\\.has\\("${action}"\\)[\\s\\S]{0,400}updateConsultRequest\\(row\\.id, "${action}", note\\)`), action);
  }
  // 취소만 확인 창(위험)
  assert.match(client, /key: "consult-cancel", label: "취소", look: "danger",\s*confirm: \{ title: `\$\{who\} 상담 취소`/);
  // 예전 «PM 통합 단계에서 연결» 자리 표시는 지웠다
  assert.doesNotMatch(client, /연결은 PM 통합 단계에서 한다/);
});

test("A 상담: 메모 칸 초기값 = ref.adminNote · 전화 버튼 = tel:ref.phone", () => {
  assert.match(client, /setNote\(row\.kind === "CONSULT" \? row\.ref\?\.adminNote \?\? "" : ""\)/);
  assert.match(client, /open\.kind === "CONSULT" && open\.ref\?\.phone && \(\s*<a href=\{`tel:\$\{open\.ref\.phone\}`\}/);
  assert.match(client, /"원장 메모\(학부모에게 안 보임\)"/);
});

test("A 상담: 상태별 버튼 목록(consultActionsFor)이 신청함 버튼 키와 맞는다", () => {
  const rules = load("src/lib/consult/consult-rules.ts");
  assert.deepEqual(rules.consultActionsFor("NEW"), ["CONTACTED", "DONE", "CANCELED", "NOTE"]);
  assert.deepEqual(rules.consultActionsFor("CONTACTED"), ["DONE", "CANCELED", "NOTE"]);
  assert.deepEqual(rules.consultActionsFor("DONE"), ["NOTE"], "끝난 상담은 메모만");
  assert.deepEqual(rules.consultActionsFor("CANCELED"), ["NOTE"]);
});

// ── B) 휴원 수강료 처리 ──────────────────────────────────────────────────
const preview = (over = {}) => ({
  requestId: "req-1", previewKey: "k1", lines: ["11월 4회 중 2회"], ready: true, tablesReady: true,
  paidTotal: 50000, unpaidTotal: 0, problems: [], channels: ["TOSS"], ...over,
});

test("B 규칙: 금액이 있고 문제 없으면 방식 필수 — 수강 변경 화면 needsSettlementChoice 와 같은 조건", () => {
  assert.equal(parts.pauseNeedsSettlementChoice(preview()), true);
  assert.equal(parts.pauseNeedsSettlementChoice(preview({ paidTotal: 0, unpaidTotal: 30000 })), true);
  assert.equal(parts.pauseNeedsSettlementChoice(preview({ paidTotal: 0, unpaidTotal: 0 })), false, "처리할 금액 없음");
  assert.equal(parts.pauseNeedsSettlementChoice(preview({ problems: ["반 요일을 알 수 없어요."] })), false, "문제 있으면 안내만");
  assert.equal(parts.pauseNeedsSettlementChoice(null), false);
  // 수강 변경 화면의 원래 조건(금액·문제)과 글자 그대로 비교
  assert.match(changes, /p\.problems\.length === 0 && \(p\.paidTotal > 0 \|\| p\.unpaidTotal > 0\)/);
  assert.match(box, /preview\.problems\.length === 0 && \(preview\.paidTotal > 0 \|\| preview\.unpaidTotal > 0\)/);
});

test("B 문구: 확인창·안내 문구가 수강 변경 화면과 같다", () => {
  const text = parts.pauseSettlementConfirmText("합성 학생 · 합성 반 · 휴원 2026-12-01부터", preview({ channels: ["TOSS", "RALLYZ"], unpaidTotal: 10000 }), "REFUND");
  assert.match(text, /수강료 처리: 환불/);
  assert.match(text, /환불 50,000원/);
  assert.match(text, /토스 온라인 결제분은 확인을 누르면 바로 부분 취소됩니다\(되돌릴 수 없음\)/);
  assert.match(text, /«환불 할 일»로 남습니다/);
  assert.match(text, /미납 청구 10,000원 감액/);
  assert.match(parts.pauseSettlementConfirmText("h", preview(), "NONE"), /돈은 움직이지 않고 기록만 남깁니다/);
  assert.match(parts.pauseSettlementConfirmText("h", preview(), "CARRY"), /이월 50,000원 — 다음 청구에서 차감/);
  for (const phrase of [
    "토스 온라인 결제분은 확인을 누르면 바로 부분 취소됩니다(되돌릴 수 없음).",
    "현금·랠리즈·POS 등은 «환불 할 일»로 남습니다.",
    "돈은 움직이지 않고 기록만 남깁니다.",
    "휴원 기간에 걸친 수강료 청구가 없어 처리할 금액이 없습니다.",
    "수강료 처리 기록 준비 전이라 지금은 금액 미리보기만 됩니다.",
    "이월 = 다음 청구에서 차감 · 환불 = 토스 온라인 결제는 바로 부분 취소, 그 밖은 환불 할 일로 남김 · 없음 = 기록만(미납 청구도 그대로)",
    'role="radiogroup" aria-label="휴원 수강료 처리 방식"',
  ]) {
    assert.ok(changes.includes(phrase), `수강 변경 화면: ${phrase}`);
    assert.ok(box.includes(phrase), `신청함: ${phrase}`);
  }
});

test("B 연결: 칸을 열면 미리보기를 받고, 방식을 고르기 전·계산 중엔 승인이 잠기며, 서버에 { mode, expectedPreviewKey }", () => {
  assert.match(client, /row\.kind === "ENROLLMENT_CHANGE" && row\.rawStatus === "PENDING" && row\.ref\?\.changeKind === "PAUSE"/);
  assert.match(client, /getPauseTuitionPreview\(pauseRequestId\)/);
  assert.match(client, /if \(pauseState\.status !== "ready"\) return \{ \.\.\.action, disabled: true \}/);
  assert.match(client, /if \(!pauseMode \|\| !preview\.ready\) return \{ \.\.\.action, disabled: true \}/);
  assert.match(client, /settlement: \{ mode, expectedPreviewKey: preview\.previewKey \}/);
  assert.match(client, /disabled=\{pending \|\| action\.disabled\}/);
  // 어댑터가 휴원 여부를 실어 준다
  assert.match(read("src/lib/requests/admin-inbox.ts"), /ref: \{ changeKind: text\(e\.changeKind\) \|\| null \}/);
  // 서버 액션은 관리자만, 실패는 ok:false(금액 모른 채 승인 금지)
  const actions = read("src/app/actions/enrollment-changes.ts");
  assert.match(actions, /export async function getPauseTuitionPreview\(requestId: string\) \{\s*await requireAdmin\(\);/);
});

test("B 남은 일: «변경» 탭에 휴원 수강료 처리 남은 일 건수 → 수강 변경 화면 링크", () => {
  const page = read("src/app/admin/inbox/page.tsx");
  assert.match(page, /kinds\.includes\("ENROLLMENT_CHANGE"\) \? countOpenPauseSettlements\(\) : Promise\.resolve\(0\)/);
  assert.match(client, /tab === "CHANGE" && \(rowsData\.openSettlementCount \?\? 0\) > 0/);
  assert.match(client, /href="\/admin\/enrollment-changes\?status=ALL"/);
});

test("B 렌더: 금액 있는 미리보기는 세 방식 버튼, 문제 있으면 빨간 안내만", () => {
  const React = nodeRequire("react");
  const { renderToStaticMarkup } = nodeRequire("react-dom/server");
  const Box = parts.default;
  const html = renderToStaticMarkup(React.createElement(Box, { state: { status: "ready", preview: preview() }, mode: "CARRY", onMode() {}, disabled: false }));
  assert.match(html, /낸 수강료에서 50,000원/);
  assert.equal((html.match(/role="radio"/g) ?? []).length, 3);
  assert.match(html, /aria-checked="true"[^>]*>이월</);
  const problem = renderToStaticMarkup(React.createElement(Box, { state: { status: "ready", preview: preview({ problems: ["반 요일을 알 수 없어 금액을 계산할 수 없어요."] }) }, mode: null, onMode() {}, disabled: false }));
  assert.match(problem, /반 요일을 알 수 없어/);
  assert.doesNotMatch(problem, /role="radio"/);
  assert.match(renderToStaticMarkup(React.createElement(Box, { state: { status: "loading" }, mode: null, onMode() {}, disabled: false })), /계산하는 중/);
  assert.equal(renderToStaticMarkup(React.createElement(Box, { state: { status: "ready", preview: null }, mode: null, onMode() {}, disabled: false })), "");
});
