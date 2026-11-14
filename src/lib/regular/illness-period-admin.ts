// 부상·질병 «기간 결석» — 원장(신청함) 쪽 승인·승인 취소·보강권으로 전환·상세 읽기 (2026-11-15 원장 승인, 1b 단계)
//
// 왜 하루짜리 승인과 따로인가: 하루짜리 [이월 승인]은 누르는 순간 금액(이월)을 적립한다. 그래서 결석일이 지나야 하고
// 그 달 청구가 발행돼 있어야 한다. 기간 결석(예: 11/6부터 복귀 미정)은 그 조건을 날짜마다 기다릴 수 없다.
// → 여기서는 «인정»만 기록하고 돈은 움직이지 않는다. 금액은 복귀 뒤 한 번에 정산한다(다음 단계).
//
// 그래서 승인은 결석 날짜·청구 기록·청구 준비 저장 스위치와 «무관하게» 된다.
// 승인하면 달라지는 것 세 가지:
//   ① 기간 상태가 NONE → APPROVED (지금 상태가 NONE 일 때만 — 두 번 눌러도 두 번째는 «이미 승인»)
//   ② 그 기간의 아직 결정 전인 결석의 검토(RegularAbsenceCarryReview)를 APPROVED 로 — 7일 자동 보강권 전환이 멈춘다
//   ③ 그 결석들의 미사용 보강권을 거둔다(기존 holdCreditForIllnessInTx)
// 결석 행의 상태(REPORTED/CONFIRMED)는 바꾸지 않는다 — 학부모 «복귀했어요»가 REPORTED 만 취소하기 때문이다.
//
// 되돌릴 수 있어야 한다(코드 리뷰 2026-11-15): 승인 때 «거둔 보강권 id»와 «새로 만든 검토 줄의 결석 id»를
// 기간 행(carrySettlement.approval)과 감사 기록에 남기고, 승인 취소 때 그 보강권을 돌려주고 그 검토 줄을 지운다.
// 인정하지 않는 기간은 [보강권으로 전환] — 결정 전인 날마다 기존 convertIllnessToMakeupInTx 를 한 거래에서 부른다.
//
// DB 는 인자(db)로만 받는다 — 테스트가 가짜 db 로 실제 실행한다. 이 파일은 prisma 를 import 하지 않는다.
import { lockCompensation } from "@/lib/billing/absence-compensation-guard";
import { rallyzMirrorExclusionSql } from "@/lib/billing/parentSendGuard";
import { APPROVED_PENDING_SQL, findParentCheckoutActivePaymentIds, lockPaymentsForCheckout } from "@/lib/payments/bundleLedger";
import { notMergedStudent } from "@/lib/studentVisibility";
import { periodCarryColumnsReady } from "@/lib/regular/absence-period-service";
import {
  closeIllnessReviewInTx, convertIllnessToMakeupInTx, holdCreditForIllnessInTx, illnessReviewReady, type IllnessTx,
} from "@/lib/regular/illness-carry-tx";
import { ILLNESS_REASON } from "@/lib/regular/illnessCarryRules";
import {
  HOLD_SKIP_REASONS, IllnessPeriodError, illnessPeriodAbsenceSql, makeupInUseSql, parseHeldBills, parsePeriodApprovalRecord, periodApprovalBlocker,
  type HeldBillRecord, type HoldSkipCode,
} from "@/lib/regular/illnessPeriodRules";

export type IllnessPeriodDb = IllnessTx & {
  $transaction<T>(work: (tx: IllnessTx) => Promise<T>, options?: { isolationLevel: "Serializable" | "RepeatableRead"; timeout?: number }): Promise<T>;
};

type PeriodRow = {
  id: string; studentId: string; reason: string; status: string; carryState: string;
  startDate: string; returnDate: string | null; note: string | null; parentReported: boolean;
  carrySettlement: unknown;
  /** 기간 대상 반(빈 배열 = 그 학생의 수강 중 반 전부) */
  classIds?: string[] | null;
};

// 기간 한 줄 — date 칼럼은 달력 값이라 시간대 변환이 없다
const PERIOD_SELECT = `SELECT p.id, p."studentId" AS "studentId", p.reason, p.status, p."carryState" AS "carryState",
       to_char(p."startDate", 'YYYY-MM-DD') AS "startDate", to_char(p."returnDate", 'YYYY-MM-DD') AS "returnDate",
       p.note, (p."reportedByUserId" IS NOT NULL) AS "parentReported", p."carrySettlement" AS "carrySettlement", p."classIds" AS "classIds"
  FROM "RegularAbsencePeriod" p WHERE p.id = $1`;

const TX_OPTIONS = { isolationLevel: "Serializable" as const, timeout: 30_000 };
// 보강권 전환은 결석마다 기존 함수(조회 여러 번)를 부른다 — 긴 기간도 끝나게 넉넉히
const CONVERT_TX_OPTIONS = { isolationLevel: "Serializable" as const, timeout: 60_000 };

function cleanId(value: unknown): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id || id.length > 200) throw new IllnessPeriodError("기간 결석을 찾을 수 없습니다.", 404);
  return id;
}

async function tableExists(tx: IllnessTx, name: string): Promise<boolean> {
  const rows = await tx.$queryRawUnsafe<Array<{ found: string | null }>>(`SELECT to_regclass($1)::text AS found`, `public."${name}"`);
  return Boolean(rows[0]?.found);
}

/** 잠금(작업대 전역 → 기간 행) 뒤 기간 한 줄. 칸이 없거나 기간이 없으면 한국어 사유로 던진다 */
async function lockPeriod(tx: IllnessTx, periodId: string): Promise<PeriodRow> {
  await lockCompensation(tx);
  if (!(await periodCarryColumnsReady(tx))) throw new IllnessPeriodError("기간 결석 승인 저장 구조를 확인해 주세요.", 503);
  const periods = await tx.$queryRawUnsafe<PeriodRow[]>(`${PERIOD_SELECT} FOR UPDATE OF p`, periodId);
  const period = periods.find((row) => row.id === periodId) ?? null;
  if (!period) throw new IllnessPeriodError("기간 결석을 찾을 수 없습니다.", 404);
  return period;
}

/** 감사 기록 — 누가 어느 기간을 승인·취소했는가(사유 글·사진은 싣지 않는다) */
async function writeAudit(tx: IllnessTx, action: string, actorId: string, details: Record<string, unknown>) {
  await tx.$executeRawUnsafe(
    `INSERT INTO "OperationsAuditLog" (id, action, "actorType", "actorUserId", "detailsJson")
     VALUES (gen_random_uuid()::text, $1, 'ADMIN', $2, $3::jsonb)`,
    action, actorId, JSON.stringify(details),
  );
}

export type ApprovePeriodResult = { periodId: string; studentId: string; startDate: string; returnDate: string | null; reviewed: number; creditsHeld: number };

/**
 * [부상 결석 승인] — 금액 없이 «인정»만 기록한다. 전부 한 트랜잭션.
 *
 * @param input.evidenceConfirmed 원장이 증빙을 확인했다(기간 전체에 한 번 — 사진을 봤거나 직접 확인)
 */
export async function approveIllnessPeriod(
  db: IllnessPeriodDb,
  input: { periodId: string; evidenceConfirmed: boolean },
  actorId: string,
): Promise<ApprovePeriodResult> {
  if (!actorId) throw new IllnessPeriodError("관리자 확인이 필요합니다.", 403);
  const periodId = cleanId(input?.periodId);
  if (input?.evidenceConfirmed !== true) throw new IllnessPeriodError("증빙을 확인했는지 체크해 주세요.", 400);

  return db.$transaction(async (tx) => {
    // 잠금 순서는 기존 정산과 같다: 작업대 전역 잠금 → 기간 행 → 결석 행
    const period = await lockPeriod(tx, periodId);
    const blocker = periodApprovalBlocker({ reason: period.reason, periodStatus: period.status, carryState: period.carryState });
    if (blocker) throw new IllnessPeriodError(blocker);

    // 상태 전이는 «지금 NONE 일 때만» — 동시에 두 번 눌러도 한 번만 바뀐다
    const changed = await tx.$executeRawUnsafe(
      `UPDATE "RegularAbsencePeriod"
          SET "carryState" = 'APPROVED', "carryApprovedAt" = now(), "carryApprovedByUserId" = $2, "updatedAt" = now()
        WHERE id = $1 AND "carryState" = 'NONE'`,
      periodId, actorId,
    );
    if (Number(changed) === 0) throw new IllnessPeriodError("이미 승인된 기간 결석입니다.");

    let reviewed = 0;
    const revokedCreditIds: string[] = [];
    const createdReviewAbsenceIds: string[] = [];
    if (await illnessReviewReady(tx)) {
      // 그 기간의 살아 있는 질병·부상 결석 중 아직 결정 전인 것(검토 줄이 없거나 «검토 중»).
      // 보강을 이미 예약·사용한 날은 뺀다 — 그 날은 보강으로 보상이 진행 중이라 «이월 대상»으로 표시하지 않는다(정산 때도 빠진다).
      const makeupSessions = await tableExists(tx, "MakeupSession");
      const absences = await tx.$queryRawUnsafe<Array<{ id: string; studentId: string; classId: string; absenceYmd: string; noReview: boolean }>>(
        `SELECT ra.id, ra."studentId" AS "studentId", ra."classId" AS "classId", to_char(ra.date, 'YYYY-MM-DD') AS "absenceYmd",
                (r."absenceId" IS NULL) AS "noReview"
           FROM "RegularAbsencePeriod" p
           JOIN "RegularAbsence" ra ON ${illnessPeriodAbsenceSql("p", "ra")}
           LEFT JOIN "RegularAbsenceCarryReview" r ON r."absenceId" = ra.id
          WHERE p.id = $1 AND COALESCE(r.status, 'PENDING') = 'PENDING'
            AND NOT ${makeupInUseSql("ra", makeupSessions)}
          ORDER BY ra.date, ra.id
          FOR UPDATE OF ra`,
        periodId,
      );
      const ids = absences.map((absence) => absence.id);
      if (ids.length > 0) {
        // 거둘 미사용 보강권을 먼저 읽어 id 를 남긴다(승인 취소 때 «그 보강권만» 돌려준다)
        const credits = await tx.$queryRawUnsafe<Array<{ id: string; absenceId: string }>>(
          `SELECT mc.id, ra.id AS "absenceId"
             FROM "RegularAbsence" ra
             JOIN "MakeupCredit" mc ON mc."studentId" = ra."studentId"
              AND mc."sourceKey" = 'REGULAR:' || ra."classId" || ':' || to_char(ra.date, 'YYYY-MM-DD')
            WHERE ra.id = ANY($1::text[]) AND mc.status = 'AVAILABLE'
            FOR UPDATE OF mc`,
          ids,
        );
        const withCredit = new Set(credits.map((credit) => credit.absenceId));
        for (const absence of absences.filter((item) => withCredit.has(item.id))) await holdCreditForIllnessInTx(tx, absence);
        revokedCreditIds.push(...credits.map((credit) => credit.id));
        createdReviewAbsenceIds.push(...absences.filter((absence) => absence.noReview).map((absence) => absence.id));

        // 검토를 «승인»으로 맞춘다 — 검토 줄이 없던 결석(학원이 등록한 기간)은 새로 만든다.
        // 결정이 이미 난 검토(하루씩 이월 승인·보강권 전환·닫힘)는 건드리지 않는다
        reviewed = Number(await tx.$executeRawUnsafe(
          `INSERT INTO "RegularAbsenceCarryReview" ("absenceId", status, source, "decidedAt", "decidedBy", "decidedByUserId")
           SELECT target.id, 'APPROVED', 'STAFF', now(), 'ADMIN', $2::text FROM unnest($1::text[]) AS target(id)
           ON CONFLICT ("absenceId") DO UPDATE
              SET status = 'APPROVED', "decidedAt" = now(), "decidedBy" = 'ADMIN',
                  "decidedByUserId" = EXCLUDED."decidedByUserId", "convertReason" = NULL, "updatedAt" = now()
            WHERE "RegularAbsenceCarryReview".status = 'PENDING'`,
          ids, actorId,
        ));
      }
    }

    // 되돌릴 재료를 기간 행에 남긴다(감사 기록에도 같은 값)
    const approval = { revokedCreditIds, createdReviewAbsenceIds };
    await tx.$executeRawUnsafe(
      `UPDATE "RegularAbsencePeriod" SET "carrySettlement" = $2::jsonb WHERE id = $1 AND "carryState" = 'APPROVED'`,
      periodId, JSON.stringify({ approval }),
    );
    await writeAudit(tx, "ILLNESS_PERIOD_APPROVED", actorId, {
      periodId, studentId: period.studentId, startDate: period.startDate, returnDate: period.returnDate,
      reviewed, creditsHeld: revokedCreditIds.length, ...approval,
    });
    return { periodId, studentId: period.studentId, startDate: period.startDate, returnDate: period.returnDate, reviewed, creditsHeld: revokedCreditIds.length };
  }, TX_OPTIONS);
}

export type CancelPeriodApprovalResult = {
  periodId: string; studentId: string; reopened: number; creditsRestored: number; reviewsRemoved: number; closed: number;
  /** 보류로 돌려 둔 청구 수 — 승인 취소해도 되살리지 않는다(청구 준비에서 다시 발행) */
  heldBills: number;
};

/**
 * [승인 취소] — 금액을 정하기 전(APPROVED)에만. 승인 «직전»으로 되돌린다.
 *   · 기간 상태 → NONE
 *   · 승인 때 새로 만든 검토 줄 → 지운다(원래 없던 줄)
 *   · 승인으로 맞춰 둔 나머지 검토 → «검토 중»(알린 시각을 지금으로 — 7일 기한이 새로 시작한다)
 *   · 그 사이 취소된 결석의 승인 검토 → 닫는다(CLOSED). 안 닫으면 같은 날을 다시 알렸을 때 검토가 열리지 않는다
 *   · 승인 때 거둔 보강권 → 다시 쓸 수 있게(만료일이 지났으면 «만료»). 그 결석이 취소됐거나 이월 적립됐으면 돌려주지 않는다
 * 하루씩 실제로 이월 적립된 결석(BillingAbsenceResolution 이 있는 것)의 검토는 건드리지 않는다.
 */
export async function cancelIllnessPeriodApproval(
  db: IllnessPeriodDb,
  input: { periodId: string },
  actorId: string,
): Promise<CancelPeriodApprovalResult> {
  if (!actorId) throw new IllnessPeriodError("관리자 확인이 필요합니다.", 403);
  const periodId = cleanId(input?.periodId);

  return db.$transaction(async (tx) => {
    const period = await lockPeriod(tx, periodId);
    const approval = parsePeriodApprovalRecord(period.carrySettlement);
    // 보류로 돌린 청구 사본 — 아래에서 carrySettlement 를 비우므로 먼저 꺼내 감사 기록에 남긴다
    const heldBills = parseHeldBills(period.carrySettlement);

    const changed = await tx.$executeRawUnsafe(
      `UPDATE "RegularAbsencePeriod"
          SET "carryState" = 'NONE', "carryApprovedAt" = NULL, "carryApprovedByUserId" = NULL, "carrySettlement" = NULL, "updatedAt" = now()
        WHERE id = $1 AND "carryState" = 'APPROVED'`,
      periodId,
    );
    if (Number(changed) === 0) {
      throw new IllnessPeriodError(period.carryState === "NONE"
        ? "승인되지 않은 기간 결석입니다."
        : "이미 정산이 끝난 기간 결석은 승인 취소할 수 없습니다.");
    }

    // 실제 이월 적립이 없는 «승인» 검토 = 기간 승인이 맞춰 둔 것. 정산 표가 아직 없으면 전부 기간 승인분이다
    const notSettled = (await tableExists(tx, "BillingAbsenceResolution"))
      ? `AND NOT EXISTS (SELECT 1 FROM "BillingAbsenceResolution" settled WHERE settled."absenceId" = ra.id)`
      : "";
    let reopened = 0;
    let reviewsRemoved = 0;
    let closed = 0;
    if (await illnessReviewReady(tx)) {
      // ① 승인 때 새로 만든 검토 줄은 지운다(이 기간의 결석이고 아직 «승인»인 것만)
      if (approval.createdReviewAbsenceIds.length > 0) {
        reviewsRemoved = Number(await tx.$executeRawUnsafe(
          `DELETE FROM "RegularAbsenceCarryReview" r
            USING "RegularAbsence" ra
            WHERE ra.id = r."absenceId" AND ra."periodId" = $1 AND r."absenceId" = ANY($2::text[])
              AND r.status = 'APPROVED' ${notSettled}`,
          periodId, approval.createdReviewAbsenceIds,
        ));
      }
      // ② 그 사이 취소된 결석의 승인 검토는 닫는다
      closed = Number(await tx.$executeRawUnsafe(
        `UPDATE "RegularAbsenceCarryReview" r
            SET status = 'CLOSED', "decidedAt" = now(), "updatedAt" = now()
           FROM "RegularAbsence" ra
          WHERE ra.id = r."absenceId" AND ra."periodId" = $1 AND ra.status = 'CANCELLED'
            AND r.status = 'APPROVED' ${notSettled}`,
        periodId,
      ));
      // ③ 살아 있는 결석의 승인 검토는 «검토 중»으로
      reopened = Number(await tx.$executeRawUnsafe(
        `UPDATE "RegularAbsenceCarryReview" r
            SET status = 'PENDING', "requestedAt" = now(),
                "decidedAt" = NULL, "decidedBy" = NULL, "decidedByUserId" = NULL, "convertReason" = NULL, "updatedAt" = now()
           FROM "RegularAbsence" ra
          WHERE ra.id = r."absenceId" AND ra."periodId" = $1 AND ra.status <> 'CANCELLED' AND ra.reason = $2
            AND r.status = 'APPROVED' ${notSettled}`,
        periodId, ILLNESS_REASON,
      ));
    }

    // ④ 승인 때 거둔 보강권을 돌려준다 — 여전히 «회수» 상태이고 예약에 묶인 적 없는 그 보강권만.
    //    그 결석이 아직 살아 있고 이월로 정산되지 않았을 때만. 만료일이 지났으면 만료 처리(매일 도는 만료 규칙과 같은 기준: expiresAt < now())
    //    그날 출석·지각으로 기록된 날은 돌려주지 않는다(수업을 들었으니 보강권이 없다 — [보강권으로 전환]과 같은 기준)
    let creditsRestored = 0;
    if (approval.revokedCreditIds.length > 0) {
      creditsRestored = Number(await tx.$executeRawUnsafe(
        `UPDATE "MakeupCredit" mc
            SET status = CASE WHEN mc."expiresAt" < now() THEN 'EXPIRED' ELSE 'AVAILABLE' END,
                note = '부상 결석 승인 취소로 되돌림', "updatedAt" = now()
          WHERE mc.id = ANY($1::text[]) AND mc."studentId" = $2 AND mc.status = 'REVOKED' AND mc."makeupSessionId" IS NULL
            AND EXISTS (SELECT 1 FROM "RegularAbsence" ra
                         WHERE ra."periodId" = $3 AND ra."studentId" = mc."studentId" AND ra.status <> 'CANCELLED'
                           AND mc."sourceKey" = 'REGULAR:' || ra."classId" || ':' || to_char(ra.date, 'YYYY-MM-DD') ${notSettled}
                           AND NOT EXISTS (SELECT 1 FROM "Attendance" att JOIN "Session" se ON se.id = att."sessionId"
                                            WHERE att."studentId" = ra."studentId" AND se."classId" = ra."classId"
                                              AND to_char(se."date", 'YYYY-MM-DD') = to_char(ra.date, 'YYYY-MM-DD')
                                              AND att.status IN ('PRESENT', 'LATE')))`,
        approval.revokedCreditIds, period.studentId, periodId,
      ));
    }

    await writeAudit(tx, "ILLNESS_PERIOD_APPROVAL_CANCELED", actorId, {
      periodId, studentId: period.studentId, reopened, reviewsRemoved, closed, creditsRestored, ...approval,
      heldPaymentIds: heldBills.map((bill) => bill.paymentId),
    });
    return { periodId, studentId: period.studentId, reopened, creditsRestored, reviewsRemoved, closed, heldBills: heldBills.length };
  }, TX_OPTIONS);
}

export type ConvertPeriodResult = {
  periodId: string; studentId: string; startDate: string; returnDate: string | null;
  /** 보강권으로 돌린 결석 수 / 그중 실제로 보강권이 새로 나간(되살아난) 수 / 그날 출석해 닫은 수 */
  converted: number; creditsIssued: number; attendedClosed: number;
};

/**
 * [보강권으로 전환] — 이 기간을 부상 결석으로 인정하지 않는다. 결정 전인 날마다 하루짜리 [보강권으로]와 같은 함수를
 * 한 거래에서 부른다(보강권 1장씩·그날 출석했으면 보강권 없음). 승인 전(NONE)에만.
 * 끝나면 그 기간의 모든 날이 결정돼 신청함 «완료»(날짜별로 처리함)로 빠진다.
 */
export async function convertIllnessPeriodToMakeup(
  db: IllnessPeriodDb,
  input: { periodId: string },
  actorId: string,
  issuable: (absenceYmd: string) => boolean,
): Promise<ConvertPeriodResult> {
  if (!actorId) throw new IllnessPeriodError("관리자 확인이 필요합니다.", 403);
  const periodId = cleanId(input?.periodId);

  return db.$transaction(async (tx) => {
    const period = await lockPeriod(tx, periodId);
    if (period.reason !== ILLNESS_REASON) throw new IllnessPeriodError("질병·부상으로 등록한 기간 결석만 처리할 수 있습니다.");
    if (period.carryState !== "NONE") throw new IllnessPeriodError("이미 승인된 기간 결석입니다. 승인을 취소한 뒤 보강권으로 돌려 주세요.");
    if (!(await illnessReviewReady(tx))) throw new IllnessPeriodError("이월 검토 저장 구조를 확인해 주세요.", 503);

    const absences = await tx.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT ra.id
         FROM "RegularAbsencePeriod" p
         JOIN "RegularAbsence" ra ON ${illnessPeriodAbsenceSql("p", "ra")}
         LEFT JOIN "RegularAbsenceCarryReview" r ON r."absenceId" = ra.id
        WHERE p.id = $1 AND COALESCE(r.status, 'PENDING') = 'PENDING'
        ORDER BY ra.date, ra.id
        FOR UPDATE OF ra`,
      periodId,
    );
    if (absences.length === 0) throw new IllnessPeriodError("보강권으로 돌릴 결석이 없습니다. 이미 날짜별로 처리된 기간입니다.");

    let converted = 0;
    let creditsIssued = 0;
    let attendedClosed = 0;
    for (const absence of absences) {
      const outcome = await convertIllnessToMakeupInTx(tx, { absenceId: absence.id, by: "ADMIN", actorUserId: actorId, issuable });
      if (outcome.converted) {
        converted += 1;
        if (outcome.creditIssued) creditsIssued += 1;
      } else if (outcome.reason === "ATTENDED") {
        // 그날 출석·지각으로 기록된 날 — 보강권을 주지 않고 검토를 닫는다(안 닫으면 기간이 «승인 대기»에 계속 남는다).
        // 검토 줄이 있으면 기존 닫기(사진 정리 포함), 없으면 닫힌 줄을 만든다
        await closeIllnessReviewInTx(tx, absence.id);
        await tx.$executeRawUnsafe(
          `INSERT INTO "RegularAbsenceCarryReview" ("absenceId", status, source, "decidedAt", "decidedBy", "decidedByUserId")
           VALUES ($1, 'CLOSED', 'STAFF', now(), 'ADMIN', $2)
           ON CONFLICT ("absenceId") DO NOTHING`,
          absence.id, actorId,
        );
        attendedClosed += 1;
      }
      // 그 밖(이미 결정됨·이월 정산됨 등)은 잠근 뒤 상태가 달라진 것 — 그대로 둔다
    }

    await writeAudit(tx, "ILLNESS_PERIOD_TO_MAKEUP", actorId, { periodId, studentId: period.studentId, converted, creditsIssued, attendedClosed });
    return { periodId, studentId: period.studentId, startDate: period.startDate, returnDate: period.returnDate, converted, creditsIssued, attendedClosed };
  }, CONVERT_TX_OPTIONS);
}

// ── 청구 발행 보류: 이미 발행된 미납 청구를 «보류로 돌리기» (2단계, 2026-11-15 원장 결정) ─────────────
//
// 왜: 부상 결석을 승인하면 그 아이의 새 청구는 발행되지 않는다(청구 준비가 막는다). 그런데 승인 «전에» 이미 발행된
// 미납 청구(예: 12월분)는 학부모 화면에 그대로 남아 결제·미납 안내 대상이 된다. 원장이 대상과 금액을 보고 한 번 눌러
// 그 청구를 «취소» 상태로 돌리고, 청구 준비의 초안을 «검토 전»으로 되돌려 복귀 뒤 다시 발행할 수 있게 한다.
// 비유: 이미 보낸 청구서를 회수해 서랍에 넣어 두는 일. 금액 메모(초안)는 남겨 두고, 다시 보낼 때는 새 청구 번호가 붙는다.
//
// 자동으로 하지 않는다 — 원장만 누른다(호출부가 원장 권한을 확인한다. 기존 «미납 청구 취소»와 같은 권한).
// 토스·현장 결제 코드는 건드리지 않는다: 결제가 진행 중인 청구는 «건너뛰고» 이유를 돌려준다.

/** 현장 결제(POS) 요청에 묶인 청구(별칭 p) — 휴원 정산(pause-settlement.ts POS_BUSY_P)과 같은 조건(테스트가 비교) */
export const HOLD_POS_BUSY_SQL = `(EXISTS (SELECT 1 FROM "PosChargeRequestItem" pi WHERE pi."paymentId" = p.id AND pi."open")
             OR EXISTS (SELECT 1 FROM "PosChargeRequest" pr WHERE pr."paymentId" = p.id AND pr.status IN ('PENDING','SENT')))`;

/**
 * 보류로 돌릴 대상 청구(별칭 p) — $1 학생 · $2 기간 시작 달(YYYYMM 숫자) · $3 기간 대상 반(빈 배열 = 전부).
 * 수강료(MONTHLY) 미납·연체, 수강월 ≥ 기간 시작 달. 랠리즈 사본 청구는 사이트에서 바꾸지 않는다(휴원 정산과 같은 기준).
 */
const HOLD_TARGET_SCOPE = `p."studentId" = $1 AND COALESCE(p.type, 'MONTHLY') = 'MONTHLY' AND p.status IN ('PENDING','OVERDUE')
        AND p.year IS NOT NULL AND p.month IS NOT NULL AND (p.year * 100 + p.month) >= $2
        AND (cardinality($3::text[]) = 0 OR p."classId" = ANY($3::text[]))
        AND ${rallyzMirrorExclusionSql("p")}`;

type HoldTargetRow = {
  id: string; year: number; month: number; amount: number; status: string; classId: string | null; className: string | null;
  invoiceId: string | null; invoiceStatus: string | null;
  posBusy: boolean; paidTx: boolean; carryUsed: boolean; carrySource: boolean; pauseSettled: boolean;
};

/** 화면에 보이는 대상 청구 한 줄 — skip 이 있으면 이번에 돌리지 않는 청구(이유 글자와 함께) */
export type HoldBillView = {
  paymentId: string; year: number; month: number; classId: string | null; className: string | null; amount: number; status: string;
  skip: HoldSkipCode | null; skipText: string | null;
};

const isHoldActive = (period: PeriodRow) =>
  period.reason === ILLNESS_REASON && period.carryState === "APPROVED" && (period.status === "ACTIVE" || period.status === "ENDED");

const holdScopeArgs = (period: PeriodRow): [string, number, string[]] => [
  period.studentId,
  Number(period.startDate.slice(0, 4)) * 100 + Number(period.startDate.slice(5, 7)),
  Array.isArray(period.classIds) ? period.classIds.map(String) : [],
];

/**
 * 대상 청구를 읽어 «돌릴 수 있는가»를 건마다 판정한다. lockedIds 를 주면 그 id 만 행 잠금(FOR UPDATE)으로 읽는다.
 * 판정 순서: 학부모 결제 진행 중 → 현장 결제 요청 중 → 결제 거래 기록 있음 → 이월을 쓴 청구 → 이월의 근거인 청구
 *   → 휴원 정산 반영 → 청구서 상태 이상.
 * «이월의 근거인 청구»를 취소하면 그 이월이 무효가 돼 그 학생 청구가 통째로 막히고, «휴원 정산이 줄여 준 청구»를 취소하면
 * 이미 차감한 휴원 이월이 사라진다 — 둘 다 자동으로 돌리지 않고 원장이 직접 본다.
 */
async function readHoldTargets(tx: IllnessTx, period: PeriodRow, nowMs: number, lockedIds: string[] | null): Promise<HoldBillView[]> {
  const args = holdScopeArgs(period);
  // 표가 아직 없는 DB 에서도 깨지지 않게 — 없는 표의 조건은 «해당 없음»(false)으로 둔다
  const posReady = (await tableExists(tx, "PosChargeRequest")) && (await tableExists(tx, "PosChargeRequestItem"));
  const carryReady = (await tableExists(tx, "BillingCarryUsage")) && (await tableExists(tx, "BillingWorkbenchDraft")) && (await tableExists(tx, "BillingCarryCredit"));
  const pauseReady = await tableExists(tx, "EnrollmentChangeSettlementLine");
  const rows = await tx.$queryRawUnsafe<HoldTargetRow[]>(
    `SELECT p.id, p.year, p.month, p.amount, p.status, p."classId" AS "classId", c.name AS "className",
            (SELECT i.id FROM "PaymentInvoice" i WHERE i."paymentId" = p.id ORDER BY i."createdAt" DESC LIMIT 1) AS "invoiceId",
            (SELECT i.status FROM "PaymentInvoice" i WHERE i."paymentId" = p.id ORDER BY i."createdAt" DESC LIMIT 1) AS "invoiceStatus",
            ${posReady ? HOLD_POS_BUSY_SQL : "false"} AS "posBusy",
            EXISTS (SELECT 1 FROM "PaymentTransaction" t
                     WHERE (t.status = 'DONE' OR ${APPROVED_PENDING_SQL})
                       AND (t."paymentId" = p.id OR EXISTS (SELECT 1 FROM "PaymentTransactionItem" it WHERE it."transactionId" = t.id AND it."paymentId" = p.id))) AS "paidTx",
            ${carryReady
              ? `EXISTS (SELECT 1 FROM "BillingCarryUsage" u
                          WHERE u."paymentId" = p.id
                             OR EXISTS (SELECT 1 FROM "BillingWorkbenchDraft" d WHERE d."paymentId" = p.id AND d.id = u."draftId" AND d.month = u.month))`
              : "false"} AS "carryUsed",
            ${carryReady
              ? `EXISTS (SELECT 1 FROM "BillingCarryCredit" source_credit WHERE source_credit.basis->>'sourcePaymentId' = p.id)`
              : "false"} AS "carrySource",
            ${pauseReady
              ? `EXISTS (SELECT 1 FROM "EnrollmentChangeSettlementLine" l WHERE l."paymentId" = p.id AND l.kind IN ('UNPAID_REDUCE','CARRY_APPLY'))`
              : "false"} AS "pauseSettled"
       FROM "Payment" p
       LEFT JOIN "Class" c ON c.id = p."classId"
      WHERE ${HOLD_TARGET_SCOPE}${lockedIds ? ` AND p.id = ANY($4::text[])` : ""}
      ORDER BY p.year, p.month, p.id${lockedIds ? " FOR UPDATE OF p" : ""}`,
    ...args, ...(lockedIds ? [lockedIds] : []),
  );
  // 학부모 결제 진행 중(30분 안 결제창·기한 남은 입금 계좌) — 관리자 청구서 수정·휴원 정산과 같은 판정 함수
  const active = await findParentCheckoutActivePaymentIds(tx, rows.map((row) => String(row.id)), nowMs);
  return rows.map((row) => {
    const skip: HoldSkipCode | null = active.has(String(row.id)) ? "CHECKOUT"
      : row.posBusy ? "POS"
      : row.paidTx ? "PAID_TX"
      : row.carryUsed ? "CARRY_USED"
      : row.carrySource ? "CARRY_SOURCE"
      : row.pauseSettled ? "PAUSE_SETTLED"
      : !row.invoiceId || !["ISSUED", "SENT", "OVERDUE"].includes(String(row.invoiceStatus)) ? "INVOICE"
      : null;
    return {
      paymentId: String(row.id), year: Number(row.year), month: Number(row.month), classId: row.classId ?? null, className: row.className ?? null,
      amount: Number(row.amount), status: String(row.status), skip, skipText: skip ? HOLD_SKIP_REASONS[skip] : null,
    };
  });
}

export type IllnessPeriodBillingHold = {
  periodId: string; studentId: string;
  /** 이 기간이 지금 «발행 보류»를 만들고 있는가(승인됨 + 금액 미확정 + 등록 취소 아님) */
  holdActive: boolean;
  /** 이미 발행된 미납 청구(보류로 돌릴 수 있는 것과 건너뛸 것 모두) */
  bills: HoldBillView[];
  /** 이미 보류로 돌려 둔 청구 사본 */
  heldBills: HeldBillRecord[];
};

/** 신청함 상세의 보류 칸 — 읽기만(잠금 없음). 금액을 가릴지는 호출부(역할)가 정한다 */
export async function readIllnessPeriodBillingHold(tx: IllnessTx, periodIdInput: string, nowMs = Date.now()): Promise<IllnessPeriodBillingHold | null> {
  const periodId = typeof periodIdInput === "string" ? periodIdInput.trim() : "";
  if (!periodId || periodId.length > 200) return null;
  if (!(await periodCarryColumnsReady(tx))) return null;
  const periods = await tx.$queryRawUnsafe<PeriodRow[]>(PERIOD_SELECT, periodId);
  const period = periods.find((row) => row.id === periodId) ?? null;
  if (!period || period.reason !== ILLNESS_REASON) return null;
  const holdActive = isHoldActive(period);
  return {
    periodId, studentId: period.studentId, holdActive,
    bills: holdActive ? await readHoldTargets(tx, period, nowMs, null) : [],
    heldBills: period.carryState === "APPROVED" ? parseHeldBills(period.carrySettlement) : [],
  };
}

export type HoldBillsResult = {
  periodId: string; studentId: string;
  held: HeldBillRecord[];
  /** 이번에 돌리지 않은 청구와 이유 */
  skipped: HoldBillView[];
};

/**
 * [발행 보류로 돌리기] — 이미 발행된 미납 청구를 «취소» 상태로 돌리고, 청구 준비 초안을 «검토 전»으로 되돌린다. 전부 한 트랜잭션.
 *
 * 잠금 순서(휴원 정산·관리자 청구서 수정과 같게 — 교착 금지):
 *   작업대 전역 잠금 → 기간 행 → ① 대상 청구 id 를 잠금 없이 읽고 → ② 결제 잠금(lockPaymentsForCheckout, id 정렬순)
 *   → ③ 그 id 만 청구 행 FOR UPDATE → ④ 범위를 다시 읽어 처음 목록과 같은지 확인.
 * 결제 시작·승인 직전도 같은 결제 잠금을 잡고 상태를 다시 읽으므로, «취소한 청구가 결제되는» 엇갈림이 없다.
 *
 * @param input.expectedPaymentIds 원장이 화면에서 본 «돌릴 청구» id 목록. 잠근 뒤의 대상과 다르면 실행하지 않는다
 *        (본 것과 다른 청구가 취소되지 않게). 건너뛸 청구(결제 진행 중 등)는 여기에 넣지 않는다.
 */
export async function holdIssuedBillsForPeriod(
  db: IllnessPeriodDb,
  input: { periodId: string; expectedPaymentIds: string[] },
  actorId: string,
  nowMs = Date.now(),
): Promise<HoldBillsResult> {
  if (!actorId) throw new IllnessPeriodError("관리자 확인이 필요합니다.", 403);
  const periodId = cleanId(input?.periodId);
  const expected = Array.isArray(input?.expectedPaymentIds)
    ? [...new Set(input.expectedPaymentIds.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 200))].sort()
    : [];
  if (expected.length === 0) throw new IllnessPeriodError("보류로 돌릴 청구가 없습니다.", 400);

  return db.$transaction(async (tx) => {
    const period = await lockPeriod(tx, periodId);
    if (!isHoldActive(period)) throw new IllnessPeriodError("부상 결석으로 승인돼 발행 보류 중인 기간만 처리할 수 있습니다.");

    // ① 잠금 없이 대상 id → ② 결제 잠금(정렬순) → ③ 그 id 만 행 잠금으로 다시 읽기
    const scopeArgs = holdScopeArgs(period);
    const readScopeIds = async () => (await tx.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT p.id FROM "Payment" p WHERE ${HOLD_TARGET_SCOPE} ORDER BY p.id`, ...scopeArgs,
    )).map((row) => String(row.id));
    const lockedIds = await readScopeIds();
    await lockPaymentsForCheckout(tx, lockedIds);
    const bills = lockedIds.length > 0 ? await readHoldTargets(tx, period, nowMs, lockedIds) : [];
    // ④ 잠그는 사이 새 청구가 생기거나 빠졌으면 실행하지 않는다(원장이 다시 누르면 새 목록으로 잠근다)
    const again = await readScopeIds();
    if (again.length !== lockedIds.length || again.some((id, index) => id !== lockedIds[index])) {
      throw new IllnessPeriodError("청구 목록이 바뀌었습니다. 다시 확인한 뒤 눌러 주세요.");
    }

    const targets = bills.filter((bill) => !bill.skip);
    const skipped = bills.filter((bill) => bill.skip);
    // 원장이 본 목록과 지금 돌릴 목록이 같을 때만 — 그 사이 결제가 시작됐거나 납부됐으면 다시 보여 준다
    const targetIds = targets.map((bill) => bill.paymentId).sort();
    if (targetIds.length !== expected.length || targetIds.some((id, index) => id !== expected[index])) {
      throw new IllnessPeriodError("대상 청구가 바뀌었습니다. 목록을 다시 확인한 뒤 눌러 주세요.");
    }

    const draftReady = (await tableExists(tx, "BillingWorkbenchDraft")) && (await tableExists(tx, "BillingWorkbenchRevision"));
    const heldAt = new Date(nowMs).toISOString();
    const held: HeldBillRecord[] = [];
    for (const bill of targets) {
      const invoices = await tx.$queryRawUnsafe<Array<{ id: string; status: string }>>(
        `SELECT id, status FROM "PaymentInvoice" WHERE "paymentId" = $1 FOR UPDATE`, bill.paymentId,
      );
      const invoice = invoices[0];
      if (!invoice) throw new IllnessPeriodError("청구서 상태가 바뀌었습니다. 다시 확인한 뒤 눌러 주세요.");
      // 기존 «미납 청구 취소»(cancelUnpaidPayment)와 같은 조건부 UPDATE — 지금도 미납·연체일 때만
      const paymentUpdated = Number(await tx.$executeRawUnsafe(
        `UPDATE "Payment" SET status = 'CANCELED', "paidDate" = NULL, "updatedAt" = NOW()
          WHERE id = $1 AND status IN ('PENDING', 'OVERDUE')`,
        bill.paymentId,
      ));
      const invoiceUpdated = Number(await tx.$executeRawUnsafe(
        `UPDATE "PaymentInvoice" SET status = 'CANCELED', "canceledAt" = NOW(), "updatedAt" = NOW()
          WHERE id = $1 AND "paymentId" = $2 AND status IN ('ISSUED', 'SENT', 'OVERDUE')`,
        invoice.id, bill.paymentId,
      ));
      // 하나라도 안 바뀌면 던진다 → 거래 전체가 되돌아간다(일부만 취소되는 일 없음)
      if (paymentUpdated !== 1 || invoiceUpdated !== 1) throw new IllnessPeriodError("청구 상태가 바뀌어 처리하지 않았습니다. 다시 확인해 주세요.");
      await tx.$executeRawUnsafe(
        `INSERT INTO "PaymentAuditLog" (id, "paymentId", "invoiceId", "actorType", "actorId", action, message, metadata, "createdAt")
         VALUES (gen_random_uuid()::text, $1, $2, 'ADMIN', $3, 'ILLNESS_PERIOD_BILL_HELD', $4, $5::jsonb, NOW())`,
        bill.paymentId, invoice.id, actorId, "부상 결석 발행 보류",
        JSON.stringify({ amount: bill.amount, year: bill.year, month: bill.month, periodId }),
      );

      // 청구 준비 초안을 «검토 전»으로 — 금액(payload)은 남겨 복귀 때 다시 쓴다. 발행 상태이고 이 청구에 연결된 초안일 때만
      let draftId: string | null = null;
      if (draftReady) {
        const drafts = await tx.$queryRawUnsafe<Array<{ id: string; month: string; version: number; payload: unknown; reason: string }>>(
          `SELECT id, month, version, payload, reason FROM "BillingWorkbenchDraft" WHERE "paymentId" = $1 FOR UPDATE`, bill.paymentId,
        );
        const draft = drafts[0];
        if (draft) {
          const nextVersion = Number(draft.version) + 1;
          const draftUpdated = Number(await tx.$executeRawUnsafe(
            `UPDATE "BillingWorkbenchDraft" SET status = 'DRAFT', "paymentId" = NULL, version = $4, "actorUserId" = $5, "updatedAt" = NOW()
              WHERE id = $1 AND month = $2 AND "paymentId" = $3 AND status = 'ISSUED'`,
            draft.id, draft.month, bill.paymentId, nextVersion, actorId,
          ));
          if (draftUpdated !== 1) throw new IllnessPeriodError("청구 준비 기록이 바뀌어 처리하지 않았습니다. 다시 확인해 주세요.");
          const payload = typeof draft.payload === "string" ? JSON.parse(draft.payload) : draft.payload;
          await tx.$executeRawUnsafe(
            `INSERT INTO "BillingWorkbenchRevision" (id, "draftId", month, version, action, payload, reason, "actorUserId")
             VALUES (gen_random_uuid()::text, $1, $2, $3, 'HOLD', $4::jsonb, $5, $6)`,
            draft.id, draft.month, nextVersion, JSON.stringify({ ...(payload ?? {}), heldPaymentId: bill.paymentId, periodId }),
            "부상 결석 발행 보류", actorId,
          );
          draftId = draft.id;
        }
      }
      held.push({ paymentId: bill.paymentId, invoiceId: invoice.id, year: bill.year, month: bill.month, classId: bill.classId, amount: bill.amount, draftId, heldAt });
    }

    // 돌린 목록을 기간 행에 «병합» 저장한다 — 승인 때 남긴 approval 키(되돌릴 재료)를 지우지 않는다.
    // 두 번째 실행이면 앞서 돌린 목록 뒤에 잇는다
    const allHeld = [...parseHeldBills(period.carrySettlement), ...held];
    const saved = Number(await tx.$executeRawUnsafe(
      `UPDATE "RegularAbsencePeriod"
          SET "carrySettlement" = COALESCE("carrySettlement", '{}'::jsonb) || $2::jsonb, "updatedAt" = now()
        WHERE id = $1 AND "carryState" = 'APPROVED'`,
      periodId, JSON.stringify({ held: allHeld }),
    ));
    if (saved !== 1) throw new IllnessPeriodError("기간 상태가 바뀌어 처리하지 않았습니다. 다시 확인해 주세요.");
    await writeAudit(tx, "ILLNESS_PERIOD_BILLS_HELD", actorId, {
      periodId, studentId: period.studentId,
      held: held.map((bill) => ({ paymentId: bill.paymentId, year: bill.year, month: bill.month, amount: bill.amount })),
      skipped: skipped.map((bill) => ({ paymentId: bill.paymentId, reason: bill.skip })),
    });
    return { periodId, studentId: period.studentId, held, skipped };
  }, TX_OPTIONS);
}

/** 학부모 앱 알림 본문에 넣을 아이 이름(없으면 빈 글자) — 형제가 같은 기간이어도 알림이 아이마다 따로 가게 */
export async function readStudentName(tx: Pick<IllnessTx, "$queryRawUnsafe">, studentId: string): Promise<string> {
  // 병합돼 사라진 학생 행은 읽지 않는다(이름을 못 읽으면 알림 본문에 이름을 붙이지 않을 뿐이다)
  const rows = await tx.$queryRawUnsafe<Array<{ name: string | null }>>(
    `SELECT s.name FROM "Student" s WHERE s.id = $1 AND ${notMergedStudent("s")}`, studentId,
  );
  return rows[0]?.name?.trim() ?? "";
}

/**
 * 승인 알림을 최근 24시간 안에 이미 보냈는가 — 승인 → 승인 취소 → 다시 승인을 되풀이해도 같은 알림이 쌓이지 않게.
 * 같은 학부모·같은 제목·같은 본문(본문에 기간 날짜가 들어 있다)으로 판정한다. createdAt 은 timestamptz 라 now() 와 바로 견준다.
 */
export async function parentNoticeSentRecently(
  tx: Pick<IllnessTx, "$queryRawUnsafe">, input: { studentId: string; title: string; message: string },
): Promise<boolean> {
  const rows = await tx.$queryRawUnsafe<Array<{ found: number }>>(
    `SELECT 1 AS found
       FROM "Notification" n
       JOIN "Student" s ON s."parentId" = n."userId"
      WHERE s.id = $1 AND ${notMergedStudent("s")} AND n.type = 'ABSENCE' AND n.title = $2 AND n.message = $3
        AND n."createdAt" > now() - interval '24 hours'
      LIMIT 1`,
    input.studentId, input.title, input.message,
  );
  return rows.length > 0;
}

export type IllnessPeriodDetail = {
  periodId: string;
  studentId: string;
  startDate: string;
  /** 복귀 첫 수업일(없으면 복귀 미정) */
  returnDate: string | null;
  /** ACTIVE | ENDED | CANCELLED */
  periodStatus: string;
  /** NONE | APPROVED | SETTLED | REFUND_REVIEW | REFUND_DONE */
  carryState: string;
  /** 학부모가 «여러 날»로 알린 기간인가(아니면 학원이 등록) */
  parentReported: boolean;
  /** 학부모가 적은 사유 글(없으면 null) — 관리자 상세에서만 보인다 */
  reasonText: string | null;
  /** 학원이 기간을 등록하며 적은 메모(없으면 null) */
  note: string | null;
  /** 증빙 사진 — 기간 한 묶음 */
  photoIds: string[];
  /** 살아 있는 결석 수와 그중 아직 결정 전인 수 */
  absenceCount: number;
  pendingCount: number;
  /** 반별 횟수 «월요반 8회» */
  classes: Array<{ className: string; count: number }>;
  /** 승인한 날(KST «YYYY-MM-DD») — 승인 전이면 null */
  approvedYmd: string | null;
  /** 승인하며 거둔 보강권 수(승인 취소하면 돌려준다) */
  heldCreditCount: number;
  /** 지금 [부상 결석 승인]을 누를 수 없는 이유(없으면 null) */
  blocker: string | null;
};

/** 신청함 상세 칸 — 기간·사유 글·사진·승인 가능 여부. 관리자만 부른다(호출부가 requireAdmin). 금액은 싣지 않는다 */
export async function readIllnessPeriodDetail(tx: IllnessTx, periodIdInput: string): Promise<IllnessPeriodDetail | null> {
  const periodId = typeof periodIdInput === "string" ? periodIdInput.trim() : "";
  if (!periodId || periodId.length > 200) return null;
  if (!(await periodCarryColumnsReady(tx))) return null;
  const periods = await tx.$queryRawUnsafe<Array<PeriodRow & { approvedYmd: string | null }>>(
    // carryApprovedAt 은 timestamptz 라 KST 변환은 한 번
    PERIOD_SELECT.replace(
      `FROM "RegularAbsencePeriod" p`,
      `, to_char(p."carryApprovedAt" AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS "approvedYmd" FROM "RegularAbsencePeriod" p`,
    ),
    periodId,
  );
  const period = periods.find((row) => row.id === periodId) ?? null;
  if (!period || period.reason !== ILLNESS_REASON) return null;

  const ready = await illnessReviewReady(tx);
  const absences = await tx.$queryRawUnsafe<Array<{ id: string; className: string | null; reviewStatus: string | null; reasonText: string | null }>>(
    ready
      ? `SELECT ra.id, c.name AS "className", r.status AS "reviewStatus", r."reasonText" AS "reasonText"
           FROM "RegularAbsencePeriod" p
           JOIN "RegularAbsence" ra ON ${illnessPeriodAbsenceSql("p", "ra")}
           LEFT JOIN "Class" c ON c.id = ra."classId"
           LEFT JOIN "RegularAbsenceCarryReview" r ON r."absenceId" = ra.id
          WHERE p.id = $1 ORDER BY ra.date, ra.id`
      : `SELECT ra.id, c.name AS "className", NULL::text AS "reviewStatus", NULL::text AS "reasonText"
           FROM "RegularAbsencePeriod" p
           JOIN "RegularAbsence" ra ON ${illnessPeriodAbsenceSql("p", "ra")}
           LEFT JOIN "Class" c ON c.id = ra."classId"
          WHERE p.id = $1 ORDER BY ra.date, ra.id`,
    periodId,
  );
  // 사진은 기간 한 묶음 — 그 기간의 어느 결석에 붙었든(취소된 날 포함) 살아 있는 사진 전부
  const photos = ready
    ? await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT e.id FROM "RegularAbsenceEvidence" e JOIN "RegularAbsence" ra ON ra.id = e."absenceId"
          WHERE ra."periodId" = $1 AND e."removedAt" IS NULL ORDER BY e."createdAt"`, periodId)
    : [];

  const byClass = new Map<string, number>();
  for (const absence of absences) {
    const name = absence.className?.trim() || "반 정보 없음";
    byClass.set(name, (byClass.get(name) ?? 0) + 1);
  }
  return {
    periodId,
    studentId: period.studentId,
    startDate: period.startDate,
    returnDate: period.returnDate,
    periodStatus: period.status,
    carryState: period.carryState,
    parentReported: period.parentReported === true,
    reasonText: absences.find((absence) => absence.reasonText)?.reasonText ?? null,
    note: period.note?.trim() || null,
    photoIds: photos.map((photo) => photo.id),
    absenceCount: absences.length,
    pendingCount: absences.filter((absence) => (absence.reviewStatus ?? "PENDING") === "PENDING").length,
    classes: Array.from(byClass, ([className, count]) => ({ className, count })),
    approvedYmd: period.approvedYmd ?? null,
    heldCreditCount: period.carryState === "APPROVED" ? parsePeriodApprovalRecord(period.carrySettlement).revokedCreditIds.length : 0,
    blocker: periodApprovalBlocker({ reason: period.reason, periodStatus: period.status, carryState: period.carryState }),
  };
}
