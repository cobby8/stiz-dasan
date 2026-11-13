/**
 * 학생 상세 «수강 반» 줄의 관리자 편집 — 반 이동 · 잘못 등록한 수강 삭제 (2026-11-09 원장 지시)
 *
 * 원장: «토요일 2교시는 잘못 신청해서 지우려고 하는데 퇴원이라는 표현이 이상하다. 반이동도 있어야 하고 삭제도 있어야 한다.»
 * - 반 이동 = 기존 수강은 적용일로 «수강 종료»(WITHDRAWN) + 새 반 수강을 같은 조건(ACTIVE·개시일)으로 생성.
 * - 삭제   = 연결된 출석·청구·보강 기록이 하나도 없을 때만. 있으면 막고 «수강 종료»를 쓰게 한다.
 *
 * 판정은 DB 를 읽지 않는 순수 함수로 두고(테스트가 실제로 실행), DB 읽기는 db 를 인자로 받는 함수 한 곳에 둔다.
 */
import { isKstYmd } from "@/lib/datetime/kst";
import { commencementYmd } from "@/lib/enrollment/commencement";

type RawDb = { $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T> };

// ── 반 이동 ───────────────────────────────────────────────────────────────

export type MoveSource = { status: string; classId: string; startsOn: unknown; /** 등록일(KST YYYY-MM-DD) — 개시일이 없을 때 적용일 하한 */ createdYmd?: string | null };

/**
 * 이동 적용일 하한 — 기존 수강 개시일(없으면 등록일 KST)보다 이르면 안 된다. 화면 min 과 서버 판정이 이 함수 하나를 쓴다.
 * 단 아직 개시 전인 수강(개시일 > 오늘)은 오늘로 낮춘다 — 미래 적용일은 막혀 있어서, 그대로 두면 개시 전엔 옮길 길이 없다.
 * (이때 새 반은 원래 개시일을 이어받으므로 청구 시수·출석부 기준은 그대로다.)
 */
export function moveEffectiveMinYmd(startsOn: unknown, createdYmd: string | null | undefined, today: string): string | null {
  const base = commencementYmd(startsOn) ?? (createdYmd && isKstYmd(createdYmd) ? createdYmd : null);
  if (!base) return null;
  return base > today ? today : base;
}
export type MoveTarget = { id: string; capacity: number; activeCount: number; deleted: boolean; seasonal: boolean } | null;
export type MovePlan =
  | { ok: true; newStartsOn: string }
  | { ok: false; code: "INVALID" | "OVER_CAPACITY"; message: string };

export function planEnrollmentMove(input: {
  from: MoveSource;
  target: MoveTarget;
  /** 학생이 이미 그 반에 가진 수강 상태(없으면 null) */
  targetExistingStatus: string | null;
  /** 이 수강의 처리 중(대기·승인 미적용) 수강 변경 신청 수 — 삭제 차단과 같은 기준 */
  openChangeRequests?: number;
  effectiveDate: string;
  today: string;
  allowOverCapacity?: boolean;
}): MovePlan {
  const bad = (message: string): MovePlan => ({ ok: false, code: "INVALID", message });
  if (input.from.status !== "ACTIVE") return bad("수강 중인 반만 옮길 수 있어요. 휴원·종료된 반은 상태를 먼저 바꿔 주세요.");
  if (!isKstYmd(input.effectiveDate)) return bad("이동 적용일을 정확히 선택해 주세요.");
  // 미래 날짜로 옮기면 그날 전까지 기존 반 출석부에서 빠져 버린다 — 상태 변경(updateEnrollmentStatus)과 같은 규칙
  if (input.effectiveDate > input.today) return bad("미래 날짜 이동은 «수강 변경 신청»(예약)으로 해 주세요.");
  const min = moveEffectiveMinYmd(input.from.startsOn, input.from.createdYmd, input.today);
  if (min && input.effectiveDate < min) return bad(`이동 적용일은 기존 수강 시작일(${min}) 이후로 골라 주세요.`);
  // 학부모 반 변경·휴원 신청이 걸려 있으면 그 신청과 엇갈린다 — 먼저 처리하게 한다
  if (Number(input.openChangeRequests ?? 0) > 0) return bad("이 수강에 처리 중인 수강 변경 신청이 있어요. 먼저 «수강 변경 신청»에서 처리해 주세요.");
  const t = input.target;
  if (!t || t.deleted || t.seasonal) return bad("옮길 반을 찾을 수 없어요. 반을 다시 골라 주세요.");
  if (t.id === input.from.classId) return bad("지금 반과 다른 반을 골라 주세요.");
  if (input.targetExistingStatus === "ACTIVE") return bad("이미 그 반에 수강 중이에요.");
  if (input.targetExistingStatus === "PAUSED") return bad("그 반은 휴원 중인 수강 기록이 있어요. 그 반을 «수강 중»으로 바꿔 주세요.");
  if (t.activeCount >= t.capacity && !input.allowOverCapacity) {
    return { ok: false, code: "OVER_CAPACITY", message: `옮길 반이 정원(${t.activeCount}/${t.capacity})이에요.` };
  }
  // 새 반 개시일 = 이동 적용일. 단 원래 수강이 아직 시작 전이면 원래 개시일을 그대로 이어받는다(청구 시수·출석부 기준 보존)
  const oldStart = commencementYmd(input.from.startsOn);
  const newStartsOn = oldStart && oldStart > input.effectiveDate ? oldStart : input.effectiveDate;
  return { ok: true, newStartsOn };
}

// ── 잘못 등록한 수강 삭제 ─────────────────────────────────────────────────

export type EnrollmentLinkCounts = {
  attendance: number;
  payments: number;
  billingDrafts: number;
  makeups: number;
  makeupCredits: number;
  seasonalItems: number;
  /** 결석 신고(취소 제외) */
  regularAbsences: number;
  /** 그 반 수업 회차에 잡힌 셔틀 승객 */
  shuttlePassengers: number;
  /** 아직 처리 안 된(대기·승인) 수강 변경 신청 */
  openChangeRequests: number;
};

const LINK_LABELS: Array<[keyof EnrollmentLinkCounts, string]> = [
  ["attendance", "출석"],
  ["payments", "청구·수납"],
  ["billingDrafts", "청구 준비"],
  ["makeups", "보강"],
  ["makeupCredits", "보강권"],
  ["seasonalItems", "특강 신청 연결"],
  ["regularAbsences", "결석 신고"],
  ["shuttlePassengers", "셔틀 탑승"],
  ["openChangeRequests", "처리 중인 수강 변경 신청"],
];

/** 삭제를 막는 연결 기록 이름들. 빈 배열이면 삭제해도 된다 */
export function enrollmentDeleteBlockers(counts: EnrollmentLinkCounts): string[] {
  return LINK_LABELS.filter(([key]) => Number(counts[key] ?? 0) > 0).map(([key, label]) => `${label} ${counts[key]}건`);
}

export function enrollmentDeleteBlockedMessage(blockers: string[]): string {
  return `이 수강에 ${blockers.join(" · ")} 기록이 있어 삭제할 수 없어요. 그만두는 반이면 «수강 종료»를 써 주세요.`;
}

/**
 * 그 수강(학생+반)에 연결된 기록 수 — 삭제 직전에 서버가 트랜잭션 안에서 다시 센다.
 * 청구 준비 표(BillingWorkbenchDraft)는 운영 DB 에 아직 없을 수 있어 있을 때만 센다.
 */
export async function readEnrollmentLinkCounts(db: RawDb, input: { enrollmentId: string; studentId: string; classId: string }): Promise<EnrollmentLinkCounts> {
  const [row] = await db.$queryRawUnsafe<Array<Omit<EnrollmentLinkCounts, "billingDrafts"> & { hasDrafts: boolean }>>(
    `SELECT
       (SELECT COUNT(*) FROM "Attendance" a JOIN "Session" se ON se.id = a."sessionId"
         WHERE a."studentId" = $2 AND se."classId" = $3)::int AS attendance,
       (SELECT COUNT(*) FROM "Payment" p WHERE p."studentId" = $2 AND p."classId" = $3)::int AS payments,
       (SELECT COUNT(*) FROM "MakeupSession" m
         WHERE m."studentId" = $2 AND (m."originalClassId" = $3 OR m."makeupClassId" = $3))::int AS makeups,
       (SELECT COUNT(*) FROM "MakeupCredit" mc WHERE mc."studentId" = $2 AND mc."originClassId" = $3)::int AS "makeupCredits",
       (SELECT COUNT(*) FROM "SpecialProgramApplicationItem" i WHERE i."enrollmentId" = $1)::int AS "seasonalItems",
       (SELECT COUNT(*) FROM "RegularAbsence" ra
         WHERE ra."studentId" = $2 AND ra."classId" = $3 AND ra.status <> 'CANCELLED')::int AS "regularAbsences",
       (SELECT COUNT(*) FROM "ShuttleRoutePassenger" sp JOIN "Session" ss ON ss.id = sp."sessionId"
         WHERE sp."studentId" = $2 AND ss."classId" = $3)::int AS "shuttlePassengers",
       (SELECT COUNT(*) FROM "EnrollmentChangeRequest" r
         WHERE r."enrollmentId" = $1 AND r.status IN ('PENDING', 'APPROVED') AND r."appliedAt" IS NULL)::int AS "openChangeRequests",
       (to_regclass('public."BillingWorkbenchDraft"') IS NOT NULL) AS "hasDrafts"`,
    input.enrollmentId, input.studentId, input.classId,
  );
  let billingDrafts = 0;
  if (row?.hasDrafts) {
    const [draft] = await db.$queryRawUnsafe<Array<{ count: number }>>(
      `SELECT COUNT(*)::int AS count FROM "BillingWorkbenchDraft" WHERE "studentId" = $1 AND "classId" = $2`,
      input.studentId, input.classId,
    );
    billingDrafts = Number(draft?.count ?? 0);
  }
  return {
    attendance: Number(row?.attendance ?? 0),
    payments: Number(row?.payments ?? 0),
    billingDrafts,
    makeups: Number(row?.makeups ?? 0),
    makeupCredits: Number(row?.makeupCredits ?? 0),
    seasonalItems: Number(row?.seasonalItems ?? 0),
    regularAbsences: Number(row?.regularAbsences ?? 0),
    shuttlePassengers: Number(row?.shuttlePassengers ?? 0),
    openChangeRequests: Number(row?.openChangeRequests ?? 0),
  };
}

// ── 삭제한 수강을 가리키는 «등록» 운영 원장 정리 ─────────────────────────────
//
// 수강 등록(enrollStudent·승인·반 이동)은 운영 원장(OperationsCommand)에 «시트·랠리즈에 이 반 추가» 확인 칸을 만든다.
// 잘못 등록한 수강을 지우면 그 칸은 할 일이 아니므로 직원 확인 목록에서 빼야 한다.
// DB 제약상 명령 상태는 PENDING·HELD·PARTIAL·SYNCED 뿐이고 «취소» 값이 없다(마이그레이션 20260827190000 CHECK).
// 그래서 가장 가까운 종료 상태(명령 SYNCED · 확인 칸 SKIPPED)로 닫고, 사유를 holdReason·error·감사 기록에 남긴다.

/** 운영 원장 명령 상태 — DB CHECK 제약과 같은 집합(테스트가 마이그레이션과 비교) */
export const OPERATIONS_COMMAND_STATUSES = ["PENDING", "HELD", "PARTIAL", "SYNCED"] as const;
/** 아직 끝나지 않은(직원 확인이 남은) 명령 상태 */
export const OPEN_COMMAND_STATUSES = ["PENDING", "HELD", "PARTIAL"] as const;
/** 삭제 시 닫을 명령 종류 — «반 추가»(새 등록) · «복귀»(그만둔 반을 되살린 등록) */
export const ADD_COMMAND_KINDS = ["CLASS_ADD", "RESUME"] as const;
export const DELETED_ENROLLMENT_CLOSE_REASON = "취소: 잘못 등록한 수강을 삭제함(시트·랠리즈 반영 불필요)";

/**
 * «삭제로 닫힌 명령이 아님» SQL 조건(alias = OperationsCommand 별칭).
 * 2026-11-14 랠리즈 은퇴 뒤로는 랠리즈 칸 SKIPPED 도 «끝남»으로 인정한다(rallyzRetirement).
 * 그래도 이 조건은 남긴다 — 삭제로 닫은 명령을 사유로 골라 «연결된 최신 원장»·«확인 필요»에서 빼는 일은 그대로 필요하다.
 */
export function notClosedByDeletedEnrollmentSql(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error("invalid alias");
  return `${alias}."holdReason" IS DISTINCT FROM '${DELETED_ENROLLMENT_CLOSE_REASON.replace(/'/g, "''")}'`;
}

type RawTx = RawDb & { $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number> };

export type ClosedAddCommands = {
  commandIds: string[];
  /** 이미 시트·랠리즈에 반영됐다고 확인된 칸 — 그쪽은 직원이 직접 정리해야 한다 */
  alreadySynced: Array<{ commandId: string; target: string }>;
};

/** 그 수강(enrollmentId)을 가리키는 열린 «등록» 명령을 닫는다. 같은 트랜잭션(tx)에서 부른다 */
export async function closeAddCommandsForDeletedEnrollment(tx: RawTx, input: { enrollmentId: string; actorUserId: string }): Promise<ClosedAddCommands> {
  const commands = await tx.$queryRawUnsafe<Array<{ id: string; requestId: string; kind: string; status: string }>>(
    `SELECT c.id, c."requestId", c.kind, c.status FROM "OperationsCommand" c
      WHERE c.kind = ANY($2::text[]) AND c.status = ANY($3::text[]) AND c."afterJson"->>'enrollmentId' = $1
      FOR UPDATE`,
    input.enrollmentId, [...ADD_COMMAND_KINDS], [...OPEN_COMMAND_STATUSES],
  );
  if (commands.length === 0) return { commandIds: [], alreadySynced: [] };
  const ids = commands.map((c) => c.id);
  const attempts = await tx.$queryRawUnsafe<Array<{ commandId: string; target: string; status: string }>>(
    `SELECT "commandId", target, status FROM "OperationsSyncAttempt" WHERE "commandId" = ANY($1::text[]) FOR UPDATE`,
    ids,
  );
  // 홈페이지(WEBSITE)는 등록 때 이미 완료 — 시트·랠리즈 중 이미 반영 확인된 칸만 따로 알린다
  const alreadySynced = attempts
    .filter((a) => a.target !== "WEBSITE" && a.status === "SUCCEEDED")
    .map((a) => ({ commandId: a.commandId, target: a.target }));
  // 남은 확인 칸(대기·실패)은 «건너뜀»으로 — 직원 확인 목록(NEEDS_CHECK)에서 빠진다
  await tx.$executeRawUnsafe(
    `UPDATE "OperationsSyncAttempt" SET status = 'SKIPPED', error = $2, "processingToken" = NULL, "processingStartedAt" = NULL, "updatedAt" = now()
      WHERE "commandId" = ANY($1::text[]) AND status IN ('PENDING', 'FAILED')`,
    ids, DELETED_ENROLLMENT_CLOSE_REASON,
  );
  await tx.$executeRawUnsafe(
    `UPDATE "OperationsCommand" SET status = 'SYNCED', "holdReason" = $2, "updatedAt" = now() WHERE id = ANY($1::text[])`,
    ids, DELETED_ENROLLMENT_CLOSE_REASON,
  );
  // 요청 안의 명령이 모두 닫혔으면 요청도 닫는다
  const requestIds = [...new Set(commands.map((c) => c.requestId))];
  await tx.$executeRawUnsafe(
    `UPDATE "OperationsRequest" r SET status = 'SYNCED', "updatedAt" = now()
      WHERE r.id = ANY($1::text[]) AND NOT EXISTS (SELECT 1 FROM "OperationsCommand" c WHERE c."requestId" = r.id AND c.status <> 'SYNCED')`,
    requestIds,
  );
  for (const command of commands) {
    await tx.$executeRawUnsafe(
      `INSERT INTO "OperationsAuditLog" (id, "requestId", action, "actorType", "actorUserId", "detailsJson")
       VALUES (gen_random_uuid()::text, $1, 'ENROLLMENT_ADD_COMMAND_CANCELLED', 'ADMIN', $2, $3::jsonb)`,
      command.requestId, input.actorUserId,
      JSON.stringify({
        commandId: command.id, enrollmentId: input.enrollmentId, from: command.status, to: "SYNCED", reason: DELETED_ENROLLMENT_CLOSE_REASON,
        alreadySynced: alreadySynced.filter((a) => a.commandId === command.id).map((a) => a.target),
      }),
    );
  }
  return { commandIds: ids, alreadySynced };
}
