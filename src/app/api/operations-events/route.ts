import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { SYNC_TARGETS } from "@/lib/operationsSync";
import { initialSyncAttempt, isSheetSyncRetired } from "@/lib/operations-sync/sheetRetirement";
import {
  assertOperationsEventPayloadMatch,
  normalizeOperationsEventPayload,
  operationsEventIdempotencyKey,
  operationsEventPayloadFingerprint,
  operationsEventPayloadHoldReason,
} from "@/lib/operations-events/policy";
import { ensureOperationsSyncInfrastructure } from "@/lib/operationsSyncInfrastructure";
import { verifyOperationsEventSignature } from "./event-contract";

export const dynamic = "force-dynamic";
const MAX_BODY_BYTES = 64 * 1024;

type ExistingCommand = { id: string; requestId: string; status: string; payloadFingerprint: string | null };

const existingCommandSql = `SELECT id,"requestId",status,
  "afterJson"->'operationsEvent'->>'payloadFingerprint' AS "payloadFingerprint"
  FROM "OperationsCommand" WHERE "idempotencyKey"=$1 LIMIT 1`;

function payloadMatches(storedFingerprint: string | null, incomingFingerprint: string) {
  try {
    assertOperationsEventPayloadMatch(storedFingerprint, incomingFingerprint);
    return true;
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  const secret = process.env.STIZ_OPERATIONS_EVENT_SECRET;
  const requestedByUserId = process.env.STIZ_OPERATIONS_EVENT_USER_ID;
  if (!secret || secret.length < 32 || !requestedByUserId) {
    console.error("[operations-events] 수신 비밀키 또는 운영 사용자 ID가 설정되지 않았습니다.");
    return NextResponse.json({ error: "실시간 접수가 설정되지 않았습니다." }, { status: 503 });
  }

  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_BODY_BYTES) return NextResponse.json({ error: "요청 본문이 너무 큽니다." }, { status: 413 });
  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "요청 본문이 너무 큽니다." }, { status: 413 });
  }

  const signatureValid = verifyOperationsEventSignature({
    rawBody,
    timestamp: request.headers.get("x-stiz-event-timestamp"),
    signature: request.headers.get("x-stiz-event-signature"),
    secret,
  });
  if (!signatureValid) return NextResponse.json({ error: "서명이 올바르지 않거나 만료되었습니다." }, { status: 401 });

  let event;
  try {
    event = normalizeOperationsEventPayload(JSON.parse(rawBody));
  } catch {
    return NextResponse.json({ error: "실시간 변경 형식이 올바르지 않습니다." }, { status: 400 });
  }

  await ensureOperationsSyncInfrastructure();
  const operator = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT id FROM "User" WHERE id=$1 LIMIT 1`, requestedByUserId,
  );
  if (!operator[0]) {
    console.error("[operations-events] STIZ_OPERATIONS_EVENT_USER_ID에 해당하는 사용자가 없습니다.");
    return NextResponse.json({ error: "실시간 접수 운영 계정이 올바르지 않습니다." }, { status: 503 });
  }

  const idempotencyKey = operationsEventIdempotencyKey(event.source, event.eventId);
  const payloadFingerprint = operationsEventPayloadFingerprint(event);
  const existing = await prisma.$queryRawUnsafe<ExistingCommand[]>(
    existingCommandSql, idempotencyKey,
  );
  if (existing[0]) {
    if (!payloadMatches(existing[0].payloadFingerprint, payloadFingerprint)) {
      // 같은 외부 ID의 내용이 달라지면 어느 쪽도 정본으로 추측하지 않고 운영 감사에 남긴다.
      await prisma.$executeRawUnsafe(
        `INSERT INTO "OperationsAuditLog" (id,"requestId",action,"actorType","detailsJson")
         VALUES ($1,$2,'OPERATIONS_EVENT_CONFLICT','SYSTEM',$3::jsonb)`,
        crypto.randomUUID(), existing[0].requestId,
        JSON.stringify({ eventId: event.eventId, source: event.source, reason: "PAYLOAD_FINGERPRINT_MISMATCH" }),
      );
      return NextResponse.json({ error: "같은 이벤트 ID에 서로 다른 변경 내용이 접수되었습니다." }, { status: 409 });
    }
    return NextResponse.json({ ok: true, duplicate: true, ...existing[0] }, { status: 200 });
  }

  const matchedStudents = event.change.studentId
    ? await prisma.$queryRawUnsafe<Array<{ id: string; name: string }>>(
        `SELECT id,name FROM "Student" WHERE id=$1 AND "mergedIntoStudentId" IS NULL LIMIT 1`, event.change.studentId,
      )
    : [];
  const resolvedStudent = matchedStudents[0];
  const identityHoldReason = event.change.studentId && !resolvedStudent
    ? "전달된 학생 식별값을 운영 사이트에서 찾지 못했습니다."
    : null;
  const holdReason = [operationsEventPayloadHoldReason(event), identityHoldReason].filter(Boolean).join(" ") || null;
  const requestId = crypto.randomUUID();
  const commandId = crypto.randomUUID();
  const sourceText = `${event.source} 실시간 변경 ${event.eventId}`;

  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `INSERT INTO "OperationsRequest" (id,"sourceText","targetMonth",status,"requestedByUserId","submittedAt")
       VALUES ($1,$2,$3,'DRAFT',$4,now())`,
      requestId, sourceText, event.change.effectiveMonth, requestedByUserId,
    );
    const inserted = await tx.$queryRawUnsafe<Array<{ id: string }>>(
      `INSERT INTO "OperationsCommand"
        (id,"requestId","idempotencyKey","sourceText","studentId","studentName",kind,"effectiveMonth",confidence,status,"holdReason","beforeJson","afterJson","billingStatus","notificationStatus")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,'HELD','HELD')
       ON CONFLICT ("idempotencyKey") DO NOTHING RETURNING id`,
      commandId, requestId, idempotencyKey, sourceText, resolvedStudent?.id ?? null,
      resolvedStudent?.name ?? event.change.studentName ?? null, event.change.kind, event.change.effectiveMonth,
      holdReason ? "LOW" : "HIGH", holdReason ? "HELD" : "PENDING", holdReason,
      JSON.stringify(event.change.before),
      JSON.stringify({
        ...event.change.after,
        effectiveDate: event.change.effectiveDate,
        operationsEvent: { eventId: event.eventId, source: event.source, occurredAt: event.occurredAt, payloadFingerprint },
      }),
    );
    if (!inserted[0]) {
      // 동시에 같은 이벤트가 도착한 경우 방금 만든 빈 요청은 지우고 먼저 접수된 원장을 돌려준다.
      await tx.$executeRawUnsafe(`DELETE FROM "OperationsRequest" WHERE id=$1`, requestId);
      const duplicate = await tx.$queryRawUnsafe<ExistingCommand[]>(existingCommandSql, idempotencyKey);
      const conflict = !duplicate[0] || !payloadMatches(duplicate[0].payloadFingerprint, payloadFingerprint);
      if (duplicate[0] && conflict) {
        await tx.$executeRawUnsafe(
          `INSERT INTO "OperationsAuditLog" (id,"requestId",action,"actorType","detailsJson")
           VALUES ($1,$2,'OPERATIONS_EVENT_CONFLICT','SYSTEM',$3::jsonb)`,
          crypto.randomUUID(), duplicate[0].requestId,
          JSON.stringify({ eventId: event.eventId, source: event.source, reason: "PAYLOAD_FINGERPRINT_MISMATCH" }),
        );
      }
      return { duplicate: true as const, conflict, command: duplicate[0] };
    }
    for (const target of SYNC_TARGETS) {
      // 시트 은퇴(기본) 상태면 SHEET 칸은 처음부터 SKIPPED — 만들 시트 원장이 없다.
      const initial = initialSyncAttempt(target, isSheetSyncRetired(process.env));
      await tx.$executeRawUnsafe(
        `INSERT INTO "OperationsSyncAttempt" (id,"commandId",target,status,"externalReference") VALUES ($1,$2,$3,$4,$5)`,
        crypto.randomUUID(), commandId, target, initial.status, initial.externalReference,
      );
    }
    await tx.$executeRawUnsafe(
      `INSERT INTO "OperationsAuditLog" (id,"requestId",action,"actorType","detailsJson")
       VALUES ($1,$2,'OPERATIONS_EVENT_RECEIVED','SYSTEM',$3::jsonb)`,
      crypto.randomUUID(), requestId,
      JSON.stringify({ eventId: event.eventId, source: event.source, occurredAt: event.occurredAt, held: Boolean(holdReason) }),
    );
    return { duplicate: false as const, conflict: false, command: { id: commandId, requestId, status: holdReason ? "HELD" : "PENDING" } };
  });

  if (result.conflict || !result.command) {
    return NextResponse.json({ error: "같은 이벤트 ID에 서로 다른 변경 내용이 접수되었습니다." }, { status: 409 });
  }
  return NextResponse.json({ ok: true, duplicate: result.duplicate, ...result.command }, { status: result.duplicate ? 200 : 202 });
}
