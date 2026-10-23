/**
 * 수강 신청서 ↔ 체험 기록 연결 — DB 연결부.
 *
 * 판정은 순수 모듈(`trialLeadMatch.ts`)이 하고, 여기서는 후보를 읽어오고 연결을 저장만 한다.
 * ⚠️ PgBouncer 트랜잭션 모드 때문에 $queryRawUnsafe / $executeRawUnsafe 만 쓴다.
 * ⚠️ 문자·알림 발송은 이 파일에서 절대 하지 않는다(연결은 내부 기록 정리일 뿐이다).
 * 날짜는 SQL 에서 KST 달력("YYYY-MM-DD")으로 바꿔 넘긴다(모든 컬럼이 timestamptz → AT TIME ZONE 한 번).
 */
import { prisma } from "@/lib/prisma";
import { ensureApplicationContactLogInfrastructure } from "@/lib/application-contact-logs";
import { parentPhoneDigits, isUsablePhoneKey } from "@/lib/enrollment/parentIdentity";
import {
    decideTrialLeadMatch,
    selectApplicationForTrialAutoLink,
    TRIAL_MATCH_OPEN_STATUSES,
    type TrialLeadMatchApplication,
    type TrialLeadMatchCandidate,
    type TrialLeadMatchResult,
    type TrialLinkSuggestion,
} from "@/lib/enrollment/trialLeadMatch";

/**
 * 관리자 목록 후보 조회 범위(전체 풀을 읽을 때만). 번호로 좁혀 읽는 신청 제출 경로에는 걸지 않는다 —
 * 이름·번호 완전 일치는 예전처럼 기간과 상관없이 연결돼야 한다(정확한 기간 자르기는 판정 모듈이 한다).
 */
const CANDIDATE_SQL_WINDOW_DAYS = 200;
/** 관리자 화면 후보 표시 대상 신청서 범위 */
const SUGGESTION_APPLICATION_WINDOW_DAYS = 150;

const OPEN_STATUS_SQL = TRIAL_MATCH_OPEN_STATUSES.map((status) => `'${status}'`).join(", ");

export type TrialLinkActor = { appUserId: string | null; appUserName: string | null } | null;

export type TrialCandidateRow = TrialLeadMatchCandidate & {
    className: string | null;
};

const CANDIDATE_SELECT = `
    SELECT t.id,
           t."childName",
           t."parentPhone",
           t.status,
           t."childSchool",
           t."childGrade",
           to_char(t."childBirthDate" AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS "childBirthYmd",
           COALESCE(c."slotKey", t."preferredSlotKey") AS "slotKey",
           c.name AS "className",
           to_char(t."createdAt" AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS "createdYmd",
           to_char(COALESCE(t."attendedDate", t."scheduledDate", t."trialDate") AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS "trialYmd",
           t."enrollApplicationId"
      FROM "TrialLead" t
      LEFT JOIN "Class" c ON c.id = t."scheduledClassId"
     WHERE t.status IN (${OPEN_STATUS_SQL})`;

function toCandidate(row: any): TrialCandidateRow {
    return {
        id: String(row.id),
        childName: String(row.childName ?? ""),
        parentPhone: row.parentPhone ?? null,
        status: String(row.status ?? ""),
        childSchool: row.childSchool ?? null,
        childGrade: row.childGrade ?? null,
        childBirthYmd: row.childBirthYmd ?? null,
        slotKey: row.slotKey ?? null,
        className: row.className ?? null,
        createdYmd: String(row.createdYmd ?? ""),
        trialYmd: row.trialYmd ?? null,
        enrollApplicationId: row.enrollApplicationId ?? null,
    };
}

/** 보호자 번호(숫자) 가 같은 체험 후보 — AUTO 판정에는 번호 일치가 필수라 이것만 읽으면 된다. */
export async function fetchTrialCandidatesByPhone(parentPhone: string): Promise<TrialCandidateRow[]> {
    const digits = parentPhoneDigits(parentPhone);
    if (!isUsablePhoneKey(digits)) return [];
    const rows = await prisma.$queryRawUnsafe<any[]>(
        `${CANDIDATE_SELECT}
           AND regexp_replace(COALESCE(t."parentPhone", ''), '[^0-9]', '', 'g') = $1`,
        digits,
    );
    return rows.map(toCandidate);
}

/** 신청 제출 순간 판정. 재제출이면 기존 신청서 id(applicationId)를 넘긴다. AUTO 일 때만 호출부가 연결한다. */
export async function decideTrialLeadForNewApplication(
    application: TrialLeadMatchApplication,
): Promise<TrialLeadMatchResult> {
    const candidates = await fetchTrialCandidatesByPhone(application.parentPhone);
    return decideTrialLeadMatch(application, candidates);
}

type ApplicationRow = {
    id: string;
    childName: string;
    parentPhone: string;
    childSchool: string | null;
    childGrade: string | null;
    childBirthYmd: string | null;
    preferredSlotKeys: string | null;
    appliedYmd: string;
};

const APPLICATION_SELECT = `
    SELECT a.id,
           a."childName",
           a."parentPhone",
           a."childSchool",
           a."childGrade",
           to_char(a."childBirthDate" AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS "childBirthYmd",
           a."preferredSlotKeys",
           to_char(a."createdAt" AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS "appliedYmd"
      FROM "EnrollmentApplication" a
     WHERE a."trialLeadId" IS NULL
       AND a.status IN ('PENDING', 'APPROVED')`;

function toMatchApplication(row: ApplicationRow): TrialLeadMatchApplication {
    return {
        applicationId: row.id,
        childName: row.childName,
        parentPhone: row.parentPhone,
        childSchool: row.childSchool,
        childGrade: row.childGrade,
        childBirthYmd: row.childBirthYmd,
        preferredSlotKeys: row.preferredSlotKeys,
        appliedYmd: row.appliedYmd,
    };
}

// ── 연결 처리 공통 함수 ────────────────────────────────────────────────────

export type LinkTrialLeadResult =
    | { linked: true; convertedTrial: boolean }
    | { linked: false; reason: string };

class LinkAbort extends Error {}

/**
 * 신청서와 체험 기록을 한 트랜잭션으로 연결한다. 이미 연결된 쪽은 덮어쓰지 않는다(조건부 UPDATE).
 *  1) EnrollmentApplication."trialLeadId" (비어 있을 때만)
 *  2) TrialLead."enrollApplicationId" / "enrollApplicationReceivedAt" (비어 있거나 같은 신청서일 때만, 열린 상태일 때만)
 *  3) 신청서가 이미 승인(APPROVED)되어 학생이 있으면 체험을 CONVERTED 로(승인 때 했어야 할 처리를 뒤늦게)
 *  4) 신청·체험 양쪽 이력(ApplicationContactLog, action=UPDATED)
 * 문자·알림은 보내지 않는다.
 */
export async function linkTrialLeadToApplication(input: {
    applicationId: string;
    trialLeadId: string;
    actor: TrialLinkActor;
    note: string;
}): Promise<LinkTrialLeadResult> {
    const { applicationId, trialLeadId, actor, note } = input;
    if (!applicationId || !trialLeadId) return { linked: false, reason: "신청서 또는 체험 기록이 비어 있습니다." };

    let logReady = true;
    try {
        await ensureApplicationContactLogInfrastructure();
    } catch (error) {
        logReady = false;
        // 이력 테이블 준비 실패가 연결 자체를 막지는 않는다(아래 INSERT 도 건너뛴다).
        console.warn("[trial-link] contact log ensure failed:", (error as Error).message);
    }

    try {
        const convertedTrial = await prisma.$transaction(async (tx) => {
            // 1) 신청서 — 아직 체험과 연결되지 않은 PENDING/APPROVED 만
            const appRows = await tx.$queryRawUnsafe<Array<{ status: string; convertedStudentId: string | null; childName: string }>>(
                `UPDATE "EnrollmentApplication"
                    SET "trialLeadId" = $1, "updatedAt" = NOW()
                  WHERE id = $2
                    AND "trialLeadId" IS NULL
                    AND status IN ('PENDING', 'APPROVED')
                  RETURNING status, "convertedStudentId", "childName"`,
                trialLeadId,
                applicationId,
            );
            if (appRows.length === 0) throw new LinkAbort("신청서가 이미 다른 체험 기록과 연결됐거나 처리 가능한 상태가 아닙니다.");

            // 2) 체험 기록 — 열린 상태이고 다른 신청서와 연결되지 않았을 때만.
            //    접수 시각은 "지금"이 아니라 신청서가 실제 들어온 시각으로 남긴다.
            const trialRows = await tx.$queryRawUnsafe<Array<{ id: string; childName: string }>>(
                `UPDATE "TrialLead" t
                    SET "enrollApplicationId" = $1,
                        "enrollApplicationReceivedAt" = COALESCE(t."enrollApplicationReceivedAt", a."createdAt", NOW()),
                        "updatedAt" = NOW()
                   FROM "EnrollmentApplication" a
                  WHERE t.id = $2
                    AND a.id = $1
                    AND (t."enrollApplicationId" IS NULL OR t."enrollApplicationId" = $1)
                    AND t.status IN (${OPEN_STATUS_SQL})
                  RETURNING t.id, t."childName"`,
                applicationId,
                trialLeadId,
            );
            if (trialRows.length === 0) throw new LinkAbort("체험 기록이 이미 다른 신청서와 연결됐거나 종료된 상태입니다.");

            // 3) 이미 승인된 신청서면 체험을 등록 완료(CONVERTED)로
            const app = appRows[0];
            let converted = false;
            if (app.status === "APPROVED" && app.convertedStudentId) {
                await tx.$executeRawUnsafe(
                    `UPDATE "TrialLead" t
                        SET status = 'CONVERTED',
                            "convertedStudentId" = $1,
                            "convertedDate" = COALESCE(t."convertedDate", a."processedAt", NOW()),
                            "updatedAt" = NOW()
                       FROM "EnrollmentApplication" a
                      WHERE t.id = $2
                        AND a.id = $3`,
                    app.convertedStudentId,
                    trialLeadId,
                    applicationId,
                );
                converted = true;
            }

            // 4) 이력 — 기존 recordApplicationHistoryLog 와 같은 형식(대상별 1줄)
            const logNote = `${note} · 신청서 ${app.childName} ↔ 체험 ${trialRows[0].childName}${converted ? " · 체험 등록완료 처리" : ""}`;
            if (logReady) for (const [targetType, trialId, enrollId] of [
                ["TRIAL", trialLeadId, null],
                ["ENROLL", null, applicationId],
            ] as const) {
                await tx.$executeRawUnsafe(
                    `INSERT INTO "ApplicationContactLog" (
                        id, "targetType", "trialLeadId", "enrollmentApplicationId", action, note,
                        "createdByUserId", "createdByName", "createdAt", "updatedAt"
                     ) VALUES (gen_random_uuid()::text, $1, $2, $3, 'UPDATED', $4, $5, $6, NOW(), NOW())`,
                    targetType,
                    trialId,
                    enrollId,
                    logNote,
                    actor?.appUserId ?? null,
                    actor?.appUserName ?? "시스템 자동 연결",
                );
            }
            return converted;
        }, { timeout: 15_000 });

        return { linked: true, convertedTrial };
    } catch (error) {
        if (error instanceof LinkAbort) return { linked: false, reason: error.message };
        throw error;
    }
}

// ── 비교 시점 (b): 관리자가 체험 기록 이름/번호를 고친 뒤 ─────────────────

/**
 * 체험 기록이 수정된 뒤, 아직 체험과 연결되지 않은 신청서들과 다시 비교해 AUTO 면 연결한다.
 * 이 체험 기록을 가리키는 AUTO 만 연결한다(다른 기록을 가리키면 손대지 않는다).
 */
export async function autoLinkApplicationsForTrialLead(
    trialLeadId: string,
    actor: TrialLinkActor,
): Promise<{ linkedApplicationIds: string[] }> {
    const leadRows = await prisma.$queryRawUnsafe<Array<{ childName: string; parentPhone: string | null; enrollApplicationId: string | null; status: string }>>(
        `SELECT "childName", "parentPhone", "enrollApplicationId", status FROM "TrialLead" WHERE id = $1 LIMIT 1`,
        trialLeadId,
    );
    const lead = leadRows[0];
    if (!lead || lead.enrollApplicationId) return { linkedApplicationIds: [] };
    if (!(TRIAL_MATCH_OPEN_STATUSES as readonly string[]).includes(lead.status)) return { linkedApplicationIds: [] };

    const digits = parentPhoneDigits(lead.parentPhone);
    if (!isUsablePhoneKey(digits)) return { linkedApplicationIds: [] };

    const apps = await prisma.$queryRawUnsafe<ApplicationRow[]>(
        `${APPLICATION_SELECT}
           AND a."createdAt" >= NOW() - INTERVAL '${SUGGESTION_APPLICATION_WINDOW_DAYS} days'
           AND regexp_replace(COALESCE(a."parentPhone", ''), '[^0-9]', '', 'g') = $1
         ORDER BY a."createdAt" DESC
         LIMIT 20`,
        digits,
    );
    if (apps.length === 0) return { linkedApplicationIds: [] };

    // 같은 번호의 후보 전체로 판정해야 "후보가 정확히 1명" 조건이 지켜진다.
    const candidates = await fetchTrialCandidatesByPhone(digits);
    // 모든 신청서를 판정한 뒤 고른다 — 첫 건을 잡지 않는다(형제 신청서 오연결 방지).
    const decisions = apps.map((app) => ({
        applicationId: app.id,
        childName: app.childName,
        decision: decideTrialLeadMatch(toMatchApplication(app), candidates),
    }));
    const chosenId = selectApplicationForTrialAutoLink(trialLeadId, lead.childName, decisions);
    if (!chosenId) return { linkedApplicationIds: [] };
    const chosen = decisions.find((item) => item.applicationId === chosenId);
    const result = await linkTrialLeadToApplication({
        applicationId: chosenId,
        trialLeadId,
        actor,
        note: `체험 기록 수정 후 자동 연결(${chosen?.decision.reason ?? "AUTO"})`,
    });
    const linkedApplicationIds = result.linked ? [chosenId] : [];
    return { linkedApplicationIds };
}

// ── 관리자 화면: 연결 안 된 신청서의 체험 후보 ─────────────────────────────

export type { TrialLinkSuggestion };

/** 신청서 id → 후보 목록(최대 3건). 후보가 없는 신청서는 키가 없다. */
export async function getTrialLinkSuggestions(): Promise<Record<string, TrialLinkSuggestion[]>> {
    const apps = await prisma.$queryRawUnsafe<ApplicationRow[]>(
        `${APPLICATION_SELECT}
           AND a."createdAt" >= NOW() - INTERVAL '${SUGGESTION_APPLICATION_WINDOW_DAYS} days'
         ORDER BY a."createdAt" DESC
         LIMIT 300`,
    );
    if (apps.length === 0) return {};

    // 이름 오타 비교는 SQL 로 못 하니, 열린 체험 기록 전체(최근 200일)를 한 번 읽어 메모리에서 비교한다.
    const pool = (await prisma.$queryRawUnsafe<any[]>(
        `${CANDIDATE_SELECT}
           AND t."createdAt" >= NOW() - INTERVAL '${CANDIDATE_SQL_WINDOW_DAYS} days'`,
    )).map(toCandidate);
    const byId = new Map(pool.map((candidate) => [candidate.id, candidate]));

    const result: Record<string, TrialLinkSuggestion[]> = {};
    for (const app of apps) {
        const decision = decideTrialLeadMatch(toMatchApplication(app), pool);
        if (decision.decision === "NONE") continue;
        const suggestions = decision.candidates.slice(0, 3).flatMap((item) => {
            const candidate = byId.get(item.trialLeadId);
            if (!candidate) return [];
            return [{
                trialLeadId: item.trialLeadId,
                childName: candidate.childName,
                trialYmd: candidate.trialYmd ?? null,
                classLabel: candidate.className || candidate.slotKey || null,
                strength: item.strength,
                reason: item.reason,
            }];
        });
        if (suggestions.length > 0) result[app.id] = suggestions;
    }
    return result;
}
