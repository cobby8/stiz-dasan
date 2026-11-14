"use server";

/**
 * 학생 상세 «수강 반» 줄 ⋯ 메뉴의 서버 동작 — 반 이동 · 잘못 등록한 수강 삭제 (2026-11-09 원장 지시)
 *
 * - 판정은 @/lib/enrollment/admin-enrollment-edit 의 순수 함수 한 곳(테스트가 실행해 확인).
 * - 반 이동은 관리자 즉시 상태 변경(updateEnrollmentStatus)·수강 등록(enrollStudent)과 같은 기록 방식을 쓴다:
 *   수강 변경 이력(EnrollmentChangeRequest, kind=CLASS_CHANGE, APPLIED) + 운영 동기화 원장(웹사이트 이벤트)을 같은 트랜잭션에.
 *   그래서 «수강 변경 신청» 화면(학부모 반 변경 신청과 같은 표)에 이력이 남고, 시트·랠리즈 확인 칸도 기존대로 생긴다.
 * - 삭제는 연결 기록을 서버가 트랜잭션 안에서 다시 센 뒤에만 지운다.
 */
import { revalidatePath, revalidateTag } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-guard";
import { todayKst } from "@/lib/datetime/kst";
import { lockCompensation } from "@/lib/billing/absence-compensation-guard";
import { notMergedStudent } from "@/lib/studentVisibility";
import { buildEnrollmentOperationsEvent } from "@/lib/operations-events/admin-hooks";
import { enqueueWebsiteOperationsEventInTransaction } from "@/lib/operations-events";
import {
  closeAddCommandsForDeletedEnrollment,
  enrollmentDeleteBlockedMessage,
  enrollmentDeleteBlockers,
  planEnrollmentMove,
  readEnrollmentLinkCounts,
} from "@/lib/enrollment/admin-enrollment-edit";
// 반 이동 뒤 정리(처리 중 신청·옛 반의 결석·보강권·미납 안내) — 관리자 상태 변경(updateEnrollmentStatus)과 같은 부품
import {
  askConfirmed,
  blockedRequestsMessage,
  cleanupEndedClassInTx,
  emptyCleanupSummary,
  openRequestsMessage,
  openRequestViews,
  planOpenChangeRequests,
  readOpenChangeRequestsForUpdate,
  supersedeChangeRequests,
  supersedeNote,
  type EnrollmentEndCleanupSummary,
  type OpenRequestView,
} from "@/lib/enrollment/enrollment-end-cleanup";

type EnrollmentStatus = "ACTIVE" | "PAUSED" | "WITHDRAWN";

/** 화면에 그대로 보여 줄 안내(사용자 오류)와 내부 오류를 구분한다 */
class EnrollmentEditError extends Error {
  constructor(message: string, readonly code: "INVALID" | "OVER_CAPACITY" = "INVALID") { super(message); }
}

function revalidateEnrollmentViews(studentId: string | null, classIds: string[]) {
  revalidatePath("/admin/students");
  if (studentId) revalidatePath(`/admin/students/${studentId}`);
  revalidatePath("/admin/classes");
  for (const id of classIds) revalidatePath(`/admin/classes/${id}`);
  // admin.ts 의 학생·반·수납 캐시 무효화와 같은 태그
  for (const tag of ["admin-classes", "admin-students", "admin-student-options", "admin-apply", "admin-waitlist", "admin-makeup", "admin-dashboard", "admin-finance", "admin-stats"]) {
    revalidateTag(tag, { expire: 0 });
  }
}

export type MoveEnrollmentResult =
  | { ok: true; newEnrollmentId: string; newStartsOn: string; cleanup: EnrollmentEndCleanupSummary }
  | { ok: false; code: "INVALID" | "OVER_CAPACITY"; message: string }
  // 처리 중 신청 — OPEN_REQUESTS 는 보여 준 신청 id 목록(closeOpenRequests)으로 다시 보내면 함께 닫고, BLOCKED_REQUESTS 는 신청함에서 먼저 처리
  | { ok: false; code: "OPEN_REQUESTS" | "BLOCKED_REQUESTS"; message: string; requests: OpenRequestView[] };

/** 확인이 필요한 신청 목록을 들고 트랜잭션을 빠져나오는 표식(아직 아무것도 쓰지 않은 시점에만 던진다) */
class OpenRequestsStop extends Error {
  constructor(readonly code: "OPEN_REQUESTS" | "BLOCKED_REQUESTS", message: string, readonly requests: OpenRequestView[]) { super(message); }
}

/** 반 이동: 기존 수강은 적용일로 수강 종료, 새 반 수강을 같은 조건으로 생성 */
export async function moveEnrollmentToClass(input: {
  enrollmentId: string;
  toClassId: string;
  effectiveFrom?: string;
  reason?: string;
  allowOverCapacity?: boolean;
  /** 확인창에서 «함께 정리하고 저장»을 눌렀을 때 화면에 보여 준 신청 id 목록(서버가 다시 읽은 대상과 같아야 진행) */
  closeOpenRequests?: string[];
}): Promise<MoveEnrollmentResult> {
  const admin = await requireAdmin();
  const today = todayKst();
  const effectiveDate = input.effectiveFrom?.trim() || today;
  let studentId: string | null = null;
  let fromClassId: string | null = null;
  try {
    const result = await prisma.$transaction(async (tx) => {
      // 0) 잠금 순서: 청구 정산 전역 잠금 → 처리 중 신청 → 수강(적용일 크론·휴원 정산과 같은 순서)
      await lockCompensation(tx);
      const openRequests = await readOpenChangeRequestsForUpdate(tx, input.enrollmentId);
      // 1) 기존 수강·대상 반·대상 반의 기존 수강을 잠그고 다시 읽는다(화면 값 믿지 않음)
      const [from] = await tx.$queryRawUnsafe<Array<{
        studentId: string; classId: string; status: EnrollmentStatus; startsOn: string | null; createdYmd: string | null; studentName: string; className: string;
      }>>(
        // createdAt 은 시간대 없는 timestamp 라 두 번 건다(UTC 로 읽고 → KST 날짜)
        `SELECT e."studentId", e."classId", e.status, e."startsOn"::text AS "startsOn",
                ((e."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Seoul')::date::text AS "createdYmd",
                s.name AS "studentName", c.name AS "className"
           FROM "Enrollment" e JOIN "Student" s ON s.id = e."studentId" JOIN "Class" c ON c.id = e."classId"
          WHERE e.id = $1 AND ${notMergedStudent("s")} FOR UPDATE OF e`,
        input.enrollmentId,
      );
      if (!from) throw new EnrollmentEditError("수강 정보를 찾을 수 없어요. 화면을 새로고침해 주세요.");
      studentId = from.studentId;
      fromClassId = from.classId;
      const [target] = await tx.$queryRawUnsafe<Array<{
        id: string; name: string; capacity: number; activeCount: number; deleted: boolean; seasonal: boolean;
      }>>(
        `SELECT c.id, c.name, c.capacity, (p."deletedAt" IS NOT NULL) AS deleted, (c."dayOfWeek" = 'Seasonal') AS seasonal,
                (SELECT COUNT(*) FROM "Enrollment" e JOIN "Student" s ON s.id = e."studentId"
                  WHERE e."classId" = c.id AND e.status = 'ACTIVE' AND ${notMergedStudent("s")})::int AS "activeCount"
           FROM "Class" c JOIN "Program" p ON p.id = c."programId"
          WHERE c.id = $1 FOR UPDATE OF c`,
        input.toClassId,
      );
      const [existing] = await tx.$queryRawUnsafe<Array<{ id: string; status: EnrollmentStatus }>>(
        `SELECT id, status FROM "Enrollment" WHERE "studentId" = $1 AND "classId" = $2 FOR UPDATE`,
        from.studentId, input.toClassId,
      );
      // 2) 판정(순수 함수 한 곳) — 먼저 신청을 빼고 이동 자체가 되는지 본다(정원·반 오류를 신청 확인보다 먼저 알린다)
      const precheck = planEnrollmentMove({
        from, target: target ?? null, targetExistingStatus: existing?.status ?? null, openChangeRequests: 0,
        effectiveDate, today, allowOverCapacity: input.allowOverCapacity,
      });
      if (!precheck.ok) throw new EnrollmentEditError(precheck.message, precheck.code);
      // 처리 중 신청: 같은 반으로 가는 승인 건은 닫고, 나머지는 확인을 받고, 돈·반영이 걸린 건은 막는다(아직 아무것도 안 썼다)
      const action = { type: "MOVE" as const, toClassId: input.toClassId };
      const requestPlan = planOpenChangeRequests(openRequests, action);
      if (requestPlan.block.length) throw new OpenRequestsStop("BLOCKED_REQUESTS", blockedRequestsMessage(requestPlan.block.length), openRequestViews(requestPlan.block));
      // 확인창에서 본 신청과 지금 닫을 대상이 정확히 같을 때만 진행(그 사이 바뀌었으면 아무것도 쓰지 않고 다시 묻는다)
      if (!askConfirmed(requestPlan.ask, input.closeOpenRequests)) {
        throw new OpenRequestsStop("OPEN_REQUESTS", openRequestsMessage(requestPlan.ask.length, Boolean(input.closeOpenRequests?.length)), openRequestViews(requestPlan.ask));
      }
      const cleanup = emptyCleanupSummary();
      cleanup.supersededRequests = await supersedeChangeRequests(tx, [...requestPlan.supersede, ...requestPlan.ask], {
        enrollmentId: input.enrollmentId, actorUserId: admin.appUserId,
        note: supersedeNote(action, today, requestPlan.ask.length > 0), confirmed: requestPlan.ask.length > 0,
      });
      // 처리 중 수강 변경 신청 수 — 삭제 차단과 같은 조회(readEnrollmentLinkCounts)로 다시 센다(위에서 닫은 뒤라 남은 게 있으면 막힌다)
      const links = await readEnrollmentLinkCounts(tx, { enrollmentId: input.enrollmentId, studentId: from.studentId, classId: from.classId });
      const plan = planEnrollmentMove({
        from, target: target ?? null, targetExistingStatus: existing?.status ?? null, openChangeRequests: links.openChangeRequests,
        effectiveDate, today, allowOverCapacity: input.allowOverCapacity,
      });
      if (!plan.ok) throw new EnrollmentEditError(plan.message, plan.code);
      const reason = input.reason?.trim() || `관리자 반 이동: ${from.className} → ${target!.name}`;

      // 3) 기존 수강 종료(기대 상태일 때만 — 그 사이 바뀌었으면 거래 전체 취소)
      const [ended] = await tx.$queryRawUnsafe<Array<{ updatedAt: Date }>>(
        `UPDATE "Enrollment" SET status = 'WITHDRAWN', "updatedAt" = NOW() WHERE id = $1 AND status = 'ACTIVE' RETURNING "updatedAt"`,
        input.enrollmentId,
      );
      if (!ended) throw new EnrollmentEditError("그 사이 수강 상태가 바뀌었어요. 새로고침 후 다시 해 주세요.");

      // 4) 수강 변경 이력 — 학부모 반 변경 신청과 같은 표·같은 종류(CLASS_CHANGE), 관리자 즉시 적용이라 APPLIED
      const [history] = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `INSERT INTO "EnrollmentChangeRequest" (
            id, "studentId", "enrollmentId", "fromClassId", "toClassId", kind, "effectiveFrom", reason,
            status, "requestedByUserId", "decidedByUserId", "decidedAt", "appliedAt", "createdAt", "updatedAt"
         ) VALUES (
            gen_random_uuid()::text, $1, $2, $3, $4, 'CLASS_CHANGE', $5::date, $6,
            'APPLIED', $7, $7, NOW(), NOW(), NOW(), NOW()
         ) RETURNING id`,
        from.studentId, input.enrollmentId, from.classId, target!.id, effectiveDate, reason, admin.appUserId,
      );

      // 5) 새 반 수강 — 같은 조건(ACTIVE + 개시일). 예전에 그 반을 그만둔 기록이 있으면 그 행을 되살린다(학생·반 유일 제약)
      const [created] = await tx.$queryRawUnsafe<Array<{ id: string; updatedAt: Date }>>(
        `INSERT INTO "Enrollment" (id, "studentId", "classId", status, "startsOn", "createdAt", "updatedAt")
         VALUES (gen_random_uuid()::text, $1, $2, 'ACTIVE', $3::date, NOW(), NOW())
         ON CONFLICT ("studentId", "classId") DO UPDATE SET status = 'ACTIVE', "startsOn" = EXCLUDED."startsOn", "updatedAt" = NOW()
         RETURNING id, "updatedAt"`,
        from.studentId, target!.id, plan.newStartsOn,
      );

      // 6) 운영 동기화 원장 — 기존 반 종료 + 새 반 등록 두 건(관리자 상태 변경·수강 등록과 같은 이벤트)
      const endEvent = buildEnrollmentOperationsEvent({
        enrollmentId: input.enrollmentId, changedAt: ended.updatedAt, actorUserId: admin.appUserId,
        studentId: from.studentId, studentName: from.studentName, classId: from.classId, className: from.className,
        previousStatus: "ACTIVE", nextStatus: "WITHDRAWN", effectiveDate, enrollmentChangeRequestId: history?.id,
      });
      if (endEvent) await enqueueWebsiteOperationsEventInTransaction(tx, endEvent);
      const startEvent = buildEnrollmentOperationsEvent({
        enrollmentId: created.id, changedAt: created.updatedAt, actorUserId: admin.appUserId,
        studentId: from.studentId, studentName: from.studentName, classId: target!.id, className: target!.name,
        previousStatus: existing?.status ?? null, nextStatus: "ACTIVE", effectiveDate: plan.newStartsOn,
        enrollmentChangeRequestId: history?.id,
      });
      if (startEvent) await enqueueWebsiteOperationsEventInTransaction(tx, startEvent);

      // 7) 옛 반의 이동 적용일(포함) 이후 결석·보강권 정리 + 미납 청구 안내(같은 트랜잭션)
      const endedClass = await cleanupEndedClassInTx(tx, {
        studentId: from.studentId, classId: from.classId, className: from.className, fromYmd: effectiveDate, actorUserId: admin.appUserId,
      });
      Object.assign(cleanup, endedClass);
      return { ok: true as const, newEnrollmentId: created.id, newStartsOn: plan.newStartsOn, cleanup };
    });
    revalidateEnrollmentViews(studentId, [fromClassId, input.toClassId].filter(Boolean) as string[]);
    revalidatePath("/admin/enrollment-changes");
    revalidatePath("/admin/absence");
    return result;
  } catch (e) {
    if (e instanceof OpenRequestsStop) return { ok: false, code: e.code, message: e.message, requests: e.requests };
    if (e instanceof EnrollmentEditError) return { ok: false, code: e.code, message: e.message };
    console.error("Failed to move enrollment:", e);
    return { ok: false, code: "INVALID", message: "반 이동에 실패했어요. 잠시 후 다시 해 주세요." };
  }
}

export type RemoveEnrollmentResult = { ok: true; alreadySyncedTargets: string[] } | { ok: false; message: string };

/** 잘못 등록한 수강 삭제 — 출석·청구·보강 연결이 하나도 없을 때만 */
export async function removeMistakenEnrollment(enrollmentId: string): Promise<RemoveEnrollmentResult> {
  const admin = await requireAdmin();
  let studentId: string | null = null;
  let classId: string | null = null;
  let closedCommandIds: string[] = [];
  let alreadySyncedTargets: string[] = [];
  try {
    await prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRawUnsafe<Array<{ studentId: string; classId: string; status: string; studentName: string; className: string }>>(
        `SELECT e."studentId", e."classId", e.status, s.name AS "studentName", c.name AS "className"
           FROM "Enrollment" e JOIN "Student" s ON s.id = e."studentId" JOIN "Class" c ON c.id = e."classId"
          WHERE e.id = $1 AND ${notMergedStudent("s")} FOR UPDATE OF e`,
        enrollmentId,
      );
      if (!row) throw new EnrollmentEditError("수강 정보를 찾을 수 없어요. 화면을 새로고침해 주세요.");
      studentId = row.studentId;
      classId = row.classId;
      // 화면이 미리 확인했어도 서버가 트랜잭션 안에서 다시 센다(그 사이 출석이 찍혔을 수 있다)
      const blockers = enrollmentDeleteBlockers(await readEnrollmentLinkCounts(tx, { enrollmentId, studentId: row.studentId, classId: row.classId }));
      if (blockers.length > 0) throw new EnrollmentEditError(enrollmentDeleteBlockedMessage(blockers));
      // 끝난(적용·반려·취소) 수강 변경 이력은 반 스냅샷(fromClassId)을 남긴 채 연결만 끊는다 — 이력은 지우지 않는다
      await tx.$executeRawUnsafe(`UPDATE "EnrollmentChangeRequest" SET "enrollmentId" = NULL, "updatedAt" = NOW() WHERE "enrollmentId" = $1`, enrollmentId);
      // 그 수강을 가리키는 열린 «등록» 운영 원장(시트·랠리즈 추가 확인 칸)을 닫아 직원 확인 목록에서 뺀다(같은 트랜잭션)
      const closed = await closeAddCommandsForDeletedEnrollment(tx, { enrollmentId, actorUserId: admin.appUserId });
      closedCommandIds = closed.commandIds;
      alreadySyncedTargets = closed.alreadySynced.map((a) => a.target);
      const deleted = await tx.$executeRawUnsafe(`DELETE FROM "Enrollment" WHERE id = $1`, enrollmentId);
      if (deleted !== 1) throw new EnrollmentEditError("그 사이 수강 정보가 바뀌었어요. 새로고침 후 다시 해 주세요.");
      // 누가 무엇을 지웠는지 감사 기록(되살릴 때 근거)
      await tx.$executeRawUnsafe(
        `INSERT INTO "OperationsAuditLog" (id, action, "actorType", "actorUserId", "detailsJson")
         VALUES (gen_random_uuid()::text, 'ENROLLMENT_DELETED_MISTAKE', 'ADMIN', $1, $2::jsonb)`,
        admin.appUserId,
        JSON.stringify({ enrollmentId, studentId: row.studentId, studentName: row.studentName, classId: row.classId, className: row.className, status: row.status,
          closedCommandIds, alreadySyncedTargets }),
      );
    });
    revalidateEnrollmentViews(studentId, classId ? [classId] : []);
    revalidatePath("/admin/enrollment-changes");
    // 이미 시트·랠리즈에 반영된 칸이 있었으면 화면이 «직접 정리» 안내를 띄운다
    return { ok: true, alreadySyncedTargets: [...new Set(alreadySyncedTargets)] };
  } catch (e) {
    if (e instanceof EnrollmentEditError) return { ok: false, message: e.message };
    console.error("Failed to remove enrollment:", e);
    return { ok: false, message: "수강 삭제에 실패했어요. 잠시 후 다시 해 주세요." };
  }
}
