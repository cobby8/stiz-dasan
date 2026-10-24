"use server";

import { prisma } from "@/lib/prisma";
import {
  buildKakaoReconfirmationPayload,
  formatKakaoReconfirmationClassLabel,
  kakaoReconfirmationPayloadHash,
  kakaoReconfirmationTokenHash,
  type KakaoReconfirmationClassSnapshot,
} from "@/lib/kakao-parent-reconfirmation";

export type KakaoParentReconfirmationPreview = {
  status: "ACTIVE";
  studentName: string;
  kind: string;
  effectiveDate: string;
  fromClassLabel: string | null;
  toClassLabel: string | null;
  shuttleIntent: string | null;
  details: string;
  expiresAt: string;
} | { status: "INVALID" | "EXPIRED" | "USED" | "NOT_REQUIRED" };

type ReconfirmationRow = {
  linkId: string;
  studentId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  requestId: string;
  requestStatus: string;
  commandId: string;
  commandStatus: string;
  commandStudentId: string | null;
  kind: string;
  afterJson: Record<string, unknown> | null;
  intakeId: string;
  intakeStatus: string;
  intakeStudentId: string | null;
  identityStatus: string;
  parentUserId: string | null;
  studentParentId: string;
  studentName: string;
  fromClassId: string | null;
  fromProgramName: string | null;
  fromClassName: string | null;
  fromDayOfWeek: string | null;
  fromStartTime: string | null;
  fromEndTime: string | null;
  toClassId: string | null;
  toProgramName: string | null;
  toClassName: string | null;
  toDayOfWeek: string | null;
  toStartTime: string | null;
  toEndTime: string | null;
  payloadHash: string;
};

function validToken(token: string) {
  return Boolean(token) && token.length <= 200;
}

const relationSql = `
  SELECT l.id AS "linkId",l."studentId",l."expiresAt",l."revokedAt",l."lastUsedAt",
         r.id AS "requestId",r.status AS "requestStatus",
         c.id AS "commandId",c.status AS "commandStatus",c."studentId" AS "commandStudentId",c.kind,c."afterJson",
         i.id AS "intakeId",i.status AS "intakeStatus",i."studentId" AS "intakeStudentId",
         k.status AS "identityStatus",k."parentUserId",s."parentId" AS "studentParentId",s.name AS "studentName",
         fc.id AS "fromClassId",fp.name AS "fromProgramName",fc.name AS "fromClassName",fc."dayOfWeek" AS "fromDayOfWeek",fc."startTime" AS "fromStartTime",fc."endTime" AS "fromEndTime",
         tc.id AS "toClassId",tp.name AS "toProgramName",tc.name AS "toClassName",tc."dayOfWeek" AS "toDayOfWeek",tc."startTime" AS "toStartTime",tc."endTime" AS "toEndTime",
         a."detailsJson"->>'payloadHash' AS "payloadHash"
    FROM "ParentOperationsRequestLink" l
    JOIN "OperationsAuditLog" a ON a."linkId"=l.id AND a.action='KAKAO_RECONFIRMATION_LINK_ISSUED'
    JOIN "OperationsRequest" r ON r.id=a."requestId"
    JOIN "OperationsCommand" c ON c.id=a."detailsJson"->>'commandId' AND c."requestId"=r.id
    JOIN "KakaoParentIntake" i ON i.id=a."detailsJson"->>'intakeId' AND i."operationsRequestId"=r.id
    JOIN "KakaoParentIdentity" k ON k.id=i."identityId"
    JOIN "Student" s ON s.id=l."studentId" AND s."mergedIntoStudentId" IS NULL
    LEFT JOIN "Class" fc ON fc.id=c."afterJson"->>'fromClassId'
    LEFT JOIN "Program" fp ON fp.id=fc."programId"
    LEFT JOIN "Class" tc ON tc.id=c."afterJson"->>'toClassId'
    LEFT JOIN "Program" tp ON tp.id=tc."programId"
   WHERE l."tokenHash"=$1 AND l.purpose='KAKAO_RECONFIRMATION'
   ORDER BY a."createdAt" DESC LIMIT 1`;

function validateRelation(row: ReconfirmationRow) {
  if (row.identityStatus !== "ACTIVE" || !row.parentUserId || row.parentUserId !== row.studentParentId) return null;
  if (!row.commandStudentId || row.studentId !== row.commandStudentId || row.intakeStudentId !== row.commandStudentId) return null;
  if (row.intakeStatus !== "APPROVED" || !["DRAFT", "HELD"].includes(row.requestStatus) || !["PENDING", "HELD"].includes(row.commandStatus)) return null;
  const payload = buildKakaoReconfirmationPayload({
    intakeId: row.intakeId, requestId: row.requestId, commandId: row.commandId,
    studentId: row.commandStudentId, kind: row.kind, afterJson: row.afterJson,
    fromClass: classSnapshot(row, "from"), toClass: classSnapshot(row, "to"),
  });
  if (!payload || kakaoReconfirmationPayloadHash(payload) !== row.payloadHash) return null;
  return payload;
}

function classSnapshot(row: ReconfirmationRow, side: "from" | "to"): KakaoReconfirmationClassSnapshot | null {
  const id = side === "from" ? row.fromClassId : row.toClassId;
  const programName = side === "from" ? row.fromProgramName : row.toProgramName;
  const className = side === "from" ? row.fromClassName : row.toClassName;
  const dayOfWeek = side === "from" ? row.fromDayOfWeek : row.toDayOfWeek;
  const startTime = side === "from" ? row.fromStartTime : row.toStartTime;
  const endTime = side === "from" ? row.fromEndTime : row.toEndTime;
  return id && programName && className && dayOfWeek && startTime && endTime
    ? { id, programName, className, dayOfWeek, startTime, endTime } : null;
}

export async function getKakaoParentReconfirmationPreview(token: string): Promise<KakaoParentReconfirmationPreview> {
  if (!validToken(token)) return { status: "INVALID" };
  const rows = await prisma.$queryRawUnsafe<ReconfirmationRow[]>(relationSql, kakaoReconfirmationTokenHash(token));
  const row = rows[0];
  if (!row) return { status: "INVALID" };
  if (row.revokedAt) return { status: row.lastUsedAt ? "USED" : "INVALID" };
  if (row.expiresAt.getTime() <= Date.now()) return { status: "EXPIRED" };
  const payload = validateRelation(row);
  if (!payload) return { status: "INVALID" };
  if (row.afterJson?.parentConfirmed === true || row.afterJson?.parentReconfirmationRequired !== true) return { status: "NOT_REQUIRED" };
  return {
    status: "ACTIVE", studentName: row.studentName, kind: row.kind,
    effectiveDate: payload.effectiveDate,
    fromClassLabel: formatKakaoReconfirmationClassLabel(payload.fromClass),
    toClassLabel: formatKakaoReconfirmationClassLabel(payload.toClass),
    shuttleIntent: payload.shuttleIntent, details: payload.details, expiresAt: row.expiresAt.toISOString(),
  };
}

export async function confirmKakaoParentReconfirmation(token: string) {
  if (!validToken(token)) return { ok: false as const, message: "유효하지 않은 재확인 링크입니다." };
  const hash = kakaoReconfirmationTokenHash(token);
  try {
    const result = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe<ReconfirmationRow[]>(`${relationSql.replace(" LIMIT 1", "")} FOR UPDATE OF l,r,c,i,k`, hash);
      const row = rows[0];
      if (!row) return { ok: false as const, message: "유효하지 않은 재확인 링크입니다." };
      if (row.lastUsedAt && row.afterJson?.parentConfirmed === true) return { ok: true as const, status: "CONFIRMED" as const };
      if (row.revokedAt || row.expiresAt.getTime() <= Date.now()) return { ok: false as const, message: "재확인 링크가 만료되었거나 취소되었습니다." };
      const payload = validateRelation(row);
      if (!payload) return { ok: false as const, message: "요청 내용이 변경되어 다시 확인해야 합니다." };
      if (row.afterJson?.parentConfirmed === true || row.afterJson?.parentReconfirmationRequired !== true) {
        return { ok: true as const, status: "CONFIRMED" as const };
      }
      const payloadHash = kakaoReconfirmationPayloadHash(payload);
      const updated = await tx.$executeRawUnsafe(
        `UPDATE "OperationsCommand"
            SET "afterJson"="afterJson" || '{"parentConfirmed":true,"parentReconfirmationRequired":false}'::jsonb,"updatedAt"=now()
          WHERE id=$1 AND "requestId"=$2 AND status IN ('PENDING','HELD')
            AND "afterJson"->>'parentReconfirmationRequired'='true'
            AND COALESCE("afterJson"->>'parentConfirmed','false')<>'true'`,
        row.commandId, row.requestId,
      );
      if (updated !== 1) return { ok: false as const, message: "이미 처리됐거나 요청 상태가 변경되었습니다." };
      await tx.$executeRawUnsafe(
        `UPDATE "ParentOperationsRequestLink" SET "revokedAt"=now(),"lastUsedAt"=now(),"updatedAt"=now()
          WHERE id=$1 AND "revokedAt" IS NULL AND "expiresAt">now()`, row.linkId,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "OperationsAuditLog" (id,"requestId","linkId",action,"actorType","detailsJson")
         VALUES ($1,$2,$3,'KAKAO_PARENT_RECONFIRMED','PARENT_LINK',$4::jsonb)`,
        crypto.randomUUID(), row.requestId, row.linkId,
        JSON.stringify({ intakeId: row.intakeId, commandId: row.commandId, payloadHash, externalWrites: false, notificationsSent: false }),
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "KakaoParentIntakeAudit" (id,"intakeId",action,"actorUserId","fromStatus","toStatus","detailsJson")
         VALUES ($1,$2,'PARENT_RECONFIRMED',$3,$4,$4,$5::jsonb)`,
        crypto.randomUUID(), row.intakeId, row.parentUserId, row.intakeStatus,
        JSON.stringify({ requestId: row.requestId, commandId: row.commandId, payloadHash, externalWrites: false, notificationsSent: false }),
      );
      return { ok: true as const, status: "CONFIRMED" as const };
    });
    return result;
  } catch (error) {
    console.error("[kakao-parent-reconfirmation] confirm failed", error);
    return { ok: false as const, message: "재확인 처리 중 오류가 발생했습니다. 학원으로 문의해 주세요." };
  }
}
