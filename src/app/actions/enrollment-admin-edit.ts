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
import { notMergedStudent } from "@/lib/studentVisibility";
import { buildEnrollmentOperationsEvent } from "@/lib/operations-events/admin-hooks";
import { enqueueWebsiteOperationsEventInTransaction } from "@/lib/operations-events";
import {
  enrollmentDeleteBlockedMessage,
  enrollmentDeleteBlockers,
  planEnrollmentMove,
  readEnrollmentLinkCounts,
} from "@/lib/enrollment/admin-enrollment-edit";

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
  | { ok: true; newEnrollmentId: string; newStartsOn: string }
  | { ok: false; code: "INVALID" | "OVER_CAPACITY"; message: string };

/** 반 이동: 기존 수강은 적용일로 수강 종료, 새 반 수강을 같은 조건으로 생성 */
export async function moveEnrollmentToClass(input: {
  enrollmentId: string;
  toClassId: string;
  effectiveFrom?: string;
  reason?: string;
  allowOverCapacity?: boolean;
}): Promise<MoveEnrollmentResult> {
  const admin = await requireAdmin();
  const today = todayKst();
  const effectiveDate = input.effectiveFrom?.trim() || today;
  let studentId: string | null = null;
  let fromClassId: string | null = null;
  try {
    const result = await prisma.$transaction(async (tx) => {
      // 1) 기존 수강·대상 반·대상 반의 기존 수강을 잠그고 다시 읽는다(화면 값 믿지 않음)
      const [from] = await tx.$queryRawUnsafe<Array<{
        studentId: string; classId: string; status: EnrollmentStatus; startsOn: string | null; studentName: string; className: string;
      }>>(
        `SELECT e."studentId", e."classId", e.status, e."startsOn"::text AS "startsOn", s.name AS "studentName", c.name AS "className"
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
      // 2) 판정(순수 함수 한 곳)
      const plan = planEnrollmentMove({
        from, target: target ?? null, targetExistingStatus: existing?.status ?? null,
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
      return { ok: true as const, newEnrollmentId: created.id, newStartsOn: plan.newStartsOn };
    });
    revalidateEnrollmentViews(studentId, [fromClassId, input.toClassId].filter(Boolean) as string[]);
    return result;
  } catch (e) {
    if (e instanceof EnrollmentEditError) return { ok: false, code: e.code, message: e.message };
    console.error("Failed to move enrollment:", e);
    return { ok: false, code: "INVALID", message: "반 이동에 실패했어요. 잠시 후 다시 해 주세요." };
  }
}

export type RemoveEnrollmentResult = { ok: true } | { ok: false; message: string };

/** 잘못 등록한 수강 삭제 — 출석·청구·보강 연결이 하나도 없을 때만 */
export async function removeMistakenEnrollment(enrollmentId: string): Promise<RemoveEnrollmentResult> {
  const admin = await requireAdmin();
  let studentId: string | null = null;
  let classId: string | null = null;
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
      const deleted = await tx.$executeRawUnsafe(`DELETE FROM "Enrollment" WHERE id = $1`, enrollmentId);
      if (deleted !== 1) throw new EnrollmentEditError("그 사이 수강 정보가 바뀌었어요. 새로고침 후 다시 해 주세요.");
      // 누가 무엇을 지웠는지 감사 기록(되살릴 때 근거)
      await tx.$executeRawUnsafe(
        `INSERT INTO "OperationsAuditLog" (id, action, "actorType", "actorUserId", "detailsJson")
         VALUES (gen_random_uuid()::text, 'ENROLLMENT_DELETED_MISTAKE', 'ADMIN', $1, $2::jsonb)`,
        admin.appUserId,
        JSON.stringify({ enrollmentId, studentId: row.studentId, studentName: row.studentName, classId: row.classId, className: row.className, status: row.status }),
      );
    });
    revalidateEnrollmentViews(studentId, classId ? [classId] : []);
    return { ok: true };
  } catch (e) {
    if (e instanceof EnrollmentEditError) return { ok: false, message: e.message };
    console.error("Failed to remove enrollment:", e);
    return { ok: false, message: "수강 삭제에 실패했어요. 잠시 후 다시 해 주세요." };
  }
}
