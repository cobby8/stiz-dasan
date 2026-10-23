import { isUsablePhoneKey, parentPhoneDigits } from "./parentIdentity";

type Reader = { $queryRawUnsafe<T>(sql: string, ...values: unknown[]): Promise<T> };
type Writer = Reader & { $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number> };
type ParentAccount = { id: string; name: string | null; role: string; phone: string | null; authUserId: string | null };
type Application = { parentPhone?: string | null; parentphone?: string | null; parentUserId?: string | null; parentuserid?: string | null };
export type VerifyParentAuth = (id: string) => Promise<boolean>;
const staffRoles = new Set(["ADMIN", "VICE_ADMIN", "INSTRUCTOR"]);

/** 서버 검증용 Auth 읽기를 제한 시간에 취소한다. SDK가 전달한 취소 신호도 유지한다. */
export function approvalAuthFetch(fetcher: typeof fetch = fetch, timeoutMs = 5_000): typeof fetch {
    return (input, init) => {
        const signal = AbortSignal.timeout(timeoutMs);
        const upstreamSignal = init?.signal ?? (input instanceof Request ? input.signal : null);
        return fetcher(input, { ...init, signal: upstreamSignal ? AbortSignal.any([upstreamSignal, signal]) : signal });
    };
}

export function isActiveApprovalAuthUser(user: { id: string; deleted_at?: string; banned_until?: string } | null, expectedId: string, now = Date.now()) {
    if (!user || user.id !== expectedId || user.deleted_at) return false;
    if (!user.banned_until) return true;
    const bannedUntil = new Date(user.banned_until).getTime();
    return Number.isFinite(bannedUntil) && bannedUntil <= now;
}

/** 전화 일치는 후보 검색에만 사용한다. 직원 계정을 자동으로 보호자로 정하지 않는다. */
export async function readApprovalParents(db: Reader, app: Application, lock = false) {
    const digits = parentPhoneDigits(app.parentPhone ?? app.parentphone);
    const linked = app.parentUserId ?? app.parentuserid ?? null;
    return db.$queryRawUnsafe<ParentAccount[]>(
        `SELECT id, name, role, phone, "authUserId" FROM "User"
         WHERE id = $1 OR ($2::boolean AND regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = $3)
         ORDER BY id ${lock ? "FOR UPDATE" : ""}`,
        linked, isUsablePhoneKey(digits), digits,
    );
}

/** Auth의 정확한 ID와 앱 계정의 단일 연결을 모두 확인한다. 이메일·전화 추정은 하지 않는다. */
async function isEligibleParent(db: Reader, user: ParentAccount, verifyAuth: VerifyParentAuth) {
    if (user.role === "PARENT" && !user.authUserId) return true;
    if ((user.role !== "PARENT" && !staffRoles.has(user.role)) || !user.authUserId) return false;
    const linked = await db.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM "User" WHERE "authUserId" = $1`, user.authUserId,
    );
    return linked.length === 1 && linked[0].id === user.id && await verifyAuth(user.authUserId);
}

export async function listApprovalParentCandidates(db: Reader, app: Application, actorId: string, verifyAuth: VerifyParentAuth) {
    const candidates = [];
    const users = await readApprovalParents(db, app);
    for (const user of users) {
        if (!await isEligibleParent(db, user, verifyAuth)) continue;
        candidates.push({ id: user.id, name: user.name || "이름 미등록", role: user.role,
            phoneLast4: parentPhoneDigits(user.phone).slice(-4), authLinked: Boolean(user.authUserId), isCurrentAccount: user.id === actorId });
    }
    return { candidates, linkedParentUserId: app.parentUserId ?? app.parentuserid ?? null, hasUnselectableMatches: users.length > candidates.length };
}

export class ParentSelectionRequired extends Error {}

/** null만 신규 보호자 생성을 뜻한다. 모호하거나 명시 연결이 깨졌으면 절대 신규 생성하지 않는다. */
export async function resolveApprovalParent(db: Reader, app: Application, selectedId: string | undefined, verifyAuth: VerifyParentAuth) {
    const linked = app.parentUserId ?? app.parentuserid ?? null;
    // 동일 연락처 신청 두 건을 동시에 승인해 신규 보호자가 복제되는 것을 막는다.
    await db.$queryRawUnsafe(`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended($1, 0))`, `enrollment-parent:${parentPhoneDigits(app.parentPhone ?? app.parentphone)}`);
    const users = await readApprovalParents(db, app, true);
    if (linked && selectedId && linked !== selectedId) throw new Error("신청서에 연결된 보호자와 선택한 계정이 다릅니다. 연결 정보를 먼저 확인해 주세요.");
    if (selectedId === "__NEW__") {
        if (users.length === 0 && !linked) return null;
        throw new ParentSelectionRequired("기존 보호자 후보가 있습니다. 연결할 보호자 계정을 직접 선택해 주세요.");
    }
    const wanted = selectedId || linked;
    if (wanted) {
        const selected = users.find((user) => user.id === wanted);
        if (!selected || !await isEligibleParent(db, selected, verifyAuth)) throw new Error("선택한 보호자 계정의 연결 정보를 확인할 수 없습니다. 다시 조회해 주세요.");
        return selected.id;
    }
    // 한 명뿐이어도 전화 일치만으로 연결하지 않는다. 신규 생성도 명시 선택해야 한다.
    throw new ParentSelectionRequired("연결할 보호자 계정을 직접 선택해 주세요.");
}

/** 반려 사유를 남긴 채 재검토 상태만 되돌린다. 등록·청구·발송은 하지 않는다. */
export async function reopenEnrollmentForReview(tx: Writer, id: string, reason: string, actor: { id: string; name: string | null }) {
    const note = reason.trim();
    if (!note || note.length > 500) throw new Error("재검토 사유를 1~500자로 입력해 주세요.");
    const [app] = await tx.$queryRawUnsafe<{ status: string; convertedStudentId: string | null; processedNote: string | null; processedAt: Date | string | null }[]>(
        `SELECT status, "convertedStudentId", "processedNote", "processedAt" FROM "EnrollmentApplication" WHERE id = $1 FOR UPDATE`, id,
    );
    if (!app || app.status !== "REJECTED" || app.convertedStudentId) throw new Error("원생으로 전환되지 않은 반려 신청만 재검토할 수 있습니다.");
    const changed = await tx.$executeRawUnsafe(
        `UPDATE "EnrollmentApplication" SET status = 'PENDING', "updatedAt" = NOW()
         WHERE id = $1 AND status = 'REJECTED' AND "convertedStudentId" IS NULL`, id,
    );
    if (changed !== 1) throw new Error("신청 상태가 변경되었습니다. 다시 조회해 주세요.");
    // 다음 승인에서 처리 메모가 교체되어도 원래 반려 사유와 시각은 이력에 남긴다.
    const rejectedAt = app.processedAt ? new Date(app.processedAt).toISOString() : "기록 없음";
    const historyNote = `반려 신청 재검토: ${note}\n이전 반려 사유: ${app.processedNote || "기록 없음"}\n이전 반려 시각: ${rejectedAt}`;
    await tx.$executeRawUnsafe(
        `INSERT INTO "ApplicationContactLog" (id, "targetType", "enrollmentApplicationId", action, note, "createdByUserId", "createdByName", "createdAt", "updatedAt")
         VALUES (gen_random_uuid()::text, 'ENROLL', $1, 'UPDATED', $2, $3, $4, NOW(), NOW())`,
        id, historyNote, actor.id, actor.name,
    );
    return { ok: true as const, status: "PENDING" as const };
}
