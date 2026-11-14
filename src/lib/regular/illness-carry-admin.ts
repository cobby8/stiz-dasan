// 질병·부상 결석 «이월 검토» — 원장(신청함) 쪽 처리.
//
// ★ 이월 규칙은 새로 만들지 않는다. [이월 승인]은 청구 준비 화면이 쓰던 resolveWorkbenchAbsence(CARRY)를
//   «그대로» 부른다 — 같은 계산(할인 후 수강료 ÷ 그 달 수업 횟수)·같은 표(BillingCarryCredit·BillingAbsenceResolution)·
//   같은 잠금·같은 거절 사유. 여기서 하는 일은 그 함수가 요구하는 준비(결석 확정·최신 자료 버전)를 같은 트랜잭션에서 해 주는 것뿐이다.
//
// 승인 시점(원장 결정 a3 해석): «조건이 맞을 때만 승인 버튼을 켠다»를 골랐다(승인 예약 없음).
//   예약 방식은 «나중에 조건이 맞으면 자동 적립»하는 cron 과 그 실패 처리(청구 금액이 바뀐 경우 등)가 더 필요하고,
//   원장이 누른 시점과 실제 돈이 움직이는 시점이 달라진다. 버튼을 조건 뒤에 켜면 누른 그 순간의 자료로 한 번에 끝난다.
//
// DB 는 인자(db)로만 받는다 — 테스트가 가짜 db 로 실제 실행한다.
import { randomUUID } from "node:crypto";
import { todayKst } from "@/lib/datetime/kst";
import { WorkbenchError, type WorkbenchCalendarSnapshot } from "@/lib/billing/workbench";
import { readWorkbench, type WorkbenchDb, type WorkbenchTx } from "@/lib/billing/workbench-service";
import { previewCarryEvidence, resolveWorkbenchAbsence } from "@/lib/billing/workbench-absence";
import { regularAbsenceSourceKey } from "@/lib/makeup/absence-report-credit";
import { convertIllnessToMakeupInTx, illnessReviewReady, type ConvertOutcome } from "@/lib/regular/illness-carry-tx";
import { ILLNESS_REASON, carryApprovalBlocker, evidenceAnchorYmdSql, evidenceDeadlineYmd, evidenceScopeSql, type CarryBillState } from "@/lib/regular/illnessCarryRules";

type AbsenceRow = { id: string; studentId: string; classId: string; date: string; reason: string; status: string };

const ABSENCE_SELECT = `SELECT a.id, a."studentId", a."classId", to_char(a.date, 'YYYY-MM-DD') AS date, a.reason, a.status
       FROM "RegularAbsence" a WHERE a.id = $1`;

/**
 * [이월 승인] — 결석을 확정하고(아직 «신고» 상태면) 기존 이월 규칙으로 적립한다. 전부 한 트랜잭션.
 * 조건이 안 맞으면 기존 규칙이 던지는 한국어 사유(WorkbenchError)가 그대로 화면에 나간다 — 아무것도 저장되지 않는다.
 *
 * @param input.evidenceConfirmed 원장이 증빙을 확인했다(사진을 봤거나 «직접 확인» 체크)
 * @param input.cancelReservation 그 결석의 보강 예약이 있으면 함께 취소해도 된다고 확인했다
 */
export async function approveIllnessCarry(
  db: WorkbenchDb,
  input: { absenceId: string; evidenceConfirmed: boolean; cancelReservation?: boolean },
  actorId: string,
  enabled: boolean,
  calendar?: WorkbenchCalendarSnapshot,
): Promise<{ studentId: string; classId: string; absenceYmd: string }> {
  if (!enabled) throw new WorkbenchError("청구 준비 저장이 꺼져 있어 이월을 적립할 수 없습니다.", 503);
  if (!actorId) throw new WorkbenchError("관리자 확인이 필요합니다.", 403);
  const absenceId = typeof input?.absenceId === "string" ? input.absenceId.trim() : "";
  if (!absenceId || absenceId.length > 200) throw new WorkbenchError("결석을 찾을 수 없습니다.", 404);
  if (input.evidenceConfirmed !== true) throw new WorkbenchError("증빙을 확인했는지 체크해 주세요.");

  return db.$transaction(async (tx) => {
    // 잠금 순서는 기존 정산과 같다: 작업대 잠금 → 결석 행
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext('STIZ_BILLING_WORKBENCH'))`);
    const rows = await tx.$queryRawUnsafe<AbsenceRow[]>(`${ABSENCE_SELECT} FOR UPDATE`, absenceId);
    const absence = rows.find((row) => row.id === absenceId) ?? null;
    if (!absence || absence.status === "CANCELLED") throw new WorkbenchError("결석을 찾을 수 없거나 취소된 결석입니다.", 404);
    if (absence.reason !== ILLNESS_REASON) throw new WorkbenchError("질병·부상 결석만 이월 승인할 수 있습니다.", 409);
    // 아직 오지 않은 결석일은 승인하지 않는다(기존 규칙과 같은 기준 — 화면도 버튼을 꺼 둔다)
    if (absence.date > todayKst()) throw new WorkbenchError("결석일이 지난 뒤에 승인할 수 있습니다.", 409);

    // 원장이 증빙을 보고 승인한다 = 결석 확정. 기존 이월 규칙은 «확정된 결석»만 받는다
    if (absence.status === "REPORTED") {
      await tx.$executeRawUnsafe(
        `UPDATE "RegularAbsence" SET status = 'CONFIRMED', "resolvedByUserId" = $2, "updatedAt" = now()
          WHERE id = $1 AND status = 'REPORTED'`,
        absenceId, actorId,
      );
    }

    // 기존 이월 규칙이 요구하는 «최신 자료 버전»을 같은 트랜잭션에서 읽어 넘긴다(다른 작업이 끼면 직렬화 오류로 통째로 되돌아간다)
    const month = absence.date.slice(0, 7);
    const view = await readWorkbench(tx, month, enabled, calendar);
    await resolveWorkbenchAbsence(
      // 이미 연 트랜잭션을 그대로 쓰게 한다 — 결석 확정과 이월 적립이 한 거래로 묶인다
      { $transaction: (work: (inner: WorkbenchTx) => Promise<any>) => work(tx) } as WorkbenchDb,
      {
        action: "RESOLVE_ABSENCE", month, sourceVersion: view.sourceVersion, requestId: `illness-${randomUUID()}`,
        absenceId, resolution: "CARRY", evidenceConfirmed: true, eligibility: "ILLNESS_INJURY",
        reason: "신청함에서 질병·부상 증빙 확인 후 이월 승인", cancelReservation: input.cancelReservation === true, originMonth: month,
      },
      actorId, enabled, calendar,
    );
    return { studentId: absence.studentId, classId: absence.classId, absenceYmd: absence.date };
  }, { isolationLevel: "Serializable", timeout: 45_000 });
}

/** [보강권으로] — 원장이 이월 대신 보강권 1장으로 정한다(기존 보강권 발급 함수 그대로) */
export async function convertIllnessToMakeupByAdmin(
  db: WorkbenchDb,
  input: { absenceId: string },
  actorId: string,
  issuable: (absenceYmd: string) => boolean,
): Promise<ConvertOutcome> {
  if (!actorId) throw new WorkbenchError("관리자 확인이 필요합니다.", 403);
  return db.$transaction(async (tx) => {
    if (!(await illnessReviewReady(tx))) throw new WorkbenchError("이월 검토 저장 구조를 확인해 주세요.", 503);
    return convertIllnessToMakeupInTx(tx, { absenceId: input.absenceId, by: "ADMIN", actorUserId: actorId, issuable });
  }, { isolationLevel: "Serializable", timeout: 30_000 });
}

export type IllnessCarryDetail = {
  absenceId: string;
  absenceYmd: string;
  /** PENDING(검토 전·검토 중) | APPROVED | MAKEUP */
  status: string;
  /** PARENT 학부모 앱 · KAKAO 카카오 대화 · STAFF 학원 등록 */
  source: string;
  /** 학부모가 적은 사유 글(없으면 null) — 관리자 상세에서만 보인다 */
  reasonText: string | null;
  photoIds: string[];
  /** 그 결석의 보강권 상태(없으면 null) */
  creditStatus: string | null;
  /** 지금 [이월 승인]을 누를 수 없는 이유 한 줄(없으면 null) */
  blocker: string | null;
  /**
   * 승인하면 쓰일 근거 미리보기(검토 중이고 근거가 있을 때만) — 화면이 «근거: 11월 납부 90,000원 ÷ 4회 = 1회 22,500원» 한 줄로 보인다.
   * kind: WORKBENCH_ISSUED 사이트 발행 · MONTHLY_REGISTER 확정 장부 · PAID_PAYMENT 납부 청구. unit 은 표시용 반올림(적립은 분수 그대로).
   * 금액(tuition·unit)은 금액을 볼 수 없는 역할이면 액션이 null 로 지운다.
   */
  evidence: { kind: "WORKBENCH_ISSUED" | "MONTHLY_REGISTER" | "PAID_PAYMENT"; month: string; tuition: number | null; sessions: number; unit: number | null; warnings: string[] } | null;
  /**
   * 같은 «여러 날 결석»(기간)에서 지금 함께 승인할 수 있는 다른 결석 id — 결석일이 지났고 아직 결정 전인 것.
   * 화면이 «같은 기간 n건 함께 승인»을 보인다. 하루 결석이면 빈 배열.
   */
  periodPeerIds: string[];
  /** 학부모가 사진을 올릴 수 있는 마지막 날(«YYYY-MM-DD») — 검토 중이고 학부모가 알린 결석일 때만. 지나면 보강권으로 자동 전환 */
  evidenceDeadlineYmd: string | null;
};

/** 신청함 상세 칸 — 사유 글·사진 목록·승인 가능 여부. 관리자만 부른다(호출부가 requireAdmin) */
export async function readIllnessCarryDetail(tx: WorkbenchTx, absenceId: string, enabled: boolean, calendar?: WorkbenchCalendarSnapshot): Promise<IllnessCarryDetail | null> {
  const rows = await tx.$queryRawUnsafe<AbsenceRow[]>(ABSENCE_SELECT, absenceId);
  const absence = rows.find((row) => row.id === absenceId) ?? null;
  if (!absence || absence.status === "CANCELLED" || absence.reason !== ILLNESS_REASON) return null;

  const ready = await illnessReviewReady(tx);
  const reviews = ready
    ? await tx.$queryRawUnsafe<Array<{ status: string; source: string; reasonText: string | null; requestedYmd: string }>>(
        `SELECT status, source, "reasonText", to_char("requestedAt" AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS "requestedYmd"
           FROM "RegularAbsenceCarryReview" WHERE "absenceId" = $1`, absenceId)
    : [];
  const photos = ready
    ? await tx.$queryRawUnsafe<Array<{ id: string }>>(
        // 여러 날 결석은 기간에 올린 사진을 함께 보인다(한 묶음)
        `SELECT e.id FROM "RegularAbsenceEvidence" e JOIN "RegularAbsence" ra ON ra.id = $1
          WHERE ${evidenceScopeSql("ra", "e")} AND e."removedAt" IS NULL ORDER BY e."createdAt"`, absenceId)
    : [];
  const credits = await tx.$queryRawUnsafe<Array<{ status: string }>>(
    `SELECT status FROM "MakeupCredit" WHERE "studentId" = $1 AND "sourceKey" = $2 LIMIT 1`,
    absence.studentId, regularAbsenceSourceKey(absence.classId, absence.date),
  );

  // 원래 달 수강료 근거(발행된 청구 또는 확정 장부)가 있는가 — 없으면 기존 이월 규칙이 거절한다. 표가 없으면 «모름»(null)
  const month = absence.date.slice(0, 7);
  const tables = await tx.$queryRawUnsafe<Array<{ draftTable: string | null; registerTable: string | null }>>(
    `SELECT to_regclass('public."BillingWorkbenchDraft"')::text AS "draftTable", to_regclass('public."MonthlyEnrollmentRegister"')::text AS "registerTable"`,
  );
  // 근거 미리보기(2026-11-15): 적립과 «같은 규칙 함수»로 읽기만 한다(발행 초안·확정 장부 → 납부완료 청구 1건).
  // 원장이 승인 전에 «얼마를 몇 회로 나누는지»를 보고, 조건이 안 맞으면 적립 때 나올 사유를 버튼 위에 미리 보인다.
  let bill: CarryBillState = null;
  let evidence: IllnessCarryDetail["evidence"] = null;
  let evidenceProblem: string | null = null;
  if (tables[0]?.draftTable) {
    const preview = await previewCarryEvidence(tx, { absence, originMonth: month, calendar });
    if (preview.ok) {
      bill = "READY";
      evidence = { kind: preview.source, month, tuition: preview.tuition, sessions: preview.sessions, unit: preview.unit, warnings: preview.warnings };
    } else if (preview.noEvidence) {
      // 근거가 없는 실제 이유를 가른다: 청구는 있는데 아직 안 냈나(납부 뒤 승인) · 청구 자체가 없나(발행 뒤 승인)
      const [year, monthNumber] = month.split("-").map(Number);
      const unpaid = await tx.$queryRawUnsafe<Array<{ found: number }>>(
        `SELECT 1 AS found FROM "Payment"
          WHERE "studentId" = $1 AND "classId" = $2 AND year = $3 AND month = $4 AND type = 'MONTHLY' AND status IN ('PENDING','OVERDUE') LIMIT 1`,
        absence.studentId, absence.classId, year, monthNumber,
      );
      bill = unpaid.length > 0 ? "UNPAID" : "NONE";
    } else {
      // 그 밖의 사유(납부 청구 여러 건·휴원 정산에서 처리한 날·일정 불일치 등)는 서버 문구 그대로 보인다
      evidenceProblem = preview.reason;
    }
  }

  // 같은 기간의 다른 결석 중 결석일이 지났고(오늘 포함) 아직 결정 전(이월·보강 정산 없음)인 질병·부상 결석
  const peers = ready
    ? await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT pa.id
           FROM "RegularAbsence" me
           JOIN "RegularAbsence" pa ON pa."periodId" = me."periodId" AND pa.id <> me.id
           LEFT JOIN "RegularAbsenceCarryReview" pr ON pr."absenceId" = pa.id
          WHERE me.id = $1 AND me."periodId" IS NOT NULL
            AND pa.reason = $2 AND pa.status <> 'CANCELLED' AND pa.date <= $3::date
            AND COALESCE(pr.status, 'PENDING') = 'PENDING'
          ORDER BY pa.date`,
        absenceId, ILLNESS_REASON, todayKst())
    : [];
  const anchors = await tx.$queryRawUnsafe<Array<{ anchorYmd: string }>>(
    `SELECT ${evidenceAnchorYmdSql("ra")} AS "anchorYmd" FROM "RegularAbsence" ra WHERE ra.id = $1`, absenceId,
  );
  const review = reviews[0] ?? null;
  const status = review?.status === "APPROVED" || review?.status === "MAKEUP" ? review.status : "PENDING";
  const creditStatus = credits[0]?.status ?? null;
  return {
    absenceId,
    absenceYmd: absence.date,
    status,
    source: review?.source ?? "STAFF",
    reasonText: review?.reasonText ?? null,
    photoIds: photos.map((photo) => photo.id),
    creditStatus,
    blocker: status === "PENDING"
      ? carryApprovalBlocker({ absenceYmd: absence.date, todayYmd: todayKst(), creditStatus, bill, writesEnabled: enabled }) ?? evidenceProblem
      : null,
    evidence: status === "PENDING" ? evidence : null,
    periodPeerIds: status === "PENDING" ? peers.map((peer) => peer.id) : [],
    // 화면이 «○월 ○일까지»로 보여 준다 — 학부모 화면·자동 전환과 같은 함수(여러 날 결석은 기간의 마지막 결석일 기준)
    evidenceDeadlineYmd: review?.status === "PENDING" && review.source !== "STAFF" && review.requestedYmd
      ? evidenceDeadlineYmd(review.requestedYmd, anchors[0]?.anchorYmd ?? absence.date)
      : null,
  };
}
