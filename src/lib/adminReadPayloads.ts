import { getStaffClassAssignments, getStaffInviteLastSends, getStaffRoleGrantUsers } from "@/lib/staff/staffPanelData";
import { unstable_cache } from "next/cache";
import { kstDow, todayKst } from "@/lib/datetime/kst";
import { getInstagramRuntimeStatus } from "@/lib/instagram";
import { getPaymentProviderPublicStatus } from "@/lib/payment-ledger";
import { getScheduleSlotAdminData } from "@/lib/scheduleSlotPayload";
import { notMergedStudent } from "@/lib/studentVisibility";
import { currentEnrollmentSql } from "@/lib/enrollment/commencement";
import {
    getAcademySettings,
    getAttendanceClassOptions,
    getAnnualEvents,
    getAllCoaches,
    getAllFaqs,
    getAllFeedbacks,
    getAllRequests,
    getAllTestimonials,
    getBillingTemplates,
    getClasses,
    getClassCapacityInfo,
    getClassSlotOverrides,
    getCoaches,
    getCoachWorkload,
    getCustomClassSlots,
    getDashboardExtendedStats,
    getDashboardStats,
    getEnrollApplications,
    getEnrollApplicationStats,
    getEnrollmentTrend,
    getPendingRequestCount,
    getRecentPendingRequests,
    getGalleryPosts,
    getMakeupSessions,
    getMonthlyAttendanceRate,
    getMonthlyRevenue,
    getPayments,
    getPaymentSummary,
    getPaymentCollectionRate,
    getNotices,
    getPrograms,
    getSheetSlotCache,
    getSessionsForReportList,
    getSmsTemplates,
    getStaffInvitations,
    getStaffUsers,
    getStudents,
    getTrialLeads,
    getTrialStats,
    getWaitlistAll,
} from "@/lib/queries";
import { prisma } from "@/lib/prisma";
import { readPendingSocialPostDrafts } from "@/lib/socialDrafts";

const DASHBOARD_MONTHS = 6;
const ADMIN_LIST_PAGE_SIZE = 50;
const ADMIN_LIST_MAX_PAGE_SIZE = 100;
const ADMIN_GALLERY_PAGE_SIZE = 24;
const ADMIN_NOTICES_PAGE_SIZE = 30;
const ADMIN_REQUESTS_PAGE_SIZE = 30;
const ADMIN_REQUEST_STATUSES = ["PENDING", "CONFIRMED", "COMPLETED", "REJECTED"] as const;

type AdminListPayloadOptions = {
    limit?: number;
    offset?: number;
};

type AdminRequestsPayloadOptions = AdminListPayloadOptions & {
    statusFilter?: string;
};

function normalizeAdminListPayloadOptions(options?: AdminListPayloadOptions) {
    const limit =
        typeof options?.limit === "number" && Number.isFinite(options.limit) && options.limit > 0
            ? Math.min(Math.floor(options.limit), ADMIN_LIST_MAX_PAGE_SIZE)
            : ADMIN_LIST_PAGE_SIZE;
    const offset =
        typeof options?.offset === "number" && Number.isFinite(options.offset) && options.offset > 0
            ? Math.floor(options.offset)
            : 0;

    return { limit, offset };
}

function buildListPagination({
    limit,
    offset,
    returned,
    hasMore,
    total,
}: {
    limit: number;
    offset: number;
    returned: number;
    hasMore: boolean;
    total: number;
}) {
    return {
        limit,
        offset,
        returned,
        total,
        hasMore,
        nextOffset: hasMore ? offset + returned : null,
        partial: hasMore || offset > 0 || returned < total,
    };
}

type AdminScheduleSettingsPayload = {
    googleSheetsScheduleUrl?: string | null;
    googlesheetsscheduleurl?: string | null;
} | null;

type AdminTodayClassRow = {
    id: string;
    name: string;
    startTime?: string | null;
    starttime?: string | null;
    endTime?: string | null;
    endtime?: string | null;
    capacity?: number | string | null;
    program_name?: string | null;
    enrolled?: number | string | null;
};

type DashboardTodayClassItem = {
    id?: string;
    name?: string;
    startTime?: string | null;
    endTime?: string | null;
    capacity?: number | string | null;
    programName?: string | null;
    enrolled?: number | string | null;
};

type RecentStudentRow = {
    id: string;
    name: string;
    createdAt?: Date | string | null;
    createdat?: Date | string | null;
    parent_name?: string | null;
};

type GallerySettingsPayload = {
    instagramUrl?: string | null;
    instagramBusinessAccountId?: string | null;
    instagramAutoPublishEnabled?: boolean | null;
};

function getMonthLabels(date = new Date()) {
    return Array.from({ length: DASHBOARD_MONTHS }, (_, index) => {
        const month = new Date(date.getFullYear(), date.getMonth() - (DASHBOARD_MONTHS - 1 - index), 1);
        return `${month.getMonth() + 1}월`;
    });
}

// 서버(Vercel)는 UTC 로 돌기 때문에 getDay() 를 쓰면 KST 00~09시에 전날 요일이 나온다.
// 요일은 반드시 KST 달력 날짜에서 뽑는다.
function getTodayLabel(ymd = todayKst()) {
    const days = ["일", "월", "화", "수", "목", "금", "토"];
    return `${days[kstDow(ymd)]}요일`;
}

function getEmptyExtendedStats(date = new Date()) {
    const monthlyRevenue = getMonthLabels(date).map((month) => ({ month, amount: 0 }));
    const monthlyAttendance = getMonthLabels(date).map((month) => ({ month, rate: 0 }));

    return {
        thisMonthRevenue: 0,
        lastMonthRevenue: 0,
        attendanceRate: 0,
        unpaidCount: 0,
        unpaidAmount: 0,
        monthlyRevenue,
        monthlyAttendance,
        programStudents: [],
    };
}

async function getTodayClasses() {
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const today = days[kstDow(todayKst())]; // KST 기준 오늘 요일 (서버 시간대 개입 없음)

    try {
        const rows = await prisma.$queryRawUnsafe<AdminTodayClassRow[]>(
            `SELECT c.id, c.name, c."startTime", c."endTime", c.capacity,
                    p.name AS program_name,
                    (SELECT COUNT(*)::int FROM "Enrollment" e WHERE e."classId" = c.id AND e.status = 'ACTIVE') AS enrolled
             FROM "Class" c
             LEFT JOIN "Program" p ON c."programId" = p.id
             WHERE c."dayOfWeek" = $1
             ORDER BY c."startTime" ASC`,
            today,
        );

        return rows.map((row) => ({
            id: row.id,
            name: row.name,
            startTime: row.startTime ?? row.starttime,
            endTime: row.endTime ?? row.endtime,
            capacity: Number(row.capacity ?? 0),
            programName: row.program_name,
            enrolled: Number(row.enrolled ?? 0),
        }));
    } catch {
        return [];
    }
}

type DashboardPrimaryRow = {
    studentCount: number | null;
    programCount: number | null;
    coachCount: number | null;
    classCount: number | null;
    pendingCount: number | null;
    enrollPending: number | null;
    enrollApproved: number | null;
    enrollRejected: number | null;
    enrollCancelled: number | null;
    enrollTotal: number | null;
    todayClasses: unknown;
    todayclasses?: unknown;
};

function readJsonArray<T>(value: unknown): T[] {
    if (Array.isArray(value)) return value as T[];
    if (typeof value !== "string") return [];

    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

async function loadDashboardPrimaryPayload() {
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const today = days[kstDow(todayKst())]; // KST 기준 오늘 요일 (서버 시간대 개입 없음)

    try {
        const rows = await prisma.$queryRawUnsafe<DashboardPrimaryRow[]>(
            `SELECT
                (SELECT COUNT(*)::int FROM "Student" s WHERE ${notMergedStudent("s")}) AS "studentCount",
                (SELECT COUNT(*)::int FROM "Program") AS "programCount",
                (SELECT COUNT(*)::int FROM "Coach") AS "coachCount",
                (SELECT COUNT(*)::int FROM "Class") AS "classCount",
                (SELECT COUNT(*)::int FROM "ParentRequest" WHERE status = 'PENDING') AS "pendingCount",
                (SELECT COUNT(*)::int FROM "EnrollmentApplication" WHERE status = 'PENDING') AS "enrollPending",
                (SELECT COUNT(*)::int FROM "EnrollmentApplication" WHERE status = 'APPROVED') AS "enrollApproved",
                (SELECT COUNT(*)::int FROM "EnrollmentApplication" WHERE status = 'REJECTED') AS "enrollRejected",
                (SELECT COUNT(*)::int FROM "EnrollmentApplication" WHERE status = 'CANCELLED') AS "enrollCancelled",
                (SELECT COUNT(*)::int FROM "EnrollmentApplication") AS "enrollTotal",
                (
                    SELECT COALESCE(
                        json_agg(
                            json_build_object(
                                'id', tc.id,
                                'name', tc.name,
                                'startTime', tc."startTime",
                                'endTime', tc."endTime",
                                'capacity', tc.capacity,
                                'programName', tc."programName",
                                'enrolled', tc.enrolled
                            )
                            ORDER BY tc."startTime" ASC
                        ),
                        '[]'::json
                    )
                    FROM (
                        SELECT c.id, c.name, c."startTime", c."endTime", c.capacity,
                               p.name AS "programName",
                               (
                                   SELECT COUNT(*)::int
                                   FROM "Enrollment" e
                                   WHERE e."classId" = c.id AND e.status = 'ACTIVE'
                               ) AS enrolled
                        FROM "Class" c
                        LEFT JOIN "Program" p ON c."programId" = p.id
                        WHERE c."dayOfWeek" = $1
                        ORDER BY c."startTime" ASC
                    ) tc
                ) AS "todayClasses"`,
            today,
        );

        const row = rows[0];
        if (!row) throw new Error("No dashboard primary row returned");

        const todayClasses = readJsonArray<DashboardTodayClassItem>(row.todayClasses ?? row.todayclasses).map((item) => ({
            id: String(item.id ?? ""),
            name: String(item.name ?? ""),
            startTime: item.startTime ?? null,
            endTime: item.endTime ?? null,
            capacity: Number(item.capacity ?? 0),
            programName: item.programName ?? null,
            enrolled: Number(item.enrolled ?? 0),
        }));

        return {
            stats: {
                studentCount: Number(row.studentCount ?? 0),
                programCount: Number(row.programCount ?? 0),
                coachCount: Number(row.coachCount ?? 0),
                classCount: Number(row.classCount ?? 0),
            },
            pendingRequests: [],
            pendingCount: Number(row.pendingCount ?? 0),
            enrollStats: {
                PENDING: Number(row.enrollPending ?? 0),
                APPROVED: Number(row.enrollApproved ?? 0),
                REJECTED: Number(row.enrollRejected ?? 0),
                CANCELLED: Number(row.enrollCancelled ?? 0),
                total: Number(row.enrollTotal ?? 0),
            },
            extendedStats: getEmptyExtendedStats(),
            todayClasses,
            recentStudents: [],
            todayLabel: getTodayLabel(),
        };
    } catch (error) {
        console.error("[loadDashboardPrimaryPayload] failed:", error);
        return {
            stats: { studentCount: 0, programCount: 0, coachCount: 0, classCount: 0 },
            pendingRequests: [],
            pendingCount: 0,
            enrollStats: { PENDING: 0, APPROVED: 0, REJECTED: 0, CANCELLED: 0, total: 0 },
            extendedStats: getEmptyExtendedStats(),
            todayClasses: [],
            recentStudents: [],
            todayLabel: getTodayLabel(),
        };
    }
}

async function getRecentStudents() {
    try {
        const rows = await prisma.$queryRawUnsafe<RecentStudentRow[]>(
            `SELECT s.id, s.name, s."createdAt", u.name AS parent_name
             FROM "Student" s
             LEFT JOIN "User" u ON s."parentId" = u.id
             WHERE ${notMergedStudent("s")}
               AND s."createdAt" >= NOW() - INTERVAL '7 days'
             ORDER BY s."createdAt" DESC
             LIMIT 5`,
        );

        return rows.map((row) => ({
            id: row.id,
            name: row.name,
            createdAt: row.createdAt ?? row.createdat,
            parentName: row.parent_name,
        }));
    } catch {
        return [];
    }
}

async function getSmsCoachPhones() {
    return prisma.$queryRawUnsafe<{ id: string; name: string; role: string; phone: string }[]>(
        `SELECT id, name, role, phone FROM "Coach" WHERE phone IS NOT NULL AND phone != '' ORDER BY "order" ASC`,
    );
}

async function loadDashboardPayload() {
    const [
        stats,
        pendingRequests,
        pendingCount,
        enrollStats,
        extendedStats,
        todayClasses,
        recentStudents,
    ] = await Promise.all([
        getDashboardStats(),
        getRecentPendingRequests(),
        getPendingRequestCount(),
        getEnrollApplicationStats(),
        getDashboardExtendedStats(),
        getTodayClasses(),
        getRecentStudents(),
    ]);

    return {
        stats,
        pendingRequests,
        pendingCount,
        enrollStats,
        extendedStats,
        todayClasses,
        recentStudents,
        todayLabel: getTodayLabel(),
    };
}

export function getCachedAdminStudentsPayload(limit?: number) {
    const normalizedLimit =
        typeof limit === "number" && Number.isFinite(limit) && limit > 0
            ? Math.min(Math.floor(limit), 500)
            : undefined;

    return unstable_cache(
        async () => {
            const [students, classes] = await Promise.all([
                getStudents(normalizedLimit),
                getClasses(),
            ]);

            return { students, classes, partial: Boolean(normalizedLimit) };
        },
        [`admin-students-v3-${normalizedLimit ?? "all"}`],
        { revalidate: 60, tags: ["admin-students", "admin-classes"] },
    )();
}

export const getCachedAdminStudentImportSummaryPayload = unstable_cache(
    async () => {
        const sheetImportSummary = await getStudentSheetImportSummary();

        return { sheetImportSummary };
    },
    ["admin-students-import-summary-v1"],
    { revalidate: 60, tags: ["admin-student-imports"] },
);

async function getStudentSheetImportSummary() {
    try {
        const [rows, scheduleMismatchRows, studentStatusRows] = await Promise.all([
            prisma.$queryRawUnsafe<{
            id: string;
            status: string;
            totalRows: number;
            registrationRows: number;
            vehicleRows: number;
            changeRows: number;
            teamRows: number;
            errorRows: number;
            message: string | null;
            createdAt: Date;
            completedAt: Date | null;
            uniqueStudents: number;
            linkedRegistrations: number;
        }[]>(
                `SELECT b.id, b.status, b."totalRows", b."registrationRows",
                        b."vehicleRows", b."changeRows", b."teamRows", b."errorRows",
                        b.message, b."createdAt", b."completedAt",
                        COALESCE(COUNT(DISTINCT r."studentKey") FILTER (WHERE r."studentKey" IS NOT NULL), 0)::int AS "uniqueStudents",
                        COALESCE(COUNT(*) FILTER (WHERE r."studentId" IS NOT NULL), 0)::int AS "linkedRegistrations"
                 FROM "StudentSheetImportBatch" b
                 LEFT JOIN "StudentRegistrationLedger" r ON r."batchId" = b.id
                 GROUP BY b.id
                 ORDER BY b."createdAt" DESC
                 LIMIT 1`
            ),
            prisma.$queryRawUnsafe<{
                slotKey: string;
                sheetCount: number;
                dbCount: number;
                diff: number;
                totalMismatchCount: number;
            }[]>(
                `WITH latest AS (
                    SELECT id
                    FROM "StudentSheetImportBatch"
                    WHERE status = 'COMPLETED'
                    ORDER BY "createdAt" DESC
                    LIMIT 1
                ),
                ledger AS (
                    SELECT
                        r.*,
                        (
                            string_to_array(
                                trim(both ',' from regexp_replace(COALESCE(r."registrationMonth", ''), '[^0-9]+', ',', 'g')),
                                ','
                            )
                        )[2]::int AS "monthNumber"
                    FROM "StudentRegistrationLedger" r
                    JOIN latest ON latest.id = r."batchId"
                ),
                selected_month AS (
                    SELECT l."monthNumber"
                    FROM ledger l
                    WHERE l."monthNumber" IS NOT NULL
                    GROUP BY l."monthNumber"
                    ORDER BY l."monthNumber" DESC
                    LIMIT 1
                ),
                target AS (
                    SELECT l.*
                    FROM ledger l
                    JOIN selected_month sm ON sm."monthNumber" = l."monthNumber"
                    WHERE l.status = 'ACTIVE'
                ),
                sheet_slots AS (
                    SELECT
                        slot_key AS "slotKey",
                        COUNT(DISTINCT COALESCE(r."studentId", r."studentKey", r."studentName" || ':' || COALESCE(r."parentPhone", r."rowNumber"::text)))::int AS "sheetCount"
                    FROM target r
                    CROSS JOIN LATERAL jsonb_array_elements_text(
                        COALESCE(NULLIF(r."selectedSlotKeysJSON", ''), '[]')::jsonb
                    ) AS slot_key
                    GROUP BY slot_key
                ),
                db_slots AS (
                    SELECT
                        c."slotKey" AS "slotKey",
                        COUNT(DISTINCT e."studentId")::int AS "dbCount"
                    FROM "Enrollment" e
                    JOIN "Class" c ON c.id = e."classId"
                    WHERE e.status = 'ACTIVE'
                      AND c."slotKey" IS NOT NULL
                    GROUP BY c."slotKey"
                ),
                mismatches AS (
                    SELECT
                        COALESCE(sheet_slots."slotKey", db_slots."slotKey") AS "slotKey",
                        COALESCE(sheet_slots."sheetCount", 0)::int AS "sheetCount",
                        COALESCE(db_slots."dbCount", 0)::int AS "dbCount",
                        (COALESCE(db_slots."dbCount", 0) - COALESCE(sheet_slots."sheetCount", 0))::int AS diff
                    FROM sheet_slots
                    FULL OUTER JOIN db_slots ON db_slots."slotKey" = sheet_slots."slotKey"
                    WHERE COALESCE(sheet_slots."sheetCount", 0) <> COALESCE(db_slots."dbCount", 0)
                )
                SELECT
                    "slotKey",
                    "sheetCount",
                    "dbCount",
                    diff,
                    COUNT(*) OVER ()::int AS "totalMismatchCount"
                FROM mismatches
                ORDER BY ABS(diff) DESC, "slotKey" ASC
                LIMIT 8`
            ),
            prisma.$queryRawUnsafe<{
                total: number;
                active: number;
                paused: number;
                withdrawn: number;
                noEnrollment: number;
            }[]>(
                `WITH latest AS (
                    SELECT id
                    FROM "StudentSheetImportBatch"
                    WHERE status = 'COMPLETED'
                    ORDER BY "createdAt" DESC
                    LIMIT 1
                ),
                ledger AS (
                    SELECT
                        r.*,
                        (
                            string_to_array(
                                trim(both ',' from regexp_replace(COALESCE(r."registrationMonth", ''), '[^0-9]+', ',', 'g')),
                                ','
                            )
                        )[2]::int AS "monthNumber"
                    FROM "StudentRegistrationLedger" r
                    JOIN latest ON latest.id = r."batchId"
                    WHERE r."studentId" IS NOT NULL
                ),
                selected_month AS (
                    SELECT l."monthNumber"
                    FROM ledger l
                    WHERE l."monthNumber" IS NOT NULL
                    GROUP BY l."monthNumber"
                    ORDER BY l."monthNumber" DESC
                    LIMIT 1
                ),
                student_month_status AS (
                    SELECT
                        l."studentId",
                        l."monthNumber",
                        CASE
                            WHEN BOOL_OR(l.status = 'WITHDRAWN') THEN 'WITHDRAWN'
                            WHEN BOOL_OR(l.status = 'ACTIVE') THEN 'ACTIVE'
                            WHEN BOOL_OR(l.status = 'PAUSED') THEN 'PAUSED'
                            ELSE 'WITHDRAWN'
                        END AS status
                    FROM ledger l
                    JOIN selected_month sm ON l."monthNumber" <= sm."monthNumber"
                    GROUP BY l."studentId", l."monthNumber"
                ),
                current_student_status AS (
                    SELECT DISTINCT ON (sms."studentId")
                        sms."studentId",
                        sms.status
                    FROM student_month_status sms
                    ORDER BY sms."studentId", sms."monthNumber" DESC
                ),
                student_status AS (
                    SELECT
                        s.id,
                        /* 원생 목록 current_status(queries.ts)와 같은 규칙: ACTIVE 수강이 있으면 개시일과 무관하게 활성 */
                        CASE WHEN EXISTS (SELECT 1 FROM "Enrollment" due WHERE due."studentId"=s.id AND ${currentEnrollmentSql("due")}) THEN 'ACTIVE'
                      ELSE css.status END
                        AS status
                    FROM "Student" s
                    LEFT JOIN current_student_status css ON css."studentId" = s.id
                    WHERE ${notMergedStudent("s")}
                )
                SELECT
                    COUNT(*)::int AS total,
                    COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS active,
                    COUNT(*) FILTER (WHERE status = 'PAUSED')::int AS paused,
                    COUNT(*) FILTER (WHERE status = 'WITHDRAWN')::int AS withdrawn,
                    COUNT(*) FILTER (WHERE status IS NULL OR status NOT IN ('ACTIVE', 'PAUSED', 'WITHDRAWN'))::int AS "noEnrollment"
                FROM student_status`
            ),
        ]);

        const latest = rows[0];
        if (!latest) return null;

        return {
            ...latest,
            createdAt: latest.createdAt.toISOString(),
            completedAt: latest.completedAt?.toISOString() ?? null,
            studentStatusCounts: studentStatusRows[0] ?? {
                total: 0,
                active: 0,
                paused: 0,
                withdrawn: 0,
                noEnrollment: 0,
            },
            scheduleMismatchCount: scheduleMismatchRows[0]?.totalMismatchCount ?? 0,
            topScheduleMismatches: scheduleMismatchRows.map((row) => ({
                slotKey: row.slotKey,
                sheetCount: row.sheetCount,
                dbCount: row.dbCount,
                diff: row.diff,
            })),
        };
    } catch (error) {
        console.error("[admin-students] import summary failed:", error);
        return null;
    }
}

export const getCachedAdminDashboardPrimaryPayload = unstable_cache(
    loadDashboardPrimaryPayload,
    ["admin-dashboard-primary-v2"],
    { revalidate: 60, tags: ["admin-dashboard"] },
);

export const getCachedAdminDashboardPayload = unstable_cache(
    loadDashboardPayload,
    ["admin-dashboard-data-v2"],
    { revalidate: 300, tags: ["admin-dashboard"] },
);

export const getCachedAdminClassesPayload = unstable_cache(
    async () => {
        const [programs, classes] = await Promise.all([
            getPrograms(),
            getClasses(),
        ]);

        return { programs, classes };
    },
    ["admin-classes-v1"],
    { revalidate: 60, tags: ["admin-classes", "admin-programs"] },
);

export const getCachedAdminProgramsPayload = unstable_cache(
    async () => {
        const programs = await getPrograms();

        return { programs };
    },
    ["admin-programs-page-v1"],
    { revalidate: 60, tags: ["admin-programs"] },
);

export const getCachedAdminCoachesPayload = unstable_cache(
    async () => {
        const coaches = await getCoaches();

        return { coaches };
    },
    ["admin-coaches-page-v1"],
    { revalidate: 60, tags: ["admin-coaches"] },
);

export const getCachedAdminTestimonialsPayload = unstable_cache(
    async () => {
        const [testimonials, settings] = await Promise.all([
            getAllTestimonials(),
            getAcademySettings(),
        ]);

        return {
            testimonials,
            naverPlaceUrl: settings?.naverPlaceUrl || "",
        };
    },
    ["admin-testimonials-page-v1"],
    { revalidate: 60, tags: ["admin-testimonials", "academy-settings"] },
);

export const getCachedAdminBillingPayload = unstable_cache(
    async () => {
        const [templates, programs] = await Promise.all([
            getBillingTemplates(),
            getPrograms(),
        ]);

        return { templates, programs };
    },
    ["admin-finance-billing-page-v1"],
    { revalidate: 60, tags: ["admin-finance-billing", "admin-programs"] },
);

export const getCachedAdminSmsTemplatesPayload = unstable_cache(
    async () => {
        const templates = await getSmsTemplates();

        return { templates };
    },
    ["admin-sms-templates-page-v1"],
    { revalidate: 60, tags: ["admin-sms-templates"] },
);

async function getAdminGalleryPostCount() {
    try {
        const rows = await prisma.$queryRawUnsafe<{ count: number | string }[]>(
            `SELECT COUNT(*)::int AS count FROM "GalleryPost"`,
        );
        return Number(rows[0]?.count ?? 0);
    } catch (error) {
        console.error("[getAdminGalleryPostCount] failed:", error);
        return 0;
    }
}

export function getCachedAdminGalleryPostsPagePayload(options?: AdminListPayloadOptions) {
    const { limit, offset } = normalizeAdminListPayloadOptions({
        limit: options?.limit ?? ADMIN_GALLERY_PAGE_SIZE,
        offset: options?.offset,
    });

    return unstable_cache(
        async () => {
            const [posts, total] = await Promise.all([
                getGalleryPosts({ limit, offset }),
                getAdminGalleryPostCount(),
            ]);

            return {
                posts,
                pagination: buildListPagination({
                    limit,
                    offset,
                    returned: posts.length,
                    total,
                    hasMore: offset + posts.length < total,
                }),
            };
        },
        ["admin-gallery-posts", String(limit), String(offset)],
        { revalidate: 30, tags: ["admin-gallery"] },
    )();
}

export function getCachedAdminGalleryPayload(options?: AdminListPayloadOptions) {
    const { limit, offset } = normalizeAdminListPayloadOptions({
        limit: options?.limit ?? ADMIN_GALLERY_PAGE_SIZE,
        offset: options?.offset,
    });

    return unstable_cache(
        async () => {
            const [posts, classes, settings, socialDrafts, total] = await Promise.all([
                getGalleryPosts({ limit, offset }),
                getClasses(),
                getAcademySettings(),
                readPendingSocialPostDrafts(30),
                getAdminGalleryPostCount(),
            ]);
            const settingsData = settings as GallerySettingsPayload | null;
            const instagramStatus = {
                profileUrl: settingsData?.instagramUrl ?? "",
                businessAccountId: settingsData?.instagramBusinessAccountId ?? "",
                autoPublishEnabled: settingsData?.instagramAutoPublishEnabled === true,
                ...getInstagramRuntimeStatus(settingsData?.instagramBusinessAccountId),
            };

            return {
                posts,
                classes,
                instagramStatus,
                socialDrafts,
                pagination: buildListPagination({
                    limit,
                    offset,
                    returned: posts.length,
                    total,
                    hasMore: offset + posts.length < total,
                }),
            };
        },
        ["admin-gallery-page-v2", String(limit), String(offset)],
        { revalidate: 60, tags: ["admin-gallery", "admin-classes", "academy-settings"] },
    )();
}

async function getAdminNoticeCount() {
    try {
        const rows = await prisma.$queryRawUnsafe<Array<{ count: number | string }>>(
            `SELECT COUNT(*)::int AS count FROM "Notice"`,
        );
        return Number(rows[0]?.count ?? 0);
    } catch (error) {
        console.error("[getAdminNoticeCount] failed:", error);
        return 0;
    }
}

export function getCachedAdminFinancePayload(year: number, month: number) {
    return unstable_cache(
        async () => {
            const [payments, summary] = await Promise.all([
                getPayments(year, month),
                getPaymentSummary(year, month),
            ]);

            return { payments, summary, paymentProvider: getPaymentProviderPublicStatus() };
        },
        ["admin-finance", String(year), String(month)],
        { revalidate: 30, tags: ["admin-finance", "admin-stats"] },
    )();
}

export function getCachedAdminNoticesPagePayload(options?: AdminListPayloadOptions) {
    const { limit, offset } = normalizeAdminListPayloadOptions({
        limit: options?.limit ?? ADMIN_NOTICES_PAGE_SIZE,
        offset: options?.offset,
    });

    return unstable_cache(
        async () => {
            const [notices, total] = await Promise.all([
                getNotices({ limit, offset }),
                getAdminNoticeCount(),
            ]);

            return {
                notices,
                pagination: buildListPagination({
                    limit,
                    offset,
                    returned: notices.length,
                    total,
                    hasMore: offset + notices.length < total,
                }),
            };
        },
        ["admin-notices-items", String(limit), String(offset)],
        { revalidate: 30, tags: ["admin-notices"] },
    )();
}

export function getCachedAdminNoticesPayload(options?: AdminListPayloadOptions) {
    const { limit, offset } = normalizeAdminListPayloadOptions({
        limit: options?.limit ?? ADMIN_NOTICES_PAGE_SIZE,
        offset: options?.offset,
    });

    return unstable_cache(
        async () => {
            const [notices, classes, total] = await Promise.all([
                getNotices({ limit, offset }),
                getClasses(),
                getAdminNoticeCount(),
            ]);

            return {
                notices,
                classes,
                pagination: buildListPagination({
                    limit,
                    offset,
                    returned: notices.length,
                    total,
                    hasMore: offset + notices.length < total,
                }),
            };
        },
        ["admin-notices-page-v2", String(limit), String(offset)],
        { revalidate: 60, tags: ["admin-notices", "admin-classes"] },
    )();
}

function attendancePayloadDateKey(date?: string | null) {
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Seoul",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(new Date());
}

export function getCachedAdminAttendancePayload(date?: string | null) {
    const dateKey = attendancePayloadDateKey(date);
    return unstable_cache(
        async () => {
            const classes = await getAttendanceClassOptions(dateKey);

            return { classes };
        },
        ["admin-attendance-page-v2", dateKey],
        { revalidate: 30, tags: ["admin-classes", "admin-seasonal"] },
    )();
}

export const getCachedAdminApplySummaryPayload = unstable_cache(
    async () => {
        const stats = await getEnrollApplicationStats();

        return { stats };
    },
    ["admin-apply-summary-v1"],
    { revalidate: 30, tags: ["admin-apply"] },
);

type AdminApplySourceStatsRange = "ALL" | "30D" | "THIS_MONTH";

type AdminApplySourceStatsRawRow = {
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

function sourceStatsStartIso(range: AdminApplySourceStatsRange) {
    if (range === "ALL") return null;

    const now = new Date();
    if (range === "THIS_MONTH") {
        return new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    }

    return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
}

export function getCachedAdminApplySourceStatsPayload(range: AdminApplySourceStatsRange = "30D") {
    const normalizedRange: AdminApplySourceStatsRange = ["ALL", "30D", "THIS_MONTH"].includes(range) ? range : "30D";
    const startIso = sourceStatsStartIso(normalizedRange);

    return unstable_cache(
        async () => {
            const whereClause = startIso ? `WHERE "createdAt" >= $1::timestamptz` : "";
            const params = startIso ? [startIso] : [];
            const rows = await prisma.$queryRawUnsafe<AdminApplySourceStatsRawRow[]>(
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

            const mappedRows = rows.map((row) => {
                const trialTotal = Number(row.trial_total ?? 0);
                const enrollTotal = Number(row.enroll_total ?? 0);
                const trialConverted = Number(row.trial_converted ?? 0);
                const enrollApproved = Number(row.enroll_approved ?? 0);
                const total = trialTotal + enrollTotal;
                const convertedTotal = trialConverted + enrollApproved;

                return {
                    source: String(row.source ?? "UNKNOWN"),
                    total,
                    trialTotal,
                    trialScheduled: Number(row.trial_scheduled ?? 0),
                    trialAttended: Number(row.trial_attended ?? 0),
                    trialConverted,
                    enrollTotal,
                    enrollPending: Number(row.enroll_pending ?? 0),
                    enrollApproved,
                    enrollClosed: Number(row.enroll_closed ?? 0),
                    conversionRate: total > 0 ? Math.round((convertedTotal / total) * 100) : 0,
                    trialAttendRate: trialTotal > 0 ? Math.round((Number(row.trial_attended ?? 0) / trialTotal) * 100) : 0,
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
                {
                    total: 0,
                    trialTotal: 0,
                    trialAttended: 0,
                    trialConverted: 0,
                    enrollTotal: 0,
                    enrollApproved: 0,
                    conversionRate: 0,
                    trialAttendRate: 0,
                    enrollApproveRate: 0,
                },
            );

            const convertedTotal = totals.trialConverted + totals.enrollApproved;
            totals.conversionRate = totals.total > 0 ? Math.round((convertedTotal / totals.total) * 100) : 0;
            totals.trialAttendRate = totals.trialTotal > 0 ? Math.round((totals.trialAttended / totals.trialTotal) * 100) : 0;
            totals.enrollApproveRate = totals.enrollTotal > 0 ? Math.round((totals.enrollApproved / totals.enrollTotal) * 100) : 0;

            return {
                range: normalizedRange,
                generatedAt: new Date().toISOString(),
                rows: mappedRows,
                totals,
            };
        },
        ["admin-apply-source-stats-v1", normalizedRange, startIso ?? "all"],
        { revalidate: 60, tags: ["admin-apply", "admin-trial"] },
    )();
}

export function getCachedAdminApplyPayload(options?: AdminListPayloadOptions) {
    const page = normalizeAdminListPayloadOptions(options);

    return unstable_cache(
        async () => {
            const [applicationRows, stats, classes] = await Promise.all([
                getEnrollApplications({ limit: page.limit + 1, offset: page.offset }),
                getEnrollApplicationStats(),
                getClasses(),
            ]);
            const hasMore = applicationRows.length > page.limit;
            const applications = hasMore ? applicationRows.slice(0, page.limit) : applicationRows;

            return {
                applications,
                stats,
                classes,
                pagination: buildListPagination({
                    limit: page.limit,
                    offset: page.offset,
                    returned: applications.length,
                    hasMore,
                    total: stats.total,
                }),
            };
        },
        ["admin-apply-v2", String(page.limit), String(page.offset)],
        { revalidate: 30, tags: ["admin-apply", "admin-classes"] },
    )();
}

export const getCachedAdminWaitlistPayload = unstable_cache(
    async () => {
        const [waitlist, capacityInfo, classes] = await Promise.all([
            getWaitlistAll(),
            getClassCapacityInfo(),
            getClasses(),
        ]);

        return { waitlist, capacityInfo, classes };
    },
    ["admin-waitlist-v1"],
    { revalidate: 30, tags: ["admin-waitlist", "admin-classes", "admin-students"] },
);

export const getCachedAdminMakeupPayload = unstable_cache(
    async () => {
        const [sessions, classes] = await Promise.all([
            getMakeupSessions(),
            getClasses(),
        ]);

        return { sessions, classes };
    },
    ["admin-makeup-v1"],
    { revalidate: 30, tags: ["admin-makeup", "admin-classes"] },
);

export const getCachedAdminStatsPayload = unstable_cache(
    async () => {
        const [
            monthlyRevenue,
            monthlyAttendance,
            enrollmentTrend,
            classCapacity,
            trialStats,
            coachWorkload,
            collectionRate,
        ] = await Promise.all([
            getMonthlyRevenue(12),
            getMonthlyAttendanceRate(12),
            getEnrollmentTrend(12),
            getClassCapacityInfo(),
            getTrialStats(),
            getCoachWorkload(),
            getPaymentCollectionRate(),
        ]);

        return {
            monthlyRevenue,
            monthlyAttendance,
            enrollmentTrend,
            classCapacity,
            trialStats,
            coachWorkload,
            collectionRate,
        };
    },
    ["admin-stats-v1"],
    { revalidate: 60, tags: ["admin-stats"] },
);

export const getCachedAdminStaffPayload = unstable_cache(
    async () => {
        // 2026-11-12: 추가 역할 직원(보기 전용 줄)·초대 문자 마지막 발송·담당 반을 같이 싣는다(기존 표만 읽음)
        const [staffUsers, coaches, invitations, grantUsers, inviteLastSends, classAssignments] = await Promise.all([
            getStaffUsers(),
            getAllCoaches(),
            getStaffInvitations(),
            getStaffRoleGrantUsers(),
            getStaffInviteLastSends(),
            getStaffClassAssignments(),
        ]);

        return { staffUsers, coaches, invitations, grantUsers, inviteLastSends, classAssignments };
    },
    ["admin-staff-v2"],
    { revalidate: 60, tags: ["admin-staff", "admin-coaches"] },
);

async function getAdminRequestStatusCounts() {
    const emptyCounts = {
        ALL: 0,
        PENDING: 0,
        CONFIRMED: 0,
        COMPLETED: 0,
        REJECTED: 0,
    };

    try {
        const rows = await prisma.$queryRawUnsafe<Array<{ status: string | null; count: number | string }>>(
            `SELECT status, COUNT(*)::int AS count FROM "ParentRequest" GROUP BY status`,
        );

        return rows.reduce((counts, row) => {
            const status = row.status ?? "";
            const count = Number(row.count ?? 0);
            counts.ALL += count;
            if (ADMIN_REQUEST_STATUSES.includes(status as (typeof ADMIN_REQUEST_STATUSES)[number])) {
                counts[status as keyof typeof emptyCounts] = count;
            }
            return counts;
        }, { ...emptyCounts });
    } catch (error) {
        console.error("[getAdminRequestStatusCounts] failed:", error);
        return emptyCounts;
    }
}

export function getCachedAdminRequestsPayload(options?: AdminRequestsPayloadOptions) {
    const { limit, offset } = normalizeAdminListPayloadOptions({
        limit: options?.limit ?? ADMIN_REQUESTS_PAGE_SIZE,
        offset: options?.offset,
    });
    const statusFilter = ADMIN_REQUEST_STATUSES.includes(options?.statusFilter as (typeof ADMIN_REQUEST_STATUSES)[number])
        ? options?.statusFilter
        : undefined;

    return unstable_cache(
        async () => {
            const [requests, counts] = await Promise.all([
                getAllRequests({ statusFilter, limit, offset }),
                getAdminRequestStatusCounts(),
            ]);
            const total = statusFilter ? counts[statusFilter as keyof typeof counts] : counts.ALL;

            return {
                requests,
                counts,
                statusFilter: statusFilter ?? "ALL",
                pagination: buildListPagination({
                    limit,
                    offset,
                    returned: requests.length,
                    total,
                    hasMore: offset + requests.length < total,
                }),
            };
        },
        ["admin-requests-page-v2", statusFilter ?? "ALL", String(limit), String(offset)],
        { revalidate: 30, tags: ["admin-requests"] },
    )();
}

export const getCachedAdminSettingsPayload = unstable_cache(
    async () => {
        try {
            const settings = await getAcademySettings();

            return { settings, fetchError: false };
        } catch {
            return { settings: null, fetchError: true };
        }
    },
    ["admin-settings-page-v1"],
    { revalidate: 60, tags: ["academy-settings"] },
);

export const getCachedAdminAnnualPayload = unstable_cache(
    async () => {
        const [events, settings] = await Promise.all([
            getAnnualEvents(),
            getAcademySettings(),
        ]);

        return {
            events,
            initialIcsUrl: settings?.googleCalendarIcsUrl || "",
        };
    },
    ["admin-annual-v1"],
    { revalidate: 60, tags: ["admin-annual", "academy-settings"] },
);

export const getCachedAdminFaqPayload = unstable_cache(
    async () => {
        const faqs = await getAllFaqs();

        return { faqs };
    },
    ["admin-faq-v1"],
    { revalidate: 60, tags: ["admin-faq"] },
);

export const getCachedAdminFeedbackPayload = unstable_cache(
    async () => {
        const feedbacks = await getAllFeedbacks();

        return { feedbacks };
    },
    ["admin-feedback-page-v1"],
    { revalidate: 60, tags: ["admin-feedback"] },
);

export function getCachedAdminReportListPayload(limit: number) {
    return unstable_cache(
        async () => {
            const sessions = await getSessionsForReportList(limit);

            return { sessions };
        },
        ["admin-attendance-report-list", String(limit)],
        { revalidate: 30, tags: ["admin-attendance-report", "admin-classes"] },
    )();
}

export const getCachedAdminSmsPayload = unstable_cache(
    async () => {
        const coaches = await getSmsCoachPhones();

        return { coaches };
    },
    ["admin-sms-page-v1"],
    { revalidate: 60, tags: ["admin-coaches"] },
);

export const getCachedAdminSchedulePayload = unstable_cache(
    async () => {
        const [dbScheduleData, coaches, programs] = await Promise.all([
            getScheduleSlotAdminData(),
            getCoaches(),
            getPrograms(),
        ]);

        let scheduleData = dbScheduleData;
        let sheetUrl: string | null = null;
        if (!scheduleData) {
            const settings = await getAcademySettings() as AdminScheduleSettingsPayload;
            sheetUrl = settings?.googleSheetsScheduleUrl ?? settings?.googlesheetsscheduleurl ?? null;
            const [overrides, customSlots, legacySlots] = await Promise.all([
                getClassSlotOverrides(),
                getCustomClassSlots(),
                sheetUrl ? getSheetSlotCache().then((cachedSlots) => cachedSlots ?? []) : Promise.resolve([]),
            ]);
            scheduleData = {
                slots: legacySlots,
                overrides,
                customSlots,
                scheduleSource: "SHEET_CACHE" as const,
            };
        }

        return {
            slots: scheduleData.slots,
            overrides: scheduleData.overrides,
            coaches,
            customSlots: scheduleData.customSlots,
            hasSheetUrl: Boolean(sheetUrl) || Boolean(dbScheduleData),
            sheetUrl: sheetUrl ?? null,
            programs,
            scheduleSource: scheduleData.scheduleSource,
        };
    },
    ["admin-schedule-page-v1"],
    { revalidate: 60, tags: ["admin-schedule", "admin-programs"] },
);

export function getCachedAdminTrialPayload(options?: AdminListPayloadOptions) {
    const page = normalizeAdminListPayloadOptions(options);

    return unstable_cache(
        async () => {
            const [leadRows, stats, classes] = await Promise.all([
                getTrialLeads({ limit: page.limit + 1, offset: page.offset }),
                getTrialStats(),
                getClasses(),
            ]);
            const hasMore = leadRows.length > page.limit;
            const leads = hasMore ? leadRows.slice(0, page.limit) : leadRows;

            return {
                leads,
                stats,
                classes,
                pagination: buildListPagination({
                    limit: page.limit,
                    offset: page.offset,
                    returned: leads.length,
                    hasMore,
                    total: stats.total,
                }),
            };
        },
        ["admin-trial-v4", String(page.limit), String(page.offset)],
        { revalidate: 30, tags: ["admin-trial", "admin-classes"] },
    )();
}
