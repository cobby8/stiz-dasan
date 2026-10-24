import { prisma } from "@/lib/prisma";
import { ensureOperationsSyncInfrastructure } from "@/lib/operationsSyncInfrastructure";
import { isSheetTargetDone } from "@/lib/operations-sync/sheetRetirement";

const ACTIVE_LEASE_MINUTES = 10;
const SUPPORTED_SHEET_KINDS = new Set(["PAUSE", "WITHDRAW"]);
const OPEN_ATTEMPT_STATUSES = ["PENDING", "FAILED"] as const;
const RUNNABLE_REQUEST_STATUSES = new Set(["APPROVED", "PENDING", "PARTIAL"]);

type SyncTarget = "SHEET" | "RALLYZ" | "WEBSITE";
type AttemptStatus = (typeof OPEN_ATTEMPT_STATUSES)[number];

type OperationsSyncWorkerRow = {
  requestId: string;
  requestStatus: string;
  commandId: string;
  commandStatus: string;
  holdReason: string | null;
  kind: string;
  studentName: string | null;
  effectiveMonth: string;
  afterJson: {
    effectiveDate?: unknown;
    parentConfirmed?: unknown;
  } | null;
  target: SyncTarget;
  attemptStatus: AttemptStatus;
  attempts: number;
  processingStartedAt: Date | string | null;
  sheetStatus: string | null;
  rallyzStatus: string | null;
  websiteStatus: string | null;
};

export type OperationsSyncWorkAction =
  | "READY_FOR_SHEET_APPLY"
  | "READY_FOR_RALLYZ_CHECK"
  | "READY_FOR_WEBSITE_APPLY"
  | "WAITING_FOR_SHEET"
  | "WAITING_FOR_EXTERNALS"
  | "NOT_DUE"
  | "BUSY"
  | "NEEDS_REVIEW";

export type OperationsSyncWorkItem = {
  requestId: string;
  commandId: string;
  target: SyncTarget;
  attemptStatus: AttemptStatus;
  attempts: number;
  kind: string;
  studentName: string | null;
  effectiveMonth: string;
  effectiveDate: string | null;
  action: OperationsSyncWorkAction;
  reason: string;
  manualRequired: boolean;
};

export type OperationsSyncQueueSummary = {
  checkedAt: string;
  mode: "read-only";
  total: number;
  counts: Record<OperationsSyncWorkAction, number>;
  items: OperationsSyncWorkItem[];
};

function kstTodayYmd(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function isActiveLease(value: Date | string | null, now: Date) {
  if (!value) return false;
  const startedAt = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(startedAt.getTime())) return false;
  return now.getTime() - startedAt.getTime() < ACTIVE_LEASE_MINUTES * 60_000;
}

function readEffectiveDate(row: OperationsSyncWorkerRow) {
  const value = row.afterJson?.effectiveDate;
  return typeof value === "string" && /^20\d{2}-(0[1-9]|1[0-2])-[0-3]\d$/.test(value) ? value : null;
}

function isParentConfirmed(row: OperationsSyncWorkerRow) {
  return row.afterJson?.parentConfirmed === true;
}

export function classifyOperationsSyncWork(row: OperationsSyncWorkerRow, now = new Date()): OperationsSyncWorkItem {
  const effectiveDate = readEffectiveDate(row);
  const base = {
    requestId: row.requestId,
    commandId: row.commandId,
    target: row.target,
    attemptStatus: row.attemptStatus,
    attempts: row.attempts,
    kind: row.kind,
    studentName: row.studentName,
    effectiveMonth: row.effectiveMonth,
    effectiveDate,
  };

  const item = (
    action: OperationsSyncWorkAction,
    reason: string,
    manualRequired = true,
  ): OperationsSyncWorkItem => ({ ...base, action, reason, manualRequired });

  if (!RUNNABLE_REQUEST_STATUSES.has(row.requestStatus)) {
    return item("NEEDS_REVIEW", "승인되지 않은 요청입니다.");
  }
  if (row.commandStatus === "HELD" || row.holdReason) {
    return item("NEEDS_REVIEW", row.holdReason || "보류된 변경입니다.");
  }
  if (isActiveLease(row.processingStartedAt, now)) {
    return item("BUSY", "다른 실행기가 처리 중입니다.", false);
  }
  if (!effectiveDate || !isParentConfirmed(row)) {
    return item("NEEDS_REVIEW", "확정된 적용일 또는 학부모 확인 정보가 없습니다.");
  }
  if (effectiveDate > kstTodayYmd(now)) {
    return item("NOT_DUE", `적용일(${effectiveDate}) 이전입니다.`, false);
  }

  if (row.target === "SHEET") {
    if (!SUPPORTED_SHEET_KINDS.has(row.kind)) {
      return item("NEEDS_REVIEW", "이 변경 종류는 시트 자동 반영 대상이 아닙니다.");
    }
    return item("READY_FOR_SHEET_APPLY", "구글 시트 반영 준비가 끝났습니다.");
  }

  if (row.target === "RALLYZ") {
    // 시트 은퇴로 건너뛴(SKIPPED) 시트도 끝난 것으로 본다.
    if (!isSheetTargetDone(row.sheetStatus)) {
      return item("WAITING_FOR_SHEET", "구글 시트 반영과 재확인이 먼저 필요합니다.", false);
    }
    return item("READY_FOR_RALLYZ_CHECK", "랠리즈 반영 확인이 필요합니다.");
  }

  if (!isSheetTargetDone(row.sheetStatus) || row.rallyzStatus !== "SUCCEEDED") {
    return item("WAITING_FOR_EXTERNALS", "시트와 랠리즈가 모두 완료되어야 홈페이지 반영을 진행합니다.", false);
  }
  return item("READY_FOR_WEBSITE_APPLY", "홈페이지 반영 준비가 끝났습니다.");
}

export async function getOperationsSyncWorkItems(limit = 20, now = new Date()) {
  await ensureOperationsSyncInfrastructure();
  const safeLimit = Math.min(Math.max(Math.trunc(limit) || 20, 1), 100);
  const rows = await prisma.$queryRawUnsafe<OperationsSyncWorkerRow[]>(
    `SELECT r.id AS "requestId", r.status AS "requestStatus",
            c.id AS "commandId", c.status AS "commandStatus", c."holdReason",
            c.kind, c."studentName", c."effectiveMonth", c."afterJson",
            a.target, a.status AS "attemptStatus", a.attempts, a."processingStartedAt",
            sheet.status AS "sheetStatus", rallyz.status AS "rallyzStatus", website.status AS "websiteStatus"
       FROM "OperationsSyncAttempt" a
       JOIN "OperationsCommand" c ON c.id=a."commandId"
       JOIN "OperationsRequest" r ON r.id=c."requestId"
       LEFT JOIN "OperationsSyncAttempt" sheet ON sheet."commandId"=c.id AND sheet.target='SHEET'
       LEFT JOIN "OperationsSyncAttempt" rallyz ON rallyz."commandId"=c.id AND rallyz.target='RALLYZ'
       LEFT JOIN "OperationsSyncAttempt" website ON website."commandId"=c.id AND website.target='WEBSITE'
      WHERE a.status = ANY($1::text[])
      ORDER BY
            CASE a.target WHEN 'SHEET' THEN 0 WHEN 'RALLYZ' THEN 1 ELSE 2 END,
            r."createdAt" ASC,
            c."createdAt" ASC,
            a."updatedAt" ASC
      LIMIT $2`,
    [...OPEN_ATTEMPT_STATUSES],
    safeLimit,
  );
  return rows.map((row) => classifyOperationsSyncWork(row, now));
}

export async function summarizeOperationsSyncQueue(limit = 20, now = new Date()): Promise<OperationsSyncQueueSummary> {
  const items = await getOperationsSyncWorkItems(limit, now);
  const counts = items.reduce((acc, item) => {
    acc[item.action] = (acc[item.action] || 0) + 1;
    return acc;
  }, {} as Record<OperationsSyncWorkAction, number>);
  return {
    checkedAt: now.toISOString(),
    mode: "read-only",
    total: items.length,
    counts,
    items,
  };
}
