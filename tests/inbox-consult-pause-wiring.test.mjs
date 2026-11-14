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
const detail = read("src/app/admin/enrollment-changes/EnrollmentChangeInboxDetail.tsx");
const changes = read("src/app/admin/enrollment-changes/EnrollmentChangesClient.tsx");
const plan = load("src/lib/enrollment/pause-settlement-plan.ts");

// ── A) 상담 ──────────────────────────────────────────────────────────────
test("A 상담: updateConsultRequest 연결 — ref.actions 에 있는 버튼만, 취소는 확인 한 번", () => {
  assert.match(client, /import \{ updateConsultRequest \} from "@\/app\/actions\/consult"/);
  assert.match(client, /const allowed = new Set\(\(row\.ref\?\.actions \?\? ""\)\.split\(","\)\.filter\(Boolean\)\)/);
  for (const action of ["CANCELED", "CONTACTED", "DONE"]) {
    assert.match(client, new RegExp(`allowed\\.has\\("${action}"\\)[\\s\\S]{0,400}updateConsultRequest\\(row\\.id, "${action}", changedNote\\(note\\)\\)`), action);
  }
  assert.match(client, /allowed\.has\("NOTE"\)[\s\S]{0,200}updateConsultRequest\(row\.id, "NOTE", note\)/, "메모 저장은 항상 보낸다");
  // 취소만 확인 창(위험)
  assert.match(client, /key: "consult-cancel", label: "취소", look: "danger",\s*confirm: \{ title: `\$\{who\} 상담 취소`/);
  // 예전 «PM 통합 단계에서 연결» 자리 표시는 지웠다
  assert.doesNotMatch(client, /연결은 PM 통합 단계에서 한다/);
});

test("A 상담: 메모 칸 초기값 = ref.adminNote · 전화 버튼 = tel:ref.phone", () => {
  // 2026-11-14 c3: 문의 답변은 «이어 쓰기»라 빈칸으로 연다(상담 메모만 저장된 값을 채운다)
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
test("휴원 상세와 기존 수강 변경 화면은 같은 처리 컴포넌트를 사용한다", () => {
  assert.match(client, /<EnrollmentChangeInboxDetail[\s\S]*?requestIds=\{open\.members\?\.map/);
  assert.match(detail, /<EnrollmentChangesClient[\s\S]*?inline/);
  assert.match(changes, /disabled=\{pending \|\| row\.settlementReadFailed/);
  for (const name of ["decideEnrollmentChange", "settlePauseTuition", "retryPauseTuitionRefund", "markPauseTuitionLineDone", "markPauseCarryHandled", "confirmEnrollmentChangeRallyz"]) {
    assert.ok(changes.includes(name), name);
  }
  const actions = read("src/app/actions/enrollment-changes.ts");
  assert.match(actions, /export async function readEnrollmentChangesForInbox[\s\S]{0,200}await requireAdmin\(\)/);
});

test("휴원 수강료 처리 대기 안내에서 화면을 옮기지 않는다", () => {
  const page = read("src/app/admin/inbox/page.tsx");
  assert.match(page, /countOpenPauseSettlements\(\)/);
  assert.match(client, /휴원 수강료 처리 대기/);
  assert.doesNotMatch(client, /href="\/admin\/enrollment-changes/);
});

// ── 검수 권장 3건(11-10) ─────────────────────────────────────────────────
// 모르는 «@/…»·next 모듈은 아무 함수나 돌려주는 빈 모듈로(맨 위 SQL 조각 함수 호출이 죽지 않게)
const stubModule = () => new Proxy({}, { get: (_, key) => (key === "__esModule" ? true : () => "") });
const loadLoose = (path, mocks) => {
  const absolute = resolve(path);
  const compiled = ts.transpileModule(read(absolute), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    fileName: absolute,
  }).outputText;
  const module = new Module(absolute);
  module.filename = absolute;
  module.paths = Module._nodeModulePaths(resolve("."));
  module.require = (name) => (name in mocks ? mocks[name] : /^(@\/|next\/|\.\/)/.test(name) ? stubModule() : nodeRequire(name));
  module._compile(compiled, absolute);
  return module.exports;
};

test("권장2 상담 메모: 상태 버튼은 메모가 처음 값과 같으면 undefined(서버가 유지), 고치면 보냄 · «메모 저장»은 항상", async () => {
  const calls = [];
  const inbox = loadLoose("src/app/admin/inbox/InboxClient.tsx", {
    "@/app/actions/consult": { updateConsultRequest: async (...args) => { calls.push(args); return { ok: true }; } },
    "@/lib/requests/catalog": { ENROLLMENT_CANCEL_REQUESTED: "CANCEL_REQUESTED", BULK_ACTION_KINDS: [] },
  });
  const row = { kind: "CONSULT", id: "c1", studentName: "합성", title: "상담 신청 · 초3", rawStatus: "NEW", facts: [],
    ref: { phone: "01012345678", adminNote: "처음 메모", actions: "CONTACTED,DONE,CANCELED,NOTE" } };
  const actions = inbox.actionsFor(row);
  assert.deepEqual(actions.map((a) => a.key), ["consult-cancel", "consult-note", "consult-contacted", "consult-done"]);
  const byKey = Object.fromEntries(actions.map((a) => [a.key, a]));
  for (const key of ["consult-contacted", "consult-done", "consult-cancel"]) await byKey[key].run("처음 메모");
  assert.deepEqual(calls.map((c) => c[2]), [undefined, undefined, undefined], "그대로면 메모를 보내지 않는다");
  calls.length = 0;
  await byKey["consult-done"].run("고친 메모");
  await byKey["consult-contacted"].run("");
  await byKey["consult-note"].run("처음 메모");
  assert.deepEqual(calls, [["c1", "DONE", "고친 메모"], ["c1", "CONTACTED", ""], ["c1", "NOTE", "처음 메모"]]);
  // 끝난 상담 = 메모만
  assert.deepEqual(inbox.actionsFor({ ...row, rawStatus: "DONE", ref: { ...row.ref, actions: "NOTE" } }).map((a) => a.key), ["consult-note"]);
});

/** 서버 승인 함수를 가짜 DB·미리보기로 실행 */
function serverHarness({ kind = "PAUSE", preview }) {
  const sqls = [];
  const tx = { async $queryRawUnsafe(sql) { sqls.push(sql); return []; } };
  const prisma = {
    async $queryRawUnsafe(sql) { sqls.push(sql); return sql.includes('SELECT kind FROM "EnrollmentChangeRequest"') ? [{ kind }] : []; },
    async $transaction(run) { sqls.push("TX"); return run(tx); },
  };
  const mod = loadLoose("src/lib/enrollment/admin-change-request.ts", {
    "@/lib/prisma": { prisma },
    "@/lib/enrollment/pause-settlement-plan": plan,
    "@/lib/datetime/kst": { ...load("src/lib/datetime/kst.ts"), todayKst: () => "2026-11-11" },
    "@/lib/enrollment/pause-settlement": {
      lockPauseSettlement: async (db) => { assert.equal(db, tx); sqls.push("LOCK"); },
      previewPauseSettlement: async (db, _id, _dates, lock) => {
        assert.equal(db, tx);
        assert.equal(lock, true);
        sqls.push("PREVIEW");
        return preview && { requestId: "r1", previewKey: "k", lines: [], ready: true, tablesReady: preview.tablesReady ?? true,
          plan: { paidTotal: preview.paidTotal ?? 0, unpaidTotal: preview.unpaidTotal ?? 0, problems: preview.problems ?? [], lines: [] } };
      },
    },
    "@/lib/enrollment/monthlyClassDates": { loadAnnualPlanEvents: async () => [], getMonthlyClassDates: () => [] },
  });
  return { mod, sqls };
}

test("권장1 서버 강제: 휴원 승인에 방식이 없고 처리할 금액이 있으면 거절(needsSettlementChoice) — 승인 UPDATE 안 함", async () => {
  const { mod, sqls } = serverHarness({ preview: { paidTotal: 50000 } });
  const result = await mod.decideEnrollmentChangeRequest({ adminUserId: "a", requestId: "r1", approve: true, settlement: null });
  assert.deepEqual(result, { ok: false, message: plan.SETTLEMENT_CHOICE_REQUIRED_MESSAGE, needsSettlementChoice: true });
  assert.equal(plan.SETTLEMENT_CHOICE_REQUIRED_MESSAGE, "수강료 처리 방식을 골라 주세요(금액이 바뀌었어요).");
  assert.deepEqual(sqls.slice(1), ["TX", "LOCK", "PREVIEW"], "거래 안에서 잠근 뒤 재계산하고 승인 UPDATE는 하지 않는다");
  // 미납 청구만 있어도 강제
  const unpaid = serverHarness({ preview: { unpaidTotal: 30000 } });
  assert.equal((await unpaid.mod.decideEnrollmentChangeRequest({ adminUserId: "a", requestId: "r1", approve: true })).needsSettlementChoice, true);
});

test("수강료 방식이 있는 승인도 청구 잠금을 신청 행 UPDATE보다 먼저 잡는다", async () => {
  const { mod, sqls } = serverHarness({});
  await mod.decideEnrollmentChangeRequest({ adminUserId: "a", requestId: "r1", approve: true, settlement: { mode: "REFUND", expectedPreviewKey: "k" } });
  assert.deepEqual(sqls.slice(0, 2), ["TX", "LOCK"]);
  assert.match(sqls[2], /UPDATE "EnrollmentChangeRequest"/);
});

test("권장1 서버 강제 예외: 금액 없음·계산 문제·표 준비 전·휴원 아님·거절은 예전처럼 진행", async () => {
  const cases = [
    { name: "금액 없음", h: { preview: { paidTotal: 0, unpaidTotal: 0 } } },
    { name: "계산 문제", h: { preview: { paidTotal: 50000, problems: ["반 요일을 알 수 없어요."] } } },
    { name: "표 준비 전", h: { preview: { paidTotal: 50000, tablesReady: false } } },
    { name: "휴원 아님", h: { kind: "WITHDRAW", preview: { paidTotal: 50000 } } },
  ];
  for (const { name, h } of cases) {
    const { mod, sqls } = serverHarness(h);
    const result = await mod.decideEnrollmentChangeRequest({ adminUserId: "a", requestId: "r1", approve: true, settlement: null });
    assert.ok(sqls.includes("TX"), `${name}: 승인 트랜잭션까지 간다`);
    assert.equal(result.needsSettlementChoice, undefined, name);
  }
  const { mod, sqls } = serverHarness({ preview: { paidTotal: 50000 } });
  await mod.decideEnrollmentChangeRequest({ adminUserId: "a", requestId: "r1", approve: false, settlement: null });
  assert.ok(sqls.includes("TX") && !sqls.some((s) => String(s).includes("SELECT kind")), "거절은 미리보기를 계산하지 않는다");
});

test("휴원 정산 문제 안내는 공유 상세에 표시한다", () => {
  assert.match(changes, /SETTLEMENT_PROBLEM_APPROVE_NOTE[\s\S]*\{SETTLEMENT_PROBLEM_APPROVE_NOTE\}/);
});
