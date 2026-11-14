// 질병·부상 결석 «이월 검토» — 트랜잭션 안에서만 쓰는 쓰기 함수 모음.
//
// 이 파일은 prisma 를 import 하지 않는다 — 호출부가 넘긴 트랜잭션(tx)으로만 DB 를 만진다.
// 결석 저장·보강권 보류/발급·검토 상태가 «같은 트랜잭션»에 묶여야 한쪽만 남는 반쪽 상태가 생기지 않는다.
// (테스트가 가짜 tx 로 이 파일을 그대로 실행한다)
//
// 규칙(원장 결정표 2026-11-14):
//   · 질병·부상 결석이 생기면(학부모 신고·사유 변경) → 검토 «PENDING», 이미 나간 미사용 보강권은 거둬 둔다.
//   · 다른 사유로 바뀌거나 신고가 취소되면 → 검토 «CLOSED», 사진은 화면에서 뺀다(파일은 cron 이 지운다).
//   · [보강권으로] / 7일 지나 사진 없음 → 보강권 1장 발급 + 검토 «MAKEUP».
//   · [이월 승인]은 기존 이월 규칙(resolveWorkbenchAbsence)이 처리하고, 그 함수가 검토를 «APPROVED»로 맞춘다.
import { lockCompensation, type CompensationTransaction } from "@/lib/billing/absence-compensation-guard";
import { issueCreditForReportedAbsence, regularAbsenceSourceKey } from "@/lib/makeup/absence-report-credit";
import { ILLNESS_REASON, evidenceScopeSql, type IllnessReviewSource } from "@/lib/regular/illnessCarryRules";

export type IllnessTx = CompensationTransaction;

/** 보강을 이미 예약·사용한 결석은 질병·부상(이월 검토)으로 바꿀 수 없다 — 라우트가 한국어 문구로 바꾼다 */
export const ILLNESS_MAKEUP_IN_USE = "ILLNESS_MAKEUP_IN_USE";

/**
 * 검토·증빙 표가 있는가(마이그레이션 적용 전 대비).
 * 없으면 호출부는 예전 방식(사유 무관 즉시 보강권)으로 돌아간다 — 새 표 때문에 결석 신고가 죽지 않게.
 */
export async function illnessReviewReady(tx: IllnessTx): Promise<boolean> {
  const rows = await tx.$queryRawUnsafe<Array<{ review: string | null; evidence: string | null }>>(
    `SELECT to_regclass('public."RegularAbsenceCarryReview"')::text AS review,
            to_regclass('public."RegularAbsenceEvidence"')::text AS evidence`,
  );
  return Boolean(rows[0]?.review && rows[0]?.evidence);
}

/** 그 결석의 미사용(AVAILABLE) 보강권을 거둬 둔다 — 검토가 끝나 [보강권으로] 가 되면 같은 한 장을 되살린다 */
export async function holdCreditForIllnessInTx(
  tx: IllnessTx,
  input: { studentId: string; classId: string; absenceYmd: string },
): Promise<{ held: number }> {
  const n = await tx.$executeRawUnsafe(
    `UPDATE "MakeupCredit"
        SET status = 'REVOKED', note = $3, "updatedAt" = now()
      WHERE "studentId" = $1 AND "sourceKey" = $2 AND status = 'AVAILABLE'`,
    input.studentId, regularAbsenceSourceKey(input.classId, input.absenceYmd), "질병·부상 결석 — 이월 검토 중이라 보류",
  );
  return { held: Number(n) };
}

/**
 * 질병·부상 결석 → 검토 시작(멱등). 결석 행을 저장한 «같은 트랜잭션»에서 부른다.
 *
 * - 이미 결정이 끝난 검토(APPROVED·MAKEUP)는 건드리지 않는다.
 * - 보강을 이미 예약·사용한 결석이면 오류(ILLNESS_MAKEUP_IN_USE) → 트랜잭션이 되돌아가 사유 변경도 없던 일이 된다.
 * - 닫혔던 검토(CLOSED)를 다시 열면 «7일» 기준점(requestedAt)을 새로 잡는다.
 */
export async function openIllnessReviewInTx(
  tx: IllnessTx,
  input: { absenceId: string; studentId: string; classId: string; absenceYmd: string; reasonText: string | null; source: IllnessReviewSource },
): Promise<{ status: string; opened: boolean }> {
  await lockCompensation(tx);
  const existing = await tx.$queryRawUnsafe<Array<{ status: string }>>(
    `SELECT status FROM "RegularAbsenceCarryReview" WHERE "absenceId" = $1 FOR UPDATE`, input.absenceId,
  );
  const current = existing[0]?.status ?? null;
  if (current === "APPROVED" || current === "MAKEUP") return { status: current, opened: false };

  // 보강권 — 이미 쓰는 중이면 막고, 미사용이면 거둬 둔다
  const credits = await tx.$queryRawUnsafe<Array<{ status: string }>>(
    `SELECT status FROM "MakeupCredit" WHERE "studentId" = $1 AND "sourceKey" = $2 FOR UPDATE`,
    input.studentId, regularAbsenceSourceKey(input.classId, input.absenceYmd),
  );
  if (credits.some((c) => c.status === "RESERVED" || c.status === "USED" || c.status === "NO_SHOW")) {
    throw new Error(ILLNESS_MAKEUP_IN_USE);
  }
  await holdCreditForIllnessInTx(tx, input);

  await tx.$executeRawUnsafe(
    `INSERT INTO "RegularAbsenceCarryReview" ("absenceId", status, source, "reasonText")
     VALUES ($1, 'PENDING', $2, $3)
     ON CONFLICT ("absenceId") DO UPDATE
        SET status = 'PENDING',
            source = CASE WHEN "RegularAbsenceCarryReview".status = 'CLOSED' THEN EXCLUDED.source ELSE "RegularAbsenceCarryReview".source END,
            "reasonText" = CASE WHEN "RegularAbsenceCarryReview".status = 'CLOSED' THEN EXCLUDED."reasonText"
                                ELSE COALESCE(EXCLUDED."reasonText", "RegularAbsenceCarryReview"."reasonText") END,
            "requestedAt" = CASE WHEN "RegularAbsenceCarryReview".status = 'CLOSED' THEN now() ELSE "RegularAbsenceCarryReview"."requestedAt" END,
            "decidedAt" = NULL, "decidedBy" = NULL, "decidedByUserId" = NULL, "convertReason" = NULL, "updatedAt" = now()
      WHERE "RegularAbsenceCarryReview".status IN ('PENDING', 'CLOSED')`,
    input.absenceId, input.source, input.reasonText,
  );
  return { status: "PENDING", opened: current !== "PENDING" };
}

/**
 * 검토 닫기 — 사진은 화면에서 빼고(removedAt), 저장소 파일은 cron 이 지운다.
 *
 * - 다른 사유로 바뀜(기본): «검토 중»만 닫는다. 원장이 이미 [보강권으로] 정한 결석은 그 결정을 그대로 둔다
 *   (사유를 바꿨다 되돌려 원장 결정을 다시 열 수 없게).
 * - 신고 자체가 취소됨(canceled=true): [보강권으로] 결정까지 닫는다 — 결석이 없던 일이 됐으니, 같은 날을 다시
 *   질병·부상으로 알리면 검토를 처음부터 다시 한다(안 닫으면 보강권도 검토도 없는 결석이 생긴다).
 * - «이월 승인»은 어느 쪽도 닫지 않는다(승인된 결석은 확정이라 취소·사유 변경이 막혀 있고, 정산 기록이다).
 */
export async function closeIllnessReviewInTx(
  tx: IllnessTx, absenceId: string, options: { canceled?: boolean } = {},
): Promise<{ closed: boolean }> {
  const n = await tx.$executeRawUnsafe(
    `UPDATE "RegularAbsenceCarryReview"
        SET status = 'CLOSED', "decidedAt" = now(), "updatedAt" = now()
      WHERE "absenceId" = $1 AND status = ANY($2::text[])`,
    absenceId, options.canceled ? ["PENDING", "MAKEUP"] : ["PENDING"],
  );
  if (Number(n) === 0) return { closed: false };
  // 사진 정리(코드 리뷰·보안 검수 2026-11-15) — 살아 있는 사진은 언제나 «살아 있는 검토가 있는 결석»에 붙어 있게 한다.
  //   ① 여러 날 결석(기간)에 살아 있는 형제(취소 안 된 결석의 검토 중·이월 승인·보강권 전환)가 있으면 사진을 그 결석으로 옮긴다
  //      (날짜 바꾸기와 같은 방식). 사진이 붙은 날만 하루 취소해도 기간의 증빙은 그대로이고, 학부모의 사진 삭제·교체도 계속 된다.
  //   ② 옮길 곳이 없으면(하루 결석이거나 기간의 마지막 검토였다) 화면에서 뺀다 — 파일은 cron 이 지운다.
  //   그래서 기간을 전부 취소하면 마지막 날이 닫힐 때 사진도 함께 빠진다(진단서 사진이 살아남지 않는다).
  await tx.$executeRawUnsafe(
    `UPDATE "RegularAbsenceEvidence" e SET "absenceId" = heir.id
       FROM (SELECT sibling.id
               FROM "RegularAbsence" me
               JOIN "RegularAbsence" sibling ON sibling."periodId" = me."periodId" AND sibling.id <> me.id AND sibling.status <> 'CANCELLED'
               JOIN "RegularAbsenceCarryReview" sr ON sr."absenceId" = sibling.id AND sr.status IN ('PENDING', 'APPROVED', 'MAKEUP')
              WHERE me.id = $1 AND me."periodId" IS NOT NULL
              ORDER BY sibling.date, sibling.id
              LIMIT 1) heir
      WHERE e."absenceId" = $1 AND e."removedAt" IS NULL`,
    absenceId,
  );
  await tx.$executeRawUnsafe(
    `UPDATE "RegularAbsenceEvidence" SET "removedAt" = now() WHERE "absenceId" = $1 AND "removedAt" IS NULL`,
    absenceId,
  );
  return { closed: true };
}

/**
 * 출결을 «결석»으로 찍을 때 보강권 자동 발급을 멈춰야 하는 결석인가.
 * 질병·부상 결석이고 아직 [보강권으로] 결정이 나지 않았으면 true(검토 대기 — 원장이 고른다).
 * 닫힌 검토(CLOSED — 그날 출석으로 기록돼 자동으로 닫힌 건 등)는 검토가 끝난 것이라 보통 결석과 같이 발급한다
 * (출결이 나중에 결석으로 정정되면 보강권이 나가야 한다. 신청함에서도 빠져 있어 보류로 두면 아무것도 못 받는다).
 * 표가 없으면(마이그레이션 전) false → 예전처럼 발급한다.
 */
export async function isIllnessCreditHeld(
  tx: IllnessTx,
  input: { studentId: string; classId: string; absenceYmd: string },
): Promise<boolean> {
  if (!(await illnessReviewReady(tx))) return false;
  const rows = await tx.$queryRawUnsafe<Array<{ found: number }>>(
    `SELECT 1 AS found
       FROM "RegularAbsence" ra
       LEFT JOIN "RegularAbsenceCarryReview" r ON r."absenceId" = ra.id
      WHERE ra."studentId" = $1 AND ra."classId" = $2 AND ra.date = $3::date
        AND ra.status <> 'CANCELLED' AND ra.reason = $4
        AND COALESCE(r.status, '') NOT IN ('MAKEUP', 'CLOSED')
      LIMIT 1`,
    input.studentId, input.classId, input.absenceYmd, ILLNESS_REASON,
  );
  return rows.length > 0;
}

/**
 * 닫혔던 검토(CLOSED)를 다시 «검토 중»으로 연다 — 출석부가 그 결석을 질병·부상으로 (다시) 표시했을 때.
 *   · 학부모가 알린 결석의 검토가 «그날 출석»으로 자동으로 닫혔는데, 뒤에 출결이 결석+질병·부상으로 정정된 경우
 *   · 취소됐던 결석 행을 출석부가 질병·부상으로 되살린 경우
 * 닫힌 검토는 신청함에서 빠지므로 다시 열어야 원장이 고를 수 있다. «7일» 기준점은 지금으로 새로 잡는다.
 * 출석부 행(학부모 표시 없음)은 학원 등록(STAFF)으로 바꿔 7일 자동 전환 대상에서 뺀다. 닫을 때 뺀 사진은 되살리지 않는다.
 */
export async function reopenClosedIllnessReviewInTx(
  tx: IllnessTx,
  input: { studentId: string; classId: string; absenceYmd: string },
): Promise<{ reopened: boolean }> {
  const n = await tx.$executeRawUnsafe(
    `UPDATE "RegularAbsenceCarryReview" r
        SET status = 'PENDING', "requestedAt" = now(),
            source = CASE WHEN ra."reportedByUserId" IS NULL THEN 'STAFF' ELSE r.source END,
            "decidedAt" = NULL, "decidedBy" = NULL, "decidedByUserId" = NULL, "convertReason" = NULL, "updatedAt" = now()
       FROM "RegularAbsence" ra
      WHERE ra.id = r."absenceId" AND ra."studentId" = $1 AND ra."classId" = $2 AND ra.date = $3::date
        AND ra.status <> 'CANCELLED' AND r.status = 'CLOSED'`,
    input.studentId, input.classId, input.absenceYmd,
  );
  return { reopened: Number(n) > 0 };
}

/** 그 결석(살아 있음)에 닫힌 검토가 있는가 — 다시 열기 전에 잠금 없이 먼저 본다(없으면 전역 잠금을 잡지 않게) */
export async function hasClosedIllnessReview(
  tx: IllnessTx,
  input: { studentId: string; classId: string; absenceYmd: string },
): Promise<boolean> {
  const rows = await tx.$queryRawUnsafe<Array<{ found: number }>>(
    `SELECT 1 AS found
       FROM "RegularAbsenceCarryReview" r
       JOIN "RegularAbsence" ra ON ra.id = r."absenceId"
      WHERE ra."studentId" = $1 AND ra."classId" = $2 AND ra.date = $3::date
        AND ra.status <> 'CANCELLED' AND r.status = 'CLOSED'
      LIMIT 1`,
    input.studentId, input.classId, input.absenceYmd,
  );
  return rows.length > 0;
}

/**
 * 검토 중이던 결석 신고를 «관리자»가 취소했는데 그날 출결은 결석이다 → 보강권 1장을 보장한다.
 *   · 검토 때문에 거둬 둔 보강권이 있으면 그 «같은 한 장»을 되살리고,
 *   · 처음부터 보강권이 없던 결석(질병·부상으로 바로 알려 한 번도 발급된 적 없음)이면 «새로 한 장 발급»한다.
 * 왜: 이월 검토 전에는 «신고 취소 + 출결 결석 = 보강권 유지»였다(실제로 빠졌으니 권리는 그대로).
 *     검토 중에는 보강권이 없으므로, 취소로 검토를 닫을 때 여기서 주지 않으면 결석했는데 아무것도 못 받는다.
 * 호출부는 검토를 닫은 «같은 트랜잭션»에서 부른다. 출결이 결석이 아니면 아무것도 하지 않는다.
 */
export async function ensureCreditForAbsentAfterCancelInTx(
  tx: IllnessTx,
  input: { studentId: string; classId: string; absenceYmd: string; issuable: (absenceYmd: string) => boolean },
): Promise<{ restored: boolean }> {
  if (!input.issuable(input.absenceYmd)) return { restored: false };
  // Session."date" 는 무tz timestamp 에 KST 달력 자정을 담는다 — 변환 없이 글자 그대로 비교
  const absent = await tx.$queryRawUnsafe<Array<{ found: number }>>(
    `SELECT 1 AS found
       FROM "Attendance" a
       JOIN "Session" se ON se.id = a."sessionId"
      WHERE a."studentId" = $1 AND se."classId" = $2
        AND to_char(se."date", 'YYYY-MM-DD') = $3
        AND a.status = 'ABSENT'
      LIMIT 1`,
    input.studentId, input.classId, input.absenceYmd,
  );
  if (absent.length === 0) return { restored: false };
  const credit = await issueCreditForReportedAbsence(tx, {
    studentId: input.studentId, classId: input.classId, absenceYmd: input.absenceYmd,
    note: "결석 신고는 취소됐지만 출결이 결석이라 보강권 유지",
  });
  return { restored: credit.issued };
}

export type ConvertOutcome =
  | { converted: true; studentId: string; classId: string; absenceYmd: string; creditIssued: boolean }
  | { converted: false; reason: "NOT_FOUND" | "NOT_ILLNESS" | "DECIDED" | "CARRY" | "HAS_EVIDENCE" | "NOT_PENDING" | "ATTENDED" };

/**
 * 보강권으로 전환 — 원장이 [보강권으로]를 눌렀거나(ADMIN), 7일 안에 사진이 없었다(AUTO).
 *
 * - 이미 결정된 검토(APPROVED·MAKEUP)·이월로 정산된 결석은 건드리지 않는다.
 * - AUTO 는 잠근 뒤 «검토 중 + 사진 0장»을 다시 확인한다(그 사이 학부모가 사진을 올렸으면 전환하지 않는다).
 * - 보강권은 기존 발급 함수 그대로(한 결석 한 장·회수된 같은 결석이면 되살림). 발급 시작일 전 결석이면 발급하지 않는다.
 */
export async function convertIllnessToMakeupInTx(
  tx: IllnessTx,
  input: {
    absenceId: string;
    by: "ADMIN" | "AUTO";
    actorUserId: string | null;
    /** 그 결석일이 보강권 발급 대상인가(credit-service.isMakeupCreditIssuableYmd — 호출부가 판정) */
    issuable: (absenceYmd: string) => boolean;
  },
): Promise<ConvertOutcome> {
  await lockCompensation(tx);
  const absences = await tx.$queryRawUnsafe<Array<{ studentId: string; classId: string; absenceYmd: string; reason: string; status: string }>>(
    `SELECT "studentId", "classId", to_char(date, 'YYYY-MM-DD') AS "absenceYmd", reason, status
       FROM "RegularAbsence" WHERE id = $1 FOR UPDATE`,
    input.absenceId,
  );
  const absence = absences[0];
  if (!absence || absence.status === "CANCELLED") return { converted: false, reason: "NOT_FOUND" };
  if (absence.reason !== ILLNESS_REASON) return { converted: false, reason: "NOT_ILLNESS" };

  const reviews = await tx.$queryRawUnsafe<Array<{ status: string }>>(
    `SELECT status FROM "RegularAbsenceCarryReview" WHERE "absenceId" = $1 FOR UPDATE`, input.absenceId,
  );
  const current = reviews[0]?.status ?? null;
  if (current === "APPROVED" || current === "MAKEUP") return { converted: false, reason: "DECIDED" };
  if (input.by === "AUTO") {
    if (current !== "PENDING") return { converted: false, reason: "NOT_PENDING" };
    // 여러 날 결석은 기간에 올린 사진을 함께 센다(한 묶음)
    const photos = await tx.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT COUNT(*)::int AS n FROM "RegularAbsenceEvidence" e JOIN "RegularAbsence" ra ON ra.id = $1
        WHERE ${evidenceScopeSql("ra", "e")} AND e."removedAt" IS NULL`, input.absenceId,
    );
    if (Number(photos[0]?.n ?? 0) > 0) return { converted: false, reason: "HAS_EVIDENCE" };
  }

  // 그날 출석·지각으로 기록됐으면 실제로는 수업을 들었다 — 보강권을 주지 않는다.
  // (예전에는 신고 때 나간 보강권을 출결 정정이 회수했다. 지금은 검토 중이라 회수할 보강권이 없으므로 여기서 막는다)
  // Session."date" 는 무tz timestamp 에 KST 달력 자정을 담는다 — 변환 없이 글자 그대로 비교(absence-report-credit 과 같은 규칙)
  const attended = await tx.$queryRawUnsafe<Array<{ found: number }>>(
    `SELECT 1 AS found
       FROM "Attendance" a
       JOIN "Session" se ON se.id = a."sessionId"
      WHERE a."studentId" = $1 AND se."classId" = $2
        AND to_char(se."date", 'YYYY-MM-DD') = $3
        AND a.status IN ('PRESENT', 'LATE')
      LIMIT 1`,
    absence.studentId, absence.classId, absence.absenceYmd,
  );
  if (attended.length > 0) {
    // 자동 전환이면 검토를 닫아 매일 다시 후보로 잡히지 않게 한다. 원장이 누른 경우는 그대로 두고 이유를 알린다
    if (input.by === "AUTO") await closeIllnessReviewInTx(tx, input.absenceId);
    return { converted: false, reason: "ATTENDED" };
  }

  let creditIssued = false;
  if (input.issuable(absence.absenceYmd)) {
    const credit = await issueCreditForReportedAbsence(tx, {
      studentId: absence.studentId, classId: absence.classId, absenceYmd: absence.absenceYmd,
      note: "질병·부상 결석 — 보강권으로 전환",
    });
    // 이월로 이미 정산된 결석(청구 준비 화면에서 먼저 처리) — 보강권을 만들지 않고 전환도 하지 않는다
    if (credit.reason === "CARRY") return { converted: false, reason: "CARRY" };
    creditIssued = credit.issued;
  }

  await tx.$executeRawUnsafe(
    `INSERT INTO "RegularAbsenceCarryReview"
       ("absenceId", status, source, "decidedAt", "decidedBy", "decidedByUserId", "convertReason")
     VALUES ($1, 'MAKEUP', 'STAFF', now(), $2, $3, $4)
     ON CONFLICT ("absenceId") DO UPDATE
        SET status = 'MAKEUP', "decidedAt" = now(), "decidedBy" = EXCLUDED."decidedBy",
            "decidedByUserId" = EXCLUDED."decidedByUserId", "convertReason" = EXCLUDED."convertReason", "updatedAt" = now()
      WHERE "RegularAbsenceCarryReview".status IN ('PENDING', 'CLOSED')`,
    input.absenceId, input.by, input.actorUserId, input.by === "AUTO" ? "NO_EVIDENCE" : "REJECTED",
  );
  return { converted: true, studentId: absence.studentId, classId: absence.classId, absenceYmd: absence.absenceYmd, creditIssued };
}
