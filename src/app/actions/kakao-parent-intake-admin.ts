"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth-guard";
import { prisma } from "@/lib/prisma";
import { operationsRequestKey, SYNC_TARGETS, type OperationsKind } from "@/lib/operationsSync";
import { ensureOperationsSyncInfrastructure } from "@/lib/operationsSyncInfrastructure";
import { initialSyncAttempt, isSheetSyncRetired } from "@/lib/operations-sync/sheetRetirement";

export type KakaoIntakeDecision = "TRANSFER" | "NEEDS_DETAILS" | "REJECT" | "CONSULTATION" | "CLOSE_CONSULTATION";

export type KakaoIntakeReviewDetails = {
  effectiveDate?: string;
  fromClassId?: string | null;
  toClassId?: string | null;
  shuttleIntent?: "START" | "STOP" | "CHANGE" | "EXEMPT" | null;
  details?: string;
};

const REVIEWABLE_STATUSES = ["SUBMITTED", "HELD", "FAILED", "NEEDS_DETAILS", "CONSULTATION"] as const;

const OPERATIONS_KIND: Record<string, OperationsKind | null> = {
  PAUSE: "PAUSE",
  WITHDRAW: "WITHDRAW",
  RESUME: "RESUME",
  CLASS_CHANGE: "CLASS_CHANGE",
  CLASS_ADD: "CLASS_ADD",
  SHUTTLE_CHANGE: "SHUTTLE_CHANGE",
  SHUTTLE_FEE: "SHUTTLE_EXEMPT",
  CONTACT_CHANGE: "CONTACT_UPDATE",
  BILLING_CORRECTION: "BILLING_CORRECTION",
};

type IntakeForReview = {
  id: string;
  revision: string;
  kind: string;
  sourceText: string;
  status: string;
  studentId: string | null;
  studentName: string | null;
  parentUserId: string | null;
  studentParentId: string | null;
  identityStatus: string;
  structuredJson: Record<string, unknown> | null;
  targetMonth: string;
  operationsRequestId: string | null;
};

type VerifiedReview = {
  operationsKind: OperationsKind;
  effectiveDate: string;
  targetMonth: string;
  fromClassId: string | null;
  toClassId: string | null;
  shuttleIntent: "START" | "STOP" | "CHANGE" | "EXEMPT" | null;
  details: string;
  parentConfirmed: boolean;
  beforeJson: Record<string, unknown>;
};

function isRealDate(value: string) {
  const match = /^(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.exec(value);
  if (!match) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function textField(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

async function verifyReviewDetails(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  intake: IntakeForReview,
  review: KakaoIntakeReviewDetails | undefined,
): Promise<VerifiedReview> {
  if (intake.studentParentId !== intake.parentUserId) throw new Error("인증 보호자와 학생 연결이 일치하지 않습니다.");

  const saved = intake.structuredJson ?? {};
  const effectiveDate = textField(review?.effectiveDate ?? saved.effectiveDate, 10);
  if (!isRealDate(effectiveDate)) throw new Error("적용일을 정확히 선택해 주세요.");
  const targetMonth = effectiveDate.slice(0, 7);
  const fromClassId = textField(review?.fromClassId ?? saved.fromClassId, 100) || null;
  const toClassId = textField(review?.toClassId ?? saved.toClassId, 100) || null;
  const explicitDetails = textField(review?.details ?? saved.details, 2000);
  const details = explicitDetails || intake.sourceText.slice(0, 2000);
  const requestedIntent = review?.shuttleIntent ?? saved.shuttleIntent ?? null;
  const shuttleIntent = ["START", "STOP", "CHANGE", "EXEMPT"].includes(String(requestedIntent))
    ? requestedIntent as VerifiedReview["shuttleIntent"] : null;

  let operationsKind = OPERATIONS_KIND[intake.kind] ?? null;
  if (intake.kind === "SHUTTLE_START_STOP") {
    operationsKind = shuttleIntent === "START" ? "SHUTTLE_START" : shuttleIntent === "STOP" ? "SHUTTLE_STOP" : null;
    if (!operationsKind) throw new Error("정규 셔틀 이용 시작 또는 중단을 선택해 주세요.");
  }
  if (!operationsKind) throw new Error("이 요청은 전용 화면 처리 또는 상담 전환이 필요합니다.");

  const expectedIntent = operationsKind === "SHUTTLE_START" ? "START" : operationsKind === "SHUTTLE_STOP" ? "STOP"
    : operationsKind === "SHUTTLE_CHANGE" ? "CHANGE" : operationsKind === "SHUTTLE_EXEMPT" ? "EXEMPT" : null;
  if (expectedIntent !== shuttleIntent) throw new Error("요청 종류와 셔틀 변경 항목이 일치하지 않습니다.");

  const requiresFrom = ["PAUSE", "WITHDRAW", "RESUME", "CLASS_CHANGE"].includes(operationsKind);
  const requiresTo = ["CLASS_CHANGE", "CLASS_ADD"].includes(operationsKind);
  if (requiresFrom && !fromClassId) throw new Error("요청을 적용할 현재 수업을 선택해 주세요.");
  if (requiresTo && !toClassId) throw new Error("희망 수업을 선택해 주세요.");
  if (fromClassId && toClassId && fromClassId === toClassId) throw new Error("현재 수업과 다른 희망 수업을 선택해 주세요.");

  let enrollment: Record<string, unknown> | null = null;
  if (fromClassId) {
    const enrollmentRows = await tx.$queryRawUnsafe<Array<{ id: string; status: string; classId: string; className: string }>>(
      `SELECT e.id,e.status,e."classId",c.name AS "className"
         FROM "Enrollment" e JOIN "Class" c ON c.id=e."classId"
        WHERE e."studentId"=$1 AND e."classId"=$2 AND e.status IN ('ACTIVE','PAUSED')`,
      intake.studentId, fromClassId,
    );
    if (enrollmentRows.length !== 1) throw new Error("선택한 현재 수업이 학생의 실제 수강 정보와 일치하지 않습니다.");
    const allowedStatus = operationsKind === "RESUME" ? "PAUSED" : "ACTIVE";
    if (enrollmentRows[0].status !== allowedStatus) {
      throw new Error(operationsKind === "RESUME" ? "휴원 중인 수업만 복귀할 수 있습니다." : "현재 수강 중인 수업만 변경할 수 있습니다.");
    }
    enrollment = enrollmentRows[0];
  }

  if (toClassId) {
    const targetRows = await tx.$queryRawUnsafe<Array<{ id: string; name: string; dayOfWeek: string; startTime: string; capacity: number; activeCount: number }>>(
      `SELECT c.id,c.name,c."dayOfWeek",c."startTime",c.capacity,
              (SELECT count(*)::int FROM "Enrollment" e WHERE e."classId"=c.id AND e.status='ACTIVE') AS "activeCount"
         FROM "Class" c JOIN "Program" p ON p.id=c."programId"
        WHERE c.id=$1 AND c."dayOfWeek"<>'Seasonal' AND p."deletedAt" IS NULL`,
      toClassId,
    );
    if (targetRows.length !== 1) throw new Error("선택한 희망 수업이 현재 개설된 정규반이 아닙니다.");
    if (targetRows[0].activeCount >= targetRows[0].capacity) throw new Error("희망 수업의 정원이 가득 찼습니다. 다른 반을 선택하거나 보류해 주세요.");
    const duplicate = await tx.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM "Enrollment" WHERE "studentId"=$1 AND "classId"=$2 AND status IN ('ACTIVE','PAUSED') LIMIT 1`,
      intake.studentId, toClassId,
    );
    if (duplicate.length) throw new Error("이미 수강 중이거나 휴원 중인 반은 희망 수업으로 선택할 수 없습니다.");
  }

  if (["SHUTTLE_START", "SHUTTLE_STOP", "SHUTTLE_CHANGE", "SHUTTLE_EXEMPT", "CONTACT_UPDATE", "BILLING_CORRECTION"].includes(operationsKind) && !explicitDetails) {
    throw new Error("변경할 상세 내용을 입력해 주세요.");
  }
  const savedEffectiveDate = textField(saved.effectiveDate, 10);
  const savedFromClassId = textField(saved.fromClassId, 100) || null;
  const savedToClassId = textField(saved.toClassId, 100) || null;
  const savedDetails = textField(saved.details, 2000);
  const savedIntent = ["START", "STOP", "CHANGE", "EXEMPT"].includes(String(saved.shuttleIntent))
    ? saved.shuttleIntent as VerifiedReview["shuttleIntent"] : null;
  const parentConfirmed = effectiveDate === savedEffectiveDate
    && fromClassId === savedFromClassId
    && toClassId === savedToClassId
    && shuttleIntent === savedIntent
    && explicitDetails === savedDetails;
  return { operationsKind, effectiveDate, targetMonth, fromClassId, toClassId, shuttleIntent, details, parentConfirmed, beforeJson: enrollment ? { enrollment } : {} };
}

function cleanNote(value: string | undefined) {
  const note = (value ?? "").trim();
  if (note.length > 500) throw new Error("검토 메모는 500자 이하로 입력해 주세요.");
  return note;
}

function nonTransferStatus(decision: Exclude<KakaoIntakeDecision, "TRANSFER">) {
  if (decision === "CLOSE_CONSULTATION") return "CONSULTATION_CLOSED";
  if (decision === "NEEDS_DETAILS") return "NEEDS_DETAILS";
  if (decision === "REJECT") return "REJECTED";
  return "CONSULTATION";
}

export async function decideKakaoParentIntake(input: {
  intakeId: string;
  expectedRevision: string;
  decision: KakaoIntakeDecision;
  note?: string;
  review?: KakaoIntakeReviewDetails;
}) {
  const admin = await requireAdmin();
  if (!["TRANSFER", "NEEDS_DETAILS", "REJECT", "CONSULTATION", "CLOSE_CONSULTATION"].includes(input.decision)) {
    return { ok: false as const, message: "지원하지 않는 처리입니다. 새로고침해 주세요." };
  }
  const note = cleanNote(input.note);
  if (!input.intakeId) return { ok: false as const, message: "요청을 찾지 못했습니다." };
  if (input.decision !== "TRANSFER" && !note) {
    return { ok: false as const, message: "추가 확인·반려·상담 처리 사유를 입력해 주세요." };
  }

  await ensureOperationsSyncInfrastructure();
  const rows = await prisma.$queryRawUnsafe<IntakeForReview[]>(
    `SELECT r.id,r."updatedAt"::text AS revision,r.kind,r."sourceText",r.status,r."studentId",r."structuredJson",
            r."operationsRequestId",i."parentUserId",i.status AS "identityStatus",
            s.name AS "studentName",s."parentId" AS "studentParentId",
            to_char(r."createdAt" AT TIME ZONE 'Asia/Seoul','YYYY-MM') AS "targetMonth"
       FROM "KakaoParentIntake" r
       JOIN "KakaoParentIdentity" i ON i.id=r."identityId"
       LEFT JOIN "Student" s ON s.id=r."studentId" AND s."mergedIntoStudentId" IS NULL
      WHERE r.id=$1 LIMIT 1`,
    input.intakeId,
  );
  const intake = rows[0];
  if (!intake) return { ok: false as const, message: "요청을 찾지 못했습니다." };
  // 날짜를 JS Date로 바꾸면 DB의 마이크로초가 잘린다. 목록에서 받은 원문 버전을 비교한다.
  if (!input.expectedRevision || input.expectedRevision !== intake.revision) {
    return { ok: false as const, message: "다른 관리자가 내용을 변경했습니다. 새로고침 후 다시 확인해 주세요." };
  }
  if (!REVIEWABLE_STATUSES.includes(intake.status as (typeof REVIEWABLE_STATUSES)[number])) {
    return { ok: false as const, message: "이미 처리됐거나 다른 관리자가 검토 중인 요청입니다." };
  }

  if (intake.operationsRequestId) {
    return { ok: false as const, message: "이미 운영 원장에 연결된 요청입니다. 실제 처리 이력을 확인해 주세요." };
  }
  if (input.decision === "CLOSE_CONSULTATION" && intake.status !== "CONSULTATION") {
    return { ok: false as const, message: "상담 전환된 요청만 상담 종결할 수 있습니다." };
  }

  if (input.decision !== "TRANSFER") {
    const nextStatus = nonTransferStatus(input.decision);
    const changed = await prisma.$transaction(async (tx) => {
      const claimed = await tx.$executeRawUnsafe(
        `UPDATE "KakaoParentIntake"
            SET status=$2,"decidedByUserId"=$3,"decidedAt"=now(),"decisionNote"=$4,
                "updatedAt"=GREATEST(clock_timestamp(),"updatedAt"+interval '1 microsecond')
          WHERE id=$1 AND status=$5 AND "updatedAt"=$6::timestamptz AND "operationsRequestId" IS NULL`,
        intake.id, nextStatus, admin.appUserId, note, intake.status, input.expectedRevision,
      );
      if (claimed !== 1) return false;
      await tx.$executeRawUnsafe(
        `INSERT INTO "KakaoParentIntakeAudit"
          (id,"intakeId",action,"actorUserId","fromStatus","toStatus",note,"detailsJson")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
        crypto.randomUUID(), intake.id, input.decision, admin.appUserId, intake.status, nextStatus, note,
        JSON.stringify({ externalMessageSent: false, operationsCreated: false, enrollmentApplied: false, billingApplied: false }),
      );
      return true;
    });
    if (!changed) return { ok: false as const, message: "다른 관리자가 먼저 처리했습니다. 새로고침해 주세요." };
    revalidatePath("/admin/kakao-requests");
    return { ok: true as const, status: nextStatus };
  }

  if (intake.identityStatus !== "ACTIVE" || !intake.parentUserId) {
    return { ok: false as const, message: "최초 인증이 완료된 보호자 요청만 운영 원장으로 이관할 수 있습니다." };
  }
  if (!intake.studentId || !intake.studentName) {
    return { ok: false as const, message: "학생 안정 ID를 확인한 뒤 이관해 주세요." };
  }
  const structuredStudentId = typeof intake.structuredJson?.studentId === "string" ? intake.structuredJson.studentId : "";
  if (structuredStudentId !== intake.studentId) {
    return { ok: false as const, message: "대화에서 선택한 학생과 저장된 학생 ID가 일치하지 않습니다." };
  }
  const requestId = crypto.randomUUID();
  const commandId = crypto.randomUUID();

  const created = await prisma.$transaction(async (tx) => {
    const claimed = await tx.$executeRawUnsafe(
      `UPDATE "KakaoParentIntake"
          SET status='PROCESSING',"updatedAt"=GREATEST(clock_timestamp(),"updatedAt"+interval '1 microsecond')
        WHERE id=$1 AND status=$2 AND "updatedAt"=$3::timestamptz AND "operationsRequestId" IS NULL`,
      intake.id, intake.status, input.expectedRevision,
    );
    if (claimed !== 1) return false;
    const verified = await verifyReviewDetails(tx, intake, input.review);
    const idempotencyKey = operationsRequestKey({
      sourceText: intake.sourceText,
      studentName: intake.studentName!,
      kind: verified.operationsKind,
      effectiveMonth: verified.targetMonth,
      effectiveDate: verified.effectiveDate,
      fromClassId: verified.fromClassId,
      toClassId: verified.toClassId,
      shuttleIntent: verified.shuttleIntent,
      details: verified.details,
      scope: `KAKAO_INTAKE:${intake.id}`,
    });
    await tx.$executeRawUnsafe(
      `INSERT INTO "OperationsRequest" (id,"sourceText","targetMonth",status,"requestedByUserId","submittedAt")
       VALUES ($1,$2,$3,'DRAFT',$4,now())`,
      requestId, intake.sourceText, verified.targetMonth, admin.appUserId,
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO "OperationsCommand"
        (id,"requestId","idempotencyKey","sourceText","studentId","studentName",kind,"effectiveMonth",confidence,status,"holdReason","afterJson","billingStatus","notificationStatus")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'HIGH','PENDING',NULL,$9::jsonb,'HELD','HELD')`,
      commandId, requestId, idempotencyKey, intake.sourceText, intake.studentId, intake.studentName,
      verified.operationsKind, verified.targetMonth,
      JSON.stringify({
        source: "KAKAO", intakeId: intake.id, parentConfirmed: verified.parentConfirmed,
        adminReviewed: true, parentReconfirmationRequired: !verified.parentConfirmed,
        effectiveDate: verified.effectiveDate, fromClassId: verified.fromClassId, toClassId: verified.toClassId,
        shuttleIntent: verified.shuttleIntent, details: verified.details,
      }),
    );
    if (Object.keys(verified.beforeJson).length) {
      await tx.$executeRawUnsafe(`UPDATE "OperationsCommand" SET "beforeJson"=$2::jsonb WHERE id=$1`, commandId, JSON.stringify(verified.beforeJson));
    }
    // 시트 은퇴(기본) 상태면 SHEET 칸은 처음부터 SKIPPED — 만들 시트 원장이 없다.
    const sheetRetired = isSheetSyncRetired(process.env);
    for (const target of SYNC_TARGETS) {
      const initial = initialSyncAttempt(target, sheetRetired);
      await tx.$executeRawUnsafe(
        `INSERT INTO "OperationsSyncAttempt" (id,"commandId",target,status,"externalReference") VALUES ($1,$2,$3,$4,$5)`,
        crypto.randomUUID(), commandId, target, initial.status, initial.externalReference,
      );
    }
    await tx.$executeRawUnsafe(
      `UPDATE "KakaoParentIntake"
          SET status='APPROVED',"decidedByUserId"=$2,"decidedAt"=now(),"decisionNote"=$3,
              "operationsRequestId"=$4,"updatedAt"=GREATEST(clock_timestamp(),"updatedAt"+interval '1 microsecond')
        WHERE id=$1 AND status='PROCESSING'`,
      intake.id, admin.appUserId, note || null, requestId,
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO "KakaoParentIntakeAudit"
        (id,"intakeId",action,"actorUserId","fromStatus","toStatus",note,"detailsJson")
       VALUES ($1,$2,'TRANSFER',$3,$4,'APPROVED',$5,$6::jsonb)`,
      crypto.randomUUID(), intake.id, admin.appUserId, intake.status, note || null,
      JSON.stringify({ operationsRequestId: requestId, commandStatus: "PENDING", billingStatus: "HELD", notificationStatus: "HELD", externalWrites: false, notificationsSent: false }),
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO "OperationsAuditLog" (id,"requestId",action,"actorType","actorUserId","detailsJson")
       VALUES ($1,$2,'KAKAO_INTAKE_TRANSFERRED','ADMIN',$3,$4::jsonb)`,
      crypto.randomUUID(), requestId, admin.appUserId,
      JSON.stringify({ intakeId: intake.id, commandStatus: "PENDING", billingStatus: "HELD", notificationStatus: "HELD", externalWrites: false, notificationsSent: false }),
    );
    return true;
  });
  if (!created) return { ok: false as const, message: "다른 관리자가 먼저 처리했습니다. 새로고침해 주세요." };

  revalidatePath("/admin/kakao-requests");
  revalidatePath("/admin/operations-sync");
  return { ok: true as const, status: "APPROVED", operationsRequestId: requestId };
}
