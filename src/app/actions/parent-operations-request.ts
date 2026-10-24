"use server";

import { createHash, randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth-guard";
import { prisma } from "@/lib/prisma";
import { operationsRequestKey, SYNC_TARGETS } from "@/lib/operationsSync";
import { ensureOperationsSyncInfrastructure } from "@/lib/operationsSyncInfrastructure";
import { initialSyncAttempt, isSheetSyncRetired } from "@/lib/operations-sync/sheetRetirement";
import {
  interpretParentOperationsRequest as interpretRequest,
  validateConfirmedParentOperationsDraft,
  type ConfirmedParentOperationsDraft,
  type ParentClassOption,
  type ParentEnrollmentContext,
} from "@/lib/parentOperationsInterpretation";

export type ParentOperationsLinkPreview = {
  status: "ACTIVE";
  studentName: string;
  expiresAt: string;
} | { status: "USED" | "EXPIRED" | "INVALID" };

export type ActiveParentOperationsLink = {
  id: string;
  studentId: string;
  studentName: string;
  expiresAt: string;
  createdAt: string;
};

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

type ValidParentLink = { id: string; studentId: string; studentName: string; createdByUserId: string };

function validatePublicRequestInput(token: string, sourceText: string, targetMonth: string) {
  const text = sourceText.trim().replace(/\r\n/g, "\n");
  if (!token || token.length > 200) throw new Error("유효하지 않은 요청 링크입니다.");
  if (!text || text.length > 2000) throw new Error("요청 내용은 1~2,000자로 입력해 주세요.");
  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(targetMonth)) throw new Error("적용 월을 확인해 주세요.");
  return text;
}

async function getValidParentLink(token: string): Promise<ValidParentLink> {
  const links = await prisma.$queryRawUnsafe<ValidParentLink[]>(
    `SELECT l.id,l."studentId",s.name AS "studentName",l."createdByUserId" FROM "ParentOperationsRequestLink" l
      JOIN "Student" s ON s.id=l."studentId"
     WHERE l."tokenHash"=$1 AND l.purpose='GENERAL' AND l."revokedAt" IS NULL AND l."expiresAt">now()
     LIMIT 1`, tokenHash(token),
  );
  if (!links[0]) throw new Error("요청 링크가 만료되었거나 취소되었습니다.");
  return links[0];
}

async function getInterpretationContext(studentId: string) {
  const [enrollments, classes] = await Promise.all([
    prisma.$queryRawUnsafe<ParentEnrollmentContext[]>(
      `SELECT e.id AS "enrollmentId",c.id AS "classId",c.name AS "className",e.status,
              c."dayOfWeek",c."startTime",c."endTime",c."slotKey"
         FROM "Enrollment" e JOIN "Class" c ON c.id=e."classId"
        WHERE e."studentId"=$1 AND e.status IN ('ACTIVE','PAUSED') AND c."dayOfWeek"<>'Seasonal'
        ORDER BY c."dayOfWeek",c."startTime"`, studentId,
    ),
    prisma.$queryRawUnsafe<ParentClassOption[]>(
      `SELECT c.id AS "classId",c.name AS "className",p.name AS "programName",
              c."dayOfWeek",c."startTime",c."endTime",c."slotKey"
         FROM "Class" c JOIN "Program" p ON p.id=c."programId"
        WHERE c."dayOfWeek"<>'Seasonal' AND p."deletedAt" IS NULL
          AND c."programId" IN (
            SELECT DISTINCT current_class."programId"
              FROM "Enrollment" current_enrollment
              JOIN "Class" current_class ON current_class.id=current_enrollment."classId"
             WHERE current_enrollment."studentId"=$1 AND current_enrollment.status IN ('ACTIVE','PAUSED')
          )
        ORDER BY c."dayOfWeek",c."startTime",c.name`,
      studentId,
    ),
  ]);
  return { enrollments, classes };
}

export async function createParentOperationsRequestLink(studentId: string, expiresInDays = 7) {
  const admin = await requireAdmin();
  if (!studentId) throw new Error("학생을 선택해 주세요.");
  if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 30) {
    throw new Error("요청 링크 유효기간은 1~30일이어야 합니다.");
  }
  await ensureOperationsSyncInfrastructure();
  const students = await prisma.$queryRawUnsafe<Array<{ id: string; name: string }>>(
    `SELECT id,name FROM "Student" WHERE id=$1 AND "mergedIntoStudentId" IS NULL LIMIT 1`, studentId,
  );
  if (!students[0]) throw new Error("학생을 찾지 못했습니다.");

  const token = randomBytes(32).toString("base64url");
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + expiresInDays * 86_400_000);
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `INSERT INTO "ParentOperationsRequestLink" (id,"studentId","tokenHash",purpose,"expiresAt","createdByUserId") VALUES ($1,$2,$3,'GENERAL',$4,$5)`,
      id, studentId, tokenHash(token), expiresAt, admin.appUserId,
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO "OperationsAuditLog" (id,"linkId",action,"actorType","actorUserId","detailsJson") VALUES ($1,$2,'LINK_CREATED','ADMIN',$3,$4::jsonb)`,
      crypto.randomUUID(), id, admin.appUserId, JSON.stringify({ expiresAt: expiresAt.toISOString() }),
    );
  });
  return { ok: true as const, token, studentName: students[0].name, expiresAt: expiresAt.toISOString() };
}

export async function getActiveParentOperationsRequestLinks(studentId: string): Promise<ActiveParentOperationsLink[]> {
  await requireAdmin();
  await ensureOperationsSyncInfrastructure();
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string; studentId: string; studentName: string; expiresAt: Date; createdAt: Date }>>(
    `SELECT l.id,l."studentId",s.name AS "studentName",l."expiresAt",l."createdAt"
       FROM "ParentOperationsRequestLink" l JOIN "Student" s ON s.id=l."studentId"
      WHERE l."studentId"=$1 AND l.purpose='GENERAL' AND l."revokedAt" IS NULL AND l."expiresAt">now()
      ORDER BY l."createdAt" DESC LIMIT 100`, studentId,
  );
  return rows.map((row) => ({ ...row, expiresAt: row.expiresAt.toISOString(), createdAt: row.createdAt.toISOString() }));
}

export async function getParentOperationsLinkPreview(token: string): Promise<ParentOperationsLinkPreview> {
  if (!token || token.length > 200) return { status: "INVALID" };
  await ensureOperationsSyncInfrastructure();
  const rows = await prisma.$queryRawUnsafe<Array<{ studentName: string; expiresAt: Date; revokedAt: Date | null; lastUsedAt: Date | null }>>(
    `SELECT s.name AS "studentName", l."expiresAt", l."revokedAt", l."lastUsedAt" FROM "ParentOperationsRequestLink" l
      JOIN "Student" s ON s.id=l."studentId"
     WHERE l."tokenHash"=$1 AND l.purpose='GENERAL'
     LIMIT 1`, tokenHash(token),
  );
  const row = rows[0];
  if (!row) return { status: "INVALID" };
  // 제출로 소진된 링크와 관리자가 취소한 링크를 구분해 학부모에게 정확한 상태를 안내한다.
  if (row.revokedAt) return { status: row.lastUsedAt ? "USED" : "INVALID" };
  if (row.expiresAt.getTime() <= Date.now()) return { status: "EXPIRED" };
  return { status: "ACTIVE", studentName: row.studentName, expiresAt: row.expiresAt.toISOString() };
}

/** 자연어는 저장하지 않고 현재 수강·실제 개설반에 맞춘 수정 가능한 초안만 만든다. */
export async function interpretParentOperationsRequest(token: string, sourceText: string, targetMonth: string) {
  const text = validatePublicRequestInput(token, sourceText, targetMonth);
  await ensureOperationsSyncInfrastructure();
  const link = await getValidParentLink(token);
  const context = await getInterpretationContext(link.studentId);
  return {
    studentName: `${link.studentName.slice(0, 1)}○${link.studentName.slice(-1)}`,
    currentEnrollments: context.enrollments.map((item) => ({ id: item.classId, label: `${item.className} · ${item.status === "PAUSED" ? "휴원" : "수강 중"}` })),
    availableClasses: context.classes.map((item) => ({ id: item.classId, label: `${item.className} · ${item.dayOfWeek} ${item.startTime}` })),
    draft: interpretRequest({ sourceText: text, targetMonth, ...context }),
  };
}

export async function submitParentOperationsRequest(token: string, sourceText: string, targetMonth: string, confirmedDraft?: ConfirmedParentOperationsDraft) {
  const text = validatePublicRequestInput(token, sourceText, targetMonth);
  await ensureOperationsSyncInfrastructure();
  const link = await getValidParentLink(token);
  const context = await getInterpretationContext(link.studentId);
  if (!confirmedDraft) throw new Error("해석된 요청 내용을 확인하고 수정한 뒤 보내 주세요.");
  const confirmed = validateConfirmedParentOperationsDraft(confirmedDraft, { sourceText: text, targetMonth, ...context });
  const requestId = crypto.randomUUID();
  const commands = confirmed.commands.map((command) => ({
    ...command,
    studentName: link.studentName,
    idempotencyKey: operationsRequestKey({
      sourceText: command.sourceText,
      studentName: link.studentName,
      kind: command.kind,
      effectiveMonth: command.effectiveDate.slice(0, 7),
      effectiveDate: command.effectiveDate,
      fromClassId: command.fromClassId,
      toClassId: command.toClassId,
      shuttleIntent: command.shuttleIntent,
      details: command.details,
      scope: `PARENT_LINK:${link.id}`,
    }),
  }));

  try {
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.$executeRawUnsafe(
        `UPDATE "ParentOperationsRequestLink" SET "revokedAt"=now(),"lastUsedAt"=now(),"updatedAt"=now()
          WHERE id=$1 AND "revokedAt" IS NULL AND "expiresAt">now()`, link.id,
      );
      if (claimed !== 1) throw new Error("REQUEST_LINK_ALREADY_USED");
      await tx.$executeRawUnsafe(
        `INSERT INTO "OperationsRequest" (id,"sourceText","targetMonth",status,"requestedByUserId","parentRequestLinkId","submittedAt")
         VALUES ($1,$2,$3,'DRAFT',$4,$5,now())`, requestId, text, targetMonth, link.createdByUserId, link.id,
      );
      for (const command of commands) {
        const commandId = crypto.randomUUID();
        const holdReason = command.kind === "UNKNOWN" ? "기타 요청은 원장이 내용을 확인해야 합니다." : null;
        await tx.$executeRawUnsafe(
          `INSERT INTO "OperationsCommand"
            (id,"requestId","idempotencyKey","sourceText","studentId","studentName",kind,"effectiveMonth",confidence,status,"holdReason","afterJson","billingStatus","notificationStatus")
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,'HELD','HELD')`,
          commandId, requestId, command.idempotencyKey, command.sourceText, link.studentId, link.studentName,
          command.kind, command.effectiveDate.slice(0, 7), holdReason ? "LOW" : command.confidence,
          holdReason ? "HELD" : "PENDING", holdReason, JSON.stringify({
            effectiveDate: command.effectiveDate,
            fromClassId: command.fromClassId,
            toClassId: command.toClassId,
            shuttleIntent: command.shuttleIntent,
            details: command.details,
            warnings: command.warnings,
            parentConfirmed: true,
          }),
        );
        for (const target of SYNC_TARGETS) {
          // 시트 은퇴(기본) 상태면 SHEET 칸은 처음부터 SKIPPED — 만들 시트 원장이 없다.
          const initial = initialSyncAttempt(target, isSheetSyncRetired(process.env));
          await tx.$executeRawUnsafe(
            `INSERT INTO "OperationsSyncAttempt" (id,"commandId",target,status,"externalReference") VALUES ($1,$2,$3,$4,$5)`,
            crypto.randomUUID(), commandId, target, initial.status, initial.externalReference,
          );
        }
      }
      await tx.$executeRawUnsafe(
        `INSERT INTO "OperationsAuditLog" (id,"requestId","linkId",action,"actorType","detailsJson") VALUES ($1,$2,$3,'REQUEST_SUBMITTED','PARENT_LINK',$4::jsonb)`,
        crypto.randomUUID(), requestId, link.id, JSON.stringify({ targetMonth, commandCount: commands.length, parentConfirmed: true }),
      );
    });
  } catch (error) {
    if (error instanceof Error && error.message === "REQUEST_LINK_ALREADY_USED") throw new Error("이미 요청을 제출했거나 만료된 링크입니다.");
    if (error instanceof Error && /unique|duplicate/i.test(error.message)) throw new Error("이미 같은 내용으로 접수된 요청입니다.");
    throw error;
  }
  revalidatePath("/admin/operations-sync");
  return { ok: true as const, requestId, status: "DRAFT" as const };
}

export async function revokeParentOperationsRequestLink(linkId: string) {
  const admin = await requireAdmin();
  await ensureOperationsSyncInfrastructure();
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`UPDATE "ParentOperationsRequestLink" SET "revokedAt"=now(),"updatedAt"=now() WHERE id=$1 AND "revokedAt" IS NULL`, linkId);
    await tx.$executeRawUnsafe(
      `INSERT INTO "OperationsAuditLog" (id,"linkId",action,"actorType","actorUserId") VALUES ($1,$2,'LINK_REVOKED','ADMIN',$3)`,
      crypto.randomUUID(), linkId, admin.appUserId,
    );
  });
  return { ok: true as const };
}
