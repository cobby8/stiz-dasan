import type { Prisma } from "@prisma/client";

import { prisma } from "../prisma";
import { SYNC_TARGETS } from "../operationsSync";
import { initialSyncAttempt, isSheetSyncRetired } from "../operations-sync/sheetRetirement";
import { assertOperationsEventPayloadMatch, prepareWebsiteOperationsEvent, type WebsiteOperationsEvent } from "./policy";

export type { WebsiteOperationsEvent } from "./policy";

export type EnqueuedOperationsEvent = {
  created: boolean;
  requestId: string;
  commandId: string;
  idempotencyKey: string;
};

/**
 * 사이트에서 이미 확정된 학생·수강 변경을 3중 동기화 원장에 적재합니다.
 * 홈페이지는 완료로, 시트·랠리즈는 대기로 시작하며 청구와 알림은 별도 승인 전까지 잠급니다.
 */
export async function enqueueWebsiteOperationsEventInTransaction(
  tx: Prisma.TransactionClient,
  input: WebsiteOperationsEvent,
): Promise<EnqueuedOperationsEvent> {
  const { holdReason, idempotencyKey, payloadFingerprint, sourceText, targetMonth } = prepareWebsiteOperationsEvent(input);
  const requestId = crypto.randomUUID();
  const commandId = crypto.randomUUID();

  await tx.$executeRawUnsafe(
    `INSERT INTO "OperationsRequest"
      (id,"sourceText","targetMonth",status,"requestedByUserId","approvedByUserId","approvedAt","submittedAt")
     VALUES ($1,$2,$3,$5,$4,$4,now(),now())`,
    requestId,
    sourceText,
    targetMonth,
    input.actorUserId,
    holdReason ? "HELD" : "APPROVED",
  );

  const inserted = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    `INSERT INTO "OperationsCommand"
      (id,"requestId","idempotencyKey","sourceText","studentId","studentName",kind,"effectiveMonth",confidence,status,
       "holdReason","beforeJson","afterJson","billingStatus","notificationStatus")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,'HELD','HELD')
     ON CONFLICT ("idempotencyKey") DO NOTHING
     RETURNING id`,
    commandId,
    requestId,
    idempotencyKey,
    sourceText,
    input.studentId,
    input.studentName,
    input.kind,
    targetMonth,
    holdReason ? "LOW" : "HIGH",
    holdReason ? "HELD" : "PENDING",
    holdReason,
    JSON.stringify(input.before),
    JSON.stringify({
      ...input.after,
      effectiveDate: input.effectiveDate,
      operationsEvent: {
        source: "WEBSITE",
        eventType: input.eventType,
        eventId: input.eventId,
        payloadFingerprint,
      },
    }),
  );

  if (inserted.length === 0) {
    // 동시 재시도에서 만든 빈 요청은 남기지 않고, 최초 명령을 그대로 반환합니다.
    await tx.$executeRawUnsafe(`DELETE FROM "OperationsRequest" WHERE id=$1`, requestId);
    const [existing] = await tx.$queryRawUnsafe<Array<{ id: string; requestId: string; payloadFingerprint: string | null }>>(
      `SELECT id,"requestId","afterJson" #>> '{operationsEvent,payloadFingerprint}' AS "payloadFingerprint"
         FROM "OperationsCommand" WHERE "idempotencyKey"=$1`,
      idempotencyKey,
    );
    if (!existing) throw new Error("기존 운영 변경 원장을 확인하지 못했습니다.");
    assertOperationsEventPayloadMatch(existing.payloadFingerprint, payloadFingerprint);
    return { created: false, requestId: existing.requestId, commandId: existing.id, idempotencyKey };
  }

  // 시트 은퇴(기본) 상태면 SHEET 칸은 처음부터 SKIPPED — 만들 시트 원장이 없다.
  const sheetRetired = isSheetSyncRetired(process.env);
  for (const target of SYNC_TARGETS) {
    const websiteDone = target === "WEBSITE";
    const initial = initialSyncAttempt(target, sheetRetired);
    await tx.$executeRawUnsafe(
      `INSERT INTO "OperationsSyncAttempt"
        (id,"commandId",target,status,attempts,"verifiedAt","externalReference")
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      crypto.randomUUID(),
      commandId,
      target,
      websiteDone ? "SUCCEEDED" : initial.status,
      websiteDone ? 1 : 0,
      websiteDone ? new Date() : null,
      websiteDone ? null : initial.externalReference,
    );
  }

  await tx.$executeRawUnsafe(
    `INSERT INTO "OperationsAuditLog"
      (id,"requestId",action,"actorType","actorUserId","detailsJson")
     VALUES ($1,$2,'WEBSITE_EVENT_ENQUEUED','ADMIN',$3,$4::jsonb)`,
    crypto.randomUUID(),
    requestId,
    input.actorUserId,
    JSON.stringify({ eventType: input.eventType, eventId: input.eventId, commandId, targetMonth, held: Boolean(holdReason) }),
  );

  return { created: true, requestId, commandId, idempotencyKey };
}

export async function enqueueWebsiteOperationsEvent(input: WebsiteOperationsEvent) {
  return prisma.$transaction((tx) => enqueueWebsiteOperationsEventInTransaction(tx, input));
}
