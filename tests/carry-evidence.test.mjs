// 결석 이월의 «원기간 근거» 순수 규칙(src/lib/billing/carryEvidence.ts) — 실제로 실행해 확인한다.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const url = (source) => `data:text/javascript;base64,${Buffer.from(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText).toString("base64")}`;
const source = await readFile("src/lib/billing/carryEvidence.ts", "utf8");
const { resolveMonthEvidence, CARRY_EVIDENCE_MULTIPLE_PAID } = await import(url(source));

// 2026-11 월요반: 2·9·16·23·30 (5회)
const NOV_MON = ["2026-11-02", "2026-11-09", "2026-11-16", "2026-11-23", "2026-11-30"];
const base = { issuedDraft: null, paidPayments: [], monthDates: NOV_MON, enrollmentStartsOn: null };
const paid = (amount, priorReduction = 0, id = "pay-1") => ({ id, amount, priorReduction });
const draft = (over = {}) => ({
  status: "ISSUED", payload: { baseAmount: 100000, discountAmount: 10000, prorationAmount: 0, carryAmount: 0, shuttleAmount: 20000 },
  paymentId: "draft-pay", paymentStatus: "PAID", periodStart: "2026-11-02", periodEnd: "2026-11-30", scheduledDates: NOV_MON, ...over,
});

test("순수 모듈이다 — DB·시계·외부 호출이 없다", () => {
  assert.doesNotMatch(source, /\$queryRawUnsafe|\$executeRawUnsafe|new Date\(|Date\.now|fetch\(|prisma/);
  assert.doesNotMatch(source, /^import (?!type )/m, "실행 시 불러오는 모듈이 없다(타입만)");
});

test("초안 없음 + 납부완료 1건 → 청구 금액 ÷ 그 달 수업 횟수가 근거", () => {
  const e = resolveMonthEvidence({ ...base, paidPayments: [paid(105000)] });
  assert.deepEqual(e, { kind: "PAID_PAYMENT", tuition: 105000, scheduledDates: NOV_MON, paymentId: "pay-1", periodStart: null, periodEnd: null, warnings: [] });
});

test("납부완료 2건 이상 → 어느 청구가 근거인지 정할 수 없어 차단", () => {
  const e = resolveMonthEvidence({ ...base, paidPayments: [paid(105000, 0, "a"), paid(90000, 0, "b")] });
  assert.deepEqual(e, { kind: "BLOCKED", reason: CARRY_EVIDENCE_MULTIPLE_PAID });
  assert.match(CARRY_EVIDENCE_MULTIPLE_PAID, /여러 건/);
});

test("납부완료가 없으면(취소·환불·미납뿐이면 호출부가 넘기지 않는다) 낸 돈이 없는 달", () => {
  assert.deepEqual(resolveMonthEvidence(base), { kind: "UNPAID", scheduledDates: NOV_MON });
});

test("이미 줄인 금액이 있으면 원래 금액 기준 — 줄어든 금액으로 나누지 않는다", () => {
  // 원래 105,000원 → 휴원 감액 21,000원 → 84,000원 납부. 한 번 값은 105,000 ÷ 5 = 21,000
  const e = resolveMonthEvidence({ ...base, paidPayments: [paid(84000, 21000)] });
  assert.equal(e.kind, "PAID_PAYMENT");
  assert.equal(e.tuition, 105000);
  // 음수 값이 들어와도 금액을 깎지 않는다
  assert.equal(resolveMonthEvidence({ ...base, paidPayments: [paid(84000, -5000)] }).tuition, 84000);
});

test("월중 등록 — 개시일이 그 달 첫 수업일보다 뒤면 개시일 이후 수업만 세고 경고를 남긴다", () => {
  const e = resolveMonthEvidence({ ...base, paidPayments: [paid(63000)], enrollmentStartsOn: "2026-11-16" });
  assert.deepEqual(e.scheduledDates, ["2026-11-16", "2026-11-23", "2026-11-30"]);
  assert.deepEqual([e.periodStart, e.periodEnd], ["2026-11-16", "2026-11-30"]);
  assert.match(e.warnings[0], /월중 등록\(개시일 2026-11-16\).*3회/);
  // 개시일이 수업일 사이(11/10)여도 그날 이후 수업만
  assert.deepEqual(resolveMonthEvidence({ ...base, paidPayments: [paid(84000)], enrollmentStartsOn: "2026-11-10" }).scheduledDates, NOV_MON.slice(2));
});

test("개시일이 그 달 첫 수업일 이전·다른 달·없음·형식 오류면 좁히지 않는다", () => {
  for (const startsOn of ["2026-11-02", "2026-11-01", "2026-10-20", "2025-11-16", "2026-12-07", null, "2026-11-1", ""]) {
    const e = resolveMonthEvidence({ ...base, paidPayments: [paid(105000)], enrollmentStartsOn: startsOn });
    assert.deepEqual([e.scheduledDates, e.periodStart, e.periodEnd, e.warnings], [NOV_MON, null, null, []], String(startsOn));
  }
});

test("수업일이 없으면 나눌 수 없어 차단 — 0으로 나누지 않는다", () => {
  assert.equal(resolveMonthEvidence({ ...base, monthDates: [], paidPayments: [paid(105000)] }).kind, "BLOCKED");
  // 개시일 뒤에 수업이 하나도 없는 경우는 개시일이 그 달 안일 때만 생긴다(마지막 수업일 뒤 등록)
  const e = resolveMonthEvidence({ ...base, monthDates: ["2026-11-02", "2026-11-09"], paidPayments: [paid(105000)], enrollmentStartsOn: "2026-11-20" });
  assert.equal(e.kind, "BLOCKED");
  assert.match(e.reason, /수업일이 없어/);
});

test("금액이 정수가 아니거나 음수면 차단", () => {
  for (const amount of [-1, 1.5, Number.NaN]) assert.equal(resolveMonthEvidence({ ...base, paidPayments: [paid(amount)] }).kind, "BLOCKED", String(amount));
});

test("수업일은 중복을 없애고 날짜순으로 — 분모가 흔들리지 않는다", () => {
  const e = resolveMonthEvidence({ ...base, monthDates: ["2026-11-23", "2026-11-02", "2026-11-02", "2026-11-09"], paidPayments: [paid(90000)] });
  assert.deepEqual(e.scheduledDates, ["2026-11-02", "2026-11-09", "2026-11-23"]);
});

test("셔틀비가 섞였을 수 있으면 경고만 — 금액은 그대로", () => {
  const e = resolveMonthEvidence({ ...base, paidPayments: [paid(125000)], shuttleMayBeIncluded: true });
  assert.equal(e.tuition, 125000);
  assert.deepEqual(e.warnings, ["셔틀비가 포함된 금액일 수 있어요."]);
});

test("발행 초안이 납부됐으면 초안이 먼저 — 수강료−할인−기간조정, 수업일은 발행 때 사본(셔틀·이월 제외)", () => {
  const e = resolveMonthEvidence({ ...base, issuedDraft: draft(), paidPayments: [paid(110000, 0, "draft-pay")] });
  assert.deepEqual(e, { kind: "WORKBENCH_ISSUED", tuition: 90000, scheduledDates: NOV_MON, paymentId: "draft-pay", periodStart: "2026-11-02", periodEnd: "2026-11-30", warnings: [] });
  // 월중 발행 사본(2회)은 그대로 분모가 된다
  const half = resolveMonthEvidence({ ...base, issuedDraft: draft({ payload: { baseAmount: 100000, discountAmount: 0, prorationAmount: 60000, carryAmount: 0, shuttleAmount: 0 }, periodStart: "2026-11-23", scheduledDates: ["2026-11-23", "2026-11-30"] }) });
  assert.deepEqual([half.tuition, half.scheduledDates.length], [40000, 2]);
});

test("발행 초안에 기간 조정이 있는데 수업일 사본이 없으면 전체 월 횟수로 추측하지 않는다", () => {
  const e = resolveMonthEvidence({ ...base, issuedDraft: draft({ payload: { baseAmount: 100000, discountAmount: 0, prorationAmount: 50000, carryAmount: 0, shuttleAmount: 0 }, scheduledDates: [] }) });
  assert.equal(e.kind, "BLOCKED");
  assert.match(e.reason, /실제 수강 기간 근거/);
});

test("발행됐지만 미납인 초안은 근거가 아니다 — 낸 돈이 없는 달", () => {
  for (const paymentStatus of ["PENDING", "OVERDUE", "CANCELED", "REFUNDED", null]) {
    assert.equal(resolveMonthEvidence({ ...base, issuedDraft: draft({ paymentStatus }) }).kind, "UNPAID", String(paymentStatus));
  }
});
