import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

// 2026-11-10 원장 결정 — k10·m7: 휴원은 언제든(오늘 수업 전이면 오늘부터) · m6: 승인 때 이월·환불·없음 + 자동 계산.
// 돈이 움직이는 기능이라 계산·판정·실행 순서를 «실제로 실행»해서 못박는다(월말·연말·자정 경계·4주 단위·부분 납부).

const nodeRequire = createRequire(import.meta.url);
const load = (path, mocks = {}) => {
  const absolute = resolve(path);
  const compiled = ts.transpileModule(readFileSync(absolute, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: absolute,
  }).outputText;
  const module = new Module(absolute);
  module.filename = absolute;
  module.paths = Module._nodeModulePaths(resolve("."));
  module.require = (name) => (name in mocks ? mocks[name] : nodeRequire(name));
  module._compile(compiled, absolute);
  return module.exports;
};

const rules = load("src/lib/enrollment/changeRequestRules.ts");
const plan = load("src/lib/enrollment/pause-settlement-plan.ts");
const partial = load("src/lib/payments/tossPartialCancel.ts");
const guard = load("src/lib/billing/parentSendGuard.ts");
// 결제 잠금·결제 진행 판정 = bundleLedger 와 같은 모양의 대역(키 형식은 실제 함수와 같다: stiz-payment-checkout:{id}, id 정렬순)
const bundleLedgerFake = {
  async lockPaymentsForCheckout(db, ids) {
    for (const id of [...new Set(ids)].sort()) await db.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, `stiz-payment-checkout:${id}`);
  },
  async findParentCheckoutActivePaymentIds(db, ids) {
    db.state.events.push("checkout-active");
    return new Set(ids.filter((id) => db.state.active.has(id)));
  },
};
const service = load("src/lib/enrollment/pause-settlement.ts", {
  "@/lib/billing/parentSendGuard": guard,
  "@/lib/enrollment/pause-settlement-plan": plan,
  "@/lib/payments/bundleLedger": bundleLedgerFake,
});

// ── 1) 휴원 시작일 규칙(KST 날짜·시각 문자열만) ─────────────────────────────
test("휴원 시작일: 오늘 그 반 수업 전이면 오늘, 이미 시작했으면 내일, 오늘 수업이 없으면 오늘", () => {
  // 2026-11-10 = 화요일(Tue)
  const tue = { today: "2026-11-10", classDayOfWeek: "Tue", classStartTime: "16:00" };
  assert.equal(rules.earliestPauseStart({ ...tue, nowHm: "15:59" }), "2026-11-10");
  assert.equal(rules.earliestPauseStart({ ...tue, nowHm: "16:00" }), "2026-11-11", "시작 시각 정각 = 이미 시작");
  assert.equal(rules.earliestPauseStart({ ...tue, nowHm: "18:30" }), "2026-11-11");
  // 자정 경계: KST 00:00 은 그날 수업 전
  assert.equal(rules.earliestPauseStart({ ...tue, nowHm: "00:00" }), "2026-11-10");
  assert.equal(rules.earliestPauseStart({ ...tue, nowHm: "23:59" }), "2026-11-11");
  // 다른 요일 반 = 오늘 빠지는 수업이 없다
  assert.equal(rules.earliestPauseStart({ today: "2026-11-10", nowHm: "20:00", classDayOfWeek: "Mon", classStartTime: "16:00" }), "2026-11-10");
  // 반 정보를 모르면 안전하게 내일
  assert.equal(rules.earliestPauseStart({ today: "2026-11-10", nowHm: "09:00", classDayOfWeek: null, classStartTime: null }), "2026-11-11");
  assert.equal(rules.earliestPauseStart({ today: "2026-11-10", nowHm: "", classDayOfWeek: "Tue", classStartTime: "16:00" }), "2026-11-11");
  // 월말·연말·윤년 다음 날
  assert.equal(rules.earliestPauseStart({ today: "2026-11-30", nowHm: "20:00", classDayOfWeek: "Mon", classStartTime: "16:00" }), "2026-12-01");
  assert.equal(rules.earliestPauseStart({ today: "2026-12-31", nowHm: "20:00", classDayOfWeek: "Thu", classStartTime: "16:00" }), "2027-01-01");
  assert.equal(rules.earliestPauseStart({ today: "2028-02-28", nowHm: "20:00", classDayOfWeek: "Mon", classStartTime: "16:00" }), "2028-02-29");
});

test("휴원 시작일 서버 판정: 가장 이른 날 이전·3개월 밖·형식 오류는 조용히 바꾸지 않고 거절", () => {
  const base = { kind: "PAUSE", today: "2026-11-10" };
  assert.equal(rules.resolveEffectiveFrom({ ...base, requestedFrom: "2026-11-10", earliestPauseFrom: "2026-11-10" }).effectiveFrom, "2026-11-10");
  assert.equal(rules.resolveEffectiveFrom({ ...base, requestedFrom: "2026-11-10", earliestPauseFrom: "2026-11-11" }).error, "PAUSE_START_TOO_SOON");
  assert.equal(rules.resolveEffectiveFrom({ ...base, requestedFrom: "2026-11-09", earliestPauseFrom: "2026-11-10" }).error, "PAUSE_START_TOO_SOON");
  // 최소값을 못 받으면 내일부터(오늘은 막는다)
  assert.equal(rules.resolveEffectiveFrom({ ...base, requestedFrom: "2026-11-10" }).error, "PAUSE_START_TOO_SOON");
  assert.equal(rules.resolveEffectiveFrom({ ...base, requestedFrom: "2027-02-10" }).effectiveFrom, "2027-02-10");
  assert.equal(rules.resolveEffectiveFrom({ ...base, requestedFrom: "2027-02-11" }).error, "EFFECTIVE_DATE_TOO_FAR");
  assert.equal(rules.resolveEffectiveFrom({ ...base, requestedFrom: "2026-11-31" }).error, "INVALID_EFFECTIVE_DATE");
  assert.ok(rules.CHANGE_REQUEST_MESSAGE.PAUSE_START_TOO_SOON.includes("내일"));
});

test("학부모 접수·화면: 반 요일·시작 시각은 DB 값으로 서버가 다시 판정하고, 화면은 그 반 최소값을 쓴다", () => {
  const lib = readFileSync("src/lib/enrollment/parent-change-request.ts", "utf8");
  assert.match(lib, /c\."dayOfWeek" AS "classDayOfWeek", c\."startTime" AS "classStartTime"/);
  assert.match(lib, /earliestPauseFrom: earliestPauseStart\(\{\s*today, nowHm: kstHm\(Date\.now\(\)\)/);
  assert.match(lib, /minPauseFrom: earliestPauseStart\(/);
  const ui = readFileSync("src/app/mypage/enrollment-change/EnrollmentChangeClient.tsx", "utf8");
  assert.match(ui, /id="pause-from"/);
  assert.match(ui, /min=\{minPauseFrom\}/);
  assert.match(ui, /kind === "PAUSE" \? pauseStart/);
  assert.match(ui, /earliestResumeOn\(pauseStart\)/, "복귀일 최소값은 고른 휴원 시작일 다음 날");
});

// ── 2) 금액 계산(순수) ─────────────────────────────────────────────────────
const pay = (over) => ({
  paymentId: "p1", year: 2026, month: 11, amount: 140000, status: "PAID", paidProvider: "MANUAL", method: "CASH",
  rallyzMirror: false, tossTx: null, busy: false, classDates: [], settledDates: [], priorReduction: 0, ...over,
});
// 화요일 반 11월 수강월 4회(4주 단위)
const NOV4 = ["2026-11-03", "2026-11-10", "2026-11-17", "2026-11-24"];

test("4주 단위: 청구 금액 ÷ 그 수강월 수업 수 × 빠지는 수업 수", () => {
  const p = plan.planPauseSettlement({ pauseFrom: "2026-11-17", resumeOn: null, payments: [pay({ classDates: NOV4 })] });
  assert.equal(p.lines.length, 1);
  assert.deepEqual(p.lines[0].missedDates, ["2026-11-17", "2026-11-24"]);
  assert.equal(p.lines[0].amount, 70000);
  assert.equal(p.paidTotal, 70000);
  assert.equal(p.unpaidTotal, 0);
  // 휴원 시작일 당일 수업도 빠진다(오늘 수업 전 휴원)
  assert.equal(plan.planPauseSettlement({ pauseFrom: "2026-11-10", resumeOn: null, payments: [pay({ classDates: NOV4 })] }).paidTotal, 105000);
  // 복귀일 당일 수업은 듣는다(빠지지 않는다)
  const back = plan.planPauseSettlement({ pauseFrom: "2026-11-10", resumeOn: "2026-11-24", payments: [pay({ classDates: NOV4 })] });
  assert.deepEqual(back.lines[0].missedDates, ["2026-11-10", "2026-11-17"]);
  assert.equal(back.paidTotal, 70000);
});

test("3회 달(청구 = 정가×3/4)·5회 달·반올림·전부 빠짐", () => {
  const three = ["2027-02-02", "2027-02-09", "2027-02-23"];
  // 3회 달 청구 105,000(=140,000×3/4) → 1회 = 35,000 = 정가÷4 (proration.ts 회당 단가와 같다)
  assert.equal(plan.planPauseSettlement({ pauseFrom: "2027-02-20", resumeOn: null, payments: [pay({ year: 2027, month: 2, amount: 105000, classDates: three })] }).paidTotal, 35000);
  // 전부 빠지면 1원 오차 없이 청구 금액 그대로
  assert.equal(plan.planPauseSettlement({ pauseFrom: "2027-02-01", resumeOn: null, payments: [pay({ year: 2027, month: 2, amount: 100000, classDates: three })] }).paidTotal, 100000);
  // 반올림은 청구 한 건마다 한 번: 100,000 × 1/3 = 33,333.3 → 33,333
  assert.equal(plan.pauseLineAmount(100000, 1, 3), 33333);
  assert.equal(plan.pauseLineAmount(100000, 2, 3), 66667);
  // 5회 달: 140,000 ÷ 5 = 28,000
  const five = ["2026-12-01", "2026-12-08", "2026-12-15", "2026-12-22", "2026-12-29"];
  assert.equal(plan.planPauseSettlement({ pauseFrom: "2026-12-29", resumeOn: null, payments: [pay({ year: 2026, month: 12, classDates: five })] }).paidTotal, 28000);
  assert.equal(plan.pauseLineAmount(0, 1, 4), 0);
  assert.equal(plan.pauseLineAmount(140000, 0, 4), 0);
  assert.equal(plan.pauseLineAmount(140000, 1, 0), 0);
});

test("월말·연말: 복귀일 미정이면 이미 낸 다음 달 청구까지 전부, 수강월이 달력 달을 넘어도 수업일 기준", () => {
  // 12월 수강월 수업이 1월 초까지 이어지는 일정(계획표가 정한 수강월 기준)
  const dec = ["2026-12-08", "2026-12-15", "2026-12-22", "2027-01-05"];
  const jan = ["2027-01-12", "2027-01-19", "2027-01-26", "2027-02-02"];
  const p = plan.planPauseSettlement({
    pauseFrom: "2026-12-31", resumeOn: null,
    payments: [pay({ paymentId: "dec", year: 2026, month: 12, classDates: dec }), pay({ paymentId: "jan", year: 2027, month: 1, classDates: jan })],
  });
  assert.deepEqual(p.lines.map((l) => [l.paymentId, l.amount]), [["dec", 35000], ["jan", 140000]]);
  assert.equal(p.carryAfterYm, "2027-01", "이월은 마지막으로 빠진 수강월 «뒤» 청구에서");
  // 휴원 시작 전 수강월 청구는 일정이 없어도 문제 삼지 않는다
  const prior = plan.planPauseSettlement({ pauseFrom: "2026-12-31", resumeOn: null, payments: [pay({ paymentId: "nov", year: 2026, month: 11, classDates: [] })] });
  assert.deepEqual(prior.problems, []);
  // 휴원이 닿는 수강월 일정이 없으면 계산하지 않는다(추측 금지)
  const missing = plan.planPauseSettlement({ pauseFrom: "2026-12-31", resumeOn: null, payments: [pay({ paymentId: "jan", year: 2027, month: 1, classDates: [] })] });
  assert.equal(missing.lines.length, 0);
  assert.match(missing.problems[0], /2027-01 수강월 수업일이 연간 일정에 없어/);
});

test("부분 납부·이미 처리된 날: 다른 휴원 처리가 뺀 날은 다시 빼지 않고, 줄인 미납 청구는 원래 금액으로 단가 계산", () => {
  // 같은 청구에서 11/17 은 이전 휴원 처리가 이미 뺐다 → 11/24 만
  const again = plan.planPauseSettlement({ pauseFrom: "2026-11-10", resumeOn: null, payments: [pay({ classDates: NOV4, settledDates: ["2026-11-10", "2026-11-17"] })] });
  assert.deepEqual(again.lines[0].missedDates, ["2026-11-24"]);
  assert.equal(again.paidTotal, 35000);
  // 미납 청구가 이미 35,000 줄어 105,000 남음 → 단가는 원래 140,000 기준(1회 35,000), 남은 금액보다 많이 빼지 않는다
  const unpaid = plan.planPauseSettlement({ pauseFrom: "2026-11-10", resumeOn: null, payments: [pay({ status: "PENDING", amount: 105000, priorReduction: 35000, classDates: NOV4, settledDates: ["2026-11-03"] })] });
  assert.equal(unpaid.lines[0].billAmount, 140000);
  assert.equal(unpaid.unpaidTotal, 105000);
  assert.equal(unpaid.lines[0].channel, "SITE");
  // 취소·환불된 청구는 빠질 돈이 없다
  assert.equal(plan.planPauseSettlement({ pauseFrom: "2026-11-10", resumeOn: null, payments: [pay({ status: "REFUNDED", classDates: NOV4 }), pay({ paymentId: "c", status: "CANCELED", classDates: NOV4 })] }).lines.length, 0);
});

test("결제 경로: 토스 온라인·무통장·POS·랠리즈·현금 구분, 결제 진행 중인 미납 청구는 실행을 막는다", () => {
  const ch = (over) => plan.paidChannel({ paidProvider: null, method: null, rallyzMirror: false, tossTx: null, ...over });
  assert.equal(ch({ paidProvider: "TOSS", tossTx: { transactionId: "t", method: "카드" } }), "TOSS");
  assert.equal(ch({ paidProvider: "TOSS", tossTx: { transactionId: "t", method: "가상계좌" } }), "TOSS_VA");
  assert.equal(ch({ paidProvider: "TOSS", tossTx: null }), "MANUAL", "거래 기록을 못 찾으면 자동으로 돈을 움직이지 않는다");
  assert.equal(ch({ paidProvider: "TOSS_POS" }), "TOSS_POS");
  assert.equal(ch({ rallyzMirror: true }), "RALLYZ");
  assert.equal(ch({ method: "RALLYZ" }), "RALLYZ");
  assert.equal(ch({ paidProvider: "MANUAL", method: "CASH" }), "MANUAL");
  assert.equal(ch({ paidProvider: "CAFE24_BRIDGE" }), "MANUAL");
  const busy = plan.planPauseSettlement({ pauseFrom: "2026-11-10", resumeOn: null, payments: [pay({ status: "PENDING", busy: true, classDates: NOV4 })] });
  assert.equal(busy.lines.length, 0);
  assert.match(busy.problems[0], /결제가 진행 중/);
  const rallyz = plan.planPauseSettlement({ pauseFrom: "2026-11-10", resumeOn: null, payments: [pay({ status: "OVERDUE", rallyzMirror: true, classDates: NOV4 })] });
  assert.equal(rallyz.lines[0].channel, "RALLYZ");
});

test("처리 방식별 기록 줄: 환불(토스=요청·그 밖=할 일) · 이월(적립) · 없음(기록만, 미납도 그대로)", () => {
  const p = plan.planPauseSettlement({
    pauseFrom: "2026-11-17", resumeOn: null,
    payments: [
      pay({ paymentId: "toss", paidProvider: "TOSS", tossTx: { transactionId: "t1", method: "카드" }, classDates: NOV4 }),
      pay({ paymentId: "cash", classDates: NOV4 }),
      pay({ paymentId: "unpaid", status: "PENDING", year: 2026, month: 12, classDates: ["2026-12-01", "2026-12-08", "2026-12-15", "2026-12-22"] }),
      pay({ paymentId: "rz", status: "PENDING", rallyzMirror: true, year: 2027, month: 1, classDates: ["2027-01-05", "2027-01-12", "2027-01-19", "2027-01-26"] }),
    ],
  });
  const kinds = (mode) => plan.settlementLineDrafts(p, mode).lines.map((l) => `${l.paymentId}:${l.kind}:${l.status}`);
  assert.deepEqual(kinds("REFUND"), ["cash:REFUND:TODO", "toss:REFUND:REQUESTED", "unpaid:UNPAID_REDUCE:DONE", "rz:UNPAID_REDUCE:TODO"]);
  assert.deepEqual(kinds("CARRY"), ["cash:CARRY_CREDIT:DONE", "toss:CARRY_CREDIT:DONE", "unpaid:UNPAID_REDUCE:DONE", "rz:UNPAID_REDUCE:TODO"]);
  assert.deepEqual(kinds("NONE"), ["cash:NONE:DONE", "toss:NONE:DONE", "unpaid:NONE:DONE", "rz:NONE:DONE"]);
  assert.equal(plan.settlementLineDrafts(p, "CARRY").carryTotal, 140000);
  assert.equal(plan.settlementLineDrafts(p, "REFUND").carryTotal, 0);
  // 학부모 알림 한 줄(«○원 이월/환불 예정»)
  assert.equal(plan.settlementNoticeLine("REFUND", 140000, 280000), "수강료 140,000원 환불 예정 · 미납 청구 280,000원 감액");
  assert.equal(plan.settlementNoticeLine("CARRY", 70000, 0), "수강료 70,000원 이월 예정(다음 청구에서 차감)");
  assert.equal(plan.settlementNoticeLine("NONE", 70000, 140000), null);
  assert.doesNotMatch(plan.settlementNoticeLine("REFUND", 1, 1), /[«»]/, "문자로도 나갈 수 있어 꺾쇠 따옴표 금지");
  // 사람 할 일 문장
  assert.match(plan.settlementTodoText({ kind: "REFUND", channel: "TOSS_POS", amount: 35000, status: "TODO" }), /POS 단말기에서 35,000원 부분 취소/);
  assert.match(plan.settlementTodoText({ kind: "REFUND", channel: "MANUAL", amount: 35000, status: "TODO" }), /직접 환불/);
  assert.match(plan.settlementTodoText({ kind: "UNPAID_REDUCE", channel: "RALLYZ", amount: 35000, status: "TODO" }), /랠리즈 청구에서 35,000원 감액/);
  assert.equal(plan.settlementTodoText({ kind: "REFUND", channel: "TOSS", amount: 1, status: "DONE" }), null);
  // 지문은 금액이 바뀌면 달라진다
  const changed = plan.planPauseSettlement({ pauseFrom: "2026-11-24", resumeOn: null, payments: [pay({ classDates: NOV4 })] });
  assert.notEqual(plan.planFingerprint("r", p), plan.planFingerprint("r", changed));
});

// ── 3) 토스 부분 취소 판정 ────────────────────────────────────────────────
test("토스 부분 취소: 남은 금액·주문·무통장 확인, 표식으로 재시도 시 두 번 취소하지 않음, 면세 몫", () => {
  const tx = { orderId: "o1", amount: 280000, method: "카드" };
  const v = { status: "DONE", orderId: "o1", paymentKey: "pk", totalAmount: 280000, balanceAmount: 280000, taxFreeAmount: 280000, method: "카드", cancels: null };
  assert.equal(partial.partialCancelBlock(v, tx, 70000), null);
  assert.match(partial.partialCancelBlock({ ...v, balanceAmount: 50000 }, tx, 70000), /남은 금액/);
  assert.match(partial.partialCancelBlock({ ...v, orderId: "x" }, tx, 70000), /장부와 달라/);
  assert.match(partial.partialCancelBlock({ ...v, totalAmount: 1 }, tx, 70000), /금액이 장부와 달라/);
  assert.match(partial.partialCancelBlock({ ...v, method: "가상계좌" }, tx, 70000), /환불 계좌/);
  assert.match(partial.partialCancelBlock({ ...v, status: "CANCELED", balanceAmount: 0 }, tx, 70000), /완료 상태가 아닌/);
  assert.equal(partial.partialCancelBlock({ ...v, status: "PARTIAL_CANCELED", balanceAmount: 210000 }, tx, 70000), null);
  assert.match(partial.partialCancelBlock(v, tx, 0), /금액이 올바르지/);
  assert.match(partial.partialCancelBlock(v, tx, 1.5), /금액이 올바르지/);
  assert.match(partial.partialCancelBlock(null, tx, 1), /확인하지 못했/);
  const marker = partial.partialCancelMarker("line-1");
  assert.equal(partial.findMarkedCancel(v, marker), null);
  const after = { ...v, status: "PARTIAL_CANCELED", balanceAmount: 210000, cancels: [{ cancelAmount: 70000, cancelReason: `휴원 수강료 환불 ${marker}`, taxFreeAmount: 70000, cancelStatus: "DONE" }] };
  assert.deepEqual(partial.findMarkedCancel(after, marker), { amount: 70000 });
  assert.equal(partial.findMarkedCancel(after, partial.partialCancelMarker("line-2")), null);
  assert.equal(partial.findMarkedCancel({ ...after, cancels: [{ ...after.cancels[0], cancelStatus: "IN_PROGRESS" }] }, marker), null);
  // 면세: 전액 면세 결제 → 취소액만큼, 앞선 취소가 면세를 써 버렸으면 남은 만큼만
  assert.equal(partial.partialCancelTaxFree(v, 70000), 70000);
  assert.equal(partial.partialCancelTaxFree({ ...v, taxFreeAmount: 100000, cancels: [{ taxFreeAmount: 70000 }] }, 70000), 30000);
  assert.equal(partial.partialCancelTaxFree({ ...v, taxFreeAmount: 0 }, 70000), 0);
});

test("토스 부분 취소 함수 계약: 재조회 → 감사 → cancelAmount+면세+고정 멱등 키 → 재조회 표식 확인, 장부(Payment)는 건드리지 않음", () => {
  const src = readFileSync("src/lib/payment-ledger.ts", "utf8");
  const body = src.slice(src.indexOf("export async function partialRefundTossPaymentByAdmin"), src.indexOf("/** 관리자 환불 취소 요청의 Idempotency-Key 시드"));
  assert.ok(body.length > 100);
  const order = ["getVerifiedTossPayment(", "findMarkedCancel(before", "partialCancelBlock(", "PAYMENT_TOSS_PARTIAL_CANCEL_REQUESTED", "cancelAmount: input.amount", "getVerifiedTossPayment(", "judgePartialCancelOutcome("];
  let at = 0;
  for (const mark of order) {
    const found = body.indexOf(mark, at);
    assert.ok(found >= 0, `${mark} 순서`);
    at = found + 1;
  }
  assert.match(body, /taxFreeAmount: partialCancelTaxFree\(before\.payment, input\.amount\)/);
  // 첫 시도·결과 모름 재확인 = 줄 id 고정 키, 확실한 실패 뒤 = 시도 번호를 섞은 키
  assert.match(body, /"Idempotency-Key": makeUuidFromSeed\(\s*\(input\.attempt \?\? 0\) > 0 \? `stiz-pause-refund:\$\{input\.lineId\}:\$\{input\.attempt\}` : `stiz-pause-refund:\$\{input\.lineId\}`/);
  assert.match(body, /input\.amount > share/, "그 청구 몫보다 많이 돌려주지 않는다");
  assert.doesNotMatch(body, /UPDATE "Payment"/);
});

// ── 4) 실행부(가짜 DB 로 실제 실행) ───────────────────────────────────────
function fakeDb({ payments, request, existing = false, active = [], priorLines = [] }) {
  const state = {
    locks: [], settlements: [], lines: [], paymentUpdates: [], invoiceUpdates: [], audits: [], opsAudits: [],
    payments: payments.map((p) => ({ ...p })), events: [], active: new Set(active),
  };
  const unpaid = (p) => ["PENDING", "OVERDUE"].includes(p.status);
  const db = {
    state,
    async $executeRawUnsafe(sql, ...v) {
      if (sql.includes("pg_advisory_xact_lock")) { state.locks.push(v[0] ?? "workbench"); state.events.push(`lock:${v[0] ?? "workbench"}`); return 1; }
      if (sql.includes('INSERT INTO "EnrollmentChangeSettlement"')) {
        state.settlements.push({ id: v[0], requestId: v[1], studentId: v[2], mode: v[3], paidAmount: v[4], unpaidAmount: v[5], carryRemaining: v[6], carryAfterYm: v[7], previewKey: v[8] });
        return 1;
      }
      if (sql.includes('INSERT INTO "EnrollmentChangeSettlementLine"')) {
        if (sql.includes("'CARRY_APPLY'")) state.lines.push({ id: v[0], settlementId: v[1], paymentId: v[2], kind: "CARRY_APPLY", amount: v[3], status: "DONE" });
        else state.lines.push({ id: v[0], settlementId: v[1], paymentId: v[2], kind: v[3], channel: v[4], amount: v[5], status: v[6], transactionId: v[8], failedAttempts: 0, createdAt: "2026-11-10T01:00:00.000Z" });
        return 1;
      }
      if (sql.includes('UPDATE "Payment" SET amount')) {
        const p = state.payments.find((x) => x.id === v[0]);
        if (!p || !["PENDING", "OVERDUE"].includes(p.status) || p.amount !== v[2]) return 0;
        p.amount = v[1];
        if (v[1] === 0) p.status = "CANCELED";
        state.paymentUpdates.push({ id: v[0], to: v[1], from: v[2] });
        return 1;
      }
      if (sql.includes('UPDATE "PaymentInvoice"')) { state.invoiceUpdates.push({ id: v[0], to: v[1] }); return 1; }
      if (sql.includes('INSERT INTO "PaymentAuditLog"')) { state.audits.push({ paymentId: v[0], action: v[2] }); return 1; }
      if (sql.includes('INSERT INTO "OperationsAuditLog"')) { state.opsAudits.push(JSON.parse(v[2])); return 1; }
      if (sql.includes('UPDATE "EnrollmentChangeSettlement" s')) return 1; // 상태 갱신
      if (sql.includes('UPDATE "EnrollmentChangeSettlement" SET "carryRemaining"')) {
        const s = state.settlements.find((x) => x.id === v[0]);
        if (s.carryRemaining !== v[2]) return 0;
        s.carryRemaining = v[1];
        return 1;
      }
      if (sql.includes('UPDATE "EnrollmentChangeSettlementLine"')) {
        const line = state.lines.find((x) => x.id === v[0]);
        if (!line || !["REQUESTED", "FAILED"].includes(line.status)) return 0;
        if (sql.includes("SET status = 'DONE'") || sql.includes("SET status = 'FAILED'")) {
          line.status = sql.includes("SET status = 'DONE'") ? "DONE" : "FAILED";
          line.message = v[1];
        } else {
          line.status = v[1];
          line.message = v[2];
          line.failedAttempts += v[3];
        }
        return 1;
      }
      throw new Error(`예상 못한 쓰기: ${sql.slice(0, 80)}`);
    },
    async $queryRawUnsafe(sql, ...v) {
      if (sql.includes("to_regclass")) return [{ a: "x", b: "y" }];
      if (sql.includes(`SELECT DISTINCT "studentId"`)) return [...new Set(state.settlements.filter((s) => s.carryRemaining > 0).map((s) => s.studentId))].sort().map((studentId) => ({ studentId }));
      if (sql.includes('FROM "EnrollmentChangeRequest" r')) return request ? [request] : [];
      if (sql.includes('SELECT id FROM "EnrollmentChangeSettlement" WHERE "requestId"')) return existing || state.settlements.length ? [{ id: "s0" }] : [];
      // 잠금 없이 읽는 후보 id(휴원 범위 / 이월 차감 범위)
      if (sql.startsWith('SELECT p.id FROM "Payment" p WHERE')) {
        state.events.push("candidates");
        assert.doesNotMatch(sql, /FOR UPDATE/);
        if (sql.includes("p.amount > 0")) return state.payments.filter((p) => unpaid(p) && p.amount > 0 && p.year * 100 + p.month > v[1] && !p.rallyzMirror).map((p) => ({ id: p.id }));
        return state.payments.filter((p) => p.year * 100 + p.month >= v[2]).map((p) => ({ id: p.id }));
      }
      if (sql.includes('FROM "Payment" p') && sql.includes("LEFT JOIN LATERAL")) {
        if (sql.includes("FOR UPDATE OF p")) {
          state.events.push("rows-for-update"); if (state.afterRowLock) state.afterRowLock(state);
          assert.match(sql, /p\.id = ANY\(\$4::text\[\]\)/, "잠근 id 만 행 잠금");
        }
        return state.payments.filter((p) => p.year * 100 + p.month >= v[2] && (!v[3] || v[3].includes(p.id)))
          .map((p) => ({ ...p, posBusy: Boolean(p.busy) }));
      }
      if (sql.includes('FROM "EnrollmentChangeSettlementLine" l') && sql.includes("JOIN")) return priorLines;
      if (sql.includes("kind = 'REFUND' AND channel = 'TOSS'")) {
        return state.lines.filter((l) => l.settlementId === v[0] && l.kind === "REFUND" && l.channel === "TOSS" && ["REQUESTED", "FAILED"].includes(l.status));
      }
      if (sql.includes('FROM "EnrollmentChangeSettlement"') && sql.includes('"carryRemaining" > 0') && sql.includes("FOR UPDATE")) {
        return state.settlements.filter((s) => s.carryRemaining > 0);
      }
      if (sql.includes('SELECT p.id, p.amount, p.year, p.month FROM "Payment" p')) {
        state.events.push("carry-rows-for-update");
        assert.match(sql, /FOR UPDATE OF p/);
        return state.payments.filter((p) => unpaid(p) && p.amount > 0 && p.year * 100 + p.month > v[1] && !p.rallyzMirror && v[3].includes(p.id));
      }
      throw new Error(`예상 못한 읽기: ${sql.slice(0, 80)}`);
    },
    async $transaction(fn) { return fn(db); },
  };
  return db;
}

const REQ = { id: "req-1", kind: "PAUSE", status: "APPROVED", studentId: "stu-1", fromClassId: "cls-1", pauseFrom: "2026-11-17", resumeOn: null, dayOfWeek: "Tue" };
const DEC4 = ["2026-12-01", "2026-12-08", "2026-12-15", "2026-12-22"];
const classDatesFor = (ym) => (ym === "2026-11" ? NOV4 : ym === "2026-12" ? DEC4 : ym === "2027-01" ? ["2027-01-05", "2027-01-12", "2027-01-19", "2027-01-26"] : []);
const ROWS = () => [
  { id: "nov", year: 2026, month: 11, amount: 140000, status: "PAID", paidProvider: "TOSS", method: "카드", rallyzMirror: false, tossTxId: "tx-nov", tossTxMethod: "카드", busy: false },
  { id: "dec", year: 2026, month: 12, amount: 140000, status: "PENDING", paidProvider: null, method: null, rallyzMirror: false, tossTxId: null, tossTxMethod: null, busy: false },
];

async function previewKey(db) {
  const preview = await service.previewPauseSettlement(db, "req-1", classDatesFor);
  return preview.previewKey;
}

test("실행: 잠금 → 재계산 지문 대조 → 기록 + 미납 감액(조건부) → 토스 환불은 커밋 뒤 작업으로", async () => {
  const db = fakeDb({ payments: ROWS(), request: REQ });
  const key = await previewKey(db);
  const result = await service.executePauseSettlementInTx(db, { requestId: "req-1", adminUserId: "admin", mode: "REFUND", expectedPreviewKey: key, classDatesFor });
  assert.equal(result.ok, true);
  assert.deepEqual(db.state.locks, ["workbench", "pause-settlement:req-1", "stiz-payment-checkout:dec", "stiz-payment-checkout:nov"]);
  assert.equal(result.paidTotal, 70000);
  assert.equal(result.unpaidTotal, 140000);
  assert.deepEqual(result.refundJobs.map((j) => [j.paymentId, j.transactionId, j.amount]), [["nov", "tx-nov", 70000]]);
  // 12월 미납 청구 전부 휴원 → 0원 = 취소
  assert.deepEqual(db.state.paymentUpdates, [{ id: "dec", to: 0, from: 140000 }]);
  assert.equal(db.state.payments.find((p) => p.id === "dec").status, "CANCELED");
  assert.equal(db.state.payments.find((p) => p.id === "nov").status, "PAID", "납부완료는 건드리지 않는다");
  assert.deepEqual(db.state.lines.map((l) => `${l.paymentId}:${l.kind}:${l.status}`), ["nov:REFUND:REQUESTED", "dec:UNPAID_REDUCE:DONE"]);
  assert.equal(db.state.settlements[0].mode, "REFUND");
  assert.equal(result.noticeLine, "수강료 70,000원 환불 예정 · 미납 청구 140,000원 감액");
  assert.equal(db.state.opsAudits[0].requestId, "req-1");
});

test("실행 거절: 미리보기 뒤 금액이 바뀜 · 이미 처리 · 방식 없음 · 승인 전 · 휴원 아님", async () => {
  const db = fakeDb({ payments: ROWS(), request: REQ });
  const key = await previewKey(db);
  db.state.payments[0].amount = 150000; // 미리보기 뒤 청구 금액이 바뀌었다
  const changed = await service.executePauseSettlementInTx(db, { requestId: "req-1", adminUserId: "a", mode: "REFUND", expectedPreviewKey: key, classDatesFor });
  assert.equal(changed.ok, false);
  assert.match(changed.message, /바뀌었어요/);
  assert.equal(db.state.settlements.length, 0);

  const dup = fakeDb({ payments: ROWS(), request: REQ, existing: true });
  assert.match((await service.executePauseSettlementInTx(dup, { requestId: "req-1", adminUserId: "a", mode: "REFUND", expectedPreviewKey: await previewKey(dup), classDatesFor })).message, /이미/);
  assert.match((await service.executePauseSettlementInTx(fakeDb({ payments: ROWS(), request: REQ }), { requestId: "req-1", adminUserId: "a", mode: "BOTH", expectedPreviewKey: key, classDatesFor })).message, /골라/);
  assert.match((await service.executePauseSettlementInTx(fakeDb({ payments: ROWS(), request: { ...REQ, status: "PENDING" } }), { requestId: "req-1", adminUserId: "a", mode: "NONE", expectedPreviewKey: key, classDatesFor })).message, /승인된 휴원만/);
  assert.match((await service.executePauseSettlementInTx(fakeDb({ payments: ROWS(), request: { ...REQ, kind: "WITHDRAW" } }), { requestId: "req-1", adminUserId: "a", mode: "NONE", expectedPreviewKey: key, classDatesFor })).message, /휴원 신청만/);
});

test("미납 감액 중 다른 곳에서 청구가 바뀌면(조건부 UPDATE 0행) 오류로 트랜잭션 전체를 되돌린다", async () => {
  const db = fakeDb({ payments: ROWS(), request: REQ });
  const key = await previewKey(db);
  const original = db.$executeRawUnsafe;
  db.$executeRawUnsafe = async (sql, ...v) => (sql.includes('UPDATE "Payment" SET amount') ? 0 : original(sql, ...v));
  await assert.rejects(
    service.executePauseSettlementInTx(db, { requestId: "req-1", adminUserId: "a", mode: "CARRY", expectedPreviewKey: key, classDatesFor }),
    /PAUSE_SETTLEMENT_PAYMENT_CONFLICT/,
  );
});

test("토스 환불 실행: 성공=DONE · 확실한 실패=FAILED · 결과 모름=REQUESTED(다시 시도는 같은 줄로)", async () => {
  for (const [answer, expected] of [
    [{ ok: true, alreadyApplied: false }, "DONE"],
    [{ ok: false, message: "토스가 취소하지 않았어요", uncertain: false }, "FAILED"],
    [{ ok: false, message: "확인 못 함", uncertain: true }, "REQUESTED"],
  ]) {
    const db = fakeDb({ payments: ROWS(), request: REQ });
    const done = await service.executePauseSettlementInTx(db, { requestId: "req-1", adminUserId: "a", mode: "REFUND", expectedPreviewKey: await previewKey(db), classDatesFor });
    const calls = [];
    const summary = await service.runSettlementTossRefunds(db, {
      settlementId: done.settlementId, adminUserId: "a",
      refundToss: async (input) => { calls.push(input); return answer; },
    });
    assert.equal(calls.length, 1);
    assert.deepEqual({ tx: calls[0].transactionId, pay: calls[0].paymentId, amount: calls[0].amount, line: calls[0].lineId }, { tx: "tx-nov", pay: "nov", amount: 70000, line: done.refundJobs[0].lineId });
    assert.equal(db.state.lines.find((l) => l.kind === "REFUND").status, expected);
    assert.equal(summary.done + summary.failed + summary.uncertain, 1);
  }
  // 토스 함수가 던져도 결과 모름(REQUESTED)으로 남기고 멈추지 않는다
  const db = fakeDb({ payments: ROWS(), request: REQ });
  const done = await service.executePauseSettlementInTx(db, { requestId: "req-1", adminUserId: "a", mode: "REFUND", expectedPreviewKey: await previewKey(db), classDatesFor });
  const summary = await service.runSettlementTossRefunds(db, { settlementId: done.settlementId, adminUserId: "a", refundToss: async () => { throw new Error("network"); } });
  assert.equal(summary.uncertain, 1);
  assert.equal(db.state.lines.find((l) => l.kind === "REFUND").status, "REQUESTED");
});

test("이월: 적립 뒤 휴원 수강월 «뒤»의 미납 청구에서 차감, 모자라면 남은 이월은 다음 청구로", async () => {
  const rows = [
    { id: "nov", year: 2026, month: 11, amount: 140000, status: "PAID", paidProvider: "MANUAL", method: "CASH", rallyzMirror: false, tossTxId: null, tossTxMethod: null, busy: false },
    { id: "dec", year: 2026, month: 12, amount: 140000, status: "PAID", paidProvider: "MANUAL", method: "CASH", rallyzMirror: false, tossTxId: null, tossTxMethod: null, busy: false },
    // 복귀 후 첫 청구(1월) 50,000 — 이월 210,000 중 50,000 만 차감되고 160,000 이 남는다
    { id: "jan", year: 2027, month: 1, amount: 50000, status: "PENDING", paidProvider: null, method: null, rallyzMirror: false, tossTxId: null, tossTxMethod: null, busy: false },
  ];
  const db = fakeDb({ payments: rows, request: { ...REQ, resumeOn: "2027-01-01" } });
  const key = (await service.previewPauseSettlement(db, "req-1", classDatesFor)).previewKey;
  const done = await service.executePauseSettlementInTx(db, { requestId: "req-1", adminUserId: "a", mode: "CARRY", expectedPreviewKey: key, classDatesFor });
  assert.equal(done.ok, true);
  assert.equal(done.paidTotal, 70000 + 140000);
  assert.equal(db.state.settlements[0].carryRemaining, 210000);
  assert.equal(db.state.settlements[0].carryAfterYm, "2026-12");
  const applied = await service.applyOpenPauseCarries(db, { studentId: "stu-1" });
  assert.deepEqual(applied, { applied: 1, amount: 50000 });
  assert.equal(db.state.payments.find((p) => p.id === "jan").status, "CANCELED", "전액 차감된 청구는 0원 미납으로 남기지 않는다");
  assert.equal(db.state.settlements[0].carryRemaining, 160000);
  assert.ok(db.state.lines.some((l) => l.kind === "CARRY_APPLY" && l.paymentId === "jan" && l.amount === 50000));
  // 다시 돌려도(크론) 더 뺄 청구가 없으면 그대로
  assert.deepEqual(await service.applyOpenPauseCarries(db, { studentId: "stu-1" }), { applied: 0, amount: 0 });
});

// ── 5) 연결 계약(승인·알림·취소 요청·화면) ─────────────────────────────────
test("승인과 수강료 처리는 한 트랜잭션, 실패하면 승인도 되돌리고, 토스·이월은 커밋 뒤·알림 앞", () => {
  const src = readFileSync("src/lib/enrollment/admin-change-request.ts", "utf8");
  const decide = src.slice(src.indexOf("export async function decideEnrollmentChangeRequest"), src.indexOf("export type DueEnrollmentChangeSummary"));
  assert.match(decide, /executePauseSettlementInTx\(tx as any/);
  assert.match(decide, /if \(!result\.ok\) throw new SettlementRejected/);
  const txEnd = decide.indexOf("  if (!rows[0]) return");
  const finish = decide.indexOf("finishSettlement(holder.settled");
  const notify = decide.indexOf('notifyParentOfEnrollmentChange(input.requestId, input.approve ? "APPROVED" : "REJECTED")');
  assert.ok(txEnd > 0 && finish > txEnd && notify > finish, "트랜잭션 → 토스·이월 → 알림 순서");
  // 신청함 등 settlement 없이 부르는 예전 호출도 그대로 동작(선택 칸)
  assert.match(decide, /settlement\?: PauseSettlementChoice \| null/);
  // 취소 요청(d8) 승인은 돈이 움직인 휴원이면 막는다
  const cancel = src.slice(src.indexOf("export async function decideEnrollmentCancelRequest"));
  assert.match(cancel, /FOR UPDATE`, input\.requestId\);\s*if \(await hasMovedMoneySettlement\(tx as any, input\.requestId\)\)/, "신청 행 잠금 뒤 트랜잭션 안에서 확인");
  // 알림 문구는 처리 기록에서 읽고, 따로 정한 처리면 SETTLED 한 번
  const notifySrc = readFileSync("src/lib/enrollment/change-decision-notify.ts", "utf8");
  assert.match(notifySrc, /event === "APPROVED" \|\| event === "SETTLED"/);
  assert.match(notifySrc, /to_regclass\('public\."EnrollmentChangeSettlement"'\)/);
  assert.match(src, /notifyParentOfEnrollmentChange\(input\.requestId, "SETTLED"\)/);
  // 매일 크론이 남은 이월을 다음 청구에서 뺀다
  assert.match(readFileSync("src/app/api/cron/enrollment-changes/route.ts", "utf8"), /applyOpenPauseCarries\(prisma as any\)/);
});

test("학부모 알림 문구: 승인에 «○원 환불/이월 예정» 한 줄, 처리 안내(SETTLED)", () => {
  const status = load("src/lib/enrollment/parentChangeStatus.ts");
  const approved = status.buildChangeDecisionNotice({ event: "APPROVED", studentName: "김루빈", className: "화 4교시", kind: "PAUSE", effectiveFrom: "2026-11-17", settlementLine: "수강료 70,000원 환불 예정" });
  assert.equal(approved.message, "김루빈 화 4교시 휴원 신청이 승인됐어요(11/17부터) · 수강료 70,000원 환불 예정");
  const plain = status.buildChangeDecisionNotice({ event: "APPROVED", studentName: "김루빈", className: null, kind: "PAUSE", effectiveFrom: "2026-11-17" });
  assert.equal(plain.message, "김루빈 휴원 신청이 승인됐어요(11/17부터)");
  const settled = status.buildChangeDecisionNotice({ event: "SETTLED", studentName: "김루빈", className: null, kind: "PAUSE", effectiveFrom: "2026-11-17", settlementLine: "수강료 70,000원 이월 예정(다음 청구에서 차감)" });
  assert.equal(settled.message, "김루빈 휴원(11/17부터) 수강료 70,000원 이월 예정(다음 청구에서 차감)");
});

test("마이그레이션: 신청당 1행·줄 유일·청구 삭제를 막지 않음·RLS·공개 키 차단", () => {
  const sql = readFileSync("prisma/migrations/20261110180000_enrollment_pause_settlement/migration.sql", "utf8");
  assert.match(sql, /CONSTRAINT "EnrollmentChangeSettlement_requestId_key" UNIQUE \("requestId"\)/);
  assert.match(sql, /UNIQUE \("settlementId", "paymentId", kind\)/);
  assert.match(sql, /"paymentId" TEXT REFERENCES "Payment"\(id\) ON DELETE SET NULL/);
  assert.match(sql, /CHECK \(mode IN \('CARRY', 'REFUND', 'NONE'\)\)/);
  assert.match(sql, /"carryRemaining" <= "paidAmount"/);
  assert.equal((sql.match(/ENABLE ROW LEVEL SECURITY/g) ?? []).length, 2);
  assert.match(sql, /REVOKE ALL ON "EnrollmentChangeSettlement", "EnrollmentChangeSettlementLine" FROM PUBLIC/);
  // 코드가 쓰는 종류·경로·상태 값 = 제약 값(같은 규칙의 두 곳을 같은 커밋에서)
  for (const value of ["REFUND", "CARRY_CREDIT", "UNPAID_REDUCE", "NONE", "CARRY_APPLY", "CARRY_MANUAL", "TOSS_VA", "TOSS_POS", "RALLYZ", "SITE", "DONE_MANUAL", "REQUESTED"]) {
    assert.ok(sql.includes(`'${value}'`), value);
  }
});

test("관리자 화면: 방식 고르기 → 확인창(금액·토스 즉시 취소 안내) → 서버 액션에 { mode, expectedPreviewKey }", () => {
  const ui = readFileSync("src/app/admin/enrollment-changes/EnrollmentChangesClient.tsx", "utf8");
  assert.match(ui, /role="radiogroup" aria-label="휴원 수강료 처리 방식"/);
  assert.match(ui, /토스 온라인 결제분은 확인을 누르면 바로 부분 취소됩니다/);
  assert.match(ui, /window\.confirm\(`\$\{settlementConfirmText\(row, mode\)\}\\n\\n승인할까요\?`\)/);
  assert.match(ui, /\{ mode, expectedPreviewKey: row\.settlementPreview!\.previewKey \}/);
  assert.match(ui, /needsSettlementChoice\(row\) && \(!modes\[row\.id\] \|\| !row\.settlementPreview\?\.ready\)/, "방식을 안 고르면 승인 버튼이 잠긴다");
  const actions = readFileSync("src/app/actions/enrollment-changes.ts", "utf8");
  for (const name of ["settlePauseTuition", "retryPauseTuitionRefund", "markPauseTuitionLineDone", "markPauseCarryHandled"]) {
    assert.match(actions, new RegExp(`export async function ${name}[\\s\\S]{0,200}await requireAdmin\\(\\)`), name);
  }
});

// ── 6) 검수 수정(11-10): 결제 경합·이월 보호·재시도 안전 ────────────────────────
test("[필수1] 잠금 순서: 전역 → 신청 → 결제 잠금(id 정렬) → 청구 행 FOR UPDATE → 결제 진행 판정 → 감액", async () => {
  const db = fakeDb({ payments: ROWS(), request: REQ });
  const key = await previewKey(db);
  db.state.events.length = 0;
  const done = await service.executePauseSettlementInTx(db, { requestId: "req-1", adminUserId: "a", mode: "REFUND", expectedPreviewKey: key, classDatesFor });
  assert.equal(done.ok, true);
  const ev = db.state.events;
  const at = (name) => ev.indexOf(name);
  assert.deepEqual(ev.slice(0, 2), ["lock:workbench", "lock:pause-settlement:req-1"]);
  assert.ok(at("candidates") > 1, "후보 id 는 잠금 없이 먼저 읽는다");
  assert.ok(at("lock:stiz-payment-checkout:dec") > at("candidates"));
  assert.ok(at("lock:stiz-payment-checkout:nov") > at("lock:stiz-payment-checkout:dec"), "결제 잠금은 id 정렬순(교착 방지)");
  assert.ok(at("rows-for-update") > at("lock:stiz-payment-checkout:nov"), "결제 잠금 뒤에 청구 행 잠금");
  assert.ok(at("checkout-active") > at("rows-for-update"), "행 잠금 뒤 결제 진행 판정");
});

test("[필수1] 경합: 학부모 결제(결제창·입금 대기)가 진행 중인 미납 청구는 감액하지 않고 실행을 막는다", async () => {
  // 미리보기 땐 결제 전 → 실행 직전 학부모가 결제를 시작(결제 잠금 뒤 판정에서 잡힌다)
  const db = fakeDb({ payments: ROWS(), request: REQ });
  const key = await previewKey(db);
  db.state.active.add("dec");
  const result = await service.executePauseSettlementInTx(db, { requestId: "req-1", adminUserId: "a", mode: "REFUND", expectedPreviewKey: key, classDatesFor });
  assert.equal(result.ok, false);
  assert.equal(db.state.paymentUpdates.length, 0, "옛 금액 결제와 엇갈리는 감액 없음");
  assert.equal(db.state.settlements.length, 0);
  // 미리보기에서도 같은 판정으로 문제로 보인다
  const preview = await service.previewPauseSettlement(fakeDb({ payments: ROWS(), request: REQ, active: ["dec"] }), "req-1", classDatesFor);
  assert.match(preview.plan.problems[0], /결제가 진행 중/);
  assert.equal(preview.ready, false);
});

test("[필수1] 이월 차감도 같은 잠금 순서, 결제 진행 중인 청구는 건너뛰고 다음 청구에서 뺀다", async () => {
  const rows = [
    { id: "nov", year: 2026, month: 11, amount: 140000, status: "PAID", paidProvider: "MANUAL", method: "CASH", rallyzMirror: false, tossTxId: null, tossTxMethod: null, busy: false },
    { id: "jan", year: 2027, month: 1, amount: 140000, status: "PENDING", paidProvider: null, method: null, rallyzMirror: false, tossTxId: null, tossTxMethod: null, busy: false },
    { id: "feb", year: 2027, month: 2, amount: 140000, status: "PENDING", paidProvider: null, method: null, rallyzMirror: false, tossTxId: null, tossTxMethod: null, busy: false },
  ];
  const db = fakeDb({ payments: rows, request: { ...REQ, resumeOn: "2026-12-01" } });
  const key = (await service.previewPauseSettlement(db, "req-1", classDatesFor)).previewKey;
  assert.equal((await service.executePauseSettlementInTx(db, { requestId: "req-1", adminUserId: "a", mode: "CARRY", expectedPreviewKey: key, classDatesFor })).ok, true);
  db.state.active.add("jan"); // 1월 청구는 학부모가 결제 중
  db.state.events.length = 0;
  const applied = await service.applyOpenPauseCarries(db, { studentId: "stu-1" });
  assert.deepEqual(applied, { applied: 1, amount: 70000 });
  assert.equal(db.state.payments.find((p) => p.id === "jan").amount, 140000, "결제 중 청구는 그대로");
  assert.equal(db.state.payments.find((p) => p.id === "feb").amount, 70000);
  const ev = db.state.events;
  assert.ok(ev.indexOf("lock:workbench") < ev.indexOf("candidates"));
  assert.ok(ev.indexOf("candidates") < ev.indexOf("lock:stiz-payment-checkout:feb"));
  assert.ok(ev.indexOf("lock:stiz-payment-checkout:feb") < ev.indexOf("carry-rows-for-update"));
  assert.ok(ev.indexOf("carry-rows-for-update") < ev.indexOf("checkout-active"));
});

test("[필수2] 이월이 차감된 청구를 새 휴원이 남은 금액보다 더 빼야 하면 실행을 막고 직접 확인 안내", () => {
  // 원래 140,000 → 이월 105,000 차감돼 35,000 남음. 새 휴원이 2회(70,000)를 빼려 함 → 이월이 사라질 수 있어 막는다
  const blocked = plan.planPauseSettlement({
    pauseFrom: "2026-11-17", resumeOn: null,
    payments: [pay({ status: "PENDING", amount: 35000, priorReduction: 105000, carryApplied: 105000, classDates: NOV4 })],
  });
  assert.equal(blocked.lines.length, 0);
  assert.match(blocked.problems[0], /이월이 차감된 달.*직접 확인/);
  // 이월 차감이 없는 감액(휴원 감액)만 있으면 남은 금액까지만 뺀다(기존 동작)
  const capped = plan.planPauseSettlement({
    pauseFrom: "2026-11-17", resumeOn: null,
    payments: [pay({ status: "PENDING", amount: 35000, priorReduction: 105000, carryApplied: 0, classDates: NOV4 })],
  });
  assert.equal(capped.unpaidTotal, 35000);
  // 이월 차감이 있어도 남은 금액 안이면 그대로 진행
  const fits = plan.planPauseSettlement({
    pauseFrom: "2026-11-24", resumeOn: null,
    payments: [pay({ status: "PENDING", amount: 105000, priorReduction: 35000, carryApplied: 35000, classDates: NOV4 })],
  });
  assert.equal(fits.unpaidTotal, 35000);
  assert.deepEqual(fits.problems, []);
});

test("[권장3] 줄인 뒤 납부한 청구도 원래 금액 기준 단가 · [권장9] 복귀 수강월 뒤 청구는 일정 없어도 건너뜀", () => {
  // 이월 35,000 차감 뒤 105,000 납부 → 1회 단가는 원래 140,000 ÷ 4 = 35,000
  const paid = plan.planPauseSettlement({ pauseFrom: "2026-11-24", resumeOn: null, payments: [pay({ amount: 105000, priorReduction: 35000, carryApplied: 35000, classDates: NOV4 })] });
  assert.equal(paid.lines[0].billAmount, 140000);
  assert.equal(paid.paidTotal, 35000);
  const afterResume = plan.planPauseSettlement({
    pauseFrom: "2026-11-17", resumeOn: "2026-12-01",
    payments: [pay({ classDates: NOV4 }), pay({ paymentId: "feb", year: 2027, month: 2, classDates: [] })],
  });
  assert.deepEqual(afterResume.problems, []);
  assert.equal(afterResume.paidTotal, 70000);
  // 복귀 수강월(12월) 자체는 여전히 일정이 필요하다
  const resumeMonth = plan.planPauseSettlement({ pauseFrom: "2026-11-17", resumeOn: "2026-12-15", payments: [pay({ paymentId: "dec", year: 2026, month: 12, classDates: [] })] });
  assert.equal(resumeMonth.problems.length, 1);
});

test("[권장8] 취소된 휴원 처리의 «뺀 날»은 제외, 실제로 줄인 금액은 원래 금액 계산에 포함", async () => {
  const rows = [{ id: "dec", year: 2026, month: 12, amount: 105000, status: "PENDING", paidProvider: null, method: null, rallyzMirror: false, tossTxId: null, tossTxMethod: null, busy: false }];
  const prior = [{ paymentId: "dec", kind: "UNPAID_REDUCE", amount: 35000, missedDates: ["2026-12-01"], requestCanceled: true }];
  const preview = await service.previewPauseSettlement(fakeDb({ payments: rows, request: { ...REQ, pauseFrom: "2026-12-01" }, priorLines: prior }), "req-1", classDatesFor);
  // 12/1 도 다시 빠지는 날로 센다(취소된 처리) · 단가 = (105,000 + 35,000) ÷ 4 → 4회 = 140,000 이지만 남은 105,000 까지만
  assert.deepEqual(preview.plan.lines[0].missedDates, DEC4);
  assert.equal(preview.plan.lines[0].billAmount, 140000);
  assert.equal(preview.plan.unpaidTotal, 105000);
  const live = await service.previewPauseSettlement(fakeDb({ payments: rows, request: { ...REQ, pauseFrom: "2026-12-01" }, priorLines: [{ ...prior[0], requestCanceled: false }] }), "req-1", classDatesFor);
  assert.deepEqual(live.plan.lines[0].missedDates, DEC4.slice(1));
});

test("[권장10] 기능 시작 전 승인된 휴원은 서버에서도 처리하지 않는다", async () => {
  const db = fakeDb({ payments: ROWS(), request: { ...REQ, decidedOn: "2026-11-09" } });
  const key = await previewKey(db);
  const old = await service.executePauseSettlementInTx(db, { requestId: "req-1", adminUserId: "a", mode: "NONE", expectedPreviewKey: key, classDatesFor, decidedSince: "2026-11-10" });
  assert.match(old.message, /기능 전에 승인된/);
  const fresh = fakeDb({ payments: ROWS(), request: { ...REQ, decidedOn: "2026-11-10" } });
  assert.equal((await service.executePauseSettlementInTx(fresh, { requestId: "req-1", adminUserId: "a", mode: "NONE", expectedPreviewKey: await previewKey(fresh), classDatesFor, decidedSince: "2026-11-10" })).ok, true);
  const src = readFileSync("src/lib/enrollment/admin-change-request.ts", "utf8");
  const settle = src.slice(src.indexOf("export async function settleApprovedPause"));
  assert.match(settle, /decidedSince: PAUSE_SETTLEMENT_SINCE/);
});

test("[권장4·5·6] 전액 면세 · 표식 없는 같은 금액 취소 감지 · 실패 뒤 새 멱등 키 · 웹훅 경보 생략", async () => {
  const v = { status: "PARTIAL_CANCELED", orderId: "o1", paymentKey: "pk", totalAmount: 280000, balanceAmount: 210000, taxFreeAmount: 280000, cancels: [{ cancelAmount: 70000, taxFreeAmount: 70000, cancelReason: "x" }] };
  // 전액 면세 결제는 앞선 취소와 무관하게 취소액 전부가 면세
  assert.equal(partial.partialCancelTaxFree(v, 70000), 70000);
  // 이 줄을 만든 뒤 표식 없는 같은 금액 취소 → 멈춤 / 전 시각·다른 금액·우리 표식은 무시 / 시각 못 읽으면 멈춤(안전)
  const at = (iso, extra = {}) => ({ ...v, cancels: [{ cancelAmount: 70000, cancelReason: "고객 요청", canceledAt: iso, ...extra }] });
  assert.equal(partial.hasUnmarkedSameAmountCancel(at("2026-11-10T15:00:00+09:00"), 70000, "2026-11-10T01:00:00.000Z"), true);
  assert.equal(partial.hasUnmarkedSameAmountCancel(at("2026-11-09T05:00:00+09:00"), 70000, "2026-11-10T01:00:00.000Z"), false);
  assert.equal(partial.hasUnmarkedSameAmountCancel(at("2026-11-10T15:00:00+09:00"), 35000, "2026-11-10T01:00:00.000Z"), false);
  assert.equal(partial.hasUnmarkedSameAmountCancel(at("2026-11-10T15:00:00+09:00", { cancelReason: "휴원 수강료 환불 STIZ-PR:l2" }), 70000, "2026-11-10T01:00:00.000Z"), false);
  assert.equal(partial.hasUnmarkedSameAmountCancel(at(undefined), 70000, "2026-11-10T01:00:00.000Z"), true);
  // 웹훅: 표식 붙은 취소 합 = 취소 금액이면 경보 생략
  assert.equal(partial.markedCancelTotal({ cancels: [{ cancelAmount: 70000, cancelReason: "휴원 수강료 환불 STIZ-PR:a" }, { cancelAmount: 35000, cancelReason: "STIZ-PR:b", cancelStatus: "DONE" }, { cancelAmount: 1000, cancelReason: "다른 취소" }] }), 105000);
  const ledger = readFileSync("src/lib/payment-ledger.ts", "utf8");
  assert.match(ledger, /markedCancelTotal\(verified\) === cancel\.canceledAmount/);
  const fn = ledger.slice(ledger.indexOf("export async function partialRefundTossPaymentByAdmin"));
  assert.ok(fn.indexOf("hasUnmarkedSameAmountCancel(before.payment") < fn.indexOf("PAYMENT_TOSS_PARTIAL_CANCEL_REQUESTED"), "보내기 전에 확인");
  assert.match(fn, /`stiz-pause-refund:\$\{input\.lineId\}:\$\{input\.attempt\}`/);
  // 실행부: 확실한 실패면 시도 번호 +1, 결과 모름이면 그대로(같은 키로 확인만)
  const db = fakeDb({ payments: ROWS(), request: REQ });
  const done = await service.executePauseSettlementInTx(db, { requestId: "req-1", adminUserId: "a", mode: "REFUND", expectedPreviewKey: await previewKey(db), classDatesFor });
  const seen = [];
  const answers = [{ ok: false, message: "거절", uncertain: false }, { ok: false, message: "모름", uncertain: true }, { ok: true, alreadyApplied: false }];
  for (const answer of answers) {
    await service.runSettlementTossRefunds(db, { settlementId: done.settlementId, adminUserId: "a", refundToss: async (input) => { seen.push([input.attempt, input.notBefore]); return answer; } });
  }
  assert.deepEqual(seen.map((s) => s[0]), [0, 1, 1]);
  assert.equal(seen[0][1], "2026-11-10T01:00:00.000Z");
  assert.equal(db.state.lines.find((l) => l.kind === "REFUND").status, "DONE");
  // FAILED 안내는 직접 취소했다면 «직접 처리함»을 누르라고 말한다
  assert.match(plan.settlementTodoText({ kind: "REFUND", channel: "TOSS", amount: 70000, status: "FAILED" }), /직접 취소했다면 «직접 처리함»을 눌러/);
});

// ── 7) 재검수(11-10): 확실한 실패 범위·크론 학생별·잠금 뒤 목록 재확인 ─────────────────
test("[필수] 확실한 거절 = 4xx 중 409·429 제외. 5xx·409·429·응답 없음·재조회 실패 = 결과 모름", () => {
  for (const s of [400, 403, 404, 422, 499]) assert.equal(partial.isDefiniteTossRejection(s), true, String(s));
  for (const s of [409, 429, 500, 502, 503, 200, null, undefined]) assert.equal(partial.isDefiniteTossRejection(s), false, String(s));
  const marker = partial.partialCancelMarker("line-1");
  const none = { cancels: [] };
  const judge = (verified, httpStatus) => partial.judgePartialCancelOutcome({ verified, marker, amount: 70000, httpStatus });
  assert.equal(judge(none, 400), "FAILED");
  assert.equal(judge(none, 409), "UNCERTAIN");
  assert.equal(judge(none, 429), "UNCERTAIN");
  assert.equal(judge(none, 503), "UNCERTAIN");
  assert.equal(judge(none, null), "UNCERTAIN", "응답 없음");
  assert.equal(judge(null, 400), "UNCERTAIN", "재조회를 못 하면 거절 응답이어도 확정하지 않는다");
  assert.equal(judge({ cancels: [{ cancelAmount: 70000, cancelReason: `x ${marker}` }] }, 500), "DONE", "응답이 5xx 여도 재조회에 취소가 있으면 완료");
  assert.equal(judge({ cancels: [{ cancelAmount: 1, cancelReason: `x ${marker}` }] }, 200), "WRONG_AMOUNT");
  // 장부 함수가 응답 코드를 판정에 넘기고, 결과 모름은 uncertain:true
  const ledger = readFileSync("src/lib/payment-ledger.ts", "utf8");
  const fn = ledger.slice(ledger.indexOf("export async function partialRefundTossPaymentByAdmin"), ledger.indexOf("/** 관리자 환불 취소 요청의 Idempotency-Key 시드"));
  assert.match(fn, /httpStatus = response\.status;/);
  assert.match(fn, /judgePartialCancelOutcome\(\{[\s\S]*?marker, amount: input\.amount, httpStatus,/);
  assert.match(fn, /if \(outcome === "FAILED"\) return \{[^\n]*uncertain: false \}/);
  assert.match(fn, /«다시 시도»로 확인해 주세요\.", uncertain: true \};\n\}/);
});

test("[필수] 409·5xx 응답 → REQUESTED 유지·같은 키(시도 번호 그대로), 400 → FAILED·다음 시도는 새 키", async () => {
  // 응답 코드 → 장부 함수 결과(판정 함수 그대로) → 실행부 줄 상태·시도 번호
  const toResult = (httpStatus) => {
    const outcome = partial.judgePartialCancelOutcome({ verified: { cancels: [] }, marker: "m", amount: 70000, httpStatus });
    return outcome === "FAILED" ? { ok: false, message: "거절", uncertain: false } : { ok: false, message: "모름", uncertain: true };
  };
  const db = fakeDb({ payments: ROWS(), request: REQ });
  const done = await service.executePauseSettlementInTx(db, { requestId: "req-1", adminUserId: "a", mode: "REFUND", expectedPreviewKey: await previewKey(db), classDatesFor });
  const attempts = [];
  const run = (httpStatus) => service.runSettlementTossRefunds(db, { settlementId: done.settlementId, adminUserId: "a", refundToss: async (input) => { attempts.push(input.attempt); return toResult(httpStatus); } });
  const line = () => db.state.lines.find((l) => l.kind === "REFUND");
  await run(409);
  assert.equal(line().status, "REQUESTED");
  await run(503);
  assert.equal(line().status, "REQUESTED");
  assert.equal(line().failedAttempts, 0);
  await run(400);
  assert.equal(line().status, "FAILED");
  assert.equal(line().failedAttempts, 1);
  await run(500);
  assert.deepEqual(attempts, [0, 0, 0, 1], "결과 모름은 같은 키, 확실한 거절 뒤에만 다음 키");
  assert.equal(line().status, "REQUESTED");
});

test("[권장3] 결제 잠금·행 잠금 뒤 다시 읽은 청구 목록이 처음과 다르면 «다시 시도»로 거절(감액 없음)", async () => {
  const db = fakeDb({ payments: ROWS(), request: REQ });
  const key = await previewKey(db);
  // 잠금을 잡는 사이 새 1월 청구가 생겼다
  db.state.afterRowLock = (state) => {
    state.payments.push({ id: "jan", year: 2027, month: 1, amount: 140000, status: "PENDING", paidProvider: null, method: null, rallyzMirror: false, tossTxId: null, tossTxMethod: null, busy: false });
    state.afterRowLock = null;
  };
  const result = await service.executePauseSettlementInTx(db, { requestId: "req-1", adminUserId: "a", mode: "REFUND", expectedPreviewKey: key, classDatesFor });
  assert.equal(result.ok, false);
  assert.match(result.message, /청구 목록이 바뀌었어요.*다시 시도/);
  assert.equal(db.state.paymentUpdates.length, 0);
  assert.equal(db.state.settlements.length, 0);
  assert.equal(db.state.events.filter((e) => e === "candidates").length, 2, "실행 = 잠금 전 목록 + 잠금 뒤 재확인(미리보기는 후보 목록을 읽지 않는다)");
});

test("[권장2] 크론(학생 지정 없음)은 학생마다 트랜잭션 — 한 학생 실패가 다른 학생 차감을 되돌리지 않는다", async () => {
  const transactions = [];
  const db = {
    async $queryRawUnsafe(sql) {
      if (sql.includes("to_regclass")) return [{ a: "x", b: "y" }];
      if (sql.includes(`SELECT DISTINCT "studentId"`)) return [{ studentId: "a-stu" }, { studentId: "b-stu" }];
      throw new Error("unexpected");
    },
    async $executeRawUnsafe() { return 1; },
    async $transaction(fn) {
      const studentHolder = { id: null };
      const tx = {
        async $executeRawUnsafe() { return 1; },
        async $queryRawUnsafe(sql, ...v) {
          if (sql.includes('FROM "EnrollmentChangeSettlement"') && sql.includes("FOR UPDATE")) {
            studentHolder.id = v[0];
            if (v[0] === "a-stu") throw new Error("학생 a 실패");
            return [];
          }
          throw new Error("unexpected tx");
        },
      };
      try { const r = await fn(tx); transactions.push([studentHolder.id, "commit"]); return r; }
      catch (e) { transactions.push([studentHolder.id, "rollback"]); throw e; }
    },
  };
  const original = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(await service.applyOpenPauseCarries(db), { applied: 0, amount: 0 });
  } finally { console.error = original; }
  assert.deepEqual(transactions, [["a-stu", "rollback"], ["b-stu", "commit"]], "학생 id 순서로 따로따로");
  const src = readFileSync("src/lib/enrollment/pause-settlement.ts", "utf8");
  assert.match(src, /ADD COLUMN IF NOT EXISTS "failedAttempts"|failedAttempts/);
  assert.match(readFileSync("prisma/migrations/20261110180000_enrollment_pause_settlement/migration.sql", "utf8"),
    /ALTER TABLE "EnrollmentChangeSettlementLine" ADD COLUMN IF NOT EXISTS "failedAttempts" INTEGER NOT NULL DEFAULT 0;/);
});
