import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error -- Node's type-stripping runner needs the runtime extension.
import { chooseRepresentative, countActive, finalEnrollmentStatuses, conflictPairsSql, isBillingRowMovable, moveGuardSql, moveSkipNote, promoteRowSql, shouldPromoteOnConflict, planEnrollmentMerge, SOFT_SKIP_STATUS, statusPriority, type EnrollmentRow, type MergeCandidate } from "./plan.ts";
// @ts-expect-error -- Node's type-stripping runner needs the runtime extension.
import { STUDENT_REF_TABLES, type StudentRefTable } from "./tables.ts";

function refTable(name: string): StudentRefTable {
  const t = STUDENT_REF_TABLES.find((x: StudentRefTable) => x.table === name);
  assert.ok(t, `${name} 이(가) STUDENT_REF_TABLES 에 없다`);
  return t;
}

function candidate(
  id: string,
  billing: number,
  childRows: number,
  createdAt: string,
  enrollments: EnrollmentRow[] = [],
): MergeCandidate {
  return {
    id,
    liveBillingCountFromFreeze: billing,
    liveChildRowCount: childRows,
    createdAt,
    enrollments,
  };
}

test("8월 확정 청구가 붙은 쪽이 무조건 대표가 된다", () => {
  const a = candidate("A", 0, 9999, "2026-03-31T05:58:00Z");
  const b = candidate("B", 1, 3, "2026-07-12T09:19:00Z");
  const pick = chooseRepresentative(a, b);
  assert.equal(pick.winnerId, "B");
  assert.equal(pick.loserId, "A");
  assert.equal(pick.rule, "FROZEN_BILLING");
});

test("8월 청구가 양쪽에 다 있으면 자동 판단하지 않고 멈춘다", () => {
  const a = candidate("A", 1, 10, "2026-03-31T05:58:00Z");
  const b = candidate("B", 2, 10, "2026-07-12T09:19:00Z");
  assert.throws(() => chooseRepresentative(a, b), /자동 대표 선정 불가/);
});

test("8월 청구가 양쪽 다 없으면 살아있는 기록이 많은 쪽이 대표", () => {
  const a = candidate("A", 0, 28, "2026-03-31T05:58:00Z");
  const b = candidate("B", 0, 231, "2026-07-14T01:10:00Z");
  const pick = chooseRepresentative(a, b);
  assert.equal(pick.winnerId, "B");
  assert.equal(pick.rule, "CHILD_ROWS");
});

test("청구도 기록도 동률이면 먼저 만들어진 쪽이 대표", () => {
  const a = candidate("A", 0, 5, "2026-03-31T05:58:00Z");
  const b = candidate("B", 0, 5, "2026-07-12T09:20:00Z");
  const pick = chooseRepresentative(a, b);
  assert.equal(pick.winnerId, "A");
  assert.equal(pick.rule, "CREATED_FIRST");
});

test("수강 상태 우선순위는 ACTIVE > PAUSED > WITHDRAWN, 모르는 값은 최하위", () => {
  assert.ok(statusPriority("ACTIVE") > statusPriority("PAUSED"));
  assert.ok(statusPriority("PAUSED") > statusPriority("WITHDRAWN"));
  assert.equal(statusPriority("알수없음"), 0);
});

test("겹치지 않는 반은 그대로 이동한다", () => {
  const plan = planEnrollmentMerge(
    [{ id: "w1", classId: "Sun-8", status: "ACTIVE" }],
    [{ id: "l1", classId: "Mon-4", status: "ACTIVE" }],
  );
  assert.deepEqual(plan.move, [{ enrollmentId: "l1", classId: "Mon-4", status: "ACTIVE" }]);
  assert.equal(plan.promote.length, 0);
  assert.equal(plan.softSkip.length, 0);
});

test("같은 반이 겹치면 하드 삭제 없이 대표 쪽 상태를 올리고 흡수 쪽은 남긴다", () => {
  const plan = planEnrollmentMerge(
    [{ id: "w1", classId: "Wed-7", status: "PAUSED" }],
    [{ id: "l1", classId: "Wed-7", status: "ACTIVE" }],
  );
  assert.deepEqual(plan.promote, [
    { enrollmentId: "w1", classId: "Wed-7", fromStatus: "PAUSED", toStatus: "ACTIVE" },
  ]);
  assert.equal(plan.move.length, 0, "UNIQUE 충돌이므로 옮기면 안 된다");
  assert.deepEqual(plan.softSkip, [
    {
      enrollmentId: "l1",
      classId: "Wed-7",
      fromStatus: "ACTIVE",
      toStatus: SOFT_SKIP_STATUS,
      supersededBy: "w1",
    },
  ]);
});

test("대표 쪽이 더 살아있으면 상태를 낮추지 않는다", () => {
  const plan = planEnrollmentMerge(
    [{ id: "w1", classId: "Tue-5", status: "ACTIVE" }],
    [{ id: "l1", classId: "Tue-5", status: "PAUSED" }],
  );
  assert.equal(plan.promote.length, 0);
  assert.equal(plan.softSkip.length, 1);
});

test("박하준 실측 케이스: 병합 후 정확히 3개 반이 ACTIVE여야 한다", () => {
  // 대표 A: 일8 ACTIVE + 수7 PAUSED / 흡수 B: 월4 ACTIVE + 수7 ACTIVE
  const winner: EnrollmentRow[] = [
    { id: "a-sun8", classId: "Sun-8", status: "ACTIVE" },
    { id: "a-wed7", classId: "Wed-7", status: "PAUSED" },
  ];
  const loser: EnrollmentRow[] = [
    { id: "b-mon4", classId: "Mon-4", status: "ACTIVE" },
    { id: "b-wed7", classId: "Wed-7", status: "ACTIVE" },
  ];
  const plan = planEnrollmentMerge(winner, loser);
  const final = finalEnrollmentStatuses(winner, plan);

  assert.equal(countActive(final), 3);
  assert.equal(final.get("Sun-8"), "ACTIVE");
  assert.equal(final.get("Mon-4"), "ACTIVE");
  assert.equal(final.get("Wed-7"), "ACTIVE");
});

test("최현 실측 케이스: PAUSED가 WITHDRAWN을 이겨 대표 행이 승격된다", () => {
  const winner: EnrollmentRow[] = [{ id: "b-mon7", classId: "Mon-7", status: "WITHDRAWN" }];
  const loser: EnrollmentRow[] = [
    { id: "a-fri7", classId: "Fri-7", status: "PAUSED" },
    { id: "a-mon7", classId: "Mon-7", status: "PAUSED" },
  ];
  const plan = planEnrollmentMerge(winner, loser);
  assert.deepEqual(plan.move, [{ enrollmentId: "a-fri7", classId: "Fri-7", status: "PAUSED" }]);
  assert.equal(plan.promote[0]?.toStatus, "PAUSED");
  assert.equal(countActive(finalEnrollmentStatuses(winner, plan)), 0);
});

test("청구 이동 가드: 2026-08 이후는 절대 옮기지 않는다", () => {
  assert.equal(isBillingRowMovable(2026, 7), true);
  assert.equal(isBillingRowMovable(2026, 6), true);
  assert.equal(isBillingRowMovable(2025, 12), true);
  assert.equal(isBillingRowMovable(2026, 8), false);
  assert.equal(isBillingRowMovable(2026, 9), false);
  assert.equal(isBillingRowMovable(2027, 1), false);
});

test("이동 가드: 충돌 키가 없는 기록 테이블은 조건 없이 전부 옮긴다", () => {
  assert.equal(moveGuardSql(refTable("ParentOperationsRequestLink"), "'W'"), "");
  assert.equal(moveGuardSql(refTable("KakaoParentIntake"), "'W'"), "");
  assert.equal(moveGuardSql(refTable("OperationsCommand"), "'W'"), "");
});

test("이동 가드: 보강권은 같은 원천(sourceKey)이 대표에게 있으면 옮기지 않는다", () => {
  const sql = moveGuardSql(refTable("MakeupCredit"), "'W'");
  assert.match(sql, /AND NOT EXISTS/);
  assert.match(sql, /rival\."studentId" = 'W'/);
  assert.match(sql, /rival\."sourceKey" IS NOT DISTINCT FROM src\."sourceKey"/);
});

test("이동 가드: 정규 결석은 반·날짜 조합으로 충돌을 본다", () => {
  const sql = moveGuardSql(refTable("RegularAbsence"), "'W'");
  assert.match(sql, /rival\."classId" IS NOT DISTINCT FROM src\."classId"/);
  assert.match(sql, /rival\."date" IS NOT DISTINCT FROM src\."date"/);
});

test("이동 가드: 셔틀 당일 예외는 취소 안 된 행끼리만 충돌로 본다(부분 UNIQUE)", () => {
  const sql = moveGuardSql(refTable("ShuttleDayException"), "'W'");
  // 흡수 쪽 행이 취소된 것이면 대표에 같은 날이 있어도 옮길 수 있어야 한다.
  assert.match(sql, /AND NOT \(src\."canceledAt" IS NULL AND EXISTS/);
  assert.match(sql, /rival\."canceledAt" IS NULL/);
  assert.match(sql, /rival\."serviceDate" IS NOT DISTINCT FROM src\."serviceDate"/);
  assert.match(sql, /rival\."direction" IS NOT DISTINCT FROM src\."direction"/);
});

test("이동 가드: 학부모 납부요청은 Payment가 대표에게 갔을 때만 따라간다(동결분은 같이 남음)", () => {
  const t = refTable("PaymentParentRequest");
  assert.equal(t.billingScoped, true);
  const sql = moveGuardSql(t, "'W'");
  assert.match(sql, /FROM "Payment" parent/);
  assert.match(sql, /parent\.id = src\."paymentId" AND parent\."studentId" = 'W'/);
  assert.match(moveSkipNote(t), /부모 행\(Payment\)/);
});

test("이동 가드: POS 결제 알림은 연결된 청구를 따라가고, 청구 연결이 없으면 옮긴다", () => {
  const t = refTable("PosPaymentNotice");
  assert.equal(t.column, "resolvedStudentId");
  assert.equal(t.billingScoped, true);
  assert.match(moveGuardSql(t, "'W'"), /src\."sitePaymentId" IS NULL OR EXISTS/);
});

test("이동 가드: 수강 변경 신청은 대상 수강과 청구 둘 다 대표 쪽일 때만 옮긴다", () => {
  const sql = moveGuardSql(refTable("EnrollmentChangeRequest"), "'W'");
  assert.match(sql, /FROM "Enrollment" parent[\s\S]*src\."enrollmentId"/);
  assert.match(sql, /FROM "Payment" parent[\s\S]*src\."invoicedPaymentId"/);
});

test("이동 가드: 월별 수강 대장(+이력)은 payload CHECK 때문에 한 행도 옮기지 않고 사유를 남긴다", () => {
  // CHECK: payload->>'studentId' = "studentId". 컬럼만 바꾸면 병합 트랜잭션 전체가 실패한다.
  for (const name of ["MonthlyEnrollmentRegister", "MonthlyEnrollmentRegisterRevision"]) {
    const t = refTable(name);
    assert.equal(moveGuardSql(t, "'W'"), " AND false");
    assert.match(moveSkipNote(t), /흡수 쪽에 남김/);
  }
});

test("이동 가드: 기존 충돌 규칙(출석 sessionId)은 예전 SQL 과 같다", () => {
  const sql = moveGuardSql(refTable("Attendance"), "'W'");
  assert.equal(
    sql.replace(/\s+/g, " ").trim(),
    `AND NOT EXISTS ( SELECT 1 FROM "Attendance" rival WHERE rival."studentId" = 'W' AND (rival."sessionId" IS NOT DISTINCT FROM src."sessionId") )`,
  );
});

test("결석 충돌 승계: 흡수 쪽이 더 살아있을 때만 대표 행이 상태를 이어받는다", () => {
  const p = refTable("RegularAbsence").promoteOnConflict!.priority;
  // 대표 취소 + 흡수 신고/확인 → 승계 (안 하면 살아있는 결석이 숨겨져 기사가 기다린다)
  assert.equal(shouldPromoteOnConflict(p, "CANCELLED", "REPORTED"), true);
  assert.equal(shouldPromoteOnConflict(p, "CANCELLED", "CONFIRMED"), true);
  assert.equal(shouldPromoteOnConflict(p, "REPORTED", "CONFIRMED"), true);
  // 대표가 같거나 더 살아있으면 그대로
  assert.equal(shouldPromoteOnConflict(p, "REPORTED", "REPORTED"), false);
  assert.equal(shouldPromoteOnConflict(p, "CONFIRMED", "REPORTED"), false);
  assert.equal(shouldPromoteOnConflict(p, "REPORTED", "CANCELLED"), false);
  // 모르는 상태로는 승계하지 않는다
  assert.equal(shouldPromoteOnConflict(p, "CANCELLED", "UNKNOWN"), false);
  assert.equal(shouldPromoteOnConflict(p, null, null), false);
});

test("결석 충돌 승계 SQL: 같은 반·날짜 쌍을 찾고, updatedAt·학생·키는 건드리지 않는다", () => {
  const t = refTable("RegularAbsence");
  const pairs = conflictPairsSql(t, "'W'", "'L'");
  assert.match(pairs, /JOIN "RegularAbsence" w ON w\."studentId" = 'W'/);
  assert.match(pairs, /\(w\."classId" IS NOT DISTINCT FROM l\."classId"\)/);
  assert.match(pairs, /\(w\."date" IS NOT DISTINCT FROM l\."date"\)/);
  assert.match(pairs, /WHERE l\."studentId" = 'L'/);
  assert.match(pairs, /w\."status"::text AS "w:status", l\."status"::text AS "l:status"/);

  const upd = promoteRowSql(t, "'wr'", "'lr'");
  assert.match(upd, /^UPDATE "RegularAbsence" w SET "status" = l\."status", "reason" = l\."reason"/);
  assert.match(upd, /WHERE w\.id = 'wr' AND l\.id = 'lr'/);
  for (const forbidden of ["updatedAt", "studentId", "classId", "date", "createdAt"]) {
    assert.doesNotMatch(upd, new RegExp(`"${forbidden}" =`), `${forbidden} 는 승계하면 안 된다`);
  }
});
