// 학부모 «수업» 탭 신청 내역 타임라인(2026-11-10 설계 B) — 규칙을 실제로 실행하고, 행을 그려 확인한다.
//  ① 상태 이름·색 뜻은 catalog 그대로(관리자 신청함과 같은 말)
//  ② 단계: 수강 변경 = 접수→검토→승인/거절→적용, 나머지 = 접수→확인→결과
//  ③ [취소] = 검토 중 수강 변경·신고 상태 결석만 / [취소 요청](d8) = 승인·적용 전·적용일 > 오늘 KST 인 휴원·퇴원만
//  ④ 조회 가드(childAccessSql + notMergedStudent), 최근 3개월
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { loadTsModule } from "./_ts-module.mjs";

const rules = await loadTsModule("src/lib/requests/parent-timeline-rules.ts");
const catalog = await loadTsModule("src/lib/requests/catalog.ts");
const read = (p) => readFileSync(p, "utf8");

const change = (over = {}) => ({
  key: "ENROLLMENT_CHANGE:r1", kind: "ENROLLMENT_CHANGE", id: "r1", studentId: "a", studentName: "합성", title: "휴원 · 월요반", when: "12/1부터",
  createdOn: "2026-11-05", createdAt: "2026-11-05T01:00:00.000Z", rawStatus: "APPROVED", details: [], answer: null,
  change: { kind: "PAUSE", effectiveFrom: "2026-12-01", applied: false }, cancelRequest: null, openHref: "/mypage/enrollment-change", ...over,
});

test("① 상태 이름·색 뜻은 catalog 와 같고, 수강 변경은 안의 종류 이름(휴원·퇴원…)으로 부른다", () => {
  for (const [kind, raw] of [["REGULAR_ABSENCE", "REPORTED"], ["MAKEUP", "BOOKED"], ["PARENT_REQUEST", "COMPLETED"], ["SHUTTLE_DAY", "ACTIVE"], ["ENROLLMENT_CHANGE", "REJECTED"]]) {
    assert.deepEqual(rules.timelineStatus({ kind, rawStatus: raw }), { label: catalog.statusLabel(kind, raw), tone: catalog.statusTone(kind, raw) }, `${kind}/${raw}`);
  }
  assert.equal(rules.timelineKindLabel(change()), "휴원");
  assert.equal(rules.timelineKindLabel(change({ change: { kind: "WITHDRAW", effectiveFrom: "2026-12-01", applied: false } })), "퇴원");
  assert.equal(rules.timelineKindLabel({ kind: "MAKEUP" }), "보강 예약");
  // 취소 요청 중이면 그 말을 앞세운다(처리 필요 색)
  assert.deepEqual(rules.timelineStatus(change({ cancelRequest: { status: "PENDING", requestedOn: "2026-11-10", decisionNote: null } })), { label: "취소 요청 검토 중", tone: "warning" });
});

test("② 단계: 수강 변경 4단계(적용일 표시) · 나머지 3단계", () => {
  const labels = (steps) => steps.map((s) => `${s.label}:${s.state}`);
  assert.deepEqual(labels(rules.timelineSteps(change({ rawStatus: "PENDING" }))), ["접수:done", "검토:current", "승인:todo", "적용 12/1:todo"]);
  assert.deepEqual(labels(rules.timelineSteps(change())), ["접수:done", "검토:done", "승인:done", "적용 12/1 예정:current"]);
  assert.deepEqual(labels(rules.timelineSteps(change({ rawStatus: "APPLIED" }))), ["접수:done", "검토:done", "승인:done", "적용 12/1:done"]);
  assert.deepEqual(labels(rules.timelineSteps(change({ rawStatus: "REJECTED" }))), ["접수:done", "검토:done", "거절:stopped"]);
  assert.deepEqual(labels(rules.timelineSteps(change({ rawStatus: "CANCELED" }))), ["접수:done", "취소:stopped"]);
  assert.deepEqual(labels(rules.timelineSteps({ kind: "REGULAR_ABSENCE", rawStatus: "REPORTED" })), ["접수:done", "확인 중:current", "완료:todo"]);
  assert.deepEqual(labels(rules.timelineSteps({ kind: "REGULAR_ABSENCE", rawStatus: "CONFIRMED" })), ["접수:done", "확인:done", "확인됨:done"]);
  assert.deepEqual(labels(rules.timelineSteps({ kind: "MAKEUP", rawStatus: "BOOKED" })), ["접수:done", "확인:done", "예약됨:current"]);
  assert.deepEqual(labels(rules.timelineSteps({ kind: "MAKEUP", rawStatus: "NO_SHOW" })), ["접수:done", "확인:done", "무단 불참:stopped"]);
  assert.deepEqual(labels(rules.timelineSteps({ kind: "REGULAR_ABSENCE", rawStatus: "CANCELLED" })), ["접수:done", "취소:stopped"]);
});

test("③ [취소]·[취소 요청] 버튼 조건", () => {
  assert.equal(rules.canCancelNow(change({ rawStatus: "PENDING" })), true);
  assert.equal(rules.canCancelNow(change()), false, "승인된 건은 바로 취소 못 한다(취소 요청으로)");
  assert.equal(rules.canCancelNow({ kind: "REGULAR_ABSENCE", rawStatus: "REPORTED" }), true);
  assert.equal(rules.canCancelNow({ kind: "REGULAR_ABSENCE", rawStatus: "CONFIRMED" }), false);
  assert.equal(rules.canCancelNow({ kind: "MAKEUP", rawStatus: "BOOKED" }), false, "보강은 원래 화면에서");

  const today = "2026-11-10";
  assert.equal(rules.canRequestCancel(change(), today), true, "승인된 휴원, 적용 12/1 > 오늘");
  assert.equal(rules.canRequestCancel(change({ change: { kind: "WITHDRAW", effectiveFrom: "2026-12-01", applied: false } }), today), true);
  assert.equal(rules.canRequestCancel(change({ change: { kind: "CLASS_CHANGE", effectiveFrom: "2026-12-01", applied: false } }), today), false, "반 변경은 대상 아님");
  assert.equal(rules.canRequestCancel(change({ change: { kind: "PAUSE", effectiveFrom: "2026-11-10", applied: false } }), today), false, "적용일 = 오늘이면 이미 늦다");
  assert.equal(rules.canRequestCancel(change({ change: { kind: "PAUSE", effectiveFrom: "2026-12-01", applied: true } }), today), false);
  assert.equal(rules.canRequestCancel(change({ rawStatus: "PENDING" }), today), false);
  assert.equal(rules.canRequestCancel(change({ cancelRequest: { status: "PENDING", requestedOn: today, decisionNote: null } }), today), false, "이미 요청함");
  assert.equal(rules.canRequestCancel(change({ cancelRequest: { status: "REJECTED", requestedOn: today, decisionNote: "어려워요" } }), today), false, "거절된 뒤 다시 내지 않는다");
  assert.equal(rules.cancelRequestLine({ status: "REJECTED", requestedOn: today, decisionNote: "이미 대기자가 있어요" }), "취소 요청이 받아들여지지 않았어요: 이미 대기자가 있어요");
  assert.match(rules.cancelRequestLine({ status: "PENDING", requestedOn: today, decisionNote: null }), /11\/10/);
  assert.equal(rules.cancelRequestLine(null), null);

  const view = rules.toTimelineView(change(), today);
  assert.equal(view.canRequestCancel, true);
  assert.equal(view.statusLabel, "승인·적용일 대기");
  assert.deepEqual(rules.sortTimeline([{ key: "b", createdAt: "2026-11-01" }, { key: "a", createdAt: "2026-11-09" }]).map((r) => r.key), ["a", "b"]);
});

test("④ 조회 가드: 표마다 childAccessSql + notMergedStudent, 최근 3개월, ORM 기본 메서드 없음", () => {
  const src = read("src/lib/requests/parent-timeline.ts");
  const queries = src.split("prisma.$queryRawUnsafe").slice(1);
  assert.equal(queries.length, 6, "결석·보강·셔틀·특강 결석·특강 보강·문의");
  for (const q of queries) {
    const sql = q.slice(0, q.indexOf("parentUserId"));
    assert.match(sql, /JOIN "Student" s ON s\.id = [^\n]+AND \$\{notMergedStudent\("s"\)\}/);
    assert.match(sql, /WHERE \$\{access\}/);
    assert.match(sql, /\$\{RECENT\}/);
  }
  assert.match(src, /const RECENT = `now\(\) - interval '3 months'`/);
  assert.match(src, /getEnrollmentChangeHistory\(parentUserId, \{ includeOpen: true \}\)/, "수강 변경은 기존 조회 재사용");
  assert.doesNotMatch(src, /prisma\.\w+\.(findMany|findFirst|create|update|upsert)/);
  // 수강 변경 이력: 기본은 예전 그대로(결정된 것만), 타임라인만 검토 중·적용 전 포함
  const lib = read("src/lib/enrollment/parent-change-request.ts");
  assert.match(lib, /options\.includeOpen\s*\?\s*`\('PENDING','APPROVED','APPLIED','REJECTED','CANCELED'\)`\s*:\s*`\('APPROVED','APPLIED','REJECTED','CANCELED'\)`/);
  assert.match(lib, /const history = await getEnrollmentChangeHistory\(parentUserId\);/);
});

// ── 행 그리기 ──
const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
function load(path, mocks = {}) {
  const absolute = resolve(path);
  const compiled = ts.transpileModule(read(absolute), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }, fileName: absolute }).outputText;
  const module = new Module(absolute);
  module.filename = absolute;
  module.paths = Module._nodeModulePaths(resolve("."));
  module.require = (name) => name in mocks ? mocks[name] : require(name);
  module._compile(compiled, absolute);
  return module.exports;
}

test("화면: 한 줄 행 = 제목 · 날짜 · 상태 배지(토큰 색), 없으면 «신청 내역이 없어요»", () => {
  const Timeline = load("src/app/mypage/classes/RequestTimeline.tsx", {
    "next/link": { __esModule: true, default: ({ children, ...p }) => React.createElement("a", p, children) },
    "next/navigation": { useRouter: () => ({ refresh() {} }) },
    "@/lib/ui/statusTones": load("src/lib/ui/statusTones.ts"),
    "@/components/admin/list/ListDetailPanel": { __esModule: true, default: () => null },
    "@/components/parent/InlineConfirm": { __esModule: true, default: () => null },
    "@/components/parent/customerMessage": { customerMessage: (_r, f) => f },
  }).default;
  const view = rules.toTimelineView(change(), "2026-11-10");
  const html = renderToStaticMarkup(React.createElement(Timeline, { rows: [view] }));
  assert.match(html, /신청 내역/);
  assert.match(html, /최근 3개월/);
  assert.match(html, /휴원 · 월요반<\/span><span[^>]*>12\/1부터<\/span><span class="[^"]*bg-\[var\(--color-academy-info-soft\)\][^"]*">승인·적용일 대기/);
  assert.match(html, /class="flex min-h-11 /, "행 높이 44px 이상");
  assert.match(renderToStaticMarkup(React.createElement(Timeline, { rows: [] })), /신청 내역이 없어요/);
});
