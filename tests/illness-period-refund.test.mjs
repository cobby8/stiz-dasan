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
  // 수강 종료 정리가 결석을 따로 보호하는 조각은 없다(코드 리뷰 반영) — 효력일 이후 결석은 «퇴원 뒤 남은 수업»이라 예전대로 취소된다
  assert.equal(rules.illnessPendingSettleAbsenceSql, undefined);
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

test("반마다 자르는 날(refundClassCutoffs): 그 반 수강 종료 효력일부터는 세지 않는다 — 퇴원 뒤 남은 수업과 겹치지 않게", () => {
  const cutoffs = rules.refundClassCutoffs([
    { classId: "fri", endsOn: "2026-11-13" }, { classId: "mon", endsOn: "2026-12-01" },
    { classId: "fri", endsOn: "2026-11-20" },          // 같은 반 기록이 여럿이면 이른 날
    { classId: "bad", endsOn: "2026-13-40" }, { classId: "none", endsOn: null }, { classId: "", endsOn: "2026-11-13" },
  ]);
  assert.deepEqual([...cutoffs], [["fri", "2026-11-13"], ["mon", "2026-12-01"]]);
  assert.deepEqual([...rules.refundClassCutoffs([])], []);
  // 예: 금요반 11월 4회(11/6·13·20·27), 효력일 11/13 으로 종료 → 효력일 전날까지인 11/6 한 번만 남는다
  const friday = ["2026-11-06", "2026-11-13", "2026-11-20", "2026-11-27"];
  assert.deepEqual(friday.filter((date) => date < cutoffs.get("fri")), ["2026-11-06"]);
  // 읽는 SQL: 적용된 수강 종료·반 변경만, 지금 다시 다니는 반은 빼고, 반마다 가장 최근 것
  const sql = rules.REFUND_CLASS_END_SQL;
  // 옛 방식 반 이동 기록(MOVE)도 수강 종료 기록이다(CLASS_CHANGE 와 같게 본다)
  assert.match(sql, /r\.kind IN \('WITHDRAW', 'CLASS_CHANGE', 'MOVE'\) AND r\."appliedAt" IS NOT NULL AND r\.status IN \('APPLIED', 'APPROVED'\)/);
  assert.match(sql, /NOT EXISTS \(SELECT 1 FROM "Enrollment" back_enrollment[\s\S]{0,200}back_enrollment\.status <> 'WITHDRAWN'\)/);
  assert.match(sql, /SELECT DISTINCT ON \(r\."fromClassId"\)[\s\S]+ORDER BY r\."fromClassId", r\."appliedAt" DESC, r\.id/);
  // 미리보기와 넘기기가 같은 자르는 날을 읽기 함수에 넘긴다 · 읽기 함수는 그날부터의 결석을 표에 올리지 않는다
  assert.equal((refundLib.match(/await readRefundClassCutoffs\(tx, period\.studentId\)\);/g) ?? []).length, 2);
  assert.match(read("src/lib/regular/illness-period-settlement.ts"), /const cutoff = classCutoffs\?\.get\(absence\.classId\);\s+return !cutoff \|\| absence\.date < cutoff;/);
});

test("문구: 학부모 앱 알림에는 금액이 없다 · 화면은 검토 중일 때만 «예정 ○원», 완료 뒤에는 금액 없이 / 환불 처리 기록 읽기", () => {
  assert.equal(rules.PERIOD_REFUND_REVIEW_NOTICE, "부상 결석 기간 수강료를 환불 검토 중이에요");
  assert.equal(rules.PERIOD_REFUND_DONE_NOTICE, "부상 결석 기간 수강료 환불 처리를 마쳤어요");
  for (const text of [rules.PERIOD_REFUND_REVIEW_NOTICE, rules.PERIOD_REFUND_DONE_NOTICE]) assert.doesNotMatch(text, /\d|원/);
  assert.equal(rules.periodRefundReviewParentLabel(84000), "환불 검토 중 · 예정 84,000원");
  assert.equal(rules.periodRefundReviewParentLabel(0), "환불 검토 중");
  assert.deepEqual([rules.periodRefundReviewParentText, rules.periodRefundDoneParentText], [undefined, undefined], "금액이 든 옛 문구 함수는 없다");
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
  assert.match(list, /refundText: refundState === "REFUND_DONE" \? PERIOD_REFUND_DONE_PARENT_LABEL : periodRefundReviewParentLabel\(refundTotal\),/);
  assert.match(list, /WHERE \$\{await childAccessSql\("s", "\$1"\)\} AND \$\{notMergedStudent\("s"\)\}/);
  const client = read("src/app/mypage/regular-absence/RegularAbsenceClient.tsx");
  assert.match(client, /\{review\.refundText \? review\.refundText : typeof review\.settledTotal === "number"/);
  // 기간 줄: 환불 검토 중 → 환불 처리 완료, 그 기간에서는 «복귀했어요»·«알림 취소»를 누르지 않는다
  const periods = read("src/lib/regular/parent-absence-period.ts");
  assert.match(periods, /const active = row\.active === true && row\.carryState !== "REFUND_REVIEW" && row\.carryState !== "REFUND_DONE";/);
  assert.match(periods, /carry === "REFUND_REVIEW" \? periodRefundReviewParentLabel\(Number\.isSafeInteger\(row\.settledTotal\) \? Number\(row\.settledTotal\) : 0\)\s+: carry === "REFUND_DONE" \? PERIOD_REFUND_DONE_PARENT_LABEL/);
  // 학부모 미리보기 API: 환불 처리 완료 뒤에는 금액을 내려보내지 않는다
  assert.match(read("src/lib/regular/illness-period-settlement.ts"), /settledTotal: period\.carryState === "REFUND_REVIEW" \? summary\?\.carryTotal \?\? null : null \};/);
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

test("수강 종료 정리(규칙): 부상 결석을 따로 보호하지 않는다 — 효력일 이후는 예전대로 취소, 효력일 전은 원래 남아 정산 대상", () => {
  const from = "2026-11-13";
  // 표시를 넘겨도(옛 호출) 판정에 쓰이지 않는다
  assert.equal(cleanup.decideAbsenceOnClassEnd(absenceRow({ date: "2026-11-13", illnessSettlePending: true }), from), "CANCEL", "효력일 당일부터 취소");
  assert.equal(cleanup.decideAbsenceOnClassEnd(absenceRow({ date: "2026-11-20" }), from), "CANCEL");
  assert.equal(cleanup.decideAbsenceOnClassEnd(absenceRow({ date: "2026-11-06" }), from), "SKIP", "효력일 전 결석은 건드리지 않는다 = 정산 대상으로 남는다");
  const plan = cleanup.planClassEndAbsences(["2026-11-06", "2026-11-13", "2026-11-20", "2026-11-27"].map((date) => absenceRow({ id: date, date })), from);
  assert.deepEqual([plan.cancel.map((row) => row.id), plan.kept, "illnessKept" in plan], [["2026-11-13", "2026-11-20", "2026-11-27"], { billing: 0, makeup: 0, attendance: 0 }, false]);
  assert.doesNotMatch(read("src/lib/enrollment/enrollment-end-cleanup.ts"), /KEEP_ILLNESS|illnessSettlePending|illnessPendingSettleAbsenceSql/);
});

test("수강 종료 정리(가짜 DB 실행): 효력일 이후 결석은 모두 취소 — 결과에 «부상 결석 정산이 남아 있어요» 한 줄(반 이동이면 이월 길을 먼저 말한다)", async () => {
  const run = async (stillEnrolled) => {
    const updates = [];
    const log = [];
    const absences = ["2026-11-13", "2026-11-20"].map((date) => ({ id: date, date, status: "CONFIRMED", note: "기간 결석 · 질병", periodRow: true, billingResolved: false, carryCredit: false, makeupBooked: false, attendanceRecorded: false }));
    const db = {
      async $queryRawUnsafe(sql, ...values) {
        log.push({ sql, values });
        if (/to_regclass/.test(sql)) return [{ found: "x" }];
        if (/information_schema\.columns/.test(sql) && /'carryState'/.test(sql)) return [{ n: 1 }];
        if (/FROM "RegularAbsence" ra/.test(sql)) return absences;
        if (/COUNT\(\*\)::int AS n,/.test(sql) && /FROM "RegularAbsencePeriod" p/.test(sql)) return [{ n: 1, stillEnrolled }];
        return [];
      },
      async $executeRawUnsafe(sql, ...values) {
        log.push({ sql, values });
        if (/UPDATE "RegularAbsence" SET status = 'CANCELLED'/.test(sql)) { updates.push(values[0]); return 1; }
        return 0;
      },
    };
    const out = await cleanup.cleanupEndedClassInTx(db, { studentId: "s1", classId: "fri4", className: "금4", fromYmd: "2026-11-13", actorUserId: "admin" });
    return { out, updates, log };
  };
  const gone = await run(false);
  assert.deepEqual(gone.updates, ["2026-11-13", "2026-11-20"], "효력일 이후 결석은 승인된 기간이어도 취소한다");
  assert.deepEqual([gone.out.cancelledAbsences, gone.out.keptAbsences, gone.out.illnessSettle], [2, { billing: 0, makeup: 0, attendance: 0 }, { periods: 1, stillEnrolled: false }]);
  // 결석 조회는 효력일 이후만 읽는다(효력일 전 결석은 보지도 않는다) · 남은 정산을 세는 조회는 «이 반은 끝난 것으로» 센다
  const absenceQuery = gone.log.find((query) => /FROM "RegularAbsence" ra/.test(query.sql));
  assert.match(absenceQuery.sql, /ra\.date >= \$3::date AND ra\.status IN \('REPORTED','CONFIRMED'\)/);
  assert.doesNotMatch(absenceQuery.sql, /illnessSettlePending|pending_period/);
  const periodQuery = gone.log.find((query) => /FROM "RegularAbsencePeriod" p/.test(query.sql));
  assert.ok(periodQuery.sql.includes(rules.illnessHoldPeriodSql("p")));
  assert.match(periodQuery.sql, /other\."classId" <> \$2 AND other\.status <> 'WITHDRAWN'/);
  assert.match(periodQuery.sql, /still\."studentId" = \$1 AND still\."classId" <> \$2 AND still\.status <> 'WITHDRAWN'\) AS "stillEnrolled"/);
  assert.deepEqual(periodQuery.values, ["s1", "fri4"]);
  assert.equal(JSON.parse(gone.log.find((query) => /ENROLLMENT_END_CLEANUP/.test(query.sql)).values[1]).illnessSettlePeriods, 1);
  // 결과 문구 — 완전히 퇴원: 환불 검토 / 반 이동(다른 반 수강 중): 이월로 정산하거나 환불 검토
  assert.equal(cleanup.cleanupResultMessage({ ...cleanup.emptyCleanupSummary(), ...gone.out }), `결석 2건 취소 · ${rules.ENROLLMENT_END_ILLNESS_NOTE}`);
  const moved = await run(true);
  assert.deepEqual(moved.out.illnessSettle, { periods: 1, stillEnrolled: true });
  assert.equal(cleanup.cleanupResultMessage({ ...cleanup.emptyCleanupSummary(), ...moved.out }), `결석 2건 취소 · ${rules.ENROLLMENT_END_ILLNESS_MOVED_NOTE}`);
  assert.equal(rules.ENROLLMENT_END_ILLNESS_MOVED_NOTE, "부상 결석 정산이 남아 있어요 · 신청함에서 이월로 정산하거나 환불 검토로 넘겨 주세요");
  assert.match(rules.ENROLLMENT_END_ILLNESS_NOTE, /^부상 결석 정산이 남아 있어요/);
  assert.equal(cleanup.cleanupResultMessage(cleanup.emptyCleanupSummary()), "", "남은 정산이 없으면 예전 그대로");
  // 기간 정산 칸이 없는 DB: 없는 칸을 읽지 않는다
  const oldLog = [];
  const oldDb = { async $queryRawUnsafe(sql) { oldLog.push(sql); return /to_regclass/.test(sql) ? [{ found: null }] : []; }, async $executeRawUnsafe() { return 0; } };
  const old = await cleanup.cleanupEndedClassInTx(oldDb, { studentId: "s1", classId: "fri4", className: "금4", fromYmd: "2026-11-13", actorUserId: "admin" });
  assert.equal(old.illnessSettle, undefined);
  assert.ok(oldLog.every((sql) => !/"carryState"/.test(sql)), "carryState 를 읽지 않는다");
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
  assert.match(preview, /const read = await readSettlementPlan\(tx, period, countUntil, omit, ctx, false, await readRefundClassCutoffs\(tx, period\.studentId\)\);/);
  assert.doesNotMatch(preview, /lockCompensation|\$executeRawUnsafe|FOR UPDATE/);
  const send = slice(refundLib, "export async function sendIllnessPeriodToRefundReview(", "export type RefundDoneResult");
  assert.match(send, /const read = await readSettlementPlan\(tx, period, countUntil, omit, ctx, true, await readRefundClassCutoffs\(tx, period\.studentId\)\);/);
  assert.equal((refundLib.match(/refundCountUntil\(ctx\.todayYmd, period\.returnDate\)/g) ?? []).length, 2, "미리보기와 넘기기가 같은 «세는 끝»");
});

test("환불 검토로 넘기기: 스위치 → 전역 잠금 → 기간 행 → 학생 행 → 퇴원 확인 → 결석 잠금 뒤 다시 계산 → 지문이 같을 때만 · 조건부 UPDATE · 병합 저장", () => {
  const send = slice(refundLib, "export async function sendIllnessPeriodToRefundReview(", "export type RefundDoneResult");
  assert.ok(send.indexOf("if (!enabled) throw") < send.indexOf("db.$transaction("));
  const order = ["await lockCompensation(tx);", "WHERE p.id = $1 FOR UPDATE OF p", `FROM "Student" s WHERE s.id = $1 AND \${notMergedStudent("s")} FOR UPDATE`,
    "readIllnessPeriodWithdrawal(tx, periodId)", "await endAbsencePeriodInTx(tx,", "await readSettlementPlan(tx, period, countUntil, omit, ctx, true,",
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
  assert.match(send, /"부상 결석 환불 검토", `\$\{await childPrefix\(done\.studentId\)\}\$\{PERIOD_REFUND_REVIEW_NOTICE\}`/);
  assert.match(done, /"부상 결석 환불 처리", `\$\{await childPrefix\(done\.studentId\)\}\$\{PERIOD_REFUND_DONE_NOTICE\}`/);
  // 알림 본문에 금액이 들어갈 길이 없다(알림을 보내는 줄에 금액 값이 없다)
  for (const body of [send, done]) assert.doesNotMatch(body.split("\n").filter((line) => line.includes("notifyParentOnce(")).join("\n"), /refundTotal|toLocaleString/);
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
  // 완전히 퇴원했으면 환불 검토만 · 반만 옮긴 아이(다른 반 수강 중)는 이월이 기본이고 환불 검토는 원장이 고를 때만
  assert.match(detail, /const refundPath = approved && withdrawal\?\.withdrawn === true && \(!withdrawal\.stillEnrolled \|\| useRefund\);/);
  assert.match(detail, /\{refundPath \? "이월로 정산하기" : "환불 검토로 넘기기"\}/);
  assert.match(detail, /\{withdrawal\?\.withdrawn && detail\.periodStatus === "ENDED" && \(\s+<p[^>]*>\{REFUND_PERIOD_CLOSED_NOTE\}<\/p>/);
  assert.equal(rules.REFUND_PERIOD_CLOSED_NOTE, "이 기간은 닫혀 있어요. 재등록하면 결석 기간을 새로 등록해 주세요.");
  assert.match(detail, /carryState="APPROVED" refund=\{refundPath\}/);
  assert.match(detail, /detail\.carryState === "REFUND_REVIEW" \|\| detail\.carryState === "REFUND_DONE" \? \(\s+\/\/[^\n]*\n\s+<IllnessPeriodRefundBox /);
  // 학생 상세 기간 줄 상태 글자
  const panel = read("src/app/admin/students/[id]/AbsencePeriodPanel.tsx");
  assert.match(panel, /\? <span>\{PERIOD_REFUND_STUDENT_LABELS\.WITHDRAWN\}<\/span>/);
  assert.match(panel, /<span>\{PERIOD_REFUND_STUDENT_LABELS\[p\.carryState\]\}<\/span>/);
});

// ── 보안 검수 반영(2026-11-15) ──────────────────────────────────────────────────────────────
test("보안 검수: 환불 처리 메모는 원장에게만 내려간다 — 메모에 환불 금액이 적히므로 부원장 응답에서는 null", () => {
  const memo = "11/20 카드 취소 84,000원";
  assert.equal(viewOf({ stage: "DONE", memo }).refund.memo, memo, "원장");
  const vice = viewOf({ stage: "DONE", money: false, memo });
  assert.equal(vice.refund.memo, null, "부원장");
  assert.deepEqual([vice.refund.stage, vice.state, vice.carryTotal], ["DONE", "SETTLED", null], "상태는 그대로 내려간다");
  const wire = JSON.stringify(vice);
  for (const secret of [memo, "84,000", "카드 취소"]) assert.ok(!wire.includes(secret), `부원장 응답에 ${secret}`);
  // 넘기기 전·환불 검토 중에는 누구에게도 메모가 없다
  for (const stage of ["PREVIEW", "REVIEW"]) assert.equal(viewOf({ stage, memo }).refund.memo, null, stage);
  // 화면: 부원장에게는 메모 대신 상태를 그대로 말한다
  assert.match(read("src/app/admin/inbox/IllnessPeriodRefundBox.tsx"), /\{done \? "환불 처리 완료 · 메모는 원장만 볼 수 있어요" : "금액과 환불 처리는 원장만 볼 수 있습니다\."\}/);
});

test("보안 검수: 금액이 정해진 기간은 학부모 «복귀했어요·알림 취소»를 서버에서 거절 — 학부모가 알린 기간·학원 등록 기간 같은 조건", () => {
  for (const state of ["SETTLED", "REFUND_REVIEW", "REFUND_DONE"]) assert.equal(rules.parentPeriodChangeLocked(state), true, state);
  for (const state of ["NONE", "APPROVED", null, undefined, ""]) assert.equal(rules.parentPeriodChangeLocked(state), false, String(state));
  assert.deepEqual([rules.PARENT_PERIOD_SETTLED_CODE, rules.PARENT_PERIOD_SETTLED_MESSAGE], ["PERIOD_SETTLED", "정산이 끝난 기간이라 바꿀 수 없어요."]);
  // 학부모가 알린 기간: 기간 행을 잠근 «뒤에» 정산 상태를 읽어 거절한다(실행 테스트는 tests/change-deadline-and-move.test.mjs)
  const parentPeriods = read("src/lib/regular/parent-absence-period.ts");
  const close = slice(parentPeriods, "export async function closeParentAbsencePeriod(", "const now = kstNow();");
  const order = ["FOR UPDATE OF p`", `if (!period) throw new Error("PERIOD_NOT_FOUND");`, "if (await periodCarryColumnsReady(tx)) {", "if (parentPeriodChangeLocked(carry[0]?.carryState)) throw new Error(PARENT_PERIOD_SETTLED_CODE);", `if (period.status !== "ACTIVE") throw new Error("PERIOD_ALREADY_CLOSED");`];
  order.reduce((from, piece) => { const at = close.indexOf(piece, from); assert.ok(at >= from, `순서가 어긋남: ${piece}`); return at; }, 0);
  // 학원이 등록한 기간: 같은 규칙 함수 · 복귀 처리(endAbsencePeriodInTx)보다 먼저
  const academy = slice(read("src/lib/regular/parent-period-settlement.ts"), "export async function returnAcademyIllnessPeriod(");
  assert.match(academy, /if \(parentPeriodChangeLocked\(period\.carryState\)\) throw new Error\(PARENT_PERIOD_SETTLED_CODE\);/);
  assert.ok(academy.indexOf("parentPeriodChangeLocked(period.carryState)") < academy.indexOf("await endAbsencePeriodInTx(tx,"));
  assert.ok(academy.indexOf("FOR UPDATE OF p") < academy.indexOf("parentPeriodChangeLocked(period.carryState)"), "잠근 뒤에 본다");
  // API 가 그 코드를 학부모 문구로 바꾼다(«학원에 문의» 대신 상태를 그대로)
  const route = read("src/app/api/mypage/regular-absence/period/route.ts");
  assert.ok(route.includes(`${rules.PARENT_PERIOD_SETTLED_CODE}: "${rules.PARENT_PERIOD_SETTLED_MESSAGE}",`));
});

// ── 코드 리뷰 반영(2026-11-15) ──────────────────────────────────────────────────────────────
test("코드 리뷰: 완전히 퇴원한 아이는 «이월 확정»을 서버에서 거절한다 — 반만 옮긴 아이(다른 반 수강 중)는 이월로 정산할 수 있다", () => {
  const service = read("src/lib/regular/illness-period-settlement.ts");
  const settle = slice(service, "export async function settleIllnessPeriod(", "export type CancelSettlementResult");
  assert.match(settle, /SELECT \(\$\{illnessWithdrawnSql\("p"\)\} AND NOT EXISTS \(\s+SELECT 1 FROM "Enrollment" any_enrollment\s+WHERE any_enrollment\."studentId" = p\."studentId" AND any_enrollment\.status <> 'WITHDRAWN'\)\) AS gone/);
  assert.match(settle, /if \(gone\[0\]\?\.gone === true\) throw new IllnessPeriodError\(SETTLE_WITHDRAWN_BLOCKED\);/);
  assert.ok(settle.indexOf("SETTLE_WITHDRAWN_BLOCKED") < settle.indexOf("await endAbsencePeriodInTx(tx,"), "복귀 처리·적립보다 먼저");
  assert.ok(settle.indexOf("FOR UPDATE OF p") < settle.indexOf("SETTLE_WITHDRAWN_BLOCKED"), "기간 행을 잠근 뒤");
  assert.equal(rules.SETTLE_WITHDRAWN_BLOCKED, "퇴원한 아이는 환불 검토로 넘겨 주세요.");
});

test("코드 리뷰: 확정·환불 검토로 넘길 때 새로 만든 검토 줄을 기록하고, 취소 때 «승인이 만든 검토 줄»에 합친다(승인 취소 때 함께 지워진다)", () => {
  const service = read("src/lib/regular/illness-period-settlement.ts");
  for (const [name, source] of [["확정", slice(service, "export async function settleIllnessPeriod(", "export type CancelSettlementResult")], ["넘기기", slice(refundLib, "export async function sendIllnessPeriodToRefundReview(", "export type RefundDoneResult")]]) {
    assert.ok(source.indexOf("createdReviewAbsenceIds = await newReviewAbsenceIds(tx, handled);") < source.indexOf(`INSERT INTO "RegularAbsenceCarryReview"`), `${name}: 검토 줄을 넣기 전에 «없던 것»을 센다`);
    assert.match(source, /confirmedAbsenceIds, createdReviewAbsenceIds,/, `${name}: 표 사본에 기록`);
  }
  for (const [name, source] of [["확정 취소", slice(service, "export async function cancelIllnessPeriodSettlement(", "/** 확정된 기간의 표 사본(화면용)")], ["환불 검토 취소", slice(refundLib, "export async function cancelIllnessPeriodRefundReview(", "export type RefundIllnessPeriod")]]) {
    assert.match(source, /createdReviewAbsenceIds: \[\.\.\.new Set\(\[\.\.\.approval\.createdReviewAbsenceIds, \.\.\.cleanIds\(record\.createdReviewAbsenceIds\)\]\)\],/, name);
  }
  assert.match(service, /WHERE NOT EXISTS \(SELECT 1 FROM "RegularAbsenceCarryReview" r WHERE r\."absenceId" = target\.id\) ORDER BY target\.id/);
});

test("코드 리뷰: 실제 납부액보다 표 금액이 큰 달의 경고는 원장에게만 내려간다(금액이 들어 있다)", () => {
  const note = "11월 월요반: 이 달은 실제 납부액 60,000원보다 표 금액이 커요 · 수납 관리 환불은 납부액까지만 돼요";
  assert.deepEqual(viewOf({ ownerNotes: [note] }).refund.ownerNotes, [note]);
  const vice = viewOf({ money: false, ownerNotes: [note] });
  assert.deepEqual(vice.refund.ownerNotes, []);
  assert.ok(!JSON.stringify(vice).includes("60,000"));
  assert.deepEqual(viewOf({}).refund.ownerNotes, [], "경고가 없으면 빈 목록");
  // 근거 금액(표)과 그 청구의 실제 납부액을 견준다 · 지문에는 넣지 않는다(안내일 뿐)
  assert.match(refundLib, /if \(Number\.isSafeInteger\(paidAmount\) && row\.tuition > paidAmount\) \{/);
  assert.match(refundLib, /SELECT p\.amount FROM "Payment" p WHERE p\.id = \$1/);
  for (const file of ["src/app/admin/inbox/IllnessPeriodRefundBox.tsx", "src/app/admin/inbox/IllnessPeriodSettlementBox.tsx"]) assert.match(read(file), /ownerNotes/);
});

test("재검수: 종료일 기록이 없어 자르지 못한 반은 원장에게 알린다 — 표에 넣은 결석이 있는 끝난 반만", () => {
  const rows = [
    { classId: "fri", className: "금요반", included: 2 },   // 끝났고 기록 없음 → 알림
    { classId: "fri", className: "금요반", included: 1 },   // 같은 반은 한 줄만
    { classId: "mon", className: "월요반", included: 3 },   // 종료 기록 있음(잘랐다)
    { classId: "wed", className: "수요반", included: 1 },   // 지금 다니는 반
    { classId: "sat", className: "토요반", included: 0 },   // 표에 넣은 결석 없음
  ];
  const notes = rules.refundUncutClassNotes(rows, new Map([["mon", "2026-11-13"]]), new Set(["wed"]));
  assert.deepEqual(notes, ["금요반은 수강 종료일 기록이 없어 오늘까지 셌어요 · 퇴원일 이후 날짜는 표에서 빼 주세요"]);
  assert.deepEqual(rules.refundUncutClassNotes([], new Map(), new Set()), []);
  // 원장에게만 내려간다(기존 ownerNotes 길 — 부원장은 빈 목록)
  assert.deepEqual(viewOf({ ownerNotes: notes }).refund.ownerNotes, notes);
  assert.deepEqual(viewOf({ money: false, ownerNotes: notes }).refund.ownerNotes, []);
  // 미리보기·넘기기 모두 같은 함수로 만든다
  assert.equal((refundLib.match(/ownerNotes: await readPaidShortfallNotes\(tx, period\.studentId, read\),/g) ?? []).length, 2);
  assert.match(refundLib, /SELECT e\."classId" AS "classId" FROM "Enrollment" e WHERE e\."studentId" = \$1 AND e\.status <> 'WITHDRAWN'/);
});
