import type { Prisma } from "@prisma/client";

import { todayKst } from "@/lib/datetime/kst";
import { CLASS_ADD_KIND, planClassAddApproval } from "@/lib/enrollment/classAddRules";
import { buildEnrollmentOperationsEvent } from "@/lib/operations-events/admin-hooks";
import { enqueueWebsiteOperationsEventInTransaction } from "@/lib/operations-events";
import { notMergedStudent } from "@/lib/studentVisibility";

// ── 원장의 «반 추가» 승인 = 그 자리에서 수강 등록(2026-11-14 결정표 c8) ─────────────
//
// 휴원·퇴원·반 변경은 «승인 = 예약 → 적용일에 반영»이지만, 반 추가는 떠나는 반이 없어 기다릴 것이 없다.
// 승인하는 순간 관리자 수강 등록(enrollStudent)·수강 신청 승인과 «같은 모양»의 수강 행을 만든다:
//   Enrollment(ACTIVE, startsOn = 신청한 시작일) + 운영 원장 «수강 등록»(CLASS_ADD) 한 건.
// 수강료는 따로 손대지 않는다 — 청구 준비가 수강 행의 개시일(startsOn)을 보고 달 중간 시작을 계산한다(기존 등록과 같다).
//
// 승인(decideEnrollmentChangeRequest)과 같은 트랜잭션에서 부른다. 막히면(정원·없는 반) 승인까지 되돌려
// 신청이 «검토 중»으로 남는다 = 대기.

type EnrollmentStatus = "ACTIVE" | "PAUSED" | "WITHDRAWN";

export type ClassAddApplyResult =
  | { ok: true; created: boolean; enrollmentId: string | null; startsOn: string | null; studentId: string; classId: string }
  | { ok: false; message: string };

export async function applyApprovedClassAddInTx(
  tx: Prisma.TransactionClient,
  input: { requestId: string; adminUserId: string },
): Promise<ClassAddApplyResult> {
  // 신청·학생을 잠그고 다시 읽는다(화면 값 믿지 않음). 방금 승인으로 바뀐 행만 대상.
  const [request] = await tx.$queryRawUnsafe<Array<{
    studentId: string; studentName: string; toClassId: string | null; effectiveFrom: string;
  }>>(
    `SELECT r."studentId", s.name AS "studentName", r."toClassId",
            to_char(r."effectiveFrom",'YYYY-MM-DD') AS "effectiveFrom"
       FROM "EnrollmentChangeRequest" r
       JOIN "Student" s ON s.id = r."studentId" AND ${notMergedStudent("s")}
      WHERE r.id = $1 AND r.kind = '${CLASS_ADD_KIND}' AND r.status = 'APPROVED' AND r."appliedAt" IS NULL
      FOR UPDATE OF r, s`,
    input.requestId,
  );
  if (!request) return { ok: false, message: "반 추가 신청을 찾을 수 없어요. 새로고침해 주세요." };
  if (!request.toClassId) return { ok: false, message: "추가할 반이 비어 있는 신청이에요. 거절하고 다시 신청받아 주세요." };

  // 대상 반을 잠그고 정원을 «지금» 다시 센다(병합된 학생은 세지 않는다 — 관리자 반 이동과 같은 셈)
  const [target] = await tx.$queryRawUnsafe<Array<{
    id: string; name: string; capacity: number; activeCount: number; deleted: boolean; seasonal: boolean;
  }>>(
    `SELECT c.id, c.name, c.capacity, (p."deletedAt" IS NOT NULL) AS deleted, (c."dayOfWeek" = 'Seasonal') AS seasonal,
            (SELECT COUNT(*) FROM "Enrollment" e JOIN "Student" s ON s.id = e."studentId"
              WHERE e."classId" = c.id AND e.status = 'ACTIVE' AND ${notMergedStudent("s")})::int AS "activeCount"
       FROM "Class" c JOIN "Program" p ON p.id = c."programId"
      WHERE c.id = $1 FOR UPDATE OF c`,
    request.toClassId,
  );
  const [existing] = await tx.$queryRawUnsafe<Array<{ id: string; status: EnrollmentStatus }>>(
    `SELECT id, status FROM "Enrollment" WHERE "studentId" = $1 AND "classId" = $2 FOR UPDATE`,
    request.studentId, request.toClassId,
  );

  const plan = planClassAddApproval({
    target: target ?? null, existingStatus: existing?.status ?? null,
    effectiveFrom: request.effectiveFrom, today: todayKst(),
  });
  if (plan.action === "BLOCK") return { ok: false, message: plan.message };

  let enrollmentId: string | null = existing?.id ?? null;
  let startsOn: string | null = null;
  if (plan.action === "CREATE") {
    // 예전에 그 반을 그만둔 기록(WITHDRAWN)이 있으면 그 행을 되살린다(학생·반 유일 제약) — 개시일은 새 시작일로.
    const [created] = await tx.$queryRawUnsafe<Array<{ id: string; updatedAt: Date }>>(
      `INSERT INTO "Enrollment" (id, "studentId", "classId", status, "startsOn", "createdAt", "updatedAt")
       VALUES (gen_random_uuid()::text, $1, $2, 'ACTIVE', $3::date, NOW(), NOW())
       ON CONFLICT ("studentId", "classId") DO UPDATE SET status = 'ACTIVE', "startsOn" = EXCLUDED."startsOn", "updatedAt" = NOW()
       RETURNING id, "updatedAt"`,
      request.studentId, target!.id, plan.startsOn,
    );
    enrollmentId = created.id;
    startsOn = plan.startsOn;
    // 운영 원장 — 관리자 수강 등록과 같은 이벤트(새 수강 = «수강 등록», 되살리기 = «수강 복귀»). 이 신청과 연결해 둔다.
    const event = buildEnrollmentOperationsEvent({
      enrollmentId: created.id, changedAt: created.updatedAt, actorUserId: input.adminUserId,
      studentId: request.studentId, studentName: request.studentName, classId: target!.id, className: target!.name,
      previousStatus: existing?.status ?? null, nextStatus: "ACTIVE", effectiveDate: plan.startsOn,
      enrollmentChangeRequestId: input.requestId,
    });
    if (event) await enqueueWebsiteOperationsEventInTransaction(tx, event);
  }

  // 사이트 반영 완료 = APPLIED + appliedAt(관리자 즉시 변경과 같은 뜻). 적용일 크론은 APPROVED 만 집으므로 다시 건드리지 않는다.
  const marked = await tx.$executeRawUnsafe(
    `UPDATE "EnrollmentChangeRequest" SET status = 'APPLIED', "appliedAt" = now(), "updatedAt" = now()
      WHERE id = $1 AND status = 'APPROVED' AND "appliedAt" IS NULL`,
    input.requestId,
  );
  if (Number(marked) !== 1) return { ok: false, message: "그 사이 신청 상태가 바뀌었어요. 새로고침 후 다시 해 주세요." };
  return { ok: true, created: plan.action === "CREATE", enrollmentId, startsOn, studentId: request.studentId, classId: request.toClassId };
}
