"use server";
import { finalizeEnrollmentChangeSync, hasVerifiedSyncTargets } from "@/lib/enrollment/finalize-change-sync";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-guard";
import { ensureOperationsSyncInfrastructure } from "@/lib/operationsSyncInfrastructure";
import { sheetHoldReleaseDecision } from "@/lib/enrollment/sheetManualCheckRules";

function kstTodayYmd() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

async function recordOperationsAuditBestEffort(statement: string, ...values: unknown[]) {
  try {
    await prisma.$executeRawUnsafe(statement, ...values);
  } catch (error) {
    // 감사로그 저장 장애는 관측하되 이미 끝난 외부 반영을 실패로 되돌리지 않는다.
    console.error("[operations-sync] 감사로그 저장 실패", error);
  }
}

/**
 * «보류 해제» (시트 은퇴 상태 전용).
 * 2026-11-18 결정표(sheet-switch «완전히 지운다»)로 구글 시트 자동 반영·«시트 직접 수정 완료» 확인은 지웠다.
 * 남은 일은 하나 — 시트 칸이 은퇴로 건너뜀(SKIPPED)인데 시트 때문에 걸려 있던 보류(복귀 어댑터 미지원 등)를 푸는 것.
 * - 사이트(WEBSITE) 반영이 이미 끝난 휴원·퇴원·복귀 건만 허용한다.
 * - 누가·언제·직전 상태/사유를 감사기록에 남긴다(거래 안에서 함께 커밋).
 * (이름은 옛 그대로 둔다 — 수강 변경 화면의 releaseEnrollmentChangeHoldSheetRetired 가 부른다.)
 */
export async function recordOperationsSheetManualCheck(commandId: string) {
  const admin = await requireAdmin();
  await ensureOperationsSyncInfrastructure();
  const result = await prisma.$transaction(async (tx) => {
    // 명령 행을 잠가 다른 처리와 동시에 상태를 바꾸지 못하게 한다.
    const commands = await tx.$queryRawUnsafe<Array<{
      requestId: string; status: string; holdReason: string | null; kind: string; studentId: string | null;
      effectiveDate: string | null; parentConfirmed: boolean; enrollmentChangeRequestId: string | null;
    }>>(
      `SELECT "requestId", status, "holdReason", kind, "studentId", "afterJson"->>'effectiveDate' AS "effectiveDate",
              (c."afterJson"->>'parentConfirmed' = 'true') AS "parentConfirmed",
              c."afterJson"->>'enrollmentChangeRequestId' AS "enrollmentChangeRequestId"
         FROM "OperationsCommand" c WHERE id=$1 FOR UPDATE`, commandId,
    );
    const command = commands[0];
    if (!command) throw new Error("변경 기록을 찾을 수 없습니다.");
    if (command.status === "SYNCED") return { changed: false };
    // 복귀(RESUME)는 관리자 직접 변경에서만 생기고 시트 자동 반영을 지원하지 않아, 수동 확인이 유일한 길이다.
    if (!['PAUSE', 'WITHDRAW', 'RESUME'].includes(command.kind)) throw new Error("휴원·퇴원·복귀 변경만 시트 수동 확인을 할 수 있습니다.");
    if (!command.parentConfirmed || !command.effectiveDate) throw new Error("확정된 적용일이 없는 기존 요청은 시트 수동 확인을 할 수 없습니다.");
    if (command.effectiveDate > kstTodayYmd()) throw new Error(`적용일(${command.effectiveDate}) 이전에는 시트 수동 확인을 할 수 없습니다.`);

    const attempts = await tx.$queryRawUnsafe<Array<{ target: string; status: string; error: string | null }>>(
      `SELECT target, status, error
         FROM "OperationsSyncAttempt" WHERE "commandId"=$1 FOR UPDATE`, commandId,
    );
    const website = attempts.find((item) => item.target === "WEBSITE");
    const sheet = attempts.find((item) => item.target === "SHEET");
    // 사이트가 먼저 반영된 자동 적용 건만 대상이다. 사이트 반영 충돌 등 다른 이유의 보류는 여기서 풀지 않는다.
    if (website?.status !== "SUCCEEDED") throw new Error("사이트 반영이 끝난 건만 시트 수동 확인을 할 수 있습니다.");
    if (!sheet) throw new Error("시트 반영 기록을 찾을 수 없습니다.");
    // 보류가 아니면 풀 것이 없다.
    if (command.status !== "HELD") return { changed: false };
    // 시트 칸이 건너뜀(SKIPPED)이 아닌 옛 기록은 더 이상 사람이 닫을 길이 없다(운영 0건 확인, 2026-11-18).
    if (sheet.status !== "SKIPPED") throw new Error("구글 시트 확인은 더 이상 지원하지 않습니다. 관리자에게 문의해 주세요.");
    // 복귀(RESUME) 어댑터 미지원 보류는 시트 때문에 걸린 보류라, 은퇴 후엔 풀어 줘야 원장이 끝난다.
    // 같은 판정 함수를 거친다 → 학생 미확정·신청 미연결·정책 보류는 그대로 거부.
    const decision = sheetHoldReleaseDecision({
      kind: command.kind, studentId: command.studentId, enrollmentChangeRequestId: command.enrollmentChangeRequestId,
      holdReason: command.holdReason, sheetStatus: sheet.status, sheetError: sheet.error,
    });
    if (!decision.ok) throw new Error(decision.reason);
    await tx.$executeRawUnsafe(
      `UPDATE "OperationsCommand" SET status='PENDING', "holdReason"=NULL, "updatedAt"=now() WHERE id=$1 AND status='HELD'`, commandId,
    );
    // 누가·언제·왜(시트 은퇴 상태에서 보류 해제)·직전 사유를 같은 거래로 남긴다.
    await tx.$executeRawUnsafe(
      `INSERT INTO "OperationsAuditLog" (id,"requestId",action,"actorType","actorUserId","detailsJson")
       VALUES ($1,$2,'COMMAND_HOLD_RELEASED','ADMIN',$3,$4::jsonb)`,
      crypto.randomUUID(), command.requestId, admin.appUserId,
      JSON.stringify({
        commandId, target: "SHEET", manual: true, note: "시트 은퇴 상태에서 보류 해제",
        sheetStatus: sheet.status, previousCommandStatus: command.status, previousHoldReason: command.holdReason,
      }),
    );
    return { changed: true };
  });
  await refreshOperationsStatuses(commandId);
  revalidatePath("/admin/enrollment-changes");
  return { ok: true as const, skipped: !result.changed };
}

async function refreshOperationsStatuses(commandId: string) {
  const changes = await prisma.$transaction(async (tx) => {
    const commands = await tx.$queryRawUnsafe<Array<{ requestId: string; commandStatus: string }>>(
      `SELECT "requestId", status AS "commandStatus" FROM "OperationsCommand" WHERE id=$1 FOR UPDATE`, commandId,
    );
    const command = commands[0];
    if (!command) return null;
    await tx.$queryRawUnsafe(`SELECT id FROM "OperationsRequest" WHERE id=$1 FOR UPDATE`, command.requestId);
    const attempts = await tx.$queryRawUnsafe<Array<{ target: string; status: string; verifiedAt: Date | null }>>(
      `SELECT target,status,"verifiedAt" FROM "OperationsSyncAttempt" WHERE "commandId"=$1 ORDER BY target FOR SHARE`, commandId,
    );
    // 사람이 다시 검토해야 하는 HELD는 단순 상태 집계가 덮어쓰면 안 된다.
    const commandStatus = command.commandStatus === "HELD"
      ? "HELD"
      : attempts.some((item) => item.status === "FAILED") ? "PARTIAL"
        : hasVerifiedSyncTargets(attempts) ? "SYNCED" : "PENDING";
    if (commandStatus !== command.commandStatus) {
      await tx.$executeRawUnsafe(`UPDATE "OperationsCommand" SET status=$2, "updatedAt"=now() WHERE id=$1`, commandId, commandStatus);
    }
    const requestRows = await tx.$queryRawUnsafe<Array<{ status: string }>>(
      `SELECT status FROM "OperationsCommand" WHERE "requestId"=$1`, command.requestId,
    );
    const hasHeld = requestRows.some((item) => item.status === "HELD");
    const hasPartial = requestRows.some((item) => item.status === "PARTIAL");
    const allHeld = requestRows.length > 0 && requestRows.every((item) => item.status === "HELD");
    const requestStatus = allHeld ? "HELD" : hasHeld || hasPartial ? "PARTIAL" : requestRows.length > 0 && requestRows.every((item) => item.status === "SYNCED") ? "SYNCED" : "PENDING";
    const currentRequests = await tx.$queryRawUnsafe<Array<{ status: string }>>(
      `SELECT status FROM "OperationsRequest" WHERE id=$1`, command.requestId,
    );
    const previousRequestStatus = currentRequests[0]?.status;
    if (previousRequestStatus && previousRequestStatus !== requestStatus) {
      await tx.$executeRawUnsafe(
        `UPDATE "OperationsRequest" SET status=$2, "updatedAt"=now() WHERE id=$1`, command.requestId, requestStatus,
      );
    }
    if (commandStatus === "SYNCED") await finalizeEnrollmentChangeSync(tx, commandId);
    return {
      requestId: command.requestId,
      commandChange: commandStatus !== command.commandStatus ? { from: command.commandStatus, to: commandStatus } : null,
      requestChange: previousRequestStatus && previousRequestStatus !== requestStatus ? { from: previousRequestStatus, to: requestStatus } : null,
    };
  });
  if (!changes) return;
  revalidatePath("/admin/enrollment-changes");

  // 집계 상태를 먼저 커밋한 뒤 감사로그를 남겨 기록 장애가 핵심 상태를 롤백하지 못하게 한다.
  if (changes.commandChange) await recordOperationsAuditBestEffort(
    `INSERT INTO "OperationsAuditLog" (id,"requestId",action,"actorType","detailsJson") VALUES ($1,$2,'COMMAND_STATUS_CHANGED','SYSTEM',$3::jsonb)`,
    crypto.randomUUID(), changes.requestId, JSON.stringify({ commandId, ...changes.commandChange }),
  );
  if (changes.requestChange) await recordOperationsAuditBestEffort(
    `INSERT INTO "OperationsAuditLog" (id,"requestId",action,"actorType","detailsJson") VALUES ($1,$2,'REQUEST_STATUS_CHANGED','SYSTEM',$3::jsonb)`,
    crypto.randomUUID(), changes.requestId, JSON.stringify(changes.requestChange),
  );
}
