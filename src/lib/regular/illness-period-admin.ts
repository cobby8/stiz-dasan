// 부상·질병 «기간 결석» — 원장(신청함) 쪽 승인·승인 취소·상세 읽기 (2026-11-15 원장 승인, 1b 단계)
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
// DB 는 인자(db)로만 받는다 — 테스트가 가짜 db 로 실제 실행한다. 이 파일은 prisma 를 import 하지 않는다.
import { lockCompensation } from "@/lib/billing/absence-compensation-guard";
import { periodCarryColumnsReady } from "@/lib/regular/absence-period-service";
import { holdCreditForIllnessInTx, illnessReviewReady, type IllnessTx } from "@/lib/regular/illness-carry-tx";
import { ILLNESS_REASON } from "@/lib/regular/illnessCarryRules";
import { IllnessPeriodError, illnessPeriodAbsenceSql, periodApprovalBlocker } from "@/lib/regular/illnessPeriodRules";

export type IllnessPeriodDb = IllnessTx & {
  $transaction<T>(work: (tx: IllnessTx) => Promise<T>, options?: { isolationLevel: "Serializable" | "RepeatableRead"; timeout?: number }): Promise<T>;
};

type PeriodRow = {
  id: string; studentId: string; reason: string; status: string; carryState: string;
  startDate: string; returnDate: string | null; note: string | null; parentReported: boolean;
};

// 기간 한 줄 — date 칼럼은 달력 값이라 시간대 변환이 없다
const PERIOD_SELECT = `SELECT p.id, p."studentId" AS "studentId", p.reason, p.status, p."carryState" AS "carryState",
       to_char(p."startDate", 'YYYY-MM-DD') AS "startDate", to_char(p."returnDate", 'YYYY-MM-DD') AS "returnDate",
       p.note, (p."reportedByUserId" IS NOT NULL) AS "parentReported"
  FROM "RegularAbsencePeriod" p WHERE p.id = $1`;

const TX_OPTIONS = { isolationLevel: "Serializable" as const, timeout: 30_000 };

function cleanId(value: unknown): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id || id.length > 200) throw new IllnessPeriodError("기간 결석을 찾을 수 없습니다.", 404);
  return id;
}

async function tableExists(tx: IllnessTx, name: string): Promise<boolean> {
  const rows = await tx.$queryRawUnsafe<Array<{ found: string | null }>>(`SELECT to_regclass($1)::text AS found`, `public."${name}"`);
  return Boolean(rows[0]?.found);
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
    await lockCompensation(tx);
    if (!(await periodCarryColumnsReady(tx))) throw new IllnessPeriodError("기간 결석 승인 저장 구조를 확인해 주세요.", 503);
    const periods = await tx.$queryRawUnsafe<PeriodRow[]>(`${PERIOD_SELECT} FOR UPDATE OF p`, periodId);
    const period = periods.find((row) => row.id === periodId) ?? null;
    if (!period) throw new IllnessPeriodError("기간 결석을 찾을 수 없습니다.", 404);
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

    // 그 기간의 살아 있는 질병·부상 결석 중 아직 결정 전인 것(검토 줄이 없거나 «검토 중»)
    let reviewed = 0;
    let creditsHeld = 0;
    if (await illnessReviewReady(tx)) {
      const absences = await tx.$queryRawUnsafe<Array<{ id: string; studentId: string; classId: string; absenceYmd: string }>>(
        `SELECT ra.id, ra."studentId" AS "studentId", ra."classId" AS "classId", to_char(ra.date, 'YYYY-MM-DD') AS "absenceYmd"
           FROM "RegularAbsencePeriod" p
           JOIN "RegularAbsence" ra ON ${illnessPeriodAbsenceSql("p", "ra")}
           LEFT JOIN "RegularAbsenceCarryReview" r ON r."absenceId" = ra.id
          WHERE p.id = $1 AND COALESCE(r.status, 'PENDING') = 'PENDING'
          ORDER BY ra.date, ra.id
          FOR UPDATE OF ra`,
        periodId,
      );
      for (const absence of absences) {
        // 미사용 보강권은 거둬 둔다(예약·사용 중인 보강권은 건드리지 않는다 — 정산 때 그 날은 빠진다)
        creditsHeld += (await holdCreditForIllnessInTx(tx, absence)).held;
      }
      if (absences.length > 0) {
        // 검토를 «승인»으로 맞춘다 — 검토 줄이 없던 결석(학원이 등록한 기간)은 새로 만든다.
        // 결정이 이미 난 검토(하루씩 이월 승인·보강권 전환·닫힘)는 건드리지 않는다
        reviewed = Number(await tx.$executeRawUnsafe(
          `INSERT INTO "RegularAbsenceCarryReview" ("absenceId", status, source, "decidedAt", "decidedBy", "decidedByUserId")
           SELECT target.id, 'APPROVED', 'STAFF', now(), 'ADMIN', $2::text FROM unnest($1::text[]) AS target(id)
           ON CONFLICT ("absenceId") DO UPDATE
              SET status = 'APPROVED', "decidedAt" = now(), "decidedBy" = 'ADMIN',
                  "decidedByUserId" = EXCLUDED."decidedByUserId", "convertReason" = NULL, "updatedAt" = now()
            WHERE "RegularAbsenceCarryReview".status = 'PENDING'`,
          absences.map((absence) => absence.id), actorId,
        ));
      }
    }

    await writeAudit(tx, "ILLNESS_PERIOD_APPROVED", actorId, {
      periodId, studentId: period.studentId, startDate: period.startDate, returnDate: period.returnDate, reviewed, creditsHeld,
    });
    return { periodId, studentId: period.studentId, startDate: period.startDate, returnDate: period.returnDate, reviewed, creditsHeld };
  }, TX_OPTIONS);
}

export type CancelPeriodApprovalResult = { periodId: string; studentId: string; reopened: number };

/**
 * [승인 취소] — 금액을 정하기 전(APPROVED)에만. 기간 상태를 NONE 으로 되돌리고, 승인으로 맞춰 둔 검토를
 * «검토 중»으로 되돌린다(알린 시각을 지금으로 — 7일 기한이 새로 시작한다).
 * 하루씩 실제로 이월 적립된 결석(BillingAbsenceResolution 이 있는 것)의 검토는 건드리지 않는다.
 * 승인 때 거둔 보강권은 되살리지 않는다 — «검토 중»인 질병·부상 결석은 원래 보강권이 보류 상태다.
 */
export async function cancelIllnessPeriodApproval(
  db: IllnessPeriodDb,
  input: { periodId: string },
  actorId: string,
): Promise<CancelPeriodApprovalResult> {
  if (!actorId) throw new IllnessPeriodError("관리자 확인이 필요합니다.", 403);
  const periodId = cleanId(input?.periodId);

  return db.$transaction(async (tx) => {
    await lockCompensation(tx);
    if (!(await periodCarryColumnsReady(tx))) throw new IllnessPeriodError("기간 결석 승인 저장 구조를 확인해 주세요.", 503);
    const periods = await tx.$queryRawUnsafe<PeriodRow[]>(`${PERIOD_SELECT} FOR UPDATE OF p`, periodId);
    const period = periods.find((row) => row.id === periodId) ?? null;
    if (!period) throw new IllnessPeriodError("기간 결석을 찾을 수 없습니다.", 404);

    const changed = await tx.$executeRawUnsafe(
      `UPDATE "RegularAbsencePeriod"
          SET "carryState" = 'NONE', "carryApprovedAt" = NULL, "carryApprovedByUserId" = NULL, "updatedAt" = now()
        WHERE id = $1 AND "carryState" = 'APPROVED'`,
      periodId,
    );
    if (Number(changed) === 0) {
      throw new IllnessPeriodError(period.carryState === "NONE"
        ? "승인되지 않은 기간 결석입니다."
        : "이미 정산이 끝난 기간 결석은 승인 취소할 수 없습니다.");
    }

    let reopened = 0;
    if (await illnessReviewReady(tx)) {
      // 실제 이월 적립이 없는 «승인» 검토 = 기간 승인이 맞춰 둔 것. 정산 표가 아직 없으면 전부 기간 승인분이다
      const notSettled = (await tableExists(tx, "BillingAbsenceResolution"))
        ? `AND NOT EXISTS (SELECT 1 FROM "BillingAbsenceResolution" settled WHERE settled."absenceId" = ra.id)`
        : "";
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

    await writeAudit(tx, "ILLNESS_PERIOD_APPROVAL_CANCELED", actorId, { periodId, studentId: period.studentId, reopened });
    return { periodId, studentId: period.studentId, reopened };
  }, TX_OPTIONS);
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
    blocker: periodApprovalBlocker({ reason: period.reason, periodStatus: period.status, carryState: period.carryState }),
  };
}
