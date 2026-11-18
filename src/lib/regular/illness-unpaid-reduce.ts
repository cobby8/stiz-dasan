// 질병·부상 결석 «미납 청구에서 1회분 빼기» — DB 연결부(2026-11-16 원장 결정).
//
// 무슨 일을 하나: 그 달 수강료가 미납인 하루짜리 질병·부상 결석을 승인하면, 이월(다음 달 차감)을 만들지 않고
//   «그 미납 청구 금액»을 1회 값만큼 줄인다. 납부된 달은 이 파일을 지나지 않는다(기존 이월 그대로).
//
// 새 표·새 칸 없음. 남기는 기록 두 가지:
//   ① 청구 변경 기록 PaymentAuditLog — action ILLNESS_UNPAID_REDUCE_ACTION, metadata { absenceId, absenceDate, before, after, reduceBy, sessions … }
//   ② 정산 기록 BillingAbsenceResolution — resolution 'CARRY'(DB 제약이 CARRY·MAKEUP 만 받는다) + 고정 사유 ILLNESS_UNPAID_REDUCE_REASON
//      → 이 결석으로 보강권이 다시 나가거나 한 번 더 이월·감액되는 길이 막힌다(PK = 결석 id · absence-compensation-guard).
//   이월 적립(BillingCarryCredit)은 만들지 않는다.
//
// 계산은 순수 모듈(illnessUnpaidReduceRules)·근거(수강료·수업 횟수)는 이월과 같은 함수(workbench-absence.readUnpaidEvidenceInTx).
// 금액을 줄이는 UPDATE 는 휴원 정산과 같은 함수(reduceUnpaidPayment — 조건부 UPDATE·0원이면 취소·기록).
//
// 잠금 순서(휴원 정산·관리자 «청구서 수정»과 같게 — 교착 금지):
//   (부르는 쪽) 작업대 전역 잠금 STIZ_BILLING_WORKBENCH → 결석 행
//   → ① 대상 청구 id 를 잠금 없이 읽고 → ② 결제 잠금(lockPaymentsForCheckout) → ③ 그 청구 행 FOR UPDATE
//   → ④ 근거를 다시 읽어 같은 청구·같은 숫자인지 확인 → ⑤ 조건부 UPDATE(금액·미납 상태가 읽은 값과 같을 때만).
//   결제 시작·토스 승인 직전도 같은 결제 잠금을 잡고 금액을 다시 읽으므로 «옛 금액으로 결제»가 생기지 않는다.
// 토스·현장 결제 코드는 건드리지 않는다 — 읽기·잠금 함수만 부른다.
//
// DB 는 인자(tx)로만 받는다 — 테스트가 가짜 db 로 실제 실행한다.
import { rallyzMirrorExclusionSql } from "@/lib/billing/parentSendGuard";
import { ILLNESS_UNPAID_REDUCE_ACTION, WorkbenchError, type WorkbenchCalendarSnapshot } from "@/lib/billing/workbench";
import { CARRY_NO_EVIDENCE_MESSAGE, readUnpaidEvidenceInTx, type CarryAbsenceTarget, type CarryEvidenceSource } from "@/lib/billing/workbench-absence";
import type { WorkbenchTx } from "@/lib/billing/workbench-service";
import { reduceUnpaidPayment } from "@/lib/enrollment/pause-settlement";
import { APPROVED_PENDING_SQL, findParentCheckoutActivePaymentIds, lockPaymentsForCheckout } from "@/lib/payments/bundleLedger";
import { HOLD_POS_BUSY_SQL } from "@/lib/regular/illness-period-admin";
import { ILLNESS_UNPAID_REDUCE_REASON } from "@/lib/regular/illnessCarryRules";
import { PERIOD_DAY_RESOLVE_BLOCKED } from "@/lib/regular/illnessPeriodRules";
import {
  APPROVAL_CHANGED_MESSAGE, UNPAID_REDUCE_BLOCKERS, UNPAID_REDUCE_CONFLICT_MESSAGE,
  approvalExpectationMismatch, planUnpaidReduce, unpaidReduceBlockCode, type ApprovalExpectation,
} from "@/lib/regular/illnessUnpaidReduceRules";
import { notMergedStudent } from "@/lib/studentVisibility";

type ReduceInput = { absence: CarryAbsenceTarget; originMonth: string; calendar?: WorkbenchCalendarSnapshot };

/** 승인하면 일어날 일 — 어느 청구에서 얼마를 빼고 얼마가 남는가 */
export type UnpaidReducePlan = {
  paymentId: string;
  /** 수강월 «YYYY-MM» */
  month: string;
  /** 근거 종류: WORKBENCH_ISSUED 사이트 발행 초안 · PAID_PAYMENT 초안 없는 일반 청구(이름은 이월 근거의 것을 그대로 쓴다) */
  source: CarryEvidenceSource;
  /** 그 달 수강료(1회 값의 분자) */
  tuition: number;
  sessions: number;
  unit: number;
  /** 지금 청구 금액 */
  before: number;
  reduceBy: number;
  after: number;
  /** 0원이 되어 청구·청구서가 취소 상태가 된다 */
  cancels: boolean;
  warnings: string[];
};

type BillRow = { id: string; amount: number; status: string; rallyzMirror: boolean; posBusy: boolean; paidTx: boolean; carryLinked: boolean };

/**
 * 줄일 청구와 금액을 읽는다. 조건이 안 맞으면 한국어 사유(WorkbenchError)를 던진다. 아무것도 쓰지 않는다.
 * lock=false(미리보기)는 행을 잠그지 않는다. lock=true(실행)는 위 잠금 순서 ①~④를 따른다.
 */
async function readUnpaidReducePlanInTx(tx: WorkbenchTx, input: ReduceInput, lock: boolean, nowMs: number): Promise<UnpaidReducePlan> {
  const { absence, originMonth } = input;
  // ① 잠금 없이 근거를 읽어 대상 청구 id 를 안다(미납 2건 이상·반 없는 청구·휴원 정산이 처리한 날·수업일 아님은 여기서 사유와 함께 막힌다)
  const first = await readUnpaidEvidenceInTx(tx, input, false);
  const paymentId = first.sourcePaymentId;
  if (!paymentId) throw new WorkbenchError(CARRY_NO_EVIDENCE_MESSAGE, 409);
  // ② 결제 잠금 — 학부모 결제 시작·토스 승인 직전과 같은 키
  if (lock) await lockPaymentsForCheckout(tx, [paymentId]);
  // ③ 그 청구 행(실행이면 FOR UPDATE) + 결제 경로 상태
  const bills = await tx.$queryRawUnsafe<BillRow[]>(
    `SELECT p.id, p.amount, p.status,
            NOT (${rallyzMirrorExclusionSql("p")}) AS "rallyzMirror",
            ${HOLD_POS_BUSY_SQL} AS "posBusy",
            EXISTS (SELECT 1 FROM "PaymentTransaction" t
                     WHERE (t.status = 'DONE' OR ${APPROVED_PENDING_SQL})
                       AND (t."paymentId" = p.id OR EXISTS (SELECT 1 FROM "PaymentTransactionItem" it WHERE it."transactionId" = t.id AND it."paymentId" = p.id))) AS "paidTx",
            -- 이월과 묶인 청구인가: 이 청구(또는 이 청구를 만든 발행 초안)에 이월을 썼거나, 이 청구를 근거로 적립한 이월이 있다(발행 보류의 판정과 같은 조건)
            (EXISTS (SELECT 1 FROM "BillingCarryUsage" u
                      WHERE u."paymentId" = p.id
                         OR EXISTS (SELECT 1 FROM "BillingWorkbenchDraft" d WHERE d."paymentId" = p.id AND d.id = u."draftId" AND d.month = u.month))
             OR EXISTS (SELECT 1 FROM "BillingCarryCredit" source_credit WHERE source_credit.basis->>'sourcePaymentId' = p.id)) AS "carryLinked"
       FROM "Payment" p
      WHERE p.id = $1 AND p."studentId" = $2 AND p."classId" = $3${lock ? " FOR UPDATE OF p" : ""}`,
    paymentId, absence.studentId, absence.classId,
  );
  const bill = bills.find((row) => String(row.id) === paymentId) ?? null;
  if (!bill) throw new WorkbenchError(UNPAID_REDUCE_CONFLICT_MESSAGE, 409, true);
  // ④ 잠근 뒤 근거를 다시 읽는다 — 기다리는 동안 납부됐거나 청구가 바뀌었으면 같은 청구·같은 숫자가 나오지 않는다
  const evidence = lock ? await readUnpaidEvidenceInTx(tx, input, true) : first;
  if (evidence.sourcePaymentId !== paymentId) throw new WorkbenchError(UNPAID_REDUCE_CONFLICT_MESSAGE, 409, true);
  // 학부모 결제 진행 중(30분 안 결제창·기한 남은 입금 계좌) — 관리자 청구서 수정·휴원 정산과 같은 판정 함수
  const active = await findParentCheckoutActivePaymentIds(tx, [paymentId], nowMs);
  const blocked = unpaidReduceBlockCode({
    status: String(bill.status), rallyzMirror: Boolean(bill.rallyzMirror), checkoutActive: active.has(paymentId),
    posBusy: Boolean(bill.posBusy), paidTx: Boolean(bill.paidTx),
  });
  if (blocked) throw new WorkbenchError(UNPAID_REDUCE_BLOCKERS[blocked], 409);
  const amounts = planUnpaidReduce({ tuition: evidence.numerator, sessions: evidence.dates.length, paymentAmount: Number(bill.amount), carryLinked: Boolean(bill.carryLinked) });
  if (!amounts.ok) throw new WorkbenchError(UNPAID_REDUCE_BLOCKERS[amounts.code], 409);
  return {
    paymentId, month: originMonth, source: evidence.source, tuition: evidence.numerator, sessions: evidence.dates.length,
    unit: amounts.unit, before: amounts.before, reduceBy: amounts.reduceBy, after: amounts.after, cancels: amounts.cancels,
    warnings: evidence.warnings,
  };
}

export type UnpaidReducePreview = { ok: true; plan: UnpaidReducePlan } | { ok: false; reason: string };

/** 신청함 «승인 전 미리보기» — 실행과 같은 규칙으로 읽기만 한다(행 잠금 없음). 막히면 실행 때 나올 사유를 그대로 돌려준다 */
export async function previewUnpaidReduce(tx: WorkbenchTx, input: ReduceInput, nowMs = Date.now()): Promise<UnpaidReducePreview> {
  try {
    return { ok: true, plan: await readUnpaidReducePlanInTx(tx, input, false, nowMs) };
  } catch (error) {
    if (error instanceof WorkbenchError) return { ok: false, reason: error.message };
    throw error;
  }
}

/**
 * 실행 — 미납 청구에서 1회 값을 빼고 정산 기록을 남긴다. 반드시 부르는 쪽 트랜잭션 안에서, 아래가 끝난 뒤에 부른다:
 *   작업대 전역 잠금 → 결석 행 FOR UPDATE → 결석이 «확정»(CONFIRMED) 상태 · 질병·부상 사유 · 결석일이 지남.
 * 결석 쪽 검사(보강 사용·예약·출결)는 기존 이월(resolveWorkbenchAbsence CARRY)과 같은 조건·같은 문구다.
 * 실패하면 throw — 부르는 쪽 트랜잭션이 통째로 되돌아간다(결석 확정 포함).
 */
export async function reduceUnpaidForIllnessAbsenceInTx(tx: WorkbenchTx, input: ReduceInput & {
  actorId: string;
  /** 그 결석의 보강 예약이 있으면 함께 취소해도 된다고 확인했다 */
  cancelReservation: boolean;
  /** 화면이 본 방식·금액 — 다시 읽은 것과 다르면 승인하지 않는다 */
  expected: ApprovalExpectation | null | undefined;
}, nowMs = Date.now()): Promise<UnpaidReducePlan> {
  const { absence, actorId } = input;
  // 미납 감액은 «질병·부상» 결석만(약관 — 경조사 등은 납부된 달 이월만). 다른 곳에서 불러도 새지 않게 DB 사유로 다시 확인
  const reasonRows = await tx.$queryRawUnsafe<Array<{ reason: string | null }>>(
    `SELECT reason FROM "RegularAbsence" WHERE id=$1`, absence.id);
  if (reasonRows[0]?.reason !== "ILLNESS_INJURY") throw new WorkbenchError("질병·부상 결석만 미납 청구에서 뺄 수 있습니다.", 409);
  // 승인·정산된 «기간 결석»의 날은 하루씩 처리하지 않는다(기존 이월과 같은 차단 — 기간 정산과 이중 보상 방지)
  const periodColumn = await tx.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT COUNT(*)::int AS n FROM information_schema.columns WHERE table_schema='public' AND table_name='RegularAbsencePeriod' AND column_name='carryState'`);
  if (Number(periodColumn[0]?.n ?? 0) > 0) {
    const decided = await tx.$queryRawUnsafe<Array<{ found: number }>>(
      `SELECT 1 AS found FROM "RegularAbsencePeriod" p JOIN "RegularAbsence" a ON a."periodId"=p.id WHERE a.id=$1 AND a.reason='ILLNESS_INJURY' AND p."carryState"<>'NONE' LIMIT 1`, absence.id);
    if (decided.length > 0) throw new WorkbenchError(PERIOD_DAY_RESOLVE_BLOCKED, 409);
  }
  // 이미 정산(이월·보강·감액)된 결석은 다시 처리하지 않는다
  const resolved = await tx.$queryRawUnsafe<Array<{ resolution: string }>>(
    `SELECT resolution FROM "BillingAbsenceResolution" WHERE "absenceId"=$1`, absence.id);
  if (resolved.length > 0) throw new WorkbenchError("확인된 미처리 결석만 처리할 수 있습니다.", 409);

  // 청구 쪽을 먼저 잠근다(결제 잠금 → 청구 행). 그 뒤에 학생·보강권 행 — 결제 흐름이 잡는 순서와 엇갈리지 않게.
  const plan = await readUnpaidReducePlanInTx(tx, input, true, nowMs);
  if (approvalExpectationMismatch(input.expected, { mode: "REDUCE", reduceBy: plan.reduceBy, after: plan.after })) {
    throw new WorkbenchError(APPROVAL_CHANGED_MESSAGE, 409, true);
  }

  const lockedStudent = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT s.id FROM "Student" s WHERE s.id=$1 AND ${notMergedStudent("s")} FOR UPDATE`, absence.studentId);
  if (lockedStudent.length !== 1) throw new WorkbenchError("통합되거나 변경된 학생입니다. 현재 학생으로 다시 조회해 주세요.", 409, true);
  const sourceKey = `REGULAR:${absence.classId}:${absence.date}`;
  const credits = await tx.$queryRawUnsafe<Array<{ id: string; status: string }>>(
    `SELECT id,status FROM "MakeupCredit" WHERE "studentId"=$1 AND "sourceKey"=$2 FOR UPDATE`, absence.studentId, sourceKey);
  const bookings = await tx.$queryRawUnsafe<Array<{ id: string; status: string }>>(
    `SELECT id,status FROM "MakeupSession" WHERE "studentId"=$1 AND "originalClassId"=$2 AND ("originalDate" AT TIME ZONE 'Asia/Seoul')::date=$3::date FOR UPDATE`,
    absence.studentId, absence.classId, absence.date);
  if (credits.some((c) => ["USED", "NO_SHOW"].includes(c.status)) || bookings.some((b) => ["ATTENDED", "NO_SHOW"].includes(b.status))) {
    throw new WorkbenchError("이미 보강에 사용된 결석입니다. 자동 이월하지 않고 별도 확인이 필요합니다.", 409);
  }
  if ((credits.some((c) => c.status === "RESERVED") || bookings.some((b) => b.status === "BOOKED")) && input.cancelReservation !== true) {
    throw new WorkbenchError("보강 예약 취소와 좌석 해제를 확인해 주세요.", 409);
  }
  const attendance = await tx.$queryRawUnsafe<Array<{ status: string }>>(
    `SELECT t.status FROM "Attendance" t JOIN "Session" se ON se.id=t."sessionId" WHERE t."studentId"=$1 AND se."classId"=$2 AND se.date::date=$3::date FOR SHARE OF t,se`,
    absence.studentId, absence.classId, absence.date);
  if (attendance.some((t) => t.status !== "ABSENT")) throw new WorkbenchError("출결이 결석과 일치하지 않습니다. 출석·지각 정정 내역을 먼저 확인해 주세요.", 409);

  // ⑤ 금액 줄이기 — 지금 금액·미납 상태가 읽은 값과 같을 때만(아니면 throw → 전부 되돌림). 0원이면 청구·청구서 취소.
  try {
    await reduceUnpaidPayment(tx, {
      paymentId: plan.paymentId, expectedAmount: plan.before, reduceBy: plan.reduceBy, adminUserId: actorId,
      action: ILLNESS_UNPAID_REDUCE_ACTION, message: "질병·부상 결석 1회 감액",
      // 사유 글(건강 정보)은 싣지 않는다 — 어느 결석·어느 날·어떤 계산인지만
      metadata: {
        absenceId: absence.id, absenceDate: absence.date, classId: absence.classId, originMonth: plan.month,
        tuition: plan.tuition, sessions: plan.sessions, unit: plan.unit, source: plan.source,
      },
    });
  } catch (error) {
    if (error instanceof Error && /^PAUSE_SETTLEMENT_(PAYMENT_CONFLICT|AMOUNT_INVALID)$/.test(error.message)) {
      throw new WorkbenchError(UNPAID_REDUCE_CONFLICT_MESSAGE, 409, true);
    }
    throw error;
  }

  // 보강 예약 취소·미사용 보강권 회수 — 기존 이월 승인과 같은 처리(같은 결석을 보강으로 또 보상하지 않는다)
  await tx.$executeRawUnsafe(`UPDATE "MakeupSession" SET status='CANCELLED',"updatedAt"=NOW() WHERE id=ANY($1::text[]) AND status='BOOKED'`, bookings.map((b) => b.id));
  await tx.$executeRawUnsafe(`UPDATE "MakeupCredit" SET status='REVOKED',"makeupSessionId"=NULL,"updatedAt"=NOW() WHERE id=ANY($1::text[]) AND status IN ('AVAILABLE','RESERVED','EXPIRED')`, credits.map((c) => c.id));
  // 정산 기록 — resolution 은 DB 제약상 'CARRY', 구분은 고정 사유 글자로(이월 적립 행은 만들지 않는다)
  await tx.$executeRawUnsafe(
    `INSERT INTO "BillingAbsenceResolution" ("absenceId","studentId",resolution,reason,"evidenceConfirmed",eligibility,"actorUserId") VALUES ($1,$2,'CARRY',$3,true,'ILLNESS_INJURY',$4)`,
    absence.id, absence.studentId, ILLNESS_UNPAID_REDUCE_REASON, actorId);
  // 신청함 검토 상태를 «승인»으로(없던 줄은 만든다) — 기존 이월 승인과 같은 문장. 검토 표가 없으면 건너뛴다
  const reviewTable = await tx.$queryRawUnsafe<Array<{ found: string | null }>>(`SELECT to_regclass($1)::text AS found`, 'public."RegularAbsenceCarryReview"');
  if (reviewTable[0]?.found) {
    await tx.$executeRawUnsafe(
      `INSERT INTO "RegularAbsenceCarryReview" ("absenceId",status,source,"decidedAt","decidedBy","decidedByUserId","convertReason") SELECT a.id,'APPROVED','STAFF',NOW(),'ADMIN',$2::text,NULL FROM "RegularAbsence" a WHERE a.id=$1 AND a.reason='ILLNESS_INJURY' ON CONFLICT ("absenceId") DO UPDATE SET status=EXCLUDED.status,"decidedAt"=NOW(),"decidedBy"='ADMIN',"decidedByUserId"=EXCLUDED."decidedByUserId","convertReason"=EXCLUDED."convertReason","updatedAt"=NOW()`,
      absence.id, actorId);
  }
  return plan;
}
