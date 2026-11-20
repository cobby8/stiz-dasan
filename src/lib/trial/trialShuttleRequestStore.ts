/**
 * 체험 «셔틀 요청» 칸을 DB 에 쓰는 한 곳 (2026-11-19).
 *
 * 공개 신청 저장(submitTrialApplication)과 관리자 저장(updateTrialLeadShuttleRequest)이 같은 SQL 을 쓴다.
 * ⚠️ 서버 액션 파일("use server")에 두지 않는다 — 거기서 export 하면 누구나 부를 수 있는 주소가 된다.
 * DB 는 인자로 받는다(prisma 든 트랜잭션이든 · $queryRawUnsafe/$executeRawUnsafe 만 쓴다 — PgBouncer).
 */
import { trialShuttleColumnsFromRow, type TrialShuttleRequestColumns } from "@/lib/trial/trialShuttleRequest";
import type { TrialShuttleReleaseReason } from "@/lib/shuttle/trialShuttleRules";

type RawDb = { $executeRawUnsafe(query: string, ...values: unknown[]): Promise<unknown> };
type RawQueryDb = { $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T> };

/** 지금 저장돼 있는 셔틀 요청 칸과 상태. 신청이 없으면 null (칸이 아직 없는 DB 에서는 오류가 난다 — 부르는 쪽이 잡는다) */
export async function readTrialShuttleState(
    db: RawQueryDb,
    leadId: string,
): Promise<{ columns: TrialShuttleRequestColumns; status: string } | null> {
    const rows = await db.$queryRawUnsafe<unknown[]>(
        `SELECT id, "shuttleNeeded", "shuttleDirection", "shuttleStatus",
                "shuttlePickupName", "shuttlePickupAddress", "shuttlePickupLat", "shuttlePickupLng",
                "shuttleDropoffName", "shuttleDropoffAddress", "shuttleDropoffLat", "shuttleDropoffLng"
           FROM "TrialLead" WHERE id = $1 LIMIT 1`,
        leadId,
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    const status = row.shuttleStatus ?? row.shuttlestatus;
    return { columns: trialShuttleColumnsFromRow(row), status: typeof status === "string" && status ? status : "NONE" };
}

/** 요청 칸만 필요할 때 */
export async function readTrialShuttleRequest(db: RawQueryDb, leadId: string): Promise<TrialShuttleRequestColumns | null> {
    return (await readTrialShuttleState(db, leadId))?.columns ?? null;
}

/**
 * 쓰기 조건 — 읽고 나서 쓰기 전에 다른 화면이 배정을 바꿨을 때, 살아 있는 탑승 줄을 둔 채 상태만 덮어쓰지 않게 한다.
 *  - ANY          : 조건 없음(방금 만든 새 신청)
 *  - NOT_ASSIGNED : 배정됨이 아닐 때만(관리자 고치기 — 풀기를 먼저 했으므로 배정됨이 남아 있으면 그 사이 누가 다시 배정한 것)
 *  - OPEN_ONLY    : 요청 없음·배정 대기일 때만(로그인 없는 신청서 재제출 — 배정됨·어려움은 절대 덮어쓰지 않는다)
 */
export type TrialShuttleWriteGuard = "ANY" | "NOT_ASSIGNED" | "OPEN_ONLY";

const WRITE_GUARD_SQL: Record<TrialShuttleWriteGuard, string> = {
    ANY: "",
    NOT_ASSIGNED: `AND "shuttleStatus" IS DISTINCT FROM 'ASSIGNED'`,
    OPEN_ONLY: `AND COALESCE("shuttleStatus", 'NONE') IN ('NONE', 'REQUESTED')`,
};

/**
 * 셔틀 요청 칸을 통째로 덮어쓴다. 바뀐 줄 수를 돌려준다(0 = 조건에 걸려 쓰지 않음).
 * 요청 있음 → 상태 REQUESTED + 요청 시각 지금 / 필요 없음 → 상태 NONE + 모든 칸 비움.
 * (배정됨·어려움 상태로 «만드는» 것은 셔틀 배정 쪽 코드만 한다)
 */
export async function writeTrialShuttleRequest(
    db: RawDb,
    leadId: string,
    columns: TrialShuttleRequestColumns,
    guard: TrialShuttleWriteGuard = "ANY",
): Promise<number> {
    const result = await db.$executeRawUnsafe(
        `UPDATE "TrialLead" SET
            "shuttleNeeded" = $2::boolean,
            "shuttleDirection" = $3,
            "shuttlePickupName" = $4,
            "shuttlePickupAddress" = $5,
            "shuttlePickupLat" = $6::double precision,
            "shuttlePickupLng" = $7::double precision,
            "shuttleDropoffName" = $8,
            "shuttleDropoffAddress" = $9,
            "shuttleDropoffLat" = $10::double precision,
            "shuttleDropoffLng" = $11::double precision,
            "shuttleStatus" = CASE WHEN $2::boolean THEN 'REQUESTED' ELSE 'NONE' END,
            "shuttleRequestedAt" = CASE WHEN $2::boolean THEN NOW() ELSE NULL END,
            "updatedAt" = NOW()
          WHERE id = $1 ${WRITE_GUARD_SQL[guard]}`,
        leadId,
        columns.shuttleNeeded,
        columns.shuttleDirection,
        columns.shuttlePickupName,
        columns.shuttlePickupAddress,
        columns.shuttlePickupLat,
        columns.shuttlePickupLng,
        columns.shuttleDropoffName,
        columns.shuttleDropoffAddress,
        columns.shuttleDropoffLat,
        columns.shuttleDropoffLng,
    );
    const count = Number(result);
    return Number.isFinite(count) ? count : 1;
}

/** 관리 메모 끝에 한 줄 덧붙인다(기존 메모는 지우지 않는다) */
export async function appendTrialLeadMemo(db: RawDb, leadId: string, text: string): Promise<void> {
    await db.$executeRawUnsafe(
        `UPDATE "TrialLead"
            SET memo = CASE WHEN memo IS NULL OR TRIM(memo) = '' THEN $2 ELSE memo || E'\\n' || $2 END,
                "updatedAt" = NOW()
          WHERE id = $1`,
        leadId,
        text,
    );
}

// ── 다시 낸 신청서의 이력 = 속도 제한 장부 ───────────────────────────────────

/** 다시 낸 신청서 이력의 작성자 이름(관리자 상담 이력에 이렇게 보인다). 속도 제한도 이 이름으로 센다 */
export const TRIAL_RESUBMIT_LOG_AUTHOR = "학부모 신청서";

/** 그 전화번호의 체험 신청이 최근 10분 동안 «다시 낸» 횟수 */
export async function countRecentTrialResubmits(db: RawQueryDb, phoneDigits: string): Promise<number> {
    const rows = await db.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT COUNT(*)::int AS count
           FROM "ApplicationContactLog" l
           JOIN "TrialLead" t ON t.id = l."trialLeadId"
          WHERE regexp_replace(COALESCE(t."parentPhone", ''), '[^0-9]', '', 'g') = $1
            AND l."createdByName" = $2
            AND l."createdAt" > NOW() - INTERVAL '10 minutes'`,
        phoneDigits,
        TRIAL_RESUBMIT_LOG_AUTHOR,
    );
    return Number(rows[0]?.count ?? 0);
}

/** 다시 낸 신청서 한 번 = 이력 한 줄(관리자가 «누가 언제 바꿨는지» 볼 수 있게, 그리고 위 횟수 세기용) */
export async function recordTrialResubmitLog(db: RawDb, leadId: string, note: string): Promise<void> {
    await db.$executeRawUnsafe(
        `INSERT INTO "ApplicationContactLog" (
            id, "targetType", "trialLeadId", "enrollmentApplicationId", action, note,
            "createdByUserId", "createdByName", "createdAt", "updatedAt"
        ) VALUES (gen_random_uuid()::text, 'TRIAL', $1, NULL, 'UPDATED', $2, NULL, $3, NOW(), NOW())`,
        leadId,
        note,
        TRIAL_RESUBMIT_LOG_AUTHOR,
    );
}

// ── 배정 풀기 ────────────────────────────────────────────────────────────────

type ReleaseModule = {
    releaseTrialShuttleOnLeadChange(leadId: string, reason: TrialShuttleReleaseReason): Promise<unknown>;
};

/**
 * 이미 된 체험 셔틀 배정을 푼다 — 실제 일은 셔틀 배정 쪽 함수(releaseTrialShuttleOnLeadChange)가 한다.
 * 여기서는 «부르는 자리»만 한 곳으로 모은다(체험 일정 변경·취소·이탈·삭제·셔틀 요청 변경).
 * 그 함수는 던지지 않고 { released, failed } 를 돌려준다 — failed 가 참이거나(풀지 못함) 모듈을 못 부르면 ok=false.
 * 풀기가 실패해도 체험 신청 저장은 막지 않는다. 화면이 «셔틀 배정을 확인해 주세요»라고 알릴 수 있게 결과만 돌려준다.
 * load 는 테스트가 바꿔 끼우는 자리다(평소엔 넘기지 않는다).
 */
export async function releaseTrialShuttleWithResult(
    leadId: string,
    reason: TrialShuttleReleaseReason,
    load: () => Promise<ReleaseModule> = () => import("@/lib/shuttle/trialShuttle"),
): Promise<{ ok: boolean; released: number }> {
    try {
        const { releaseTrialShuttleOnLeadChange } = await load();
        const result = (await releaseTrialShuttleOnLeadChange(leadId, reason)) as { released?: unknown; failed?: unknown } | null | undefined;
        const released = Number(result?.released ?? 0) || 0;
        if (result?.failed === true) {
            console.warn("[trial-shuttle] 배정 풀기 실패(배정 쪽이 실패를 알림):", leadId, reason);
            return { ok: false, released };
        }
        return { ok: true, released };
    } catch (error) {
        console.warn("[trial-shuttle] 배정 풀기 실패:", leadId, reason, (error as Error).message);
        return { ok: false, released: 0 };
    }
}

/** 풀기가 잘 끝났는가만 필요할 때(true = 풀었거나 풀 것이 없었다) */
export async function releaseTrialShuttleSafely(
    leadId: string,
    reason: TrialShuttleReleaseReason,
    load?: () => Promise<ReleaseModule>,
): Promise<boolean> {
    return (await releaseTrialShuttleWithResult(leadId, reason, load)).ok;
}
