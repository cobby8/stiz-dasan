// 부상·질병 «기간 결석» 퇴원 정산 — 환불 검토(4단계, 2026-11-15 원장 결정)
//
// 부상 결석 중에 복귀하지 않고 퇴원하면(그 기간의 대상 반이 모두 수강 종료), 복귀 정산과 «같은 읽기·같은 계산·같은 지문»으로
// 정산표를 만들어 «환불 검토 ○원»으로 올린다. 비유: 계산서만 뽑아 원장 책상에 올려 두는 일이다.
//
// ★ 이 파일은 돈을 움직이지 않는다. 결제·환불·토스·현장 결제 코드를 부르지 않고, 청구(Payment) 행도 고치지 않는다.
//   환불은 원장이 수납 관리의 «환불»로 직접 하고, 끝나면 «환불 처리함»(메모)으로 닫는다.
//
// 복귀 정산(이월 확정)과 다른 점은 셋뿐이다:
//   ① 이월(BillingCarryCredit)을 만들지 않는다 — 차감할 다음 청구가 없다.
//   ② 넣은 결석마다 정산 기록(BillingAbsenceResolution · CARRY · 사유 «퇴원 정산 — 환불 검토»)만 남긴다 — 그 결석으로
//      보강권이 다시 나가거나 하루씩 이월되는 이중 보상을 막는다.
//   ③ 기간 상태가 APPROVED → REFUND_REVIEW → (환불 처리함) REFUND_DONE 으로 간다. REFUND_DONE 은 되돌리지 않는다.
// 낸 돈이 없는 달은 환불할 돈이 없다 — 표에 «청구 없음»으로만 보이고, 보류로 돌린 미납 청구는 취소된 채 둔다.
//
// 잠금 순서는 복귀 정산과 같다(교착 금지): 작업대 전역 잠금 → 기간 행 → 학생 행 → 결석 행 → 근거 행.
// 격리 수준은 DB 기본(READ COMMITTED) — 잠근 «뒤에» 다시 읽는 납부 상태·결석이 최신이어야 한다(복귀 정산 확정과 같다).
// carrySettlement 는 «병합» 저장한다(승인 기록 approval · 보류로 돌린 청구 held 를 지우지 않는다).
//
// DB 는 인자(db)로만 받는다 — 테스트가 실제 PostgreSQL 로 실행한다. 이 파일은 prisma 를 import 하지 않는다.
import { lockCompensation } from "@/lib/billing/absence-compensation-guard";
import { notMergedStudent } from "@/lib/studentVisibility";
import { endAbsencePeriodInTx, periodCarryColumnsReady } from "@/lib/regular/absence-period-service";
import { illnessReviewReady, type IllnessTx } from "@/lib/regular/illness-carry-tx";
import { ILLNESS_REASON } from "@/lib/regular/illnessCarryRules";
import {
  IllnessPeriodError, REFUND_MEMO_MAX, REFUND_RESOLUTION_REASON, illnessWithdrawnSql, parsePeriodApprovalRecord, parseRefundRecord,
  parseSettlementSummary, refundCountUntil,
} from "@/lib/regular/illnessPeriodRules";
import {
  PERIOD_SELECT, READ_TX_OPTIONS, SETTLE_TX_OPTIONS, cleanId, cleanIds, readSettlementPlan, tableExists,
  type PeriodRow, type SettlementContext, type SettlementDb, type SettlementPreview,
} from "@/lib/regular/illness-period-settlement";
import type { SettlementPlan } from "@/lib/regular/illnessPeriodSettlementPlan";

/** 대상 반에 아직 다니는 반이 있는 기간 — 퇴원 정산이 아니라 복귀 정산(이월) 대상이다 */
export const REFUND_NOT_WITHDRAWN_MESSAGE = "수강 중인 대상 반이 있어 환불 검토로 넘길 수 없습니다. 복귀한 뒤 ‹정산하기›로 이월을 확정해 주세요.";
/** 넣을 결석이 하나도 없는 기간 — 넘길 것이 없다 */
export const REFUND_NOTHING_MESSAGE = "환불 검토에 넣을 결석이 없어요. ‹승인 취소›로 정리해 주세요.";

/** 지금 상태에서 환불 검토로 넘길 수 없는 이유(넘길 수 있으면 null) */
function stateBlocker(period: PeriodRow): string | null {
  if (period.carryState === "REFUND_REVIEW") return "이미 환불 검토로 넘긴 기간입니다.";
  if (period.carryState === "REFUND_DONE") return "이미 환불 처리한 기간입니다.";
  if (period.carryState === "SETTLED") return "이미 이월을 확정한 기간입니다.";
  if (period.carryState !== "APPROVED") return "부상 결석으로 승인된 기간만 정산할 수 있습니다.";
  if (period.status === "CANCELLED") return "등록 취소된 기간 결석입니다.";
  return null;
}

export type IllnessPeriodWithdrawal = {
  /** 승인됐고 금액 미확정인데 대상 반이 모두 수강 종료됐다 = «정산 필요 · 퇴원» */
  withdrawn: boolean;
  /** 그 학생이 (대상 반이 아닌) 다른 반은 아직 다닌다 — 반만 옮긴 경우. 이월로 정산하는 길도 남겨 둔다 */
  stillEnrolled: boolean;
};

/** 그 기간이 퇴원 정산 대상인가 — 판정 조각(illnessWithdrawnSql) 한 곳. 읽기만 한다 */
export async function readIllnessPeriodWithdrawal(tx: IllnessTx, periodId: string): Promise<IllnessPeriodWithdrawal> {
  const rows = await tx.$queryRawUnsafe<Array<{ withdrawn: boolean; stillEnrolled: boolean }>>(
    `SELECT ${illnessWithdrawnSql("p")} AS withdrawn,
            EXISTS (SELECT 1 FROM "Enrollment" any_enrollment
                     WHERE any_enrollment."studentId" = p."studentId" AND any_enrollment.status <> 'WITHDRAWN') AS "stillEnrolled"
       FROM "RegularAbsencePeriod" p WHERE p.id = $1`,
    periodId,
  );
  return { withdrawn: rows[0]?.withdrawn === true, stillEnrolled: rows[0]?.stillEnrolled === true };
}

export type RefundPreview = SettlementPreview & IllnessPeriodWithdrawal;

/**
 * 퇴원 정산 미리보기 — 읽기만 한다(잠금 없음). 복귀 정산 미리보기와 같은 읽기 함수(readSettlementPlan)·같은 계산·같은 지문이다.
 * 복귀일이 없으므로 «오늘까지 빠진 수업»만 센다(refundCountUntil — 복귀일이 이미 저장돼 있고 더 이르면 그날까지).
 * plan.carryTotal 이 «환불 검토 금액»이다(낸 돈이 있는 달의 빠진 수업 값 합계 — 분수로 더해 한 번 반올림).
 */
export async function previewIllnessPeriodRefund(
  db: SettlementDb, input: { periodId: string; omitAbsenceIds?: string[] }, ctx: SettlementContext,
): Promise<RefundPreview> {
  const periodId = cleanId(input?.periodId);
  const omit = cleanIds(input?.omitAbsenceIds);
  return db.$transaction(async (tx) => {
    if (!(await periodCarryColumnsReady(tx))) throw new IllnessPeriodError("기간 결석 정산 저장 구조를 확인해 주세요.", 503);
    const periods = await tx.$queryRawUnsafe<PeriodRow[]>(`${PERIOD_SELECT} WHERE p.id = $1`, periodId);
    const period = periods.find((row) => row.id === periodId) ?? null;
    if (!period || period.reason !== ILLNESS_REASON) throw new IllnessPeriodError("기간 결석을 찾을 수 없습니다.", 404);
    const withdrawal = await readIllnessPeriodWithdrawal(tx, periodId);
    const countUntil = refundCountUntil(ctx.todayYmd, period.returnDate);
    const read = await readSettlementPlan(tx, period, countUntil, omit, ctx, false);
    const state = stateBlocker(period);
    const blockers = [
      ...(state ? [state] : []),
      // 상태가 맞는데 대상 반을 아직 다니면 퇴원 정산이 아니다
      ...(!state && !withdrawal.withdrawn ? [REFUND_NOT_WITHDRAWN_MESSAGE] : []),
      ...read.plan.problems.map((problem) => problem.text),
      ...(read.plan.problems.length === 0 && read.plan.rows.every((row) => row.absenceIds.length === 0) ? [REFUND_NOTHING_MESSAGE] : []),
    ];
    return {
      periodId, studentId: period.studentId, periodStatus: period.status, carryState: period.carryState, parentReported: period.parentReported === true,
      startDate: period.startDate, returnDate: countUntil, storedReturnDate: period.returnDate,
      // 퇴원한 아이는 복귀일을 받지 않는다
      canSetReturnDate: false,
      plan: read.plan, fingerprint: read.fingerprint,
      // 이월이 아니라 환불 검토라 «쓸 수 있는 달»이 없다
      availableMonth: null, blockers, ...withdrawal,
    };
  }, READ_TX_OPTIONS);
}

export type RefundReviewResult = {
  periodId: string; studentId: string; startDate: string;
  /** 환불 검토 금액(낸 돈이 있는 달의 빠진 수업 값 합계) */
  refundTotal: number;
  /** 낸 돈이 있는 달의 결석 수 / 낸 돈이 없는 달이라 정산 기록만 남긴 결석 수 */
  refundAbsences: number; unpaidAbsences: number;
};

/**
 * [환불 검토로 넘기기] — 원장만(호출부가 확인). 미리보기에서 본 표(지문)와 잠근 뒤 다시 계산한 표가 같을 때만 실행한다.
 * 이월은 만들지 않는다. 넣은 결석마다 정산 기록만 남기고 기간 상태를 APPROVED → REFUND_REVIEW 로 바꾼다.
 *
 * @param enabled 청구 준비 저장 스위치 — 정산 기록(청구 준비가 읽는 표)을 쓰는 일이라 복귀 정산 확정과 같은 스위치를 본다
 */
export async function sendIllnessPeriodToRefundReview(
  db: SettlementDb, input: { periodId: string; omitAbsenceIds?: string[]; expectedFingerprint: string },
  actorId: string, enabled: boolean, ctx: SettlementContext,
): Promise<RefundReviewResult> {
  if (!enabled) throw new IllnessPeriodError("환불 검토로 넘기기는 청구 준비 저장이 켜진 뒤에 할 수 있습니다.", 503);
  if (!actorId) throw new IllnessPeriodError("관리자 확인이 필요합니다.", 403);
  const periodId = cleanId(input?.periodId);
  const omit = cleanIds(input?.omitAbsenceIds);
  const expected = typeof input?.expectedFingerprint === "string" ? input.expectedFingerprint : "";
  if (!/^[a-f0-9]{64}$/.test(expected)) throw new IllnessPeriodError("정산 내용을 다시 불러온 뒤 넘겨 주세요.", 400);

  return db.$transaction(async (tx) => {
    // ① 전역 잠금 → 기간 행
    await lockCompensation(tx);
    if (!(await periodCarryColumnsReady(tx))) throw new IllnessPeriodError("기간 결석 정산 저장 구조를 확인해 주세요.", 503);
    if (!(await tableExists(tx, "BillingAbsenceResolution"))) throw new IllnessPeriodError("정산 저장 구조를 확인해 주세요.", 503);
    const periods = await tx.$queryRawUnsafe<PeriodRow[]>(`${PERIOD_SELECT} WHERE p.id = $1 FOR UPDATE OF p`, periodId);
    const period = periods.find((row) => row.id === periodId) ?? null;
    if (!period || period.reason !== ILLNESS_REASON) throw new IllnessPeriodError("기간 결석을 찾을 수 없습니다.", 404);
    const state = stateBlocker(period);
    if (state) throw new IllnessPeriodError(state);

    // ② 학생 행(병합된 학생이면 멈춘다)
    const students = await tx.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT s.id FROM "Student" s WHERE s.id = $1 AND ${notMergedStudent("s")} FOR UPDATE`, period.studentId,
    );
    if (students.length !== 1) throw new IllnessPeriodError("통합되거나 변경된 학생입니다. 현재 학생으로 다시 확인해 주세요.");

    // ③ 퇴원했는가 — 잠근 뒤 다시 본다(그 사이 다시 등록했으면 이월로 정산할 일이다)
    if (!(await readIllnessPeriodWithdrawal(tx, periodId)).withdrawn) throw new IllnessPeriodError(REFUND_NOT_WITHDRAWN_MESSAGE);

    // ④ 진행 중인 학원 등록 기간이면 «오늘까지»로 닫는다(기존 복귀 처리 함수 — 그날 이후 결석 취소 · 기간 ENDED).
    //    닫지 않으면 나중에 그 아이가 다시 등록했을 때 매일 연장이 이 기간으로 결석을 계속 만든다.
    //    학부모가 알린 기간은 자동 연장이 없고 기간째 복귀 처리 대상도 아니라 그대로 둔다.
    const countUntil = refundCountUntil(ctx.todayYmd, period.returnDate);
    if (period.status === "ACTIVE" && period.parentReported !== true) {
      try {
        await endAbsencePeriodInTx(tx, { periodId, returnDate: countUntil }, { ...ctx, actorUserId: actorId });
      } catch (error) {
        if (error instanceof IllnessPeriodError) throw error;
        throw new IllnessPeriodError(error instanceof Error && error.message ? error.message : "기간을 닫지 못했습니다.");
      }
    }

    // ⑤ 결석 행을 잠그고 다시 계산 — 원장이 본 표와 같을 때만
    const read = await readSettlementPlan(tx, period, countUntil, omit, ctx, true);
    if (read.plan.problems.length > 0) throw new IllnessPeriodError(read.plan.problems[0].text);
    if (read.fingerprint !== expected) throw new IllnessPeriodError("정산 내용이 바뀌었습니다. 표를 다시 확인한 뒤 넘겨 주세요.");

    const refundAbsenceIds: string[] = [];
    const unpaidAbsenceIds: string[] = [];
    const confirmedAbsenceIds: string[] = [];
    for (const row of read.plan.rows) {
      const paid = row.evidence === "WORKBENCH_ISSUED" || row.evidence === "PAID_PAYMENT";
      for (const absenceId of row.absenceIds) {
        // 학부모가 알린 결석(REPORTED)은 이때 확정한다(복귀 정산과 같다 — 정산 기록은 확정된 결석에 남긴다)
        const confirmed = Number(await tx.$executeRawUnsafe(
          `UPDATE "RegularAbsence" SET status = 'CONFIRMED', "resolvedByUserId" = $2, "updatedAt" = now() WHERE id = $1 AND status = 'REPORTED'`,
          absenceId, actorId,
        ));
        if (confirmed > 0) confirmedAbsenceIds.push(absenceId);
        (paid ? refundAbsenceIds : unpaidAbsenceIds).push(absenceId);
        // 정산 기록만 남긴다(이월 행 없음) — 이 결석으로 보강권이 다시 나가거나 하루씩 이월되는 길을 막는다(PK = 결석 id)
        await tx.$executeRawUnsafe(
          `INSERT INTO "BillingAbsenceResolution" ("absenceId","studentId",resolution,reason,"evidenceConfirmed",eligibility,"actorUserId")
           VALUES ($1,$2,'CARRY',$3,true,$4,$5)`,
          absenceId, period.studentId, REFUND_RESOLUTION_REASON, ILLNESS_REASON, actorId,
        );
      }
    }
    const handled = [...refundAbsenceIds, ...unpaidAbsenceIds];
    if (handled.length === 0) throw new IllnessPeriodError(REFUND_NOTHING_MESSAGE);

    // 검토를 «승인»으로(없던 줄은 만든다), 미사용 보강권은 회수 — 복귀 정산 확정과 같은 처리(퇴원 뒤 그 결석으로 보강권이 나가지 않게)
    if (await illnessReviewReady(tx)) {
      await tx.$executeRawUnsafe(
        `INSERT INTO "RegularAbsenceCarryReview" ("absenceId", status, source, "decidedAt", "decidedBy", "decidedByUserId")
         SELECT target.id, 'APPROVED', 'STAFF', now(), 'ADMIN', $2::text FROM unnest($1::text[]) AS target(id)
         ON CONFLICT ("absenceId") DO UPDATE
            SET status = 'APPROVED', "decidedAt" = now(), "decidedBy" = 'ADMIN',
                "decidedByUserId" = EXCLUDED."decidedByUserId", "convertReason" = NULL, "updatedAt" = now()`,
        handled, actorId,
      );
    }
    const revoked = await tx.$queryRawUnsafe<Array<{ id: string }>>(
      `UPDATE "MakeupCredit" mc
          SET status = 'REVOKED', "makeupSessionId" = NULL, "updatedAt" = NOW()
         FROM "RegularAbsence" ra
        WHERE ra.id = ANY($1::text[]) AND mc."studentId" = ra."studentId"
          AND mc."sourceKey" = 'REGULAR:' || ra."classId" || ':' || to_char(ra.date, 'YYYY-MM-DD')
          AND mc.status IN ('AVAILABLE', 'EXPIRED')
       RETURNING mc.id`,
      handled,
    );

    // ⑥ 기간 상태 — «지금 APPROVED 일 때만». 표 사본은 병합 저장. 낸 돈이 없는 달 안내는 표 사본 «안»에 넣는다
    //    (기간 행 맨 위의 unpaidGuides 는 청구 준비가 «다닌 만큼만 청구» 제안에 읽는 칸이다 — 퇴원한 아이는 청구할 달이 없다)
    const settlement = {
      mode: "REFUND", fingerprint: read.fingerprint, returnDate: countUntil, availableMonth: null, carryTotal: read.plan.carryTotal,
      rows: read.plan.rows, unpaidGuides: read.plan.unpaidGuides, omitAbsenceIds: omit,
      refundAbsenceIds, unpaidAbsenceIds, confirmedAbsenceIds, revokedCreditIds: revoked.map((row) => row.id),
      todayYmd: ctx.todayYmd, calendarFingerprint: ctx.calendar?.fingerprint ?? null,
    };
    const changed = Number(await tx.$executeRawUnsafe(
      `UPDATE "RegularAbsencePeriod"
          SET "carryState" = 'REFUND_REVIEW', "carrySettledAt" = now(), "carrySettledByUserId" = $2,
              "carrySettlement" = COALESCE("carrySettlement", '{}'::jsonb) || $3::jsonb, "updatedAt" = now()
        WHERE id = $1 AND "carryState" = 'APPROVED'`,
      periodId, actorId, JSON.stringify({ settlement }),
    ));
    if (changed !== 1) throw new IllnessPeriodError("기간 상태가 바뀌어 넘기지 않았습니다. 다시 확인해 주세요.");
    await tx.$executeRawUnsafe(
      `INSERT INTO "OperationsAuditLog" (id, action, "actorType", "actorUserId", "detailsJson")
       VALUES (gen_random_uuid()::text, 'ILLNESS_PERIOD_REFUND_REVIEW', 'ADMIN', $1, $2::jsonb)`,
      actorId, JSON.stringify({ periodId, studentId: period.studentId, ...settlement }),
    );
    return {
      periodId, studentId: period.studentId, startDate: period.startDate, refundTotal: read.plan.carryTotal,
      refundAbsences: refundAbsenceIds.length, unpaidAbsences: unpaidAbsenceIds.length,
    };
  }, SETTLE_TX_OPTIONS);
}

export type RefundDoneResult = { periodId: string; studentId: string; startDate: string; refundTotal: number };

/**
 * [환불 처리함] — 원장만. 수납 관리에서 환불을 마친 뒤 메모와 함께 닫는다(REFUND_REVIEW → REFUND_DONE).
 * 여기서 환불이 실행되지 않는다 — «했다»는 기록만 남긴다. 조건부 UPDATE 라 두 번 눌러도 한 번만 된다. 되돌리지 않는다.
 */
export async function markIllnessPeriodRefundDone(
  db: SettlementDb, input: { periodId: string; memo: string }, actorId: string,
): Promise<RefundDoneResult> {
  if (!actorId) throw new IllnessPeriodError("관리자 확인이 필요합니다.", 403);
  const periodId = cleanId(input?.periodId);
  const memo = typeof input?.memo === "string" ? input.memo.trim() : "";
  if (!memo) throw new IllnessPeriodError("환불 처리 메모를 적어 주세요(환불한 날·방법·금액).", 400);
  if (memo.length > REFUND_MEMO_MAX) throw new IllnessPeriodError(`메모는 ${REFUND_MEMO_MAX}자까지 적을 수 있습니다.`, 400);

  return db.$transaction(async (tx) => {
    if (!(await periodCarryColumnsReady(tx))) throw new IllnessPeriodError("기간 결석 정산 저장 구조를 확인해 주세요.", 503);
    const periods = await tx.$queryRawUnsafe<PeriodRow[]>(`${PERIOD_SELECT} WHERE p.id = $1 FOR UPDATE OF p`, periodId);
    const period = periods.find((row) => row.id === periodId) ?? null;
    if (!period || period.reason !== ILLNESS_REASON) throw new IllnessPeriodError("기간 결석을 찾을 수 없습니다.", 404);
    if (period.carryState === "REFUND_DONE") throw new IllnessPeriodError("이미 환불 처리한 기간입니다.");
    if (period.carryState !== "REFUND_REVIEW") throw new IllnessPeriodError("환불 검토 중인 기간만 환불 처리할 수 있습니다.");
    const refundTotal = parseSettlementSummary(period.carrySettlement)?.carryTotal ?? 0;
    // 처리 시각은 DB 시계(시각 값 — 달력 날짜 계산이 아니다)
    const changed = Number(await tx.$executeRawUnsafe(
      `UPDATE "RegularAbsencePeriod"
          SET "carryState" = 'REFUND_DONE',
              "carrySettlement" = COALESCE("carrySettlement", '{}'::jsonb)
                || jsonb_build_object('refund', jsonb_build_object('memo', $2::text, 'doneByUserId', $3::text, 'doneAt', to_jsonb(now()))),
              "updatedAt" = now()
        WHERE id = $1 AND "carryState" = 'REFUND_REVIEW'`,
      periodId, memo, actorId,
    ));
    if (changed !== 1) throw new IllnessPeriodError("기간 상태가 바뀌어 처리하지 않았습니다. 다시 확인해 주세요.");
    await tx.$executeRawUnsafe(
      `INSERT INTO "OperationsAuditLog" (id, action, "actorType", "actorUserId", "detailsJson")
       VALUES (gen_random_uuid()::text, 'ILLNESS_PERIOD_REFUND_DONE', 'ADMIN', $1, $2::jsonb)`,
      actorId, JSON.stringify({ periodId, studentId: period.studentId, refundTotal, memo }),
    );
    return { periodId, studentId: period.studentId, startDate: period.startDate, refundTotal };
  }, SETTLE_TX_OPTIONS);
}

export type CancelRefundReviewResult = { periodId: string; studentId: string; resolutionsRemoved: number; reopened: number };

/**
 * [환불 검토 취소] — 원장만. 환불 검토로 넘긴 것을 넘기기 직전(APPROVED · 정산 필요 · 퇴원)으로 되돌린다.
 * 정산 기록을 지우기 전에 사본을 감사 기록에 남긴다. 환불 처리함(REFUND_DONE)까지 간 기간은 되돌리지 않는다.
 * 기간을 닫은 것(ENDED)과 검토 «승인»은 그대로 둔다 — 승인된 기간의 모양이다. 발행 보류가 다시 걸린다.
 */
export async function cancelIllnessPeriodRefundReview(
  db: SettlementDb, input: { periodId: string }, actorId: string, enabled: boolean,
): Promise<CancelRefundReviewResult> {
  if (!enabled) throw new IllnessPeriodError("환불 검토 취소는 청구 준비 저장이 켜진 뒤에 할 수 있습니다.", 503);
  if (!actorId) throw new IllnessPeriodError("관리자 확인이 필요합니다.", 403);
  const periodId = cleanId(input?.periodId);

  return db.$transaction(async (tx) => {
    await lockCompensation(tx);
    if (!(await periodCarryColumnsReady(tx))) throw new IllnessPeriodError("기간 결석 정산 저장 구조를 확인해 주세요.", 503);
    const periods = await tx.$queryRawUnsafe<PeriodRow[]>(`${PERIOD_SELECT} WHERE p.id = $1 FOR UPDATE OF p`, periodId);
    const period = periods.find((row) => row.id === periodId) ?? null;
    if (!period || period.reason !== ILLNESS_REASON) throw new IllnessPeriodError("기간 결석을 찾을 수 없습니다.", 404);
    if (period.carryState === "REFUND_DONE") throw new IllnessPeriodError("이미 환불 처리한 기간은 되돌릴 수 없습니다.");
    if (period.carryState !== "REFUND_REVIEW") throw new IllnessPeriodError("환불 검토 중인 기간만 취소할 수 있습니다.");

    const stored = (typeof period.carrySettlement === "string" ? JSON.parse(period.carrySettlement) : period.carrySettlement) as
      { settlement?: { refundAbsenceIds?: unknown; unpaidAbsenceIds?: unknown; confirmedAbsenceIds?: unknown; revokedCreditIds?: unknown } } | null;
    const record = stored?.settlement ?? {};
    const settledAbsenceIds = [...cleanIds(record.refundAbsenceIds), ...cleanIds(record.unpaidAbsenceIds)];

    // 이 정산이 남긴 기록만 — 이 기간의 결석이고, 사유가 퇴원 정산인 것
    const resolutions = settledAbsenceIds.length > 0
      ? await tx.$queryRawUnsafe<Array<Record<string, unknown>>>(
          `SELECT r."absenceId" AS "absenceId", r.resolution, r.reason, r."actorUserId" AS "actorUserId"
             FROM "BillingAbsenceResolution" r JOIN "RegularAbsence" ra ON ra.id = r."absenceId"
            WHERE ra."periodId" = $1 AND r."absenceId" = ANY($2::text[]) AND r.reason = $3 FOR UPDATE OF r`,
          periodId, settledAbsenceIds, REFUND_RESOLUTION_REASON,
        )
      : [];

    // 지우기 전에 사본을 남긴다
    await tx.$executeRawUnsafe(
      `INSERT INTO "OperationsAuditLog" (id, action, "actorType", "actorUserId", "detailsJson")
       VALUES (gen_random_uuid()::text, 'ILLNESS_PERIOD_REFUND_REVIEW_CANCELED', 'ADMIN', $1, $2::jsonb)`,
      actorId, JSON.stringify({ periodId, studentId: period.studentId, resolutions, settlement: stored?.settlement ?? null }),
    );

    const resolutionsRemoved = settledAbsenceIds.length > 0
      ? Number(await tx.$executeRawUnsafe(
          `DELETE FROM "BillingAbsenceResolution" r USING "RegularAbsence" ra
            WHERE ra.id = r."absenceId" AND ra."periodId" = $1 AND r."absenceId" = ANY($2::text[]) AND r.reason = $3`,
          periodId, settledAbsenceIds, REFUND_RESOLUTION_REASON,
        ))
      : 0;
    // 넘길 때 «확정»으로 바꾼 학부모 결석은 다시 «신고» 상태로
    const confirmedIds = cleanIds(record.confirmedAbsenceIds);
    const reopened = confirmedIds.length > 0
      ? Number(await tx.$executeRawUnsafe(
          `UPDATE "RegularAbsence" SET status = 'REPORTED', "updatedAt" = now()
            WHERE id = ANY($1::text[]) AND "periodId" = $2 AND status = 'CONFIRMED' AND "reportedByUserId" IS NOT NULL`,
          confirmedIds, periodId,
        ))
      : 0;

    // 넘길 때 거둔 보강권은 «승인이 거둔 보강권» 목록에 합친다 — 승인 상태에서는 거둬 둔 것이 맞고, 승인 취소 때 함께 돌려준다
    const approval = parsePeriodApprovalRecord(period.carrySettlement);
    const mergedApproval = {
      revokedCreditIds: [...new Set([...approval.revokedCreditIds, ...cleanIds(record.revokedCreditIds)])],
      createdReviewAbsenceIds: approval.createdReviewAbsenceIds,
    };
    const changed = Number(await tx.$executeRawUnsafe(
      `UPDATE "RegularAbsencePeriod"
          SET "carryState" = 'APPROVED', "carrySettledAt" = NULL, "carrySettledByUserId" = NULL,
              "carrySettlement" = (COALESCE("carrySettlement", '{}'::jsonb) - 'settlement') || $2::jsonb, "updatedAt" = now()
        WHERE id = $1 AND "carryState" = 'REFUND_REVIEW'`,
      periodId, JSON.stringify({ approval: mergedApproval }),
    ));
    if (changed !== 1) throw new IllnessPeriodError("기간 상태가 바뀌어 취소하지 않았습니다. 다시 확인해 주세요.");
    return { periodId, studentId: period.studentId, resolutionsRemoved, reopened };
  }, SETTLE_TX_OPTIONS);
}

export type RefundIllnessPeriod = {
  periodId: string; studentId: string;
  /** REFUND_REVIEW = 환불 검토 중 · REFUND_DONE = 환불 처리함 */
  carryState: "REFUND_REVIEW" | "REFUND_DONE";
  /** 환불 검토 금액(넘길 때의 표 사본 합계 — 다시 계산하지 않는다) */
  refundTotal: number;
  rows: SettlementPlan["rows"]; unpaidGuides: SettlementPlan["unpaidGuides"];
  /** 환불 처리함 메모·처리 시각(REFUND_DONE 일 때만) */
  memo: string | null; doneAt: string | null;
};

/** 환불 검토로 넘긴 기간의 표 사본(화면용) — 넘긴 뒤에는 다시 계산하지 않고 그때의 표를 그대로 보인다 */
export async function readRefundIllnessPeriod(tx: IllnessTx, periodIdInput: string): Promise<RefundIllnessPeriod | null> {
  const periodId = typeof periodIdInput === "string" ? periodIdInput.trim() : "";
  if (!periodId || periodId.length > 200) return null;
  if (!(await periodCarryColumnsReady(tx))) return null;
  const periods = await tx.$queryRawUnsafe<PeriodRow[]>(`${PERIOD_SELECT} WHERE p.id = $1`, periodId);
  const period = periods.find((row) => row.id === periodId) ?? null;
  if (!period || period.reason !== ILLNESS_REASON) return null;
  if (period.carryState !== "REFUND_REVIEW" && period.carryState !== "REFUND_DONE") return null;
  const summary = parseSettlementSummary(period.carrySettlement);
  if (!summary) return null;
  const stored = (typeof period.carrySettlement === "string" ? JSON.parse(period.carrySettlement) : period.carrySettlement) as
    { settlement?: { rows?: unknown; unpaidGuides?: unknown } };
  const refund = period.carryState === "REFUND_DONE" ? parseRefundRecord(period.carrySettlement) : null;
  return {
    periodId, studentId: period.studentId, carryState: period.carryState, refundTotal: summary.carryTotal,
    rows: Array.isArray(stored?.settlement?.rows) ? stored.settlement.rows as SettlementPlan["rows"] : [],
    unpaidGuides: Array.isArray(stored?.settlement?.unpaidGuides) ? stored.settlement.unpaidGuides as SettlementPlan["unpaidGuides"] : [],
    memo: refund?.memo ?? null, doneAt: refund?.doneAt ?? null,
  };
}
