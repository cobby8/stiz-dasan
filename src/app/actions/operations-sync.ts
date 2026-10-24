"use server";
import { finalizeEnrollmentChangeSync, hasVerifiedSyncTargets } from "@/lib/enrollment/finalize-change-sync";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-guard";
import { ensureOperationsSyncInfrastructure } from "@/lib/operationsSyncInfrastructure";
import { applySheetEnrollmentStatus } from "@/lib/googleSheetsOperations";
import { sheetHoldReleaseDecision } from "@/lib/enrollment/sheetManualCheckRules";
import { isSheetTargetDone } from "@/lib/operations-sync/sheetRetirement";

type OperationsRequestRow = {
  id: string;
  sourceText: string;
  targetMonth: string;
  status: string;
  parentRequestLinkId: string | null;
  submittedAt: Date | string | null;
  createdAt: Date | string;
  commands: Array<{
    id: string;
    studentName: string | null;
    kind: string;
    effectiveMonth: string;
    confidence: string;
    status: string;
    holdReason: string | null;
    beforeJson: { enrollments?: Array<{ id: string; status: string; className: string }> } | null;
    afterJson: { enrollments?: Array<{ id: string; status: string; className: string }> } | null;
    effectiveDate: string | null;
    fromClassName: string | null;
    toClassName: string | null;
    canExecute?: boolean;
    targets: Array<{ target: "SHEET" | "RALLYZ" | "WEBSITE"; status: string }>;
  }>;
};

export async function createOperationsRequest(sourceText: string, targetMonth: string) {
  await requireAdmin();
  const text = sourceText.trim();
  if (!text) throw new Error("학부모 요청 내용을 입력해 주세요.");
  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(targetMonth)) throw new Error("적용 월을 확인해 주세요.");

  // 자유문장만으로는 적용일·대상 반을 확정할 수 없다. 공개 요청서의 구조화 확인 절차만 사용한다.
  throw new Error("관리자 직접 입력은 안전한 적용일·대상 수업을 확정할 수 없어 중단되었습니다. 학생별 학부모 요청 링크에서 내용을 확인해 접수해 주세요.");

}

export async function getOperationsRequests() {
  await requireAdmin();
  await ensureOperationsSyncInfrastructure();
  const rows = await prisma.$queryRawUnsafe<OperationsRequestRow[]>(
    `SELECT r.id, r."sourceText", r."targetMonth", r.status, r."createdAt", r."parentRequestLinkId", r."submittedAt",
            COALESCE(json_agg(json_build_object(
              'id', c.id, 'studentName', c."studentName", 'kind', c.kind,
              'effectiveMonth', c."effectiveMonth", 'confidence', c.confidence,
              'effectiveDate', c."afterJson"->>'effectiveDate',
              'fromClassName', (SELECT name FROM "Class" WHERE id=(c."afterJson"->>'fromClassId')),
              'toClassName', (SELECT name FROM "Class" WHERE id=(c."afterJson"->>'toClassId')),
              'status', c.status, 'holdReason', c."holdReason",
              'beforeJson', c."beforeJson", 'afterJson', c."afterJson",
              'targets', (SELECT json_agg(json_build_object('target',a.target,'status',a.status) ORDER BY a.target)
                            FROM "OperationsSyncAttempt" a WHERE a."commandId" = c.id)
            ) ORDER BY c."createdAt") FILTER (WHERE c.id IS NOT NULL), '[]'::json) AS commands
       FROM "OperationsRequest" r
       LEFT JOIN "OperationsCommand" c ON c."requestId" = r.id
      GROUP BY r.id
      ORDER BY r."createdAt" DESC
      LIMIT 50`,
  );
  const serverToday = kstTodayYmd();
  return rows.map((row) => ({
    ...row,
    commands: row.commands.map((command) => ({
      ...command,
      canExecute: Boolean(command.effectiveDate && command.effectiveDate <= serverToday),
    })),
    source: row.parentRequestLinkId ? "PARENT_LINK" as const : "ADMIN" as const,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    submittedAt: row.submittedAt instanceof Date ? row.submittedAt.toISOString() : row.submittedAt,
  }));
}

type PreviewEnrollment = { id: string; status: string; className: string };
type StructuredCommandPlan = {
  effectiveDate?: string;
  fromClassId?: string | null;
  toClassId?: string | null;
  shuttleIntent?: string | null;
  details?: string;
  warnings?: string[];
  parentConfirmed?: boolean;
  enrollments?: PreviewEnrollment[];
};

function kstTodayYmd() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

type SyncTarget = "SHEET" | "RALLYZ" | "WEBSITE";

/**
 * 외부 호출은 DB 트랜잭션 안에서 기다릴 수 없으므로 10분 임대 토큰을 먼저 잡는다.
 * 성공한 대상은 조건절에서 제외해 같은 작업이 다시 호출되지 않게 한다.
 */
async function claimSyncAttempt(commandId: string, target: SyncTarget, actorUserId: string) {
  const token = crypto.randomUUID();
  const claimed = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRawUnsafe<Array<{ requestId: string; previousStatus: string }>>(
      `WITH candidate AS (
         SELECT a.id, a.status AS "previousStatus", c."requestId"
           FROM "OperationsSyncAttempt" a
           JOIN "OperationsCommand" c ON c.id=a."commandId"
          WHERE a."commandId"=$1 AND a.target=$2 AND a.status IN ('PENDING','FAILED')
            AND (a."processingToken" IS NULL OR a."processingStartedAt" < now() - interval '10 minutes')
          FOR UPDATE OF a
       ), updated AS (
         UPDATE "OperationsSyncAttempt" a
            SET "processingToken"=$3, "processingStartedAt"=now(), attempts=a.attempts+1, "updatedAt"=now()
           FROM candidate
          WHERE a.id=candidate.id
          RETURNING candidate."requestId", candidate."previousStatus"
       ) SELECT * FROM updated`,
      commandId, target, token,
    );
    if (!rows[0]) return null;
    await tx.$executeRawUnsafe(
      `INSERT INTO "OperationsAuditLog" (id,"requestId",action,"actorType","actorUserId","detailsJson")
       VALUES ($1,$2,$3,'ADMIN',$4,$5::jsonb)`,
      crypto.randomUUID(), rows[0].requestId,
      rows[0].previousStatus === "FAILED" ? "SYNC_TARGET_RETRIED" : "SYNC_TARGET_STARTED",
      actorUserId, JSON.stringify({ commandId, target }),
    );
    return rows[0];
  });
  if (claimed) return { token, skipped: false as const };

  const current = await prisma.$queryRawUnsafe<Array<{ status: string; processing: boolean }>>(
    `SELECT status, ("processingToken" IS NOT NULL AND "processingStartedAt" >= now() - interval '10 minutes') AS processing
       FROM "OperationsSyncAttempt" WHERE "commandId"=$1 AND target=$2`, commandId, target,
  );
  if (current[0]?.status === "SUCCEEDED") return { token: null, skipped: true as const };
  if (current[0]?.processing) throw new Error("같은 반영 작업이 이미 진행 중입니다. 잠시 후 상태를 다시 확인해 주세요.");
  throw new Error("현재 상태에서는 이 반영 작업을 시작할 수 없습니다.");
}

async function finishSyncAttempt(params: {
  commandId: string;
  target: SyncTarget;
  token: string;
  actorUserId: string;
  succeeded: boolean;
  externalReference?: string;
  error?: string;
}) {
  const rows = await prisma.$queryRawUnsafe<Array<{ requestId: string }>>(
      `WITH updated AS (
         UPDATE "OperationsSyncAttempt" a
            SET status=$4, "externalReference"=COALESCE($5,"externalReference"), error=$6,
                "verifiedAt"=CASE WHEN $4='SUCCEEDED' THEN now() ELSE NULL END,
                "processingToken"=NULL, "processingStartedAt"=NULL, "updatedAt"=now()
          WHERE a."commandId"=$1 AND a.target=$2 AND a."processingToken"=$3 AND a.status IN ('PENDING','FAILED')
          RETURNING a."commandId"
       ) SELECT c."requestId" FROM updated u JOIN "OperationsCommand" c ON c.id=u."commandId"`,
      params.commandId, params.target, params.token, params.succeeded ? "SUCCEEDED" : "FAILED",
      params.externalReference || null, params.error?.slice(0, 1000) || null,
  );
  if (!rows[0]) throw new Error("반영 작업의 실행 권한이 만료되었거나 이미 처리되었습니다.");

  // 외부 반영 결과는 먼저 확정한다. 감사로그 장애가 성공 상태와 임대 해제를 되돌리면 외부 작업이 중복될 수 있다.
  await recordOperationsAuditBestEffort(
      `INSERT INTO "OperationsAuditLog" (id,"requestId",action,"actorType","actorUserId","detailsJson")
       VALUES ($1,$2,$3,'ADMIN',$4,$5::jsonb)`,
      crypto.randomUUID(), rows[0].requestId, params.succeeded ? "SYNC_TARGET_SUCCEEDED" : "SYNC_TARGET_FAILED",
      params.actorUserId, JSON.stringify({ commandId: params.commandId, target: params.target, error: params.error?.slice(0, 1000) || null }),
  );
}

async function recordOperationsAuditBestEffort(statement: string, ...values: unknown[]) {
  try {
    await prisma.$executeRawUnsafe(statement, ...values);
  } catch (error) {
    // 감사로그 저장 장애는 관측하되 이미 끝난 외부 반영을 실패로 되돌리지 않는다.
    console.error("[operations-sync] 감사로그 저장 실패", error);
  }
}

export async function approveOperationsRequest(requestId: string) {
  const admin = await requireAdmin();
  await ensureOperationsSyncInfrastructure();
  let ready = 0;
  await prisma.$transaction(async (tx) => {
    // 요청 행을 잠가 같은 승인 버튼의 동시 실행을 직렬화한다.
    const locked = await tx.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM "OperationsRequest" WHERE id=$1 FOR UPDATE`, requestId,
    );
    if (!locked[0]) throw new Error("요청을 찾을 수 없습니다.");
    const commands = await tx.$queryRawUnsafe<Array<{ id: string; studentId: string | null; kind: string; status: string; afterJson: StructuredCommandPlan | null; effectiveMonth: string }>>(
      `SELECT id, "studentId", kind, status, "afterJson", "effectiveMonth" FROM "OperationsCommand" WHERE "requestId"=$1 AND status <> 'SYNCED' ORDER BY "createdAt" FOR UPDATE`,
      requestId,
    );
    if (commands.length === 0) throw new Error("승인할 변경 명령이 없습니다.");
    for (const command of commands) {
      if (!command.studentId) {
        await tx.$executeRawUnsafe(`UPDATE "OperationsCommand" SET status='HELD', "holdReason"='학생을 확정할 수 없습니다.', "updatedAt"=now() WHERE id=$1`, command.id);
        continue;
      }
      const plan = command.afterJson;
      const effectiveDate = plan?.effectiveDate;
      const fromClassId = plan?.fromClassId;
      const requiresFromClass = ['PAUSE', 'WITHDRAW', 'RESUME', 'CLASS_CHANGE'].includes(command.kind);
      const requiresToClass = ['CLASS_CHANGE', 'CLASS_ADD'].includes(command.kind);
      if (!plan?.parentConfirmed || !effectiveDate || (requiresFromClass && !fromClassId) || (requiresToClass && !plan.toClassId) || effectiveDate.slice(0, 7) !== command.effectiveMonth) {
        await tx.$executeRawUnsafe(
          `UPDATE "OperationsCommand" SET status='HELD', "holdReason"='확정된 적용일 또는 필수 대상 수업이 없는 기존 요청입니다. 대상을 다시 확인해 주세요.', "updatedAt"=now() WHERE id=$1`,
          command.id,
        );
        continue;
      }
      if (plan.toClassId) {
        const targets = await tx.$queryRawUnsafe<Array<{ id: string }>>(
          `SELECT c.id FROM "Class" c JOIN "Program" p ON p.id=c."programId" WHERE c.id=$1 AND c."dayOfWeek"<>'Seasonal' AND p."deletedAt" IS NULL LIMIT 1`,
          plan.toClassId,
        );
        if (targets.length !== 1) {
          await tx.$executeRawUnsafe(`UPDATE "OperationsCommand" SET status='HELD', "holdReason"='희망 수업이 더 이상 개설되어 있지 않습니다.', "updatedAt"=now() WHERE id=$1`, command.id);
          continue;
        }
      }
      if (!['PAUSE', 'WITHDRAW'].includes(command.kind)) {
        await tx.$executeRawUnsafe(
          `UPDATE "OperationsCommand" SET status='HELD', "holdReason"='대상 반·노선·금액을 확정하는 전용 어댑터가 필요합니다.', "updatedAt"=now() WHERE id=$1`,
          command.id,
        );
        continue;
      }
      const enrollments = await tx.$queryRawUnsafe<PreviewEnrollment[]>(
        `SELECT e.id, e.status, c.name AS "className" FROM "Enrollment" e JOIN "Class" c ON c.id=e."classId"
          WHERE e."studentId"=$1 AND e."classId"=$2 AND e.status IN ('ACTIVE','PAUSED') ORDER BY c.name`,
        command.studentId, fromClassId,
      );
      if (enrollments.length !== 1) {
        await tx.$executeRawUnsafe(
          `UPDATE "OperationsCommand" SET status='HELD', "holdReason"='대상 수강 등록이 없거나 여러 건이라 자동 반영할 수 없습니다.', "updatedAt"=now() WHERE id=$1`, command.id,
        );
        continue;
      }
      const nextStatus = command.kind === "PAUSE" ? "PAUSED" : "WITHDRAWN";
      await tx.$executeRawUnsafe(
        `UPDATE "OperationsCommand" SET "beforeJson"=$2::jsonb, "afterJson"=$3::jsonb, confidence='HIGH', status='PENDING', "holdReason"=NULL, "updatedAt"=now() WHERE id=$1`,
        command.id,
        JSON.stringify({ ...plan, enrollments }),
        JSON.stringify({ ...plan, enrollments: enrollments.map((row) => ({ ...row, status: nextStatus })) }),
      );
      // 상태 충돌로 실패했던 홈페이지 시도만 새 미리보기 기준으로 다시 열어 준다.
      await tx.$executeRawUnsafe(
        `UPDATE "OperationsSyncAttempt" SET status='PENDING', error=NULL, "verifiedAt"=NULL, "updatedAt"=now()
          WHERE "commandId"=$1 AND target='WEBSITE' AND status='FAILED'`, command.id,
      );
      ready += 1;
    }
    await tx.$executeRawUnsafe(
      `UPDATE "OperationsRequest" SET status=$2, "approvedByUserId"=$3, "approvedAt"=now(), "updatedAt"=now() WHERE id=$1`,
      requestId, ready > 0 ? "APPROVED" : "HELD", admin.appUserId,
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO "OperationsAuditLog" (id,"requestId",action,"actorType","actorUserId","detailsJson")
       VALUES ($1,$2,$3,'ADMIN',$4,$5::jsonb)`,
      crypto.randomUUID(), requestId, ready > 0 ? "REQUEST_APPROVED" : "REQUEST_HELD", admin.appUserId,
      JSON.stringify({ readyCommands: ready, totalCommands: commands.length }),
    );
  });
  revalidatePath("/admin/operations-sync");
  return { ok: true as const, ready };
}

export async function applyOperationsWebsite(requestId: string) {
  const admin = await requireAdmin();
  await ensureOperationsSyncInfrastructure();
  const requests = await prisma.$queryRawUnsafe<Array<{ status: string; targetMonth: string }>>(
    `SELECT status, "targetMonth" FROM "OperationsRequest" WHERE id=$1`, requestId,
  );
  if (!requests[0] || !['APPROVED', 'PARTIAL', 'PENDING'].includes(requests[0].status)) throw new Error("먼저 변경 계획을 승인해 주세요.");
  const currentMonth = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit" }).format(new Date()).slice(0, 7);
  if (requests[0].targetMonth > currentMonth) throw new Error("미래 적용 월은 시작된 뒤 홈페이지 상태를 변경해 주세요.");

  const commands = await prisma.$queryRawUnsafe<Array<{
    id: string;
    beforeJson: { enrollments?: Array<{ id: string; status: string }> } | null;
    afterJson: { enrollments?: Array<{ id: string; status: string }> } | null;
    effectiveDate: string | null;
  }>>(
    `SELECT c.id, c."beforeJson", c."afterJson", c."afterJson"->>'effectiveDate' AS "effectiveDate" FROM "OperationsCommand" c
      JOIN "OperationsSyncAttempt" a ON a."commandId"=c.id AND a.target='WEBSITE'
      WHERE c."requestId"=$1 AND c.status IN ('PENDING','PARTIAL') AND a.status IN ('PENDING','FAILED')
        AND NOT EXISTS (
          SELECT 1 FROM "OperationsSyncAttempt" pending
          WHERE pending."commandId"=c.id
            -- 시트는 은퇴로 건너뜀(SKIPPED)도 끝난 것으로 본다. 랠리즈는 실제 확인(SUCCEEDED)만.
            AND ((pending.target='SHEET' AND pending.status NOT IN ('SUCCEEDED','SKIPPED'))
              OR (pending.target='RALLYZ' AND pending.status <> 'SUCCEEDED'))
        )`, requestId,
  );
  if (commands.length === 0) {
    // 홈페이지 반영 커밋 직후 프로세스가 중단됐다면 외부 작업은 반복하지 않고 상위 집계만 복구한다.
    const succeeded = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT c.id FROM "OperationsCommand" c
        JOIN "OperationsSyncAttempt" a ON a."commandId"=c.id AND a.target='WEBSITE'
       WHERE c."requestId"=$1 AND a.status='SUCCEEDED' AND c.status <> 'HELD'`, requestId,
    );
    if (succeeded.length > 0) {
      for (const command of succeeded) await refreshOperationsStatuses(command.id);
      revalidatePath("/admin/operations-sync");
      return { ok: true as const, applied: 0, skipped: true as const };
    }
    throw new Error("먼저 시트와 랠리즈의 실제 반영을 모두 확인해 주세요.");
  }
  const today = kstTodayYmd();
  const notDue = commands.filter((command) => !command.effectiveDate || command.effectiveDate > today);
  if (notDue.length > 0) throw new Error(`적용일(${notDue[0].effectiveDate || "미확정"}) 이전에는 홈페이지 상태를 변경할 수 없습니다.`);
  let applied = 0;
  const conflicts: string[] = [];
  for (const command of commands) {
    const claim = await claimSyncAttempt(command.id, "WEBSITE", admin.appUserId);
    if (claim.skipped || !claim.token) continue;
    const beforeRows = command.beforeJson?.enrollments || [];
    const afterRows = command.afterJson?.enrollments || [];
    const beforeById = new Map(beforeRows.map((row) => [row.id, row.status]));
    const invalidPreview = beforeRows.length === 0
      || afterRows.length !== beforeRows.length
      || afterRows.some((row) => !beforeById.has(row.id));
    if (invalidPreview) {
      conflicts.push(command.id);
      await markWebsiteConflict(command.id, claim.token, admin.appUserId, "승인 당시 수강 상태 미리보기가 불완전하여 반영을 중단했습니다.");
      continue;
    }

    try {
      await prisma.$transaction(async (tx) => {
        for (const row of afterRows) {
          const expectedStatus = beforeById.get(row.id)!;
          const affected = await tx.$executeRawUnsafe(
            `UPDATE "Enrollment" SET status=$2, "updatedAt"=now() WHERE id=$1 AND status=$3`,
            row.id, row.status, expectedStatus,
          );
          if (affected !== 1) throw new Error(`ENROLLMENT_CONFLICT:${row.id}`);
        }
        const attemptAffected = await tx.$executeRawUnsafe(
          `UPDATE "OperationsSyncAttempt" SET status='SUCCEEDED', "verifiedAt"=now(), error=NULL,
                  "processingToken"=NULL, "processingStartedAt"=NULL, "updatedAt"=now()
            WHERE "commandId"=$1 AND target='WEBSITE' AND "processingToken"=$2 AND status IN ('PENDING','FAILED')`, command.id, claim.token,
        );
        if (attemptAffected !== 1) throw new Error("WEBSITE_ATTEMPT_CONFLICT");
        await tx.$executeRawUnsafe(
          `INSERT INTO "OperationsAuditLog" (id,"requestId",action,"actorType","actorUserId","detailsJson")
           VALUES ($1,$2,'SYNC_TARGET_SUCCEEDED','ADMIN',$3,$4::jsonb)`,
          crypto.randomUUID(), requestId, admin.appUserId, JSON.stringify({ commandId: command.id, target: "WEBSITE" }),
        );
      });
      applied += 1;
    } catch (error) {
      const isConflict = error instanceof Error && (error.message.startsWith("ENROLLMENT_CONFLICT:") || error.message === "WEBSITE_ATTEMPT_CONFLICT");
      if (!isConflict) {
        const message = error instanceof Error ? error.message : "홈페이지 반영 실패";
        await finishSyncAttempt({ commandId: command.id, target: "WEBSITE", token: claim.token, actorUserId: admin.appUserId, succeeded: false, error: message });
        await refreshOperationsStatuses(command.id);
        throw error;
      }
      conflicts.push(command.id);
      await markWebsiteConflict(command.id, claim.token, admin.appUserId, "승인 후 수강 상태가 변경되었습니다. 현재 상태를 다시 확인하고 재승인해 주세요.");
    }
  }
  for (const command of commands) await refreshOperationsStatuses(command.id);
  revalidatePath("/admin/operations-sync");
  if (conflicts.length > 0) {
    throw new Error(`${conflicts.length}건은 승인 후 수강 상태가 달라져 반영하지 않았습니다. 요청을 다시 검토해 주세요.`);
  }
  return { ok: true as const, applied, skipped: false as const };
}

async function markWebsiteConflict(commandId: string, processingToken: string, actorUserId: string, reason: string) {
  await prisma.$transaction(async (tx) => {
    const commands = await tx.$queryRawUnsafe<Array<{ requestId: string }>>(
      `UPDATE "OperationsCommand" SET status='HELD', "holdReason"=$2, "updatedAt"=now()
        WHERE id=$1 AND status <> 'SYNCED' RETURNING "requestId"`, commandId, reason,
    );
    const affected = await tx.$executeRawUnsafe(
      `UPDATE "OperationsSyncAttempt" SET status='FAILED', error=$3, "verifiedAt"=NULL,
              "processingToken"=NULL, "processingStartedAt"=NULL, "updatedAt"=now()
        WHERE "commandId"=$1 AND target='WEBSITE' AND "processingToken"=$2 AND status IN ('PENDING','FAILED')`, commandId, processingToken, reason,
    );
    if (affected !== 1 || !commands[0]) throw new Error("홈페이지 반영 충돌 상태를 저장하지 못했습니다.");
    await tx.$executeRawUnsafe(
      `INSERT INTO "OperationsAuditLog" (id,"requestId",action,"actorType","actorUserId","detailsJson")
       VALUES ($1,$2,'COMMAND_HELD','ADMIN',$3,$4::jsonb),
              ($5,$2,'SYNC_TARGET_FAILED','ADMIN',$3,$4::jsonb)`,
      crypto.randomUUID(), commands[0].requestId, actorUserId,
      JSON.stringify({ commandId, target: "WEBSITE", reason }), crypto.randomUUID(),
    );
  });
}

export async function recordOperationsExternalCheck(commandId: string, target: "RALLYZ", succeeded: boolean) {
  const admin = await requireAdmin();
  await ensureOperationsSyncInfrastructure();
  const sheet = await prisma.$queryRawUnsafe<Array<{ status: string; commandStatus: string; effectiveDate: string | null; parentConfirmed: boolean }>>(
    `SELECT a.status, c.status AS "commandStatus", c."afterJson"->>'effectiveDate' AS "effectiveDate",
            (c."afterJson"->>'parentConfirmed' = 'true') AS "parentConfirmed"
       FROM "OperationsSyncAttempt" a JOIN "OperationsCommand" c ON c.id=a."commandId"
      WHERE a."commandId"=$1 AND a.target='SHEET'`, commandId,
  );
  // 시트 선행 조건: 실제 반영(SUCCEEDED) 또는 시트 은퇴로 건너뜀(SKIPPED)이면 랠리즈 확인으로 넘어간다.
  if (!sheet[0] || !isSheetTargetDone(sheet[0].status)) throw new Error("구글 시트 반영과 재확인을 먼저 완료해 주세요.");
  if (!sheet[0].parentConfirmed || !sheet[0].effectiveDate) throw new Error("확정된 적용일이 없는 기존 요청은 랠리즈 반영을 확인할 수 없습니다.");
  if (sheet[0].effectiveDate > kstTodayYmd()) throw new Error(`적용일(${sheet[0].effectiveDate}) 이전에는 랠리즈 반영을 확인할 수 없습니다.`);
  if (sheet[0].commandStatus === "HELD") throw new Error("보류된 변경은 랠리즈 반영을 확인할 수 없습니다.");
  const changed = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRawUnsafe<Array<{ requestId: string; previousStatus: string }>>(
      `WITH candidate AS (
         SELECT a.id, a.status AS "previousStatus", c."requestId"
           FROM "OperationsSyncAttempt" a JOIN "OperationsCommand" c ON c.id=a."commandId"
          WHERE a."commandId"=$1 AND a.target=$2 AND a.status <> 'SUCCEEDED'
          FOR UPDATE OF a
       ), updated AS (
         UPDATE "OperationsSyncAttempt" a
            SET status=$3, attempts=a.attempts+1, error=CASE WHEN $3='FAILED' THEN '관리자가 랠리즈 반영 실패를 확인했습니다.' ELSE NULL END,
                "verifiedAt"=CASE WHEN $3='SUCCEEDED' THEN now() ELSE NULL END, "updatedAt"=now()
           FROM candidate WHERE a.id=candidate.id
         RETURNING candidate."requestId", candidate."previousStatus"
       ) SELECT * FROM updated`, commandId, target, succeeded ? "SUCCEEDED" : "FAILED",
    );
    if (!rows[0]) return false;
    const action = succeeded
      ? "SYNC_TARGET_SUCCEEDED"
      : rows[0].previousStatus === "FAILED" ? "SYNC_TARGET_RETRIED_FAILED" : "SYNC_TARGET_FAILED";
    await tx.$executeRawUnsafe(
      `INSERT INTO "OperationsAuditLog" (id,"requestId",action,"actorType","actorUserId","detailsJson")
       VALUES ($1,$2,$3,'ADMIN',$4,$5::jsonb)`,
      crypto.randomUUID(), rows[0].requestId, action, admin.appUserId, JSON.stringify({ commandId, target }),
    );
    return true;
  });
  if (!changed) {
    await refreshOperationsStatuses(commandId);
    return { ok: true as const, skipped: true as const };
  }
  await refreshOperationsStatuses(commandId);
  revalidatePath("/admin/operations-sync");
  return { ok: true as const, skipped: false as const };
}

export async function applyOperationsSheet(commandId: string) {
  const admin = await requireAdmin();
  await ensureOperationsSyncInfrastructure();
  const rows = await prisma.$queryRawUnsafe<Array<{
    id: string; studentName: string | null; studentId: string | null; kind: string; effectiveMonth: string;
    birthDate: Date | null; parentPhone: string | null; requestStatus: string; attemptStatus: string;
    commandStatus: string; effectiveDate: string | null; fromClassId: string | null; parentConfirmed: boolean;
    className: string | null; classDayOfWeek: string | null; classSlotKey: string | null;
  }>>(
    `SELECT c.id, c."studentName", c."studentId", c.kind, c."effectiveMonth", s."birthDate", c.status AS "commandStatus",
            u.phone AS "parentPhone", r.status AS "requestStatus", a.status AS "attemptStatus",
            c."afterJson"->>'effectiveDate' AS "effectiveDate", c."afterJson"->>'fromClassId' AS "fromClassId",
            (c."afterJson"->>'parentConfirmed' = 'true') AS "parentConfirmed",
            fc.name AS "className", fc."dayOfWeek" AS "classDayOfWeek", fc."slotKey" AS "classSlotKey"
       FROM "OperationsCommand" c
       JOIN "OperationsRequest" r ON r.id=c."requestId"
       JOIN "OperationsSyncAttempt" a ON a."commandId"=c.id AND a.target='SHEET'
       LEFT JOIN "Student" s ON s.id=c."studentId"
       LEFT JOIN "User" u ON u.id=s."parentId"
       LEFT JOIN "Class" fc ON fc.id=(c."afterJson"->>'fromClassId')
      WHERE c.id=$1`, commandId,
  );
  const row = rows[0];
  if (!row || !row.studentName || !row.studentId || !row.birthDate) throw new Error("학생 식별 정보를 확정할 수 없습니다.");
  if (!['APPROVED', 'PENDING', 'PARTIAL'].includes(row.requestStatus)) throw new Error("먼저 변경 계획을 승인해 주세요.");
  if (row.commandStatus === "HELD") throw new Error("보류된 변경은 시트에 반영할 수 없습니다.");
  if (!['PAUSE', 'WITHDRAW'].includes(row.kind)) throw new Error("이 변경 종류는 아직 시트 자동 반영을 지원하지 않습니다.");
  if (!row.parentConfirmed || !row.effectiveDate || !row.fromClassId || !row.className || !row.classDayOfWeek) throw new Error("확정된 적용일과 대상 수업이 없는 기존 요청은 자동 반영하지 않습니다.");
  if (row.effectiveDate > kstTodayYmd()) throw new Error(`적용일(${row.effectiveDate}) 이전에는 시트에 반영할 수 없습니다.`);
  // 이미 반영됐거나(SUCCEEDED) 시트 은퇴로 건너뛴(SKIPPED) 칸은 시트를 건드리지 않는다.
  if (isSheetTargetDone(row.attemptStatus)) {
    await refreshOperationsStatuses(commandId);
    return { ok: true as const, skipped: true };
  }

  const claim = await claimSyncAttempt(commandId, "SHEET", admin.appUserId);
  if (claim.skipped || !claim.token) {
    await refreshOperationsStatuses(commandId);
    return { ok: true as const, skipped: true };
  }

  let result: Awaited<ReturnType<typeof applySheetEnrollmentStatus>>;
  try {
    result = await applySheetEnrollmentStatus({
      commandId: row.id,
      studentName: row.studentName,
      birthDate: row.birthDate,
      parentPhone: row.parentPhone,
      targetMonth: row.effectiveMonth,
      kind: row.kind as "PAUSE" | "WITHDRAW",
      className: row.className,
      classDayOfWeek: row.classDayOfWeek,
      classSlotKey: row.classSlotKey,
    });
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : "구글 시트 반영 실패";
    const sharedStatusConflict = rawMessage.startsWith("SHEET_SHARED_STATUS_CONFLICT:");
    const message = rawMessage.replace(/^SHEET_SHARED_STATUS_CONFLICT:/, "");
    await finishSyncAttempt({ commandId, target: "SHEET", token: claim.token, actorUserId: admin.appUserId, succeeded: false, error: message });
    if (sharedStatusConflict) {
      await prisma.$transaction(async (tx) => {
        const changed = await tx.$queryRawUnsafe<Array<{ requestId: string }>>(
          `UPDATE "OperationsCommand" SET status='HELD', "holdReason"=$2, "updatedAt"=now()
            WHERE id=$1 AND status <> 'SYNCED' RETURNING "requestId"`, commandId, message.slice(0, 1000),
        );
        if (changed[0]) await tx.$executeRawUnsafe(
          `INSERT INTO "OperationsAuditLog" (id,"requestId",action,"actorType","actorUserId","detailsJson")
           VALUES ($1,$2,'COMMAND_HELD','ADMIN',$3,$4::jsonb)`,
          crypto.randomUUID(), changed[0].requestId, admin.appUserId, JSON.stringify({ commandId, target: "SHEET", reason: message.slice(0, 1000) }),
        );
      });
    }
    await refreshOperationsStatuses(commandId);
    throw new Error(message);
  }
  await finishSyncAttempt({
    commandId, target: "SHEET", token: claim.token, actorUserId: admin.appUserId, succeeded: true,
    externalReference: `${result.spreadsheetId}:${result.rows.join(",")}`,
  });
  await refreshOperationsStatuses(commandId);
  revalidatePath("/admin/operations-sync");
  return { ok: true as const, skipped: false };
}

/**
 * 「시트 직접 수정 완료」 수동 확인.
 * 시트 행 없음·학생 식별 불가·공통 상태 충돌처럼 자동 시트 반영이 끝내 안 되는 건은
 * 원장이 구글 시트를 직접 고친 뒤 이 확인으로 SHEET 를 SUCCEEDED 로 기록한다.
 * - 사이트(WEBSITE) 반영이 이미 끝난 휴원·퇴원·복귀 건만 허용한다(사이트 반영 전 건은 기존 순서를 지킨다).
 * - 시트 사유로 보류(HELD)된 명령은 보류를 풀어 랠리즈 확인 → SYNCED 로 이어지게 한다.
 * - 누가·언제·"수동 확인"·직전 상태/사유를 감사기록에 남긴다(거래 안에서 함께 커밋).
 */
export async function recordOperationsSheetManualCheck(commandId: string) {
  const admin = await requireAdmin();
  await ensureOperationsSyncInfrastructure();
  const result = await prisma.$transaction(async (tx) => {
    // 명령 행을 잠가 자동 시트 반영·랠리즈 확인과 동시에 상태를 바꾸지 못하게 한다.
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

    const attempts = await tx.$queryRawUnsafe<Array<{ target: string; status: string; error: string | null; processing: boolean }>>(
      `SELECT target, status, error,
              ("processingToken" IS NOT NULL AND "processingStartedAt" >= now() - interval '10 minutes') AS processing
         FROM "OperationsSyncAttempt" WHERE "commandId"=$1 FOR UPDATE`, commandId,
    );
    const website = attempts.find((item) => item.target === "WEBSITE");
    const sheet = attempts.find((item) => item.target === "SHEET");
    // 사이트가 먼저 반영된 자동 적용 건만 대상이다. 사이트 반영 충돌 등 다른 이유의 보류는 여기서 풀지 않는다.
    if (website?.status !== "SUCCEEDED") throw new Error("사이트 반영이 끝난 건만 시트 수동 확인을 할 수 있습니다.");
    if (!sheet) throw new Error("시트 반영 기록을 찾을 수 없습니다.");
    // 시트 은퇴로 건너뛴 칸(SKIPPED)은 시트를 고칠 일이 없다 → 시트 칸은 절대 건드리지 않는다.
    if (sheet.status === "SKIPPED") {
      if (command.status !== "HELD") return { changed: false };
      // 단, 복귀(RESUME) 어댑터 미지원 보류는 시트 때문에 걸린 보류라, 은퇴 후엔 풀어 줘야 랠리즈 확인으로 끝난다.
      // 같은 판정 함수를 거친다 → 학생 미확정·신청 미연결·정책 보류는 그대로 거부(시트 충돌 분기는 FAILED 조건이라 해당 없음).
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
    }
    if (sheet.status === "SUCCEEDED" && command.status !== "HELD") return { changed: false };
    if (sheet.processing) throw new Error("시트 자동 반영이 진행 중입니다. 잠시 후 상태를 다시 확인해 주세요.");
    // 보류(HELD)는 원인이 시트 쪽일 때만 푼다(시트 충돌·복귀 어댑터 미지원). 정책 보류는 사람 확인 신호를 지우지 않는다.
    if (command.status === "HELD") {
      const decision = sheetHoldReleaseDecision({
        kind: command.kind, studentId: command.studentId, enrollmentChangeRequestId: command.enrollmentChangeRequestId,
        holdReason: command.holdReason, sheetStatus: sheet.status, sheetError: sheet.error,
      });
      if (!decision.ok) throw new Error(decision.reason);
    }

    // 수동 확인 = 사람이 시트를 직접 고쳤다는 증거. verifiedAt 을 채워야 SYNCED 집계 조건을 만족한다.
    await tx.$executeRawUnsafe(
      `UPDATE "OperationsSyncAttempt"
          SET status='SUCCEEDED', "verifiedAt"=COALESCE("verifiedAt", now()), error=NULL,
              "externalReference"=$2, "processingToken"=NULL, "processingStartedAt"=NULL, "updatedAt"=now()
        WHERE "commandId"=$1 AND target='SHEET'`,
      commandId, `MANUAL:${admin.appUserId}`,
    );
    // 위 판정을 통과한(시트 때문에 보류된) 명령만 보류를 풀어 랠리즈 확인이 가능하게 한다(사유는 감사기록에 보존).
    if (command.status === "HELD") {
      await tx.$executeRawUnsafe(
        `UPDATE "OperationsCommand" SET status='PENDING', "holdReason"=NULL, "updatedAt"=now() WHERE id=$1`, commandId,
      );
    }
    await tx.$executeRawUnsafe(
      `INSERT INTO "OperationsAuditLog" (id,"requestId",action,"actorType","actorUserId","detailsJson")
       VALUES ($1,$2,'SYNC_TARGET_MANUALLY_CONFIRMED','ADMIN',$3,$4::jsonb)`,
      crypto.randomUUID(), command.requestId, admin.appUserId,
      JSON.stringify({
        commandId, target: "SHEET", manual: true, note: "수동 확인: 관리자가 구글 시트를 직접 수정",
        previousSheetStatus: sheet.status, previousSheetError: sheet.error?.slice(0, 1000) ?? null,
        previousCommandStatus: command.status, previousHoldReason: command.holdReason,
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
