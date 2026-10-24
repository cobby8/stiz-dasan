import { prisma } from "@/lib/prisma";

const REQUIRED_COLUMNS: Record<string, readonly string[]> = {
  OperationsRequest: ["id", "sourceText", "targetMonth", "status", "requestedByUserId", "approvedByUserId", "approvedAt", "parentRequestLinkId", "submittedAt", "createdAt", "updatedAt"],
  OperationsCommand: ["id", "requestId", "idempotencyKey", "sourceText", "studentId", "studentName", "kind", "effectiveMonth", "confidence", "status", "holdReason", "beforeJson", "afterJson", "billingStatus", "notificationStatus", "createdAt", "updatedAt"],
  OperationsSyncAttempt: ["id", "commandId", "target", "status", "attempts", "externalReference", "error", "verifiedAt", "processingToken", "processingStartedAt", "createdAt", "updatedAt"],
  RallyzAttendanceSyncRun: ["id", "sourceDate", "status", "sourceJson", "requestedByUserId", "appliedByUserId", "appliedAt", "createdAt", "updatedAt"],
  RallyzAttendanceSyncItem: ["id", "runId", "idempotencyKey", "sourceDate", "rallyzClassId", "sourceClassName", "slotKey", "studentName", "managementName", "sourceStatus", "siteStatus", "studentId", "classId", "sessionId", "attendanceId", "status", "holdReason", "createdAt", "updatedAt"],
  ParentOperationsRequestLink: ["id", "studentId", "tokenHash", "purpose", "expiresAt", "revokedAt", "lastUsedAt", "createdByUserId", "createdAt", "updatedAt"],
  OperationsAuditLog: ["id", "requestId", "linkId", "action", "actorType", "actorUserId", "detailsJson", "createdAt"],
};

let infrastructureReady = false;
let infrastructureCheck: Promise<void> | null = null;

async function checkOperationsSyncInfrastructure() {
  const rows = await prisma.$queryRawUnsafe<Array<{ table_name: string; column_name: string }>>(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = ANY($1::text[])`,
    Object.keys(REQUIRED_COLUMNS),
  );
  const existing = new Set(rows.map((row) => `${row.table_name}.${row.column_name}`));
  const missing = Object.entries(REQUIRED_COLUMNS).flatMap(([table, columns]) =>
    columns.filter((column) => !existing.has(`${table}.${column}`)).map((column) => `${table}.${column}`),
  );
  if (missing.length > 0) {
    throw new Error(
      `운영 동기화 DB 구조가 준비되지 않았습니다: ${missing.join(", ")}. `
      + "아래 4개 migration을 순서대로 모두 적용해 주세요: "
      + "prisma/migrations/20260827190000_add_parent_operations_request_links → "
      + "prisma/migrations/20260827223000_add_operations_sync_processing_lease → "
      + "prisma/migrations/20260828090000_complete_operations_sync_infrastructure → "
      + "prisma/migrations/20260904100000_add_parent_operations_link_purpose.",
    );
  }
}

/**
 * 호출 계약은 유지하되 SSR에서는 DDL을 실행하지 않고 필수 구조만 읽기 전용으로 확인한다.
 * 동시에 여러 서버 함수가 호출돼도 동일 Promise를 공유해 DB 확인은 한 번만 수행한다.
 */
export async function ensureOperationsSyncInfrastructure() {
  if (infrastructureReady) return;
  if (!infrastructureCheck) {
    infrastructureCheck = checkOperationsSyncInfrastructure()
      .then(() => { infrastructureReady = true; })
      .catch((error) => {
        // 일시적 연결 실패는 다음 요청에서 다시 확인할 수 있게 잠금을 해제한다.
        infrastructureCheck = null;
        throw error;
      });
  }
  await infrastructureCheck;
}
