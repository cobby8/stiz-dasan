"use server";

import { createHash, createHmac, timingSafeEqual } from "crypto";
import { revalidatePath, revalidateTag } from "next/cache";
import { prisma } from "@/lib/prisma";
import { isKstYmd, todayKst } from "@/lib/datetime/kst";
import { normalizeApprovalClassIds } from "@/lib/enrollment/approval-classes";
import { approvalAuthFetch, isActiveApprovalAuthUser, listApprovalParentCandidates, ParentSelectionRequired, reopenEnrollmentForReview, resolveApprovalParent } from "@/lib/enrollment/approval-parent";
import { createAdminClient } from "@/lib/supabase/admin";
import { isUsablePhoneKey, parentPhoneDigits } from "@/lib/enrollment/parentIdentity";
import { autoLinkApplicationsForTrialLead, getTrialLinkSuggestions, linkTrialLeadToApplication } from "@/lib/enrollment/trialLeadLinkService";
import type { TrialLinkSuggestion } from "@/lib/enrollment/trialLeadMatch";
import { requireAdmin, requireOwner, requireVerifiedParent } from "@/lib/auth-guard";
import {
    createNotificationRecord,
    notifyAdmins,
    notifyParentsOfStudents,
    notifyAllParents,
    sendParentSms,
    sendParentSmsWithResult,
    sendFailClosedTrackedSms,
    sendTrackedSms,
} from "@/lib/notification";
import type { SheetClassSlot } from "@/lib/googleSheetsSchedule";
import {
    createCalendarEvent,
    updateCalendarEvent,
    deleteCalendarEvent,
} from "@/lib/googleCalendarWrite";
import { publishGalleryPostToInstagram } from "@/lib/instagram";
import { syncInstagramGalleryPostsToDb } from "@/lib/instagramGallerySync";
import { ACADEMY_SETTINGS_CACHE_TAG, getAcademySettings, getMakeupSlotAvailability } from "@/lib/queries";
import {
    activeMakeupSql,
    isMakeupSlotFull,
    MAKEUP_CAPACITY_FULL_MESSAGE,
} from "@/lib/makeup/capacity";
import { notMergedStudent } from "@/lib/studentVisibility";
import { createTrialEnrollShortLink } from "@/lib/enroll-short-link";
import { SHUTTLE_LOCATION_CONSENT_VERSION } from "@/lib/seasonal/contracts";
import { validateAcademyCoordinateInput } from "@/lib/shuttle/academyLocation";
import { assertSolapiShortSms } from "@/lib/sms-byte-length";
import { renderSmsTemplate } from "@/lib/smsTemplate";
import {
    ensureInvoiceForPayment,
    ensureInvoicesForMonth,
    ensurePaymentInfrastructure,
    markOverduePayments,
    markPaymentPaid,
    recordTerminalPayment,
    recordPaymentAudit,
    syncInvoiceStatusesForMonth,
} from "@/lib/payment-ledger";
import { monthlyBillingDueDate } from "@/lib/billing-due-date";
import { isMonthlyInvoiceNotificationEligible } from "@/lib/billing/notification-policy";
import {
    BILLING_PARENT_SEND_LOCKED_MESSAGE,
    isBillingParentSendEnabled,
    rallyzMirrorExclusionSql,
    summarizeUnpaidByParent,
} from "@/lib/billing/parentSendGuard";
import {
    APPLICATION_CONTACT_ACTIONS,
    ensureApplicationContactLogInfrastructure,
    type ApplicationContactAction,
    type ApplicationContactTargetType,
} from "@/lib/application-contact-logs";
import { PUBLIC_SITE_URL } from "@/lib/publicMetadata";
import { formatTrialScheduleLabel, formatTrialSmsDateTime, hasExplicitTrialTime, isLegacyTrialDatePlaceholder } from "@/lib/trial-sms-time";
import { seoulDateInputValue } from "@/lib/trial-schedule-time";
import { resolveCanonicalTrialSchedule } from "@/lib/trial-schedule-server";
import { confirmTrialFeeWithAudit, type TrialFeeConfirmationResult } from "@/lib/trial-fee-confirmation";
import { recordApplicationContactAtomically } from "@/lib/application-contact-transaction";
import { sessionDateForKorea } from "@/lib/seasonal/session-bridge";
import { syncCreditForRegularSession, syncCreditForSeasonalSeat } from "@/lib/makeup/credit-service";
import { linkMatchingCoachProfileToUser } from "@/lib/staff-coach-link";
import { buildEnrollmentOperationsEvent } from "@/lib/operations-events/admin-hooks";
import { enqueueWebsiteOperationsEventInTransaction } from "@/lib/operations-events";

type AdminActor = Awaited<ReturnType<typeof requireAdmin>>;
type ApplicationHistoryAction = Extract<ApplicationContactAction, "UPDATED" | "SCHEDULED" | "CANCELLED">;

async function recordApplicationHistoryLog(input: {
    targetType: ApplicationContactTargetType;
    targetId: string;
    action: ApplicationHistoryAction;
    note?: string | null;
    admin: AdminActor;
}) {
    try {
        await ensureApplicationContactLogInfrastructure();
        await prisma.$executeRawUnsafe(
            `INSERT INTO "ApplicationContactLog" (
                id, "targetType", "trialLeadId", "enrollmentApplicationId", action, note,
                "createdByUserId", "createdByName", "createdAt", "updatedAt"
            )
            VALUES (
                gen_random_uuid()::text,
                $1,
                $2,
                $3,
                $4,
                $5,
                $6,
                $7,
                NOW(),
                NOW()
            )`,
            input.targetType,
            input.targetType === "TRIAL" ? input.targetId : null,
            input.targetType === "ENROLL" ? input.targetId : null,
            input.action,
            input.note?.trim() || null,
            input.admin.appUserId,
            input.admin.appUserName,
        );
    } catch (error) {
        console.warn("[application-history] failed to write log:", (error as Error).message);
    }
}

// ── AcademySettings 누락 컬럼 자동 추가 (idempotent) ──────────────────────────
// $executeRawUnsafe 사용: simple query protocol → PgBouncer transaction mode 호환
// $executeRaw 태그드 템플릿은 prepared statement(extended protocol)를 사용해 PgBouncer가 차단
let _columnsEnsured = false;
const BOOLEAN_SETTINGS_COLUMNS = new Set([
    "instagramAutoPublishEnabled",
    "useBuiltInTrialForm",
    "useBuiltInEnrollForm",
]);
// 숫자(double precision) 컬럼 목록.
// 왜 필요한가: 아래 rawUpsertAcademySettings의 "없는 컬럼 자동 생성" fallback은
// 여기(그리고 BOOLEAN 목록)에 없으면 무조건 TEXT로 만든다. 좌표처럼 이미 마이그레이션이
// double precision으로 만든 컬럼을 TEXT로 재생성하면 환경마다 타입이 갈리고,
// 반대로 숫자 컬럼에 문자열을 바인딩하면 Postgres가 42804로 저장을 거부한다.
// (실측: float8 컬럼에 문자열 파라미터 → ERROR 42804 "is of type double precision but expression is of type text")
const NUMERIC_SETTINGS_COLUMNS = new Set([
    "shuttleDepotLatitude",
    "shuttleDepotLongitude",
    "shuttleHubLatitude",
    "shuttleHubLongitude",
]);

function revalidateProgramAdminCaches() {
    revalidateTag("admin-programs", { expire: 0 });
    revalidateTag("admin-classes", { expire: 0 });
    revalidateTag("admin-finance-billing", { expire: 0 });
}

function revalidateCoachAdminCaches() {
    revalidateTag("admin-coaches", { expire: 0 });
    revalidateTag("admin-coach-options", { expire: 0 });
}

function revalidateTestimonialAdminCaches() {
    revalidateTag("admin-testimonials", { expire: 0 });
}

function revalidateGalleryAdminCaches() {
    revalidateTag("admin-gallery", { expire: 0 });
}

function revalidateNoticeAdminCaches() {
    revalidateTag("admin-notices", { expire: 0 });
}

function revalidateStaffAdminCaches() {
    revalidateTag("admin-staff", { expire: 0 });
    revalidateTag("admin-coaches", { expire: 0 });
}

function revalidateRequestAdminCaches() {
    revalidateTag("admin-requests", { expire: 0 });
    revalidateTag("admin-dashboard", { expire: 0 });
}

function revalidateFeedbackAdminCaches() {
    revalidateTag("admin-feedback", { expire: 0 });
}

function revalidateAttendanceReportAdminCaches() {
    revalidateTag("admin-attendance-report", { expire: 0 });
}

function revalidateClassAdminCaches() {
    revalidateTag("admin-classes", { expire: 0 });
    revalidateTag("admin-students", { expire: 0 });
    revalidateTag("admin-apply", { expire: 0 });
    revalidateTag("admin-waitlist", { expire: 0 });
    revalidateTag("admin-makeup", { expire: 0 });
    revalidateTag("admin-dashboard", { expire: 0 });
}

function revalidateStudentAdminCaches() {
    revalidateTag("admin-students", { expire: 0 });
    revalidateTag("admin-student-options", { expire: 0 });
    revalidateTag("admin-waitlist", { expire: 0 });
    revalidateTag("admin-makeup", { expire: 0 });
    revalidateTag("admin-dashboard", { expire: 0 });
    revalidateTag("admin-finance", { expire: 0 });
    revalidateTag("admin-stats", { expire: 0 });
}

function revalidateTrialAdminCaches() {
    revalidateTag("admin-trial", { expire: 0 });
    revalidateTag("admin-dashboard", { expire: 0 });
}

function revalidateApplyAdminCaches() {
    revalidateTag("admin-apply", { expire: 0 });
    revalidateTag("admin-trial", { expire: 0 });
    revalidateTag("admin-students", { expire: 0 });
    revalidateTag("admin-dashboard", { expire: 0 });
}

function revalidateWaitlistAdminCaches() {
    revalidateTag("admin-waitlist", { expire: 0 });
    revalidateTag("admin-classes", { expire: 0 });
    revalidateTag("admin-students", { expire: 0 });
}

function revalidateMakeupAdminCaches() {
    revalidateTag("admin-makeup", { expire: 0 });
    revalidateTag("admin-classes", { expire: 0 });
}

// ⚠️ 현재 이 함수를 호출하는 곳은 없다(전수 검색 확인).
//    실제 컬럼 생성은 rawUpsertAcademySettings의 fallback이 담당한다.
//    따라서 여기 목록만 고쳐도 실 DB에는 아무 영향이 없다 — 반드시 아래
//    BOOLEAN/NUMERIC 목록과 ALLOWED_SETTINGS_COLUMNS를 함께 맞춰야 한다.
export async function ensureAcademySettingsColumns() {
    if (_columnsEnsured) return;
    const columns: [string, string][] = [
        ["googleSheetsScheduleUrl", "TEXT"],
        ["googleCalendarIcsUrl", "TEXT"],
        ["termsOfService", "TEXT"],
        ["trialTitle", "TEXT DEFAULT '체험수업 안내'"],
        ["trialContent", "TEXT"],
        ["trialFormUrl", "TEXT"],
        ["enrollTitle", "TEXT DEFAULT '수강신청 안내'"],
        ["enrollContent", "TEXT"],
        ["enrollFormUrl", "TEXT"],
        ["youtubeUrl", "TEXT"],
        ["philosophyText", "TEXT"],
        ["facilitiesText", "TEXT"],
        ["facilitiesImagesJSON", "TEXT"],
        ["galleryImagesJSON", "TEXT"],
        ["operatingHours", "TEXT"],
        ["privacyPolicy", "TEXT"],
        ["footerDescription", "TEXT"],
        ["footerCopyright", "TEXT"],
        ["instagramUrl", "TEXT"],
        ["instagramBusinessAccountId", "TEXT"],
        ["instagramAutoPublishEnabled", "BOOLEAN DEFAULT false"],
        ["kakaoChannelUrl", "TEXT"],
        ["uniformFormUrl", "TEXT"],
        ["useBuiltInTrialForm", "BOOLEAN DEFAULT false"],  // 자체 폼 ON/OFF (false=구글폼)
        ["useBuiltInEnrollForm", "BOOLEAN DEFAULT false"], // 자체 폼 ON/OFF (false=구글폼)
        // 셔틀 노선의 출발지·도착지로 쓰는 학원 위치. 좌표도 TEXT인 이유는
        // 아래 rawUpsertAcademySettings의 컬럼 자동 추가 fallback이 TEXT로 만들기 때문이다.
        // (타입이 갈리면 환경마다 컬럼 타입이 달라진다. 검증은 shuttle/academyLocation.ts가 한다.)
        ["academyPlaceName", "TEXT"],
        ["academyAddress", "TEXT"],
        ["academyLatitude", "TEXT"],
        ["academyLongitude", "TEXT"],
        // 차고지·무료 탑승 거점 좌표는 마이그레이션이 DOUBLE PRECISION으로 만든다.
        // 여기서 TEXT로 만들면 타입이 갈리므로 반드시 동일 타입으로 맞춘다.
        ["shuttleDepotAddress", "TEXT"],
        ["shuttleDepotLatitude", "DOUBLE PRECISION"],
        ["shuttleDepotLongitude", "DOUBLE PRECISION"],
        ["shuttleHubName", "TEXT"],
        ["shuttleHubAddress", "TEXT"],
        ["shuttleHubLatitude", "DOUBLE PRECISION"],
        ["shuttleHubLongitude", "DOUBLE PRECISION"],
    ];
    for (const [col, type] of columns) {
        try {
            await prisma.$executeRawUnsafe(
                `ALTER TABLE "AcademySettings" ADD COLUMN IF NOT EXISTS "${col}" ${type}`
            );
        } catch (e) {
            console.warn(`[DDL] column "${col}" ensure failed:`, (e as Error).message);
        }
    }
    _columnsEnsured = true;
}

// ── Prisma 모델 클라이언트 없이 raw SQL 로 upsert (RETURNING 우회) ──────────────
const ALLOWED_SETTINGS_COLUMNS = [
    'introductionTitle', 'introductionText', 'shuttleInfoText',
    'contactPhone', 'address', 'operatingHours', 'privacyPolicy', 'termsOfService', 'pageDesignJSON',
    'footerDescription', 'footerCopyright',
    'googleCalendarIcsUrl', 'googleSheetsScheduleUrl', 'classDays',
    'siteBodyFont', 'siteHeadingFont',
    'trialTitle', 'trialContent', 'trialFormUrl',
    'enrollTitle', 'enrollContent', 'enrollFormUrl',
    'youtubeUrl', 'instagramUrl', 'instagramBusinessAccountId', 'instagramAutoPublishEnabled', 'kakaoChannelUrl',
    'philosophyText',
    'facilitiesText',
    'facilitiesImagesJSON',
    'galleryImagesJSON',
    'naverPlaceUrl',
    'uniformFormUrl',
    'useBuiltInTrialForm',
    'useBuiltInEnrollForm',
    // 셔틀 기준 학원 위치 (지도로 찍어 저장)
    'academyPlaceName',
    'academyAddress',
    'academyLatitude',
    'academyLongitude',
] as const;

const ALLOWED_SETTINGS_COLUMN_SET: ReadonlySet<string> = new Set(ALLOWED_SETTINGS_COLUMNS);

// 숫자 컬럼에는 문자열을 그대로 넣으면 Postgres가 42804로 거부한다.
// 폼에서 온 "37.61" 같은 문자열을 숫자로 바꿔서 바인딩한다.
function coerceSettingValue(col: string, value: unknown) {
    if (value === null || value === undefined) return value;
    if (!NUMERIC_SETTINGS_COLUMNS.has(col)) return value;
    if (typeof value === "number") return value;
    const parsed = Number(String(value).trim());
    if (!Number.isFinite(parsed)) {
        // 조용히 null로 만들면 좌표가 사라져 셔틀 경로가 깨진다. 차라리 실패시킨다.
        throw new Error(`설정값 "${col}"이(가) 숫자가 아닙니다.`);
    }
    return parsed;
}

async function rawUpsertAcademySettings(payload: Record<string, any>) {
    // singleton 행이 없으면 생성
    await prisma.$executeRawUnsafe(
        `INSERT INTO "AcademySettings" (id, "createdAt", "updatedAt") VALUES ('singleton', NOW(), NOW()) ON CONFLICT (id) DO NOTHING`
    );

    // 허용 목록에 없는 키는 아무 에러 없이 버려진다(조용한 실패).
    // 컬럼을 새로 추가하고 ALLOWED_SETTINGS_COLUMNS 등록을 잊는 실수를 로그로 잡는다.
    const droppedKeys = Object.keys(payload).filter(
        key => payload[key] !== undefined && !ALLOWED_SETTINGS_COLUMN_SET.has(key)
    );
    if (droppedKeys.length > 0) {
        console.warn(
            `[rawUpsert] ALLOWED_SETTINGS_COLUMNS에 없어 저장하지 않은 키: ${droppedKeys.join(", ")}`
        );
    }

    const colsToUpdate = ALLOWED_SETTINGS_COLUMNS.filter(col => payload[col] !== undefined);
    if (colsToUpdate.length === 0) return;

    const values = colsToUpdate.map(col => coerceSettingValue(col, payload[col]));

    // 단일 배치 UPDATE: 19개 개별 쿼리(~1,400ms) → 쿼리 1개(~75ms)
    // 신규 컬럼 없을 때까지 재시도 (최대 컬럼 수)
    for (let attempt = 0; attempt <= colsToUpdate.length; attempt++) {
        const setClauses = colsToUpdate.map((col, i) => `"${col}" = $${i + 1}`).join(", ");
        try {
            await prisma.$executeRawUnsafe(
                `UPDATE "AcademySettings" SET ${setClauses}, "updatedAt" = NOW() WHERE id = 'singleton'`,
                ...values
            );
            return; // 성공
        } catch (e) {
            const msg = (e as Error).message ?? "";
            // PostgreSQL: column "X" of relation "Y" does not exist
            const missingCol = msg.match(/column "([^"]+)" of relation/)?.[1];
            if (missingCol) {
                // 해당 컬럼만 추가 후 재시도
                try {
                    const colType = BOOLEAN_SETTINGS_COLUMNS.has(missingCol)
                        ? 'BOOLEAN DEFAULT false'
                        : NUMERIC_SETTINGS_COLUMNS.has(missingCol)
                            ? 'DOUBLE PRECISION'
                            : 'TEXT';
                    await prisma.$executeRawUnsafe(
                        `ALTER TABLE "AcademySettings" ADD COLUMN IF NOT EXISTS "${missingCol}" ${colType}`
                    );
                } catch {}
            } else {
                console.error("[rawUpsert] batch update failed:", msg);
                throw e;
            }
        }
    }
    // 루프 종료까지 return 없음 = 모든 재시도 실패
    throw new Error("설정 컬럼 추가 후에도 저장에 실패했습니다. DB 스키마를 확인해 주세요.");
}

type ProgramData = {
    name: string;
    targetAge?: string;
    weeklyFrequency?: string;
    description?: string;
    price: number;
    days?: string | null;
    priceWeek1?: number | null;
    priceWeek2?: number | null;
    priceWeek3?: number | null;
    priceDaily?: number | null;
    shuttleFeeOverride?: number | null;
    imageUrl?: string | null;
    runsShuttle?: boolean;
};

export async function createProgram(data: ProgramData) {
    await requireAdmin();
    const { name, targetAge, weeklyFrequency, description, price, days, priceWeek1, priceWeek2, priceWeek3, priceDaily, shuttleFeeOverride, imageUrl, runsShuttle } = data;
    // $executeRawUnsafe: simple query protocol → PgBouncer transaction mode 호환
    try {
        await prisma.$executeRawUnsafe(
            `INSERT INTO "Program" (id, "name", "targetAge", "weeklyFrequency", "description", "price", "days", "priceWeek1", "priceWeek2", "priceWeek3", "priceDaily", "shuttleFeeOverride", "imageUrl", "runsShuttle", "order", "createdAt", "updatedAt")
             VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
               (SELECT COALESCE(MAX("order"), -1) + 1 FROM "Program"), now(), now())`,
            name,
            targetAge ?? null,
            weeklyFrequency ?? null,
            description ?? null,
            price,
            days ?? null,
            priceWeek1 ?? null,
            priceWeek2 ?? null,
            priceWeek3 ?? null,
            priceDaily ?? null,
            shuttleFeeOverride ?? null,
            imageUrl ?? null,
            runsShuttle ?? true,
        );
    } catch (e) {
        console.error("Failed to create program:", e);
        throw new Error("데이터베이스에 연결할 수 없습니다. Supabase 연결 설정을 확인해주세요.");
    }
    revalidatePath("/admin/programs");
    revalidatePath("/programs");
    revalidatePath("/schedule");
    revalidateProgramAdminCaches();
}

export async function updateProgram(id: string, data: ProgramData) {
    await requireAdmin();
    const { name, targetAge, weeklyFrequency, description, price, days, priceWeek1, priceWeek2, priceWeek3, priceDaily, shuttleFeeOverride, imageUrl, runsShuttle } = data;
    // $executeRawUnsafe: simple query protocol → PgBouncer transaction mode 호환
    try {
        await prisma.$executeRawUnsafe(
            `UPDATE "Program" SET
               "name" = $1,
               "targetAge" = $2,
               "weeklyFrequency" = $3,
               "description" = $4,
               "price" = $5,
               "days" = $6,
               "priceWeek1" = $7,
               "priceWeek2" = $8,
               "priceWeek3" = $9,
               "priceDaily" = $10,
               "shuttleFeeOverride" = $11,
               "imageUrl" = $12,
               "runsShuttle" = $13,
               "updatedAt" = now()
             WHERE id = $14`,
            name,
            targetAge ?? null,
            weeklyFrequency ?? null,
            description ?? null,
            price,
            days ?? null,
            priceWeek1 ?? null,
            priceWeek2 ?? null,
            priceWeek3 ?? null,
            priceDaily ?? null,
            shuttleFeeOverride ?? null,
            imageUrl ?? null,
            runsShuttle ?? true,
            id,
        );
    } catch (e) {
        console.error("Failed to update program:", e);
        throw new Error("프로그램 수정 실패");
    }
    revalidatePath("/admin/programs");
    revalidatePath("/programs");
    revalidatePath("/schedule");
    revalidateProgramAdminCaches();
}

export async function reorderPrograms(orderedIds: string[]) {
    await requireAdmin();
    // 파라미터 바인딩으로 SQL 인젝션 방지 + $executeRawUnsafe로 PgBouncer 호환
    try {
        for (let i = 0; i < orderedIds.length; i++) {
            await prisma.$executeRawUnsafe(
                `UPDATE "Program" SET "order" = $1 WHERE id = $2`, i, orderedIds[i]
            );
        }
    } catch (e) {
        console.error("Failed to reorder programs:", e);
    }
    revalidatePath("/admin/programs");
    revalidatePath("/programs");
    revalidateProgramAdminCaches();
}

export async function deleteProgram(id: string) {
    await requireAdmin();
    // ★ 소프트 삭제: 회원의 수강·세션·출석 이력을 그대로 보존하기 위해 실제 행을 지우지 않는다.
    //   Enrollment/Session 이 Class 를, Class 가 Program 을 RESTRICT 로 참조하므로 하드 삭제는
    //   이력이 있는 프로그램에서 항상 실패한다(그래서 기존엔 "삭제가 안 됨"). deletedAt 만 세팅해
    //   목록·공개 카탈로그에서 감추고, 이력 화면은 id 로 프로그램 이름을 계속 조회할 수 있게 한다.
    // $executeRawUnsafe: PgBouncer transaction mode 호환 (Prisma ORM 메서드 사용 불가)
    try {
        const affected = await prisma.$executeRawUnsafe(
            `UPDATE "Program" SET "deletedAt" = now(), "updatedAt" = now()
              WHERE id = $1 AND "deletedAt" IS NULL`,
            id,
        );
        if (!affected) {
            // 이미 삭제됐거나 없는 id — 조용히 통과(멱등)
            console.warn("deleteProgram: no active program for id", id);
        }
        revalidatePath("/admin/programs");
        revalidatePath("/programs");
        revalidatePath("/schedule");
        revalidateProgramAdminCaches();
    } catch (e) {
        console.error("Failed to delete program:", e);
        throw new Error("프로그램 삭제에 실패했습니다. 잠시 후 다시 시도해주세요.");
    }
}

export async function createClass(data: {
    programId: string;
    name: string;
    dayOfWeek: string;
    startTime: string;
    endTime: string;
    location?: string;
    capacity: number;
}) {
    await requireAdmin();
    try {
        await prisma.$executeRawUnsafe(
            `INSERT INTO "Class" (id, "programId", name, "dayOfWeek", "startTime", "endTime", location, capacity, "createdAt", "updatedAt")
             VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, NOW(), NOW())`,
            data.programId, data.name, data.dayOfWeek,
            data.startTime || "", data.endTime || "",
            data.location || null, data.capacity,
        );
    } catch (e) {
        console.error("Failed to create class:", e);
        throw new Error("데이터베이스에 연결할 수 없습니다. Supabase 연결 설정을 확인해주세요.");
    }
    revalidatePath("/admin/classes");
    revalidatePath("/schedule");
    revalidatePath("/");
    revalidateClassAdminCaches();
}

export async function updateClass(id: string, data: {
    programId: string;
    name: string;
    dayOfWeek: string;
    startTime: string;
    endTime: string;
    location?: string;
    capacity: number;
}) {
    await requireAdmin();
    try {
        await prisma.$executeRawUnsafe(
            `UPDATE "Class" SET "programId" = $1, name = $2, "dayOfWeek" = $3,
             "startTime" = $4, "endTime" = $5, location = $6, capacity = $7, "updatedAt" = NOW()
             WHERE id = $8`,
            data.programId, data.name, data.dayOfWeek,
            data.startTime || "", data.endTime || "",
            data.location || null, data.capacity, id,
        );
    } catch (e) {
        console.error("Failed to update class:", e);
        throw new Error("반 수정 실패");
    }
    revalidatePath("/admin/classes");
    revalidatePath("/schedule");
    revalidatePath("/");
    revalidateClassAdminCaches();
}

export async function deleteClass(id: string) {
    await requireAdmin();
    try {
        await prisma.$executeRawUnsafe(`DELETE FROM "Enrollment" WHERE "classId" = $1`, id);
        await prisma.$executeRawUnsafe(`DELETE FROM "Class" WHERE id = $1`, id);
    } catch (e) {
        console.error("Failed to delete class:", e);
        throw new Error("반 삭제 실패");
    }
    revalidatePath("/admin/classes");
    revalidatePath("/schedule");
    revalidatePath("/");
    revalidateClassAdminCaches();
}

export async function updateAcademySettings(data: {
    pageDesignJSON?: string;
    contactPhone?: string;
    address?: string;
    introductionTitle?: string;
    introductionText?: string;
    googleCalendarIcsUrl?: string;
    googleSheetsScheduleUrl?: string;
    classDays?: string;
    siteBodyFont?: string;
    siteHeadingFont?: string;
    termsOfService?: string;
    privacyPolicy?: string;
    footerDescription?: string;
    footerCopyright?: string;
    trialTitle?: string;
    trialContent?: string;
    trialFormUrl?: string;
    enrollTitle?: string;
    enrollContent?: string;
    enrollFormUrl?: string;
    youtubeUrl?: string;
    instagramUrl?: string;
    instagramBusinessAccountId?: string;
    instagramAutoPublishEnabled?: boolean;
    kakaoChannelUrl?: string;
    philosophyText?: string;
    facilitiesText?: string;
    facilitiesImagesJSON?: string;
    galleryImagesJSON?: string;
    operatingHours?: string;
    naverPlaceUrl?: string;
    uniformFormUrl?: string;
    useBuiltInTrialForm?: boolean;
    useBuiltInEnrollForm?: boolean;
    academyPlaceName?: string;
    academyAddress?: string;
    academyLatitude?: string;
    academyLongitude?: string;
}) {
    await requireAdmin();
    // 빈 URL 필드는 기존 DB 값을 덮어쓰지 않음
    const payload = { ...data };
    if (payload.googleSheetsScheduleUrl === "") delete payload.googleSheetsScheduleUrl;
    if (payload.googleCalendarIcsUrl === "") delete payload.googleCalendarIcsUrl;

    // 학원 좌표 검증: 틀린 좌표를 저장하면 셔틀 T맵 경로가 통째로 엉뚱한 곳으로 간다.
    // 둘 다 비어 있으면 "아직 지정 안 함"이라는 정상 상태이므로 통과시킨다.
    const hasLatitude = typeof payload.academyLatitude === "string" && payload.academyLatitude.trim() !== "";
    const hasLongitude = typeof payload.academyLongitude === "string" && payload.academyLongitude.trim() !== "";
    if (hasLatitude || hasLongitude) {
        const checked = validateAcademyCoordinateInput(payload.academyLatitude, payload.academyLongitude);
        if (!checked.ok) throw new Error(checked.reason);
        // 검증을 통과한 값으로 정규화해 저장한다(공백 제거, 숫자 형식 통일).
        payload.academyLatitude = String(checked.latitude);
        payload.academyLongitude = String(checked.longitude);
    }

    // raw SQL 로 직접 저장 — 누락 컬럼은 rawUpsertAcademySettings 내부에서 lazily 추가
    try {
        await rawUpsertAcademySettings(payload);
    } catch (e) {
        console.error("Failed to update academy settings:", e);
        throw new Error("설정 저장에 실패했습니다. 잠시 후 다시 시도해 주세요.");
    }
    revalidateTag(ACADEMY_SETTINGS_CACHE_TAG, { expire: 0 });
    revalidatePath("/");
    revalidatePath("/about");
    revalidatePath("/programs");
    revalidatePath("/schedule");
    revalidatePath("/annual");
    revalidatePath("/gallery");
    revalidatePath("/notices");
    revalidatePath("/faq");
    revalidatePath("/terms");
    revalidatePath("/privacy");
    revalidatePath("/simulator");
    revalidatePath("/admin/settings");
    revalidatePath("/admin/apply");
    revalidatePath("/apply");
}

// 네이버 플레이스 URL만 단독 업데이트하는 전용 Server Action
// — TestimonialsAdminClient에서 범용 updateAcademySettings를 import하면
//   Next.js 16 + Turbopack SSR 시 서버 액션이 비정상 실행되어 권한 에러가 발생하므로
//   testimonials 페이지 전용으로 분리한다.
export async function updateNaverPlaceUrl(url: string) {
    await requireAdmin();
    try {
        await rawUpsertAcademySettings({ naverPlaceUrl: url });
    } catch (e) {
        console.error("Failed to update naver place URL:", e);
        throw new Error("네이버 플레이스 URL 저장에 실패했습니다.");
    }
    revalidateTag(ACADEMY_SETTINGS_CACHE_TAG, { expire: 0 });
    revalidateTestimonialAdminCaches();
    revalidatePath("/admin/testimonials");
    revalidatePath("/");
}

export async function createCoach(data: {
    name: string;
    role: string;
    description?: string;
    imageUrl?: string;
    phone?: string;
    order?: number;
}) {
    await requireAdmin();
    // $executeRawUnsafe: PgBouncer transaction mode 호환 (Prisma ORM 메서드 사용 불가)
    try {
        await prisma.$executeRawUnsafe(
            `INSERT INTO "Coach" (id, name, role, description, "imageUrl", phone, "order", "createdAt", "updatedAt")
             VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5,
               COALESCE($6, (SELECT COALESCE(MAX("order"), -1) + 1 FROM "Coach")),
               NOW(), NOW())`,
            data.name,
            data.role,
            data.description || null,
            data.imageUrl || null,
            data.phone || null,
            data.order ?? null,
        );
        revalidatePath("/admin/coaches");
        revalidatePath("/admin/schedule");
        revalidatePath("/about");
        revalidatePath("/schedule");
        revalidateCoachAdminCaches();
    } catch (e) {
        console.error("Failed to create coach:", e);
        throw new Error("데이터베이스에 연결할 수 없습니다. Supabase 연결 설정을 확인해주세요.");
    }
}

export async function updateCoach(id: string, data: {
    name: string;
    role: string;
    description?: string;
    imageUrl?: string;
    phone?: string;
}) {
    await requireAdmin();
    // $executeRawUnsafe: PgBouncer transaction mode 호환 (Prisma ORM 메서드 사용 불가)
    try {
        await prisma.$executeRawUnsafe(
            `UPDATE "Coach" SET name = $1, role = $2, description = $3, "imageUrl" = $4, phone = $5, "updatedAt" = NOW()
             WHERE id = $6`,
            data.name,
            data.role,
            data.description || null,
            data.imageUrl || null,
            data.phone || null,
            id,
        );
        revalidatePath("/admin/coaches");
        revalidatePath("/admin/schedule");
        revalidatePath("/about");
        revalidatePath("/schedule");
        revalidateCoachAdminCaches();
    } catch (e) {
        console.error("Failed to update coach:", e);
        throw new Error("코치 정보 수정 실패");
    }
}

export async function deleteCoach(id: string) {
    await requireAdmin();
    // $executeRawUnsafe: PgBouncer transaction mode 호환 (Prisma ORM 메서드 사용 불가)
    try {
        await prisma.$executeRawUnsafe(`DELETE FROM "Coach" WHERE id = $1`, id);
        revalidatePath("/admin/coaches");
        revalidatePath("/admin/schedule");
        revalidatePath("/about");
        revalidatePath("/schedule");
        revalidateCoachAdminCaches();
    } catch (e) {
        console.error("Failed to delete coach:", e);
        throw new Error("Failed to delete coach");
    }
}

export async function moveCoach(id: string, direction: "up" | "down") {
    await requireAdmin();
    // $queryRawUnsafe + $executeRawUnsafe: PgBouncer transaction mode 호환
    try {
        const coaches = await prisma.$queryRawUnsafe<any[]>(
            `SELECT id, "order" FROM "Coach" ORDER BY "order" ASC`
        );
        const idx = coaches.findIndex((c: any) => c.id === id);
        if (idx === -1) return;
        const swapIdx = direction === "up" ? idx - 1 : idx + 1;
        if (swapIdx < 0 || swapIdx >= coaches.length) return;
        const a = coaches[idx];
        const b = coaches[swapIdx];
        // 두 코치의 order 값을 서로 교환
        await prisma.$executeRawUnsafe(
            `UPDATE "Coach" SET "order" = $1 WHERE id = $2`, b.order, a.id
        );
        await prisma.$executeRawUnsafe(
            `UPDATE "Coach" SET "order" = $1 WHERE id = $2`, a.order, b.id
        );
        revalidatePath("/admin/coaches");
        revalidatePath("/about");
        revalidatePath("/schedule");
        revalidateCoachAdminCaches();
    } catch (e) {
        console.error("Failed to move coach:", e);
        throw new Error("순서 변경 실패");
    }
}

export async function reorderCoaches(ids: string[]) {
    await requireAdmin();
    // 파라미터 바인딩으로 SQL 인젝션 방지 + PgBouncer 호환
    try {
        if (ids.length === 0) return;
        for (let i = 0; i < ids.length; i++) {
            await prisma.$executeRawUnsafe(
                `UPDATE "Coach" SET "order" = $1 WHERE id = $2`, i, ids[i]
            );
        }
        revalidatePath("/admin/coaches");
        revalidatePath("/about");
        revalidatePath("/schedule");
        revalidateCoachAdminCaches();
    } catch (e) {
        console.error("Failed to reorder coaches:", e);
        throw new Error("순서 변경 실패");
    }
}

// ── 연간일정 CRUD ─────────────────────────────────────────────────────────────
export async function createAnnualEvent(data: {
    title: string;
    date: string;
    endDate?: string | null;
    description?: string | null;
    category?: string;
}) {
    await requireAdmin();
    // ID를 미리 생성하여 INSERT 후 구글 이벤트 ID를 UPDATE할 때 사용
    const id = crypto.randomUUID();

    try {
        // 1단계: DB에 먼저 저장 (googleEventId는 null로 시작)
        await prisma.$executeRawUnsafe(
            `INSERT INTO "AnnualEvent" (id, title, date, "endDate", description, category, "googleEventId", "createdAt", "updatedAt")
             VALUES ($1, $2, $3::timestamp, $4::timestamp, $5, $6, NULL, NOW(), NOW())`,
            id,
            data.title,
            data.date,
            data.endDate || null,
            data.description || null,
            data.category || "일반",
        );
    } catch (e) {
        console.error("Failed to create annual event:", e);
        throw new Error("일정 추가 실패");
    }

    // 2단계: 구글 캘린더에 동기화 (best-effort — 실패해도 DB는 이미 저장됨)
    const googleEventId = await createCalendarEvent({
        title: data.title,
        date: data.date,
        endDate: data.endDate,
        description: data.description,
    });

    // 3단계: 구글 이벤트 ID를 DB에 저장 (성공한 경우만)
    if (googleEventId) {
        try {
            await prisma.$executeRawUnsafe(
                `UPDATE "AnnualEvent" SET "googleEventId" = $1, "updatedAt" = NOW() WHERE id = $2`,
                googleEventId,
                id,
            );
        } catch (e) {
            console.error("Failed to save googleEventId:", e);
            // googleEventId 저장 실패해도 이벤트 자체는 DB에 존재하므로 무시
        }
    }

    revalidatePath("/admin/annual");
    revalidatePath("/annual");
    revalidateTag("admin-annual", { expire: 0 });
}

export async function updateAnnualEvent(id: string, data: {
    title: string;
    date: string;
    endDate?: string | null;
    description?: string | null;
    category?: string;
}) {
    await requireAdmin();
    // 1단계: DB 먼저 수정
    try {
        await prisma.$executeRawUnsafe(
            `UPDATE "AnnualEvent" SET title = $1, date = $2::timestamp, "endDate" = $3::timestamp,
             description = $4, category = $5, "updatedAt" = NOW() WHERE id = $6`,
            data.title,
            data.date,
            data.endDate || null,
            data.description || null,
            data.category || "일반",
            id,
        );
    } catch (e) {
        console.error("Failed to update annual event:", e);
        throw new Error("일정 수정 실패");
    }

    // 2단계: 구글 캘린더 동기화 (best-effort)
    // 기존 googleEventId를 조회하여 구글 이벤트도 함께 수정
    try {
        const rows = await prisma.$queryRawUnsafe<{ googleEventId: string | null }[]>(
            `SELECT "googleEventId" FROM "AnnualEvent" WHERE id = $1`,
            id,
        );
        const gId = rows[0]?.googleEventId;
        if (gId) {
            await updateCalendarEvent(gId, {
                title: data.title,
                date: data.date,
                endDate: data.endDate,
                description: data.description,
            });
        }
    } catch (e) {
        // 구글 동기화 실패해도 DB 수정은 이미 완료됨
        console.error("Failed to sync update to Google Calendar:", e);
    }

    revalidatePath("/admin/annual");
    revalidatePath("/annual");
    revalidateTag("admin-annual", { expire: 0 });
}

export async function deleteAnnualEvent(id: string) {
    await requireAdmin();
    // 1단계: 삭제 전에 구글 이벤트 ID를 먼저 조회 (삭제 후에는 조회 불가)
    let googleEventId: string | null = null;
    try {
        const rows = await prisma.$queryRawUnsafe<{ googleEventId: string | null }[]>(
            `SELECT "googleEventId" FROM "AnnualEvent" WHERE id = $1`,
            id,
        );
        googleEventId = rows[0]?.googleEventId ?? null;
    } catch (e) {
        console.error("Failed to fetch googleEventId before delete:", e);
    }

    // 2단계: DB에서 삭제
    try {
        await prisma.$executeRawUnsafe(
            `DELETE FROM "AnnualEvent" WHERE id = $1`,
            id,
        );
    } catch (e) {
        console.error("Failed to delete annual event:", e);
        throw new Error("일정 삭제 실패");
    }

    // 3단계: 구글 캘린더에서도 삭제 (best-effort)
    if (googleEventId) {
        await deleteCalendarEvent(googleEventId);
    }

    revalidatePath("/admin/annual");
    revalidatePath("/annual");
    revalidateTag("admin-annual", { expire: 0 });
}

// ── 원생 관리 CRUD ────────────────────────────────────────────────────────────
export async function createStudent(data: {
    name: string;
    birthDate: string;
    gender?: string | null;
    parentName: string;
    parentPhone?: string | null;
    parentEmail?: string | null;
    // 새 필드: 엑셀 업로드 일괄 등록에서도 사용
    phone?: string | null;       // 학생 휴대폰번호
    school?: string | null;      // 학교명
    grade?: string | null;       // 학년
    address?: string | null;     // 주소
    enrollDate?: string | null;  // 입회일자
    memo?: string | null;        // 메모
}) {
    await requireAdmin();
    try {
        // 학부모 User 생성 또는 조회 (이메일 기준)
        let parentId: string;
        const email = data.parentEmail?.trim() || `parent_${Date.now()}@stiz.local`;

        const existing = await prisma.$queryRawUnsafe<any[]>(
            `SELECT id FROM "User" WHERE email = $1 LIMIT 1`, email
        );

        if (existing.length > 0) {
            parentId = existing[0].id;
            // 이름/전화번호 업데이트
            await prisma.$executeRawUnsafe(
                `UPDATE "User" SET name = $1, phone = $2, "updatedAt" = NOW() WHERE id = $3`,
                data.parentName, data.parentPhone || null, parentId,
            );
        } else {
            const rows = await prisma.$queryRawUnsafe<any[]>(
                `INSERT INTO "User" (id, email, name, phone, role, "createdAt", "updatedAt")
                 VALUES (gen_random_uuid()::text, $1, $2, $3, 'PARENT', NOW(), NOW())
                 RETURNING id`,
                email, data.parentName, data.parentPhone || null,
            );
            parentId = rows[0].id;
        }

        // 원생 생성: 새 필드(phone, school, grade, address, enrollDate, memo) 포함
        await prisma.$executeRawUnsafe(
            `INSERT INTO "Student" (id, name, "birthDate", gender, "parentId", phone, school, grade, address, "enrollDate", memo, "createdAt", "updatedAt")
             VALUES (gen_random_uuid()::text, $1, $2::timestamp, $3, $4, $5, $6, $7, $8, $9::timestamp, $10, NOW(), NOW())`,
            data.name,
            data.birthDate,
            data.gender || null,
            parentId,
            data.phone || null,
            data.school || null,
            data.grade || null,
            data.address || null,
            data.enrollDate || null,
            data.memo || null,
        );
    } catch (e) {
        console.error("Failed to create student:", e);
        throw new Error("원생 등록 실패");
    }
    revalidatePath("/admin/students");
    revalidatePath("/admin");
    revalidateStudentAdminCaches();
}

export async function updateStudentMemo(id: string, memo: string) {
    await requireAdmin();
    try {
        await prisma.$executeRawUnsafe(
            `UPDATE "Student" SET memo = $1, "updatedAt" = NOW() WHERE id = $2`,
            memo || null, id,
        );
    } catch (e) {
        console.error("Failed to update student memo:", e);
        throw new Error("메모 저장 실패");
    }
    revalidatePath("/admin/students");
    revalidateStudentAdminCaches();
}

export async function updateStudent(id: string, data: {
    name: string;
    birthDate: string;
    gender?: string | null;
    parentName: string;
    parentPhone?: string | null;
    // 학부모 이메일(데이터계약 parent.email 대응). 인라인 편집에서 전달
    parentEmail?: string | null;
    // 새 필드: 학생 추가 정보
    phone?: string | null;
    school?: string | null;
    grade?: string | null;
    address?: string | null;
    enrollDate?: string | null;
}) {
    await requireAdmin();
    try {
        // 원생 정보 업데이트: 새 필드(phone, school, grade, address, enrollDate) 포함
        await prisma.$executeRawUnsafe(
            `UPDATE "Student" SET name = $1, "birthDate" = $2::timestamp, gender = $3,
                    phone = $5, school = $6, grade = $7, address = $8, "enrollDate" = $9::timestamp,
                    "updatedAt" = NOW()
             WHERE id = $4`,
            data.name, data.birthDate, data.gender || null, id,
            data.phone || null, data.school || null, data.grade || null,
            data.address || null, data.enrollDate || null,
        );
        // 학부모 정보도 업데이트
        const student = await prisma.$queryRawUnsafe<any[]>(
            `SELECT "parentId" FROM "Student" WHERE id = $1`, id
        );
        if (student[0]) {
            await prisma.$executeRawUnsafe(
                `UPDATE "User" SET name = $1, phone = $2, email = $3, "updatedAt" = NOW() WHERE id = $4`,
                data.parentName, data.parentPhone || null, data.parentEmail || null, student[0].parentId ?? student[0].parentid,
            );
        }
    } catch (e) {
        console.error("Failed to update student:", e);
        throw new Error("원생 수정 실패");
    }
    revalidatePath("/admin/students");
    revalidatePath("/admin");
    revalidateStudentAdminCaches();
}

export async function deleteStudent(id: string) {
    await requireAdmin();
    try {
        // FK 제약 순서: Student를 참조하는 모든 테이블을 먼저 삭제해야 함
        await prisma.$executeRawUnsafe(`DELETE FROM "Guardian" WHERE "studentId" = $1`, id);
        await prisma.$executeRawUnsafe(`DELETE FROM "StudentSessionNote" WHERE "studentId" = $1`, id);
        await prisma.$executeRawUnsafe(`DELETE FROM "Feedback" WHERE "studentId" = $1`, id);
        await prisma.$executeRawUnsafe(`DELETE FROM "SkillRecord" WHERE "studentId" = $1`, id);
        await prisma.$executeRawUnsafe(`DELETE FROM "Waitlist" WHERE "studentId" = $1`, id);
        await prisma.$executeRawUnsafe(`DELETE FROM "MakeupSession" WHERE "studentId" = $1`, id);
        await prisma.$executeRawUnsafe(`DELETE FROM "Attendance" WHERE "studentId" = $1`, id);
        await prisma.$executeRawUnsafe(`DELETE FROM "Payment" WHERE "studentId" = $1`, id);
        await prisma.$executeRawUnsafe(`DELETE FROM "Enrollment" WHERE "studentId" = $1`, id);
        await prisma.$executeRawUnsafe(`DELETE FROM "Student" WHERE id = $1`, id);
    } catch (e) {
        console.error("Failed to delete student:", e);
        throw new Error("원생 삭제 실패");
    }
    revalidatePath("/admin/students");
    revalidatePath("/admin");
    revalidateStudentAdminCaches();
}

// ── 수강 등록 관리 ────────────────────────────────────────────────────────────
export async function enrollStudent(studentId: string, classId: string) {
    const admin = await requireAdmin();
    try {
        await prisma.$transaction(async (tx) => {
            const [context] = await tx.$queryRawUnsafe<Array<{
                studentName: string;
                className: string;
            }>>(
                `SELECT s.name AS "studentName", c.name AS "className"
                   FROM "Student" s
                   CROSS JOIN "Class" c
                  WHERE s.id=$1 AND c.id=$2
                  FOR UPDATE OF s,c`,
                studentId, classId,
            );
            if (!context) throw new Error("학생 또는 수업 정보를 찾을 수 없습니다.");
            const [existingEnrollment] = await tx.$queryRawUnsafe<Array<{
                id: string;
                status: "ACTIVE" | "PAUSED" | "WITHDRAWN";
            }>>(
                `SELECT id,status FROM "Enrollment" WHERE "studentId"=$1 AND "classId"=$2 FOR UPDATE`,
                studentId, classId,
            );
            // 이미 활성인 수강은 updatedAt까지 그대로 보존하는 완전한 no-op입니다.
            if (existingEnrollment?.status === "ACTIVE") return;

            const [enrollment] = await tx.$queryRawUnsafe<Array<{ id: string; updatedAt: Date }>>(
                `INSERT INTO "Enrollment" (id, "studentId", "classId", status, "createdAt", "updatedAt")
                 VALUES (gen_random_uuid()::text, $1, $2, 'ACTIVE', NOW(), NOW())
                 ON CONFLICT ("studentId", "classId") DO UPDATE SET status = 'ACTIVE', "updatedAt" = NOW()
                 RETURNING id,"updatedAt"`,
                studentId, classId,
            );
            const event = buildEnrollmentOperationsEvent({
                enrollmentId: enrollment.id,
                changedAt: enrollment.updatedAt,
                actorUserId: admin.appUserId,
                studentId,
                studentName: context.studentName,
                classId,
                className: context.className,
                previousStatus: existingEnrollment?.status ?? null,
                nextStatus: "ACTIVE",
            });
            if (event) await enqueueWebsiteOperationsEventInTransaction(tx, event);
        });
    } catch (e) {
        console.error("Failed to enroll student:", e);
        if (e instanceof Error && e.message === "학생 또는 수업 정보를 찾을 수 없습니다.") throw e;
        throw new Error("수강 등록 실패");
    }
    revalidatePath("/admin/students");
    revalidatePath("/admin/classes");
    revalidateStudentAdminCaches();
    revalidateClassAdminCaches();
}

export async function updateEnrollmentStatus(
    enrollmentId: string,
    status: string,
    change?: { effectiveFrom?: string; reason?: string },
) {
    const admin = await requireAdmin();

    const allowedStatuses = new Set(["ACTIVE", "PAUSED", "WITHDRAWN"]);
    if (!allowedStatuses.has(status)) {
        throw new Error("허용되지 않는 수강 상태입니다.");
    }
    const effectiveFrom = change?.effectiveFrom?.trim() || todayKst();
    if (!isKstYmd(effectiveFrom)) throw new Error("효력일 형식이 올바르지 않습니다.");
    if (effectiveFrom > todayKst()) throw new Error("미래 효력일은 예약 변경으로 신청해 주세요.");

    let changedStudentId: string | null = null;
    let changedClassId: string | null = null;

    try {
        await prisma.$transaction(async (tx) => {
            const [before] = await tx.$queryRawUnsafe<Array<{
                studentId: string;
                classId: string;
                studentName: string;
                className: string;
                previousStatus: "ACTIVE" | "PAUSED" | "WITHDRAWN";
            }>>(
                `SELECT e."studentId",e."classId",e.status AS "previousStatus",s.name AS "studentName",c.name AS "className"
                   FROM "Enrollment" e
                   JOIN "Student" s ON s.id=e."studentId"
                   JOIN "Class" c ON c.id=e."classId"
                  WHERE e.id=$1
                  FOR UPDATE OF e`,
                enrollmentId,
            );
            if (!before) throw new Error("수강 등록 정보를 찾을 수 없습니다.");
            // 같은 상태를 다시 저장해도 변경 시각과 외부 동기화 원장을 모두 건드리지 않습니다.
            if (before.previousStatus === status) {
                changedStudentId = before.studentId;
                changedClassId = before.classId;
                return;
            }

            const [changed] = await tx.$queryRawUnsafe<Array<{ updatedAt: Date }>>(
                `UPDATE "Enrollment" SET status=$1,"updatedAt"=NOW() WHERE id=$2 RETURNING "updatedAt"`,
                status, enrollmentId,
            );
            const kind = status === "PAUSED" ? "PAUSE" : status === "WITHDRAWN" ? "WITHDRAW" : "RESUME";
            // 이력 id 를 돌려받아 운영 원장에 연결한다(「수강 변경 신청」 화면의 랠리즈 확인 배지용).
            const [history] = await tx.$queryRawUnsafe<Array<{ id: string }>>(
                `INSERT INTO "EnrollmentChangeRequest" (
                    id, "studentId", "enrollmentId", "fromClassId", kind, "effectiveFrom", reason,
                    status, "requestedByUserId", "decidedByUserId", "decidedAt", "appliedAt", "createdAt", "updatedAt"
                ) VALUES (
                    gen_random_uuid()::text, $1, $2, $3, $4, $5::date, $6,
                    'APPLIED', $7, $7, NOW(), NOW(), NOW(), NOW()
                ) RETURNING id`,
                before.studentId,
                enrollmentId,
                before.classId,
                kind,
                effectiveFrom,
                change?.reason?.trim() || `관리자 상태 변경: ${before.previousStatus} → ${status}`,
                admin.appUserId,
            );
            changedStudentId = before.studentId;
            changedClassId = before.classId;
            const event = buildEnrollmentOperationsEvent({
                enrollmentId,
                changedAt: changed.updatedAt,
                actorUserId: admin.appUserId,
                studentId: before.studentId,
                studentName: before.studentName,
                classId: before.classId,
                className: before.className,
                previousStatus: before.previousStatus,
                nextStatus: status as "ACTIVE" | "PAUSED" | "WITHDRAWN",
                enrollmentChangeRequestId: history?.id,
            });
            if (event) await enqueueWebsiteOperationsEventInTransaction(tx, event);
        });
    } catch (e) {
        console.error("Failed to update enrollment:", e);
        if (e instanceof Error && e.message === "수강 등록 정보를 찾을 수 없습니다.") {
            throw e;
        }
        throw new Error("수강 상태 변경 실패");
    }
    revalidatePath("/admin/students");
    if (changedStudentId) revalidatePath(`/admin/students/${changedStudentId}`);
    revalidatePath("/admin/classes");
    if (changedClassId) revalidatePath(`/admin/classes/${changedClassId}`);
    revalidateStudentAdminCaches();
    revalidateClassAdminCaches();
    revalidateFinanceCaches();
}

export async function deleteEnrollment(enrollmentId: string) {
    // 수강 이력은 시트·랠리즈 대조의 근거이므로 삭제하지 않고 퇴원 상태로 보존합니다.
    return updateEnrollmentStatus(enrollmentId, "WITHDRAWN");
}

// ── 출결 관리 ──────────────────────────────────────────────────────────────────
type AdminSeasonalAttendanceContext = {
    sessionDateId: string;
    startsAt: Date;
    linkedClassId: string;
    coachId: string | null;
};

async function getAdminSeasonalAttendanceContext(classId: string, date: string, sessionDateId: string) {
    const rows = await prisma.$queryRawUnsafe<AdminSeasonalAttendanceContext[]>(
        `SELECT sd.id AS "sessionDateId", sd."startsAt", o."linkedClassId", s."coachId"
           FROM "SpecialProgramSessionDate" sd
           JOIN "SpecialProgramOffering" o ON o.id = sd."offeringId"
           LEFT JOIN "Session" s ON s."specialProgramSessionDateId" = sd.id
          WHERE sd.id = $1
            AND o."linkedClassId" = $2
            AND (sd."startsAt" AT TIME ZONE 'Asia/Seoul')::date = $3::date
          LIMIT 1`,
        sessionDateId, classId, date,
    );
    return rows[0] ?? null;
}

async function getAdminSeasonalRosterStudentIds(sessionDateId: string) {
    const rows = await prisma.$queryRawUnsafe<{ studentId: string }[]>(
        `SELECT DISTINCT app."convertedStudentId" AS "studentId"
           FROM "SpecialProgramSessionDate" anchor_sd
           JOIN "SpecialProgramOffering" anchor_o ON anchor_o.id = anchor_sd."offeringId"
           JOIN "SpecialProgramSessionDate" sd
             ON sd."startsAt" = anchor_sd."startsAt" AND sd."endsAt" = anchor_sd."endsAt"
           JOIN "SpecialProgramOffering" o
             ON o.id = sd."offeringId"
            AND (
              o.id = anchor_o.id
              OR (
                anchor_o."linkedClassId" IS NOT NULL
                AND o."linkedClassId" = anchor_o."linkedClassId"
                AND o."seasonId" = anchor_o."seasonId"
              )
            )
           JOIN "SpecialProgramApplicationItem" item ON item."offeringId" = o.id
            AND item.status = 'APPROVED'
            AND item."conversionStatus" IN ('COMPLETED', 'INVOICE_RETRY_REQUIRED')
           JOIN "SpecialProgramApplication" app ON app.id = item."applicationId"
            AND app."convertedStudentId" IS NOT NULL
            AND (
              COALESCE(cardinality(app."selectedWeekdays"), 0) = 0
              OR CASE EXTRACT(ISODOW FROM sd."startsAt" AT TIME ZONE 'Asia/Seoul')::int
                WHEN 1 THEN 'MON' WHEN 2 THEN 'TUE' WHEN 3 THEN 'WED' WHEN 4 THEN 'THU'
                WHEN 5 THEN 'FRI' WHEN 6 THEN 'SAT' ELSE 'SUN'
              END = ANY(app."selectedWeekdays")
            )
          WHERE anchor_sd.id = $1`,
        sessionDateId,
    );
    return new Set(rows.map((row) => row.studentId));
}

// 관리자 방학특강 출결 → 그 학생의 좌석(SpecialProgramEnrollmentDate)을 찾아 보강권을 맞춘다.
// 코치 화면은 좌석 id 로 저장하므로, 여기서도 같은 좌석을 찾아야 sourceKey(SEASONAL:{좌석id})가 같아진다.
// 좌석 범위는 명단 조회(getAdminSeasonalRosterStudentIds)와 같다 — 같은 시각의 같은 강좌 또는 연결 반 형제 강좌.
// 코치 경로(staff-sessions.ts)처럼 승인(APPROVED)된 신청 항목의 좌석만 인정한다 — 취소·반려된 신청의 좌석으로 발급되지 않게.
// 좌석이 없으면(명단 밖·취소된 좌석) 아무것도 하지 않는다.
async function syncAdminSeasonalMakeupCredit(sessionDateId: string, studentId: string, status: string) {
    const seats = await prisma.$queryRawUnsafe<{ id: string }[]>(
        `SELECT e.id
           FROM "SpecialProgramSessionDate" anchor_sd
           JOIN "SpecialProgramOffering" anchor_o ON anchor_o.id = anchor_sd."offeringId"
           JOIN "SpecialProgramSessionDate" sd
             ON sd."startsAt" = anchor_sd."startsAt" AND sd."endsAt" = anchor_sd."endsAt"
           JOIN "SpecialProgramOffering" o
             ON o.id = sd."offeringId"
            AND (
              o.id = anchor_o.id
              OR (
                anchor_o."linkedClassId" IS NOT NULL
                AND o."linkedClassId" = anchor_o."linkedClassId"
                AND o."seasonId" = anchor_o."seasonId"
              )
            )
           JOIN "SpecialProgramApplicationItem" i ON i."offeringId" = o.id AND i.status = 'APPROVED'
           JOIN "SpecialProgramEnrollmentDate" e ON e."sessionDateId" = sd.id AND e."applicationItemId" = i.id
          WHERE anchor_sd.id = $1
            AND e."studentId" = $2
            AND e.status = 'SCHEDULED'
          ORDER BY (sd.id = anchor_sd.id) DESC, e.id
          LIMIT 1`,
        sessionDateId, studentId,
    );
    if (!seats[0]) return;
    // 한 학생·한 회차에 한 장 — 좌석이 여럿이어도 첫 좌석 하나로만 처리한다.
    await syncCreditForSeasonalSeat({ enrollmentDateId: seats[0].id, studentId, status });
}

export async function saveAttendance(classId: string, date: string, records: { studentId: string; status: string }[], options?: { sessionDateId?: string | null }) {
    const admin = await requireAdmin();
    const sessionDateId = options?.sessionDateId?.trim() || null;
    if (sessionDateId) {
        try {
            const context = await getAdminSeasonalAttendanceContext(classId, date, sessionDateId);
            if (!context) throw new Error("방학특강 회차 정보를 찾을 수 없습니다.");
            const rosterStudentIds = await getAdminSeasonalRosterStudentIds(sessionDateId);
            const allowedRecords = records.filter((record) => rosterStudentIds.has(record.studentId));
            if (allowedRecords.length === 0) throw new Error("저장할 방학특강 출석 대상이 없습니다.");

            const sessionRows = await prisma.$queryRawUnsafe<any[]>(
                `INSERT INTO "Session" (
                    id, "classId", date, "sessionKey", status, "coachId", "specialProgramSessionDateId", "createdAt", "updatedAt"
                 )
                 VALUES (
                    gen_random_uuid()::text, $1, $2::date, $3, 'PLANNED', $4, $5, NOW(), NOW()
                 )
                 ON CONFLICT ("sessionKey") DO UPDATE SET "updatedAt" = NOW()
                 RETURNING id`,
                classId,
                sessionDateForKorea(context.startsAt),
                `seasonal:${sessionDateId}`,
                context.coachId,
                sessionDateId,
            );
            const sessionId = sessionRows[0].id;
            for (const rec of allowedRecords) {
                await prisma.$executeRawUnsafe(
                    `INSERT INTO "Attendance" (id, "sessionId", "studentId", status, "checkedAt", "checkedByUserId", "createdAt", "updatedAt")
                     VALUES (gen_random_uuid()::text, $1, $2, $3, NOW(), $4, NOW(), NOW())
                     ON CONFLICT ("sessionId", "studentId") DO UPDATE SET
                       status = $3,
                       "checkedAt" = COALESCE("Attendance"."checkedAt", NOW()),
                       "checkedByUserId" = $4,
                       "updatedAt" = NOW()`,
                    sessionId, rec.studentId, rec.status, admin.appUserId,
                );
            }
            // 보강권 — 결석이면 발급, 출석·지각으로 정정되면 회수(코치 화면과 같은 규칙·같은 키).
            // ★ 출결은 이미 저장됐다. 보강권이 실패해도 출결 저장을 실패로 만들지 않는다.
            for (const rec of allowedRecords) {
                try {
                    await syncAdminSeasonalMakeupCredit(sessionDateId, rec.studentId, rec.status);
                } catch (error) {
                    console.error("[saveAttendance] 방학특강 보강권 처리 실패(출결은 저장됨)", {
                        sessionDateId, studentId: rec.studentId, error,
                    });
                }
            }
            const studentIds = allowedRecords.map(r => r.studentId);
            const dateStr = new Date(date).toLocaleDateString("ko-KR", { month: "long", day: "numeric" });
            await notifyParentsOfStudents(
                studentIds,
                "ATTENDANCE",
                "출석 확인",
                `${dateStr} 방학특강 출석이 기록되었습니다.`,
                "/mypage",
            );
        } catch (e) {
            console.error("Failed to save seasonal attendance:", e);
            throw new Error("방학특강 출석 저장 실패");
        }
        revalidatePath("/admin/attendance");
        revalidatePath("/staff");
        revalidatePath("/mypage");
        return;
    }
    try {
        // 세션 생성 또는 조회
        const existing = await prisma.$queryRawUnsafe<any[]>(
            `SELECT id FROM "Session" WHERE "classId" = $1 AND date::date = $2::date AND "specialProgramSessionDateId" IS NULL LIMIT 1`,
            classId, date
        );
        let sessionId: string;
        if (existing.length > 0) {
            sessionId = existing[0].id;
        } else {
            const rows = await prisma.$queryRawUnsafe<any[]>(
                `INSERT INTO "Session" (id, "classId", date, "createdAt", "updatedAt")
                 VALUES (gen_random_uuid()::text, $1, $2::timestamp, NOW(), NOW())
                 RETURNING id`,
                classId, date
            );
            sessionId = rows[0].id;
        }

        // 각 학생 출석 기록 upsert
        for (const rec of records) {
            await prisma.$executeRawUnsafe(
                `INSERT INTO "Attendance" (id, "sessionId", "studentId", status, "createdAt", "updatedAt")
                 VALUES (gen_random_uuid()::text, $1, $2, $3, NOW(), NOW())
                 ON CONFLICT ("sessionId", "studentId") DO UPDATE SET status = $3, "updatedAt" = NOW()`,
                sessionId, rec.studentId, rec.status
            );
        }
        // 보강권 — 결석이면 발급, 출석·지각으로 정정되면 회수(코치 화면과 같은 함수).
        // ★ 출결은 이미 저장됐다. 보강권이 실패해도 출결 저장을 실패로 만들지 않는다.
        for (const rec of records) {
            try {
                await syncCreditForRegularSession({ sessionId, studentId: rec.studentId, status: rec.status });
            } catch (error) {
                console.error("[saveAttendance] 보강권 처리 실패(출결은 저장됨)", {
                    sessionId, studentId: rec.studentId, error,
                });
            }
        }
        // 출결 완료 알림 → 학부모에게 전송
        const studentIds = records.map(r => r.studentId);
        const dateStr = new Date(date).toLocaleDateString("ko-KR", { month: "long", day: "numeric" });
        await notifyParentsOfStudents(
            studentIds,
            "ATTENDANCE",
            "출결 확인",
            `${dateStr} 출결이 기록되었습니다.`,
            "/mypage",
        );
    } catch (e) {
        console.error("Failed to save attendance:", e);
        throw new Error("출결 저장 실패");
    }
    revalidatePath("/admin/attendance");
    revalidatePath("/mypage");
}

// ── 수납 관리 ──────────────────────────────────────────────────────────────────
function revalidateFinanceCaches() {
    revalidatePath("/admin/finance");
    revalidatePath("/admin/stats");
    revalidateTag("admin-finance", { expire: 0 });
    revalidateTag("admin-stats", { expire: 0 });
}

async function requireFinanceOwner() {
    const admin = await requireAdmin();
    if (admin.appUserRole !== "ADMIN") {
        throw new Error("수퍼관리자 권한이 필요합니다.");
    }
    return admin;
}

export async function createPayment(data: {
    studentId: string;
    classId?: string | null;
    amount: number;
    dueDate: string;
    status?: string;
    type?: string;        // 청구 유형: MONTHLY, SHUTTLE, UNIFORM, OTHER
    description?: string; // 설명: "4월 수강료" 등
    notifyParent?: boolean;
}) {
    const admin = await requireAdmin();
    try {
        const dueDate = new Date(data.dueDate);
        if (Number.isNaN(dueDate.getTime())) throw new Error("납부 기한이 올바르지 않습니다.");
        if (!Number.isSafeInteger(data.amount) || data.amount <= 0) throw new Error("청구 금액은 1원 이상의 정수여야 합니다.");
        const year = dueDate.getFullYear();
        const month = dueDate.getMonth() + 1;
        const requestedStatus = data.status || "PENDING";
        const paymentType = data.type || "MONTHLY";
        if (!["PENDING", "PAID", "OVERDUE"].includes(requestedStatus)) {
            throw new Error("지원하지 않는 수납 상태입니다.");
        }
        if (!["MONTHLY", "SHUTTLE", "UNIFORM", "OTHER"].includes(paymentType)) {
            throw new Error("지원하지 않는 수납 유형입니다.");
        }
        if (admin.appUserRole !== "ADMIN" && requestedStatus !== "PENDING") {
            throw new Error("수퍼관리자만 납부 상태로 바로 등록할 수 있습니다.");
        }
        if (data.notifyParent && requestedStatus !== "PENDING") {
            throw new Error("학부모 수납 안내는 미납 청구에만 보낼 수 있습니다.");
        }
        await ensurePaymentInfrastructure();
        if (data.notifyParent) {
            const parentRows = await prisma.$queryRawUnsafe<{ parentId: string | null }[]>(
                `SELECT "parentId" FROM "Student" WHERE id = $1 LIMIT 1`, data.studentId,
            );
            if (!parentRows[0]?.parentId) throw new Error("연결된 학부모가 없어 알림을 보낼 수 없습니다.");
        }
        const classId = data.classId?.trim() || null;
        if (["MONTHLY", "SHUTTLE"].includes(paymentType) && !classId) {
            throw new Error("수강료와 셔틀 청구에는 연결할 수업을 선택해 주세요.");
        }
        const invoice = await prisma.$transaction(async (tx) => {
            if (classId) {
                const enrollment = await tx.$queryRawUnsafe<{ id: string }[]>(
                    `SELECT id FROM "Enrollment"
                     WHERE "studentId" = $1 AND "classId" = $2 AND status = 'ACTIVE'
                     LIMIT 1 FOR SHARE`,
                    data.studentId,
                    classId,
                );
                if (enrollment.length === 0) {
                    throw new Error("선택한 수업에 현재 수강 중인 학생만 청구할 수 있습니다.");
                }
            }
            const rows = await tx.$queryRawUnsafe<{ id: string }[]>(
                `INSERT INTO "Payment" (id, "studentId", "classId", amount, status, "dueDate", year, month, type, description, "createdAt", "updatedAt")
                 VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5::timestamp, $6, $7, $8, $9, NOW(), NOW())
                 RETURNING id`,
                data.studentId, classId, data.amount, requestedStatus, data.dueDate,
                year, month, paymentType, data.description || null,
            );
            const paymentId = rows[0]?.id;
            if (!paymentId) throw new Error("청구 기록을 생성하지 못했습니다.");
            await ensureInvoicesForMonth(year, month, [paymentId], tx);
            const invoiceRows = await tx.$queryRawUnsafe<{ id: string }[]>(
                `SELECT id FROM "PaymentInvoice" WHERE "paymentId" = $1`, paymentId,
            );
            if (!invoiceRows[0]) throw new Error("청구서를 생성하지 못했습니다.");
            await tx.$executeRawUnsafe(
                `INSERT INTO "PaymentAuditLog" (
                    id, "paymentId", "invoiceId", "actorType", "actorId", action, message, metadata, "createdAt"
                 ) VALUES (
                    gen_random_uuid()::text, $1, $2, 'ADMIN', $3, 'PAYMENT_CREATE_MANUAL', $4, $5::jsonb, NOW()
                 )`,
                paymentId, invoiceRows[0].id, admin.appUserId,
                "관리자 수동 청구 생성",
                JSON.stringify({ classId, amount: data.amount, year, month, type: paymentType, notifyParent: Boolean(data.notifyParent) }),
            );
            return invoiceRows[0];
        });

        // 학부모 청구 안내는 랠리즈 전담(B안) — 사이트 발송 잠금이 풀린 경우에만 알린다.
        if (data.notifyParent && isBillingParentSendEnabled()) {
            const amountStr = data.amount.toLocaleString("ko-KR");
            await notifyParentsOfStudents(
                [data.studentId],
                "PAYMENT",
                "수납 안내",
                `${amountStr}원 수납 요청이 등록되었습니다.`,
                `/payments/${invoice.id}`,
            );
        }
    } catch (e) {
        console.error("Failed to create payment:", e);
        throw new Error(e instanceof Error ? e.message : "수납 기록 생성 실패");
    }
    revalidateFinanceCaches();
    revalidatePath("/mypage");
}

export async function cancelUnpaidPayment(id: string, reason: string) {
    const admin = await requireFinanceOwner();
    const paymentId = id?.trim();
    const cancelReason = reason?.trim();
    if (!paymentId) throw new Error("취소할 청구를 선택해 주세요.");
    if (!cancelReason || cancelReason.length > 300) throw new Error("취소 사유를 1~300자로 입력해 주세요.");

    try {
        await ensurePaymentInfrastructure();
        await prisma.$transaction(async (tx) => {
            const paymentRows = await tx.$queryRawUnsafe<{ status: string; amount: number; year: number | null; month: number | null }[]>(
                `SELECT status, amount, year, month FROM "Payment" WHERE id = $1 FOR UPDATE`,
                paymentId,
            );
            const payment = paymentRows[0];
            if (!payment) throw new Error("수납 기록을 찾을 수 없습니다.");
            if (!["PENDING", "OVERDUE"].includes(payment.status)) {
                throw new Error("미납 또는 연체 상태의 청구만 취소할 수 있습니다.");
            }

            // 취소 도중 새 청구서를 만들지 않는다. 현재 연결된 청구서만 잠가 검증한다.
            const invoiceRows = await tx.$queryRawUnsafe<{ id: string; status: string }[]>(
                `SELECT id, status FROM "PaymentInvoice" WHERE "paymentId" = $1 FOR UPDATE`,
                paymentId,
            );
            const invoice = invoiceRows[0];
            if (!invoice) throw new Error("연결된 청구서를 찾을 수 없습니다.");
            if (!["ISSUED", "SENT", "OVERDUE"].includes(invoice.status)) {
                throw new Error("현재 청구서 상태에서는 취소할 수 없습니다. 다시 조회해 주세요.");
            }

            const completedTransactions = await tx.$queryRawUnsafe<{ id: string }[]>(
                `SELECT id FROM "PaymentTransaction" WHERE "paymentId" = $1 AND status = 'DONE' LIMIT 1`,
                paymentId,
            );
            if (completedTransactions.length > 0) {
                throw new Error("완료된 결제 거래가 있어 취소할 수 없습니다. 환불 절차를 사용해 주세요.");
            }

            const paymentUpdated = await tx.$executeRawUnsafe(
                `UPDATE "Payment" SET status = 'CANCELED', "paidDate" = NULL, "updatedAt" = NOW()
                 WHERE id = $1 AND status IN ('PENDING', 'OVERDUE')`,
                paymentId,
            );
            const invoiceUpdated = await tx.$executeRawUnsafe(
                `UPDATE "PaymentInvoice" SET status = 'CANCELED', "canceledAt" = NOW(), "updatedAt" = NOW()
                 WHERE id = $1 AND "paymentId" = $2 AND status IN ('ISSUED', 'SENT', 'OVERDUE')`,
                invoice.id,
                paymentId,
            );
            if (paymentUpdated !== 1 || invoiceUpdated !== 1) {
                throw new Error("현재 수납·청구 상태가 바뀌어 취소하지 않았습니다. 다시 조회해 주세요.");
            }

            await tx.$executeRawUnsafe(
                `INSERT INTO "PaymentAuditLog" (
                    id, "paymentId", "invoiceId", "actorType", "actorId", action, message, metadata, "createdAt"
                 ) VALUES (
                    gen_random_uuid()::text, $1, $2, 'ADMIN', $3, 'PAYMENT_CANCEL_UNPAID', $4, $5::jsonb, NOW()
                 )`,
                paymentId,
                invoice.id,
                admin.appUserId,
                cancelReason,
                JSON.stringify({ amount: payment.amount, year: payment.year, month: payment.month }),
            );
        });
    } catch (e) {
        console.error("Failed to cancel unpaid payment:", e);
        throw new Error(e instanceof Error ? e.message : "미납 청구 취소 실패");
    }
    revalidateFinanceCaches();
    revalidatePath("/mypage");
}

export async function updatePaymentStatus(id: string, status: string) {
    await requireFinanceOwner();
    try {
        await ensurePaymentInfrastructure();
        if (status === "PAID") {
            await markPaymentPaid({
                paymentId: id,
                actorType: "ADMIN",
                method: "MANUAL",
            });
            revalidateFinanceCaches();
            return;
        }

        const invoice = await ensureInvoiceForPayment(id);
        const invoiceStatus = status === "OVERDUE"
            ? "OVERDUE"
            : ["REFUNDED", "CANCELED"].includes(status)
                ? "CANCELED"
                : "ISSUED";

        await prisma.$executeRawUnsafe(
            `UPDATE "Payment" SET status = $1, "paidDate" = NULL, "updatedAt" = NOW() WHERE id = $2`,
            status, id,
        );
        if (invoice?.id) {
            await prisma.$executeRawUnsafe(
                `UPDATE "PaymentInvoice" SET status = $1, "updatedAt" = NOW() WHERE id = $2`,
                invoiceStatus,
                invoice.id,
            );
        }
        await recordPaymentAudit({
            paymentId: id,
            invoiceId: invoice?.id ?? null,
            actorType: "ADMIN",
            action: "PAYMENT_STATUS_UPDATE",
            message: `Payment status changed to ${status}`,
        });
    } catch (e) {
        console.error("Failed to update payment:", e);
        throw new Error("수납 상태 변경 실패");
    }
    revalidateFinanceCaches();
}

export async function markTerminalPaymentPaid(data: {
    paymentId: string;
    approvalNo: string;
    receivedAt?: string;
    memo?: string;
}) {
    const admin = await requireFinanceOwner();
    const paymentId = data.paymentId?.trim();
    const approvalNo = data.approvalNo?.trim();

    if (!paymentId) {
        throw new Error("수납 기록을 선택해 주세요.");
    }
    if (!approvalNo) {
        throw new Error("단말기 승인번호를 입력해 주세요.");
    }

    try {
        const result = await recordTerminalPayment({
            paymentId,
            approvalNo,
            receivedAt: data.receivedAt || null,
            memo: data.memo || null,
            method: "CARD",
            actorType: "ADMIN",
            actorId: admin.appUserId,
        });
        revalidateFinanceCaches();
        revalidatePath("/mypage");
        return result;
    } catch (e) {
        console.error("Failed to mark terminal payment:", e);
        throw new Error(e instanceof Error ? e.message : "현장 단말기 결제 반영 실패");
    }
}

export async function deletePayment(id: string) {
    await requireFinanceOwner();
    try {
        await ensurePaymentInfrastructure();
        await prisma.$executeRawUnsafe(`DELETE FROM "PaymentTransaction" WHERE "paymentId" = $1`, id);
        await prisma.$executeRawUnsafe(`DELETE FROM "PaymentInvoice" WHERE "paymentId" = $1`, id);
        await prisma.$executeRawUnsafe(`DELETE FROM "Payment" WHERE id = $1`, id);
    } catch (e) {
        console.error("Failed to delete payment:", e);
        throw new Error("수납 기록 삭제 실패");
    }
    revalidateFinanceCaches();
}

let _galleryInstagramColumnsEnsured = false;
async function ensureGalleryPostInstagramColumns() {
    if (_galleryInstagramColumnsEnsured) return;
    const columns: [string, string][] = [
        ["source", "TEXT DEFAULT 'WEBSITE'"],
        ["externalId", "TEXT"],
        ["externalUrl", "TEXT"],
        ["instagramMediaId", "TEXT"],
        ["instagramPermalink", "TEXT"],
        ["instagramPublishedAt", "TIMESTAMPTZ"],
        ["instagramPublishError", "TEXT"],
    ];
    for (const [col, type] of columns) {
        try {
            await prisma.$executeRawUnsafe(
                `ALTER TABLE "GalleryPost" ADD COLUMN IF NOT EXISTS "${col}" ${type}`
            );
        } catch (e) {
            console.warn(`[DDL] GalleryPost column "${col}" ensure failed:`, (e as Error).message);
        }
    }
    _galleryInstagramColumnsEnsured = true;
}

function galleryInstagramCaption(title?: string | null, caption?: string | null) {
    return [title?.trim(), caption?.trim()].filter(Boolean).join("\n\n");
}

// ── 갤러리 관리 ──────────────────────────────────────────────────────────────
export async function createGalleryPost(data: {
    classId?: string | null;
    title?: string | null;
    caption?: string | null;
    mediaJSON: string;
    isPublic?: boolean;
}) {
    await requireAdmin();
    let postId: string | null = null;
    try {
        await ensureGalleryPostInstagramColumns();
        const rows = await prisma.$queryRawUnsafe<any[]>(
            `INSERT INTO "GalleryPost" (id, "classId", title, caption, "mediaJSON", "isPublic", "createdAt", "updatedAt")
             VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, NOW(), NOW())
             RETURNING id`,
            data.classId || null,
            data.title || null,
            data.caption || null,
            data.mediaJSON,
            data.isPublic !== false,
        );
        postId = rows[0]?.id ?? null;

        if (postId && data.isPublic !== false) {
            const settings = await getAcademySettings() as any;
            if (settings.instagramAutoPublishEnabled) {
                const result = await publishGalleryPostToInstagram({
                    businessAccountId: settings.instagramBusinessAccountId,
                    caption: galleryInstagramCaption(data.title, data.caption),
                    mediaJSON: data.mediaJSON,
                });
                if (result.attempted) {
                    await prisma.$executeRawUnsafe(
                        `UPDATE "GalleryPost"
                         SET "instagramMediaId" = $1,
                             "instagramPermalink" = $2,
                             "instagramPublishedAt" = $3,
                             "instagramPublishError" = $4
                         WHERE id = $5`,
                        result.ok ? result.instagramMediaId ?? null : null,
                        result.ok ? result.permalink ?? null : null,
                        result.ok ? new Date() : null,
                        result.ok ? null : result.error ?? null,
                        postId,
                    );
                }
            }
        }
    } catch (e) {
        console.error("Failed to create gallery post:", e);
        throw new Error("갤러리 게시물 생성 실패");
    }
    revalidatePath("/admin/gallery");
    revalidateGalleryAdminCaches();
    revalidatePath("/gallery");
    revalidatePath("/mypage");
    revalidatePath("/");
}

export async function syncInstagramGalleryPosts() {
    await requireAdmin();
    const settings = await getAcademySettings() as any;
    const result = await syncInstagramGalleryPostsToDb({
        businessAccountId: settings.instagramBusinessAccountId,
        limit: 25,
    });

    revalidatePath("/admin/gallery");
    revalidateGalleryAdminCaches();
    revalidatePath("/gallery");
    revalidatePath("/");
    return result;
}

export async function updateGalleryPost(id: string, data: {
    classId?: string | null;
    title?: string | null;
    caption?: string | null;
    mediaJSON?: string;
    isPublic?: boolean;
}) {
    await requireAdmin();
    try {
        await prisma.$executeRawUnsafe(
            `UPDATE "GalleryPost" SET "classId" = $1, title = $2, caption = $3,
             "mediaJSON" = $4, "isPublic" = $5, "updatedAt" = NOW() WHERE id = $6`,
            data.classId || null,
            data.title || null,
            data.caption || null,
            data.mediaJSON || "[]",
            data.isPublic !== false,
            id,
        );
    } catch (e) {
        console.error("Failed to update gallery post:", e);
        throw new Error("갤러리 게시물 수정 실패");
    }
    revalidatePath("/admin/gallery");
    revalidateGalleryAdminCaches();
    revalidatePath("/gallery");
    revalidatePath("/mypage");
    revalidatePath("/");
}

export async function deleteGalleryPost(id: string) {
    await requireAdmin();
    try {
        await prisma.$executeRawUnsafe(`DELETE FROM "GalleryPost" WHERE id = $1`, id);
    } catch (e) {
        console.error("Failed to delete gallery post:", e);
        throw new Error("갤러리 게시물 삭제 실패");
    }
    revalidatePath("/admin/gallery");
    revalidateGalleryAdminCaches();
    revalidatePath("/gallery");
    revalidatePath("/mypage");
    revalidatePath("/");
}

// ── 공지사항 관리 ────────────────────────────────────────────────────────────
export async function createNotice(data: {
    title: string;
    content: string;
    targetType?: string;
    targetClassIds?: string | null;
    attachmentsJSON?: string | null;
    isPinned?: boolean;
}) {
    await requireAdmin();
    try {
        await prisma.$executeRawUnsafe(
            `INSERT INTO "Notice" (id, title, content, "targetType", "targetClassIds", "attachmentsJSON", "isPinned", "createdAt", "updatedAt")
             VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, NOW(), NOW())`,
            data.title,
            data.content,
            data.targetType || "ALL",
            data.targetClassIds || null,
            data.attachmentsJSON || null,
            data.isPinned || false,
        );
        // 공지 작성 알림 → 모든 학부모에게
        await notifyAllParents(
            "NOTICE",
            "새 공지사항",
            data.title,
            "/notices",
        );
    } catch (e) {
        console.error("Failed to create notice:", e);
        throw new Error("공지사항 생성 실패");
    }
    revalidatePath("/admin/notices");
    revalidateNoticeAdminCaches();
    revalidatePath("/notices");
    revalidatePath("/mypage");
    revalidatePath("/");
}

export async function updateNotice(id: string, data: {
    title: string;
    content: string;
    targetType?: string;
    targetClassIds?: string | null;
    attachmentsJSON?: string | null;
    isPinned?: boolean;
}) {
    await requireAdmin();
    try {
        await prisma.$executeRawUnsafe(
            `UPDATE "Notice" SET title = $1, content = $2, "targetType" = $3,
             "targetClassIds" = $4, "attachmentsJSON" = $5, "isPinned" = $6, "updatedAt" = NOW()
             WHERE id = $7`,
            data.title,
            data.content,
            data.targetType || "ALL",
            data.targetClassIds || null,
            data.attachmentsJSON || null,
            data.isPinned || false,
            id,
        );
    } catch (e) {
        console.error("Failed to update notice:", e);
        throw new Error("공지사항 수정 실패");
    }
    revalidatePath("/admin/notices");
    revalidateNoticeAdminCaches();
    revalidatePath("/notices");
    revalidatePath("/mypage");
    revalidatePath("/");
}

export async function deleteNotice(id: string) {
    await requireAdmin();
    try {
        await prisma.$executeRawUnsafe(`DELETE FROM "Notice" WHERE id = $1`, id);
    } catch (e) {
        console.error("Failed to delete notice:", e);
        throw new Error("공지사항 삭제 실패");
    }
    revalidatePath("/admin/notices");
    revalidateNoticeAdminCaches();
    revalidatePath("/notices");
    revalidatePath("/mypage");
    revalidatePath("/");
}

// ── 알림 시스템 ──────────────────────────────────────────────────────────────
// createNotificationRecord, notifyParentsOfStudents, notifyAllParents는
// src/lib/notification.ts로 이동됨 (import 참조)

// 알림 읽음 처리
export async function markNotificationRead(id: string) {
    await requireAdmin();
    try {
        await prisma.$executeRawUnsafe(
            `UPDATE "Notification" SET "isRead" = true WHERE id = $1`, id
        );
    } catch (e) {
        console.error("Failed to mark notification read:", e);
        throw new Error("알림 읽음 처리 실패");
    }
    revalidatePath("/mypage");
}

// 모든 알림 읽음 처리
export async function markAllNotificationsRead(userId: string) {
    await requireAdmin();
    try {
        await prisma.$executeRawUnsafe(
            `UPDATE "Notification" SET "isRead" = true WHERE "userId" = $1 AND "isRead" = false`,
            userId,
        );
    } catch (e) {
        console.error("Failed to mark all notifications read:", e);
        throw new Error("알림 전체 읽음 처리 실패");
    }
    revalidatePath("/mypage");
}

// ── 학부모 요청 시스템 ───────────────────────────────────────────────────────

// 학부모가 요청 접수
export async function createParentRequest(data: {
    userId: string;
    studentId: string;
    type: string;
    title: string;
    content: string;
    date?: string | null;
}) {
    const parent = await requireVerifiedParent();
    const studentId = data.studentId?.trim();
    const type = data.type?.trim().toUpperCase();
    const title = data.title?.trim();
    const content = data.content?.trim();
    const allowedTypes = new Set(["ABSENCE", "SHUTTLE", "EARLY_LEAVE", "OTHER"]);
    if (!studentId || studentId.length > 100) throw new Error("올바른 자녀를 선택해 주세요.");
    if (!allowedTypes.has(type)) throw new Error("올바른 요청 유형을 선택해 주세요.");
    if (!title || title.length > 200) throw new Error("요청 제목은 200자 이내로 입력해 주세요.");
    if (!content || content.length > 2000) throw new Error("요청 내용은 2,000자 이내로 입력해 주세요.");
    const requestedDate = data.date ? new Date(data.date) : null;
    if (requestedDate && Number.isNaN(requestedDate.getTime())) throw new Error("올바른 날짜를 입력해 주세요.");

    const ownedStudent = await prisma.student.findFirst({
        where: { id: studentId, parentId: parent.appUserId },
        select: { id: true, name: true },
    });
    if (!ownedStudent) throw new Error("본인 자녀에 대해서만 요청할 수 있습니다.");
    try {
        await prisma.$executeRawUnsafe(
            `INSERT INTO "ParentRequest" (id, "userId", "studentId", type, title, content, date, status, "createdAt", "updatedAt")
             VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6::timestamptz, 'PENDING', NOW(), NOW())`,
            parent.appUserId, ownedStudent.id, type, title, content, requestedDate,
        );
    } catch (e) {
        console.error("Failed to create parent request:", e);
        throw new Error("요청 접수에 실패했습니다.");
    }
    try {
        // 관리자(ADMIN)에게 알림
        const admins = await prisma.$queryRawUnsafe<any[]>(
            `SELECT id FROM "User" WHERE role = 'ADMIN'`
        );
        // 해당 원생 이름 조회
        const studentRows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT name FROM "Student" WHERE id = $1`, ownedStudent.id
        );
        const studentName = studentRows[0]?.name ?? "원생";
        const typeLabels: Record<string, string> = {
            ABSENCE: "결석 신청", SHUTTLE: "셔틀 변경", EARLY_LEAVE: "조퇴 요청", OTHER: "기타 요청"
        };
        const typeLabel = typeLabels[type] || type;

        for (const admin of admins) {
            await createNotificationRecord({
                userId: admin.id,
                type: "REQUEST",
                title: `${typeLabel} 접수`,
                message: `${studentName} - ${title}`,
                linkUrl: "/admin/requests",
            });
        }
    } catch (e) {
        // 요청은 이미 저장되었으므로 알림 장애를 학부모의 접수 실패로 돌려주지 않는다.
        console.error("Parent request saved, but admin notification failed:", e);
    }
    revalidatePath("/mypage");
    revalidatePath("/admin");
    revalidateRequestAdminCaches();
    revalidatePath("/admin/requests");
}

// 일반 메시지 상담 상태이며 실제 출결·배차 반영을 의미하지 않는다.
export async function updateRequestStatus(id: string, status: string, adminNote?: string) {
    await requireAdmin();
    if (!id || !["PENDING", "CONFIRMED", "COMPLETED", "REJECTED"].includes(status)) {
        throw new Error("허용되지 않은 상담 상태입니다.");
    }
    if (adminNote !== undefined && adminNote.length > 2000) throw new Error("답변은 2,000자 이내로 입력해 주세요.");
    const before = await getParentRequestStatusForAdmin(id);
    if (!before) throw new Error("요청을 찾을 수 없습니다. 목록을 다시 확인해 주세요.");
    const note = adminNote === undefined ? before.adminNote : adminNote || null;
    // 이미 저장된 동일 상태/메모는 재전송하지 않는다.
    if (before.status === status && before.adminNote === note) {
        return { saved: true as const, notification: "UNCHANGED" as const };
    }
    let updated;
    try {
        updated = await prisma.$queryRawUnsafe<{ id: string }[]>(
            `UPDATE "ParentRequest" SET status = $1, "adminNote" = $2, "updatedAt" = NOW()
             WHERE id = $3 AND status = $4 AND "adminNote" IS NOT DISTINCT FROM $5 RETURNING id`,
            status, note, id, before.status, before.adminNote,
        );
    } catch {
        return { saved: false as const, notification: "UNKNOWN" as const };
    }
    if (!updated.length) return { saved: false as const, notification: "UNKNOWN" as const };
    revalidateRequestAdminCaches();
    revalidatePath("/admin/requests");
    revalidatePath("/admin");
    revalidatePath("/mypage");

    let notification: "REGISTERED" | "FAILED" | "UNKNOWN" = "UNKNOWN";
    try {
        // 이 액션만 알림 등록 결과를 반환한다. 공용 알림 함수의 다른 호출은 변경하지 않는다.
        await prisma.$executeRawUnsafe(
            `INSERT INTO "Notification" (id, "userId", type, title, message, "linkUrl", "isRead", "createdAt")
             VALUES (gen_random_uuid()::text, $1, 'REQUEST', '메시지 상담 상태 안내', $2, '/mypage', false, NOW())`,
            before.userId,
            `"${before.title}" → ${({ PENDING: "상담 대기", CONFIRMED: "내용 확인", COMPLETED: "상담 종결", REJECTED: "반려" } as Record<string, string>)[status]}. 출결·셔틀 변경 여부는 해당 화면에서 확인해 주세요.`,
        );
        notification = "REGISTERED";
    } catch {
        // 응답 유실 시 실제 등록됐을 수 있으므로 자동 재발송하지 않는다.
        notification = "UNKNOWN";
    }
    let push: string = "NOT_ATTEMPTED";
    if (notification === "REGISTERED") {
        try {
            const { sendPushToUser } = await import("@/lib/pushNotification");
            push = (await sendPushToUser(before.userId, {
                title: "메시지 상담 상태 안내", body: "상담 상태가 변경되었습니다. 보낸 메시지에서 확인해 주세요.", url: "/mypage", tag: "REQUEST",
            })).status;
        } catch { push = "UNKNOWN"; }
    }
    return { saved: true as const, notification, push };
}

export async function getParentRequestStatusForAdmin(id: string) {
    await requireAdmin();
    const rows = await prisma.$queryRawUnsafe<{ id: string; userId: string; title: string; status: string; adminNote: string | null }[]>(
        `SELECT id, "userId", title, status, "adminNote" FROM "ParentRequest" WHERE id = $1`, id,
    );
    return rows[0] ?? null;
}

// 요청 삭제 (관리자)
export async function deleteParentRequest(id: string) {
    await requireAdmin();
    try {
        await prisma.$executeRawUnsafe(`DELETE FROM "ParentRequest" WHERE id = $1`, id);
    } catch (e) {
        console.error("Failed to delete parent request:", e);
        throw new Error("요청 삭제 실패");
    }
    revalidateRequestAdminCaches();
    revalidatePath("/admin/requests");
    revalidatePath("/admin");
    revalidatePath("/mypage");
}

// ── 학습 피드백 ──────────────────────────────────────────────────────────────

// 피드백 생성: 코치가 원생에게 학습 피드백을 작성하고, 해당 학부모에게 알림 전송
export async function createFeedback(data: {
    studentId: string;
    coachId: string;
    sessionDate?: string | null;
    category?: string;
    title: string;
    content: string;
    rating?: number | null;
    isPublic?: boolean;
}) {
    await requireAdmin();
    try {
        await prisma.$executeRawUnsafe(
            `INSERT INTO "Feedback" (id, "studentId", "coachId", "sessionDate", category, title, content, rating, "isPublic", "createdAt", "updatedAt")
             VALUES (gen_random_uuid()::text, $1, $2, $3::timestamptz, $4, $5, $6, $7, $8, NOW(), NOW())`,
            data.studentId, data.coachId, data.sessionDate || null,
            data.category || "GENERAL", data.title, data.content,
            data.rating ?? null, data.isPublic !== false,
        );

        // 학부모에게 피드백 알림 전송
        const studentRows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT name, "parentId" FROM "Student" WHERE id = $1`, data.studentId
        );
        if (studentRows[0]) {
            const parentId = studentRows[0].parentId ?? studentRows[0].parentid;
            if (parentId) {
                await createNotificationRecord({
                    userId: parentId,
                    type: "FEEDBACK",
                    title: "학습 피드백",
                    message: `${studentRows[0].name} - ${data.title}`,
                    linkUrl: "/mypage",
                });
            }
        }
    } catch (e) {
        console.error("Failed to create feedback:", e);
        throw new Error("피드백 작성 실패");
    }
    revalidateFeedbackAdminCaches();
    revalidatePath("/admin/feedback");
    revalidatePath("/mypage");
}

// 피드백 수정: 제목/내용/카테고리/평점/공개여부 변경
export async function updateFeedback(id: string, data: {
    category?: string;
    title: string;
    content: string;
    rating?: number | null;
    isPublic?: boolean;
}) {
    await requireAdmin();
    try {
        await prisma.$executeRawUnsafe(
            `UPDATE "Feedback" SET category = $1, title = $2, content = $3, rating = $4, "isPublic" = $5, "updatedAt" = NOW()
             WHERE id = $6`,
            data.category || "GENERAL", data.title, data.content,
            data.rating ?? null, data.isPublic !== false, id,
        );
    } catch (e) {
        console.error("Failed to update feedback:", e);
        throw new Error("피드백 수정 실패");
    }
    revalidateFeedbackAdminCaches();
    revalidatePath("/admin/feedback");
    revalidatePath("/mypage");
}

// 피드백 삭제
export async function deleteFeedback(id: string) {
    await requireAdmin();
    try {
        await prisma.$executeRawUnsafe(`DELETE FROM "Feedback" WHERE id = $1`, id);
    } catch (e) {
        console.error("Failed to delete feedback:", e);
        throw new Error("피드백 삭제 실패");
    }
    revalidateFeedbackAdminCaches();
    revalidatePath("/admin/feedback");
    revalidatePath("/mypage");
}

// ── FAQ 관리 ──────────────────────────────────────────────────────────────────

// FAQ 생성
export async function createFaq(data: {
    question: string;
    answer: string;
    order?: number;
    isPublic?: boolean;
}) {
    await requireAdmin();
    try {
        await prisma.$executeRawUnsafe(
            `INSERT INTO "Faq" (id, question, answer, "order", "isPublic", "createdAt", "updatedAt")
             VALUES (gen_random_uuid()::text, $1, $2, $3, $4, NOW(), NOW())`,
            data.question,
            data.answer,
            data.order ?? 0,
            data.isPublic ?? true,
        );
    } catch (e) {
        console.error("Failed to create FAQ:", e);
        throw new Error("FAQ 생성 실패");
    }
    revalidatePath("/admin/faq");
    revalidatePath("/apply");
    revalidateTag("admin-faq", { expire: 0 });
}

// FAQ 수정
export async function updateFaq(id: string, data: {
    question: string;
    answer: string;
    order?: number;
    isPublic?: boolean;
}) {
    await requireAdmin();
    try {
        await prisma.$executeRawUnsafe(
            `UPDATE "Faq" SET question = $1, answer = $2, "order" = $3, "isPublic" = $4, "updatedAt" = NOW()
             WHERE id = $5`,
            data.question,
            data.answer,
            data.order ?? 0,
            data.isPublic ?? true,
            id,
        );
    } catch (e) {
        console.error("Failed to update FAQ:", e);
        throw new Error("FAQ 수정 실패");
    }
    revalidatePath("/admin/faq");
    revalidatePath("/apply");
    revalidateTag("admin-faq", { expire: 0 });
}

// FAQ 삭제
export async function deleteFaq(id: string) {
    await requireAdmin();
    try {
        await prisma.$executeRawUnsafe(`DELETE FROM "Faq" WHERE id = $1`, id);
    } catch (e) {
        console.error("Failed to delete FAQ:", e);
        throw new Error("FAQ 삭제 실패");
    }
    revalidatePath("/admin/faq");
    revalidatePath("/apply");
    revalidateTag("admin-faq", { expire: 0 });
}

// ── 학부모 후기 관리 ─────────────────────────────────────────────────────────

// 후기 생성
export async function createTestimonial(data: {
    name: string;
    info: string;
    text: string;
    rating?: number;
    order?: number;
    isPublic?: boolean;
}) {
    await requireAdmin();
    try {
        await prisma.$executeRawUnsafe(
            `INSERT INTO "Testimonial" (id, name, info, text, rating, "order", "isPublic", "createdAt", "updatedAt")
             VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, NOW(), NOW())`,
            data.name,
            data.info,
            data.text,
            data.rating ?? 5,
            data.order ?? 0,
            data.isPublic ?? true,
        );
    } catch (e) {
        console.error("Failed to create Testimonial:", e);
        throw new Error("후기 생성 실패");
    }
    revalidateTestimonialAdminCaches();
    revalidatePath("/admin/testimonials");
    revalidatePath("/");
}

// 후기 수정
export async function updateTestimonial(id: string, data: {
    name: string;
    info: string;
    text: string;
    rating?: number;
    order?: number;
    isPublic?: boolean;
}) {
    await requireAdmin();
    try {
        await prisma.$executeRawUnsafe(
            `UPDATE "Testimonial" SET name = $1, info = $2, text = $3, rating = $4, "order" = $5, "isPublic" = $6, "updatedAt" = NOW()
             WHERE id = $7`,
            data.name,
            data.info,
            data.text,
            data.rating ?? 5,
            data.order ?? 0,
            data.isPublic ?? true,
            id,
        );
    } catch (e) {
        console.error("Failed to update Testimonial:", e);
        throw new Error("후기 수정 실패");
    }
    revalidateTestimonialAdminCaches();
    revalidatePath("/admin/testimonials");
    revalidatePath("/");
}

// 후기 삭제
export async function deleteTestimonial(id: string) {
    await requireAdmin();
    try {
        await prisma.$executeRawUnsafe(`DELETE FROM "Testimonial" WHERE id = $1`, id);
    } catch (e) {
        console.error("Failed to delete Testimonial:", e);
        throw new Error("후기 삭제 실패");
    }
    revalidateTestimonialAdminCaches();
    revalidatePath("/admin/testimonials");
    revalidatePath("/");
}

// ── 엑셀 일괄 등록 ──────────────────────────────────────────────────────────

// bulkCreateStudents에서 사용하는 학생 데이터 타입
// ParsedStudent(엑셀 파싱 결과)와 동일한 구조이지만, Server Action은 별도 타입으로 정의
type BulkStudentInput = {
    rowNumber: number;           // 엑셀 원본 행 번호 (에러 보고용)
    name: string;                // 학생명
    birthDate: string | null;    // 생년월일 ISO 문자열
    gender: string | null;       // "MALE" | "FEMALE" | null
    phone: string | null;        // 학생 휴대폰번호
    school: string | null;       // 학교명
    grade: string | null;        // 학년
    address: string | null;      // 주소
    enrollDate: string | null;   // 입회일자 ISO 문자열
    memo: string | null;         // 메모 (관리용이름 + 원본 메모 조합)
    className: string | null;    // 엑셀 C열 클래스명 (예: "6. 토요일 2교시") — 자동 매칭용
    // 보호자1 정보 → User 테이블에 저장
    guardian1Relation: string | null; // 보호자1 관계 (예: "아버지")
    guardian1Phone: string | null;    // 보호자1 전화번호
    // 보호자2,3 정보 → Guardian 테이블에 저장
    guardian2Relation: string | null;
    guardian2Phone: string | null;
    guardian3Relation: string | null;
    guardian3Phone: string | null;
};

// 일괄 등록 결과 타입
type BulkCreateResult = {
    created: number;     // 새로 등록된 학생 수
    skipped: number;     // 중복으로 건너뛴 학생 수
    updated: number;     // 덮어쓰기로 업데이트된 학생 수
    enrolled: number;    // 자동 수강 등록 성공 수
    enrollErrors: string[];  // 수강 등록 실패/매칭 실패 목록
    errors: { rowNumber: number; name: string; reason: string }[];  // 실패한 행 목록
};

/**
 * 엑셀 클래스명 → slotKey 파싱 함수
 *
 * 엑셀 C열 클래스명 형식 예시:
 * - "6. 토요일 2교시" → "Sat-2"
 * - "1. 월요일 7교시" → "Mon-7"
 * - "화요일 8교시(성인)" → "Tue-8"
 * - "목요일 4교시(대표반)" → "Thu-4"
 *
 * 파싱 규칙:
 * 1. 앞의 번호("6. ") 제거
 * 2. 요일명 추출 → dayKey (Mon/Tue/...)
 * 3. "N교시" → N
 * 4. 괄호 안의 내용은 무시
 * 5. 결과: "{dayKey}-{period}"
 */
const DAY_NAME_TO_KEY: Record<string, string> = {
    "월요일": "Mon", "화요일": "Tue", "수요일": "Wed", "목요일": "Thu",
    "금요일": "Fri", "토요일": "Sat", "일요일": "Sun",
};

function parseClassNameToSlotKey(className: string): string | null {
    // 앞의 번호 제거 (예: "6. " → "")
    const cleaned = className.replace(/^\d+\.\s*/, "").trim();

    // 요일명 추출
    let dayKey: string | null = null;
    for (const [korDay, key] of Object.entries(DAY_NAME_TO_KEY)) {
        if (cleaned.includes(korDay)) {
            dayKey = key;
            break;
        }
    }
    if (!dayKey) return null;

    // 교시 추출: "N교시" 패턴에서 N을 가져옴
    const periodMatch = cleaned.match(/(\d+)교시/);
    if (!periodMatch) return null;

    const period = parseInt(periodMatch[1], 10);
    return `${dayKey}-${period}`;
}

/**
 * 엑셀에서 파싱된 학생 데이터를 일괄 등록하는 Server Action
 *
 * 처리 흐름 (학생 1명당):
 * 1. 중복 체크: 이름 + 생년월일이 동일한 Student가 있는지 확인
 * 2. 중복이면: duplicateMode에 따라 건너뛰기 또는 덮어쓰기
 * 3. 보호자1: User 테이블에서 전화번호로 검색, 없으면 새로 생성
 * 4. Student INSERT (또는 UPDATE)
 * 5. 보호자2,3: Guardian 테이블에 INSERT
 * 6. className이 있으면: slotKey로 파싱 → Class 검색 → 자동 수강 등록
 *
 * PgBouncer 호환을 위해 $queryRawUnsafe / $executeRawUnsafe만 사용
 * 트랜잭션 사용 불가이므로, 건별 INSERT + 실패 목록 반환 방식
 */
export async function bulkCreateStudents(
    students: BulkStudentInput[],
    duplicateMode: "skip" | "overwrite" = "skip"
): Promise<BulkCreateResult> {
    await requireAdmin();
    const result: BulkCreateResult = {
        created: 0,
        skipped: 0,
        updated: 0,
        enrolled: 0,
        enrollErrors: [],
        errors: [],
    };

    for (const student of students) {
        try {
            // ── 1. 중복 체크: 이름 + 생년월일이 같은 학생이 있는지 조회 ──
            let existingStudentId: string | null = null;

            if (student.birthDate) {
                // 이름 + 생년월일 기준으로 기존 학생 조회
                const existing = await prisma.$queryRawUnsafe<any[]>(
                    `SELECT id FROM "Student" s
                     WHERE ${notMergedStudent("s")}
                       AND s.name = $1 AND s."birthDate"::date = $2::date
                     LIMIT 1`,
                    student.name,
                    student.birthDate,
                );
                if (existing.length > 0) {
                    existingStudentId = existing[0].id;
                }
            }

            // ── 2. 중복 학생 처리 ──
            // finalStudentId: 수강 등록에 사용할 학생 ID (신규든 기존이든 여기에 저장)
            let finalStudentId: string | null = null;

            if (existingStudentId) {
                if (duplicateMode === "skip") {
                    // 건너뛰기: 학생 정보는 안 건드리고, 수강 등록만 시도
                    result.skipped++;
                    finalStudentId = existingStudentId;
                } else {
                    // 덮어쓰기 모드: 기존 학생 정보를 엑셀 데이터로 업데이트
                    await prisma.$executeRawUnsafe(
                        `UPDATE "Student" SET
                            gender = $1, phone = $2, school = $3, grade = $4,
                            address = $5, "enrollDate" = $6::timestamp, memo = $7,
                            "updatedAt" = NOW()
                         WHERE id = $8`,
                        student.gender || null,
                        student.phone || null,
                        student.school || null,
                        student.grade || null,
                        student.address || null,
                        student.enrollDate || null,
                        student.memo || null,
                        existingStudentId,
                    );

                    // 기존 Guardian 삭제 후 재등록 (보호자 정보 갱신)
                    await prisma.$executeRawUnsafe(
                        `DELETE FROM "Guardian" WHERE "studentId" = $1`,
                        existingStudentId,
                    );

                    // 보호자2,3 Guardian 테이블에 INSERT
                    await insertGuardians(existingStudentId, student);

                    // 보호자1 정보도 업데이트 (User 테이블)
                    if (student.guardian1Phone) {
                        const parentRows = await prisma.$queryRawUnsafe<any[]>(
                            `SELECT "parentId" FROM "Student" WHERE id = $1`,
                            existingStudentId,
                        );
                        const parentId = parentRows[0]?.parentId ?? parentRows[0]?.parentid;
                        if (parentId) {
                            await prisma.$executeRawUnsafe(
                                `UPDATE "User" SET
                                    name = $1, phone = $2, "updatedAt" = NOW()
                                 WHERE id = $3`,
                                student.guardian1Relation || "보호자",
                                student.guardian1Phone,
                                parentId,
                            );
                        }
                    }

                    result.updated++;
                    finalStudentId = existingStudentId;
                }
            }

            // 기존 학생이 처리된 경우 (skip 또는 overwrite) 신규 등록은 건너뜀
            if (!finalStudentId) {
            // ── 3. 신규 학생: 보호자1 User 생성 또는 조회 ──
            let parentId: string;

            // 보호자1 이름은 관계명(예: "아버지")을 사용, 없으면 "보호자"
            const parentName = student.guardian1Relation || "보호자";
            // 랠리즈 엑셀에 email이 없으므로 자동 생성 (기존 createStudent 패턴 동일)
            const parentEmail = `parent_${Date.now()}_${student.rowNumber}@stiz.local`;

            if (student.guardian1Phone) {
                // 전화번호로 기존 보호자 검색 (같은 전화번호 = 같은 보호자)
                // 숫자만 남겨 비교한다 — 저장 형식이 '010-1234-5678'과 '01012345678'로 섞여 있어
                // 글자 그대로 비교하면 같은 사람을 못 찾고 보호자·학생이 복제된다.
                const existingParent = await prisma.$queryRawUnsafe<any[]>(
                    `SELECT id FROM "User"
                      WHERE role = 'PARENT'
                        AND regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = $1
                      ORDER BY ("authUserId" IS NOT NULL) DESC, "createdAt" ASC
                      LIMIT 1`,
                    parentPhoneDigits(student.guardian1Phone),
                );

                if (existingParent.length > 0) {
                    parentId = existingParent[0].id;
                } else {
                    // 보호자1 신규 생성
                    const rows = await prisma.$queryRawUnsafe<any[]>(
                        `INSERT INTO "User" (id, email, name, phone, role, "createdAt", "updatedAt")
                         VALUES (gen_random_uuid()::text, $1, $2, $3, 'PARENT', NOW(), NOW())
                         RETURNING id`,
                        parentEmail,
                        parentName,
                        student.guardian1Phone,
                    );
                    parentId = rows[0].id;
                }
            } else {
                // 전화번호 없으면 무조건 새 User 생성
                const rows = await prisma.$queryRawUnsafe<any[]>(
                    `INSERT INTO "User" (id, email, name, phone, role, "createdAt", "updatedAt")
                     VALUES (gen_random_uuid()::text, $1, $2, $3, 'PARENT', NOW(), NOW())
                     RETURNING id`,
                    parentEmail,
                    parentName,
                    null,
                );
                parentId = rows[0].id;
            }

            // ── 4. Student INSERT ──
            // 생년월일이 없으면 기본값(2000-01-01) 사용 — birthDate는 NOT NULL 컬럼
            const birthDateValue = student.birthDate || "2000-01-01T00:00:00.000Z";

            const studentRows = await prisma.$queryRawUnsafe<any[]>(
                `INSERT INTO "Student" (id, name, "birthDate", gender, "parentId",
                    phone, school, grade, address, "enrollDate", memo,
                    "createdAt", "updatedAt")
                 VALUES (gen_random_uuid()::text, $1, $2::timestamp, $3, $4,
                    $5, $6, $7, $8, $9::timestamp, $10,
                    NOW(), NOW())
                 RETURNING id`,
                student.name,
                birthDateValue,
                student.gender || null,
                parentId,
                student.phone || null,
                student.school || null,
                student.grade || null,
                student.address || null,
                student.enrollDate || null,
                student.memo || null,
            );

            const newStudentId = studentRows[0].id;

            // ── 5. 보호자1도 Guardian 테이블에 기록 (isPrimary = true) ──
            // 보호자1은 User에도 있고 Guardian에도 있음 (이중 저장)
            // 이유: Guardian 테이블에서 모든 보호자를 일괄 조회할 수 있도록
            if (student.guardian1Phone || student.guardian1Relation) {
                await prisma.$executeRawUnsafe(
                    `INSERT INTO "Guardian" (id, "studentId", relation, name, phone, "isPrimary", "createdAt", "updatedAt")
                     VALUES (gen_random_uuid()::text, $1, $2, $3, $4, true, NOW(), NOW())`,
                    newStudentId,
                    student.guardian1Relation || "보호자",
                    student.guardian1Relation || "보호자",
                    student.guardian1Phone || null,
                );
            }

            // ── 6. 보호자2,3 Guardian 테이블에 INSERT ──
            await insertGuardians(newStudentId, student);

            result.created++;
            finalStudentId = newStudentId;
            }

            // ── 7. 엑셀 클래스명으로 자동 수강 등록 ──
            // className이 있고, 학생 ID가 확보된 경우에만 실행
            if (student.className && finalStudentId) {
                try {
                    const slotKey = parseClassNameToSlotKey(student.className);
                    if (slotKey) {
                        // slotKey로 Class 검색
                        const classRows = await prisma.$queryRawUnsafe<any[]>(
                            `SELECT id FROM "Class" WHERE "slotKey" = $1 LIMIT 1`,
                            slotKey,
                        );
                        if (classRows.length > 0) {
                            // Class를 찾았으면 수강 등록 (ON CONFLICT로 중복 등록 방지)
                            await prisma.$executeRawUnsafe(
                                `INSERT INTO "Enrollment" (id, "studentId", "classId", status, "createdAt", "updatedAt")
                                 VALUES (gen_random_uuid()::text, $1, $2, 'ACTIVE', NOW(), NOW())
                                 ON CONFLICT ("studentId", "classId") DO UPDATE SET status = 'ACTIVE', "updatedAt" = NOW()`,
                                finalStudentId,
                                classRows[0].id,
                            );
                            result.enrolled++;
                        } else {
                            // Class를 못 찾으면 경고 로그에 추가 (에러는 아님)
                            result.enrollErrors.push(
                                `${student.name} (행 ${student.rowNumber}): "${student.className}" → slotKey "${slotKey}" 매칭 Class 없음`
                            );
                        }
                    } else {
                        // slotKey 파싱 실패
                        result.enrollErrors.push(
                            `${student.name} (행 ${student.rowNumber}): "${student.className}" 클래스명 파싱 실패`
                        );
                    }
                } catch (enrollErr) {
                    // 수강 등록 오류: 학생 등록은 성공했으므로 경고만 기록
                    result.enrollErrors.push(
                        `${student.name} (행 ${student.rowNumber}): 수강 등록 오류 — ${enrollErr instanceof Error ? enrollErr.message : "알 수 없는 오류"}`
                    );
                }
            }
        } catch (e) {
            // 건별 오류: 해당 학생만 실패 기록하고 나머지 계속 진행
            console.error(`[bulkCreate] 행 ${student.rowNumber} (${student.name}) 실패:`, e);
            result.errors.push({
                rowNumber: student.rowNumber,
                name: student.name,
                reason: e instanceof Error ? e.message : "알 수 없는 오류",
            });
        }
    }

    // 학생 목록 페이지 캐시 무효화
    revalidatePath("/admin/students");
    revalidatePath("/admin");

    return result;
}

/**
 * 보호자2, 3 정보를 Guardian 테이블에 INSERT하는 헬퍼 함수
 * - isPrimary = false (보호자2,3은 보조 보호자)
 * - 관계명 또는 전화번호가 하나라도 있으면 저장
 */
async function insertGuardians(studentId: string, student: BulkStudentInput) {
    // 보호자2
    if (student.guardian2Relation || student.guardian2Phone) {
        await prisma.$executeRawUnsafe(
            `INSERT INTO "Guardian" (id, "studentId", relation, name, phone, "isPrimary", "createdAt", "updatedAt")
             VALUES (gen_random_uuid()::text, $1, $2, $3, $4, false, NOW(), NOW())`,
            studentId,
            student.guardian2Relation || "보호자2",
            student.guardian2Relation || "보호자2",
            student.guardian2Phone || null,
        );
    }

    // 보호자3
    if (student.guardian3Relation || student.guardian3Phone) {
        await prisma.$executeRawUnsafe(
            `INSERT INTO "Guardian" (id, "studentId", relation, name, phone, "isPrimary", "createdAt", "updatedAt")
             VALUES (gen_random_uuid()::text, $1, $2, $3, $4, false, NOW(), NOW())`,
            studentId,
            student.guardian3Relation || "보호자3",
            student.guardian3Relation || "보호자3",
            student.guardian3Phone || null,
        );
    }
}

// ── 수업 기록 저장 (세션 + 출석 일괄) ─────────────────────────────────────────

/**
 * saveSessionLog: 수업 기록(Session)과 출석(Attendance)을 한번에 저장하는 통합 Server Action
 *
 * - 기존 saveAttendance는 출석만 저장하지만, 이 함수는 수업 주제/내용/사진/코치 + 출석을 함께 저장
 * - Session이 이미 있으면 UPDATE, 없으면 INSERT (classId + date 기준)
 * - attendances가 전달되면 각 학생에 대해 Attendance UPSERT
 * - PgBouncer 호환을 위해 $queryRawUnsafe / $executeRawUnsafe만 사용
 */
export async function saveSessionLog(data: {
    classId: string;
    date: string;           // ISO 날짜 문자열
    topic?: string;         // 수업 주제
    content?: string;       // 수업 상세 내용
    photosJSON?: string;    // 사진 URL 배열 JSON 문자열 (클라이언트에서 JSON.stringify 완료)
    coachId?: string;       // 담당 코치 ID
    attendances?: Array<{   // 출석 데이터 (선택)
        studentId: string;
        status: string;     // PRESENT, ABSENT, LATE
    }>;
}) {
    await requireAdmin();
    try {
        // ── 1. 해당 classId + date로 기존 Session 검색 ──
        const existing = await prisma.$queryRawUnsafe<any[]>(
            `SELECT id FROM "Session" WHERE "classId" = $1 AND date::date = $2::date LIMIT 1`,
            data.classId, data.date
        );

        let sessionId: string;

        if (existing.length > 0) {
            // ── 2. 기존 Session이 있으면 UPDATE ──
            sessionId = existing[0].id;
            await prisma.$executeRawUnsafe(
                `UPDATE "Session" SET
                    topic = $1, content = $2, "photosJSON" = $3, "coachId" = $4, "updatedAt" = NOW()
                 WHERE id = $5`,
                data.topic || null,
                data.content || null,
                data.photosJSON || null,
                data.coachId || null,
                sessionId,
            );
        } else {
            // ── 3. 없으면 새 Session INSERT ──
            const rows = await prisma.$queryRawUnsafe<any[]>(
                `INSERT INTO "Session" (id, "classId", date, topic, content, "photosJSON", "coachId", "createdAt", "updatedAt")
                 VALUES (gen_random_uuid()::text, $1, $2::timestamp, $3, $4, $5, $6, NOW(), NOW())
                 RETURNING id`,
                data.classId,
                data.date,
                data.topic || null,
                data.content || null,
                data.photosJSON || null,
                data.coachId || null,
            );
            sessionId = rows[0].id;
        }

        // ── 4. 출석 데이터가 있으면 각 학생별 Attendance UPSERT ──
        // 기존 saveAttendance와 동일한 ON CONFLICT 패턴 사용
        if (data.attendances && data.attendances.length > 0) {
            for (const rec of data.attendances) {
                await prisma.$executeRawUnsafe(
                    `INSERT INTO "Attendance" (id, "sessionId", "studentId", status, "createdAt", "updatedAt")
                     VALUES (gen_random_uuid()::text, $1, $2, $3, NOW(), NOW())
                     ON CONFLICT ("sessionId", "studentId") DO UPDATE SET status = $3, "updatedAt" = NOW()`,
                    sessionId, rec.studentId, rec.status
                );
            }
        }

        // ── 5. 캐시 무효화 ──
        revalidatePath("/admin/classes");

        return { success: true, sessionId };
    } catch (e) {
        console.error("Failed to save session log:", e);
        throw new Error("수업 기록 저장 실패");
    }
}

// ── (삭제됨 2026-10-06) 시간표 슬롯 → Class 동기화 ─────────────────────────────
// syncScheduleToClasses / getClassSyncPreview 는 화면·API 어디서도 부르지 않아 지웠다(Phase 2 시트 종료).
// 시간표 원본은 사이트 DB(ScheduleSlot)이고 반(Class)은 관리자 화면에서 직접 관리한다.
// 옛 일회성 실행본은 scripts/sync-classes.mjs 에 그대로 남아 있다(독립 스크립트).

// ══════════════════════════════════════════════════════════════════════════════
// 📌 Phase 1: 수납 고도화 — 청구 템플릿 CRUD + 자동 청구서 + 미납 알림
// ══════════════════════════════════════════════════════════════════════════════

// ── Payment 테이블 새 컬럼 자동 추가 (마이그레이션 대신 DDL) ──────────────────────
let _paymentColumnsEnsured = false;
export async function ensurePaymentColumns() {
    if (_paymentColumnsEnsured) return;
    await ensurePaymentInfrastructure();
    const columns: [string, string][] = [
        ["type", "TEXT DEFAULT 'MONTHLY'"],
        ["description", "TEXT"],
        ["month", "INTEGER"],
        ["year", "INTEGER"],
        ["autoGenerated", "BOOLEAN DEFAULT false"],
        ["notifiedAt", "TIMESTAMPTZ"],
    ];
    for (const [col, type] of columns) {
        try {
            await prisma.$executeRawUnsafe(
                `ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "${col}" ${type}`
            );
        } catch (e) {
            console.warn(`[DDL] Payment."${col}" ensure failed:`, (e as Error).message);
        }
    }
    // 인덱스도 생성 (존재하면 무시)
    try {
        await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "Payment_year_month_idx" ON "Payment" (year, month)`);
        await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "Payment_status_idx" ON "Payment" (status)`);
    } catch {}
    _paymentColumnsEnsured = true;
}

// ── BillingTemplate 테이블 자동 생성 (마이그레이션 대신 DDL) ──────────────────────
let _billingTableEnsured = false;
export async function ensureBillingTemplateTable() {
    if (_billingTableEnsured) return;
    try {
        await prisma.$executeRawUnsafe(`
            CREATE TABLE IF NOT EXISTS "BillingTemplate" (
                id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                name TEXT NOT NULL,
                amount INTEGER NOT NULL,
                type TEXT DEFAULT 'MONTHLY',
                description TEXT,
                "isActive" BOOLEAN DEFAULT true,
                "dueDay" INTEGER DEFAULT 10,
                "programId" TEXT,
                "createdAt" TIMESTAMPTZ DEFAULT NOW(),
                "updatedAt" TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        await prisma.$executeRawUnsafe(
            `CREATE INDEX IF NOT EXISTS "BillingTemplate_isActive_idx" ON "BillingTemplate" ("isActive")`
        );
    } catch (e) {
        console.warn("[DDL] BillingTemplate table ensure failed:", (e as Error).message);
    }
    _billingTableEnsured = true;
}

// ── 청구 템플릿 CRUD ────────────────────────────────────────────────────────────

// 청구 템플릿 생성
export async function createBillingTemplate(data: {
    name: string;
    amount: number;
    type?: string;
    description?: string;
    dueDay?: number;
    programId?: string | null;
}) {
    await requireAdmin();
    await ensureBillingTemplateTable();
    try {
        await prisma.$executeRawUnsafe(
            `INSERT INTO "BillingTemplate" (id, name, amount, type, description, "dueDay", "programId", "createdAt", "updatedAt")
             VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, NOW(), NOW())`,
            data.name,
            data.amount,
            data.type || "MONTHLY",
            data.description || null,
            data.dueDay || 10,
            data.programId || null,
        );
    } catch (e) {
        console.error("Failed to create billing template:", e);
        throw new Error("청구 템플릿 생성 실패");
    }
    revalidatePath("/admin/finance/billing");
    revalidateTag("admin-finance-billing", { expire: 0 });
}

// 청구 템플릿 수정
export async function updateBillingTemplate(id: string, data: {
    name?: string;
    amount?: number;
    type?: string;
    description?: string;
    isActive?: boolean;
    dueDay?: number;
    programId?: string | null;
}) {
    await requireAdmin();
    await ensureBillingTemplateTable();
    try {
        // 변경할 필드만 SET 절에 포함
        const sets: string[] = [];
        const vals: any[] = [];
        let idx = 1;
        if (data.name !== undefined) { sets.push(`name = $${idx++}`); vals.push(data.name); }
        if (data.amount !== undefined) { sets.push(`amount = $${idx++}`); vals.push(data.amount); }
        if (data.type !== undefined) { sets.push(`type = $${idx++}`); vals.push(data.type); }
        if (data.description !== undefined) { sets.push(`description = $${idx++}`); vals.push(data.description); }
        if (data.isActive !== undefined) { sets.push(`"isActive" = $${idx++}`); vals.push(data.isActive); }
        if (data.dueDay !== undefined) { sets.push(`"dueDay" = $${idx++}`); vals.push(data.dueDay); }
        if (data.programId !== undefined) { sets.push(`"programId" = $${idx++}`); vals.push(data.programId); }
        if (sets.length === 0) return;
        sets.push(`"updatedAt" = NOW()`);
        vals.push(id);
        await prisma.$executeRawUnsafe(
            `UPDATE "BillingTemplate" SET ${sets.join(", ")} WHERE id = $${idx}`,
            ...vals,
        );
    } catch (e) {
        console.error("Failed to update billing template:", e);
        throw new Error("청구 템플릿 수정 실패");
    }
    revalidatePath("/admin/finance/billing");
    revalidateTag("admin-finance-billing", { expire: 0 });
}

// 청구 템플릿 삭제
export async function deleteBillingTemplate(id: string) {
    await requireAdmin();
    await ensureBillingTemplateTable();
    try {
        await prisma.$executeRawUnsafe(`DELETE FROM "BillingTemplate" WHERE id = $1`, id);
    } catch (e) {
        console.error("Failed to delete billing template:", e);
        throw new Error("청구 템플릿 삭제 실패");
    }
    revalidatePath("/admin/finance/billing");
    revalidateTag("admin-finance-billing", { expire: 0 });
}

type MonthlyInvoicePreviewSample = {
    studentId: string;
    studentName: string;
    className: string | null;
    classCount: number;
    classNames: string[];
    parentName: string | null;
    parentPhone: string | null;
    parentEmail: string | null;
    templateName: string;
    type: string;
    amount: number;
    /** @deprecated 템플릿에 저장된 옛 설정값(매월 N일). 납부기한 계산에는 더 이상 쓰지 않는다. */
    dueDay: number;
    /** 실제 적용될 납부기한(YYYY-MM-DD) — 약관 기준 전월 말일 */
    dueDate: string;
    existingPaymentId: string | null;
    existingStatus: string | null;
    existingAmount: number | null;
    existingInvoiceNo: string | null;
    existingInvoiceStatus: string | null;
    existingSentAt: string | null;
    issueReason: string | null;
    action: "CREATE" | "SKIP" | "REVIEW";
};

type MonthlyInvoicePreview = {
    year: number;
    month: number;
    activeTemplateCount: number;
    targetStudentCount: number;
    createCount: number;
    skipCount: number;
    reviewCount: number;
    createAmount: number;
    skipAmount: number;
    samples: MonthlyInvoicePreviewSample[];
    items: MonthlyInvoicePreviewSample[];
};

const MONTHLY_INVOICE_TARGETS_SQL = `
    WITH templates AS (
        SELECT id, name, amount, type, description, "dueDay", "programId"
        FROM "BillingTemplate"
        -- 0원 청구서는 원장과 학부모 알림 모두 만들지 않는다.
        WHERE "isActive" = true
          AND amount > 0
    ),
    active_enrollments AS (
        SELECT DISTINCT
            s.id AS "studentId",
            s.name AS "studentName",
            u.name AS "parentName",
            u.phone AS "parentPhone",
            u.email AS "parentEmail",
            c.id AS "classId",
            c.name AS "className",
            c."programId"
        FROM "Student" s
        JOIN "User" u ON u.id = s."parentId"
        JOIN "Enrollment" e ON e."studentId" = s.id
        JOIN "Class" c ON c.id = e."classId"
        -- 흡수된 중복 학생에게 새 청구가 또 만들어지면 같은 아이에게 두 번 청구된다.
        WHERE e.status = 'ACTIVE' AND ${notMergedStudent("s")}
    ),
    student_class_totals AS (
        -- 프로그램별 템플릿으로 나누기 전에 학생의 전체 활성 반을 확인한다.
        SELECT "studentId", COUNT(DISTINCT "classId")::int AS "totalClassCount",
               ARRAY_AGG(DISTINCT "className" ORDER BY "className") AS "classNames"
        FROM active_enrollments
        GROUP BY "studentId"
    ),
    target_pairs AS (
        SELECT
            t.id AS "templateId",
            t.name AS "templateName",
            t.amount,
            COALESCE(t.type, 'MONTHLY') AS type,
            COALESCE(t.description, t.name) AS description,
            LEAST(GREATEST(COALESCE(t."dueDay", 10), 1), 28) AS "dueDay",
            a."studentId",
            a."studentName",
            a."parentName",
            a."parentPhone",
            a."parentEmail",
            MIN(a."classId") AS "classId",
            MIN(a."className") AS "className",
            sc."classNames",
            sc."totalClassCount" AS "classCount",
            sc."totalClassCount"
        FROM templates t
        JOIN active_enrollments a
          ON t."programId" IS NULL OR t."programId" = a."programId"
        JOIN student_class_totals sc ON sc."studentId" = a."studentId"
        GROUP BY
            t.id, t.name, t.amount, t.type, t.description, t."dueDay",
            a."studentId", a."studentName", a."parentName", a."parentPhone", a."parentEmail",
            sc."classNames", sc."totalClassCount"
    ),
    actions AS (
        SELECT
            tp.*,
            p.id AS "existingPaymentId",
            p.status AS "existingStatus",
            p.amount::int AS "existingAmount",
            i."invoiceNo" AS "existingInvoiceNo",
            i.status AS "existingInvoiceStatus",
            TO_CHAR(i."sentAt", 'YYYY-MM-DD') AS "existingSentAt",
            CASE
                WHEN tp."totalClassCount" > 1 THEN '여러 반 수강: 반별 수강료·할인·기존 납부를 확인해야 하므로 발행에서 제외합니다.'
                WHEN NULLIF(tp."parentEmail", '') IS NULL THEN '학부모 이메일 확인 필요'
                WHEN NULLIF(tp."parentPhone", '') IS NULL THEN '학부모 연락처 확인 권장'
                WHEN p.id IS NOT NULL THEN '이미 같은 유형의 청구가 있어 유지'
                ELSE NULL
            END AS "issueReason",
            CASE WHEN tp."totalClassCount" > 1 THEN 'REVIEW'
                 WHEN p.id IS NULL THEN 'CREATE' ELSE 'SKIP' END AS action
        FROM target_pairs tp
        LEFT JOIN "Payment" p
          ON p."studentId" = tp."studentId"
         AND p.year = $1
         AND p.month = $2
         AND p.type = tp.type
         -- 다반 확인필요 행은 납부 건수만큼 복제되지 않도록 기존 납부와 합치지 않는다.
         AND tp."totalClassCount" = 1
        LEFT JOIN "PaymentInvoice" i ON i."paymentId" = p.id
    )
`;

export async function previewMonthlyInvoices(year: number, month: number): Promise<MonthlyInvoicePreview> {
    await requireAdmin();
    await ensurePaymentColumns();
    await ensureBillingTemplateTable();

    try {
        const [summaryRows, items] = await Promise.all([
            prisma.$queryRawUnsafe<{
                activeTemplateCount: number;
                targetStudentCount: number;
                createCount: number;
                skipCount: number;
                reviewCount: number;
                createAmount: number;
                skipAmount: number;
            }[]>(
                `
                ${MONTHLY_INVOICE_TARGETS_SQL}
                SELECT
                    (SELECT COUNT(*)::int FROM templates) AS "activeTemplateCount",
                    (SELECT COUNT(DISTINCT "studentId")::int FROM target_pairs) AS "targetStudentCount",
                    COUNT(CASE WHEN action = 'CREATE' THEN 1 END)::int AS "createCount",
                    COUNT(CASE WHEN action = 'SKIP' THEN 1 END)::int AS "skipCount",
                    COUNT(CASE WHEN action = 'REVIEW' THEN 1 END)::int AS "reviewCount",
                    COALESCE(SUM(CASE WHEN action = 'CREATE' THEN amount ELSE 0 END), 0)::int AS "createAmount",
                    COALESCE(SUM(CASE WHEN action = 'SKIP' THEN amount ELSE 0 END), 0)::int AS "skipAmount"
                FROM actions
                `,
                year,
                month,
            ),
            prisma.$queryRawUnsafe<MonthlyInvoicePreviewSample[]>(
                `
                ${MONTHLY_INVOICE_TARGETS_SQL}
                SELECT
                    "studentId",
                    "studentName",
                    "className",
                    "classCount",
                    "classNames",
                    "parentName",
                    "parentPhone",
                    "parentEmail",
                    "templateName",
                    type,
                    amount::int AS amount,
                    "dueDay"::int AS "dueDay",
                    "existingPaymentId",
                    "existingStatus",
                    "existingAmount",
                    "existingInvoiceNo",
                    "existingInvoiceStatus",
                    "existingSentAt",
                    "issueReason",
                    action
                FROM actions
                ORDER BY
                    CASE action WHEN 'REVIEW' THEN 0 WHEN 'CREATE' THEN 1 ELSE 2 END,
                    "studentName",
                    "templateName"
                `,
                year,
                month,
            ),
        ]);

        const summary = summaryRows[0] ?? {
            activeTemplateCount: 0,
            targetStudentCount: 0,
            createCount: 0,
            skipCount: 0,
            reviewCount: 0,
            createAmount: 0,
            skipAmount: 0,
        };

        return {
            year,
            month,
            activeTemplateCount: Number(summary.activeTemplateCount ?? 0),
            targetStudentCount: Number(summary.targetStudentCount ?? 0),
            createCount: Number(summary.createCount ?? 0),
            skipCount: Number(summary.skipCount ?? 0),
            reviewCount: Number(summary.reviewCount ?? 0),
            createAmount: Number(summary.createAmount ?? 0),
            skipAmount: Number(summary.skipAmount ?? 0),
            samples: items.slice(0, 20).map((sample) => ({
                ...sample,
                amount: Number(sample.amount ?? 0),
                dueDay: Number(sample.dueDay ?? 10),
                dueDate: monthlyBillingDueDate(year, month), // 화면에는 실제 적용될 기한을 보여준다
                existingAmount: sample.existingAmount == null ? null : Number(sample.existingAmount),
                action: sample.action,
            })),
            items: items.map((sample) => ({
                ...sample,
                amount: Number(sample.amount ?? 0),
                dueDay: Number(sample.dueDay ?? 10),
                dueDate: monthlyBillingDueDate(year, month),
                existingAmount: sample.existingAmount == null ? null : Number(sample.existingAmount),
                action: sample.action,
            })),
        };
    } catch (e) {
        console.error("Failed to preview monthly invoices:", e);
        throw new Error("월별 청구 대상 미리보기 실패");
    }
}

// ── 월별 청구서 자동 생성 ────────────────────────────────────────────────────────
// 활성 템플릿 기준으로 ACTIVE 수강생에게 청구서를 생성한다.
// 중복 방지: 같은 학생+같은 year+month+type 조합이 이미 있으면 건너뜀
export async function generateMonthlyInvoices(year: number, month: number, excludeStudentIds?: string[]) {
    await requireAdmin();
    await ensurePaymentColumns();
    await ensureBillingTemplateTable();

    try {
        const preview = await previewMonthlyInvoices(year, month);
        if (preview.activeTemplateCount === 0) {
            return { created: 0, skipped: 0, message: "활성 청구 템플릿이 없습니다." };
        }

        const excluded = excludeStudentIds && excludeStudentIds.length > 0 ? excludeStudentIds : null;
        const excludeClause = excluded
            ? `AND "studentId" NOT IN (${excluded.map((_, i) => `$${i + 4}`).join(",")})`
            : "";

        // 구조 보강은 거래 밖에서 마치고, 납부와 청구서는 함께 성공하거나 함께 취소한다.
        await ensurePaymentInfrastructure();
        const { insertedRows, invoiceResult } = await prisma.$transaction(async (tx) => {
            // 이 월청구 경로의 같은 연월 실행만 순서대로 처리한다(다른 수납 경로의 전체 잠금은 아님).
            await tx.$executeRawUnsafe(
                `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
                `monthly-invoice:${year}:${month}`,
            );
            const insertedRows = await tx.$queryRawUnsafe<{ id: string }[]>(
                `
                ${MONTHLY_INVOICE_TARGETS_SQL}
                INSERT INTO "Payment" (
                    id, "studentId", "classId", amount, status, "dueDate", type, description,
                    month, year, "autoGenerated", "createdAt", "updatedAt"
                )
                SELECT
                    gen_random_uuid()::text,
                    "studentId",
                    "classId",
                    amount,
                    'PENDING',
                    $3::timestamp,
                    type,
                    description,
                    $2,
                    $1,
                    true,
                    NOW(),
                    NOW()
                FROM actions
                WHERE action = 'CREATE'
                ${excludeClause}
                RETURNING id
                `,
                year,
                month,
                monthlyBillingDueDate(year, month),
                ...(excluded ?? []),
            );

            // 이번 승인으로 새로 생성된 납부만 발행하고, 같은 달의 보류·기존 기록은 건드리지 않는다.
            const invoiceResult = await ensureInvoicesForMonth(year, month, insertedRows.map((row) => row.id), tx);
            return { insertedRows, invoiceResult };
        });

        revalidateFinanceCaches();

        return {
            created: insertedRows.length,
            skipped: preview.skipCount,
            invoices: invoiceResult.invoiceCount,
            message: `${insertedRows.length}건 생성, ${preview.skipCount}건 기존 청구서 유지`,
        };
    } catch (e) {
        console.error("Failed to generate monthly invoices:", e);
        throw new Error("월별 청구서 생성 실패");
    }
}

// ── 미납 알림 일괄 발송 ──────────────────────────────────────────────────────────
// PENDING/OVERDUE 상태인 결제 건의 학부모에게 알림을 보낸다.
// 이미 알림이 발송된 건(notifiedAt != null)은 건너뜀 (강제 재발송 옵션 있음)
export async function refreshPaymentLedger(year: number, month: number) {
    await requireAdmin();
    await ensurePaymentInfrastructure();
    const invoiceResult = await ensureInvoicesForMonth(year, month);
    const overdueResult = await markOverduePayments();
    const invoiceSyncResult = await syncInvoiceStatusesForMonth(year, month);
    revalidateFinanceCaches();
    return {
        invoices: invoiceResult.invoiceCount,
        overdue: overdueResult.updated,
        synced: invoiceSyncResult.updated,
        message: `${invoiceResult.invoiceCount} invoices checked, ${overdueResult.updated} overdue payments updated, ${invoiceSyncResult.updated} invoice statuses synced`,
    };
}

export async function sendInvoiceLinksForMonth(year: number, month: number, forceResend?: boolean) {
    await requireAdmin();
    // 학부모 청구 안내는 랠리즈 전담 — 잠금이면 DB 를 건드리기 전에 바로 돌려보낸다.
    // (throw 대신 결과로 돌려줘야 운영 빌드에서도 안내 문구가 가려지지 않는다)
    if (!isBillingParentSendEnabled()) {
        return { sent: 0, ok: false, locked: true, message: BILLING_PARENT_SEND_LOCKED_MESSAGE };
    }
    await ensurePaymentInfrastructure();
    await ensureInvoicesForMonth(year, month);

    const dueStart = `${year}-${String(month).padStart(2, "0")}-01`;
    const nextMonth = month === 12 ? 1 : month + 1;
    const nextYear = month === 12 ? year + 1 : year;
    const dueEnd = `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`;
    const sentFilter = forceResend ? "" : `AND i."sentAt" IS NULL`;

    try {
        const invoiceCandidates = await prisma.$queryRawUnsafe<{
            id: string;
            amount: number;
            notificationHeld: boolean;
        }[]>(
            `
            SELECT
              i.id,
              p.amount::int AS amount,
              EXISTS (
                SELECT 1
                FROM "OperationsCommand" command
                WHERE command."studentId" = p."studentId"
                  AND command."effectiveMonth" = CONCAT($1::text, '-', LPAD($2::text, 2, '0'))
                  AND command.status = 'HELD'
                  AND command."notificationStatus" = 'HELD'
              ) AS "notificationHeld"
            FROM "PaymentInvoice" i
            JOIN "Payment" p ON p.id = i."paymentId"
            WHERE i.status NOT IN ('PAID', 'CANCELED')
              AND p.amount > 0
              AND i."parentId" IS NOT NULL
              -- 랠리즈 청구서의 장부용 사본은 학부모에게 다시 보내지 않는다
              AND ${rallyzMirrorExclusionSql("p")}
              AND (
                (p.year = $1 AND p.month = $2)
                OR (p."dueDate" >= $3::timestamp AND p."dueDate" < $4::timestamp)
              )
              ${sentFilter}
            ORDER BY i."dueDate" ASC
            `,
            year,
            month,
            dueStart,
            dueEnd,
        );
        // 실제 운영 요청 원장의 HELD 상태와 금액을 함께 확인해 발송 대상을 확정한다.
        const invoices = invoiceCandidates.filter(isMonthlyInvoiceNotificationEligible);

        if (invoices.length === 0) {
            return { sent: 0, message: "발송할 청구서 링크가 없습니다." };
        }

        const ids = invoices.map((invoice) => invoice.id);
        const placeholders = ids.map((_, index) => `$${index + 1}`).join(",");

        await prisma.$executeRawUnsafe(
            `
            INSERT INTO "Notification" (
                id, "userId", type, title, message, "linkUrl", "isRead", "createdAt"
            )
            SELECT
                gen_random_uuid()::text,
                i."parentId",
                'PAYMENT',
                CONCAT($${ids.length + 1}::text, '월 수강료 청구서 안내'),
                CONCAT(
                    s.name,
                    ' 학생 청구서가 발행되었습니다. 금액 ',
                    TO_CHAR(i.amount, 'FM999,999,999'),
                    '원, 납부기한 ',
                    TO_CHAR(i."dueDate", 'YYYY-MM-DD'),
                    '까지 확인해 주세요.'
                ),
                CONCAT('/payments/', i.id),
                false,
                NOW()
            FROM "PaymentInvoice" i
            JOIN "Student" s ON s.id = i."studentId"
            WHERE i.id IN (${placeholders})
              AND i."parentId" IS NOT NULL
            `,
            ...ids,
            String(month),
        );

        await prisma.$executeRawUnsafe(
            `
            UPDATE "PaymentInvoice"
            SET "sentAt" = COALESCE("sentAt", NOW()),
                status = CASE WHEN status = 'ISSUED' THEN 'SENT' ELSE status END,
                "updatedAt" = NOW()
            WHERE id IN (${placeholders})
            `,
            ...ids,
        );

        await prisma.$executeRawUnsafe(
            `
            UPDATE "Payment" p
            SET "notifiedAt" = COALESCE(p."notifiedAt", NOW()),
                "updatedAt" = NOW()
            FROM "PaymentInvoice" i
            WHERE i."paymentId" = p.id
              AND i.id IN (${placeholders})
            `,
            ...ids,
        );

        await recordPaymentAudit({
            actorType: "ADMIN",
            action: "INVOICE_LINKS_SENT",
            message: `${ids.length} invoice links sent`,
            metadata: { year, month, invoiceIds: ids },
        });

        revalidateFinanceCaches();
        revalidatePath("/mypage");

        return {
            sent: ids.length,
            message: `${ids.length}건의 청구서 링크를 학부모 알림으로 발송했습니다.`,
        };
    } catch (e) {
        console.error("Failed to send invoice links:", e);
        throw new Error("청구서 링크 발송 실패");
    }
}

export async function sendUnpaidReminders() {
    await requireAdmin();
    // 학부모 청구 안내는 랠리즈 전담 — 잠금이면 미납 상태 갱신·발송 전에 바로 돌려보낸다.
    // (throw 대신 결과로 돌려줘야 운영 빌드에서도 안내 문구가 가려지지 않는다)
    if (!isBillingParentSendEnabled()) {
        return { sent: 0, failed: 0, smsSent: 0, errors: [] as string[], ok: false, locked: true, message: BILLING_PARENT_SEND_LOCKED_MESSAGE };
    }
    await ensurePaymentColumns();
    await ensurePaymentInfrastructure();
    await markOverduePayments();

    try {
        // 미납 결제 건 조회 — 랠리즈 청구서의 장부용 사본은 랠리즈가 이미 안내하므로 뺀다
        const condition = `WHERE p.status IN ('PENDING', 'OVERDUE') AND p."notifiedAt" IS NULL
              AND ${rallyzMirrorExclusionSql("p")}`;

        const unpaid = await prisma.$queryRawUnsafe<any[]>(
            `SELECT p.id, p."studentId", p.amount, p.description, p."dueDate", s."parentId"
             FROM "Payment" p
             -- 학부모 묶음용 parentId 만 붙인다. 병합 필터를 ON 절에 걸어 결제 행(문자 대상)은 숨기지 않는다
             LEFT JOIN "Student" s ON s.id = p."studentId" AND ${notMergedStudent("s")}
             ${condition}`
        );

        if (unpaid.length === 0) {
            return { sent: 0, message: "발송할 미납 건이 없습니다." };
        }

        // 학부모별로 묶어 "그 학부모 자녀의 미납만" 건수·금액을 앱 알림으로 보낸다.
        // (예전엔 학원 전체 합계를 모든 학부모에게 똑같이 보냈다)
        const parentSummaries = summarizeUnpaidByParent(
            unpaid.map((u: any) => ({
                parentId: u.parentId ?? u.parentid ?? null,
                studentId: u.studentId ?? u.studentid,
                amount: u.amount,
            })),
        );
        for (const summary of parentSummaries) {
            await notifyParentsOfStudents(
                summary.studentIds,
                "PAYMENT",
                "미납 수납 안내",
                `미납 ${summary.count}건 (총 ${summary.total.toLocaleString("ko-KR")}원)이 있습니다. 확인 부탁드립니다.`,
                "/mypage",
            );
        }

        // 한 학생의 미납 건을 문자 한 통으로 묶되, 성공한 문자에 포함된 결제만 발송 완료로 기록한다.
        const studentUnpaid: Record<string, { count: number; total: number; paymentIds: string[] }> = {};
        for (const u of unpaid) {
            const sid = u.studentId ?? u.studentid;
            if (!studentUnpaid[sid]) studentUnpaid[sid] = { count: 0, total: 0, paymentIds: [] };
            studentUnpaid[sid].count++;
            studentUnpaid[sid].total += Number(u.amount);
            studentUnpaid[sid].paymentIds.push(u.id);
        }

        const sidList = Object.keys(studentUnpaid);
        const phList = sidList.map((_: string, i: number) => `$${i + 1}`).join(",");
        const stuParents = await prisma.$queryRawUnsafe<any[]>(
            `SELECT s.id, s.name, u.phone
             FROM "Student" s JOIN "User" u ON s."parentId" = u.id
             WHERE s.id IN (${phList}) AND u.phone IS NOT NULL AND u.phone != ''`,
            ...sidList,
        );
        const parentByStudent = new Map(stuParents.map((row) => [row.id, row]));
        const successfulPaymentIds: string[] = [];
        let successfulSms = 0;
        const smsErrors: string[] = [];

        for (const [studentId, info] of Object.entries(studentUnpaid)) {
            const studentParent = parentByStudent.get(studentId);
            if (!studentParent?.phone) {
                smsErrors.push(`학생 ID ${studentId}의 학부모 전화번호가 없어 장부 생성 전 발송을 중단했습니다.`);
                continue;
            }

            const result = await sendParentSmsWithResult(
                studentParent.phone,
                "UNPAID_PARENT",
                {
                    childName: studentParent.name,
                    unpaidCount: String(info.count),
                    totalAmount: info.total.toLocaleString("ko-KR"),
                },
                {
                    eventType: "UNPAID_REMINDER",
                    // 결제 ID 조합은 재호출해도 같은 사건 번호가 되어 성공 문자 중복을 막는다.
                    eventId: `unpaid:${info.paymentIds.slice().sort().join(",")}`,
                },
            );
            if (result.ok) {
                successfulSms += 1;
                successfulPaymentIds.push(...info.paymentIds);
            } else {
                smsErrors.push(result.reason || `${studentParent.name} 학부모 문자 발송 실패`);
            }
        }

        if (successfulPaymentIds.length > 0) {
            const placeholders = successfulPaymentIds.map((_, i) => `$${i + 1}`).join(",");
            await prisma.$executeRawUnsafe(
                `UPDATE "Payment"
                 SET "notifiedAt" = NOW(),
                     "lastReminderAt" = NOW(),
                     "reminderCount" = COALESCE("reminderCount", 0) + 1,
                     "updatedAt" = NOW()
                 WHERE id IN (${placeholders})`,
                ...successfulPaymentIds,
            );
            await prisma.$executeRawUnsafe(
                `UPDATE "PaymentInvoice"
                 SET "sentAt" = COALESCE("sentAt", NOW()),
                     "lastReminderAt" = NOW(),
                     "reminderCount" = COALESCE("reminderCount", 0) + 1,
                     status = CASE WHEN status = 'ISSUED' THEN 'SENT' ELSE status END,
                     "updatedAt" = NOW()
                 WHERE "paymentId" IN (${placeholders})`,
                ...successfulPaymentIds,
            );
        }

        revalidateFinanceCaches();
        const failed = unpaid.length - successfulPaymentIds.length;
        return {
            sent: successfulPaymentIds.length,
            failed,
            smsSent: successfulSms,
            errors: smsErrors,
            message: failed > 0
                ? `${successfulPaymentIds.length}건 발송 성공, ${failed}건 실패(재시도 가능) · ${smsErrors[0] || "학부모 전화번호가 없거나 문자 설정을 확인해주세요."}`
                : `${successfulPaymentIds.length}건 알림 발송 완료`,
        };
    } catch (e) {
        console.error("Failed to send unpaid reminders:", e);
        throw new Error("미납 알림 발송 실패");
    }
}

// ── 일괄 수납 상태 변경 ──────────────────────────────────────────────────────────
// 선택한 결제 건들의 상태를 한번에 변경 (체크박스 일괄 처리용)
export async function bulkUpdatePaymentStatus(ids: string[], newStatus: string) {
    await requireFinanceOwner();
    if (ids.length === 0) return;

    try {
        await ensurePaymentInfrastructure();
        if (newStatus === "PAID") {
            await Promise.all(ids.map((id) => markPaymentPaid({
                paymentId: id,
                actorType: "ADMIN",
                method: "MANUAL",
            })));
            revalidateFinanceCaches();
            return;
        }

        const placeholders = ids.map((_, i) => `$${i + 2}`).join(",");
        await prisma.$executeRawUnsafe(
            `UPDATE "Payment" SET status = $1, "paidDate" = NULL, "updatedAt" = NOW() WHERE id IN (${placeholders})`,
            newStatus,
            ...ids,
        );
        const invoiceStatus = newStatus === "OVERDUE"
            ? "OVERDUE"
            : ["REFUNDED", "CANCELED"].includes(newStatus)
                ? "CANCELED"
                : "ISSUED";
        const invoicePlaceholders = ids.map((_, i) => `$${i + 2}`).join(",");
        await prisma.$executeRawUnsafe(
            `UPDATE "PaymentInvoice" SET status = $1, "updatedAt" = NOW() WHERE "paymentId" IN (${invoicePlaceholders})`,
            invoiceStatus,
            ...ids,
        );
        await recordPaymentAudit({
            actorType: "ADMIN",
            action: "PAYMENT_BULK_STATUS_UPDATE",
            message: `Payment bulk status changed to ${newStatus}`,
            metadata: { paymentIds: ids },
        });
    } catch (e) {
        console.error("Failed to bulk update payment status:", e);
        throw new Error("일괄 상태 변경 실패");
    }
    revalidateFinanceCaches();
}

// ══════════════════════════════════════════════════════════════════════════════
// Phase 2: 일일 수업 리포트 — Server Actions
// ══════════════════════════════════════════════════════════════════════════════

// ── Session 테이블에 published/publishedAt 컬럼 + StudentSessionNote 테이블 자동 생성 ──
// 마이그레이션 대신 DDL로 처리 (Phase 1 패턴과 동일)
let _reportColumnsEnsured = false;
export async function ensureReportColumns() {
    if (_reportColumnsEnsured) return;

    // 1. Session 테이블에 published, publishedAt 컬럼 추가
    const sessionCols: [string, string][] = [
        ["published", "BOOLEAN DEFAULT false"],
        ["publishedAt", "TIMESTAMPTZ"],
    ];
    for (const [col, type] of sessionCols) {
        try {
            await prisma.$executeRawUnsafe(
                `ALTER TABLE "Session" ADD COLUMN IF NOT EXISTS "${col}" ${type}`
            );
        } catch (e) {
            console.warn(`[DDL] Session."${col}" ensure failed:`, (e as Error).message);
        }
    }

    // 2. StudentSessionNote 테이블 생성
    try {
        await prisma.$executeRawUnsafe(`
            CREATE TABLE IF NOT EXISTS "StudentSessionNote" (
                id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                "sessionId" TEXT NOT NULL REFERENCES "Session"(id),
                "studentId" TEXT NOT NULL REFERENCES "Student"(id),
                note TEXT NOT NULL,
                rating INTEGER,
                "createdAt" TIMESTAMPTZ DEFAULT NOW(),
                "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE("sessionId", "studentId")
            )
        `);
        // 인덱스 생성 (학생별 조회 최적화)
        await prisma.$executeRawUnsafe(
            `CREATE INDEX IF NOT EXISTS "StudentSessionNote_studentId_idx" ON "StudentSessionNote" ("studentId")`
        );
    } catch (e) {
        console.warn("[DDL] StudentSessionNote table ensure failed:", (e as Error).message);
    }

    _reportColumnsEnsured = true;
}

/**
 * 세션 리포트 저장 (수업 주제/내용/사진 + published 상태)
 * - 기존 saveSessionLog와 유사하지만, published/publishedAt 필드도 저장
 * - 기존 Session이 있으면 UPDATE, 없으면 INSERT하지 않음 (출결이 먼저 기록되어야 함)
 */
export async function saveSessionReport(data: {
    sessionId: string;
    topic?: string;
    content?: string;
    photosJSON?: string;
    coachId?: string;
}) {
    await requireAdmin();
    await ensureReportColumns();

    try {
        await prisma.$executeRawUnsafe(
            `UPDATE "Session" SET
                topic = $1, content = $2, "photosJSON" = $3, "coachId" = $4, "updatedAt" = NOW()
             WHERE id = $5`,
            data.topic || null,
            data.content || null,
            data.photosJSON || null,
            data.coachId || null,
            data.sessionId,
        );
    } catch (e) {
        console.error("Failed to save session report:", e);
        throw new Error("리포트 저장 실패");
    }
    revalidatePath("/admin/attendance");
    revalidateAttendanceReportAdminCaches();
    revalidatePath("/admin/attendance/report");
}

/**
 * 세션 리포트 발행/발행취소 토글
 * - published=true로 변경 시 publishedAt에 현재 시각 기록
 * - published=false로 변경 시 publishedAt 유지 (마지막 발행 시점 기록용)
 * - 발행 시 해당 세션에 출석한 학생들의 학부모에게 알림 전송
 */
export async function publishSessionReport(sessionId: string, publish: boolean) {
    await requireAdmin();
    await ensureReportColumns();

    try {
        if (publish) {
            // 발행: publishedAt 갱신 + 학부모 알림
            await prisma.$executeRawUnsafe(
                `UPDATE "Session" SET published = true, "publishedAt" = NOW(), "updatedAt" = NOW()
                 WHERE id = $1`,
                sessionId,
            );

            // 해당 세션에 출석한 학생 ID 목록 조회 → 학부모 알림
            const students = await prisma.$queryRawUnsafe<any[]>(
                `SELECT DISTINCT "studentId" FROM "Attendance" WHERE "sessionId" = $1`,
                sessionId,
            );
            const studentIds = students.map((s: any) => s.studentId ?? s.studentid);
            if (studentIds.length > 0) {
                // 세션 날짜 조회 (알림 메시지용)
                const sessionRows = await prisma.$queryRawUnsafe<any[]>(
                    `SELECT date FROM "Session" WHERE id = $1 LIMIT 1`,
                    sessionId,
                );
                const dateStr = sessionRows[0]?.date
                    ? new Date(sessionRows[0].date).toLocaleDateString("ko-KR", { month: "long", day: "numeric" })
                    : "오늘";

                await notifyParentsOfStudents(
                    studentIds,
                    "REPORT",
                    "수업 리포트 발행",
                    `${dateStr} 수업 리포트가 발행되었습니다.`,
                    `/mypage/reports/${sessionId}`,
                );
            }
        } else {
            // 발행 취소: published만 false로
            await prisma.$executeRawUnsafe(
                `UPDATE "Session" SET published = false, "updatedAt" = NOW()
                 WHERE id = $1`,
                sessionId,
            );
        }
    } catch (e) {
        console.error("Failed to publish session report:", e);
        throw new Error("리포트 발행 상태 변경 실패");
    }
    revalidatePath("/admin/attendance");
    revalidateAttendanceReportAdminCaches();
    revalidatePath("/admin/attendance/report");
    revalidatePath("/mypage/reports");
}

/**
 * 학생별 개별 노트 일괄 저장 (UPSERT)
 * - 하나의 세션에 대해 여러 학생의 노트를 한번에 저장
 * - sessionId + studentId 유니크 → 있으면 UPDATE, 없으면 INSERT
 */
export async function saveStudentSessionNotes(
    sessionId: string,
    notes: Array<{ studentId: string; note: string; rating?: number | null }>
) {
    await requireAdmin();
    await ensureReportColumns();

    try {
        for (const n of notes) {
            // 빈 노트는 건너뜀 (삭제하지 않고 무시)
            if (!n.note.trim()) continue;

            await prisma.$executeRawUnsafe(
                `INSERT INTO "StudentSessionNote" (id, "sessionId", "studentId", note, rating, "createdAt", "updatedAt")
                 VALUES (gen_random_uuid()::text, $1, $2, $3, $4, NOW(), NOW())
                 ON CONFLICT ("sessionId", "studentId")
                 DO UPDATE SET note = $3, rating = $4, "updatedAt" = NOW()`,
                sessionId,
                n.studentId,
                n.note.trim(),
                n.rating ?? null,
            );
        }
    } catch (e) {
        console.error("Failed to save student session notes:", e);
        throw new Error("학생별 노트 저장 실패");
    }
    revalidateAttendanceReportAdminCaches();
    revalidatePath("/admin/attendance/report");
}

// ── 체험수업 CRM ─────────────────────────────────────────────────────────────

/**
 * TrialLead 테이블 DDL ensure — 테이블이 없으면 자동 생성 (멱등성 보장)
 * 서버 재시작 후 첫 호출에서만 실행되고, 이후는 스킵
 */
let _trialLeadTableEnsured = false;
export async function ensureTrialLeadTable() {
    if (_trialLeadTableEnsured) return;

    try {
        await prisma.$executeRawUnsafe(`
            CREATE TABLE IF NOT EXISTS "TrialLead" (
                id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                "childName" TEXT NOT NULL,
                "childAge" TEXT,
                "parentName" TEXT NOT NULL,
                "parentPhone" TEXT NOT NULL,
                source TEXT DEFAULT 'WEBSITE',
                status TEXT DEFAULT 'NEW',
                "scheduledDate" TIMESTAMPTZ,
                "scheduledClassId" TEXT,
                "attendedDate" TIMESTAMPTZ,
                "convertedDate" TIMESTAMPTZ,
                "convertedStudentId" TEXT,
                "lostReason" TEXT,
                memo TEXT,
                "createdAt" TIMESTAMPTZ DEFAULT NOW(),
                "updatedAt" TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        // 인덱스 생성 (상태별 필터 + 최신순 정렬 최적화)
        await prisma.$executeRawUnsafe(
            `CREATE INDEX IF NOT EXISTS "TrialLead_status_idx" ON "TrialLead" (status)`
        );
        await prisma.$executeRawUnsafe(
            `CREATE INDEX IF NOT EXISTS "TrialLead_createdAt_idx" ON "TrialLead" ("createdAt")`
        );

        // Phase A 추가 컬럼 — 체험 신청 폼에서 수집하는 상세 정보
        const extendedColumns: [string, string][] = [
            ['"childBirthDate"', "TIMESTAMPTZ"],
            ['"childGrade"', "TEXT"],
            ['"childGender"', "TEXT"],
            ['"childSchool"', "TEXT"],
            ['"basketballExp"', "TEXT"],
            ['"preferredDays"', "TEXT"],
            ['"preferredSlotKey"', "TEXT"],
            ['"preferredDay"', "TEXT"],
            ['"preferredPeriod"', "TEXT"],
            ['"trialDate"', "TIMESTAMPTZ"],
            ['"attendedSmsSentAt"', "TIMESTAMPTZ"],
            ['"postTrialConsultedAt"', "TIMESTAMPTZ"],
            ['"enrollGuideSentAt"', "TIMESTAMPTZ"],
            ['"enrollApplicationReceivedAt"', "TIMESTAMPTZ"],
            ['"enrollApplicationId"', "TEXT"],
            ['"coachNoticeSentAt"', "TIMESTAMPTZ"],
            ['"coachNoticeSentTo"', "TEXT"],
            ['"trialFeeConfirmed"', "BOOLEAN DEFAULT false"],
            // 학부모의 「체험비·계좌 확인」 체크 시각 — 실제 입금 확인(trialFeeConfirmed)과 별개
            ['"trialFeeNoticeAgreedAt"', "TIMESTAMPTZ"],
            ['"hopeNote"', "TEXT"],
            ['"agreedTerms"', "BOOLEAN DEFAULT false"],
            ['"agreedPrivacy"', "BOOLEAN DEFAULT false"],
        ];
        for (const [col, type] of extendedColumns) {
            try {
                await prisma.$executeRawUnsafe(
                    `ALTER TABLE "TrialLead" ADD COLUMN IF NOT EXISTS ${col} ${type}`
                );
            } catch (_) { /* 이미 존재하면 무시 */ }
        }
    } catch (e) {
        console.warn("[DDL] TrialLead table ensure failed:", (e as Error).message);
    }

    _trialLeadTableEnsured = true;
}

/**
 * 체험 리드 등록 — 새 체험 신청 건 추가
 */
export async function createTrialLead(data: {
    childName: string;
    childAge?: string;
    parentName: string;
    parentPhone: string;
    source?: string;
    memo?: string;
}) {
    await requireAdmin();
    await ensureTrialLeadTable();

    try {
        await prisma.$executeRawUnsafe(
            `INSERT INTO "TrialLead" (id, "childName", "childAge", "parentName", "parentPhone", source, memo, "createdAt", "updatedAt")
             VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, NOW(), NOW())`,
            data.childName.trim(),
            data.childAge?.trim() || null,
            data.parentName.trim(),
            data.parentPhone.trim(),
            data.source || "WEBSITE",
            data.memo?.trim() || null,
        );
    } catch (e) {
        console.error("Failed to create trial lead:", e);
        throw new Error("체험 신청 등록 실패");
    }
    revalidatePath("/admin/trial");
    revalidatePath("/admin/apply");
    revalidateTrialAdminCaches();
}

/**
 * 체험 리드 수정 — 상태/메모/날짜 등 업데이트
 * 허용 필드만 동적으로 SET절 구성 (SQL 인젝션 방지: 컬럼명은 화이트리스트)
 */
const TRIAL_LEAD_COLUMNS = [
    "childName", "childAge", "parentName", "parentPhone",
    "source", "status", "scheduledDate", "scheduledClassId",
    "attendedDate", "convertedDate", "convertedStudentId",
    "lostReason", "memo",
    // Phase A 추가 필드
    "childBirthDate", "childGrade", "childGender", "childSchool", "basketballExp",
    "preferredDays", "preferredSlotKey", "preferredDay", "preferredPeriod",
    // trialFeeConfirmed 는 일부러 뺐다 — 입금 확인은 confirmTrialFeePayment(감사 이력 포함)만 바꾼다.
    // 공용 수정에 남겨 두면 오래된 화면 값으로 덮어써 확인이 풀리거나 이력 없이 바뀔 수 있다.
    "trialDate", "hopeNote", "agreedTerms", "agreedPrivacy",
] as const;

/**
 * 체험비 입금 확인 전용 action.
 * 공용 수정 action과 분리해 중복 클릭에서도 최초 변경 한 번만 이력을 남긴다.
 */
export async function confirmTrialFeePayment(id: string): Promise<TrialFeeConfirmationResult> {
    const admin = await requireAdmin();
    await ensureTrialLeadTable();
    await ensureApplicationContactLogInfrastructure();

    const result = await confirmTrialFeeWithAudit(prisma, id, {
        userId: admin.appUserId,
        userName: admin.appUserName,
    });
    if (!result.found) return result;

    if (result.changed) {
        revalidatePath("/admin/trial");
        revalidatePath("/admin/apply");
        revalidateTrialAdminCaches();
    }

    return result;
}

export async function updateTrialLead(
    id: string,
    data: Partial<Record<(typeof TRIAL_LEAD_COLUMNS)[number], any>>,
    history?: {
        action?: ApplicationHistoryAction;
        note?: string | null;
        sendScheduleNotification?: boolean;
    },
) {
    const admin = await requireAdmin();
    await ensureTrialLeadTable();

    // 화이트리스트에 있는 필드만 추출
    const entries = TRIAL_LEAD_COLUMNS
        .filter((col) => data[col] !== undefined)
        .map((col) => [col, data[col]] as const);

    if (entries.length === 0) return;

    const previousRows = await prisma.$queryRawUnsafe<any[]>(
        `SELECT status, "attendedSmsSentAt", "scheduledDate", "scheduledClassId", "trialDate",
                "preferredSlotKey", "preferredDay", "preferredPeriod"
         FROM "TrialLead" WHERE id = $1 LIMIT 1`,
        id,
    );
    const previousLead = previousRows[0];
    if (!previousLead) throw new Error("체험 신청을 찾지 못했습니다. 목록을 새로고침해 주세요.");

    if (data.status === "SCHEDULED") {
        if (typeof data.scheduledClassId !== "string" || !data.scheduledClassId.trim()) {
            throw new Error("해당 날짜의 수업을 선택해 주세요.");
        }
        const explicitScheduledDate = data.scheduledDate;
        const hasExplicitScheduledTime = explicitScheduledDate instanceof Date
            ? !Number.isNaN(explicitScheduledDate.getTime())
            : typeof explicitScheduledDate === "string"
                && /T\d{2}:\d{2}/.test(explicitScheduledDate)
                && !Number.isNaN(new Date(explicitScheduledDate).getTime());
        // 확정 날짜가 없으면 희망일정(trialDate)으로 자동 채움
        const resolvedScheduledDate = data.scheduledDate !== undefined
            ? data.scheduledDate
            : (previousLead?.scheduledDate ?? previousLead?.scheduleddate
                ?? previousLead?.trialDate ?? previousLead?.trialdate);
        const scheduledClassId = data.scheduledClassId !== undefined
            ? data.scheduledClassId
            : previousLead?.scheduledClassId ?? previousLead?.scheduledclassid;
        const selectedDate = resolvedScheduledDate ? seoulDateInputValue(resolvedScheduledDate) : "";
        if (!selectedDate) {
            throw new Error("체험수업 일정을 확정하려면 올바른 수업 날짜와 시간을 입력해주세요.");
        }
        let slotKey = previousLead?.preferredSlotKey ?? previousLead?.preferredslotkey ?? null;
        if (typeof scheduledClassId === "string" && scheduledClassId.trim()) {
            const classes = await prisma.$queryRawUnsafe<Array<{ slotKey: string | null }>>(
                `SELECT "slotKey" FROM "Class" WHERE id=$1 LIMIT 1`, scheduledClassId.trim(),
            );
            slotKey = classes[0]?.slotKey ?? null;
        }
        if (!slotKey) throw new Error("체험수업 희망 시간표를 찾을 수 없습니다.");
        const canonical = await resolveCanonicalTrialSchedule({ selectedDate, slotKey, scheduledClassId: scheduledClassId || null });
        // 관리자가 시간을 명시했다면 관계만 검증하고 그 시각을 보존한다. 날짜뿐이거나 누락된 경우에만 시간표 시작시간을 채운다.
        const nextScheduledDate = hasExplicitScheduledTime ? explicitScheduledDate : canonical.scheduledDate;
        data.scheduledDate = nextScheduledDate;
        const scheduledEntry = entries.find(([col]) => col === "scheduledDate");
        if (scheduledEntry) (scheduledEntry as [string, unknown])[1] = nextScheduledDate;
        else entries.push(["scheduledDate", nextScheduledDate] as const);
    }

    const shouldSendAttendedSms =
        data.status === "ATTENDED"
        && previousLead
        && !(previousLead.attendedSmsSentAt ?? previousLead.attendedsmssentat);
    let attendedSmsResult: { attempted: boolean; sent: boolean; message?: string } = {
        attempted: false,
        sent: false,
    };
    const scheduledSmsResult: {
        attempted: boolean;
        parentSent: boolean;
        parentFailed: boolean;
        adminSent: number;
        adminFailed: number;
        coachSent: number;
        coachFailed: number;
        errors: string[];
    } = {
        attempted: false,
        parentSent: false,
        parentFailed: false,
        adminSent: 0,
        adminFailed: 0,
        coachSent: 0,
        coachFailed: 0,
        errors: [],
    };

    // 동적 SET절: 컬럼명은 화이트리스트에서만 허용 → SQL 인젝션 불가능, 값은 $N 바인딩
    const setClauses = entries.map(([col], i) => {
        // 날짜 타입 필드는 ::timestamptz 캐스팅
        const isDate = ["scheduledDate", "attendedDate", "convertedDate", "childBirthDate", "trialDate"].includes(col);
        return `"${col}" = $${i + 1}${isDate ? "::timestamptz" : ""}`;
    }).join(", ");
    const values = entries.map(([, val]) => val ?? null);

    try {
        await prisma.$executeRawUnsafe(
            `UPDATE "TrialLead" SET ${setClauses}, "updatedAt" = NOW() WHERE id = $${values.length + 1}`,
            ...values,
            id,
        );

        if (history?.action) {
            await recordApplicationHistoryLog({
                targetType: "TRIAL",
                targetId: id,
                action: history.action,
                note: history.note,
                admin,
            });
        }

        // 체험 기록의 아이 이름·보호자 번호를 고쳤다면(오타 수정 등), 아직 체험과 연결되지 않은
        // 수강 신청서와 다시 비교해 확실한 경우(AUTO)에만 연결한다. 문자는 보내지 않는다.
        // 실패해도 체험 기록 저장 자체는 성공으로 둔다(연결은 관리자 화면 [연결] 버튼으로도 가능).
        if (data.childName !== undefined || data.parentPhone !== undefined) {
            try {
                await autoLinkApplicationsForTrialLead(id, { appUserId: admin.appUserId, appUserName: admin.appUserName });
            } catch (linkError) {
                console.warn("[updateTrialLead] enroll application auto link failed:", (linkError as Error).message);
            }
        }

        // 일정 저장과 외부 발송은 별도 승인 대상이다. 기본 저장은 절대 문자를 보내지 않는다.
        if (data.status === "SCHEDULED" && history?.sendScheduleNotification === true) {
            scheduledSmsResult.attempted = true;
            try {
            // 해당 리드의 학부모 전화번호와 변수 조회
            const leads = await prisma.$queryRawUnsafe<any[]>(
                `SELECT "childName", "childGrade", "parentPhone", "scheduledDate", "scheduledClassId"
                 FROM "TrialLead" WHERE id = $1 LIMIT 1`,
                id,
            );
            if (leads.length > 0) {
                const lead = leads[0];
                const parentPhone = lead.parentPhone ?? lead.parentphone;
                const childName = lead.childName ?? lead.childname;
                const childGrade = lead.childGrade ?? lead.childgrade ?? "";
                const scheduledDate = lead.scheduledDate ?? lead.scheduleddate;
                const classId = lead.scheduledClassId ?? lead.scheduledclassid;

                // 배정 반 이름 + slotKey 조회 (담당 코치 SMS용)
                let className = "";
                let classSlotKey: string | null = null;
                if (classId) {
                    const cls = await prisma.$queryRawUnsafe<any[]>(
                        `SELECT name, "slotKey" FROM "Class" WHERE id = $1 LIMIT 1`, classId,
                    );
                    className = cls[0]?.name || "";
                    classSlotKey = cls[0]?.slotKey ?? cls[0]?.slotkey ?? null;
                }

                // 학원 전화번호 조회
                const settings = await prisma.$queryRawUnsafe<any[]>(
                    `SELECT "contactPhone" FROM "AcademySettings" WHERE id = 'singleton' LIMIT 1`
                );
                const academyPhone = settings[0]?.contactPhone ?? settings[0]?.contactphone ?? "";

                // 날짜 포맷팅
                const dateStr = formatTrialSmsDateTime(scheduledDate);
                // 같은 반·일시를 다시 저장해도 공급자에게 중복 요청하지 않는 일정 사건 번호다.
                // 반이나 시간이 실제로 변경되면 새 사건으로 처리되어 변경 안내는 정상 발송된다.
                const scheduledEventId = [
                    "trial",
                    id,
                    "scheduled",
                    new Date(scheduledDate).toISOString(),
                    classId || "no-class",
                ].join(":");

                if (parentPhone) {
                    const parentDelivery = await sendParentSmsWithResult(
                        parentPhone,
                        "TRIAL_SCHEDULED_PARENT",
                        {
                            childName: childName || "",
                            scheduledDate: dateStr,
                            className,
                            academyPhone,
                        },
                        {
                            eventType: "TRIAL_SCHEDULED",
                            eventId: scheduledEventId,
                        },
                    );
                    scheduledSmsResult.parentSent = parentDelivery.ok;
                    scheduledSmsResult.parentFailed = !parentDelivery.ok;
                    if (!parentDelivery.ok) {
                        scheduledSmsResult.errors.push(
                            parentDelivery.reason || "학부모 일정 확정 문자 발송에 실패했습니다.",
                        );
                    }
                } else {
                    scheduledSmsResult.parentFailed = true;
                    scheduledSmsResult.errors.push("학부모 전화번호가 없어 일정 확정 문자를 발송하지 못했습니다.");
                }

                // 담당 코치에게 체험 일정 확정 알림 SMS (slotKey 기반)
                const staffDelivery = await notifyAdmins(
                    "TRIAL_APPLICATION",
                    "체험수업 일정 확정",
                    `${childName || ""} — ${className} (${dateStr})`,
                    "/admin/trial",
                    {
                        coachTrigger: "TRIAL_SCHEDULED_COACH",
                        variables: {
                            childName: childName || "",
                            childGrade,
                            scheduledDate: dateStr,
                            className,
                        },
                        slotKeys: classSlotKey ? [classSlotKey] : undefined,
                        // 담당 슬롯이나 담당 코치가 없을 때 전체 코치에게 개인정보가 퍼지는 것을 막는다.
                        requireMatchedCoach: true,
                        eventId: scheduledEventId,
                    },
                );
                scheduledSmsResult.adminSent = staffDelivery.adminSent;
                scheduledSmsResult.adminFailed = staffDelivery.adminFailed;
                scheduledSmsResult.coachSent = staffDelivery.coachSent;
                scheduledSmsResult.coachFailed = staffDelivery.coachFailed;
                scheduledSmsResult.errors.push(...staffDelivery.errors);
            } else {
                scheduledSmsResult.errors.push("일정이 저장되었지만 체험 신청 정보를 다시 불러오지 못했습니다.");
            }
            } catch (smsError) {
                console.error("[updateTrialLead scheduled SMS] failed:", smsError);
                scheduledSmsResult.parentFailed = true;
                scheduledSmsResult.adminFailed = Math.max(1, scheduledSmsResult.adminFailed);
                scheduledSmsResult.coachFailed = Math.max(1, scheduledSmsResult.coachFailed);
                scheduledSmsResult.errors.push("일정은 저장됐지만 문자 발송 준비 중 오류가 발생했습니다.");
            }
        }

        if (shouldSendAttendedSms) {
            attendedSmsResult = { attempted: true, sent: false };
            const leads = await prisma.$queryRawUnsafe<any[]>(
                `SELECT "childName", "parentName", "parentPhone"
                 FROM "TrialLead" WHERE id = $1 LIMIT 1`,
                id,
            );
            const lead = leads[0];
            const parentPhone = lead?.parentPhone ?? lead?.parentphone;

            if (lead && parentPhone) {
                const settings = await prisma.$queryRawUnsafe<any[]>(
                    `SELECT "contactPhone" FROM "AcademySettings" WHERE id = 'singleton' LIMIT 1`
                );
                const academyPhone = settings[0]?.contactPhone ?? settings[0]?.contactphone ?? "";
                const childName = lead.childName ?? lead.childname ?? "";
                const parentName = lead.parentName ?? lead.parentname ?? "";

                const smsResult = await sendParentSmsWithResult(
                    parentPhone,
                    "TRIAL_ATTENDED_PARENT",
                    {
                        childName,
                        parentName,
                        academyPhone,
                        enrollLink: buildEnrollLink(id),
                    },
                    {
                        eventType: "TRIAL_ATTENDED",
                        eventId: `trial:${id}:attended`,
                    },
                );
                attendedSmsResult = {
                    attempted: true,
                    sent: smsResult.ok,
                    // 장부 확정 실패처럼 자동 재시도하면 안 되는 경우를 UI가 정확히 안내하도록 원인부터 전달한다.
                    message: smsResult.ok
                        ? undefined
                        : smsResult.reason || "체험 완료 문자는 발송되지 않아 다시 시도할 수 있습니다.",
                };

                // 실제 문자 성공(또는 장부상 기존 성공 확인)일 때만 완료 시각을 남긴다.
                if (smsResult.ok) {
                    await prisma.$executeRawUnsafe(
                        `UPDATE "TrialLead"
                         SET "attendedSmsSentAt" = COALESCE("attendedSmsSentAt", NOW()),
                             "updatedAt" = NOW()
                         WHERE id = $1`,
                        id,
                    );
                }
            } else {
                attendedSmsResult.message = "학부모 전화번호가 없어 체험 완료 문자를 발송하지 못했습니다.";
            }
        }
    } catch (e) {
        console.error("Failed to update trial lead:", e);
        throw new Error("체험 리드 수정 실패");
    }
    revalidatePath("/admin/trial");
    revalidatePath("/admin/apply");
    revalidateTrialAdminCaches();
    return {
        attendedSms: attendedSmsResult,
        scheduledSms: scheduledSmsResult,
    };
}

// 상태 변경과 분리된 체험 완료 문자 전용 재시도 액션이다.
export async function resendTrialAttendedSms(id: string) {
    const result = await updateTrialLead(id, { status: "ATTENDED" });
    if (!result?.attendedSms.attempted) {
        return { sent: true, message: "이미 발송 완료된 체험 완료 문자입니다." };
    }
    return {
        sent: result.attendedSms.sent,
        message: result.attendedSms.sent
            ? "체험 완료 문자를 발송했습니다."
            : result.attendedSms.message || "체험 완료 문자 발송에 실패했습니다. 문자 장부를 확인해주세요.",
    };
}

/**
 * 체험 리드 삭제
 */
export async function deleteTrialLead(id: string) {
    await requireAdmin();
    await ensureTrialLeadTable();

    try {
        await prisma.$executeRawUnsafe(
            `DELETE FROM "TrialLead" WHERE id = $1`, id
        );
    } catch (e) {
        console.error("Failed to delete trial lead:", e);
        throw new Error("체험 리드 삭제 실패");
    }
    revalidatePath("/admin/trial");
    revalidatePath("/admin/apply");
    revalidateTrialAdminCaches();
}

/**
 * 체험 → 정규 등록 전환
 * 1. Student 생성 (+ 학부모 User 생성/조회)
 * 2. TrialLead status='CONVERTED', convertedDate=NOW(), convertedStudentId=새 Student ID
 */
export async function convertTrialToStudent(
    leadId: string,
    studentData: {
        name: string;
        birthDate: string;
        gender?: string | null;
        parentName: string;
        parentPhone?: string | null;
        parentEmail?: string | null;
        memo?: string | null;
    }
) {
    await requireAdmin();
    await ensureTrialLeadTable();

    try {
        // 1. 학부모 User 생성 또는 조회 (createStudent와 동일한 패턴)
        let parentId: string;
        const email = studentData.parentEmail?.trim() || `parent_${Date.now()}@stiz.local`;

        const existing = await prisma.$queryRawUnsafe<any[]>(
            `SELECT id FROM "User" WHERE email = $1 LIMIT 1`, email
        );

        if (existing.length > 0) {
            parentId = existing[0].id;
            await prisma.$executeRawUnsafe(
                `UPDATE "User" SET name = $1, phone = $2, "updatedAt" = NOW() WHERE id = $3`,
                studentData.parentName, studentData.parentPhone || null, parentId,
            );
        } else {
            const rows = await prisma.$queryRawUnsafe<any[]>(
                `INSERT INTO "User" (id, email, name, phone, role, "createdAt", "updatedAt")
                 VALUES (gen_random_uuid()::text, $1, $2, $3, 'PARENT', NOW(), NOW())
                 RETURNING id`,
                email, studentData.parentName, studentData.parentPhone || null,
            );
            parentId = rows[0].id;
        }

        // 2. Student 생성 (RETURNING id로 새 학생 ID 획득)
        const studentRows = await prisma.$queryRawUnsafe<any[]>(
            `INSERT INTO "Student" (id, name, "birthDate", gender, "parentId", memo, "createdAt", "updatedAt")
             VALUES (gen_random_uuid()::text, $1, $2::timestamp, $3, $4, $5, NOW(), NOW())
             RETURNING id`,
            studentData.name,
            studentData.birthDate,
            studentData.gender || null,
            parentId,
            studentData.memo || null,
        );
        const newStudentId = studentRows[0].id;

        // 3. TrialLead 전환 처리 (상태 + 전환일 + 연결 Student ID)
        await prisma.$executeRawUnsafe(
            `UPDATE "TrialLead"
             SET status = 'CONVERTED', "convertedDate" = NOW(), "convertedStudentId" = $1, "updatedAt" = NOW()
             WHERE id = $2`,
            newStudentId, leadId,
        );
    } catch (e) {
        console.error("Failed to convert trial to student:", e);
        throw new Error("정규 등록 전환 실패");
    }
    revalidatePath("/admin/trial");
    revalidatePath("/admin/apply");
    revalidatePath("/admin/students");
    revalidatePath("/admin");
    revalidateTrialAdminCaches();
    revalidateStudentAdminCaches();
}

// ── 대기자(Waitlist) 관리 ─────────────────────────────────────────────────────

// DDL ensure: Waitlist 테이블이 없으면 생성 (멱등성 보장)
let _waitlistEnsured = false;
export async function ensureWaitlistTable() {
    if (_waitlistEnsured) return;
    try {
        await prisma.$executeRawUnsafe(`
            CREATE TABLE IF NOT EXISTS "Waitlist" (
                id TEXT PRIMARY KEY DEFAULT (gen_random_uuid())::text,
                "studentId" TEXT NOT NULL,
                "classId" TEXT NOT NULL,
                priority INT DEFAULT 0,
                status TEXT DEFAULT 'WAITING',
                "offeredAt" TIMESTAMPTZ,
                "respondBy" TIMESTAMPTZ,
                memo TEXT,
                "createdAt" TIMESTAMPTZ DEFAULT NOW(),
                "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE ("studentId", "classId")
            )
        `);
        // 인덱스도 멱등하게 생성
        await prisma.$executeRawUnsafe(
            `CREATE INDEX IF NOT EXISTS "Waitlist_classId_status_idx" ON "Waitlist" ("classId", status)`
        );
    } catch (e) {
        console.warn("[DDL] Waitlist table ensure failed:", (e as Error).message);
    }
    _waitlistEnsured = true;
}

/**
 * 대기 등록 — 학생을 반 대기열에 추가
 * priority는 해당 반의 기존 대기자 최대값 + 1로 자동 설정 (선착순)
 */
export async function addToWaitlist(studentId: string, classId: string, memo?: string) {
    await requireAdmin();
    await ensureWaitlistTable();
    try {
        // 해당 반의 현재 최대 priority 조회
        const maxRows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT COALESCE(MAX(priority), -1)::int AS max_p FROM "Waitlist" WHERE "classId" = $1`,
            classId,
        );
        const nextPriority = (maxRows[0]?.max_p ?? -1) + 1;

        await prisma.$executeRawUnsafe(
            `INSERT INTO "Waitlist" (id, "studentId", "classId", priority, status, memo, "createdAt", "updatedAt")
             VALUES (gen_random_uuid()::text, $1, $2, $3, 'WAITING', $4, NOW(), NOW())
             ON CONFLICT ("studentId", "classId") DO UPDATE
             SET status = 'WAITING', priority = $3, memo = $4, "updatedAt" = NOW()`,
            studentId, classId, nextPriority, memo || null,
        );
    } catch (e) {
        console.error("Failed to add to waitlist:", e);
        throw new Error("대기 등록 실패");
    }
    revalidatePath("/admin/waitlist");
    revalidatePath("/admin/classes");
    revalidateWaitlistAdminCaches();
}

/**
 * 대기 취소 — 대기열에서 제거 (status를 CANCELLED로 변경)
 */
export async function removeFromWaitlist(id: string) {
    await requireAdmin();
    try {
        await prisma.$executeRawUnsafe(
            `UPDATE "Waitlist" SET status = 'CANCELLED', "updatedAt" = NOW() WHERE id = $1`,
            id,
        );
    } catch (e) {
        console.error("Failed to remove from waitlist:", e);
        throw new Error("대기 취소 실패");
    }
    revalidatePath("/admin/waitlist");
    revalidatePath("/admin/classes");
    revalidateWaitlistAdminCaches();
}

/**
 * 자리 제안 — WAITING 상태의 대기자에게 자리를 제안
 * offeredAt: 현재 시각, respondBy: 3일 후 (응답 기한)
 * 학부모에게 Notification 발송
 */
export async function offerWaitlistSpot(id: string) {
    await requireAdmin();
    try {
        // 대기자 정보 조회 (학생 ID + 반 이름 필요)
        const rows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT w."studentId", w."classId", c.name AS class_name
             FROM "Waitlist" w
             LEFT JOIN "Class" c ON w."classId" = c.id
             WHERE w.id = $1 AND w.status = 'WAITING'`,
            id,
        );
        if (rows.length === 0) throw new Error("대기 상태가 아닌 항목입니다");

        const { studentId, class_name } = rows[0];
        const studentid = rows[0].studentId ?? rows[0].studentid;

        // 상태를 OFFERED로 변경 + 제안 시각/응답 기한 설정
        await prisma.$executeRawUnsafe(
            `UPDATE "Waitlist"
             SET status = 'OFFERED', "offeredAt" = NOW(), "respondBy" = NOW() + INTERVAL '3 days', "updatedAt" = NOW()
             WHERE id = $1`,
            id,
        );

        // 학부모에게 알림 발송 (자리가 났다는 안내)
        await notifyParentsOfStudents(
            [studentid],
            "WAITLIST",
            "대기 반 자리 안내",
            `${class_name ?? "반"} 자리가 났습니다. 3일 이내 응답해주세요.`,
            "/mypage",
        );
    } catch (e) {
        console.error("Failed to offer waitlist spot:", e);
        throw new Error("자리 제안 실패");
    }
    revalidatePath("/admin/waitlist");
    revalidateWaitlistAdminCaches();
}

/**
 * 대기자 응답 처리
 * accepted=true: Enrollment 생성 + status ENROLLED
 * accepted=false: status CANCELLED
 */
export async function processWaitlistResponse(id: string, accepted: boolean) {
    await requireAdmin();
    try {
        if (accepted) {
            // 대기자 정보 조회
            const rows = await prisma.$queryRawUnsafe<any[]>(
                `SELECT "studentId", "classId" FROM "Waitlist" WHERE id = $1 AND status = 'OFFERED'`,
                id,
            );
            if (rows.length === 0) throw new Error("제안 상태가 아닌 항목입니다");

            const studentId = rows[0].studentId ?? rows[0].studentid;
            const classId = rows[0].classId ?? rows[0].classid;

            // Enrollment 생성 (ON CONFLICT로 이미 있으면 ACTIVE로 업데이트)
            await prisma.$executeRawUnsafe(
                `INSERT INTO "Enrollment" (id, "studentId", "classId", status, "createdAt", "updatedAt")
                 VALUES (gen_random_uuid()::text, $1, $2, 'ACTIVE', NOW(), NOW())
                 ON CONFLICT ("studentId", "classId") DO UPDATE SET status = 'ACTIVE', "updatedAt" = NOW()`,
                studentId, classId,
            );

            // Waitlist 상태를 ENROLLED로 변경
            await prisma.$executeRawUnsafe(
                `UPDATE "Waitlist" SET status = 'ENROLLED', "updatedAt" = NOW() WHERE id = $1`,
                id,
            );
        } else {
            // 거절: CANCELLED로 변경
            await prisma.$executeRawUnsafe(
                `UPDATE "Waitlist" SET status = 'CANCELLED', "updatedAt" = NOW() WHERE id = $1`,
                id,
            );
        }
    } catch (e) {
        console.error("Failed to process waitlist response:", e);
        throw new Error("대기자 응답 처리 실패");
    }
    revalidatePath("/admin/waitlist");
    revalidatePath("/admin/classes");
    revalidatePath("/admin/students");
    revalidateWaitlistAdminCaches();
    revalidateStudentAdminCaches();
}

// ══════════════════════════════════════════════════════════════════════════════
// ── 보강(메이크업) 수업 관리 ─────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

// DDL ensure 플래그 — 프로세스당 한 번만 실행
let _makeupEnsured = false;

/**
 * MakeupSession 테이블 자동 생성 (멱등)
 * 서버 페이지에서 호출하여 테이블이 없으면 자동으로 만든다
 */
export async function ensureMakeupSessionTable() {
    if (_makeupEnsured) return;
    try {
        await prisma.$executeRawUnsafe(`
            CREATE TABLE IF NOT EXISTS "MakeupSession" (
                id TEXT PRIMARY KEY DEFAULT (gen_random_uuid())::text,
                "studentId" TEXT NOT NULL,
                "originalClassId" TEXT NOT NULL,
                "originalDate" TIMESTAMPTZ NOT NULL,
                "makeupClassId" TEXT NOT NULL,
                "makeupDate" TIMESTAMPTZ NOT NULL,
                status TEXT DEFAULT 'BOOKED',
                "requestId" TEXT,
                "createdAt" TIMESTAMPTZ DEFAULT NOW(),
                "updatedAt" TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        // 인덱스 멱등 생성
        await prisma.$executeRawUnsafe(
            `CREATE INDEX IF NOT EXISTS "MakeupSession_studentId_idx" ON "MakeupSession" ("studentId")`
        );
        await prisma.$executeRawUnsafe(
            `CREATE INDEX IF NOT EXISTS "MakeupSession_makeupClassId_makeupDate_idx" ON "MakeupSession" ("makeupClassId", "makeupDate")`
        );
    } catch (e) {
        console.warn("[DDL] MakeupSession table ensure failed:", (e as Error).message);
    }
    _makeupEnsured = true;
}

/**
 * 보강 반 잔여석 조회 — 보강 예약 모달이 "반 + 보강일" 기준으로 실제 빈자리를 확인한다.
 * (화면이 총정원을 잔여석처럼 낙관 표시하던 문제를 막기 위한 읽기 전용 액션)
 */
export async function loadMakeupSlotAvailability(input: {
    programId: string;
    excludeClassId: string;
    makeupDate: string; // YYYY-MM-DD
}) {
    await requireAdmin();
    const programId = input?.programId?.trim();
    const excludeClassId = input?.excludeClassId?.trim();
    const makeupDate = input?.makeupDate?.trim();
    // 날짜가 없으면 잔여석을 계산할 수 없다 → 빈 결과(화면은 "확인 중"을 유지)
    if (!programId || !excludeClassId) return { ok: false, slots: [] };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(makeupDate || "")) return { ok: false, slots: [] };

    const slots = await getMakeupSlotAvailability(programId, excludeClassId, makeupDate!);
    return { ok: true, slots };
}

/**
 * 저장 직전 정원 재검증 — 화면에서 본 잔여석과 실제 저장 시점 사이에
 * 다른 예약이 들어올 수 있으므로 서버에서 한 번 더 확인한다.
 * 수강 인원 판정은 출결 화면과 동일(ACTIVE Enrollment + 통합 학생 제외).
 */
async function assertMakeupSeatAvailable(makeupClassId: string, makeupDate: string) {
    const rows = await prisma.$queryRawUnsafe<any[]>(
        `SELECT c.capacity,
                (SELECT COUNT(*)::int
                   FROM "Enrollment" e
                   JOIN "Student" s ON s.id = e."studentId" AND ${notMergedStudent("s")}
                  WHERE e."classId" = c.id AND e.status = 'ACTIVE') AS enrolled
           FROM "Class" c
          WHERE c.id = $1
          LIMIT 1`,
        makeupClassId,
    );
    const row = rows[0];
    if (!row) throw new Error("보강 반을 찾을 수 없습니다.");

    // MakeupSession 테이블이 아직 없을 수 있다 → 없으면 활성 보강 0건으로 본다.
    let bookedMakeups = 0;
    try {
        const booked = await prisma.$queryRawUnsafe<any[]>(
            `SELECT COUNT(*)::int AS booked
               FROM "MakeupSession" ms
              WHERE ms."makeupClassId" = $1
                AND ms."makeupDate"::date = $2::date
                AND ${activeMakeupSql("ms")}`,
            makeupClassId,
            makeupDate,
        );
        bookedMakeups = Number(booked[0]?.booked ?? 0);
    } catch (e) {
        console.warn("[assertMakeupSeatAvailable] makeup count skipped:", (e as Error).message);
    }

    const usage = {
        capacity: Number(row.capacity ?? 0),
        enrolled: Number(row.enrolled ?? 0),
        bookedMakeups,
    };
    if (isMakeupSlotFull(usage)) throw new Error(MAKEUP_CAPACITY_FULL_MESSAGE);
}

/**
 * 보강 예약 — 결석한 학생에게 다른 반에서 보충 수업을 예약
 */
export async function bookMakeupSession(data: {
    studentId: string;
    originalClassId: string;
    originalDate: string; // ISO 날짜 문자열
    makeupClassId: string;
    makeupDate: string;   // ISO 날짜 문자열
    requestId?: string;
}) {
    await requireAdmin();
    await ensureMakeupSessionTable();
    // 정원 초과 차단 — 모달 예약과 결석→보강 지정(scheduleMakeupForAbsence) 두 경로 모두
    // 이 액션을 거치므로, 여기서 막으면 양쪽이 동일하게 보호된다.
    // (try 바깥에 두어 "이미 정원이 찼습니다..." 문구가 그대로 원장에게 전달되게 한다)
    await assertMakeupSeatAvailable(data.makeupClassId, data.makeupDate);
    try {
        await prisma.$executeRawUnsafe(
            `INSERT INTO "MakeupSession"
                (id, "studentId", "originalClassId", "originalDate", "makeupClassId", "makeupDate", status, "requestId", "createdAt", "updatedAt")
             VALUES (gen_random_uuid()::text, $1, $2, $3::timestamptz, $4, $5::timestamptz, 'BOOKED', $6, NOW(), NOW())`,
            data.studentId,
            data.originalClassId,
            data.originalDate,
            data.makeupClassId,
            data.makeupDate,
            data.requestId || null,
        );
    } catch (e) {
        console.error("Failed to book makeup session:", e);
        throw new Error("보강 예약 실패");
    }
    revalidatePath("/admin/makeup");
    revalidateMakeupAdminCaches();
}

/**
 * 보강 취소 — BOOKED 상태의 보강을 CANCELLED로 변경
 */
export async function cancelMakeupSession(id: string) {
    await requireAdmin();
    try {
        await prisma.$executeRawUnsafe(
            `UPDATE "MakeupSession" SET status = 'CANCELLED', "updatedAt" = NOW() WHERE id = $1`,
            id,
        );
    } catch (e) {
        console.error("Failed to cancel makeup session:", e);
        throw new Error("보강 취소 실패");
    }
    revalidatePath("/admin/makeup");
    revalidateMakeupAdminCaches();
}

/**
 * 보강 상태 변경 — BOOKED → ATTENDED / NO_SHOW / CANCELLED
 */
const MAKEUP_STATUS_WHITELIST = ["BOOKED", "ATTENDED", "CANCELLED", "NO_SHOW"];
export async function updateMakeupStatus(id: string, status: string) {
    await requireAdmin();
    // SQL 인젝션 방지: 허용된 상태값만 사용
    if (!MAKEUP_STATUS_WHITELIST.includes(status)) {
        throw new Error("잘못된 상태값입니다");
    }
    try {
        await prisma.$executeRawUnsafe(
            `UPDATE "MakeupSession" SET status = $1, "updatedAt" = NOW() WHERE id = $2`,
            status,
            id,
        );
    } catch (e) {
        console.error("Failed to update makeup status:", e);
        throw new Error("보강 상태 변경 실패");
    }
    // 보강권 반영(참석→사용완료 / 노쇼→차감 / 취소→복구).
    // 실패해도 출결 자체는 저장돼야 하므로 격리한다.
    try {
        const { syncCreditForMakeupSession } = await import("@/lib/makeup/credit-service");
        await syncCreditForMakeupSession({ makeupSessionId: id, status });
    } catch (e) {
        console.error("[updateMakeupStatus] 보강권 반영 실패(상태 변경은 완료됨):", e);
    }
    revalidatePath("/admin/makeup");
    revalidateMakeupAdminCaches();
}

// ── 수강 신청서 관리 (Phase C) ─────────────────────────────────────────────────

/**
 * 승인 흐름 중단용 신호(sentinel).
 * 이유: 트랜잭션 도중 '학생 모호(동명 형제)'를 발견하면, 이미 만든 학부모 레코드까지 되돌려야(rollback) 안전하다.
 *       일반 return으로는 트랜잭션이 커밋되므로, 특수 예외를 던져 롤백시키고 catch에서 그 payload를 그대로 반환한다.
 */
class ApprovalAbort extends Error {
    constructor(public payload: { ok: false; code: string; [k: string]: unknown }) {
        super("APPROVAL_ABORT");
    }
}

/** 서버 전용 Auth 조회다. 실패하거나 삭제된 계정이면 연결하지 않는다. */
async function verifyEnrollmentParentAuth(id: string) {
    const { data, error } = await createAdminClient({ fetch: approvalAuthFetch() }).auth.admin.getUserById(id);
    if (error) throw new Error("보호자 로그인 계정 확인에 실패했습니다. 잠시 후 다시 조회해 주세요.");
    return isActiveApprovalAuthUser(data.user, id);
}

export async function getEnrollmentParentCandidates(applicationId: string) {
    const admin = await requireAdmin();
    const [app] = await prisma.$queryRawUnsafe<Array<{ parentPhone: string | null; parentUserId: string | null }>>(
        `SELECT "parentPhone", "parentUserId" FROM "EnrollmentApplication" WHERE id = $1`, applicationId,
    );
    if (!app) throw new Error("신청서를 찾을 수 없습니다.");
    return listApprovalParentCandidates(prisma, app, admin.appUserId, verifyEnrollmentParentAuth);
}

export async function reopenEnrollApplicationForReview(applicationId: string, data: { reason: string }) {
    const admin = await requireAdmin();
    await ensureApplicationContactLogInfrastructure();
    const result = await prisma.$transaction((tx) => reopenEnrollmentForReview(tx, applicationId, data.reason, {
        id: admin.appUserId, name: admin.appUserName,
    }));
    revalidatePath("/admin/apply");
    revalidatePath("/admin");
    revalidateApplyAdminCaches();
    return result;
}

/**
 * 수강 신청서 승인 — 핵심 비즈니스 로직
 * 1. EnrollmentApplication 조회
 * 2. 명시 보호자 선택·Auth 연결 확인 → 후보가 없을 때만 새 PARENT 생성
 * 3. Student SELECT (name + parentId) → 없으면 INSERT
 * 4. Guardian INSERT (ON CONFLICT 무시)
 * 5. 각 classId에 대해 Enrollment 생성/활성화 + 운영 동기화 원장 적재
 * 6. EnrollmentApplication UPDATE (status=APPROVED, convertedStudentId, processedAt)
 * 7. TrialLead가 있으면 UPDATE (status=CONVERTED, convertedStudentId, convertedDate)
 */
export async function approveEnrollApplication(
    applicationId: string,
    data: {
        classIds: string[];       // 배정할 반 ID 배열
        processedNote?: string;   // 관리자 메모
        force?: boolean;          // A. 정원 초과 경고를 무시하고 강행할지(관리자 재확인 후 true)
        parentUserId?: string;    // 관리자가 직접 선택한 기존 보호자 계정 ID(대표 역할 유지)
        resolvedStudentId?: string; // B. 동명 형제로 학생이 모호할 때 관리자가 지정한 학생 id
    }
) {
    const admin = await requireAdmin();
    // force는 정원 경고만 우회한다. 반 필수·유효성 검사는 항상 유지한다.
    try {
        data = { ...data, classIds: normalizeApprovalClassIds(data?.classIds) };
    } catch (error) {
        return { ok: false as const, code: "INVALID_CLASSES" as const,
            message: error instanceof Error ? error.message : "배정할 수업을 확인해 주세요." };
    }
    const validClasses = await prisma.$queryRawUnsafe<{ id: string }[]>(
        `SELECT c.id FROM "Class" c JOIN "Program" p ON p.id=c."programId"
          WHERE c.id = ANY($1::text[]) AND c."dayOfWeek" <> 'Seasonal' AND p."deletedAt" IS NULL`,
        data.classIds,
    );
    if (validClasses.length !== data.classIds.length) {
        return { ok: false as const, code: "INVALID_CLASSES" as const,
            message: "현재 개설된 정규 수업만 배정할 수 있습니다. 수업을 다시 선택해 주세요." };
    }

    // ── A. 정원 초과 소프트 게이트 ──────────────────────────────────
    // 이유: 정원을 넘겨 배정하는 실수를 막되, 관리자 재량(대기 없이 추가)은 허용해야 한다.
    //       그래서 '하드 차단'이 아니라 '경고 후 재확인(force)' 방식으로 처리한다.
    //       ★ 트랜잭션 진입 전에 '읽기만' 수행 → DB 변경 0(부작용 없이 되돌릴 수 있음).
    if (data.force !== true && Array.isArray(data.classIds) && data.classIds.length > 0) {
        const overCapacity: { classId: string; name: string; current: number; capacity: number }[] = [];
        for (const classId of data.classIds) {
            // 각 반의 정원(capacity)과 '현재 ACTIVE 수강 인원' 조회(병합된 학생은 제외).
            const rows = await prisma.$queryRawUnsafe<any[]>(
                `SELECT c.name AS name, c.capacity AS capacity,
                        (SELECT COUNT(*) FROM "Enrollment" e
                         JOIN "Student" s ON s.id = e."studentId"
                         WHERE e."classId" = c.id AND e.status = 'ACTIVE' AND ${notMergedStudent("s")}
                        )::int AS current
                 FROM "Class" c WHERE c.id = $1 LIMIT 1`,
                classId,
            );
            if (rows.length === 0) continue;
            const capacity = Number(rows[0].capacity ?? rows[0].CAPACITY);
            const current = Number(rows[0].current ?? rows[0].CURRENT);
            // 이미 정원을 채운(current >= capacity) 반에 한 명 더 넣으면 초과 → 경고 대상.
            if (Number.isFinite(capacity) && Number.isFinite(current) && current >= capacity) {
                overCapacity.push({ classId, name: rows[0].name ?? "", current, capacity });
            }
        }
        // 초과 반이 하나라도 있으면 아무 것도 바꾸지 않고 경고만 반환 → UI가 재확인 후 force:true로 재호출.
        if (overCapacity.length > 0) {
            return { ok: false as const, code: "CAPACITY_WARNING" as const, classes: overCapacity };
        }
    }

    const smsResult = {
        parentSent: false,
        parentFailed: false,
        adminFailed: 0,
        coachSent: 0,
        coachFailed: 0,
        errors: [] as string[],
    };

    try {
        await prisma.$transaction(async (tx) => {
        // 저장 직전에도 반·프로그램을 잠가 사전 조회 이후 폐강된 반을 차단한다.
        const lockedClasses = await tx.$queryRawUnsafe<{ id: string }[]>(
            `SELECT c.id FROM "Class" c JOIN "Program" p ON p.id=c."programId"
              WHERE c.id = ANY($1::text[]) AND c."dayOfWeek" <> 'Seasonal' AND p."deletedAt" IS NULL
              FOR SHARE OF c, p`, data.classIds,
        );
        if (lockedClasses.length !== data.classIds.length) throw new Error("배정할 수업이 변경되었습니다. 다시 선택해 주세요.");
        // 1. 신청서 조회
        const apps = await tx.$queryRawUnsafe<any[]>(
            `SELECT * FROM "EnrollmentApplication" WHERE id = $1 FOR UPDATE`,
            applicationId
        );
        if (apps.length === 0) throw new Error("신청서를 찾을 수 없습니다.");
        const app = apps[0];

        // PENDING 상태만 승인 가능
        if (app.status !== "PENDING" || app.convertedStudentId || app.convertedstudentid) {
            throw new Error(`이미 처리된 신청서입니다. (현재 상태: ${app.status})`);
        }

        const readAppField = (field: string) => app[field] ?? app[field.toLowerCase()] ?? null;
        const shuttleNeeded = Boolean(readAppField("shuttleNeeded"));
        const locationPrefixes = ["shuttlePickup", "shuttleDropoff"] as const;
        const locationFields = [
            "Address", "RoadAddress", "Latitude", "Longitude", "PlaceId",
            "Source", "AccuracyMeters", "ConfirmedAt",
        ] as const;
        const hasAnyLocationMetadata = locationPrefixes.some((prefix) =>
            locationFields.some((suffix) => readAppField(`${prefix}${suffix}`) != null)
        );
        const consentVersion = readAppField("shuttleLocationConsentVersion");
        const consentAt = readAppField("shuttleLocationConsentAt");
        const hasAnyConsentMetadata = consentVersion != null || consentAt != null;
        const completeLocations = locationPrefixes.every((prefix) => {
            const address = String(readAppField(`${prefix}Address`) ?? "").trim();
            const rawLatitude = readAppField(`${prefix}Latitude`);
            const rawLongitude = readAppField(`${prefix}Longitude`);
            const latitude = Number(rawLatitude);
            const longitude = Number(rawLongitude);
            const source = readAppField(`${prefix}Source`);
            const confirmedAt = readAppField(`${prefix}ConfirmedAt`);
            const accuracy = readAppField(`${prefix}AccuracyMeters`);
            return Boolean(address)
                && rawLatitude != null
                && rawLongitude != null
                && Number.isFinite(latitude)
                && latitude >= -90
                && latitude <= 90
                && Number.isFinite(longitude)
                && longitude >= -180
                && longitude <= 180
                && ["MAP_PIN", "SEARCH", "CURRENT_LOCATION"].includes(source)
                && confirmedAt != null
                && !Number.isNaN(new Date(confirmedAt).getTime())
                && (
                    accuracy == null
                    || (
                        Number.isFinite(Number(accuracy))
                        && Number(accuracy) >= 0
                        && Number(accuracy) <= 1_000_000
                    )
                );
        });
        const hasCompleteCurrentConsent = consentVersion === SHUTTLE_LOCATION_CONSENT_VERSION
            && consentAt != null
            && !Number.isNaN(new Date(consentAt).getTime());

        if (!shuttleNeeded && (hasAnyLocationMetadata || hasAnyConsentMetadata)) {
            throw new Error("셔틀 미이용 신청서에 위치정보가 남아 있습니다. 신청서를 다시 저장해주세요.");
        }
        if (
            shuttleNeeded
            && (hasAnyLocationMetadata || hasAnyConsentMetadata)
            && !(completeLocations && hasCompleteCurrentConsent)
        ) {
            throw new Error("셔틀 위치 또는 위치정보 동의가 불완전합니다. 신청서를 다시 저장해주세요.");
        }
        const shouldCopyShuttleLocations = shuttleNeeded && completeLocations && hasCompleteCurrentConsent;

        // 2. 전화는 후보 검색에만 사용한다. 명시 선택한 계정을 다시 검증하고 대표 역할은 유지한다.
        const parentPhone = app.parentPhone ?? app.parentphone;
        const parentName = app.parentName ?? app.parentname;
        const parentPhoneDigitsValue = parentPhoneDigits(parentPhone);
        let parentId: string;
        const selectedParentId = await resolveApprovalParent(tx, app, data.parentUserId, verifyEnrollmentParentAuth);
        if (selectedParentId) {
            parentId = selectedParentId;
        } else {
            const newUsers = await tx.$queryRawUnsafe<any[]>(
                `INSERT INTO "User" (id, email, name, phone, role, "createdAt", "updatedAt")
                 VALUES (gen_random_uuid()::text, $1, $2, $3, 'PARENT', NOW(), NOW())
                 RETURNING id`,
                `parent_${parentPhoneDigitsValue}@stiz.local`, parentName, parentPhoneDigitsValue || parentPhone,
            );
            parentId = newUsers[0].id;
        }

        // 3. Student 조회/생성 — 동명 형제 오매칭·중복 생성 방지를 위해 '생년(childBirthDate)'을 매칭에 강화한다.
        //    핵심 원칙: 기존에 잘 매칭되던 '단일 학생'은 그대로 재사용(회귀 없음). 생년은 '동명 다수'를 가릴 때만 결정적으로 쓴다.
        const childName = app.childName ?? app.childname;
        const childBirthDate = app.childBirthDate ?? app.childbirthdate;
        let studentId: string | null = null;

        // (0) 관리자가 모호성 해소를 위해 특정 학생을 지정했으면(resolvedStudentId) 그 학생을 우선 사용.
        //     단, 이 보호자 소속이고 병합되지 않은 학생인지 검증(엉뚱한 학생 지정 방지).
        if (data.resolvedStudentId) {
            const picked = await tx.$queryRawUnsafe<any[]>(
                `SELECT id FROM "Student" s
                 WHERE ${notMergedStudent("s")} AND s.id = $1 AND s."parentId" = $2 LIMIT 1`,
                data.resolvedStudentId, parentId,
            );
            if (picked.length === 0) throw new Error("지정한 학생을 찾을 수 없습니다. 다시 확인해주세요.");
            studentId = picked[0].id;
        }

        // (1) 신청서 생년이 있으면 → name + parentId + birthDate 정확 매칭 우선.
        if (!studentId && childBirthDate) {
            const exact = await tx.$queryRawUnsafe<any[]>(
                `SELECT id FROM "Student" s
                 WHERE ${notMergedStudent("s")} AND s.name = $1 AND s."parentId" = $2
                   AND s."birthDate" = $3::timestamptz LIMIT 1`,
                childName, parentId, childBirthDate,
            );
            if (exact.length > 0) studentId = exact[0].id;
        }

        // (2) 못 찾으면 → name + parentId 폴백 조회.
        if (!studentId) {
            const fallback = await tx.$queryRawUnsafe<any[]>(
                `SELECT id, name, "birthDate" FROM "Student" s
                 WHERE ${notMergedStudent("s")} AND s.name = $1 AND s."parentId" = $2`,
                childName, parentId,
            );
            if (fallback.length === 1) {
                // 정확히 1명 → 기존 단일 학생 보존(생년 null/불일치여도 깨지 않고 재사용). ★중복 생성 방지의 핵심.
                studentId = fallback[0].id;
            } else if (fallback.length >= 2) {
                // 2명 이상(동명 형제) → 자동 선택/자동 생성 금지. 관리자가 지정하도록 후보를 돌려주고 중단(롤백).
                throw new ApprovalAbort({
                    ok: false,
                    code: "STUDENT_AMBIGUOUS",
                    candidates: fallback.map((s) => ({
                        id: s.id,
                        name: s.name,
                        birthDate: s.birthDate ?? s.birthdate ?? null,
                    })),
                });
            }
            // 0명이면 studentId는 null 유지 → 아래에서 신규 INSERT.
        }

        if (studentId) {
            // 기존 원생 업데이트 (최신 정보로 갱신). 생년이 비어있고 신청서 생년이 있으면 COALESCE로 채움(덮어쓰기 금지).
            await tx.$executeRawUnsafe(
                `UPDATE "Student" SET
                    "birthDate" = COALESCE("birthDate", $1::timestamptz),
                    gender = COALESCE($2, gender),
                    grade = COALESCE($3, grade),
                    school = COALESCE($4, school),
                    phone = COALESCE($5, phone),
                    address = COALESCE($6, address),
                    "referralSource" = COALESCE($7, "referralSource"),
                    "updatedAt" = NOW()
                 WHERE id = $8`,
                childBirthDate ?? null,
                app.childGender ?? app.childgender ?? null,
                app.childGrade ?? app.childgrade ?? null,
                app.childSchool ?? app.childschool ?? null,
                app.childPhone ?? app.childphone ?? null,
                app.address ?? null,
                app.referralSource ?? app.referralsource ?? null,
                studentId,
            );
        } else {
            // 새 원생 생성
            const newStudents = await tx.$queryRawUnsafe<any[]>(
                `INSERT INTO "Student" (id, name, "birthDate", gender, grade, school, phone, address, "referralSource", "parentId", "enrollDate", "createdAt", "updatedAt")
                 VALUES (gen_random_uuid()::text, $1, $2::timestamptz, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW(), NOW())
                 RETURNING id`,
                childName,
                childBirthDate,
                app.childGender ?? app.childgender ?? null,
                app.childGrade ?? app.childgrade ?? null,
                app.childSchool ?? app.childschool ?? null,
                app.childPhone ?? app.childphone ?? null,
                app.address ?? null,
                app.referralSource ?? app.referralsource ?? null,
                parentId,
            );
            studentId = newStudents[0].id;
        }

        // 아래 Guardian·Enrollment·운영 원장은 모두 안정적인 studentId가 있어야만 기록한다.
        if (!studentId) throw new Error("승인할 학생 식별값을 만들지 못했습니다.");

        // 4. Guardian 생성 — 보호자 관계 등록 (ON CONFLICT 무시)
        const parentRelation = app.parentRelation ?? app.parentrelation ?? "부모";
        await tx.$executeRawUnsafe(
            `INSERT INTO "Guardian" (id, "studentId", relation, name, phone, "isPrimary", "createdAt", "updatedAt")
             SELECT gen_random_uuid()::text, $1, $2, $3, $4, true, NOW(), NOW()
             WHERE NOT EXISTS (
                 SELECT 1
                 FROM "Guardian"
                 WHERE "studentId" = $1
                   AND relation = $2
             )`,
            studentId, parentRelation, parentName, parentPhone,
        );

        // 5. 각 반에 Enrollment를 등록하거나 비활성 수강을 다시 활성화하고,
        //    실제 상태가 바뀐 경우에만 세 시스템 동기화 원장을 같은 트랜잭션에 남긴다.
        for (const classId of data.classIds) {
            const [classContext] = await tx.$queryRawUnsafe<Array<{ className: string }>>(
                `SELECT name AS "className" FROM "Class" WHERE id = $1 LIMIT 1`,
                classId,
            );
            if (!classContext) throw new Error("배정할 반을 찾을 수 없습니다.");

            const [existingEnrollment] = await tx.$queryRawUnsafe<Array<{
                id: string;
                status: "ACTIVE" | "PAUSED" | "WITHDRAWN";
            }>>(
                `SELECT id, status FROM "Enrollment"
                  WHERE "studentId" = $1 AND "classId" = $2
                  FOR UPDATE`,
                studentId,
                classId,
            );
            // 이미 활성인 수강은 DB와 원장을 모두 건드리지 않는 완전한 no-op입니다.
            if (existingEnrollment?.status === "ACTIVE") continue;

            const [enrollment] = await tx.$queryRawUnsafe<Array<{ id: string; updatedAt: Date }>>(
                `INSERT INTO "Enrollment" (id, "studentId", "classId", status, "createdAt", "updatedAt")
                 VALUES (gen_random_uuid()::text, $1, $2, 'ACTIVE', NOW(), NOW())
                 ON CONFLICT ("studentId", "classId") DO UPDATE
                   SET status = 'ACTIVE', "updatedAt" = NOW()
                 RETURNING id, "updatedAt"`,
                studentId, classId,
            );
            const event = buildEnrollmentOperationsEvent({
                enrollmentId: enrollment.id,
                changedAt: enrollment.updatedAt,
                actorUserId: admin.appUserId,
                studentId,
                studentName: childName,
                classId,
                className: classContext.className,
                previousStatus: existingEnrollment?.status ?? null,
                nextStatus: "ACTIVE",
                enrollmentApplicationId: app.id,
            });
            if (event) await enqueueWebsiteOperationsEventInTransaction(tx, event);
        }

        // 학부모가 지도에서 확인한 탑승·하차 위치는 함께 저장한다.
        if (shouldCopyShuttleLocations) {
            const upsertLocation = (
                kind: "PICKUP" | "DROPOFF",
                prefix: "shuttlePickup" | "shuttleDropoff",
            ) => tx.$executeRawUnsafe(
                `INSERT INTO "StudentShuttleLocation" (
                    id, "studentId", kind, name, address, "roadAddress",
                    latitude, longitude, "placeId", source, "accuracyMeters",
                    "confirmedAt", "consentVersion", "createdAt", "updatedAt"
                 ) VALUES (
                    gen_random_uuid()::text, $1, $2, $12, $3, $4,
                    $5, $6, $7, $8, $9, $10::timestamptz, $11, NOW(), NOW()
                 )
                 ON CONFLICT ("studentId", kind) DO UPDATE SET
                    name = EXCLUDED.name,
                    address = EXCLUDED.address,
                    "roadAddress" = EXCLUDED."roadAddress",
                    latitude = EXCLUDED.latitude,
                    longitude = EXCLUDED.longitude,
                    "placeId" = EXCLUDED."placeId",
                    source = EXCLUDED.source,
                    "accuracyMeters" = EXCLUDED."accuracyMeters",
                    "confirmedAt" = EXCLUDED."confirmedAt",
                    "consentVersion" = EXCLUDED."consentVersion",
                    "updatedAt" = NOW()`,
                studentId,
                kind,
                readAppField(`${prefix}Address`),
                readAppField(`${prefix}RoadAddress`),
                readAppField(`${prefix}Latitude`),
                readAppField(`${prefix}Longitude`),
                readAppField(`${prefix}PlaceId`),
                readAppField(`${prefix}Source`),
                readAppField(`${prefix}AccuracyMeters`),
                readAppField(`${prefix}ConfirmedAt`),
                consentVersion,
                // $12: 장소명(라벨) — G2에서 EnrollmentApplication.shuttlePickup/shuttleDropoff 라벨 컬럼에 저장된 값.
                // prefix 자체가 라벨 컬럼명(접미사 없는 shuttlePickup/shuttleDropoff)이라 그대로 읽는다.
                // 값이 없으면 도로명주소 -> 지번주소 순으로 폴백(관리자 수동확정 service.ts와 동일 철학, 단 name null 방지).
                readAppField(prefix)
                    ?? readAppField(`${prefix}RoadAddress`)
                    ?? readAppField(`${prefix}Address`),
            );
            await upsertLocation("PICKUP", "shuttlePickup");
            await upsertLocation("DROPOFF", "shuttleDropoff");
        }

        // 6. 신청서 상태 업데이트
        await tx.$executeRawUnsafe(
            `UPDATE "EnrollmentApplication"
             SET status = 'APPROVED',
                 "convertedStudentId" = $1,
                 "processedAt" = NOW(),
                 "processedNote" = $2,
                 "assignedClassId" = $3,
                 "parentUserId" = $5,
                 "updatedAt" = NOW()
             WHERE id = $4`,
            studentId,
            data.processedNote || null,
            data.classIds.join(","),
            applicationId,
            parentId,
        );

        // 7. 연결된 TrialLead가 있으면 CONVERTED로 업데이트
        const trialLeadId = app.trialLeadId ?? app.trialleadid;
        if (trialLeadId) {
            await tx.$executeRawUnsafe(
                `UPDATE "TrialLead"
                 SET status = 'CONVERTED',
                     "convertedStudentId" = $1,
                     "convertedDate" = NOW(),
                     "updatedAt" = NOW()
                 WHERE id = $2`,
                studentId, trialLeadId,
            );
        }
        }, { timeout: 15_000 });
    } catch (e) {
        // 학생 모호(STUDENT_AMBIGUOUS) 등 '중단 신호'는 에러가 아니라 정상 반환값으로 돌려준다(트랜잭션은 롤백됨).
        if (e instanceof ApprovalAbort) {
            return e.payload;
        }
        if (e instanceof ParentSelectionRequired) {
            return { ok: false as const, code: "PARENT_SELECTION_REQUIRED" as const, message: e.message };
        }
        console.error("Failed to approve enrollment application:", e);
        throw new Error((e as Error).message || "수강 신청 승인 실패");
    }

    revalidatePath("/admin/apply");
    revalidatePath("/admin/trial");
    revalidatePath("/admin/students");
    revalidatePath("/admin");
    revalidateApplyAdminCaches();
    revalidateStudentAdminCaches();

    // 외부 알림은 이 승인 액션에서 실행하지 않습니다. 정확한 수신자·문구 미리보기와
    // 별도 승인 원장을 갖춘 전용 발송 액션에서만 처리해야 합니다.
    return { approved: true, sms: smsResult };
}

/**
 * 수강 신청 목록용 — 체험과 연결되지 않은 신청서별 "체험 기록 후보".
 * 읽기 전용이며 관리자만 호출할 수 있다.
 */
export async function getEnrollTrialLinkSuggestions(): Promise<Record<string, TrialLinkSuggestion[]>> {
    await requireAdmin();
    await ensureTrialLeadTable();
    try {
        return await getTrialLinkSuggestions();
    } catch (error) {
        console.warn("[getEnrollTrialLinkSuggestions] failed:", (error as Error).message);
        return {};
    }
}

/**
 * 관리자가 [연결] 버튼으로 신청서와 체험 기록을 직접 연결한다.
 * 이미 연결된 쪽은 덮어쓰지 않고, 문자·알림은 보내지 않는다.
 */
export async function linkEnrollApplicationToTrialLead(applicationId: string, trialLeadId: string) {
    const admin = await requireAdmin();
    await ensureTrialLeadTable();
    const result = await linkTrialLeadToApplication({
        applicationId,
        trialLeadId,
        actor: { appUserId: admin.appUserId, appUserName: admin.appUserName },
        note: "관리자가 체험 기록 후보를 직접 연결",
    });
    // 운영 빌드는 서버 액션의 throw 메시지를 가리므로, 실패 사유는 반환값으로 돌려준다.
    if (!result.linked) return result;

    revalidatePath("/admin/apply");
    revalidatePath("/admin/trial");
    revalidatePath("/admin");
    revalidateApplyAdminCaches();
    revalidateTrialAdminCaches();
    return result;
}

/**
 * 수강 신청서 반려 — 상태를 REJECTED로 변경
 */
export async function rejectEnrollApplication(
    applicationId: string,
    reason?: string
) {
    await requireAdmin();

    try {
        // PENDING 상태만 반려 가능
        const apps = await prisma.$queryRawUnsafe<any[]>(
            `SELECT status FROM "EnrollmentApplication" WHERE id = $1 LIMIT 1`,
            applicationId
        );
        if (apps.length === 0) throw new Error("신청서를 찾을 수 없습니다.");
        if (apps[0].status !== "PENDING") {
            throw new Error(`이미 처리된 신청서입니다. (현재 상태: ${apps[0].status})`);
        }

        await prisma.$executeRawUnsafe(
            `UPDATE "EnrollmentApplication"
             SET status = 'REJECTED',
                 "processedAt" = NOW(),
                 "processedNote" = $1,
                 "updatedAt" = NOW()
             WHERE id = $2`,
            reason || null,
            applicationId,
        );
    } catch (e) {
        console.error("Failed to reject enrollment application:", e);
        throw new Error((e as Error).message || "수강 신청 반려 실패");
    }

    revalidatePath("/admin/apply");
    revalidatePath("/admin");
    revalidateApplyAdminCaches();
}

const ENROLL_APPLICATION_COLUMNS = [
    "trialLeadId",
    "childName", "childBirthDate", "childGender", "childGrade", "childSchool", "childPhone",
    "parentName", "parentPhone", "parentRelation", "address",
    "enrollmentMonths", "preferredSlotKeys", "assignedClassId",
    "basketballExp", "uniformSize",
    "shuttleNeeded", "shuttlePickup", "shuttleTime", "shuttleDropoff",
    "paymentMethod", "referralSource", "memo",
    "applicationNoticeConfirmed", "shuttleNoticeConfirmed", "processedNote",
] as const;

type EnrollApplicationColumn = (typeof ENROLL_APPLICATION_COLUMNS)[number];

const ENROLL_APPLICATION_FIELD_LABELS: Partial<Record<EnrollApplicationColumn, string>> = {
    childName: "아이 이름",
    childBirthDate: "생년월일",
    childGender: "성별",
    childGrade: "학년",
    childSchool: "학교",
    childPhone: "아이 연락처",
    parentName: "보호자 이름",
    parentPhone: "보호자 연락처",
    parentRelation: "보호자 관계",
    address: "주소",
    enrollmentMonths: "수강 월",
    preferredSlotKeys: "희망 시간",
    assignedClassId: "배정 반",
    basketballExp: "농구 경험",
    uniformSize: "유니폼",
    shuttleNeeded: "셔틀 신청",
    shuttlePickup: "탑승지",
    shuttleTime: "셔틀 시간",
    shuttleDropoff: "하차지",
    paymentMethod: "납부 방식",
    referralSource: "유입 경로",
    memo: "메모",
    applicationNoticeConfirmed: "확정 안내 확인",
    shuttleNoticeConfirmed: "셔틀 주의 확인",
    processedNote: "처리 메모",
};

function normalizeHistoryValue(value: unknown) {
    if (value instanceof Date) return value.toISOString();
    if (value === null || value === undefined) return "";
    if (typeof value === "boolean") return value ? "true" : "false";
    return String(value).trim();
}

function buildEnrollApplicationUpdateNote(
    previous: Record<string, unknown>,
    entries: Array<readonly [EnrollApplicationColumn, unknown]>,
) {
    const changedLabels = entries
        .filter(([column, value]) => normalizeHistoryValue(previous[column]) !== normalizeHistoryValue(value))
        .map(([column]) => ENROLL_APPLICATION_FIELD_LABELS[column] ?? column);

    if (changedLabels.length === 0) return "수강신청 내용을 다시 저장했습니다.";
    const visibleLabels = changedLabels.slice(0, 6).join(", ");
    const suffix = changedLabels.length > 6 ? ` 외 ${changedLabels.length - 6}개` : "";
    return `수정: ${visibleLabels}${suffix}`;
}

/**
 * 수강 신청서 수정 — 승인 전 신청 내용을 관리자 화면에서 정리
 * 승인 후에는 원생/수강 등록 데이터가 이미 만들어지므로 별도 메뉴에서 수정해야 한다.
 */
export async function updateEnrollApplication(
    applicationId: string,
    data: Partial<Record<(typeof ENROLL_APPLICATION_COLUMNS)[number], any>>
) {
    const admin = await requireAdmin();

    try {
        const apps = await prisma.$queryRawUnsafe<any[]>(
            `SELECT * FROM "EnrollmentApplication" WHERE id = $1 LIMIT 1`,
            applicationId,
        );
        if (apps.length === 0) throw new Error("신청서를 찾을 수 없습니다.");
        if (apps[0].status === "APPROVED") {
            throw new Error("이미 승인된 신청서는 원생/수강 등록 메뉴에서 수정해주세요.");
        }

        const entries = ENROLL_APPLICATION_COLUMNS
            .filter((col) => data[col] !== undefined)
            .map((col) => [col, data[col]] as const);
        if (entries.length === 0) return;

        const historyNote = buildEnrollApplicationUpdateNote(apps[0], entries);

        const setClauses = entries.map(([col], index) => {
            const isDate = ["childBirthDate"].includes(col);
            return `"${col}" = $${index + 1}${isDate ? "::timestamptz" : ""}`;
        }).join(", ");
        const values = entries.map(([, value]) => value ?? null);

        await prisma.$executeRawUnsafe(
            `UPDATE "EnrollmentApplication"
             SET ${setClauses}, "updatedAt" = NOW()
             WHERE id = $${values.length + 1}`,
            ...values,
            applicationId,
        );

        await recordApplicationHistoryLog({
            targetType: "ENROLL",
            targetId: applicationId,
            action: "UPDATED",
            note: historyNote,
            admin,
        });
    } catch (e) {
        console.error("Failed to update enrollment application:", e);
        throw new Error((e as Error).message || "수강 신청 수정 실패");
    }

    revalidatePath("/admin/apply");
    revalidatePath("/admin");
    revalidateApplyAdminCaches();
}

/**
 * 수강 신청서 취소 — 삭제하지 않고 취소 이력으로 남긴다.
 */
export async function cancelEnrollApplication(
    applicationId: string,
    reason?: string
) {
    const admin = await requireAdmin();

    try {
        const apps = await prisma.$queryRawUnsafe<any[]>(
            `SELECT status FROM "EnrollmentApplication" WHERE id = $1 LIMIT 1`,
            applicationId,
        );
        if (apps.length === 0) throw new Error("신청서를 찾을 수 없습니다.");
        if (apps[0].status === "APPROVED") {
            throw new Error("이미 승인된 신청은 원생/수강 등록에서 취소해주세요.");
        }

        const cancelReason = reason?.trim() || "관리자 취소";

        await prisma.$executeRawUnsafe(
            `UPDATE "EnrollmentApplication"
             SET status = 'CANCELLED',
                 "processedAt" = NOW(),
                 "processedNote" = $1,
                 "updatedAt" = NOW()
             WHERE id = $2`,
            cancelReason,
            applicationId,
        );

        await recordApplicationHistoryLog({
            targetType: "ENROLL",
            targetId: applicationId,
            action: "CANCELLED",
            note: `취소: ${cancelReason}`,
            admin,
        });
    } catch (e) {
        console.error("Failed to cancel enrollment application:", e);
        throw new Error((e as Error).message || "수강 신청 취소 실패");
    }

    revalidatePath("/admin/apply");
    revalidatePath("/admin");
    revalidateApplyAdminCaches();
}

export async function recordApplicationContact(input: {
    targetType: ApplicationContactTargetType;
    targetId: string;
    action: ApplicationContactAction;
    note?: string | null;
    nextFollowUpAt?: string | null;
}) {
    const admin = await requireAdmin();
    await ensureApplicationContactLogInfrastructure();

    const targetType = input.targetType;
    const action = input.action;
    const targetId = input.targetId?.trim();
    const note = input.note?.trim() || null;
    const nextFollowUpAt = input.nextFollowUpAt?.trim() || null;

    if (!targetId) {
        throw new Error("기록할 신청 건을 찾을 수 없습니다.");
    }
    if (targetType !== "TRIAL" && targetType !== "ENROLL") {
        throw new Error("지원하지 않는 신청 유형입니다.");
    }
    if (!APPLICATION_CONTACT_ACTIONS.includes(action)) {
        throw new Error("지원하지 않는 연락 기록입니다.");
    }
    if (action === "FOLLOW_UP" && !nextFollowUpAt) {
        throw new Error("다음 연락 예정일을 입력해 주세요.");
    }
    if (nextFollowUpAt && Number.isNaN(new Date(nextFollowUpAt).getTime())) {
        throw new Error("다음 연락 예정일 형식이 올바르지 않습니다.");
    }

    const result = await recordApplicationContactAtomically(prisma, {
        targetType,
        targetId,
        action,
        note,
        nextFollowUpAt,
        actorUserId: admin.appUserId,
        actorUserName: admin.appUserName,
    });
    if (!result.found) throw new Error("신청 건을 찾을 수 없습니다.");

    revalidatePath("/admin/apply");
    revalidatePath("/admin/trial");
    if (targetType === "TRIAL") {
        revalidateTrialAdminCaches();
    } else {
        revalidateApplyAdminCaches();
    }

    return { ok: true };
}

/**
 * 수강 안내 링크 생성 — 체험 리드의 trialLeadId를 포함한 수강 신청 URL 반환
 * 관리자가 체험 완료된 학부모에게 보낼 링크를 복사하는 용도
 */
function buildEnrollLink(trialLeadId: string): string {
    const baseUrl = (
        process.env.NEXT_PUBLIC_SITE_URL?.trim()
        || process.env.NEXT_PUBLIC_BASE_URL?.trim()
        || PUBLIC_SITE_URL
    ).replace(/\/+$/, "");

    return `${baseUrl}/apply/enroll?trialId=${trialLeadId}`;
}

export async function generateEnrollLink(trialLeadId: string): Promise<string> {
    await requireAdmin();

    // trialLeadId 존재 확인
    const leads = await prisma.$queryRawUnsafe<any[]>(
        `SELECT id FROM "TrialLead" WHERE id = $1 LIMIT 1`,
        trialLeadId
    );
    if (leads.length === 0) throw new Error("체험 리드를 찾을 수 없습니다.");

    // 프로토콜+호스트를 환경변수 또는 기본값에서 가져옴
    // 환경변수에서 베이스 URL 결정: 직접 설정 > Vercel 자동 > 로컬 개발
    return buildEnrollLink(trialLeadId);
}

// ── SMS 수동 발송 (관리자 전용) ──────────────────────────────────────────────
// 관리자가 코치 또는 직접 입력한 번호로 문자를 보내는 기능

export type PostTrialEnrollGuideResult = {
    enrollLink: string;
    sent: boolean;
    message?: string;
};

export async function sendPostTrialEnrollGuide(
    trialLeadId: string,
    options?: { convert?: boolean },
): Promise<PostTrialEnrollGuideResult> {
    await requireAdmin();
    await ensureTrialLeadTable();

    const leads = await prisma.$queryRawUnsafe<any[]>(
        `SELECT id, "childName", "parentName", "parentPhone", status
         FROM "TrialLead"
         WHERE id = $1
         LIMIT 1`,
        trialLeadId,
    );
    if (leads.length === 0) {
        throw new Error("체험 리드를 찾을 수 없습니다.");
    }

    const lead = leads[0];
    if (options?.convert) {
        await prisma.$executeRawUnsafe(
            `UPDATE "TrialLead"
             SET status = 'CONVERTED',
                 "convertedDate" = COALESCE("convertedDate", NOW()),
                 "updatedAt" = NOW()
             WHERE id = $1`,
            trialLeadId,
        );
    }

    const parentPhone = lead.parentPhone ?? lead.parentphone;

    try {
    const { shortUrl: enrollLink } = await createTrialEnrollShortLink(trialLeadId);
    const childName = lead.childName ?? lead.childname ?? "";
    const parentName = lead.parentName ?? lead.parentname ?? "";
    const templateVariables = { childName, parentName, enrollLink };
    const renderedMessage = await renderSmsTemplate("TRIAL_ENROLL_GUIDE_PARENT", templateVariables);
    if (!renderedMessage) {
        return {
            enrollLink,
            sent: false,
            message: "수강신청 안내 문자 템플릿을 사용할 수 없습니다.",
        };
    }
    try {
        assertSolapiShortSms(renderedMessage);
    } catch {
        return {
            enrollLink,
            sent: false,
            message: "단문 기준을 초과해 발송하지 않았습니다. 문자 템플릿이나 짧은 링크 주소를 확인해주세요.",
        };
    }

    const smsResult = await sendParentSmsWithResult(
        parentPhone || "",
        "TRIAL_ENROLL_GUIDE_PARENT",
        templateVariables,
        {
            eventType: "TRIAL_ENROLL_GUIDE",
            eventId: `trial:${trialLeadId}:enroll-guide`,
            forceSms: true,
        },
    );

    if (smsResult.ok) {
        await prisma.$executeRawUnsafe(
            `UPDATE "TrialLead"
             SET "postTrialConsultedAt" = COALESCE("postTrialConsultedAt", NOW()),
                 "enrollGuideSentAt" = COALESCE("enrollGuideSentAt", NOW()),
                 "updatedAt" = NOW()
             WHERE id = $1`,
            trialLeadId,
        );
    }

    revalidatePath("/admin/trial");
    revalidatePath("/admin/apply");
    revalidateTrialAdminCaches();

    return {
        enrollLink,
        sent: smsResult.ok,
        message: smsResult.ok
            ? undefined
            : smsResult.reason || "수강신청 안내 문자 발송에 실패했습니다.",
    };
    } catch (smsError) {
        console.error("[sendPostTrialEnrollGuide SMS] failed:", smsError);
        revalidatePath("/admin/trial");
        revalidatePath("/admin/apply");
        revalidateTrialAdminCaches();
        return {
            enrollLink: "",
            sent: false,
            message: "수강신청 안내 문자 준비 중 오류가 발생했습니다.",
        };
    }
}

type TrialApplicationSmsResendResult = {
    requested: number;
    sent: number;
    failed: number;
    targets: string[];
    message: string;
};

function normalizeAdminSmsPhone(phone: string | null | undefined) {
    return (phone ?? "").replace(/\D/g, "");
}

async function getTrialApplicationCoachSmsRecipients(slotKey: string | null): Promise<Array<{ id: string; name: string; phone: string }>> {
    if (!slotKey) {
        return prisma.$queryRawUnsafe<Array<{ id: string; name: string; phone: string }>>(
            `SELECT id, name, phone
             FROM "Coach"
             WHERE phone IS NOT NULL AND phone != ''
             ORDER BY name ASC`,
        );
    }

    return prisma.$queryRawUnsafe<Array<{ id: string; name: string; phone: string }>>(
        `SELECT DISTINCT c.id, c.name, c.phone
         FROM "ScheduleSlot" ss
         JOIN "Coach" c ON c.id = ss."coachId"
         WHERE ss."slotKey" = $1 AND c.phone IS NOT NULL AND c.phone != ''
         UNION
         SELECT DISTINCT c.id, c.name, c.phone
         FROM "ClassSlotOverride" o
         JOIN "Coach" c ON c.id = o."coachId"
         WHERE o."slotKey" = $1 AND c.phone IS NOT NULL AND c.phone != ''
         UNION
         SELECT DISTINCT c.id, c.name, c.phone
         FROM "CustomClassSlot" cs
         JOIN "Coach" c ON c.id = cs."coachId"
         WHERE (cs.id = $1 OR ('custom-' || cs.id) = $1)
           AND c.phone IS NOT NULL AND c.phone != ''
         ORDER BY name ASC`,
        slotKey,
    );
}

export async function resendTrialApplicationSms(trialLeadId: string): Promise<TrialApplicationSmsResendResult> {
    await requireAdmin();
    await ensureTrialLeadTable();

    const leads = await prisma.$queryRawUnsafe<any[]>(
        `SELECT id, "childName", "childGrade", "parentName", "parentPhone", "preferredSlotKey"
         FROM "TrialLead"
         WHERE id = $1
         LIMIT 1`,
        trialLeadId,
    );
    if (leads.length === 0) throw new Error("체험 신청 정보를 찾을 수 없습니다.");

    const lead = leads[0];
    const childName = lead.childName ?? lead.childname ?? "";
    const childGrade = lead.childGrade ?? lead.childgrade ?? "학년 미입력";
    const parentName = lead.parentName ?? lead.parentname ?? "";
    const parentPhone = lead.parentPhone ?? lead.parentphone ?? "";
    const preferredSlotKey = lead.preferredSlotKey ?? lead.preferredslotkey ?? null;

    const failedRows = await prisma.$queryRawUnsafe<Array<{ recipientRole: string | null; trigger: string | null }>>(
        `SELECT latest."recipientRole", latest.trigger
         FROM (
             SELECT DISTINCT ON (
                 nd."recipientPhone",
                 nd."payloadJSON"->>'recipientRole',
                 nd."payloadJSON"->>'trigger'
             )
                 nd.status,
                 nd."payloadJSON"->>'recipientRole' AS "recipientRole",
                 nd."payloadJSON"->>'trigger' AS trigger,
                 nd."updatedAt"
             FROM "NotificationDelivery" nd
             WHERE nd."eventType" = 'TRIAL_APPLICATION'
               AND nd.channel = 'SMS'
               AND nd."dedupeKey" LIKE ('sms:TRIAL_APPLICATION:' || $1 || ':%')
             ORDER BY
                 nd."recipientPhone",
                 nd."payloadJSON"->>'recipientRole',
                 nd."payloadJSON"->>'trigger',
                 nd."updatedAt" DESC
         ) latest
         WHERE latest.status = 'FAILED'`,
        trialLeadId,
    );

    if (failedRows.length === 0) {
        return {
            requested: 0,
            sent: 0,
            failed: 0,
            targets: [],
            message: "재발송할 실패 문자가 없습니다.",
        };
    }

    const failedTargets = new Set(failedRows.map(row => `${row.recipientRole ?? ""}:${row.trigger ?? ""}`));
    const retryAllTargets = failedRows.some(row => !row.recipientRole || !row.trigger);
    const shouldSendParent = retryAllTargets || failedTargets.has("PARENT:TRIAL_CONFIRM_PARENT");
    const shouldSendAdmin = retryAllTargets || failedTargets.has("ADMIN:TRIAL_NEW_ADMIN");
    const shouldSendCoach = retryAllTargets || failedTargets.has("COACH:TRIAL_NEW_COACH");
    const deliveryRunId = `retry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const variables = {
        childName,
        childGrade,
        parentName,
        parentPhone: normalizeAdminSmsPhone(parentPhone),
    };
    const { renderSmsTemplate } = await import("@/lib/smsTemplate");

    const settings = await prisma.$queryRawUnsafe<any[]>(
        `SELECT "contactPhone" FROM "AcademySettings" WHERE id = 'singleton' LIMIT 1`,
    );
    const academyPhone = settings[0]?.contactPhone ?? settings[0]?.contactphone ?? "";
    const smsTasks: Array<Promise<{ ok: boolean; to: string; reason?: string }>> = [];
    const targetLabels = new Set<string>();
    const staffPhones = new Set<string>();

    if (shouldSendParent) {
        const normalizedParentPhone = normalizeAdminSmsPhone(parentPhone);
        if (!normalizedParentPhone) {
            throw new Error("학부모 연락처가 없어 접수 확인 문자를 재발송할 수 없습니다.");
        }
        const renderedParentMessage = await renderSmsTemplate("TRIAL_CONFIRM_PARENT", {
            childName,
            parentName,
            academyPhone,
        });
        const parentMessage = renderedParentMessage
            || `[STIZ] ${childName} 체험수업 신청이 접수되었습니다.\n일정 확정 후 다시 안내드리겠습니다.\n문의: ${academyPhone}`;
        targetLabels.add("학부모");
        smsTasks.push(sendTrackedSms({
            eventType: "TRIAL_APPLICATION",
            eventId: trialLeadId,
            deliveryRunId,
            recipientPhone: normalizedParentPhone,
            recipientRole: "PARENT",
            trigger: "TRIAL_CONFIRM_PARENT",
            body: parentMessage,
        }));
    }

    if (shouldSendAdmin) {
        const adminMessage = await renderSmsTemplate("TRIAL_NEW_ADMIN", variables)
            || `[STIZ] 새 체험수업 신청\n${childName} (${childGrade}) - ${parentName}`;
        const admins = await prisma.$queryRawUnsafe<Array<{ id: string; phone: string | null }>>(
            `SELECT id, phone
             FROM "User"
             WHERE role IN ('ADMIN', 'VICE_ADMIN')
               AND phone IS NOT NULL
               AND phone != ''`,
        );
        for (const admin of admins) {
            const phone = normalizeAdminSmsPhone(admin.phone);
            if (!phone || staffPhones.has(phone)) continue;
            staffPhones.add(phone);
            targetLabels.add("관리자");
            smsTasks.push(sendTrackedSms({
                eventType: "TRIAL_APPLICATION",
                eventId: trialLeadId,
                deliveryRunId,
                recipientUserId: admin.id,
                recipientPhone: phone,
                recipientRole: "ADMIN",
                trigger: "TRIAL_NEW_ADMIN",
                body: adminMessage,
            }));
        }
    }

    if (shouldSendCoach) {
        const coachMessage = await renderSmsTemplate("TRIAL_NEW_COACH", variables)
            || `[STIZ] 새 체험수업 신청\n${childName} (${childGrade})`;
        const coaches = await getTrialApplicationCoachSmsRecipients(preferredSlotKey);
        for (const coach of coaches) {
            const phone = normalizeAdminSmsPhone(coach.phone);
            if (!phone || staffPhones.has(phone)) continue;
            staffPhones.add(phone);
            targetLabels.add("담당 선생님");
            smsTasks.push(sendTrackedSms({
                eventType: "TRIAL_APPLICATION",
                eventId: trialLeadId,
                deliveryRunId,
                recipientPhone: phone,
                recipientRole: "COACH",
                trigger: "TRIAL_NEW_COACH",
                body: coachMessage,
            }));
        }
    }

    if (smsTasks.length === 0) {
        throw new Error("재발송할 연락처가 없습니다. 관리자/담당 선생님/학부모 전화번호를 확인해주세요.");
    }

    const results = await Promise.allSettled(smsTasks);
    const sent = results.filter(result => result.status === "fulfilled" && result.value.ok).length;
    const failed = results.length - sent;
    const targets = Array.from(targetLabels);

    revalidatePath("/admin/trial");
    revalidatePath("/admin/apply");
    revalidateTrialAdminCaches();

    return {
        requested: results.length,
        sent,
        failed,
        targets,
        message: failed > 0
            ? `${targets.join(", ")} 문자 재발송 결과: ${sent}건 성공, ${failed}건 실패`
            : `${targets.join(", ")} 문자 ${sent}건을 다시 보냈습니다.`,
    };
}

export async function sendTrialCoachNotice(trialLeadId: string): Promise<{ sentTo: string[] }> {
    await requireAdmin();
    await ensureTrialLeadTable();

    const leads = await prisma.$queryRawUnsafe<any[]>(
        `SELECT id, "childName", "childGrade", "childSchool", "parentName", "parentPhone",
                "scheduledDate", "scheduledClassId", "preferredSlotKey", "trialDate",
                "preferredDay", "preferredPeriod", status, memo, "hopeNote"
         FROM "TrialLead"
         WHERE id = $1
         LIMIT 1`,
        trialLeadId,
    );
    if (leads.length === 0) throw new Error("체험 리드를 찾을 수 없습니다.");

    const lead = leads[0];
    let slotKey = lead.preferredSlotKey ?? lead.preferredslotkey ?? null;
    let className = "";
    let scheduleLabel = "";

    const scheduledClassId = lead.scheduledClassId ?? lead.scheduledclassid;
    if (scheduledClassId) {
        const classRows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT name, "slotKey", "dayOfWeek", "startTime", "endTime", "instructorId"
             FROM "Class"
             WHERE id = $1
             LIMIT 1`,
            scheduledClassId,
        );
        const cls = classRows[0];
        if (cls) {
            className = cls.name ?? "";
            slotKey = cls.slotKey ?? cls.slotkey ?? slotKey;
            scheduleLabel = [cls.dayOfWeek ?? cls.dayofweek, cls.startTime ?? cls.starttime, cls.endTime ?? cls.endtime]
                .filter(Boolean)
                .join(" ");
        }
    }

    if (!slotKey) {
        throw new Error("담당 선생님을 찾을 수 있는 수업/희망 시간 정보가 없습니다.");
    }

    // 확정일을 우선하고, 희망일만 있으면 slotKey의 실제 시작시간을 서울시각으로 결합한다.
    const rawTrialDate = lead.scheduledDate ?? lead.scheduleddate ?? lead.trialDate ?? lead.trialdate;
    const selectedDate = rawTrialDate ? seoulDateInputValue(rawTrialDate) : "";
    if (!selectedDate) throw new Error("체험 날짜를 확인할 수 없습니다.");
    const canonicalSchedule = await resolveCanonicalTrialSchedule({
        selectedDate,
        slotKey,
        scheduledClassId: scheduledClassId || null,
    });
    className = canonicalSchedule.className || className;

    // 저장된 확정시각이 있으면 canonical 조회는 반·요일 관계 검증에만 사용한다.
    // 실제 문자 일시와 수업 라벨은 학부모에게 확정한 동일 시각을 표시해야 한다.
    const storedScheduledDate = lead.scheduledDate ?? lead.scheduleddate;
    const legacyDatePlaceholder = isLegacyTrialDatePlaceholder({
        scheduledDate: storedScheduledDate,
        trialDate: lead.trialDate ?? lead.trialdate,
        status: lead.status,
        scheduledClassId: scheduledClassId || null,
    });
    const hasStoredConfirmedTime = hasExplicitTrialTime(storedScheduledDate) && !legacyDatePlaceholder;
    const confirmedScheduleDate = hasStoredConfirmedTime
        ? storedScheduledDate
        : canonicalSchedule.scheduledDate;
    scheduleLabel = hasStoredConfirmedTime
        ? formatTrialScheduleLabel(canonicalSchedule.scheduleLabel, confirmedScheduleDate)
        : canonicalSchedule.scheduleLabel;

    const coachRows = await prisma.$queryRawUnsafe<{ id: string; name: string; phone: string }[]>(
        `SELECT DISTINCT c.id, c.name, c.phone
         FROM "ScheduleSlot" ss
         JOIN "Coach" c ON c.id = ss."coachId"
         WHERE ss."slotKey" = $1 AND c.phone IS NOT NULL AND c.phone != ''
         UNION
         SELECT DISTINCT c.id, c.name, c.phone
         FROM "ClassSlotOverride" o
         JOIN "Coach" c ON c.id = o."coachId"
         WHERE o."slotKey" = $1 AND c.phone IS NOT NULL AND c.phone != ''
         UNION
         SELECT DISTINCT c.id, c.name, c.phone
         FROM "CustomClassSlot" cs
         JOIN "Coach" c ON c.id = cs."coachId"
         WHERE (cs.id = $1 OR ('custom-' || cs.id) = $1)
           AND c.phone IS NOT NULL AND c.phone != ''`,
        slotKey,
    );

    if (coachRows.length === 0) {
        throw new Error("해당 시간대에 전화번호가 등록된 담당 선생님이 없습니다.");
    }

    const trialDateText = hasStoredConfirmedTime
        ? formatTrialSmsDateTime(confirmedScheduleDate)
        : canonicalSchedule.formattedDate;

    const { renderSmsTemplate } = await import("@/lib/smsTemplate");
    const renderedMessage = await renderSmsTemplate("TRIAL_COACH_NOTICE", {
        childName: lead.childName ?? lead.childname ?? "",
        childGrade: lead.childGrade ?? lead.childgrade ?? "",
        childSchool: lead.childSchool ?? lead.childschool ?? "",
        parentName: lead.parentName ?? lead.parentname ?? "",
        parentPhone: lead.parentPhone ?? lead.parentphone ?? "",
        trialDate: trialDateText,
        className,
        scheduleLabel,
        preferredSlotKey: slotKey,
        memo: lead.memo ?? lead.hopeNote ?? lead.hopenote ?? "",
    });
    if (!renderedMessage) {
        throw new Error("담당 선생님 문자 템플릿이 비활성화되어 발송하지 않았습니다.");
    }
    const message = renderedMessage;

    const sentNames: string[] = [];
    const failedMessages: string[] = [];
    const sentPhones = new Set<string>();
    for (const coach of coachRows) {
        if (!coach.phone || sentPhones.has(coach.phone)) continue;
        sentPhones.add(coach.phone);
        const result = await sendTrackedSms({
            eventType: "TRIAL_COACH_NOTICE",
            eventId: trialLeadId,
            recipientPhone: coach.phone,
            recipientRole: "COACH",
            trigger: "TRIAL_COACH_NOTICE",
            body: message,
        });
        const label = coach.name || coach.phone;
        if (result.ok) {
            sentNames.push(label);
        } else {
            failedMessages.push(`${label}(${result.to}): ${result.reason || "unknown error"}`);
        }
    }

    if (failedMessages.length > 0) {
        throw new Error(`담당쌤 알림 문자 발송에 실패했습니다.\n${failedMessages.join("\n")}`);
    }

    await prisma.$executeRawUnsafe(
        `UPDATE "TrialLead"
         SET "coachNoticeSentAt" = NOW(),
             "coachNoticeSentTo" = $1,
             "updatedAt" = NOW()
         WHERE id = $2`,
        sentNames.join(", "),
        trialLeadId,
    );

    revalidatePath("/admin/trial");
    revalidatePath("/admin/apply");
    revalidateTrialAdminCaches();

    return { sentTo: sentNames };
}

import { sendSmsDetailed } from "@/lib/sms";
import {
    claimMessageDelivery,
    finalizeMessageDelivery,
    finalizeMessageDeliveryBatch,
    reserveMessageDelivery,
    reserveMessageDeliveryBatch,
    reserveManualMessageQueue,
} from "@/lib/message-ledger";
import {
    BULK_MANUAL_MESSAGE_RECIPIENT_LIMIT,
    MANUAL_MESSAGE_RECIPIENT_LIMIT,
    normalizeUniqueManualRecipients,
    validateManualMessageRequestId,
    type ManualMessageRecipientResult,
    type ManualMessageSendResult,
} from "@/lib/manual-message-service";

export async function enqueueManualSmsBatch(
    recipients: string[],
    message: string,
    options: { requestId: string; purpose?: string; reason?: string; audienceScope?: "INTERNAL" | "EXTERNAL" },
) {
    const admin = await requireAdmin();
    if (!message.trim()) throw new Error("메시지를 입력해주세요.");
    const requestId = validateManualMessageRequestId(options?.requestId);
    if (!requestId) throw new Error("대량 발송 요청 ID가 필요합니다.");
    const normalized = normalizeUniqueManualRecipients(recipients);
    if (!normalized.recipients.length) throw new Error("올바른 휴대폰 번호를 입력해주세요.");
    if (normalized.recipients.length > BULK_MANUAL_MESSAGE_RECIPIENT_LIMIT) {
        throw new Error(`한 번에 ${BULK_MANUAL_MESSAGE_RECIPIENT_LIMIT}명 이하만 접수할 수 있습니다.`);
    }
    const body = `[STIZ] ${message.trim()}`;
    const queued = await reserveManualMessageQueue({
        requestId,
        actorUserId: admin.appUserId,
        actorName: admin.appUserName,
        purpose: options.purpose?.trim() || "관리자 대량 문자 발송",
        reason: options.reason?.trim() || "관리자 문자센터에서 승인 후 대량 접수",
        audienceScope: options.audienceScope || "EXTERNAL",
        body,
        recipients: normalized.recipients,
    });
    return {
        ...queued,
        total: normalized.recipients.length,
        duplicateCount: normalized.duplicateCount,
        invalidCount: normalized.invalidCount,
    };
}

/**
 * getCoachPhones — SMS 발송 수신자 선택 UI용 코치 전화번호 목록 조회
 */
export async function getCoachPhones(): Promise<{ id: string; name: string; role: string; phone: string }[]> {
    await requireAdmin();
    const rows = await prisma.$queryRawUnsafe<{ id: string; name: string; role: string; phone: string }[]>(
        `SELECT id, name, role, phone FROM "Coach" WHERE phone IS NOT NULL AND phone != '' ORDER BY "order" ASC`
    );
    return rows;
}

/**
 * sendManualSms — 관리자가 수동으로 SMS 발송
 *
 * @param recipients  수신 번호 배열 (하이픈 포함/미포함 모두 가능)
 * @param message     메시지 본문
 * @returns           발송 결과 { total, success, failed }
 */
export async function sendManualSms(
    recipients: string[],
    message: string,
    options?: {
        requestId?: string;
        purpose?: string;
        reason?: string;
        audienceScope?: "INTERNAL" | "EXTERNAL";
    },
): Promise<ManualMessageSendResult> {
    const admin = await requireAdmin();

    if (!recipients.length) throw new Error("수신자를 선택해주세요.");
    if (!message.trim()) throw new Error("메시지를 입력해주세요.");

    const normalized = normalizeUniqueManualRecipients(recipients);
    if (!normalized.recipients.length) throw new Error("올바른 휴대폰 번호를 입력해주세요.");
    if (normalized.recipients.length > MANUAL_MESSAGE_RECIPIENT_LIMIT) {
        throw new Error(`한 번에 ${MANUAL_MESSAGE_RECIPIENT_LIMIT}명 이하만 발송할 수 있습니다.`);
    }

    const body = `[STIZ] ${message.trim()}`;
    const purpose = options?.purpose?.trim() || "관리자 수동 문자 발송";
    const reason = options?.reason?.trim() || "관리자 문자센터에서 직접 발송";
    const audienceScope = options?.audienceScope || "INTERNAL";
    const requestId = validateManualMessageRequestId(options?.requestId);
    const requestFingerprint = createHash("sha256")
        .update(`${admin.appUserId}:${body}:${normalized.recipients.join(",")}`)
        .digest("hex")
        .slice(0, 24);
    const stableEventKey = requestId
        ? `manual:request:${requestId}:${requestFingerprint}`
        : `manual:click:${requestFingerprint}:${Math.floor(Date.now() / 30_000)}`;
    const batchId = await reserveMessageDeliveryBatch({
        source: "MANUAL",
        stableEventKey,
        audienceScope,
        trigger: "MANUAL_MESSAGE",
        actorUserId: admin.appUserId,
        actorName: admin.appUserName,
        purpose,
        reason,
        body,
        requestedChannel: "SMS",
    });
    if (!batchId) throw new Error("문자 발송 장부를 생성하지 못했습니다.");

    const results: ManualMessageRecipientResult[] = [];
    for (const recipient of normalized.recipients) {
        const reserved = await reserveMessageDelivery({
            batchId,
            source: "MANUAL",
            stableEventKey,
            eventType: "MANUAL_MESSAGE",
            trigger: "MANUAL_MESSAGE",
            audienceScope,
            recipientPhone: recipient,
            body,
            requestedChannel: "SMS",
        });
        if (!reserved.deliveryId) {
            results.push({
                recipient,
                last4: recipient.slice(-4),
                ok: false,
                status: "ALREADY_PROCESSED",
                reason: "중복 발송 요청입니다.",
            });
            continue;
        }

        const claimed = await claimMessageDelivery(reserved.deliveryId);
        if (!claimed.claimed) {
            results.push({
                recipient,
                last4: recipient.slice(-4),
                ok: false,
                status: "ALREADY_PROCESSED",
                reason: "이미 처리 중이거나 처리된 발송 요청입니다.",
            });
            continue;
        }

        const sent = await sendSmsDetailed(recipient, body);
        try {
            await finalizeMessageDelivery({
                deliveryId: reserved.deliveryId,
                ok: sent.ok,
                provider: sent.provider,
                requestedChannel: "SMS",
                actualChannel: "SMS",
                messageType: sent.messageType || "SMS",
                providerGroupId: sent.groupId,
                providerMessageId: sent.messageId,
                providerStatus: sent.ok ? "ACCEPTED" : "FAILED",
                errorCode: sent.ok ? null : sent.reason?.slice(0, 500),
            });
        } catch (ledgerError) {
            // ⚠️ 여기 도달했다는 건 **문자는 이미 공급자에게 넘어간 뒤**라는 뜻이다.
            //    장부 기록 실패를 '발송 실패'로 보고하면 원장이 다시 눌러 **중복 발송**된다
            //    (2026-08-03 실제 사고: 학부모 13명이 같은 안내를 두 번 받았다).
            //    그래서 발송 성공 여부는 공급자 응답(sent.ok)만으로 판정한다.
            console.error("[manual-sms] 장부 기록 실패(발송은 완료됨):", ledgerError);
            results.push({
                recipient,
                last4: recipient.slice(-4),
                ok: sent.ok,
                status: sent.ok ? "SENT" : "FAILED",
                uncertain: true,
                reason: sent.ok
                    ? "발송은 완료됐습니다. (발송 기록 저장만 실패 — 다시 보내지 마세요)"
                    : (sent.reason ?? "발송에 실패했습니다."),
                provider: sent.provider,
                providerMessageId: sent.messageId,
                providerGroupId: sent.groupId,
                messageType: sent.messageType,
            });
            continue;
        }
        results.push({
            recipient,
            last4: recipient.slice(-4),
            ok: sent.ok,
            status: sent.ok ? "SENT" : "FAILED",
            reason: sent.reason,
            provider: sent.provider,
            providerMessageId: sent.messageId,
            providerGroupId: sent.groupId,
            messageType: sent.messageType,
        });
    }

    try {
        await finalizeMessageDeliveryBatch(batchId);
    } catch {
        // 공급자 호출이 끝난 뒤 묶음 집계 실패로 전체 요청을 실패 처리하면 중복 발송 위험이 있습니다.
    }
    const success = results.filter((result) => result.ok).length;
    const retryRecipients = results
        .filter((result) => result.status === "FAILED")
        .map((result) => result.recipient);
    const failed = results.filter((result) => result.status === "FAILED").length;
    const uncertain = results.filter((result) => result.status === "UNCERTAIN").length;
    return {
        batchId,
        total: results.length,
        success,
        failed,
        uncertain,
        duplicateCount: normalized.duplicateCount,
        invalidCount: normalized.invalidCount,
        results,
        retryRecipients,
    };
}

// ── SMS 템플릿 관리 Server Actions ──────────────────────────────────────────

import {
    ensureSmsTemplates,
    renderTemplate,
    autoConvertKeywords as autoConvertKeywordsFn,
    SAMPLE_VARIABLES,
} from "@/lib/smsTemplate";

async function requireMessageSettingAuditInfrastructure() {
    const [availability] = await prisma.$queryRawUnsafe<Array<{ available: boolean }>>(
        `SELECT to_regclass('public."MessageSettingAuditLog"') IS NOT NULL AS available`,
    ).catch(() => [{ available: false }]);
    if (!availability.available) {
        throw new Error("문자 설정 DB 업데이트가 필요합니다.");
    }
}

/**
 * updateSmsTemplate — 템플릿 본문/활성 상태 수정
 *
 * 관리자가 카드에서 메시지를 편집하거나 ON/OFF 토글을 변경할 때 호출
 */
export async function updateSmsTemplate(
    id: string,
    data: { body?: string; isActive?: boolean },
) {
    const admin = await requireAdmin();
    await requireMessageSettingAuditInfrastructure();
    await ensureSmsTemplates();

    // 수정할 필드가 없으면 무시
    const sets: string[] = [];
    const values: any[] = [];
    let idx = 1;

    if (data.body !== undefined) {
        sets.push(`body = $${idx++}`);
        values.push(data.body);
    }
    if (data.isActive !== undefined) {
        sets.push(`"isActive" = $${idx++}`);
        values.push(data.isActive);
    }
    if (sets.length === 0) return;

    sets.push(`"updatedAt" = NOW()`);

    try {
        const [availability] = await prisma.$queryRawUnsafe<Array<{ automationAvailable: boolean }>>(
            `SELECT to_regclass('public."MessageAutomationRule"') IS NOT NULL AS "automationAvailable"`,
        ).catch(() => [{ automationAvailable: false }]);
        const updateTemplate = async (tx: typeof prisma) => {
            const [before] = await tx.$queryRawUnsafe<Array<{
                trigger: string;
                body: string;
                isActive: boolean;
                updatedAt: Date;
            }>>(
                `SELECT trigger, body, "isActive", "updatedAt"
                   FROM "SmsTemplate" WHERE id = $1 FOR UPDATE`,
                id,
            );
            if (!before) throw new Error("템플릿을 찾을 수 없습니다.");
            await tx.$executeRawUnsafe(
                `UPDATE "SmsTemplate" SET ${sets.join(", ")} WHERE id = $${idx}`,
                ...values,
                id,
            );
            if (typeof data.isActive === "boolean" && availability.automationAvailable) {
                // 자동 발송 탭과 템플릿 탭이 서로 다른 상태를 보이지 않도록 같은 거래에서 갱신한다.
                await tx.$executeRawUnsafe(
                    `UPDATE "MessageAutomationRule"
                        SET "isActive" = $1, "updatedAt" = NOW()
                      WHERE "templateId" = $2`,
                    data.isActive,
                    id,
                );
            }
            const [after] = await tx.$queryRawUnsafe<Array<{
                trigger: string;
                body: string;
                isActive: boolean;
                updatedAt: Date;
            }>>(
                `SELECT trigger, body, "isActive", "updatedAt"
                   FROM "SmsTemplate" WHERE id = $1`,
                id,
            );
            if (!after) throw new Error("템플릿 변경 결과를 확인할 수 없습니다.");
            const safeMetadata = (template: typeof before) => ({
                trigger: template.trigger,
                bodyHash: createHash("sha256").update(template.body).digest("hex"),
                isActive: template.isActive,
                updatedAt: template.updatedAt.toISOString(),
            });
            await tx.$executeRawUnsafe(
                `INSERT INTO "MessageSettingAuditLog" (
                    id, "settingType", "settingId", action, "actorUserId", "actorName",
                    "beforeJSON", "afterJSON", "createdAt"
                 ) VALUES (
                    gen_random_uuid()::text, 'TEMPLATE', $1, 'UPDATE', $2, $3,
                    $4::jsonb, $5::jsonb, NOW()
                 )`,
                id,
                admin.appUserId,
                admin.appUserName,
                JSON.stringify(safeMetadata(before)),
                JSON.stringify(safeMetadata(after)),
            );
        };
        await prisma.$transaction(async (tx) => updateTemplate(tx as typeof prisma));
    } catch (e) {
        console.error("[updateSmsTemplate] failed:", e);
        if ((e as Error).message === "문자 설정 DB 업데이트가 필요합니다.") throw e;
        throw new Error("템플릿 수정 실패");
    }

    revalidatePath("/admin/sms/templates");
    revalidateTag("admin-sms-templates", { expire: 0 });
}

/**
 * previewSmsTemplate — 미리보기: 샘플 데이터로 변수 치환한 결과 반환
 */
export async function previewSmsTemplate(body: string): Promise<string> {
    await requireAdmin();
    return renderTemplate(body, SAMPLE_VARIABLES);
}

/**
 * autoConvertSmsKeywords — 본문의 한글 키워드를 {{변수}}로 자동 치환
 */
export async function autoConvertSmsKeywords(body: string): Promise<{ converted: string; changes: string[] }> {
    await requireAdmin();
    return autoConvertKeywordsFn(body);
}

/**
 * resetSmsTemplate — 기본 템플릿으로 초기화
 */
export async function resetSmsTemplate(id: string) {
    const admin = await requireAdmin();
    await requireMessageSettingAuditInfrastructure();
    await ensureSmsTemplates();

    try {
        // 현재 템플릿의 trigger를 조회
        const rows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT trigger FROM "SmsTemplate" WHERE id = $1 LIMIT 1`,
            id,
        );
        if (rows.length === 0) throw new Error("템플릿을 찾을 수 없습니다.");

        const trigger = rows[0].trigger;

        // 기본 템플릿에서 해당 trigger의 body를 찾아 복원
        const { DEFAULT_TEMPLATES } = await import("@/lib/smsTemplate") as any;
        // smsTemplate.ts에서 DEFAULT_TEMPLATES가 export되지 않으므로 직접 매핑
        const defaultBodies: Record<string, string> = {
            TRIAL_NEW_ADMIN: "[STIZ] 새 체험수업 신청\n{{childName}} ({{childGrade}}) - {{parentName}}",
            TRIAL_NEW_COACH: "[STIZ] 새 체험수업 신청\n{{childName}} ({{childGrade}})",
            TRIAL_SCHEDULED_COACH: "[STIZ] 체험수업 일정이 확정되었습니다.\n학생: {{childName}} ({{childGrade}})\n일시: {{scheduledDate}}\n반: {{className}}",
            TRIAL_COACH_NOTICE: "[STIZ] 체험수업 알림\n학생: {{childName}} {{childGrade}} {{childSchool}}\n일정: {{trialDate}}\n수업: {{className}} {{scheduleLabel}}\n희망: {{preferredSlotKey}}\n학부모: {{parentName}} {{parentPhone}}\n메모: {{memo}}",
            ENROLL_NEW_ADMIN: "[STIZ] 새 수강 신청\n{{childName}} ({{childGrade}}) - {{parentName}}",
            ENROLL_NEW_COACH: "[STIZ] 새 수강 신청\n{{childName}} ({{childGrade}})",
            ENROLL_APPROVED_COACH: "[STIZ] 수강 신청이 승인되었습니다.\n학생: {{childName}} ({{childGrade}})\n배정 반: {{className}}",
            TRIAL_CONFIRM_PARENT: "[STIZ] {{childName}} 체험수업 신청이 접수되었습니다.\n일정 확정 시 다시 안내드리겠습니다.\n문의: {{academyPhone}}",
            TRIAL_SCHEDULED_PARENT: "[STIZ] {{childName}} 체험수업 일정이 확정되었습니다.\n일시: {{scheduledDate}}\n반: {{className}}\n문의: {{academyPhone}}",
            TRIAL_ENROLL_GUIDE_PARENT: "스티즈 수강신청서\n링크에서 작성해주세요 :)\n{{enrollLink}}",
            ENROLL_CONFIRM_PARENT: "[STIZ] {{childName}} 수강 신청이 접수되었습니다.\n승인 후 안내드리겠습니다.\n문의: {{academyPhone}}",
            ENROLL_APPROVED_PARENT: "[STIZ] {{childName}} 수강이 확정되었습니다.\n배정 반: {{className}}\n상세 안내는 별도 연락드리겠습니다.",
            INVOICE_PARENT: "[STIZ] {{month}}월 수강료 안내\n{{childName}}: {{amount}}원\n납부기한: {{dueDate}}",
            UNPAID_PARENT: "[STIZ] 미납 수납 안내\n{{childName}}: {{unpaidCount}}건 ({{totalAmount}}원)\n확인 부탁드립니다.",
        };

        const defaultBody = defaultBodies[trigger];
        if (!defaultBody) throw new Error("기본 템플릿을 찾을 수 없습니다.");

        const [availability] = await prisma.$queryRawUnsafe<Array<{ automationAvailable: boolean }>>(
            `SELECT to_regclass('public."MessageAutomationRule"') IS NOT NULL AS "automationAvailable"`,
        ).catch(() => [{ automationAvailable: false }]);
        const resetTemplate = async (tx: typeof prisma) => {
            const [before] = await tx.$queryRawUnsafe<Array<{
                trigger: string;
                body: string;
                isActive: boolean;
                updatedAt: Date;
            }>>(
                `SELECT trigger, body, "isActive", "updatedAt"
                   FROM "SmsTemplate" WHERE id = $1 FOR UPDATE`,
                id,
            );
            if (!before) throw new Error("템플릿을 찾을 수 없습니다.");
            await tx.$executeRawUnsafe(
                `UPDATE "SmsTemplate" SET body = $1, "isActive" = true, "updatedAt" = NOW() WHERE id = $2`,
                defaultBody,
                id,
            );
            if (availability.automationAvailable) {
                await tx.$executeRawUnsafe(
                    `UPDATE "MessageAutomationRule"
                        SET "isActive" = true, "updatedAt" = NOW()
                      WHERE "templateId" = $1`,
                    id,
                );
            }
            const [after] = await tx.$queryRawUnsafe<Array<{
                trigger: string;
                body: string;
                isActive: boolean;
                updatedAt: Date;
            }>>(
                `SELECT trigger, body, "isActive", "updatedAt"
                   FROM "SmsTemplate" WHERE id = $1`,
                id,
            );
            if (!after) throw new Error("템플릿 초기화 결과를 확인할 수 없습니다.");
            const safeMetadata = (template: typeof before) => ({
                trigger: template.trigger,
                bodyHash: createHash("sha256").update(template.body).digest("hex"),
                isActive: template.isActive,
                updatedAt: template.updatedAt.toISOString(),
            });
            await tx.$executeRawUnsafe(
                `INSERT INTO "MessageSettingAuditLog" (
                    id, "settingType", "settingId", action, "actorUserId", "actorName",
                    reason, "beforeJSON", "afterJSON", "createdAt"
                 ) VALUES (
                    gen_random_uuid()::text, 'TEMPLATE', $1, 'RESET', $2, $3,
                    'RESET_TO_DEFAULT', $4::jsonb, $5::jsonb, NOW()
                 )`,
                id,
                admin.appUserId,
                admin.appUserName,
                JSON.stringify(safeMetadata(before)),
                JSON.stringify(safeMetadata(after)),
            );
        };
        await prisma.$transaction(async (tx) => resetTemplate(tx as typeof prisma));
    } catch (e) {
        console.error("[resetSmsTemplate] failed:", e);
        throw new Error((e as Error).message || "템플릿 초기화 실패");
    }

    revalidatePath("/admin/sms/templates");
    revalidateTag("admin-sms-templates", { expire: 0 });
}

// ══════════════════════════════════════════════════════════════════════
// 스태프 관리 — ADMIN(원장)만 사용 가능한 권한 관리 기능
// ══════════════════════════════════════════════════════════════════════

// ── DDL: Staff 역할 enum + Coach.userId 컬럼 추가 ──────────────
// Prisma migrate 없이도 안전하게 동작하도록 DDL ensure 패턴 사용
// ALTER TYPE ... ADD VALUE는 트랜잭션 내에서 실행 불가 → IF NOT EXISTS 사용
let _staffColumnsEnsured = false;
export async function ensureStaffColumns() {
    if (_staffColumnsEnsured) return;
    try {
        // 1) Staff Role enum 값 추가 (이미 있으면 무시)
        for (const role of ["VICE_ADMIN", "DRIVER"] as const) {
            await prisma.$executeRawUnsafe(
                `DO $$ BEGIN
                   IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = '${role}'
                     AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'Role'))
                   THEN
                     ALTER TYPE "Role" ADD VALUE '${role}';
                   END IF;
                 END $$`
            );
        }
        // 2) Coach 테이블에 userId 컬럼 추가 (이미 있으면 무시)
        await prisma.$executeRawUnsafe(
            `ALTER TABLE "Coach" ADD COLUMN IF NOT EXISTS "userId" TEXT UNIQUE`
        );
        _staffColumnsEnsured = true;
    } catch (e) {
        console.error("[ensureStaffColumns] DDL failed:", e);
    }
}

/**
 * createStaffUser — 신규 스태프 생성 (requireOwner: ADMIN만)
 *
 * 전화번호 기반 인증 후 호출된다.
 * - phone 필수, email은 자동 생성 (phone@staff.local)
 * - Supabase Auth 계정 없이 User 테이블에만 레코드 생성
 */
export async function createStaffUser(data: {
    name: string;
    phone: string; // 필수 — 인증 완료된 전화번호
    role: "ADMIN" | "VICE_ADMIN" | "INSTRUCTOR" | "DRIVER";
    verificationProof: string;
}) {
    const owner = await requireOwner();
    await ensureStaffColumns();

    // 전화번호에서 하이픈 제거 후 이메일 자동 생성
    const cleanPhone = data.phone.replace(/\D/g, "");
    const autoEmail = `${cleanPhone}@staff.local`;

    try {
        const verificationSecret =
            process.env.STAFF_PHONE_VERIFICATION_SECRET?.trim()
            || process.env.SOLAPI_API_SECRET?.trim();
        if (!verificationSecret || !data.verificationProof) {
            throw new Error("전화번호 인증 정보가 없습니다. 다시 인증해 주세요.");
        }
        const phoneHash = createHmac("sha256", verificationSecret)
            .update(`phone:${cleanPhone}`)
            .digest("hex");
        const suppliedProofHash = createHmac("sha256", verificationSecret)
            .update(`proof:${data.verificationProof}`)
            .digest("hex");

        await prisma.$transaction(async (tx) => {
            // 인증 확인·증표 소비·직원 생성을 한 거래로 묶어 재사용을 막는다.
            await tx.$executeRawUnsafe(
                `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
                `staff-phone-number:${phoneHash}`,
            );
            const [verification] = await tx.$queryRawUnsafe<Array<{
                id: string;
                proofHash: string | null;
            }>>(
                `SELECT id, "proofHash"
                   FROM "StaffPhoneVerification"
                  WHERE "ownerId" = $1 AND "phoneHash" = $2
                    AND status = 'VERIFIED'
                    AND "proofExpiresAt" > NOW()
                    AND "consumedAt" IS NULL
                  FOR UPDATE`,
                owner.id,
                phoneHash,
            );
            const expected = Buffer.from(verification?.proofHash || "", "hex");
            const supplied = Buffer.from(suppliedProofHash, "hex");
            if (
                !verification ||
                expected.length !== supplied.length ||
                !timingSafeEqual(expected, supplied)
            ) {
                throw new Error("전화번호 인증이 만료되었거나 이미 사용되었습니다. 다시 인증해 주세요.");
            }

            const existing = await tx.$queryRawUnsafe<Array<{ id: string }>>(
                `SELECT id FROM "User" WHERE phone = $1 OR email = $2 LIMIT 1 FOR UPDATE`,
                cleanPhone,
                autoEmail,
            );
            if (existing.length > 0) throw new Error("이미 등록된 전화번호입니다.");

            const createdRows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
                `INSERT INTO "User" (id, email, name, phone, role, "createdAt", "updatedAt")
                 VALUES (gen_random_uuid(), $1, $2, $3, $4::"Role", NOW(), NOW())
                 RETURNING id`,
                autoEmail,
                data.name,
                cleanPhone,
                data.role,
            );
            const createdUserId = createdRows[0]?.id;
            if (createdUserId) {
                await linkMatchingCoachProfileToUser(tx, {
                    userId: createdUserId,
                    name: data.name,
                    phone: cleanPhone,
                    role: data.role,
                });
            }
            await tx.$executeRawUnsafe(
                `UPDATE "StaffPhoneVerification"
                    SET status = 'CONSUMED', "consumedAt" = NOW(),
                        "proofHash" = NULL, "updatedAt" = NOW()
                  WHERE id = $1`,
                verification.id,
            );
        });
    } catch (e) {
        console.error("[createStaffUser] failed:", e);
        throw new Error((e as Error).message || "스태프 생성 실패");
    }

    revalidateStaffAdminCaches();
    revalidatePath("/admin/staff");
}

/**
 * updateUserRole — 사용자 역할 변경 (requireOwner: ADMIN만)
 * ADMIN은 다른 사용자의 역할을 변경할 수 있지만, 자기 자신을 변경할 수 없음
 */
export async function updateUserRole(userId: string, newRole: "ADMIN" | "VICE_ADMIN" | "INSTRUCTOR" | "DRIVER" | "PARENT") {
    const user = await requireOwner();
    await ensureStaffColumns();

    try {
        // 자기 자신의 역할 변경 방지 (실수로 ADMIN 권한을 잃는 것 방지)
        const targetRows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT email FROM "User" WHERE id = $1 LIMIT 1`,
            userId,
        );
        if (targetRows.length > 0 && targetRows[0].email === user.email) {
            throw new Error("자기 자신의 역할은 변경할 수 없습니다.");
        }

        await prisma.$executeRawUnsafe(
            `UPDATE "User" SET role = $1::"Role", "updatedAt" = NOW() WHERE id = $2`,
            newRole,
            userId,
        );
    } catch (e) {
        console.error("[updateUserRole] failed:", e);
        throw new Error((e as Error).message || "역할 변경 실패");
    }

    revalidateStaffAdminCaches();
    revalidatePath("/admin/staff");
}

/**
 * linkCoachToUser — Coach와 User(INSTRUCTOR) 연결/해제 (requireOwner: ADMIN만)
 * coachId가 null이면 기존 연결 해제, 값이 있으면 연결
 */
export async function linkCoachToUser(userId: string, coachId: string | null) {
    await requireOwner();
    await ensureStaffColumns();

    try {
        if (coachId) {
            // 해당 코치가 이미 다른 유저에게 연결되어 있는지 확인
            const linked = await prisma.$queryRawUnsafe<any[]>(
                `SELECT "userId" FROM "Coach" WHERE id = $1 AND "userId" IS NOT NULL AND "userId" != $2 LIMIT 1`,
                coachId,
                userId,
            );
            if (linked.length > 0) {
                throw new Error("이 코치는 이미 다른 사용자에게 연결되어 있습니다.");
            }

            // 기존에 이 유저에게 연결된 코치가 있으면 해제
            await prisma.$executeRawUnsafe(
                `UPDATE "Coach" SET "userId" = NULL, "updatedAt" = NOW() WHERE "userId" = $1`,
                userId,
            );

            // 새 코치 연결
            await prisma.$executeRawUnsafe(
                `UPDATE "Coach" SET "userId" = $1, "updatedAt" = NOW() WHERE id = $2`,
                userId,
                coachId,
            );
        } else {
            // 연결 해제
            await prisma.$executeRawUnsafe(
                `UPDATE "Coach" SET "userId" = NULL, "updatedAt" = NOW() WHERE "userId" = $1`,
                userId,
            );
        }
    } catch (e) {
        console.error("[linkCoachToUser] failed:", e);
        throw new Error((e as Error).message || "코치 연결 실패");
    }

    revalidateStaffAdminCaches();
    revalidatePath("/admin/staff");
}

// ══════════════════════════════════════════════════════════════════════
// 스태프 초대 링크 시스템 — ADMIN(원장)만 초대 생성/취소/재발송 가능
// ══════════════════════════════════════════════════════════════════════

// ── DDL: StaffInvitation 테이블 자동 생성 (Prisma migrate 없이도 동작) ────────
let _invitationTableEnsured = false;
export async function ensureStaffInvitationTable() {
    if (_invitationTableEnsured) return;
    try {
        // StaffInvitation 테이블이 없으면 생성 (IF NOT EXISTS로 안전)
        await prisma.$executeRawUnsafe(`
            CREATE TABLE IF NOT EXISTS "StaffInvitation" (
                id         TEXT PRIMARY KEY DEFAULT (gen_random_uuid())::text,
                token      TEXT UNIQUE NOT NULL DEFAULT (gen_random_uuid())::text,
                name       TEXT NOT NULL,
                phone      TEXT NOT NULL,
                role       "Role" NOT NULL DEFAULT 'INSTRUCTOR',
                status     TEXT NOT NULL DEFAULT 'PENDING',
                "expiresAt"     TIMESTAMPTZ NOT NULL,
                "acceptedAt"    TIMESTAMPTZ,
                "acceptedUserId" TEXT,
                "createdBy"     TEXT NOT NULL,
                "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                "updatedAt"     TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);
        // 인덱스 생성 (IF NOT EXISTS로 안전)
        await prisma.$executeRawUnsafe(
            `CREATE INDEX IF NOT EXISTS "StaffInvitation_status_idx" ON "StaffInvitation" (status)`
        );
        await prisma.$executeRawUnsafe(
            `CREATE INDEX IF NOT EXISTS "StaffInvitation_phone_idx" ON "StaffInvitation" (phone)`
        );
        _invitationTableEnsured = true;
    } catch (e) {
        console.error("[ensureStaffInvitationTable] DDL failed:", e);
    }
}

function getStaffInvitationBaseUrl() {
    const configuredUrl =
        process.env.NEXT_PUBLIC_SITE_URL?.trim()
        || process.env.NEXT_PUBLIC_BASE_URL?.trim()
        || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "");

    if (!configuredUrl) return null;

    try {
        const parsedUrl = new URL(configuredUrl);
        const isLocalHost = parsedUrl.hostname === "localhost" || parsedUrl.hostname === "127.0.0.1";
        if (parsedUrl.protocol !== "https:" || isLocalHost) return null;
        return parsedUrl.origin;
    } catch {
        return null;
    }
}

function getStaffInvitationUrl(token: string) {
    const invitePath = `/invite/${encodeURIComponent(token)}`;
    const baseUrl = getStaffInvitationBaseUrl();
    return baseUrl ? `${baseUrl}${invitePath}` : invitePath;
}

const SMS_SITE_URL_MISSING = "운영 사이트 주소가 설정되지 않아 문자를 보내지 않았습니다.";
const SMS_SEND_FAILED = "문자 발송에 실패했습니다. 가입 링크를 직접 전달해 주세요.";

/**
 * inviteStaff — 스태프 초대 링크 생성 (requireOwner: ADMIN만)
 * 이름 + 전화번호 + 역할을 받아서 7일 유효한 초대를 생성
 * 생성 후 SMS로 초대 링크를 발송한다
 */
export async function inviteStaff(data: {
    name: string;
    phone: string;
    role: "INSTRUCTOR" | "DRIVER";
}) {
    const user = await requireOwner();
    await ensureStaffInvitationTable();

    if (data.role !== "INSTRUCTOR" && data.role !== "DRIVER") {
        throw new Error("초대는 선생님 또는 기사 역할만 선택할 수 있습니다.");
    }
    const staffRole = data.role;
    const staffRoleLabel = staffRole === "DRIVER" ? "셔틀 기사" : "코치/강사";

    const cleanName = data.name.trim();
    const cleanPhone = data.phone.replace(/\D/g, "");
    if (!cleanName) {
        throw new Error("이름을 입력해 주세요.");
    }
    if (!/^010\d{8}$/.test(cleanPhone)) {
        throw new Error("휴대전화 번호는 010으로 시작하는 11자리 숫자로 입력해 주세요.");
    }

    // 같은 번호로 PENDING 상태인 초대가 이미 있는지 확인
    const existing = await prisma.$queryRawUnsafe<any[]>(
        `SELECT id FROM "StaffInvitation"
         WHERE phone = $1 AND status = 'PENDING' AND "expiresAt" > NOW()
         LIMIT 1`,
        cleanPhone,
    );
    if (existing.length > 0) {
        throw new Error("이미 대기 중인 초대가 있습니다. 기존 초대를 취소 후 다시 시도해주세요.");
    }

    // 이미 가입된 스태프인지 확인
    const existingUser = await prisma.$queryRawUnsafe<any[]>(
        `SELECT id FROM "User" WHERE phone = $1 AND role IN ('ADMIN','VICE_ADMIN','INSTRUCTOR','DRIVER') LIMIT 1`,
        cleanPhone,
    );
    if (existingUser.length > 0) {
        throw new Error("이미 등록된 스태프입니다.");
    }

    try {
        // 초대 레코드 생성 — 만료: 7일 후
        const rows = await prisma.$queryRawUnsafe<any[]>(
            `INSERT INTO "StaffInvitation" (id, token, name, phone, role, status, "expiresAt", "createdBy", "createdAt", "updatedAt")
             VALUES (
               (gen_random_uuid())::text,
               (gen_random_uuid())::text,
               $1, $2, $3::"Role", 'PENDING',
               NOW() + INTERVAL '7 days',
               $4, NOW(), NOW()
             )
             RETURNING id, token`,
            cleanName,
            cleanPhone,
            staffRole,
            user.id,
        );

        const invitationId = rows[0]?.id;
        const token = rows[0]?.token;
        if (!invitationId || !token) throw new Error("초대 생성 실패");

        // 문자 발송이 실패해도 생성된 초대와 복사용 링크는 그대로 유지한다.
        const inviteUrl = getStaffInvitationUrl(token);
        const baseUrl = getStaffInvitationBaseUrl();
        const smsResult = baseUrl
            ? await sendFailClosedTrackedSms({
                eventType: "STAFF_INVITATION",
                eventId: invitationId,
                recipientPhone: cleanPhone,
                recipientRole: "ADMIN",
                trigger: "SECURITY_STAFF_INVITATION",
                source: "SECURITY",
                body: `[STIZ 농구교실] ${cleanName}님, ${staffRoleLabel} 초대가 도착했습니다.\n아래 링크에서 가입을 완료해주세요:\n${inviteUrl}`,
            })
            : { ok: false, reason: SMS_SITE_URL_MISSING };

        if (baseUrl && !smsResult.ok) {
            console.error(
                "[inviteStaff SMS] failed:",
                "reason" in smsResult ? smsResult.reason : smsResult.errorCode,
            );
        }

        revalidateStaffAdminCaches();
        revalidatePath("/admin/staff");
        return {
            token,
            inviteUrl,
            smsSent: smsResult.ok,
            smsError: smsResult.ok
                ? undefined
                : baseUrl ? SMS_SEND_FAILED : SMS_SITE_URL_MISSING,
        };
    } catch (e) {
        console.error("[inviteStaff] failed:", e);
        throw new Error((e as Error).message || "초대 생성 실패");
    }
}

/**
 * cancelInvitation — 초대 취소 (requireOwner: ADMIN만)
 * PENDING 상태인 초대만 취소 가능
 */
export async function cancelInvitation(invitationId: string) {
    await requireOwner();
    await ensureStaffInvitationTable();

    try {
        const result = await prisma.$executeRawUnsafe(
            `UPDATE "StaffInvitation"
             SET status = 'CANCELLED', "updatedAt" = NOW()
             WHERE id = $1 AND status = 'PENDING'`,
            invitationId,
        );
        if (result === 0) {
            throw new Error("취소할 수 있는 초대가 없습니다.");
        }
    } catch (e) {
        console.error("[cancelInvitation] failed:", e);
        throw new Error((e as Error).message || "초대 취소 실패");
    }

    revalidateStaffAdminCaches();
    revalidatePath("/admin/staff");
}

/**
 * resendInvitation — 초대 SMS 재발송 (requireOwner: ADMIN만)
 * PENDING + 만료 전인 초대만 재발송 가능. 만료된 경우 만료일을 7일 연장한다.
 */
export async function resendInvitation(invitationId: string) {
    await requireOwner();
    await ensureStaffInvitationTable();

    try {
        // 초대 정보 조회
        const rows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT token, name, phone, "expiresAt"
             FROM "StaffInvitation"
             WHERE id = $1 AND status = 'PENDING'
             LIMIT 1`,
            invitationId,
        );
        if (rows.length === 0) {
            throw new Error("재발송할 수 있는 초대가 없습니다.");
        }

        const inv = rows[0];
        const cleanPhone = String(inv.phone ?? "").replace(/\D/g, "");
        if (!/^010\d{8}$/.test(cleanPhone)) {
            throw new Error("저장된 휴대전화 번호가 올바르지 않아 문자를 보낼 수 없습니다.");
        }
        const expiresAt = new Date(inv.expiresAt ?? inv.expiresat);

        // 만료되었으면 7일 연장
        if (expiresAt < new Date()) {
            await prisma.$executeRawUnsafe(
                `UPDATE "StaffInvitation"
                 SET "expiresAt" = NOW() + INTERVAL '7 days', "updatedAt" = NOW()
                 WHERE id = $1`,
                invitationId,
            );
        }

        // 문자 재발송 실패와 초대 링크의 유효성을 분리한다.
        const inviteUrl = getStaffInvitationUrl(inv.token);
        const baseUrl = getStaffInvitationBaseUrl();
        const smsResult = baseUrl
            ? await sendFailClosedTrackedSms({
                eventType: "STAFF_INVITATION",
                eventId: invitationId,
                deliveryRunId: `manual-resend:${Math.floor(Date.now() / 30_000)}`,
                recipientPhone: cleanPhone,
                recipientRole: "ADMIN",
                trigger: "SECURITY_STAFF_INVITATION",
                source: "SECURITY",
                body: `[STIZ 농구교실] ${inv.name}님, 스태프 초대 링크를 재발송합니다.\n아래 링크에서 가입을 완료해주세요:\n${inviteUrl}`,
            })
            : { ok: false, reason: SMS_SITE_URL_MISSING };

        if (baseUrl && !smsResult.ok) {
            console.error(
                "[resendInvitation SMS] failed:",
                "reason" in smsResult ? smsResult.reason : smsResult.errorCode,
            );
        }

        revalidateStaffAdminCaches();
        revalidatePath("/admin/staff");
        return {
            ok: smsResult.ok,
            inviteUrl,
            smsSent: smsResult.ok,
            smsError: smsResult.ok
                ? undefined
                : baseUrl ? SMS_SEND_FAILED : SMS_SITE_URL_MISSING,
        };
    } catch (e) {
        console.error("[resendInvitation] failed:", e);
        throw new Error((e as Error).message || "초대 재발송 실패");
    }
}
