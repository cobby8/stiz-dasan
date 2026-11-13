/**
 * 대시보드 카드·통계 탭 DB 조회 — 2026-11-13 대시보드·통계 개편(원장 결정표 승인).
 *
 * 왜 새로 만드나:
 *   옛 통계 함수(queries.ts getMonthlyRevenue 등)는 서버 시계(UTC)로 달을 잘라 KST 1일 00~09시에 지난달이 되고,
 *   신규/퇴원을 «수강 줄» 단위로 세며, 수납률에 유니폼·셔틀이 섞여 있었다.
 *   옛 함수는 다른 화면이 쓸 수 있어 건드리지 않고, 통계는 이 파일의 새 경로만 쓴다.
 *
 * ■ 시간대 처리(전역 규칙)
 *   - 시간대 없는 칼럼(Student.birthDate·Enrollment.createdAt/updatedAt·Session.date·Payment.paidDate/dueDate)
 *     = UTC 로 저장된 값이라 «두 번» 건다: ((col AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Seoul')
 *   - timestamptz 칼럼(TrialLead.createdAt·EnrollmentApplication.createdAt·Student.uniformReceivedAt)은 «한 번»만.
 *   - 오늘·이번 달은 서버 시계가 아니라 todayKst() 문자열에서 뽑는다.
 *
 * ■ 판정 규칙(학년·성별·지점·유니폼 묶음·비율)은 statsRules.ts 한 곳에서만 한다. 여기서는 원본 값만 읽는다.
 * ⚠️ DB 접근은 $queryRawUnsafe 만(PgBouncer 트랜잭션 모드). 재원생 명단이 나오므로 관리자 payload 에서만 부른다.
 */
import { prisma } from "@/lib/prisma";
import { addMonthsYm, todayKst } from "@/lib/datetime/kst";
import { notMergedStudent } from "@/lib/studentVisibility";
import { currentEnrollmentSql } from "@/lib/enrollment/commencement";
import { branchFromClassLocation, branchFromClassLocations, branchLabel } from "@/lib/students/student-register-rules";
import { getClassCapacityInfo, getCoachWorkload } from "@/lib/queries";
import { normalizeReferral } from "./sourceLabels";
import {
    GRADE_BANDS,
    GRADE_LABELS,
    UNIFORM_GROUPS,
    branchGroup,
    countBy,
    diffPoint,
    gradeBandOf,
    gradeNeedsCheck,
    lastMonths,
    monthShortLabel,
    normalizeGender,
    periodMonths,
    rate,
    schoolGradeFromBirth,
    uniformGroup,
    type GenderLabel,
    type GradeLabel,
    type StatsBranchKey,
    type StatsTabKey,
    type UniformGroup,
} from "./statsRules";
import type {
    DashboardSummary,
    MonthFlow,
    MonthRate,
    SourceStatsRow,
    StatsAttendanceTab,
    StatsBillingTab,
    StatsFunnelTab,
    StatsStudentsTab,
    StatsTabPayload,
    StatsUniformTab,
} from "./statsTypes";

// 시간대 없는 칼럼을 KST 시각으로 — 반드시 두 번 건다(한 번만 걸면 9시간 밀린다)
const kstNaive = (col: string) => `((${col} AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Seoul')`;
// 출석률 분모 = 기록 전체(기존 출결 화면과 같은 분모), 분자 = 출석 + 지각
const ATT_ALL = `('PRESENT','LATE','ABSENT','EXCUSED')`;
const ATT_OK = `('PRESENT','LATE')`;
// 수강료 청구에서 «살아 있는» 상태(취소·환불 제외), 미납 = PENDING·OVERDUE(청구·수납 화면과 같은 값)
const BILL_LIVE = `('PAID','PENDING','OVERDUE')`;
const BILL_UNPAID = `('PENDING','OVERDUE')`;

const num = (v: unknown) => {
    const n = Number(v ?? 0);
    return Number.isFinite(n) ? n : 0;
};

// ── 원생 1명 1줄 ─────────────────────────────────────────────────────────

type StudentBaseRaw = {
    id: string;
    name: string;
    gender: string | null;
    grade: string | null;
    branch: string | null;
    referral: string | null;
    uniform_status: string | null;
    uniform_received_ymd: string | null;
    birth_ymd: string | null;
    created_recent: boolean | null;
    created_label: string | null;
    parent_name: string | null;
    has_active: boolean | null;
    latest_status: string | null;
    first_ym: string | null;
    withdrawn_ym: string | null;
    locations: (string | null)[] | null;
    active_classes: string[] | null;
    active_programs: string[] | null;
};

export type StudentStatRow = {
    id: string;
    name: string;
    isActive: boolean;
    /** 현재 ACTIVE 없음 + 마지막 수강 줄이 퇴원 */
    isLeft: boolean;
    firstYm: string | null;
    leftYm: string | null;
    grade: GradeLabel;
    gradeNeedsCheck: boolean;
    gender: GenderLabel;
    branchKey: StatsBranchKey | "other";
    branchLabel: string;
    referral: string;
    uniformStatus: string;
    uniformGroup: UniformGroup;
    uniformReceivedYmd: string | null;
    classes: string[];
    programs: string[];
    createdRecent: boolean;
    createdLabel: string;
    parentName: string | null;
};

/**
 * 병합되지 않은 원생 전체를 1명 1줄로 읽는다(재원·퇴원 판정, 지점, 유니폼 등 원본 값).
 * 재원생 = ACTIVE 수강 1개 이상(원생 목록 «활성»과 같은 기준).
 */
export async function loadStudentStatRows(todayYmd = todayKst()): Promise<StudentStatRow[]> {
    const rows = await prisma.$queryRawUnsafe<StudentBaseRaw[]>(
        `SELECT s.id, s.name, s.gender, s.grade, s.branch,
                s."referralSource" AS referral,
                s."uniformStatus" AS uniform_status,
                TO_CHAR(s."uniformReceivedAt" AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS uniform_received_ymd,
                TO_CHAR(${kstNaive(`s."birthDate"`)}, 'YYYY-MM-DD') AS birth_ymd,
                (s."createdAt" >= (NOW() AT TIME ZONE 'UTC') - INTERVAL '7 days') AS created_recent,
                TO_CHAR(${kstNaive(`s."createdAt"`)}, 'MM-DD') AS created_label,
                u.name AS parent_name,
                ag.has_active, ag.latest_status, ag.first_ym, ag.withdrawn_ym,
                ag.locations, ag.active_classes, ag.active_programs
         FROM (SELECT * FROM "Student" s0 WHERE ${notMergedStudent("s0")}) s
         LEFT JOIN "User" u ON u.id = s."parentId"
         LEFT JOIN LATERAL (
             SELECT
                 COALESCE(BOOL_OR(${currentEnrollmentSql("e")}), FALSE) AS has_active,
                 (ARRAY_AGG(e.status ORDER BY e."createdAt" DESC))[1] AS latest_status,
                 TO_CHAR(MIN(${kstNaive(`e."createdAt"`)}), 'YYYY-MM') AS first_ym,
                 TO_CHAR(MAX(${kstNaive(`e."updatedAt"`)}) FILTER (WHERE e.status IN ('WITHDRAWN','DROPPED')), 'YYYY-MM') AS withdrawn_ym,
                 ARRAY_AGG(c.location ORDER BY (${currentEnrollmentSql("e")}) DESC, e."createdAt" DESC) AS locations,
                 ARRAY_REMOVE(ARRAY_AGG(c.name ORDER BY c.name) FILTER (WHERE ${currentEnrollmentSql("e")}), NULL) AS active_classes,
                 ARRAY_REMOVE(ARRAY_AGG(DISTINCT p.name) FILTER (WHERE ${currentEnrollmentSql("e")}), NULL) AS active_programs
             FROM "Enrollment" e
             JOIN "Class" c ON c.id = e."classId"
             LEFT JOIN "Program" p ON p.id = c."programId"
             WHERE e."studentId" = s.id
         ) ag ON TRUE`,
    );

    return rows.map((row) => {
        const grade = schoolGradeFromBirth(row.birth_ymd, todayYmd);
        // 지점: 원생에 적힌 값 → 없으면 반 장소에서 → 그래도 없으면 미지정
        const label = branchLabel(row.branch) || branchLabel(branchFromClassLocations(row.locations ?? []));
        const group = branchGroup(label);
        const isActive = Boolean(row.has_active);
        const isLeft = !isActive && (row.latest_status === "WITHDRAWN" || row.latest_status === "DROPPED");
        return {
            id: row.id,
            name: row.name,
            isActive,
            isLeft,
            firstYm: row.first_ym,
            leftYm: isLeft ? row.withdrawn_ym : null,
            grade,
            gradeNeedsCheck: gradeNeedsCheck(grade, row.grade),
            gender: normalizeGender(row.gender),
            branchKey: group.key,
            branchLabel: group.label,
            referral: normalizeReferral(row.referral),
            uniformStatus: String(row.uniform_status ?? "").trim(),
            uniformGroup: uniformGroup(row.uniform_status),
            uniformReceivedYmd: row.uniform_received_ymd,
            classes: row.active_classes ?? [],
            programs: row.active_programs ?? [],
            createdRecent: Boolean(row.created_recent),
            createdLabel: row.created_label ?? "",
            parentName: row.parent_name,
        };
    });
}

/** 지점 필터 — «전체»면 그대로 */
function inBranch(rows: StudentStatRow[], branch: StatsBranchKey) {
    return branch === "all" ? rows : rows.filter((r) => r.branchKey === branch);
}

/** 지점 필터를 SQL 에 넘길 원생 id 목록 — «전체»면 null(조건을 걸지 않는다) */
function branchIds(rows: StudentStatRow[], branch: StatsBranchKey): string[] | null {
    return branch === "all" ? null : rows.filter((r) => r.branchKey === branch).map((r) => r.id);
}

/** 신규(첫 수강 달)·퇴원(마지막 퇴원 달) 월별 — 원생 단위로 센다(수강 줄 단위 아님) */
export function buildFlowSeries(rows: StudentStatRow[], months: string[]): MonthFlow[] {
    return months.map((ym) => ({
        ym,
        label: monthShortLabel(ym),
        newCount: rows.filter((r) => r.firstYm === ym).length,
        leftCount: rows.filter((r) => r.leftYm === ym).length,
    }));
}

// ── 출결 월별 ───────────────────────────────────────────────────────────

type AttendanceMonthRaw = { ym: string; total: number; ok: number; present: number; late: number; absent: number; excused: number };

/** 월별 출결 집계(수업 날짜 KST 기준). ids 가 있으면 그 원생만 */
export async function loadAttendanceMonthly(fromYm: string, ids: string[] | null): Promise<AttendanceMonthRaw[]> {
    const params: unknown[] = [`${fromYm}-01`];
    let idFilter = "";
    if (ids) {
        params.push(ids);
        idFilter = `AND a."studentId" = ANY($2::text[])`;
    }
    const rows = await prisma.$queryRawUnsafe<AttendanceMonthRaw[]>(
        `SELECT TO_CHAR(${kstNaive("se.date")}, 'YYYY-MM') AS ym,
                COUNT(*) FILTER (WHERE a.status IN ${ATT_ALL})::int AS total,
                COUNT(*) FILTER (WHERE a.status IN ${ATT_OK})::int AS ok,
                COUNT(*) FILTER (WHERE a.status = 'PRESENT')::int AS present,
                COUNT(*) FILTER (WHERE a.status = 'LATE')::int AS late,
                COUNT(*) FILTER (WHERE a.status = 'ABSENT')::int AS absent,
                COUNT(*) FILTER (WHERE a.status = 'EXCUSED')::int AS excused
         FROM "Attendance" a
         JOIN "Session" se ON se.id = a."sessionId"
         WHERE ${kstNaive("se.date")} >= $1::timestamp ${idFilter}
         GROUP BY 1`,
        ...params,
    );
    return rows.map((r) => ({ ym: r.ym, total: num(r.total), ok: num(r.ok), present: num(r.present), late: num(r.late), absent: num(r.absent), excused: num(r.excused) }));
}

function attendanceSeries(raw: AttendanceMonthRaw[], months: string[]): MonthRate[] {
    const map = new Map(raw.map((r) => [r.ym, r]));
    return months.map((ym) => {
        const m = map.get(ym);
        return { ym, label: monthShortLabel(ym), rate: m ? rate(m.ok, m.total) : null, total: m?.total ?? 0 };
    });
}

// ── 수납 ────────────────────────────────────────────────────────────────

type BillingMonthRaw = {
    billed_count: number; billed_amount: number | string;
    paid_count: number; paid_amount: number | string;
    unpaid_count: number; unpaid_amount: number | string;
};

/** 그 달 수강료 청구(Payment.year/month, type MONTHLY, 취소·환불 제외) 집계 */
export async function loadBillingMonthly(ym: string, ids: string[] | null) {
    const params: unknown[] = [Number(ym.slice(0, 4)), Number(ym.slice(5, 7))];
    let idFilter = "";
    if (ids) {
        params.push(ids);
        idFilter = `AND p."studentId" = ANY($3::text[])`;
    }
    const rows = await prisma.$queryRawUnsafe<BillingMonthRaw[]>(
        `SELECT COUNT(*) FILTER (WHERE p.status IN ${BILL_LIVE})::int AS billed_count,
                COALESCE(SUM(p.amount) FILTER (WHERE p.status IN ${BILL_LIVE}), 0)::bigint AS billed_amount,
                COUNT(*) FILTER (WHERE p.status = 'PAID')::int AS paid_count,
                COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'PAID'), 0)::bigint AS paid_amount,
                COUNT(*) FILTER (WHERE p.status IN ${BILL_UNPAID})::int AS unpaid_count,
                COALESCE(SUM(p.amount) FILTER (WHERE p.status IN ${BILL_UNPAID}), 0)::bigint AS unpaid_amount
         FROM "Payment" p
         WHERE p.type = 'MONTHLY' AND p.year = $1 AND p.month = $2 ${idFilter}`,
        ...params,
    );
    const r = rows[0];
    return {
        billedCount: num(r?.billed_count),
        billedAmount: num(r?.billed_amount),
        paidCount: num(r?.paid_count),
        paidAmount: num(r?.paid_amount),
        unpaidCount: num(r?.unpaid_count),
        unpaidAmount: num(r?.unpaid_amount),
    };
}

/** 월별 매출 = 그 달(입금일 KST)에 수납 완료된 금액, 모든 종류(옛 대시보드 «매출»과 같은 뜻) */
async function loadRevenueMonthly(fromYm: string, ids: string[] | null) {
    const params: unknown[] = [`${fromYm}-01`];
    let idFilter = "";
    if (ids) {
        params.push(ids);
        idFilter = `AND p."studentId" = ANY($2::text[])`;
    }
    const rows = await prisma.$queryRawUnsafe<{ ym: string; amount: number | string; count: number }[]>(
        `SELECT TO_CHAR(${kstNaive(`p."paidDate"`)}, 'YYYY-MM') AS ym,
                COALESCE(SUM(p.amount), 0)::bigint AS amount, COUNT(*)::int AS count
         FROM "Payment" p
         WHERE p.status = 'PAID' AND p."paidDate" IS NOT NULL
           AND ${kstNaive(`p."paidDate"`)} >= $1::timestamp ${idFilter}
         GROUP BY 1`,
        ...params,
    );
    return new Map(rows.map((r) => [r.ym, { amount: num(r.amount), count: num(r.count) }]));
}

/** 누적 미납(이번 달까지 청구분) 합계와 상위 원생 — 미래 달 청구는 아직 미납이 아니라 뺀다 */
async function loadUnpaidOverview(currentYm: string, ids: string[] | null) {
    const ymNumber = Number(currentYm.replace("-", ""));
    const params: unknown[] = [ymNumber];
    let idFilter = "";
    if (ids) {
        params.push(ids);
        idFilter = `AND p."studentId" = ANY($2::text[])`;
    }
    const base = `FROM "Payment" p
         WHERE p.status IN ${BILL_UNPAID}
           AND COALESCE(p.year * 100 + p.month, TO_CHAR(${kstNaive(`p."dueDate"`)}, 'YYYYMM')::int) <= $1 ${idFilter}`;
    const [totals, top] = await Promise.all([
        prisma.$queryRawUnsafe<{ count: number; amount: number | string }[]>(
            `SELECT COUNT(*)::int AS count, COALESCE(SUM(p.amount), 0)::bigint AS amount ${base}`,
            ...params,
        ),
        // 청구(돈)는 병합된 원생 것도 숨기지 않는다(studentVisibility 규칙) — 이름만 붙인다
        prisma.$queryRawUnsafe<{ student_id: string; name: string | null; count: number; amount: number | string }[]>(
            `SELECT p."studentId" AS student_id, s.name, COUNT(*)::int AS count, COALESCE(SUM(p.amount), 0)::bigint AS amount
             ${base.replace(`FROM "Payment" p`, `FROM "Payment" p LEFT JOIN "Student" s ON s.id = p."studentId"`)}
             GROUP BY p."studentId", s.name
             ORDER BY amount DESC, s.name ASC
             LIMIT 10`,
            ...params,
        ),
    ]);
    return {
        overdue: { count: num(totals[0]?.count), amount: num(totals[0]?.amount) },
        topUnpaid: top.map((t) => ({ studentId: t.student_id, name: t.name ?? "(이름 없음)", count: num(t.count), amount: num(t.amount) })),
    };
}

// ── 유입·전환 ───────────────────────────────────────────────────────────

export type ApplySourceRange = "ALL" | "30D" | "THIS_MONTH";

/**
 * 기간 시작 시각(ISO). «이번 달»은 KST 1일 0시 — 서버 시계(getMonth)로 자르면 매달 1일 00~09시에 지난달이 된다.
 * (2026-11-13 adminReadPayloads 의 옛 sourceStatsStartIso 결함을 고쳐 여기로 모았다)
 */
export function funnelStartIso(range: ApplySourceRange, nowMs = Date.now()): string | null {
    if (range === "ALL") return null;
    if (range === "THIS_MONTH") return `${todayKst(nowMs).slice(0, 7)}-01T00:00:00+09:00`;
    return new Date(nowMs - 30 * 24 * 60 * 60 * 1000).toISOString();
}

type ApplySourceRaw = {
    source: string | null;
    trial_total: number | string | null;
    trial_scheduled: number | string | null;
    trial_attended: number | string | null;
    trial_converted: number | string | null;
    enroll_total: number | string | null;
    enroll_pending: number | string | null;
    enroll_approved: number | string | null;
    enroll_closed: number | string | null;
    latest_at: string | Date | null;
};

/** 유입경로별 체험·수강신청 집계(신청 화면 «유입 통계»와 같은 쿼리 — 그 화면에서 옮겨 왔다) */
export async function loadApplySourceStats(range: ApplySourceRange) {
    const startIso = funnelStartIso(range);
    // TrialLead·EnrollmentApplication 의 createdAt 은 timestamptz → 시간대 한 번(ISO 그대로 비교)
    const whereClause = startIso ? `WHERE "createdAt" >= $1::timestamptz` : "";
    const params = startIso ? [startIso] : [];
    const rows = await prisma.$queryRawUnsafe<ApplySourceRaw[]>(
        `WITH trial AS (
            SELECT
                COALESCE(NULLIF(TRIM(source), ''), 'UNKNOWN') AS source,
                COUNT(*)::int AS trial_total,
                COUNT(*) FILTER (WHERE status = 'SCHEDULED')::int AS trial_scheduled,
                COUNT(*) FILTER (WHERE status = 'ATTENDED')::int AS trial_attended,
                COUNT(*) FILTER (WHERE status = 'CONVERTED')::int AS trial_converted,
                MAX("createdAt") AS latest_at
            FROM "TrialLead"
            ${whereClause}
            GROUP BY 1
        ),
        enroll AS (
            SELECT
                COALESCE(NULLIF(TRIM("referralSource"), ''), 'UNKNOWN') AS source,
                COUNT(*)::int AS enroll_total,
                COUNT(*) FILTER (WHERE status = 'PENDING')::int AS enroll_pending,
                COUNT(*) FILTER (WHERE status = 'APPROVED')::int AS enroll_approved,
                COUNT(*) FILTER (WHERE status IN ('REJECTED', 'CANCELLED'))::int AS enroll_closed,
                MAX("createdAt") AS latest_at
            FROM "EnrollmentApplication"
            ${whereClause}
            GROUP BY 1
        ),
        sources AS (
            SELECT source FROM trial
            UNION
            SELECT source FROM enroll
        )
        SELECT
            s.source,
            COALESCE(t.trial_total, 0)::int AS trial_total,
            COALESCE(t.trial_scheduled, 0)::int AS trial_scheduled,
            COALESCE(t.trial_attended, 0)::int AS trial_attended,
            COALESCE(t.trial_converted, 0)::int AS trial_converted,
            COALESCE(e.enroll_total, 0)::int AS enroll_total,
            COALESCE(e.enroll_pending, 0)::int AS enroll_pending,
            COALESCE(e.enroll_approved, 0)::int AS enroll_approved,
            COALESCE(e.enroll_closed, 0)::int AS enroll_closed,
            GREATEST(t.latest_at, e.latest_at) AS latest_at
        FROM sources s
        LEFT JOIN trial t ON t.source = s.source
        LEFT JOIN enroll e ON e.source = s.source
        ORDER BY (COALESCE(t.trial_total, 0) + COALESCE(e.enroll_total, 0)) DESC, s.source ASC`,
        ...params,
    );

    const mappedRows: SourceStatsRow[] = rows.map((row) => {
        const trialTotal = num(row.trial_total);
        const enrollTotal = num(row.enroll_total);
        const trialConverted = num(row.trial_converted);
        const enrollApproved = num(row.enroll_approved);
        const total = trialTotal + enrollTotal;
        const convertedTotal = trialConverted + enrollApproved;
        return {
            source: String(row.source ?? "UNKNOWN"),
            total,
            trialTotal,
            trialScheduled: num(row.trial_scheduled),
            trialAttended: num(row.trial_attended),
            trialConverted,
            enrollTotal,
            enrollPending: num(row.enroll_pending),
            enrollApproved,
            enrollClosed: num(row.enroll_closed),
            conversionRate: total > 0 ? Math.round((convertedTotal / total) * 100) : 0,
            trialAttendRate: trialTotal > 0 ? Math.round((num(row.trial_attended) / trialTotal) * 100) : 0,
            enrollApproveRate: enrollTotal > 0 ? Math.round((enrollApproved / enrollTotal) * 100) : 0,
            latestAt: row.latest_at ?? null,
        };
    });

    const totals = mappedRows.reduce(
        (acc, row) => {
            acc.total += row.total;
            acc.trialTotal += row.trialTotal;
            acc.trialAttended += row.trialAttended;
            acc.trialConverted += row.trialConverted;
            acc.enrollTotal += row.enrollTotal;
            acc.enrollApproved += row.enrollApproved;
            return acc;
        },
        { total: 0, trialTotal: 0, trialAttended: 0, trialConverted: 0, enrollTotal: 0, enrollApproved: 0, conversionRate: 0, trialAttendRate: 0, enrollApproveRate: 0 },
    );
    const convertedTotal = totals.trialConverted + totals.enrollApproved;
    totals.conversionRate = totals.total > 0 ? Math.round((convertedTotal / totals.total) * 100) : 0;
    totals.trialAttendRate = totals.trialTotal > 0 ? Math.round((totals.trialAttended / totals.trialTotal) * 100) : 0;
    totals.enrollApproveRate = totals.enrollTotal > 0 ? Math.round((totals.enrollApproved / totals.enrollTotal) * 100) : 0;

    return { range, generatedAt: new Date().toISOString(), rows: mappedRows, totals };
}

type FunnelRaw = {
    inquiries: number; attended: number; converted: number;
    s_new: number; s_contacted: number; s_scheduled: number; s_attended: number; s_converted: number; s_lost: number; s_cancelled: number;
    applications: number; approved: number;
};

/** 체험 단계(문의 → 체험 참석 → 등록)와 수강신청 — 기간 시작 이후 접수분 */
async function loadFunnelCounts(startIso: string | null) {
    const where = startIso ? `WHERE "createdAt" >= $1::timestamptz` : "";
    const params = startIso ? [startIso] : [];
    const rows = await prisma.$queryRawUnsafe<FunnelRaw[]>(
        `WITH t AS (SELECT * FROM "TrialLead" ${where}),
              a AS (SELECT * FROM "EnrollmentApplication" ${where})
         SELECT
            (SELECT COUNT(*)::int FROM t) AS inquiries,
            (SELECT COUNT(*)::int FROM t WHERE status IN ('ATTENDED','CONVERTED') OR "attendedDate" IS NOT NULL) AS attended,
            (SELECT COUNT(*)::int FROM t WHERE status = 'CONVERTED') AS converted,
            (SELECT COUNT(*)::int FROM t WHERE status = 'NEW') AS s_new,
            (SELECT COUNT(*)::int FROM t WHERE status = 'CONTACTED') AS s_contacted,
            (SELECT COUNT(*)::int FROM t WHERE status = 'SCHEDULED') AS s_scheduled,
            (SELECT COUNT(*)::int FROM t WHERE status = 'ATTENDED') AS s_attended,
            (SELECT COUNT(*)::int FROM t WHERE status = 'CONVERTED') AS s_converted,
            (SELECT COUNT(*)::int FROM t WHERE status = 'LOST') AS s_lost,
            (SELECT COUNT(*)::int FROM t WHERE status = 'CANCELLED') AS s_cancelled,
            (SELECT COUNT(*)::int FROM a) AS applications,
            (SELECT COUNT(*)::int FROM a WHERE status = 'APPROVED') AS approved`,
        ...params,
    );
    return rows[0];
}

// ── 대시보드 카드 6개 ──────────────────────────────────────────────────

type DashboardSqlRaw = {
    bill: { billed_amount: number; paid_amount: number; unpaid_count: number; unpaid_amount: number } | null;
    att: { ym: string; total: number; ok: number }[] | null;
    trial: { inquiries: number; attended: number; converted: number } | null;
};

/**
 * 대시보드 맨 위 카드 6개.
 * 수납·출석·체험 숫자는 SQL 한 문장, 원생 숫자(재원·신규/퇴원·유니폼)는 원생 1줄 조회를 함께(Promise.all) 읽는다.
 * (지점은 «적힌 값 → 반 장소» 규칙이 TS 한 곳에 있어 SQL 로 다시 쓰지 않는다)
 */
export async function loadDashboardSummary(): Promise<DashboardSummary> {
    const today = todayKst();
    const currentYm = today.slice(0, 7);
    const months6 = lastMonths(currentYm, 6);
    const [students, sqlRows] = await Promise.all([
        loadStudentStatRows(today),
        prisma.$queryRawUnsafe<DashboardSqlRaw[]>(
            `WITH bill AS (
                SELECT COALESCE(SUM(p.amount) FILTER (WHERE p.status IN ${BILL_LIVE}), 0)::bigint AS billed_amount,
                       COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'PAID'), 0)::bigint AS paid_amount,
                       COUNT(*) FILTER (WHERE p.status IN ${BILL_UNPAID})::int AS unpaid_count,
                       COALESCE(SUM(p.amount) FILTER (WHERE p.status IN ${BILL_UNPAID}), 0)::bigint AS unpaid_amount
                FROM "Payment" p
                WHERE p.type = 'MONTHLY' AND p.year = $1 AND p.month = $2
             ),
             att AS (
                SELECT TO_CHAR(${kstNaive("se.date")}, 'YYYY-MM') AS ym,
                       COUNT(*) FILTER (WHERE a.status IN ${ATT_ALL})::int AS total,
                       COUNT(*) FILTER (WHERE a.status IN ${ATT_OK})::int AS ok
                FROM "Attendance" a
                JOIN "Session" se ON se.id = a."sessionId"
                WHERE ${kstNaive("se.date")} >= $3::timestamp
                GROUP BY 1
             ),
             trial AS (
                SELECT COUNT(*)::int AS inquiries,
                       COUNT(*) FILTER (WHERE status IN ('ATTENDED','CONVERTED') OR "attendedDate" IS NOT NULL)::int AS attended,
                       COUNT(*) FILTER (WHERE status = 'CONVERTED')::int AS converted
                FROM "TrialLead"
                WHERE "createdAt" >= NOW() - INTERVAL '30 days'
             )
             SELECT (SELECT row_to_json(bill) FROM bill) AS bill,
                    (SELECT COALESCE(json_agg(att), '[]'::json) FROM att) AS att,
                    (SELECT row_to_json(trial) FROM trial) AS trial`,
            Number(currentYm.slice(0, 4)),
            Number(currentYm.slice(5, 7)),
            `${months6[0]}-01`,
        ),
    ]);

    const raw = sqlRows[0] ?? { bill: null, att: [], trial: null };
    const active = students.filter((s) => s.isActive);
    const attSeries = attendanceSeries(
        (raw.att ?? []).map((r) => ({ ym: r.ym, total: num(r.total), ok: num(r.ok), present: 0, late: 0, absent: 0, excused: 0 })),
        months6,
    );
    const thisAtt = attSeries[attSeries.length - 1]?.rate ?? null;
    const prevAtt = attSeries[attSeries.length - 2]?.rate ?? null;
    const flow = buildFlowSeries(students, months6);
    const uniformCounts = countBy(active.map((s) => s.uniformGroup), UNIFORM_GROUPS);
    const owned = active.filter((s) => s.uniformGroup === "보유").length;
    const billed = num(raw.bill?.billed_amount);
    const paid = num(raw.bill?.paid_amount);
    const trial = { inquiries: num(raw.trial?.inquiries), attended: num(raw.trial?.attended), converted: num(raw.trial?.converted) };

    return {
        currentYm,
        students: { active: active.length, byBranch: countBy(active.map((s) => s.branchLabel), ["다산2호점", "평내호평점"]) },
        billing: { rateAmount: rate(paid, billed), paidAmount: paid, billedAmount: billed, unpaidCount: num(raw.bill?.unpaid_count), unpaidAmount: num(raw.bill?.unpaid_amount) },
        attendance: { rate: thisAtt, prevRate: prevAtt, diff: diffPoint(thisAtt, prevAtt), series: attSeries },
        flow: { newCount: flow[flow.length - 1]?.newCount ?? 0, leftCount: flow[flow.length - 1]?.leftCount ?? 0, series: flow },
        funnel: { ...trial, rate: rate(trial.converted, trial.inquiries) },
        uniform: {
            rate: rate(owned, active.length),
            owned,
            total: active.length,
            needsCheck: active.filter((s) => s.uniformGroup === "확인 필요").length,
            segments: uniformCounts,
        },
    };
}

// ── 통계 탭 ────────────────────────────────────────────────────────────

async function loadStudentsTab(branch: StatsBranchKey, period: string): Promise<StatsStudentsTab> {
    const today = todayKst();
    const currentYm = today.slice(0, 7);
    const all = inBranch(await loadStudentStatRows(today), branch);
    const active = all.filter((s) => s.isActive);
    const flow = buildFlowSeries(all, lastMonths(currentYm, periodMonths(period)));
    const firstYms = all.map((s) => s.firstYm).filter((v): v is string => Boolean(v)).sort();

    const genderByBand = GRADE_BANDS.map((band) => {
        const inBand = active.filter((s) => gradeBandOf(s.grade) === band);
        return {
            band,
            male: inBand.filter((s) => s.gender === "남").length,
            female: inBand.filter((s) => s.gender === "여").length,
            unknown: inBand.filter((s) => s.gender === "미입력").length,
        };
    }).filter((row) => row.male + row.female + row.unknown > 0);

    return {
        tab: "students",
        active: active.length,
        newThisMonth: all.filter((s) => s.firstYm === currentYm).length,
        leftThisMonth: all.filter((s) => s.leftYm === currentYm).length,
        gradeNeedsCheck: active.filter((s) => s.gradeNeedsCheck).length,
        grades: countBy(active.map((s) => s.grade), GRADE_LABELS),
        genderTotal: {
            male: active.filter((s) => s.gender === "남").length,
            female: active.filter((s) => s.gender === "여").length,
            unknown: active.filter((s) => s.gender === "미입력").length,
        },
        genderByBand,
        branches: countBy(active.map((s) => s.branchLabel), ["다산2호점", "평내호평점"]),
        flow,
        flowSince: firstYms[0] ?? null,
        programs: countBy(active.flatMap((s) => s.programs)),
        // 최근 7일 새로 등록한 원생(옛 대시보드 «신규 원생» 명단 그대로 — 원생 등록일 기준, 최대 10명)
        recent: all
            .filter((s) => s.createdRecent)
            .sort((a, b) => b.createdLabel.localeCompare(a.createdLabel))
            .slice(0, 10)
            .map((s) => ({ id: s.id, name: s.name, parentName: s.parentName, createdLabel: s.createdLabel })),
    };
}

async function loadFunnelTab(branch: StatsBranchKey, period: string): Promise<StatsFunnelTab> {
    const range: ApplySourceRange = period === "all" ? "ALL" : period === "month" ? "THIS_MONTH" : "30D";
    const [students, funnel, sources] = await Promise.all([
        loadStudentStatRows(),
        loadFunnelCounts(funnelStartIso(range)),
        loadApplySourceStats(range),
    ]);
    // 체험 문의·신청서에는 지점이 없다 → 지점 필터는 «재원생 가입경로»에만 건다
    const active = inBranch(students, branch).filter((s) => s.isActive);
    return {
        tab: "funnel",
        inquiries: num(funnel?.inquiries),
        attended: num(funnel?.attended),
        converted: num(funnel?.converted),
        conversionRate: rate(num(funnel?.converted), num(funnel?.inquiries)),
        applications: num(funnel?.applications),
        approved: num(funnel?.approved),
        trialStatus: {
            NEW: num(funnel?.s_new),
            CONTACTED: num(funnel?.s_contacted),
            SCHEDULED: num(funnel?.s_scheduled),
            ATTENDED: num(funnel?.s_attended),
            CONVERTED: num(funnel?.s_converted),
            LOST: num(funnel?.s_lost),
            CANCELLED: num(funnel?.s_cancelled),
        },
        sources: sources.rows,
        referral: countBy(active.map((s) => s.referral)),
        referralTotal: active.length,
    };
}

async function loadAttendanceTab(branch: StatsBranchKey, period: string): Promise<StatsAttendanceTab> {
    const currentYm = todayKst().slice(0, 7);
    const months = lastMonths(currentYm, periodMonths(period));
    const students = await loadStudentStatRows();
    const ids = branchIds(students, branch);
    const [att, capacity, locations, coaches, scaleRows] = await Promise.all([
        loadAttendanceMonthly(months[0], ids),
        getClassCapacityInfo(),
        prisma.$queryRawUnsafe<{ id: string; location: string | null }[]>(`SELECT id, location FROM "Class"`),
        getCoachWorkload(),
        prisma.$queryRawUnsafe<{ programs: number; classes: number; coaches: number }[]>(
            `SELECT (SELECT COUNT(*)::int FROM "Program" WHERE "deletedAt" IS NULL) AS programs,
                    (SELECT COUNT(*)::int FROM "Class") AS classes,
                    (SELECT COUNT(*)::int FROM "Coach") AS coaches`,
        ),
    ]);
    const series = attendanceSeries(att, months);
    const thisMonth = att.find((r) => r.ym === currentYm);
    const thisRate = series[series.length - 1]?.rate ?? null;
    const prevRate = series[series.length - 2]?.rate ?? null;
    // 반 지점 = 반 장소에서(원생 지점과 같은 규칙). 반 정원·인원은 기존 getClassCapacityInfo 그대로
    const locationById = new Map(locations.map((l) => [l.id, l.location]));
    const classes = capacity
        .filter((c) => branch === "all" || branchGroup(branchLabel(branchFromClassLocation(locationById.get(c.id)))).key === branch)
        .map((c) => ({ id: c.id, name: c.name, dayOfWeek: c.dayOfWeek, startTime: c.startTime, capacity: c.capacity, enrolled: c.enrolled, waiting: c.waiting }));

    return {
        tab: "attendance",
        rate: thisRate,
        prevRate,
        diff: diffPoint(thisRate, prevRate),
        present: thisMonth?.present ?? 0,
        late: thisMonth?.late ?? 0,
        absent: thisMonth?.absent ?? 0,
        excused: thisMonth?.excused ?? 0,
        total: thisMonth?.total ?? 0,
        waiting: classes.reduce((sum, c) => sum + c.waiting, 0),
        series,
        classes,
        coaches: coaches.map((c) => ({ id: c.id, name: c.name, classCount: c.classCount, studentCount: c.studentCount })),
        scale: { programs: num(scaleRows[0]?.programs), classes: num(scaleRows[0]?.classes), coaches: num(scaleRows[0]?.coaches) },
    };
}

async function loadBillingTab(branch: StatsBranchKey, period: string): Promise<StatsBillingTab> {
    const currentYm = todayKst().slice(0, 7);
    const months = lastMonths(currentYm, periodMonths(period));
    const ids = branch === "all" ? null : branchIds(await loadStudentStatRows(), branch);
    const [bill, revenueMap, unpaid] = await Promise.all([
        loadBillingMonthly(currentYm, ids),
        loadRevenueMonthly(months[0], ids),
        loadUnpaidOverview(currentYm, ids),
    ]);
    const revenue = revenueMap.get(currentYm)?.amount ?? 0;
    const prevRevenue = revenueMap.get(addMonthsYm(currentYm, -1))?.amount ?? 0;
    return {
        tab: "billing",
        ym: currentYm,
        ...bill,
        rateCount: rate(bill.paidCount, bill.billedCount),
        rateAmount: rate(bill.paidAmount, bill.billedAmount),
        revenue,
        prevRevenue,
        revenueDiffPct: prevRevenue > 0 ? Math.round(((revenue - prevRevenue) / prevRevenue) * 100) : null,
        revenueSeries: months.map((ym) => ({ ym, label: monthShortLabel(ym), amount: revenueMap.get(ym)?.amount ?? 0, count: revenueMap.get(ym)?.count ?? 0 })),
        ...unpaid,
    };
}

async function loadUniformTab(branch: StatsBranchKey): Promise<StatsUniformTab> {
    const students = inBranch(await loadStudentStatRows(), branch);
    const active = students.filter((s) => s.isActive);
    const names = [...new Set(active.map((s) => s.name.trim()).filter(Boolean))];
    const grantParams: unknown[] = [];
    let grantFilter = "";
    if (branch !== "all") {
        grantParams.push(students.map((s) => s.id));
        grantFilter = `WHERE g."studentId" = ANY($1::text[])`;
    }
    const [grants, sizes] = await Promise.all([
        prisma.$queryRawUnsafe<{ status: string; count: number }[]>(
            `SELECT g.status, COUNT(*)::int AS count FROM "UniformFreeGrant" g ${grantFilter} GROUP BY 1`,
            ...grantParams,
        ),
        // 사이즈는 원생 칸에 없다 → 주문서 품목의 «학생 이름»이 재원생 이름과 같은 것만(주문 기준)
        prisma.$queryRawUnsafe<{ top: string | null; bottom: string | null; qty: number; student: string }[]>(
            `SELECT NULLIF(TRIM(i."topSize"), '') AS top, NULLIF(TRIM(i."bottomSize"), '') AS bottom,
                    SUM(i.quantity)::int AS qty, TRIM(i."studentName") AS student
             FROM "UniformOrderItem" i
             JOIN "UniformOrder" o ON o.id = i."uniformOrderId"
             WHERE o."orderStatus" <> 'CANCELED' AND TRIM(i."studentName") = ANY($1::text[])
             GROUP BY 1, 2, 4`,
            names,
        ),
    ]);

    const ownedOf = (rows: StudentStatRow[]) => rows.filter((s) => s.uniformGroup === "보유").length;
    const ratioBy = (keyOf: (s: StudentStatRow) => string, order: readonly string[]) =>
        countBy(active.map(keyOf), order).map(({ label, count }) => {
            const owned = ownedOf(active.filter((s) => keyOf(s) === label));
            return { label, owned, total: count, rate: rate(owned, count) };
        });
    const sizeCount = (pick: "top" | "bottom") => {
        const map = new Map<string, number>();
        for (const row of sizes) {
            const key = row[pick];
            if (key) map.set(key, (map.get(key) ?? 0) + num(row.qty));
        }
        return [...map.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => sizeOrder(a.label) - sizeOrder(b.label) || a.label.localeCompare(b.label, "ko"));
    };
    const grantCount = (status: string) => num(grants.find((g) => g.status === status)?.count);
    const owned = ownedOf(active);

    return {
        tab: "uniform",
        total: active.length,
        owned,
        rate: rate(owned, active.length),
        segments: countBy(active.map((s) => s.uniformGroup), UNIFORM_GROUPS),
        byBranch: ratioBy((s) => s.branchLabel, ["다산2호점", "평내호평점"]),
        byGrade: ratioBy((s) => s.grade, GRADE_LABELS),
        grants: { issued: grantCount("ISSUED"), used: grantCount("USED"), revoked: grantCount("REVOKED") },
        list: active
            .map((s) => ({
                id: s.id,
                name: s.name,
                classes: s.classes.join(", "),
                branch: s.branchLabel,
                status: s.uniformStatus || "미입력",
                group: s.uniformGroup,
                receivedYmd: s.uniformReceivedYmd,
            }))
            .sort((a, b) => UNIFORM_GROUPS.indexOf(a.group as UniformGroup) - UNIFORM_GROUPS.indexOf(b.group as UniformGroup) || a.name.localeCompare(b.name, "ko")),
        sizes: { top: sizeCount("top"), bottom: sizeCount("bottom"), matchedStudents: new Set(sizes.map((s) => s.student)).size },
    };
}

/** 사이즈 글(«130»·«S»·«XL») 정렬 — 숫자는 숫자 순, 글자는 S < M < L < XL 순 */
function sizeOrder(label: string): number {
    const n = Number(label.replace(/[^0-9]/g, ""));
    if (/^\d+$/.test(label.trim())) return n;
    const letters = ["XXS", "XS", "S", "M", "L", "XL", "XXL", "2XL", "3XL"];
    const at = letters.indexOf(label.trim().toUpperCase());
    return at >= 0 ? 1000 + at : 2000;
}

/** 통계 탭 하나만 읽는다(탭을 바꾸면 그 탭만 서버가 읽는다) */
export async function loadStatsTab(tab: StatsTabKey, branch: StatsBranchKey, period: string): Promise<StatsTabPayload> {
    switch (tab) {
        case "funnel":
            return loadFunnelTab(branch, period);
        case "attendance":
            return loadAttendanceTab(branch, period);
        case "billing":
            return loadBillingTab(branch, period);
        case "uniform":
            return loadUniformTab(branch);
        case "students":
        default:
            return loadStudentsTab(branch, period);
    }
}

