import { prisma } from "@/lib/prisma";
import type { ParentRequestKind } from "@/lib/kakao-chatbot-contract";
import { reportRegularAbsence } from "@/lib/regular/parent-regular-absence";
import { submitShuttleException } from "@/lib/shuttle/parent-shuttle-exception";

type Structured = Record<string, unknown>;

type ClaimedIntake = {
  id: string;
  kind: ParentRequestKind;
  studentId: string | null;
  parentUserId: string;
  structuredJson: Structured | null;
};

export type IntakeRoutingResult = {
  claimed: number;
  applied: number;
  held: number;
  failed: number;
};

const AUTO_KINDS = new Set<ParentRequestKind>([
  "REGULAR_ABSENCE",
  "SHUTTLE_SKIP",
  "SHUTTLE_LOCATION",
]);

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function routingResult(input: {
  mode: "AUTO" | "APPROVAL";
  reason: string;
  admin: string;
  coach: string;
  driver: string;
}) {
  return {
    mode: input.mode,
    reason: input.reason,
    deliveries: {
      admin: { target: "ADMIN_AND_VICE_ADMIN", status: input.admin },
      coach: { target: "ASSIGNED_CLASS_COACH", status: input.coach },
      driver: { target: "SHUTTLE_DRIVER", status: input.driver },
    },
    routedAt: new Date().toISOString(),
  };
}

async function claimSubmittedIntakes(limit: number): Promise<ClaimedIntake[]> {
  return prisma.$queryRawUnsafe<ClaimedIntake[]>(
    `WITH candidates AS (
       SELECT r.id
         FROM "KakaoParentIntake" r
         JOIN "KakaoParentIdentity" i ON i.id = r."identityId"
        WHERE i.status = 'ACTIVE' AND i."parentUserId" IS NOT NULL
          AND r.status = 'SUBMITTED'
        ORDER BY r."createdAt"
        FOR UPDATE SKIP LOCKED
        LIMIT $1
     ), claimed AS (
       UPDATE "KakaoParentIntake" r
          SET status = 'PROCESSING', "updatedAt" = now()
         FROM candidates c
        WHERE r.id = c.id
       RETURNING r.id, r.kind, r."studentId", r."identityId", r."structuredJson"
     )
     SELECT c.id, c.kind, c."studentId", c."structuredJson",
            i."parentUserId" AS "parentUserId"
       FROM claimed c
       JOIN "KakaoParentIdentity" i ON i.id = c."identityId"`,
    Math.max(1, Math.min(50, limit)),
  );
}

async function finish(intake: ClaimedIntake, status: "APPLIED" | "HELD" | "FAILED", routing: Structured, errorCode?: string) {
  const structured = { ...(intake.structuredJson ?? {}), routing };
  await prisma.$executeRawUnsafe(
    `UPDATE "KakaoParentIntake"
        SET status=$2, "structuredJson"=$3::jsonb,
            "appliedAt"=CASE WHEN $2='APPLIED' THEN now() ELSE "appliedAt" END,
            "errorCode"=$4, "updatedAt"=now()
      WHERE id=$1 AND status='PROCESSING'`,
    intake.id,
    status,
    JSON.stringify(structured),
    errorCode ?? null,
  );
}

function requiredAutoFields(intake: ClaimedIntake): { ok: true; data: Structured } | { ok: false; missing: string[] } {
  const data = intake.structuredJson ?? {};
  const missing: string[] = [];
  if (!intake.studentId || text(data.studentId) !== intake.studentId) missing.push("studentId");

  if (intake.kind === "REGULAR_ABSENCE") {
    for (const key of ["classId", "date", "reason"] as const) if (!text(data[key])) missing.push(key);
  } else {
    for (const key of ["serviceDate", "direction"] as const) if (!text(data[key])) missing.push(key);
    if (intake.kind === "SHUTTLE_LOCATION" && !text(data.location)) missing.push("location");
  }
  return missing.length ? { ok: false, missing } : { ok: true, data };
}

async function routeOne(intake: ClaimedIntake): Promise<"APPLIED" | "HELD" | "FAILED"> {
  if (!AUTO_KINDS.has(intake.kind)) {
    await finish(intake, "HELD", routingResult({
      mode: "APPROVAL",
      reason: "ADMIN_APPROVAL_REQUIRED",
      admin: "PENDING_APPROVAL",
      coach: "AFTER_APPROVAL",
      driver: "AFTER_APPROVAL",
    }));
    return "HELD";
  }

  const checked = requiredAutoFields(intake);
  if (!checked.ok) {
    await finish(intake, "HELD", routingResult({
      mode: "APPROVAL",
      reason: `MISSING_STRUCTURED_FIELDS:${checked.missing.join(",")}`,
      admin: "PENDING_REVIEW",
      coach: "NOT_SENT",
      driver: "NOT_SENT",
    }), "MISSING_STRUCTURED_FIELDS");
    return "HELD";
  }

  let delivery: { admin?: string; coach?: string; driver?: string } | null | undefined;
  try {
    if (intake.kind === "REGULAR_ABSENCE") {
      const result = await reportRegularAbsence(intake.parentUserId, {
        studentId: intake.studentId!,
        classId: text(checked.data.classId),
        date: text(checked.data.date),
        reason: text(checked.data.reason),
      });
      delivery = result.notification;
    } else {
      const result = await submitShuttleException(intake.parentUserId, {
        studentId: intake.studentId!,
        serviceDate: checked.data.serviceDate,
        direction: checked.data.direction,
        kind: intake.kind === "SHUTTLE_SKIP" ? "SKIP" : "LOCATION",
        location: checked.data.location,
        note: checked.data.note,
      });
      if (!result.ok) throw new Error(result.message);
      delivery = result.notification;
    }
  } catch (error) {
    const code = error instanceof Error ? error.message.slice(0, 160) : "DOMAIN_VALIDATION_FAILED";
    // 입력 또는 현재 운영 상태가 맞지 않으면 재시도로 추측하지 않고 관리자 검토로 보낸다.
    await finish(intake, "HELD", routingResult({
      mode: "APPROVAL",
      reason: "DOMAIN_VALIDATION_FAILED",
      admin: "PENDING_REVIEW",
      coach: "NOT_SENT",
      driver: "NOT_SENT",
    }), code);
    return "HELD";
  }

  // 도메인 반영이 끝난 뒤 이 상태 기록만 실패하면 PROCESSING으로 남긴다.
  // 실제 반영을 HELD로 잘못 표시하거나 자동 재실행하지 않고 관리자가 대조한다.
  await finish(intake, "APPLIED", routingResult({
    mode: "AUTO",
    reason: "DOMAIN_VALIDATED",
    admin: delivery?.admin ?? "NOTIFICATION_FAILED",
    coach: delivery?.coach ?? (intake.kind === "REGULAR_ABSENCE" ? "NOT_FOUND" : "NOT_APPLICABLE"),
    driver: delivery?.driver ?? "NOT_FOUND",
  }));
  return "APPLIED";
}

export async function routeSubmittedKakaoIntakes(limit = 20): Promise<IntakeRoutingResult> {
  const result: IntakeRoutingResult = { claimed: 0, applied: 0, held: 0, failed: 0 };
  const claims = await claimSubmittedIntakes(limit);
  result.claimed = claims.length;
  for (const intake of claims) {
    try {
      const status = await routeOne(intake);
      if (status === "APPLIED") result.applied += 1;
      else result.held += 1;
    } catch (error) {
      result.failed += 1;
      // 실제 도메인 반영 뒤 상태 기록만 실패했을 가능성이 있으므로 FAILED로 덮지 않는다.
      // PROCESSING은 관리자 대조 후 수동으로 복구해 중복 결석·셔틀 반영을 막는다.
      console.error("[kakao intake routing] manual reconciliation required", {
        intakeId: intake.id,
        error: error instanceof Error ? error.message.slice(0, 160) : "ROUTER_INTERNAL_ERROR",
      });
    }
  }
  return result;
}
