import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

// 부상·질병 «기간 결석» 퇴원 정산 = 환불 검토(4단계, 2026-11-15 원장 결정) — 규칙·화면 모양·권한을 실제로 돌려 확인한다.
//
// DB 흐름(승인 → 보류 → 퇴원 → 환불 검토 → 환불 처리함 · 취소 뒤 다시 넘기기 · 두 번 눌러도 한 번 · 수강 종료 정리 보호)은
// 실제 PostgreSQL 로 돌린다: node scripts/test-billing-workbench-postgres.mjs (tests/illness-period-refund-postgres.mjs).
// 여기는 순수 규칙 실행 + «누가 누를 수 있나 · 금액이 누구에게 내려가나 · 돈을 움직이는 코드를 부르지 않는가»를 지킨다.

const rules = await loadTsModule("src/lib/regular/illnessPeriodRules.ts");
const viewRules = await loadTsModule("src/lib/regular/illnessPeriodRefundView.ts");
const catalog = await loadTsModule("src/lib/requests/catalog.ts");
const cleanup = await loadTsModule("src/lib/enrollment/enrollment-end-cleanup.ts");
const read = (path) => readFileSync(path, "utf8");
const slice = (source, from, to) => {
  const start = source.indexOf(from);
  assert.ok(start >= 0, `구간 시작을 찾지 못함: ${from}`);
  const end = to ? source.indexOf(to, start + from.length) : source.length;
  assert.ok(end > start, `구간 끝을 찾지 못함: ${to}`);
  return source.slice(start, end);
};

const refundLib = read("src/lib/regular/illness-period-refund.ts");
const refundActions = read("src/app/actions/illness-period-refund.ts");

test("상태: 신청함 목록 값 = 상태 지도 값 — «정산 필요 · 퇴원»·«환불 검토»는 처리 필요(메뉴 숫자), «환불 처리»는 완료", () => {
  assert.deepEqual([rules.PERIOD_WITHDRAWN_INBOX_STATUS, rules.PERIOD_REFUND_REVIEW_INBOX_STATUS, rules.PERIOD_REFUND_DONE_INBOX_STATUS], ["SETTLE_WITHDRAWN", "REFUND_REVIEW", "REFUND_DONE"]);
  assert.deepEqual(
    ["SETTLE_WITHDRAWN", "REFUND_REVIEW", "REFUND_DONE"].map((status) => [catalog.bucketFor("ILLNESS_PERIOD", status), catalog.statusLabel("ILLNESS_PERIOD", status)]),
    [["ACTION", "정산 필요 · 퇴원"], ["ACTION", "환불 검토"], ["DONE", "완료(환불 처리)"]],
  );
  // 기간의 정산 상태 값(DB CHECK 제약과 같은 집합)에 이미 들어 있다 — 스키마 변경 없음
  assert.ok(rules.PERIOD_CARRY_STATES.includes("REFUND_REVIEW") && rules.PERIOD_CARRY_STATES.includes("REFUND_DONE"));
  assert.deepEqual(rules.PERIOD_REFUND_STUDENT_LABELS, { WITHDRAWN: "퇴원 · 정산 필요", REFUND_REVIEW: "환불 검토", REFUND_DONE: "환불 처리 완료" });
  // 목록 SQL: 환불 상태가 먼저, 퇴원이 «복귀 · 정산 필요»보다 먼저(다음 청구가 없으니 이월로 안내하지 않는다)
  const inbox = read("src/lib/requests/admin-inbox.ts");
  const order = ["WHEN x.\"carryState\" = 'REFUND_REVIEW' THEN", "WHEN x.\"carryState\" = 'REFUND_DONE' THEN", "WHEN ${illnessWithdrawnSql(\"x\")} THEN", "WHEN ${illnessSettleNeededSql(\"x\")} THEN", "WHEN x.\"carryState\" <> 'NONE' THEN 'APPROVED'"];
  order.reduce((from, piece) => { const at = inbox.indexOf(piece, from); assert.ok(at >= from, `순서가 어긋남: ${piece}`); return at; }, 0);
  // 금액은 목록에 싣지 않는다(부원장도 목록을 본다)
  const adapter = slice(inbox, 'kind: "ILLNESS_PERIOD",', 'kind: "MAKEUP",');
  assert.doesNotMatch(adapter, /carryTotal|carrySettlement|toLocaleString/);
});

test("퇴원 판정 조각: 승인·금액 미확정 + 대상 반에 끝나지 않은 수강이 하나도 없다 — 대상 반이 빈 배열이면 그 학생의 반 전부", () => {
  const sql = rules.illnessWithdrawnSql("p");
  assert.ok(sql.includes(rules.illnessHoldPeriodSql("p")), "승인됐고 금액 미확정인 기간만");
  assert.match(sql, /NOT EXISTS \(\s+SELECT 1 FROM "Enrollment" live_enrollment\s+WHERE live_enrollment\."studentId" = p\."studentId" AND live_enrollment\.status <> 'WITHDRAWN'\s+AND \(cardinality\(p\."classIds"\) = 0 OR live_enrollment\."classId" = ANY\(p\."classIds"\)\)\)/);
  // 수강 종료 정리가 지우지 않을 결석: 승인된 기간에 묶인 지난 날(오늘 포함) — 오늘은 DB 시계의 KST 날짜
  const keep = rules.illnessPendingSettleAbsenceSql("ra");
  assert.match(keep, /ra\.reason = 'ILLNESS_INJURY' AND ra\.date <= \(now\(\) AT TIME ZONE 'Asia\/Seoul'\)::date/);
  assert.ok(keep.includes(rules.illnessHoldPeriodSql("pending_period")));
});

test("세는 끝(refundCountUntil): 퇴원한 아이는 오늘까지만 센다 — 저장된 복귀일이 더 이르면 그날, 달·해·윤년 경계", () => {
  assert.equal(rules.refundCountUntil("2026-11-15", null), "2026-11-16", "복귀 미정 → 내일(오늘 수업까지 센다)");
  assert.equal(rules.refundCountUntil("2026-11-15", "2026-11-10"), "2026-11-10", "이미 복귀 처리된 기간은 그 복귀일");
  assert.equal(rules.refundCountUntil("2026-11-15", "2026-11-16"), "2026-11-16");
  assert.equal(rules.refundCountUntil("2026-11-15", "2026-12-01"), "2026-11-16", "미래 복귀일은 쓰지 않는다(아직 안 지난 날을 세지 않는다)");
  assert.equal(rules.refundCountUntil("2026-11-30", null), "2026-12-01", "월말");
  assert.equal(rules.refundCountUntil("2026-12-31", undefined), "2027-01-01", "연말");
  assert.equal(rules.refundCountUntil("2028-02-28", null), "2028-02-29", "윤년");
  assert.equal(rules.refundCountUntil("2027-02-28", "잘못된값"), "2027-03-01", "모양이 다른 복귀일은 무시");
});

test("문구: 학부모 알림·화면 — 금액은 확정된 정산표 합계, 0원이면 금액 없이 / 환불 처리 기록 읽기", () => {
  assert.equal(rules.periodRefundReviewParentText(84000), "부상 결석 기간 수강료 84,000원을 환불 검토 중이에요");
  assert.equal(rules.periodRefundDoneParentText(84000), "부상 결석 기간 수강료 84,000원 환불 처리를 마쳤어요");
  assert.equal(rules.periodRefundReviewParentText(0), "부상 결석 정산을 확인하고 있어요 · 환불할 수강료는 없어요");
  assert.equal(rules.periodRefundDoneParentText(0), "부상 결석 정산을 마쳤어요 · 환불할 수강료는 없어요");
  assert.deepEqual([rules.PERIOD_REFUND_REVIEW_PARENT_LABEL, rules.PERIOD_REFUND_DONE_PARENT_LABEL], ["환불 검토 중", "환불 처리 완료"]);
  assert.equal(rules.REFUND_RESOLUTION_REASON, "퇴원 정산 — 환불 검토");
  assert.deepEqual(rules.parseRefundRecord({ refund: { memo: "11/20 카드 취소", doneAt: "2026-11-20T01:00:00Z", doneByUserId: "owner" } }), { memo: "11/20 카드 취소", doneAt: "2026-11-20T01:00:00Z", doneByUserId: "owner" });
  assert.deepEqual(rules.parseRefundRecord(JSON.stringify({ refund: { memo: "메모" } })), { memo: "메모", doneAt: null, doneByUserId: null });
  for (const bad of [null, "x", {}, { refund: [] }, { refund: { memo: "" } }, { refund: { memo: 3 } }]) assert.equal(rules.parseRefundRecord(bad), null);
});

test("학부모 날짜별 글자: 환불 검토·환불 처리된 기간에서 정산표에 들지 않은 날은 «정산 제외», 보강을 쓴 날은 보강권", () => {
  const day = (input) => rules.parentPeriodDayStatus({ reviewStatus: "APPROVED", reason: "ILLNESS_INJURY", settled: false, ...input });
  for (const state of ["REFUND_REVIEW", "REFUND_DONE"]) {
    assert.deepEqual(day({ periodCarryState: state, settled: true }), { status: "APPROVED", amountPending: false }, "정산표에 든 날");
    assert.deepEqual(day({ periodCarryState: state }), { status: "EXCLUDED", amountPending: false, excluded: true });
    assert.deepEqual(day({ periodCarryState: state, makeupInUse: true }), { status: "MAKEUP", amountPending: false });
  }
  // 학부모 목록: 정산표에 든 날은 «이월» 글자 대신 환불 상태와 합계 — 본인 아이만(childAccessSql)
  const list = read("src/lib/regular/parent-regular-absence.ts");
  assert.match(list, /const refundState = r\.settled === true && \(r\.periodCarryState === "REFUND_REVIEW" \|\| r\.periodCarryState === "REFUND_DONE"\)/);
  assert.match(list, /refundText: refundState === "REFUND_DONE" \? periodRefundDoneParentText\(refundTotal\) : periodRefundReviewParentText\(refundTotal\),/);
  assert.match(list, /WHERE \$\{await childAccessSql\("s", "\$1"\)\} AND \$\{notMergedStudent\("s"\)\}/);
  const client = read("src/app/mypage/regular-absence/RegularAbsenceClient.tsx");
  assert.match(client, /\{review\.refundText \? review\.refundText : typeof review\.settledTotal === "number"/);
  // 기간 줄: 환불 검토 중 → 환불 처리 완료, 그 기간에서는 «복귀했어요»·«알림 취소»를 누르지 않는다
  const periods = read("src/lib/regular/parent-absence-period.ts");
  assert.match(periods, /const active = row\.active === true && row\.carryState !== "REFUND_REVIEW" && row\.carryState !== "REFUND_DONE";/);
  assert.match(periods, /carry === "REFUND_REVIEW" \? `\$\{PERIOD_REFUND_REVIEW_PARENT_LABEL\} · \$\{periodRefundReviewParentText\(/);
  assert.match(periods, /OR p\."carryState" = 'REFUND_REVIEW' OR \(p\."carryState" = 'REFUND_DONE' AND p\."carrySettledAt" > now\(\) - interval '60 days'\)/);
  assert.match(periods, /WHERE \$\{await childAccessSql\("s", "\$1"\)\} AND \$\{notMergedStudent\("s"\)\}/);
});

// ── 화면에 내려보내는 모양(실행): 부원장 응답에는 금액이 없다 ─────────────────────────────────────
const planRows = [
  { month: "2026-11", classId: "mon", className: "월요반", evidence: "PAID_PAYMENT", tuition: 105000, sessions: 5, dates: ["2026-11-09", "2026-11-16"], absenceIds: ["a1", "a2"],
    excluded: [{ absenceId: "a0", date: "2026-11-02", code: "ATTENDED", why: "출석 기록 있음" }], unitDisplay: 21000, subtotal: 42000, warnings: ["셔틀비가 포함된 금액일 수 있어요."], blockedReason: null },
  { month: "2026-12", classId: "mon", className: "월요반", evidence: "UNPAID", tuition: 0, sessions: 4, dates: ["2026-11-30"], absenceIds: ["a3"], excluded: [], unitDisplay: 0, subtotal: 0, warnings: [], blockedReason: null },
];
const guides = [{ month: "2026-12", classId: "mon", className: "월요반", sessions: 4, attended: 3, missedDates: ["2026-11-30"], shape: "PREFIX", periodStart: "2026-12-07", periodEnd: "2026-12-21" }];
const viewOf = (over) => viewRules.buildRefundView({
  stage: "PREVIEW", money: true, writesEnabled: true, studentId: "stu 1", rows: planRows, total: 42000, unpaidGuides: guides,
  fingerprint: "f".repeat(64), countUntil: "2026-12-02", storedReturnDate: null, blockers: [], needsHold: false, memo: null, ...over,
});

test("화면 모양: 원장에게는 금액·지문, 부원장 응답에는 금액도 지문도 없다(서버 응답에서 뺀다)", () => {
  const owner = viewOf({});
  assert.deepEqual([owner.state, owner.carryTotal, owner.fingerprint, owner.canSettle, owner.canSetReturnDate, owner.availableMonth], ["READY", 42000, "f".repeat(64), true, false, null]);
  assert.deepEqual(owner.rows.map((row) => [row.key, row.tuition, row.unit, row.subtotal, row.dates.length]), [["mon|2026-11", 105000, 21000, 42000, 2], ["mon|2026-12", null, null, null, 1]]);
  assert.deepEqual(owner.unpaid, ["12월 월요반 · 4회 중 1회 결석 → 낸 돈이 없는 달이라 환불 대상이 아니에요(청구 없음)"]);
  assert.equal(owner.refund.financeHref, "/admin/finance?studentId=stu%201", "수납 관리의 그 학생 납부 청구 화면(기존)");

  const vice = viewOf({ money: false });
  assert.deepEqual([vice.carryTotal, vice.fingerprint, vice.canSeeMoney, vice.canSettle], [null, null, false, false]);
  for (const row of vice.rows) assert.deepEqual([row.tuition, row.unit, row.subtotal], [null, null, null]);
  // 응답 전체를 글자로 펴도 금액·지문이 어디에도 없다
  const wire = JSON.stringify(vice);
  for (const secret of ["105000", "21000", "42000", "105,000", "42,000", "f".repeat(64)]) assert.ok(!wire.includes(secret), `부원장 응답에 ${secret}`);
  // 날짜·제외 사유·낸 돈이 없는 달 안내(금액 없음)는 그대로 내려간다
  assert.deepEqual(vice.rows[0].dates, [{ absenceId: "a1", date: "2026-11-09" }, { absenceId: "a2", date: "2026-11-16" }]);
  assert.deepEqual(vice.rows[0].excluded, [{ absenceId: "a0", date: "2026-11-02", code: "ATTENDED", why: "출석 기록 있음" }]);
  assert.deepEqual(vice.unpaid, owner.unpaid);
});

test("화면 모양: 넘긴 뒤(환불 검토·환불 처리함)는 표 사본 — 지문 없음, 메모는 환불 처리함에서만", () => {
  const review = viewOf({ stage: "REVIEW", memo: "아직 없음" });
  assert.deepEqual([review.state, review.fingerprint, review.refund.stage, review.refund.memo, review.carryTotal], ["SETTLED", null, "REVIEW", null, 42000]);
  const done = viewOf({ stage: "DONE", memo: "11/20 카드 취소 42,000원" });
  assert.deepEqual([done.state, done.refund.stage, done.refund.memo], ["SETTLED", "DONE", "11/20 카드 취소 42,000원"]);
  assert.equal(viewOf({ stage: "DONE", money: false, memo: "메모" }).carryTotal, null);
  // 낸 돈이 없는 달 문구에는 금액이 없다
  assert.doesNotMatch(slice(read("src/lib/regular/illnessPeriodSettlementPlan.ts"), "export function unpaidGuideRefundText(", "export function parentSettlementView("), /toLocaleString|원`|tuition|subtotal/);
});

// ── 수강 종료 정리: 정산 대상 결석 보호 · 결과 문구 ─────────────────────────────────────────────
const absenceRow = (over = {}) => ({
  id: "a", date: "2026-11-16", status: "CONFIRMED", note: null, periodRow: true, billingResolved: false, carryCredit: false, makeupBooked: false,
  attendanceRecorded: false, creditId: null, creditStatus: null, creditBooked: false, ...over,
});

test("수강 종료 정리(규칙): 승인된 기간의 지난 결석은 지우지 않는다 — 정산·이월에 묶인 날이 먼저, 효력일 전은 예전처럼 건드리지 않는다", () => {
  const from = "2026-11-10";
  assert.equal(cleanup.decideAbsenceOnClassEnd(absenceRow({ illnessSettlePending: true }), from), "KEEP_ILLNESS");
  assert.equal(cleanup.decideAbsenceOnClassEnd(absenceRow(), from), "CANCEL", "표시가 없으면 예전처럼 취소");
  assert.equal(cleanup.decideAbsenceOnClassEnd(absenceRow({ illnessSettlePending: true, billingResolved: true }), from), "KEEP_BILLING");
  // 보강권이 예약·사용돼 있어도 정산 대기가 먼저다(정산이 «보강 완료/예약 중»으로 따로 뺀다) — 어느 쪽이든 결석은 남는다
  assert.equal(cleanup.decideAbsenceOnClassEnd(absenceRow({ illnessSettlePending: true, creditStatus: "RESERVED" }), from), "KEEP_ILLNESS");
  assert.equal(cleanup.decideAbsenceOnClassEnd(absenceRow({ illnessSettlePending: true, date: "2026-11-09" }), from), "SKIP");
  const plan = cleanup.planClassEndAbsences([
    absenceRow({ id: "past", illnessSettlePending: true, creditId: "c1", creditStatus: "AVAILABLE" }),
    absenceRow({ id: "future", date: "2026-11-23", creditId: "c2", creditStatus: "AVAILABLE" }),
  ], from);
  assert.deepEqual([plan.cancel.map((row) => row.id), plan.revokeCreditIds, plan.illnessKept, plan.kept], [["future"], ["c2"], 1, { billing: 0, makeup: 0, attendance: 0 }]);
});

test("수강 종료 정리(가짜 DB 실행): 정산 대상 결석은 남고 미래 결석만 취소 — 결과에 «부상 결석 정산이 남아 있어요» 한 줄", async () => {
  const updates = [];
  const log = [];
  const absences = [
    { id: "past", date: "2026-11-09", status: "CONFIRMED", note: "기간 결석 · 질병", periodRow: true, billingResolved: false, carryCredit: false, makeupBooked: false, attendanceRecorded: false, illnessSettlePending: true },
    { id: "future", date: "2026-11-23", status: "CONFIRMED", note: "기간 결석 · 질병", periodRow: true, billingResolved: false, carryCredit: false, makeupBooked: false, attendanceRecorded: false, illnessSettlePending: false },
  ];
  const db = {
    async $queryRawUnsafe(sql, ...values) {
      log.push({ sql, values });
      if (/to_regclass/.test(sql)) return [{ found: "x" }];
      if (/information_schema\.columns/.test(sql) && /'carryState'/.test(sql)) return [{ n: 1 }];
      if (/FROM "RegularAbsence" ra/.test(sql)) return absences;
      if (/COUNT\(\*\)::int AS n FROM "RegularAbsencePeriod" p/.test(sql)) return [{ n: 1 }];
      return [];
    },
    async $executeRawUnsafe(sql, ...values) {
      log.push({ sql, values });
      if (/UPDATE "RegularAbsence" SET status = 'CANCELLED'/.test(sql)) { updates.push(values[0]); return 1; }
      return 0;
    },
  };
  const out = await cleanup.cleanupEndedClassInTx(db, { studentId: "s1", classId: "mon4", className: "월4", fromYmd: "2026-11-05", actorUserId: "admin" });
  assert.deepEqual(updates, ["future"], "지난 결석(정산 대상)은 취소하지 않는다");
  assert.deepEqual([out.cancelledAbsences, out.keptAbsences, out.illnessSettle], [1, { billing: 0, makeup: 0, attendance: 0 }, { periods: 1, keptAbsences: 1 }]);
  // 결석 조회가 판정 조각을 그대로 쓴다 · 남은 정산을 세는 조회는 «이 반은 끝난 것으로» 센다
  const absenceSql = log.find((query) => /FROM "RegularAbsence" ra/.test(query.sql)).sql;
  assert.ok(absenceSql.includes(`${rules.illnessPendingSettleAbsenceSql("ra")} AS "illnessSettlePending"`));
  const periodQuery = log.find((query) => /COUNT\(\*\)::int AS n FROM "RegularAbsencePeriod" p/.test(query.sql));
  assert.ok(periodQuery.sql.includes(rules.illnessHoldPeriodSql("p")));
  assert.match(periodQuery.sql, /other\."classId" <> \$2 AND other\.status <> 'WITHDRAWN'/);
  assert.deepEqual(periodQuery.values, ["s1", "mon4"]);
  const audit = JSON.parse(log.find((query) => /ENROLLMENT_END_CLEANUP/.test(query.sql)).values[1]);
  assert.deepEqual([audit.illnessKeptAbsences, audit.illnessSettlePeriods], [1, 1]);
  // 결과 문구
  const summary = { ...cleanup.emptyCleanupSummary(), ...out };
  assert.equal(cleanup.cleanupResultMessage(summary), `결석 1건 취소 · ${rules.ENROLLMENT_END_ILLNESS_NOTE}`);
  assert.match(rules.ENROLLMENT_END_ILLNESS_NOTE, /^부상 결석 정산이 남아 있어요/);
  assert.equal(cleanup.cleanupResultMessage(cleanup.emptyCleanupSummary()), "", "남은 정산이 없으면 예전 그대로");
  // 기간 정산 칸이 없는 DB: 없는 칸을 읽지 않는다(판정 조각 대신 false)
  const oldLog = [];
  const oldDb = { async $queryRawUnsafe(sql) { oldLog.push(sql); return /to_regclass/.test(sql) ? [{ found: null }] : []; }, async $executeRawUnsafe() { return 0; } };
  const old = await cleanup.cleanupEndedClassInTx(oldDb, { studentId: "s1", classId: "mon4", className: "월4", fromYmd: "2026-11-05", actorUserId: "admin" });
  assert.equal(old.illnessSettle, undefined);
  assert.ok(oldLog.every((sql) => !/"carryState"/.test(sql)), "carryState 를 읽지 않는다");
  assert.match(oldLog.find((sql) => /FROM "RegularAbsence" ra/.test(sql)), /false AS "illnessSettlePending"/);
});

// ── 연결부·권한(코드에서 빠지지 않게) ───────────────────────────────────────────────────────────
test("환불 검토: 이 기능은 돈을 움직이지 않는다 — 이월을 만들지 않고, 결제·청구·환불 코드를 부르지 않는다", () => {
  for (const source of [refundLib, refundActions, read("src/app/admin/inbox/IllnessPeriodRefundBox.tsx")]) {
    assert.doesNotMatch(source, /insertCarryCreditInTx|INSERT INTO "BillingCarryCredit"|BillingCarryUsage/, "이월을 만들지도 쓰지도 않는다");
    assert.doesNotMatch(source, /(UPDATE|INSERT INTO|DELETE FROM) "Payment|"PaymentInvoice"|"PaymentTransaction"|"PaymentAuditLog"/, "청구·결제 행을 건드리지 않는다");
    assert.doesNotMatch(source, /from "@\/lib\/(payments|pos|toss)[^"]*"|tosspayments|bulkRefund|cancelPayment|refundPayment/i, "결제·환불 모듈을 가져오지 않는다");
    assert.doesNotMatch(source, /sendParentSms|sendTrackedSms|sendFailClosedTrackedSms|alimtalk|sendSms/i, "문자·알림톡을 새로 만들지 않는다");
  }
  // 복귀 정산과 «같은 읽기 함수»로 표를 만든다(식이 둘로 갈리지 않는다) — 미리보기는 잠금 없이, 넘기기는 잠근 뒤 다시
  const preview = slice(refundLib, "export async function previewIllnessPeriodRefund(", "export type RefundReviewResult");
  assert.match(preview, /const read = await readSettlementPlan\(tx, period, countUntil, omit, ctx, false\);/);
  assert.doesNotMatch(preview, /lockCompensation|\$executeRawUnsafe|FOR UPDATE/);
  const send = slice(refundLib, "export async function sendIllnessPeriodToRefundReview(", "export type RefundDoneResult");
  assert.match(send, /const read = await readSettlementPlan\(tx, period, countUntil, omit, ctx, true\);/);
  assert.equal((refundLib.match(/refundCountUntil\(ctx\.todayYmd, period\.returnDate\)/g) ?? []).length, 2, "미리보기와 넘기기가 같은 «세는 끝»");
});

test("환불 검토로 넘기기: 스위치 → 전역 잠금 → 기간 행 → 학생 행 → 퇴원 확인 → 결석 잠금 뒤 다시 계산 → 지문이 같을 때만 · 조건부 UPDATE · 병합 저장", () => {
  const send = slice(refundLib, "export async function sendIllnessPeriodToRefundReview(", "export type RefundDoneResult");
  assert.ok(send.indexOf("if (!enabled) throw") < send.indexOf("db.$transaction("));
  const order = ["await lockCompensation(tx);", "WHERE p.id = $1 FOR UPDATE OF p", `FROM "Student" s WHERE s.id = $1 AND \${notMergedStudent("s")} FOR UPDATE`,
    "readIllnessPeriodWithdrawal(tx, periodId)", "await endAbsencePeriodInTx(tx,", "await readSettlementPlan(tx, period, countUntil, omit, ctx, true)",
    "if (read.plan.problems.length > 0) throw", "if (read.fingerprint !== expected) throw", `INSERT INTO "BillingAbsenceResolution"`];
  order.reduce((from, piece) => { const at = send.indexOf(piece, from); assert.ok(at >= from, `순서가 어긋남: ${piece}`); return at; }, 0);
  assert.match(send, /VALUES \(\$1,\$2,'CARRY',\$3,true,\$4,\$5\)`,\s+absenceId, period\.studentId, REFUND_RESOLUTION_REASON, ILLNESS_REASON, actorId,/);
  assert.match(send, /SET "carryState" = 'REFUND_REVIEW', "carrySettledAt" = now\(\), "carrySettledByUserId" = \$2,\s+"carrySettlement" = COALESCE\("carrySettlement", '\{\}'::jsonb\) \|\| \$3::jsonb, "updatedAt" = now\(\)\s+WHERE id = \$1 AND "carryState" = 'APPROVED'/);
  assert.match(send, /if \(changed !== 1\) throw new IllnessPeriodError\("기간 상태가 바뀌어 넘기지 않았습니다/);
  assert.match(send, /'ILLNESS_PERIOD_REFUND_REVIEW', 'ADMIN', \$1, \$2::jsonb/);
  // 낸 돈이 없는 달 안내는 표 사본 «안»에만 둔다 — 기간 행 맨 위의 unpaidGuides(청구 준비가 읽는 칸)에는 쓰지 않는다
  assert.match(send, /JSON\.stringify\(\{ settlement \}\)/);
  assert.match(send, /rows: read\.plan\.rows, unpaidGuides: read\.plan\.unpaidGuides,/);
  // 격리 수준을 올리지 않는다(잠근 뒤 다시 읽는 값이 최신이어야 한다 — 복귀 정산 확정과 같다)
  assert.doesNotMatch(refundLib, /isolationLevel/);
  assert.match(read("src/lib/regular/illness-period-settlement.ts"), /export const SETTLE_TX_OPTIONS = \{ timeout: 60_000 \};/);
});

test("환불 처리함·환불 검토 취소: 조건부 UPDATE 한 번 — 처리함은 메모 필수·되돌리지 않음, 취소는 자기 정산 기록만 지우고 사본을 남긴다", () => {
  const done = slice(refundLib, "export async function markIllnessPeriodRefundDone(", "export type CancelRefundReviewResult");
  assert.ok(done.indexOf("환불 처리 메모를 적어 주세요") < done.indexOf("db.$transaction("), "메모 확인이 먼저");
  assert.match(done, /if \(memo\.length > REFUND_MEMO_MAX\) throw/);
  assert.match(done, /SET "carryState" = 'REFUND_DONE',[\s\S]{0,320}WHERE id = \$1 AND "carryState" = 'REFUND_REVIEW'/);
  assert.match(done, /COALESCE\("carrySettlement", '\{\}'::jsonb\)\s+\|\| jsonb_build_object\('refund', jsonb_build_object\('memo', \$2::text, 'doneByUserId', \$3::text, 'doneAt', to_jsonb\(now\(\)\)\)\)/);
  assert.match(done, /if \(period\.carryState === "REFUND_DONE"\) throw new IllnessPeriodError\("이미 환불 처리한 기간입니다\."\);/);
  assert.match(done, /'ILLNESS_PERIOD_REFUND_DONE', 'ADMIN', \$1, \$2::jsonb/);
  const cancel = slice(refundLib, "export async function cancelIllnessPeriodRefundReview(", "export type RefundIllnessPeriod");
  assert.match(cancel, /if \(period\.carryState === "REFUND_DONE"\) throw new IllnessPeriodError\("이미 환불 처리한 기간은 되돌릴 수 없습니다\."\);/);
  assert.ok(cancel.indexOf("'ILLNESS_PERIOD_REFUND_REVIEW_CANCELED'") < cancel.indexOf(`DELETE FROM "BillingAbsenceResolution"`), "지우기 전에 사본");
  assert.match(cancel, /WHERE ra\.id = r\."absenceId" AND ra\."periodId" = \$1 AND r\."absenceId" = ANY\(\$2::text\[\]\) AND r\.reason = \$3`,\s+periodId, settledAbsenceIds, REFUND_RESOLUTION_REASON,/);
  assert.match(cancel, /SET "carryState" = 'APPROVED', "carrySettledAt" = NULL, "carrySettledByUserId" = NULL,\s+"carrySettlement" = \(COALESCE\("carrySettlement", '\{\}'::jsonb\) - 'settlement'\) \|\| \$2::jsonb, "updatedAt" = now\(\)\s+WHERE id = \$1 AND "carryState" = 'REFUND_REVIEW'/);
});

test("권한: 미리보기는 원장·부원장(금액은 원장만) — 넘기기·환불 처리함·환불 검토 취소는 원장만, 학부모에게는 앱 알림만", () => {
  const load = slice(refundActions, "export async function loadIllnessPeriodRefund(", "/**\n * [환불 검토로 넘기기]");
  assert.match(load, /const admin = await requireAdmin\(\);\s+const money = canSeeAllMoney\(admin\.appUserRole\);/);
  assert.equal((load.match(/buildRefundView\(\{/g) ?? []).length, 2, "넘기기 전·넘긴 뒤 모두 같은 함수로 금액을 가린다");
  assert.equal((load.match(/money,/g) ?? []).length, 2);
  const send = slice(refundActions, "export async function sendIllnessPeriodRefundReviewAction(", "/**\n * [환불 처리함]");
  const done = slice(refundActions, "export async function markIllnessPeriodRefundDoneAction(", "/** [환불 검토 취소]");
  const cancel = slice(refundActions, "export async function cancelIllnessPeriodRefundReviewAction(");
  for (const [name, body] of [["넘기기", send], ["환불 처리함", done], ["환불 검토 취소", cancel]]) {
    assert.match(body, /try \{ owner = await requireOwner\(\); \} catch \{ return \{ ok: false, message: "[^"]+원장만 할 수 있습니다\." \}; \}/, name);
    assert.ok(body.indexOf("await requireOwner()") < body.indexOf("prisma"), `${name}: 권한 확인이 먼저`);
    assert.doesNotMatch(body, /input\?\.(carryTotal|amount|subtotal|tuition|refundTotal)/, `${name}: 화면이 보낸 금액을 받지 않는다`);
  }
  // 알림: 넘겼을 때 1회 · 처리함 때 1회 · 취소는 알리지 않는다. 24시간 중복 방지는 기존 함수 그대로
  assert.equal((send.match(/notifyParentOnce\(/g) ?? []).length, 1);
  assert.equal((done.match(/notifyParentOnce\(/g) ?? []).length, 1);
  assert.doesNotMatch(cancel, /notifyParent/);
  assert.match(send, /"부상 결석 환불 검토", `\$\{await childPrefix\(done\.studentId\)\}\$\{periodRefundReviewParentText\(done\.refundTotal\)\}`/);
  assert.match(done, /"부상 결석 환불 처리", `\$\{await childPrefix\(done\.studentId\)\}\$\{periodRefundDoneParentText\(done\.refundTotal\)\}`/);
  assert.match(refundActions, /const already = await parentNoticeSentRecently\(prisma, \{ studentId, title, message \}\)\.catch\(\(\) => false\);\s+if \(already\) return;/);
  assert.match(send, /await settlementContext\(owner\.appUserId, true\)/, "넘기기 직전에는 공식 일정을 새로 읽는다");
});

test("화면: 정산 칸은 퇴원이면 «환불 검토로 넘기기», 넘긴 뒤 칸은 수납 관리 링크·메모·«환불 처리함»·«환불 검토 취소» — 아이콘 없이 글자, 토큰 색, 44px", () => {
  const box = read("src/app/admin/inbox/IllnessPeriodSettlementBox.tsx");
  assert.match(box, /\{pending \? "처리 중…" : refund \? "환불 검토로 넘기기" : "이월 확정"\}/);
  assert.match(box, /confirmLabel: "환불 검토로 넘기기",\s+tone: "primary",/);
  assert.match(box, /\? loadIllnessPeriodRefund\(\{ periodId, omitAbsenceIds: nextOmit \}\)/);
  assert.match(box, /여기서 환불이 실행되지는 않습니다\. 수납 관리에서 직접 환불한 뒤 ‹환불 처리함›을 눌러 닫아 주세요\./);
  const refundBox = read("src/app/admin/inbox/IllnessPeriodRefundBox.tsx");
  assert.match(refundBox, /수납 관리에서 환불한 뒤 ‹환불 처리함›을 눌러 주세요\./);
  assert.match(refundBox, /<Link href=\{view\.refund\.financeHref\} className="academy-button-secondary">수납 관리에서 환불하기<\/Link>/);
  assert.match(refundBox, /disabled=\{pending \|\| !memoReady\} onClick=\{\(\) => void markDone\(\)\} className="academy-button-primary">/);
  assert.match(refundBox, /confirmLabel: "환불 처리함",\s+tone: "primary",/);
  assert.match(refundBox, /confirmLabel: "환불 검토 취소",\s+tone: "danger",/);
  assert.match(refundBox, /className="academy-button-danger">환불 검토 취소<\/button>/);
  assert.match(refundBox, /\{view\.carryTotal !== null && <span className="ml-2 tabular-nums">\{won\(view\.carryTotal\)\}<\/span>\}/, "금액은 내려온 것만");
  assert.match(refundBox, /\{!done && view\.canSettle && \(/, "누르는 것은 원장에게만");
  assert.match(refundBox, /useAdminConfirm\(\)/);
  assert.match(refundBox, /<li key=\{row\.key\} className="flex min-h-11 /, "한 줄 행 · 44px");
  for (const source of [refundBox, box]) assert.doesNotMatch(source, /material-symbols|UiIcon|font-(extrabold|black|bold)|#[0-9a-fA-F]{3,6}\b|lucide|학원에 문의/);
  assert.doesNotMatch(refundBox, /Math\.round|reduce\(/, "화면에서 금액을 계산하지 않는다");
  // 상세: 승인된 기간은 퇴원이면 정산 칸이 환불 길로, 환불 상태는 환불 칸으로
  const detail = read("src/app/admin/inbox/IllnessPeriodInboxDetail.tsx");
  assert.match(detail, /const refundPath = approved && withdrawal\?\.withdrawn === true && !useCarry;/);
  assert.match(detail, /carryState="APPROVED" refund=\{refundPath\}/);
  assert.match(detail, /detail\.carryState === "REFUND_REVIEW" \|\| detail\.carryState === "REFUND_DONE" \? \(\s+\/\/[^\n]*\n\s+<IllnessPeriodRefundBox /);
  // 학생 상세 기간 줄 상태 글자
  const panel = read("src/app/admin/students/[id]/AbsencePeriodPanel.tsx");
  assert.match(panel, /\? <span>\{PERIOD_REFUND_STUDENT_LABELS\.WITHDRAWN\}<\/span>/);
  assert.match(panel, /<span>\{PERIOD_REFUND_STUDENT_LABELS\[p\.carryState\]\}<\/span>/);
});
