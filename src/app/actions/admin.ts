"use server";

import { commencementYmd, requireCommencement } from "@/lib/enrollment/commencement";
import { sendEnrollGuideIfEnabled } from "@/lib/trial-fee/guideSender";
import { childAccessWhere } from "@/lib/account/child-access";

import { createHash } from "crypto";
import { revalidatePath, revalidateTag } from "next/cache";
import { prisma } from "@/lib/prisma";
import { assertRegularMakeupAllowed, assertMakeupSessionAllowed, CompensationConflict, lockCompensation } from "@/lib/billing/absence-compensation-guard";
import { isKstYmd, todayKst } from "@/lib/datetime/kst";
import { normalizeApprovalClassIds } from "@/lib/enrollment/approval-classes";
// 정원 경고·셔틀 위치 저장 = 신청서 승인과 새 «원생 등록»이 같이 쓰는 한 곳
import { findOverCapacityClasses } from "@/lib/enrollment/class-capacity";
import { upsertStudentShuttleLocation } from "@/lib/students/student-shuttle-location-upsert";
import { UNIFORM_STATUS_VALUES } from "@/lib/students/student-register-rules";
import { approvalAuthFetch, isActiveApprovalAuthUser, listApprovalParentCandidates, ParentSelectionRequired, reopenEnrollmentForReview, resolveApprovalParent } from "@/lib/enrollment/approval-parent";
import { createAdminClient } from "@/lib/supabase/admin";
import { isUsablePhoneKey, parentPhoneDigits } from "@/lib/enrollment/parentIdentity";
import {
    canAdminEditParentAccount,
    insertPrimaryGuardian,
    linkParentAccountForNewStudent,
    ParentAccountLinkError,
    validatePrimaryGuardian,
    type ParentLinkDb,
    type PrimaryGuardian,
} from "@/lib/students/parentAccountLink";
import { autoLinkApplicationsForTrialLead, getTrialLinkSuggestions, linkTrialLeadToApplication } from "@/lib/enrollment/trialLeadLinkService";
import type { TrialLinkSuggestion } from "@/lib/enrollment/trialLeadMatch";
import { forgetAppUserRoleCache, requireAdmin, requireOwner, requireVerifiedParent } from "@/lib/auth-guard";
// 하루 새 문의 상한(문의 규칙 한 곳)
import { INQUIRY_DAILY_NEW_MAX } from "@/lib/requests/inquiryThreadRules";
import { maskPaymentAmount } from "@/lib/auth/moneyAccess";
import {
    RETIRED_LOGIN_BAN_DURATION,
    decideRetiredReinvite,
    isConvertibleStaffRole,
    isLoginLinkRole,
    shouldBlockLoginOnRetire,
    staffAuthId,
    staffLoginKind,
} from "@/lib/staff/staffAccountLink";
import { maskedPhoneLast4 } from "@/lib/staff/staffRoster";
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
import { renderSmsTemplate, UNPAID_PARENT_DEFAULT_BODY } from "@/lib/smsTemplate";
import {
    PARENT_MESSAGE_PREFIX,
    manualMessagePrefix,
    isParentAlimtalkTrigger,
    parentAlimtalkSmsTemplateBody,
    BILLING_ALIMTALK_TEMPLATES,
} from "@/lib/messaging/parent-alimtalk-templates";
import { alimtalkTemplateIdForEnv } from "@/lib/messaging/alimtalk-config";
// 청구서 안내·미납 안내 발송 대기열(2026-11-13) — 순수 규칙 + DB 인자 연결부
import {
    BILLING_NOTICE_TRIGGER,
    UNPAID_REMINDER_INTERVAL_DAYS,
    applyBillingNoticeResults,
    checkBillingSendRule,
    describeReservation,
    loadBillingNoticeProgress,
    planInvoiceNotices,
    planUnpaidNotices,
    reserveBillingNotices,
    unpaidBlockingNoticeSql,
    type InvoiceNoticeRow,
    type NoticeTx,
    type ReserveQueueFn,
    type UnpaidNoticeRow,
} from "@/lib/billing/noticeQueue";
import {
    ensureInvoiceForPayment,
    ensureInvoicesForMonth,
    ensurePaymentInfrastructure,
    markOverduePayments,
    recordPaymentAudit,
    syncInvoiceStatusesForMonth,
} from "@/lib/payment-ledger";
// 관리자 «납부 처리»(계좌이체 기록) 규칙 — 화면과 같은 판정을 쓴다(2026-11-08)
import {
    BANK_TRANSFER_AUDIT_ACTION,
    BANK_TRANSFER_METHOD,
    bankTransferResultMessage,
    splitRecordableTargets,
    validateBankTransferInput,
    type SkipReason,
} from "@/lib/payments/bankTransferRecord";
import { monthlyBillingDueDate } from "@/lib/billing-due-date";
// 학생 상세 «청구/수납» 발행·수정 규칙(청구 월·중복·수정 가능 여부·작업대 차단) — 화면과 같은 순수 판정
import {
    DONE_TRANSACTION_BLOCK_MESSAGE,
    findDuplicateCharges,
    isBillingWorkbenchWritesEnabled,
    isFinanceOwnerRole,
    normalizeBillingDescription,
    manualChargeBlockedByWorkbench,
    normalizeDueYmd,
    POS_LOCKING_REQUEST_STATUSES,
    resolveBillingPeriod,
    statusAfterDueDateEdit,
    unpaidEditBlockReason,
    validateUnpaidEdit,
} from "@/lib/payments/studentBillingRules";
// 학부모 결제(단건·묶음)와 같은 청구 잠금 — 수정 중 옛 금액 주문이 생기지 않게(검수 지적 2026-11-09)
import { findParentCheckoutActivePaymentIds, lockPaymentsForCheckout, txCoversPaymentSql } from "@/lib/payments/bundleLedger";
// 납부완료(PAID) 청구의 상태 변경·영구 삭제 규칙 — 실제 결제는 잠금, 수기는 «대기로 되돌리기»만(화면과 같은 함수 · 2026-11-10)
import { judgePaymentStatusChange, paymentDeleteBlockReason, type PaymentStatusDecision } from "@/lib/payments/paidStatusGuard";
import { isMonthlyInvoiceNotificationEligible } from "@/lib/billing/notification-policy";
// 비회원 결제 링크(2026-11-14) — 가입하지 않은 학부모의 청구 안내 링크를 /pay/<토큰> 으로
import { issueGuestPayPathsForNotices } from "@/lib/payments/guestPayLinkService";
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
import { normalizedTrialPreferencePatch } from "@/lib/trial-schedule-display";
import { confirmTrialFeeWithAudit, type TrialFeeConfirmationResult } from "@/lib/trial-fee-confirmation";
import { recordApplicationContactAtomically } from "@/lib/application-contact-transaction";
import { sessionDateForKorea } from "@/lib/seasonal/session-bridge";
import { absencePlanMessage, applyAttendanceAbsenceReasonInTx } from "@/lib/regular/attendance-absence-reason";
import { syncCreditForRegularSession, syncCreditForSeasonalSeat } from "@/lib/makeup/credit-service";
import { findOrCreateRegularSession, resolveSessionLogTarget } from "@/lib/regular/regularSession";
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
    // 주 보호자 관계(엄마·아빠 등) — Guardian.relation 으로 저장. 이메일은 받지 않는다(매칭에 쓰지 않음)
    parentRelation?: string | null;
    // 새 필드: 엑셀 업로드 일괄 등록에서도 사용
    phone?: string | null;       // 학생 휴대폰번호
    school?: string | null;      // 학교명
    grade?: string | null;       // 학년
    address?: string | null;     // 주소
    enrollDate?: string | null;  // 입회일자
    memo?: string | null;        // 메모
}): Promise<AdminStudentCreateResult> {
    await requireAdmin();
    const name = String(data.name ?? "").trim();
    if (!name || !data.birthDate) return { ok: false, error: "학생 이름과 생년월일을 입력해 주세요." };
    // 주 보호자(관계·이름·휴대폰) 필수 — 휴대폰이 학부모 계정을 찾는 열쇠다
    const guardian = validatePrimaryGuardian({ relation: data.parentRelation, name: data.parentName, phone: data.parentPhone });
    if (!guardian.ok) return { ok: false, error: guardian.error };

    let result: AdminStudentCreateResult;
    try {
        // 계정 확정·학생·주 보호자를 한 트랜잭션으로 — 중간에 실패하면 빈 계정도 남지 않는다
        const created = await prisma.$transaction(
            (tx) => insertAdminStudentWithGuardian(tx, { ...data, name }, guardian.value),
            { timeout: 15_000 },
        );
        result = { ok: true, ...created };
    } catch (e) {
        if (e instanceof ParentAccountLinkError) return { ok: false, error: e.message };
        console.error("Failed to create student:", e);
        throw new Error("원생 등록 실패");
    }
    revalidatePath("/admin/students");
    revalidatePath("/admin");
    revalidateStudentAdminCaches();
    return result;
}

/** 관리자 직접 등록(목록 «원생 등록»·체험 «정규 전환»)의 결과. 안내가 필요한 실패는 throw 대신 ok:false 로 돌려준다
 *  (운영 빌드는 서버 액션이 던진 오류 문구를 화면에 그대로 보내지 않는다). */
export type AdminStudentCreateResult =
    | { ok: true; studentId: string; parentAccountCreated: boolean; staffAccount: boolean }
    | { ok: false; error: string };

/**
 * [트랜잭션 안에서] 학부모 계정 확정 → Student INSERT → 주 보호자 Guardian INSERT.
 * 계정 연결 규칙은 parentAccountLink 한 곳에 있다(이메일 매칭·기존 계정 덮어쓰기 없음).
 */
async function insertAdminStudentWithGuardian(
    tx: ParentLinkDb,
    student: {
        name: string; birthDate: string; gender?: string | null;
        phone?: string | null; school?: string | null; grade?: string | null;
        address?: string | null; enrollDate?: string | null; memo?: string | null;
    },
    guardian: PrimaryGuardian,
) {
    const link = await linkParentAccountForNewStudent(tx, guardian);
    const rows = await tx.$queryRawUnsafe<{ id: string }[]>(
        `INSERT INTO "Student" (id, name, "birthDate", gender, "parentId", phone, school, grade, address, "enrollDate", memo, "createdAt", "updatedAt")
         VALUES (gen_random_uuid()::text, $1, $2::timestamp, $3, $4, $5, $6, $7, $8, $9::timestamp, $10, NOW(), NOW())
         RETURNING id`,
        student.name,
        student.birthDate,
        student.gender || null,
        link.parentId,
        student.phone || null,
        student.school || null,
        student.grade || null,
        student.address || null,
        student.enrollDate || null,
        student.memo || null,
    );
    const studentId = rows[0].id;
    // 입력한 보호자 정보는 계정이 아니라 Guardian(주 보호자)에 남긴다 — 알림·본인인증 자녀 연결이 이 기록을 쓴다
    await insertPrimaryGuardian(tx, studentId, guardian);
    return { studentId, parentAccountCreated: link.created, staffAccount: link.staffAccount };
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

export async function updateStudentUniform(id: string, data: {
    status: string | null;
    appliedAt?: string | null;
    orderedAt?: string | null;
    receivedAt?: string | null;
    source?: string | null;
    note?: string | null;
}) {
    await requireAdmin();
    // 허용값은 새 «원생 등록» 창과 같은 목록 한 곳(student-register-rules)
    const allowed = new Set<string>(UNIFORM_STATUS_VALUES);
    if (data.status && !allowed.has(data.status)) throw new Error("유니폼 상태값이 올바르지 않습니다.");
    try {
        await prisma.$executeRawUnsafe(
            `UPDATE "Student" SET "uniformStatus" = $1,
                    "uniformAppliedAt" = $2::timestamptz,
                    "uniformOrderedAt" = $3::timestamptz,
                    "uniformReceivedAt" = $4::timestamptz,
                    "uniformSource" = $5, "uniformNote" = $6, "updatedAt" = NOW()
             WHERE id = $7`,
            data.status || null, data.appliedAt || null, data.orderedAt || null,
            data.receivedAt || null, data.source || null, data.note || null, id,
        );
    } catch (e) {
        console.error("Failed to update student uniform:", e);
        throw new Error("유니폼 정보 저장 실패");
    }
    revalidatePath(`/admin/students/${id}`);
    revalidatePath("/admin/students");
    // 2026-11-13: 유니폼 보유율이 대시보드 카드·통계 «유니폼» 탭에 나온다 → 저장 즉시 두 화면도 새로
    revalidateTag("admin-stats", { expire: 0 });
    revalidatePath("/admin/stats");
    revalidatePath("/admin");
}

export async function updateStudent(id: string, data: {
    name: string;
    birthDate: string;
    gender?: string | null;
    parentName: string;
    parentPhone?: string | null;
    // 학부모 이메일 — 예전 화면 호환용으로 받기만 하고 저장하지 않는다(로그인 이메일은 학부모가 가입 때 정한다)
    parentEmail?: string | null;
    // 새 필드: 학생 추가 정보
    phone?: string | null;
    school?: string | null;
    grade?: string | null;
    address?: string | null;
    enrollDate?: string | null;
}): Promise<{ parentAccountUpdated: boolean; parentPhoneConflict: boolean }> {
    await requireAdmin();
    let parentAccountUpdated = false;
    // 빈 계정 번호를 다른 계정과 같은 번호로 바꾸려다 번호를 유지했는지(화면 안내용)
    let parentPhoneConflict = false;
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
        // 학부모 계정(User)은 학원이 만든 «빈 계정»(PARENT·로그인 미연결·합성 이메일)일 때만 이름·번호를 고친다.
        // 예전엔 이름·번호·이메일을 무조건 덮어써서 ① 이메일을 안 넘기는 목록 «수정»이 email=NULL(NOT NULL 위반)로 늘 실패했고
        // ② 학생이 직원 계정에 붙어 있으면 직원 계정 정보가 바뀌었다. 이메일은 어떤 경우에도 고치지 않는다.
        const parentRows = await prisma.$queryRawUnsafe<{ id: string; role: string; authUserId: string | null; email: string | null }[]>(
            `SELECT u.id, u.role::text AS role, u."authUserId", u.email
               FROM "Student" s JOIN "User" u ON u.id = s."parentId"
              WHERE s.id = $1`,
            id,
        );
        const parent = parentRows[0];
        if (parent && canAdminEditParentAccount(parent)) {
            const nextName = String(data.parentName ?? "").trim();
            const nextPhone = parentPhoneDigits(data.parentPhone);
            // 비운 값으로는 덮지 않는다 — 번호는 학부모가 가입할 때 이 계정을 찾는 열쇠라 쓸 수 있는 번호일 때만 바꾼다
            let phoneToSave = isUsablePhoneKey(nextPhone) ? nextPhone : null;
            // 다른 계정(학부모·직원)이 이미 쓰는 번호로 바꾸면 같은 번호 계정이 둘이 되어 학부모 가입이 «학원 문의»로 막힌다
            // → 번호는 그대로 두고 화면에 안내한다(1차 검수 권장, 2026-11-09)
            if (phoneToSave) {
                const taken = await prisma.$queryRawUnsafe<{ id: string }[]>(
                    `SELECT id FROM "User"
                      WHERE regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = $1
                        AND id <> $2 AND "withdrawnAt" IS NULL
                      LIMIT 1`,
                    phoneToSave, parent.id,
                );
                if (taken.length > 0) {
                    phoneToSave = null;
                    parentPhoneConflict = true;
                }
            }
            const changed = await prisma.$executeRawUnsafe(
                `UPDATE "User"
                    SET name = COALESCE($1, name),
                        phone = COALESCE($2, phone),
                        "updatedAt" = NOW()
                  WHERE id = $3 AND role = 'PARENT' AND "authUserId" IS NULL`,
                nextName || null, phoneToSave, parent.id,
            );
            // 실제로 바뀐 행이 있을 때만 «고쳤다»고 알린다(그 사이 로그인 연결돼 SQL 조건에 걸리면 0행)
            parentAccountUpdated = changed > 0;
        }
    } catch (e) {
        console.error("Failed to update student:", e);
        throw new Error("원생 수정 실패");
    }
    revalidatePath("/admin/students");
    revalidatePath("/admin");
    revalidateStudentAdminCaches();
    // 화면이 «학부모 계정은 바꾸지 않았음»·«번호는 그대로 둠»을 안내할 수 있게 알려 준다
    return { parentAccountUpdated, parentPhoneConflict };
}

export async function deleteStudent(id: string) {
    await requireAdmin();
    // 원생 삭제는 그 원생의 청구(Payment)도 함께 지운다 — 실제 결제로 받은 청구·완료 거래가 붙은 청구가 있으면
    // 돈은 그대로인데 기록만 사라지므로 거절한다(수납 기록 영구 삭제와 같은 판정 · 2026-11-10 원장 승인).
    // 확인을 못 하면(조회 실패) 지우지 않는다(안전한 쪽).
    let deleteBlock: string | null = null;
    try {
        await ensurePaymentInfrastructure();
        const paymentIds = await prisma.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM "Payment" WHERE "studentId" = $1`, id);
        if (paymentIds.length > 0) {
            const rows = await prisma.$queryRawUnsafe<PaymentStatusGuardRow[]>(PAYMENT_STATUS_GUARD_SELECT, paymentIds.map((r) => r.id));
            for (const row of rows) {
                const reason = paymentDeleteBlockReason(row);
                if (reason) { deleteBlock = reason; break; }
            }
        }
    } catch (e) {
        console.error("Failed to check payments before student delete:", e);
        throw new Error("원생 삭제 실패");
    }
    if (deleteBlock) throw new Error("실제 결제로 받은 청구가 있어 원생을 삭제할 수 없어요. 결제 취소·환불을 먼저 해 주세요(그만둔 원생은 «퇴원»으로 두세요).");
    // 프로필 사진(2026-11-15, 개인정보): 행을 지우기 «전에» 사진 경로를 읽어 두고, 삭제가 성공한 «뒤에» 파일을 지운다.
    // 이 함수에서만 쓰는 부품이라 여기서 불러온다. 경로를 못 읽어도 원생 삭제는 그대로 진행한다(기록만).
    const photoCleanup = await import("@/lib/profilePhoto/cleanup");
    const photoOwner = { kind: "student" as const, id };
    const photoPath = await photoCleanup.readProfilePhotoPath(photoOwner).catch(() => {
        console.error("[profile-photo] 삭제 전 사진 경로 조회 실패 — 남은 파일 확인 필요", `student:${id}`);
        return null;
    });
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
    // 원생 행이 지워진 뒤에만 사진 파일을 지운다 — 실패해도 삭제는 성공이다(남은 파일 경로는 기록된다)
    await photoCleanup.removeProfilePhotoFiles(photoOwner, photoPath, "student-delete");
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
                // 2026-11-14 보안 HIGH: 개시일을 오늘(KST)로 적는다 — 비워 두면 수업 피드에서 입학 전 수업이 열렸다.
                // 되살리기(그만둔 반 재등록)도 «되살린 날»부터(쉬는 동안의 수업·사진이 열리지 않게). 이미 ACTIVE 면 위에서 끝났다.
                `INSERT INTO "Enrollment" (id, "studentId", "classId", status, "startsOn", "createdAt", "updatedAt")
                 VALUES (gen_random_uuid()::text, $1, $2, 'ACTIVE', (NOW() AT TIME ZONE 'Asia/Seoul')::date, NOW(), NOW())
                 ON CONFLICT ("studentId", "classId") DO UPDATE SET status = 'ACTIVE', "startsOn" = CASE WHEN "Enrollment".status = 'ACTIVE' THEN "Enrollment"."startsOn" ELSE (NOW() AT TIME ZONE 'Asia/Seoul')::date END, "updatedAt" = NOW()
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

            // 2026-11-14 보안 HIGH: 퇴원(WITHDRAWN) → 재원(ACTIVE) 이면 개시일을 효력일로 다시 적는다.
            // 옛 개시일이 남으면 빠져 있던 몇 달의 수업 사진·소식·영상이 수업 피드에서 열렸다(참여 = 시작일 ≤ 수업일).
            // 효력일은 위에서 KST 달력·미래 금지를 확인한 값(없으면 오늘 KST). 휴원(PAUSED) → 재원은 그대로 둔다.
            const rejoin = before.previousStatus === "WITHDRAWN" && status === "ACTIVE";
            const [changed] = await tx.$queryRawUnsafe<Array<{ updatedAt: Date }>>(
                `UPDATE "Enrollment" SET status=$1,
                        "startsOn" = CASE WHEN $3::boolean THEN $4::date ELSE "startsOn" END,
                        "updatedAt"=NOW()
                  WHERE id=$2 RETURNING "updatedAt"`,
                status, enrollmentId, rejoin, effectiveFrom,
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

// absenceReason(정규만): "ILLNESS_INJURY"=질병·부상 결석 표시 / null=표시 끄기 / 생략=그대로.
// 관리자가 찍은 질병·부상은 바로 «확정(CONFIRMED)» — 청구 작업대 이월 후보가 된다(이월 적용은 증빙 확인 후).
export async function saveAttendance(classId: string, date: string, records: { studentId: string; status: string; absenceReason?: "ILLNESS_INJURY" | null }[], options?: { sessionDateId?: string | null }) {
    const admin = await requireAdmin();
    if (records.some((r) => r.absenceReason !== undefined && r.absenceReason !== null && r.absenceReason !== "ILLNESS_INJURY")) {
        throw new Error("올바른 결석 사유가 아닙니다.");
    }
    // 화면에 띄울 결석 사유 안내(막힘·실패). 출결 저장 자체는 성공으로 둔다.
    const absenceMessages: string[] = [];
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
        return { ok: true as const, absenceMessages: [] as string[] };
    }
    try {
        const eligible = await prisma.$queryRawUnsafe<Array<{ studentId: string }>>(
            `SELECT e."studentId" FROM "Enrollment" e WHERE e."classId"=$1 AND e.status='ACTIVE'
             AND (e."startsOn" IS NULL OR e."startsOn" <= $2::date OR EXISTS (
               SELECT 1 FROM "Attendance" historical JOIN "Session" prior ON prior.id=historical."sessionId"
               WHERE historical."studentId"=e."studentId" AND prior."classId"=$1 AND prior.date::date=$2::date
             ))`, classId, date,
        );
        const eligibleIds = new Set(eligible.map(row => row.studentId));
        if (records.some(row => !eligibleIds.has(row.studentId))) throw new Error("수강 개시일 전이거나 이 수업 명단에 없는 학생입니다.");
        // 세션 생성 또는 조회 — 코치 앱·랠리즈와 같은 판정 함수 하나를 쓴다(같은 반·같은 날 = 기록 하나).
        // 예전엔 키 없이 새 기록을 만들어, 그 뒤 코치가 수업을 시작하면 기록이 둘로 갈라질 수 있었다.
        const sessionId = await prisma.$transaction(tx => findOrCreateRegularSession(tx, { classId, dateYmd: date }));

        // 각 학생 출석 기록 upsert
        for (const rec of records) {
            await prisma.$executeRawUnsafe(
                `INSERT INTO "Attendance" (id, "sessionId", "studentId", status, "createdAt", "updatedAt")
                 VALUES (gen_random_uuid()::text, $1, $2, $3, NOW(), NOW())
                 ON CONFLICT ("sessionId", "studentId") DO UPDATE SET status = $3, "updatedAt" = NOW()`,
                sessionId, rec.studentId, rec.status
            );
        }
        // 결석 사유(질병·부상) — 코치 출석부와 같은 함수·같은 저장 위치(RegularAbsence). 실패해도 출결은 유지.
        if (isKstYmd(date)) {
            for (const rec of records) {
                try {
                    const applied = await prisma.$transaction((tx) => applyAttendanceAbsenceReasonInTx(tx, {
                        studentId: rec.studentId, classId, dateYmd: date, attendanceStatus: rec.status,
                        intent: rec.absenceReason, confirmedByUserId: admin.appUserId, actorUserId: admin.appUserId,
                    }));
                    const msg = absencePlanMessage(applied.plan);
                    if (msg) absenceMessages.push(msg);
                } catch (error) {
                    console.error("[saveAttendance] 결석 사유 저장 실패(출결은 저장됨)", { sessionId, studentId: rec.studentId, error });
                    if (rec.absenceReason !== undefined) absenceMessages.push("일부 학생의 질병·부상 표시를 저장하지 못했습니다. 다시 저장해 주세요.");
                }
            }
        }
        // 보강권 — 결석이면 발급, 출석·지각으로 정정되면 회수(코치 화면과 같은 함수).
        // ★ 출결은 이미 저장됐다. 보강권이 실패해도 출결 저장을 실패로 만들지 않는다.
        // ★ 순서: 결석 사유(질병·부상 표시)를 저장한 «뒤»에 맞춘다(2026-11-14 a2) — 질병·부상 결석은 자동 발급하지 않고 원장이 신청함에서 고른다.
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
    revalidatePath("/admin/absence");
    revalidatePath("/mypage");
    return { ok: true as const, absenceMessages: [...new Set(absenceMessages)] };
}

// ── 수납 관리 ──────────────────────────────────────────────────────────────────
function revalidateFinanceCaches() {
    revalidatePath("/admin/finance");
    revalidatePath("/admin/stats");
    // 학생 상세 «청구/수납» 탭도 같은 청구를 보여 준다(30초 ISR) — 어느 학생이든 다시 그리게 한다
    revalidatePath("/admin/students/[id]", "page");
    revalidateTag("admin-finance", { expire: 0 });
    revalidateTag("admin-stats", { expire: 0 });
}

async function requireFinanceOwner() {
    const admin = await requireAdmin();
    // 화면(학생 상세 ⋯ 메뉴 표시)과 같은 기준 — studentBillingRules.isFinanceOwnerRole
    if (!isFinanceOwnerRole(admin.appUserRole)) {
        throw new Error("수퍼관리자 권한이 필요합니다.");
    }
    return admin;
}

// createPayment 결과 — 같은 학생·반·월·유형에 살아 있는 청구가 있으면 발행하지 않고 목록을 돌려준다.
// 화면이 «그래도 발행»을 확인받아 force: true 로 다시 부른다(서버는 force 없이 중복을 만들지 않는다).
export type CreatePaymentResult =
    | { ok: true; invoiceId: string }
    // amount: 부원장에게는 이미 납부·취소·환불된 중복 청구의 금액을 null 로 가린다(moneyAccess, 2026-11-14)
    | { ok: false; duplicates: Array<{ id: string; status: string; amount: number | null; description: string | null }> };

export async function createPayment(data: {
    studentId: string;
    classId?: string | null;
    amount: number;
    dueDate: string;
    status?: string;
    type?: string;        // 청구 유형: MONTHLY, SHUTTLE, UNIFORM, OTHER
    description?: string; // 설명: "4월 수강료" 등
    notifyParent?: boolean;
    /** 청구 월 "YYYY-MM"(학생 상세 발행). 없으면 납부기한 "YYYY-MM-DD" 의 앞부분 — 수납 관리 화면 호환 */
    billingMonth?: string | null;
    /** 중복 경고를 보고도 «그래도 발행»을 고른 경우에만 true */
    force?: boolean;
}): Promise<CreatePaymentResult> {
    const admin = await requireAdmin();
    let result: CreatePaymentResult;
    try {
        // 납부기한은 "YYYY-MM-DD" 문자열로만 받는다 — Date 객체를 거치면 서버(UTC)에서 날짜가 밀릴 수 있다
        const dueYmd = normalizeDueYmd(data.dueDate);
        if (!Number.isSafeInteger(data.amount) || data.amount <= 0) throw new Error("청구 금액은 1원 이상의 정수여야 합니다.");
        // 청구 월 = 화면이 보낸 청구 월, 없으면 납부기한 문자열의 연·월(예전엔 Date 의 월을 읽어 시간대에 따라 전달로 밀렸다)
        const { year, month } = resolveBillingPeriod({ billingMonth: data.billingMonth, dueDate: dueYmd });
        // 설명은 수정과 같은 규칙(앞뒤 공백 제거·200자 이내·비면 null)
        const description = normalizeBillingDescription(data.description);
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
        const created = await prisma.$transaction(async (tx) => {
            if (["MONTHLY", "SHUTTLE"].includes(paymentType)) {
                // 청구 준비(작업대)와 같은 잠금을 잡아 동시에 도는 작업대 발행과 순서를 맞춘다
                await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext('STIZ_BILLING_WORKBENCH'))");
                // 작업대 «쓰기»가 켜져 있을 때만 그쪽으로 안내한다. 예전엔 «표가 있으면» 막아,
                // 쓰기가 꺼진 지금은 신규생 수강료를 아무 데서도 발행할 수 없었다(2026-11-09).
                if (manualChargeBlockedByWorkbench(paymentType, isBillingWorkbenchWritesEnabled(process.env))) {
                    throw new Error("수강료·셔틀비는 이번 달 청구 준비에서 검토해 주세요.");
                }
            }
            // 같은 학생의 수동 발행이 동시에 두 번 들어와도 중복 검사가 서로를 보게 학생 단위로 줄 세운다
            await tx.$executeRawUnsafe(
                `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
                `manual-charge:${data.studentId}`,
            );
            // 중복 검사: 같은 학생·청구 월·유형의 청구를 읽어 순수 판정(반·살아 있음)으로 거른다
            const sameMonthRows = await tx.$queryRawUnsafe<Array<{ id: string; studentId: string; classId: string | null; year: number; month: number; type: string; status: string; amount: number; description: string | null }>>(
                `SELECT id, "studentId", "classId", year, month, COALESCE(type, 'MONTHLY') AS type, status, amount, description
                   FROM "Payment"
                  WHERE "studentId" = $1 AND year = $2 AND month = $3 AND COALESCE(type, 'MONTHLY') = $4`,
                data.studentId, year, month, paymentType,
            );
            const duplicates = findDuplicateCharges(
                sameMonthRows.map((row) => ({ ...row, amount: Number(row.amount), year: Number(row.year), month: Number(row.month) })),
                { studentId: data.studentId, classId, year, month, type: paymentType },
            );
            if (duplicates.length > 0 && !data.force) {
                // 아무것도 쓰지 않고 돌려준다(거래 안에서 쓴 것이 없으므로 그대로 끝난다)
                return {
                    kind: "duplicate" as const,
                    duplicates: duplicates.map((row) => ({ id: row.id, status: row.status, amount: row.amount, description: row.description ?? null })),
                };
            }
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
                data.studentId, classId, data.amount, requestedStatus, dueYmd,
                year, month, paymentType, description,
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
                // forcedDuplicateIds: 중복 경고를 보고도 «그래도 발행»한 경우 그때 있던 청구 id(나중에 확인용)
                JSON.stringify({
                    classId, amount: data.amount, year, month, type: paymentType, dueDate: dueYmd, description,
                    notifyParent: Boolean(data.notifyParent),
                    forcedDuplicateIds: duplicates.map((row) => row.id),
                }),
            );
            return { kind: "created" as const, invoice: invoiceRows[0] };
        });

        if (created.kind === "duplicate") {
            // 중복이라 발행하지 않았다 — 캐시 무효화·알림 없이 바로 돌려준다
            // 부원장에게는 미납이 아닌 중복 청구 금액을 가린다(원장은 그대로)
            return { ok: false, duplicates: created.duplicates.map((row) => maskPaymentAmount(row, admin.appUserRole)) };
        }
        const invoice = created.invoice;
        result = { ok: true, invoiceId: invoice.id };

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
    return result;
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

// 납부완료(PAID)는 방법·근거 없이 만들지 않는다(2026-11-08 원장 결정).
// 계좌이체는 recordBankTransferPayment, 현장 결제는 토스 POS 확인, 온라인은 토스 웹훅이 각각
// lib/payment-ledger 의 markPaymentPaid 를 직접 부른다 — 이 상태 변경 함수들은 PAID 를 받지 않는다.
const DIRECT_PAID_BLOCKED_MESSAGE = "납부완료는 «납부 처리» 창에서 결제 방법을 골라 기록해 주세요.";
// 환불도 상태 변경으로 만들지 않는다(PM 결정 2026-11-09) — 토스 온라인은 실제 결제 취소, POS 는 POS 취소,
// 수기만 장부 환불로 갈라 주는 refundSelectedPayments(⚡ «환불»·«선택 항목 환불»)만 쓴다. 여기서 바꾸면 돈은 그대로 둔 채 장부만 환불된다.
const DIRECT_REFUND_BLOCKED_MESSAGE = "환불은 수납 관리의 ⚡ «환불» 또는 «선택 항목 환불»로 해 주세요.";

// 납부완료 상태 변경 거절 — 안내 문구를 그대로 화면에 보여 주려고 일반 실패(«수납 상태 변경 실패»)와 구분한다
class PaymentStatusGuardError extends Error {}
// 판정 사이에 다른 경로(토스 웹훅·POS·납부 처리 창)가 상태를 바꿨을 때
const PAYMENT_STATUS_RACE_MESSAGE = "처리 중 청구 상태가 바뀌어 변경하지 않았어요. 다시 조회해 주세요.";

// 상태 변경 판정용으로 DB 에서 다시 읽는 값(화면이 보낸 현재 상태는 믿지 않는다)
type PaymentStatusGuardRow = {
    id: string;
    status: string;
    paidProvider: string | null;
    method: string | null;
    paidDate: Date | string | null;
    hasDoneTransaction: boolean;
    hasManualDoneTransaction: boolean;
};
// 완료 거래는 둘로 나눠 읽는다 — 토스 등 실제 결제(hasDoneTransaction) / 교사 수납 확인(provider MANUAL · hasManualDoneTransaction).
// 묶음 결제(한 거래에 청구 여러 건)도 잡도록 거래 항목 표까지 본다(txCoversPaymentSql).
const PAYMENT_STATUS_GUARD_SELECT = `
    SELECT p.id, p.status, p."paidProvider", p.method, p."paidDate",
           EXISTS (SELECT 1 FROM "PaymentTransaction" t WHERE ${txCoversPaymentSql("t", "p.id")} AND t.status = 'DONE'
                     AND COALESCE(UPPER(t.provider), '') <> 'MANUAL') AS "hasDoneTransaction",
           EXISTS (SELECT 1 FROM "PaymentTransaction" t WHERE ${txCoversPaymentSql("t", "p.id")} AND t.status = 'DONE'
                     AND UPPER(t.provider) = 'MANUAL') AS "hasManualDoneTransaction"
      FROM "Payment" p
     WHERE p.id = ANY($1::text[])`;
// 수기 납부완료 되돌리기의 조건부 UPDATE 조건 — 판정 함수(isManualPaidProvider)와 같은 기준을 SQL 로 한 번 더 건다
const PAYMENT_REVERT_WHERE = `status = 'PAID'
       AND COALESCE(NULLIF(UPPER(TRIM("paidProvider")), ''), 'MANUAL') = 'MANUAL'
       AND NOT EXISTS (SELECT 1 FROM "PaymentTransaction" t WHERE t."paymentId" = "Payment".id AND t.status = 'DONE')`;
// 수기 납부완료를 대기로 되돌릴 때 비우는 값: 납부일·결제 수단·결제 경로(«받지 않은 돈»의 기록). 이전 값은 감사 기록에 남긴다.
const PAYMENT_REVERT_SET = `status = 'PENDING', "paidDate" = NULL, method = NULL, "paidProvider" = NULL, "updatedAt" = NOW()`;
// 청구서도 «받음»을 지운다 — 보낸 적 있으면 SENT, 아니면 ISSUED(청구서 수정과 같은 규칙)
const INVOICE_REVERT_SET = `status = CASE WHEN "sentAt" IS NOT NULL THEN 'SENT' ELSE 'ISSUED' END, "paidAt" = NULL, "updatedAt" = NOW()`;

export async function updatePaymentStatus(id: string, status: string) {
    const admin = await requireFinanceOwner();
    // try 밖에서 막아야 안내 문구가 «수납 상태 변경 실패»로 뭉개지지 않는다
    if (status === "PAID") throw new Error(DIRECT_PAID_BLOCKED_MESSAGE);
    if (status === "REFUNDED") throw new Error(DIRECT_REFUND_BLOCKED_MESSAGE);
    try {
        await ensurePaymentInfrastructure();
        // 1) DB 에서 지금 상태·결제 경로를 다시 읽어 판정(2026-11-10 원장 지시 — 납부완료를 대기·취소로 바꾸는 구멍)
        const rows = await prisma.$queryRawUnsafe<PaymentStatusGuardRow[]>(PAYMENT_STATUS_GUARD_SELECT, [id]);
        const current = rows[0];
        if (!current) throw new PaymentStatusGuardError("수납 기록을 찾을 수 없습니다.");
        const decision: PaymentStatusDecision = judgePaymentStatusChange(current, status);
        if (!decision.ok) throw new PaymentStatusGuardError(decision.message);

        const invoice = await ensureInvoiceForPayment(id);

        if (decision.kind === "REVERT_PAID") {
            // 2-a) 수기 납부완료 → 대기(납부 기록 정정). Payment·청구서를 한 트랜잭션으로 — 하나라도 실패하면 둘 다 되돌린다.
            // 조건부 UPDATE — 그 사이 바뀌었으면 0건 → 거절(롤백)
            await prisma.$transaction(async (tx) => {
                const updated = await tx.$executeRawUnsafe(
                    `UPDATE "Payment" SET ${PAYMENT_REVERT_SET} WHERE id = $1 AND ${PAYMENT_REVERT_WHERE}`,
                    id,
                );
                if (Number(updated) !== 1) throw new PaymentStatusGuardError(PAYMENT_STATUS_RACE_MESSAGE);
                if (invoice?.id) {
                    await tx.$executeRawUnsafe(
                        `UPDATE "PaymentInvoice" SET ${INVOICE_REVERT_SET} WHERE id = $1`,
                        invoice.id,
                    );
                }
            });
            // 감사 기록: 누가·언제·무엇을 지웠는지(되돌릴 때 필요한 이전 값까지)
            await recordPaymentAudit({
                paymentId: id,
                invoiceId: invoice?.id ?? null,
                actorType: "ADMIN",
                actorId: admin.appUserId,
                action: "PAYMENT_PAID_REVERTED",
                message: "납부 기록 정정: 납부완료 → 대기",
                metadata: {
                    previousStatus: current.status,
                    nextStatus: "PENDING",
                    previousPaidProvider: current.paidProvider,
                    previousMethod: current.method,
                    previousPaidDate: current.paidDate,
                },
            });
        } else {
            // 2-b) 납부완료가 아닌 청구(예전 그대로). 그 사이 납부완료가 됐으면 덮지 않는다(조건부 UPDATE)
            const invoiceStatus = status === "OVERDUE"
                ? "OVERDUE"
                : ["REFUNDED", "CANCELED"].includes(status)
                    ? "CANCELED"
                    : "ISSUED";

            // Payment·청구서를 한 트랜잭션으로(0건이면 롤백)
            await prisma.$transaction(async (tx) => {
                const updated = await tx.$executeRawUnsafe(
                    `UPDATE "Payment" SET status = $1, "paidDate" = NULL, "updatedAt" = NOW() WHERE id = $2 AND status <> 'PAID'`,
                    status, id,
                );
                if (Number(updated) !== 1) throw new PaymentStatusGuardError(PAYMENT_STATUS_RACE_MESSAGE);
                if (invoice?.id) {
                    await tx.$executeRawUnsafe(
                        `UPDATE "PaymentInvoice" SET status = $1, "updatedAt" = NOW() WHERE id = $2`,
                        invoiceStatus,
                        invoice.id,
                    );
                }
            });
            await recordPaymentAudit({
                paymentId: id,
                invoiceId: invoice?.id ?? null,
                actorType: "ADMIN",
                action: "PAYMENT_STATUS_UPDATE",
                message: `Payment status changed to ${status}`,
            });
        }
    } catch (e) {
        // 규칙 거절은 안내 문구 그대로, 그 밖은 일반 실패
        if (e instanceof PaymentStatusGuardError) throw new Error(e.message);
        console.error("Failed to update payment:", e);
        throw new Error("수납 상태 변경 실패");
    }
    revalidateFinanceCaches();
}

/**
 * 계좌이체 납부 기록(관리자 «납부 처리» 창 · 2026-11-08 원장 결정)
 * - 입금일·입금자명을 받아야만 납부완료가 된다. 여러 건이면 같은 입금 정보로 한 번에 기록한다.
 * - 미납·연체만 바꾸고, 이미 납부·취소·환불은 건너뛰어 결과로 알려 준다.
 * - 한 트랜잭션: 청구 잠금 → Payment·PaymentInvoice 갱신 → 건마다 감사 기록. 하나라도 어긋나면 전부 되돌린다.
 * (예전 «현장 단말기 결제 반영» markTerminalPaymentPaid 는 이 창으로 대체되어 지웠다.
 *  이미 단말기로 기록된 결제는 Payment.method·paidProvider 값이 그대로 남아 화면 표시가 유지된다.)
 */
export async function recordBankTransferPayment(data: {
    paymentIds: string[];
    depositDate: string;
    depositorName: string;
    memo?: string | null;
}) {
    // 권한 = 기존 납부 처리와 같은 재무 권한(원장 ADMIN)
    const admin = await requireFinanceOwner();
    // 서버가 다시 검사한다(화면 검사를 믿지 않는다). 미래 입금일 기준은 KST 오늘.
    const checked = validateBankTransferInput(data, todayKst());
    if (!checked.ok) throw new Error(checked.error);
    const { paymentIds, depositDate, depositorName, memo } = checked.value;

    try {
        await ensurePaymentInfrastructure();
        // 청구서가 없는 옛 청구도 있으므로 먼저 맞춰 둔다(멱등 — 기존 납부 처리와 같은 준비 단계)
        for (const id of paymentIds) await ensureInvoiceForPayment(id);

        const result = await prisma.$transaction(async (tx) => {
            // 동시에 토스 웹훅·POS 확인이 같은 청구를 바꾸지 못하게 잠근다
            const rows = await tx.$queryRawUnsafe<{ id: string; status: string; amount: number; invoiceId: string | null }[]>(
                `SELECT p.id, p.status, p.amount, i.id AS "invoiceId"
                   FROM "Payment" p
                   LEFT JOIN "PaymentInvoice" i ON i."paymentId" = p.id
                  WHERE p.id = ANY($1::text[])
                  ORDER BY p.id
                  FOR UPDATE OF p`,
                paymentIds,
            );
            const { recordable, skipped } = splitRecordableTargets(rows, paymentIds);
            if (recordable.length === 0) return { recorded: [] as typeof rows, skipped };

            // paidDate 는 시간대 없는 timestamp — 날짜 문자열을 그대로 '그날 00:00' 으로 넣는다.
            // UTC 로 읽어도(toISOString) KST 로 두 번 걸어 읽어도 같은 날짜가 나온다.
            // paidProvider = 'MANUAL' — 교사 수납 확인(staff-billing)·특강 수동 납부와 같은 관례.
            // 토스 주문번호·결제키(providerOrderId/providerPaymentKey)는 다른 수동 경로처럼 건드리지 않는다.
            const updated = await tx.$executeRawUnsafe(
                `UPDATE "Payment"
                    SET status = 'PAID', "paidDate" = $2::date::timestamp, method = $3,
                        "paidProvider" = 'MANUAL', "updatedAt" = NOW()
                  WHERE id = ANY($1::text[]) AND status IN ('PENDING', 'OVERDUE')`,
                recordable, depositDate, BANK_TRANSFER_METHOD,
            );
            if (Number(updated) !== recordable.length) {
                throw new Error("처리 중 청구 상태가 바뀌어 기록하지 않았어요. 다시 조회해 주세요.");
            }
            // PaymentInvoice.paidAt 은 timestamptz — Payment.paidDate 와 «같은 순간»(입금일 00:00 UTC = KST 09:00)으로 넣는다.
            // KST 자정(전날 15:00 UTC)으로 넣으면 UTC 로 날짜를 자르는 화면에서 하루 앞당겨 보인다.
            // 청구서가 이미 납부·취소면 덮지 않는다(교사 수납 확인과 같은 조건 — 토스 취소 직후 경합 대비).
            await tx.$executeRawUnsafe(
                `UPDATE "PaymentInvoice"
                    SET status = 'PAID', "paidAt" = ($2::date::timestamp AT TIME ZONE 'UTC'), "updatedAt" = NOW()
                  WHERE "paymentId" = ANY($1::text[]) AND status NOT IN ('PAID', 'CANCELED')`,
                recordable, depositDate,
            );

            const recorded = rows.filter((row) => recordable.includes(row.id));
            for (const row of recorded) {
                // 근거 기록: 누가·언제 입금·누구 이름으로·이전 상태
                await tx.$executeRawUnsafe(
                    `INSERT INTO "PaymentAuditLog" (
                        id, "paymentId", "invoiceId", "actorType", "actorId", action, message, metadata, "createdAt"
                     ) VALUES (
                        gen_random_uuid()::text, $1, $2, 'ADMIN', $3, $4, $5, $6::jsonb, NOW()
                     )`,
                    row.id,
                    row.invoiceId,
                    admin.appUserId,
                    BANK_TRANSFER_AUDIT_ACTION,
                    "관리자 계좌이체 납부 기록",
                    JSON.stringify({
                        method: BANK_TRANSFER_METHOD,
                        depositDate,
                        depositorName,
                        memo,
                        previousStatus: row.status,
                        amount: Number(row.amount),
                        batchSize: recordable.length,
                    }),
                );
            }
            return { recorded, skipped };
        });

        revalidateFinanceCaches();
        revalidatePath("/mypage");
        return {
            recordedCount: result.recorded.length,
            recordedAmount: result.recorded.reduce((sum, row) => sum + Number(row.amount), 0),
            skipped: result.skipped as Array<{ id: string; reason: SkipReason }>,
            message: bankTransferResultMessage(result.recorded.length, result.skipped.length),
        };
    } catch (e) {
        console.error("Failed to record bank transfer payment:", e);
        throw new Error(e instanceof Error ? e.message : "계좌이체 납부 기록 실패");
    }
}

// 현장 결제(POS)로 받은 청구는 삭제하면 결제 기록·POS 요청까지 같이 지워진다 — 환불(결제 취소)로만 되돌린다
const PAYMENT_DELETE_BLOCKED_MESSAGE = "현장 결제(POS)로 받았거나 POS 요청에 묶인 청구는 삭제할 수 없어요. 먼저 결제 취소(환불)를 해 주세요.";

export async function deletePayment(id: string) {
    await requireFinanceOwner();
    // 삭제 전 DB 에서 직접 확인(화면에서 메뉴를 숨겨도 서버가 한 번 더 막는다).
    // 조건: 토스 POS 결제(paidProvider) · POS 요청(열림·납부·보류·취소 진행)에 묶인 청구.
    // POS 표 조회가 실패하면 «확인 못 함»이므로 삭제하지 않는다(안전한 쪽).
    let blocked = false;
    try {
        await ensurePaymentInfrastructure();
        const rows = await prisma.$queryRawUnsafe<{ blocked: boolean }[]>(
            `SELECT (p."paidProvider" = 'TOSS_POS' OR EXISTS (
                        SELECT 1 FROM "PosChargeRequest" r
                         WHERE (r."paymentId" = p.id
                                OR EXISTS (SELECT 1 FROM "PosChargeRequestItem" it WHERE it."requestId" = r.id AND it."paymentId" = p.id))
                           AND (r.status IN ('PENDING','SENT','PAID','HELD') OR r."cancelState" IS NOT NULL)
                    )) AS blocked
               FROM "Payment" p WHERE p.id = $1`,
            id,
        );
        blocked = rows[0]?.blocked === true;
    } catch (e) {
        console.error("Failed to check payment before delete:", e);
        throw new Error("수납 기록 삭제 실패");
    }
    if (blocked) throw new Error(PAYMENT_DELETE_BLOCKED_MESSAGE);
    try {
        // 한 트랜잭션: 청구 잠금 → 실제 결제·완료 거래 재판정(2026-11-10 원장 승인) → 지우기.
        // 잠근 뒤 판정하므로 그 사이 토스 웹훅이 납부완료로 바꾼 청구도 지우지 않는다. 하나라도 실패하면 전부 되돌린다.
        await prisma.$transaction(async (tx) => {
            const locked = await tx.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM "Payment" WHERE id = $1 FOR UPDATE`, id);
            if (locked.length === 0) throw new PaymentStatusGuardError("수납 기록을 찾을 수 없습니다. 다시 조회해 주세요.");
            const rows = await tx.$queryRawUnsafe<PaymentStatusGuardRow[]>(PAYMENT_STATUS_GUARD_SELECT, [id]);
            const reason = rows[0] ? paymentDeleteBlockReason(rows[0]) : null;
            if (reason) throw new PaymentStatusGuardError(reason);
            await tx.$executeRawUnsafe(`DELETE FROM "PaymentTransaction" WHERE "paymentId" = $1`, id);
            await tx.$executeRawUnsafe(`DELETE FROM "PaymentInvoice" WHERE "paymentId" = $1`, id);
            await tx.$executeRawUnsafe(`DELETE FROM "Payment" WHERE id = $1`, id);
        });
    } catch (e) {
        // 규칙 거절은 안내 문구 그대로
        if (e instanceof PaymentStatusGuardError) throw new Error(e.message);
        console.error("Failed to delete payment:", e);
        throw new Error("수납 기록 삭제 실패");
    }
    revalidateFinanceCaches();
}

/**
 * 미납 청구 수정(학생 상세 «청구/수납» · 2026-11-09 원장 지시) — 금액·설명·납부기한만 바꾼다.
 * - 권한: 재무 권한(원장 ADMIN) — 청구서 삭제(cancelUnpaidPayment)와 같다.
 * - IDOR: 화면이 보낸 학생 id 와 청구가 맞아야 한다. 학생·미납 상태를 UPDATE WHERE 에도 다시 건다.
 * - 막는 경우: 미납·연체가 아님 · POS 요청에 묶임 · 학부모 결제(단건·묶음) 진행 중 · 청구서가 수정 불가 상태.
 *   판정은 lib/payments/studentBillingRules 의 unpaidEditBlockReason(화면과 같은 함수).
 * - 한 트랜잭션: 청구·청구서 잠금 → 판정 → Payment·PaymentInvoice 같이 갱신 → 감사 기록(이전 값·되돌릴 값).
 * - 학부모에게 알리지 않는다.
 */
export async function updateUnpaidPayment(input: {
    studentId: string;
    paymentId: string;
    amount: number;
    description?: string | null;
    dueDate: string;
}) {
    const admin = await requireFinanceOwner();
    const studentId = input.studentId?.trim();
    const paymentId = input.paymentId?.trim();
    if (!studentId || !paymentId) throw new Error("수정할 청구를 선택해 주세요.");
    // 화면 검사를 믿지 않고 서버가 다시 검사한다(금액 정수·기한 "YYYY-MM-DD")
    const patch = validateUnpaidEdit(input);

    try {
        await ensurePaymentInfrastructure();
        await prisma.$transaction(async (tx) => {
            // 0) 학부모 결제 시작·승인 직전과 같은 잠금(stiz-payment-checkout:{청구 id}) — 이 잠금을 쥔 동안
            //    결제 쪽은 기다렸다가 금액을 다시 읽어, 바뀌었으면 옛 금액 주문을 만들지 않고 멈춘다
            await lockPaymentsForCheckout(tx, [paymentId]);
            // 1) 그 학생의 청구인지 + 잠금(동시에 토스 웹훅·POS·납부 처리가 같은 청구를 못 바꾸게)
            const paymentRows = await tx.$queryRawUnsafe<Array<{
                status: string; amount: number; description: string | null; type: string | null;
                due_ymd: string; payable_until: string | null; pos_locked: boolean;
            }>>(
                `SELECT p.status, p.amount, p.description, p.type,
                        p."dueDate"::date::text AS due_ymd,
                        p."payableUntil"::text AS payable_until,
                        -- POS 요청 묶임: 수납 목록(getPaymentPosInfo)·영구 삭제(deletePayment)와 같은 기준
                        EXISTS (
                            SELECT 1 FROM "PosChargeRequest" r
                             WHERE (r."paymentId" = p.id
                                    OR EXISTS (SELECT 1 FROM "PosChargeRequestItem" it WHERE it."requestId" = r.id AND it."paymentId" = p.id))
                               AND (r.status = ANY($3::text[]) OR r."cancelState" IS NOT NULL)
                        ) AS pos_locked
                   FROM "Payment" p
                  WHERE p.id = $1 AND p."studentId" = $2
                  FOR UPDATE OF p`,
                paymentId,
                studentId,
                [...POS_LOCKING_REQUEST_STATUSES],
            );
            const payment = paymentRows[0];
            if (!payment) throw new Error("이 학생의 청구를 찾을 수 없습니다. 다시 조회해 주세요.");

            // 2) 청구서도 잠그고 상태 확인(새로 만들지 않는다 — 취소와 같은 원칙)
            const invoiceRows = await tx.$queryRawUnsafe<Array<{ id: string; status: string; sentAt: Date | null }>>(
                `SELECT id, status, "sentAt" FROM "PaymentInvoice" WHERE "paymentId" = $1 FOR UPDATE`,
                paymentId,
            );
            const invoice = invoiceRows[0];
            const blocked = unpaidEditBlockReason({
                status: payment.status,
                invoiceStatus: invoice?.status ?? null,
                posLocked: payment.pos_locked === true,
                // 학부모 결제 진행(30분 안 결제창·기한 남은 입금 계좌) — 학생 상세 안내와 같은 함수
                parentCheckoutActive: (await findParentCheckoutActivePaymentIds(tx, [paymentId], Date.now())).has(paymentId),
            });
            if (blocked) throw new Error(blocked);
            if (!invoice) throw new Error("연결된 청구서를 찾을 수 없습니다.");
            // 완료(DONE) 결제 거래가 있으면 수정하지 않는다 — cancelUnpaidPayment 와 같은 검사(환불 절차로)
            const completedTransactions = await tx.$queryRawUnsafe<{ id: string }[]>(
                `SELECT id FROM "PaymentTransaction" WHERE "paymentId" = $1 AND status = 'DONE' LIMIT 1`,
                paymentId,
            );
            if (completedTransactions.length > 0) throw new Error(DONE_TRANSACTION_BLOCK_MESSAGE);

            const before = {
                amount: Number(payment.amount),
                description: payment.description ?? null,
                dueDate: payment.due_ymd,
                status: payment.status,
                invoiceStatus: invoice.status,
                payableUntil: payment.payable_until,
            };
            if (before.amount === patch.amount && before.description === patch.description && before.dueDate === patch.dueDate) {
                throw new Error("바뀐 내용이 없어요.");
            }

            // 3) 기한을 오늘(KST) 이후로 늘린 연체 청구는 미납으로 되돌린다(청구서는 보냈으면 SENT, 아니면 ISSUED)
            const nextStatus = statusAfterDueDateEdit(payment.status, patch.dueDate, todayKst());
            const nextInvoiceStatus = nextStatus === "PENDING" && invoice.status === "OVERDUE"
                ? (invoice.sentAt ? "SENT" : "ISSUED")
                : invoice.status;
            // 청구서 제목 = 청구서를 처음 만들 때와 같은 규칙(설명 → 유형 → «수강료»)
            const nextTitle = patch.description ?? payment.type ?? "수강료";

            // Payment.dueDate 는 시간대 없는 timestamp → 그날 00:00. payableUntil·청구서 기한은 timestamptz →
            // 같은 순간(그날 00:00 UTC)으로 넣어 기존 발행(ensureInvoicesForMonth)과 같은 값이 되게 한다.
            const paymentUpdated = await tx.$executeRawUnsafe(
                `UPDATE "Payment"
                    SET amount = $3, description = $4, "dueDate" = $5::date::timestamp,
                        "payableUntil" = ($5::date::timestamp AT TIME ZONE 'UTC'),
                        status = $6, "updatedAt" = NOW()
                  WHERE id = $1 AND "studentId" = $2 AND status IN ('PENDING', 'OVERDUE')`,
                paymentId, studentId, patch.amount, patch.description, patch.dueDate, nextStatus,
            );
            const invoiceUpdated = await tx.$executeRawUnsafe(
                `UPDATE "PaymentInvoice"
                    SET amount = $3, title = $4, description = $5,
                        "dueDate" = ($6::date::timestamp AT TIME ZONE 'UTC'),
                        status = $7, "updatedAt" = NOW()
                  WHERE id = $1 AND "paymentId" = $2 AND status IN ('ISSUED', 'SENT', 'OVERDUE')`,
                invoice.id, paymentId, patch.amount, nextTitle, patch.description, patch.dueDate, nextInvoiceStatus,
            );
            if (Number(paymentUpdated) !== 1 || Number(invoiceUpdated) !== 1) {
                throw new Error("현재 수납·청구 상태가 바뀌어 수정하지 않았습니다. 다시 조회해 주세요.");
            }

            // 4) 감사 기록 — 누가·무엇을 바꿨나 + 되돌릴 값(rollback)
            await tx.$executeRawUnsafe(
                `INSERT INTO "PaymentAuditLog" (
                    id, "paymentId", "invoiceId", "actorType", "actorId", action, message, metadata, "createdAt"
                 ) VALUES (
                    gen_random_uuid()::text, $1, $2, 'ADMIN', $3, 'PAYMENT_UPDATE_UNPAID', $4, $5::jsonb, NOW()
                 )`,
                paymentId,
                invoice.id,
                admin.appUserId,
                "관리자 미납 청구 수정",
                JSON.stringify({
                    studentId,
                    before,
                    after: { ...patch, status: nextStatus, invoiceStatus: nextInvoiceStatus },
                    // 되돌리려면 이 값으로 같은 함수를 다시 부르면 된다(상태는 연체 판정이 다시 맞춘다)
                    rollback: { amount: before.amount, description: before.description, dueDate: before.dueDate },
                }),
            );
        });
    } catch (e) {
        console.error("Failed to update unpaid payment:", e);
        throw new Error(e instanceof Error ? e.message : "미납 청구 수정 실패");
    }
    revalidateFinanceCaches();
    revalidatePath("/mypage");
    return { ok: true as const };
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
        where: { id: studentId, ...await childAccessWhere(parent.appUserId) },
        select: { id: true, name: true },
    });
    if (!ownedStudent) throw new Error("본인 자녀에 대해서만 요청할 수 있습니다.");
    // 하루(KST) 새 문의 상한 — 넣는 문장 안에서 센다(한 사람이 문의를 끝없이 만들지 못하게, 보안 검수 권장 2026-11-14).
    // createdAt 은 timestamptz 라 AT TIME ZONE 을 한 번만 건다.
    let insertedCount = 0;
    try {
        insertedCount = Number(await prisma.$executeRawUnsafe(
            `INSERT INTO "ParentRequest" (id, "userId", "studentId", type, title, content, date, status, "createdAt", "updatedAt")
             SELECT gen_random_uuid()::text, $1, $2, $3, $4, $5, $6::timestamptz, 'PENDING', NOW(), NOW()
              WHERE (SELECT COUNT(*) FROM "ParentRequest" d
                      WHERE d."userId" = $1
                        AND (d."createdAt" AT TIME ZONE 'Asia/Seoul')::date = (NOW() AT TIME ZONE 'Asia/Seoul')::date) < $7`,
            parent.appUserId, ownedStudent.id, type, title, content, requestedDate, INQUIRY_DAILY_NEW_MAX,
        ));
    } catch (e) {
        console.error("Failed to create parent request:", e);
        throw new Error("요청 접수에 실패했습니다.");
    }
    if (insertedCount === 0) throw new Error("오늘은 문의를 더 보낼 수 없어요. 급한 일은 학원에 전화해 주세요.");
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
             VALUES (gen_random_uuid()::text, $1, 'REQUEST', '메시지 상담 상태 안내', $2, $3, false, NOW())`,
            before.userId,
            `"${before.title}" → ${({ PENDING: "상담 대기", CONFIRMED: "내용 확인", COMPLETED: "상담 종결", REJECTED: "반려" } as Record<string, string>)[status]}. 출결·셔틀 변경 여부는 해당 화면에서 확인해 주세요.`,
            // 누르면 그 문의의 대화 화면으로(2026-11-14 — 예전엔 홈으로 갔다)
            `/mypage/requests/${id}`,
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
                title: "메시지 상담 상태 안내", body: "상담 상태가 변경되었습니다. 보낸 문의에서 확인해 주세요.", url: `/mypage/requests/${id}`, tag: "REQUEST",
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
 * 학생 1명 신규 분기(계정 확정·학생·보호자1~3)는 트랜잭션 하나(prisma.$transaction — 원시 SQL 이라 PgBouncer 에서도 동작).
 * 엑셀 전체는 묶지 않는다 — 한 행이 실패해도 나머지는 등록하고 실패 목록으로 돌려준다.
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

                    // 보호자1은 학부모 계정(User)을 덮어쓰지 않고 주 보호자 Guardian 으로 다시 넣는다(신규 분기와 같은 형식).
                    // 예전엔 계정 이름을 «아버지»·«보호자» 같은 관계명으로 덮었다(로그인하는 학부모 계정 포함) — 2026-11-09 제거.
                    if (student.guardian1Phone || student.guardian1Relation) {
                        await prisma.$executeRawUnsafe(
                            `INSERT INTO "Guardian" (id, "studentId", relation, name, phone, "isPrimary", "createdAt", "updatedAt")
                             VALUES (gen_random_uuid()::text, $1, $2, $3, $4, true, NOW(), NOW())`,
                            existingStudentId,
                            student.guardian1Relation || "보호자",
                            student.guardian1Relation || "보호자",
                            student.guardian1Phone || null,
                        );
                    }

                    // 보호자2,3 Guardian 테이블에 INSERT
                    await insertGuardians(existingStudentId, student);

                    result.updated++;
                    finalStudentId = existingStudentId;
                }
            }

            // 기존 학생이 처리된 경우 (skip 또는 overwrite) 신규 등록은 건너뜀
            if (!finalStudentId) {
            // ── 3. 신규 학생: 보호자1 번호로 학부모 계정 확정 — 목록·체험·등록 창과 같은 규칙(parentAccountLink) 한 곳 ──
            // 보호자1 이름은 관계명(예: "아버지")을 사용, 없으면 "보호자" (엑셀에 보호자 이름 칸이 없다)
            const guardian1Label = student.guardian1Relation || "보호자";
            // 번호가 없거나 형식이 틀리면 계정을 찾을 열쇠가 없어 이 행은 실패로 남긴다(예전엔 번호 없는 빈 계정을 만들어
            // 학부모가 영영 가입·연결을 못 했다). 안내 문구는 엑셀 실패 목록에 그대로 보인다.
            const guardian1 = validatePrimaryGuardian({ relation: guardian1Label, name: guardian1Label, phone: student.guardian1Phone });
            if (!guardian1.ok) throw new Error(`보호자1 휴대폰: ${guardian1.error}`);

            // 계정 확정·학생·보호자1~3 을 한 트랜잭션으로 — 중간에 실패하면 빈 계정도 남지 않는다
            const newStudentId = await prisma.$transaction(async (tx) => {
                // 같은 번호 PARENT 1명 → 그 계정 / 없으면 같은 번호 직원 1명 / 둘 다 없으면 빈 계정(parent_<번호>@stiz.local)
                // 기존 계정의 이름·번호·이메일은 바꾸지 않는다. 같은 번호 계정이 여럿이면 오류 → 이 행만 실패
                const link = await linkParentAccountForNewStudent(tx, guardian1.value);

                // ── 4. Student INSERT ──
                // 생년월일이 없으면 기본값(2000-01-01) 사용 — birthDate는 NOT NULL 컬럼
                const birthDateValue = student.birthDate || "2000-01-01T00:00:00.000Z";

                const studentRows = await tx.$queryRawUnsafe<any[]>(
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
                    link.parentId,
                    student.phone || null,
                    student.school || null,
                    student.grade || null,
                    student.address || null,
                    student.enrollDate || null,
                    student.memo || null,
                );
                const createdId: string = studentRows[0].id;

                // ── 5. 보호자1 = 주 보호자 Guardian (입력값은 계정이 아니라 Guardian 에 남긴다) ──
                await insertPrimaryGuardian(tx, createdId, guardian1.value);

                // ── 6. 보호자2,3 Guardian 테이블에 INSERT ──
                await insertGuardians(createdId, student, tx);
                return createdId;
            }, { timeout: 15_000 });

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
                            // 2026-11-14 보안 HIGH: 새 행은 개시일을 비워 둔다 — 가져오기는 «이미 다니던 원생» 이관이라
                            // NULL(기존 수강 이력 = 청구 시수·출석부 개시 제한 없음) 의미를 지킨다. 수업 피드는 등록일(가져온 날)부터 보인다.
                            // 그만둔 반을 되살릴 때만 개시일 = 오늘(KST). 이미 ACTIVE 면 기존 개시일을 건드리지 않는다(재실행 안전).
                            await prisma.$executeRawUnsafe(
                                `INSERT INTO "Enrollment" (id, "studentId", "classId", status, "createdAt", "updatedAt")
                                 VALUES (gen_random_uuid()::text, $1, $2, 'ACTIVE', NOW(), NOW())
                                 ON CONFLICT ("studentId", "classId") DO UPDATE SET status = 'ACTIVE', "startsOn" = CASE WHEN "Enrollment".status = 'ACTIVE' THEN "Enrollment"."startsOn" ELSE (NOW() AT TIME ZONE 'Asia/Seoul')::date END, "updatedAt" = NOW()`,
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
async function insertGuardians(
    studentId: string,
    student: BulkStudentInput,
    // 신규 등록은 트랜잭션(tx) 안에서 부른다. 덮어쓰기 모드는 예전처럼 prisma 로 바로 쓴다
    db: { $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number> } = prisma,
) {
    // 보호자2
    if (student.guardian2Relation || student.guardian2Phone) {
        await db.$executeRawUnsafe(
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
        await db.$executeRawUnsafe(
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
    sessionId?: string;     // 수정 모드: 고칠 기록 id(방학특강 회차 기록일 수도 있다). 없으면 새로 작성
    attendances?: Array<{   // 출석 데이터 (선택)
        studentId: string;
        status: string;     // PRESENT, ABSENT, LATE
    }>;
}) {
    await requireAdmin();
    try {
        if (data.attendances?.length) {
            const eligible = await prisma.$queryRawUnsafe<Array<{ studentId: string }>>(
                `SELECT e."studentId" FROM "Enrollment" e WHERE e."classId"=$1 AND e.status='ACTIVE'
             AND (e."startsOn" IS NULL OR e."startsOn" <= $2::date OR EXISTS (
               SELECT 1 FROM "Attendance" historical JOIN "Session" prior ON prior.id=historical."sessionId"
               WHERE historical."studentId"=e."studentId" AND prior."classId"=$1 AND prior.date::date=$2::date
             ))`, data.classId, data.date,
            );
            const ids = new Set(eligible.map(row => row.studentId));
            if (data.attendances.some(row => !ids.has(row.studentId))) throw new Error("수강 개시일 전이거나 이 수업 명단에 없는 학생입니다.");
        }
        // ── 1~3. 고칠 기록을 정하고 내용을 덮어쓴다 ──
        // 수정: 화면이 고른 기록(이 반 것인지 확인) 그대로 — 방학특강 회차 기록을 고칠 때 정규 기록이 새로 생기지 않게.
        // 새로 작성: 같은 반·같은 날 기록을 찾거나 만든다(코치 앱·출결 화면과 같은 판정 함수 findOrCreateRegularSession).
        const { sessionId, isSeasonal } = await prisma.$transaction(async tx => {
            const id = await resolveSessionLogTarget(tx, { classId: data.classId, dateYmd: data.date, sessionId: data.sessionId });
            // 방학특강 회차 기록인지 — 맞으면 아래 4단계(정규반 출석 저장)를 건너뛴다.
            const kind = await tx.$queryRawUnsafe<Array<{ seasonal: boolean }>>(
                `SELECT ("specialProgramSessionDateId" IS NOT NULL) AS seasonal FROM "Session" WHERE id = $1`,
                id,
            );
            await tx.$executeRawUnsafe(
                `UPDATE "Session" SET
                    topic = $1, content = $2, "photosJSON" = $3, "coachId" = $4, "updatedAt" = NOW()
                 WHERE id = $5`,
                data.topic || null,
                data.content || null,
                data.photosJSON || null,
                data.coachId || null,
                id,
            );
            return { sessionId: id, isSeasonal: kind[0]?.seasonal === true };
        });

        // ── 4. 출석 데이터가 있으면 각 학생별 Attendance UPSERT ──
        // 기존 saveAttendance와 동일한 ON CONFLICT 패턴 사용
        // ⚠️ 방학특강 회차 기록에는 정규반 명단 출석을 넣지 않는다.
        //    넣으면 특강을 신청하지 않은 정규반 아이들이 «출석»으로 남고,
        //    출석이 생긴 회차는 특강 날짜를 지우거나 옮길 수 없게 막힌다(session-bridge).
        if (!isSeasonal && data.attendances && data.attendances.length > 0) {
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
    // 부원장 차단(2026-11-14 원장 결정): 월 일괄 발행·미리보기·일괄 문자·발송 진행은 원장만 — 학원 전체 청구 규모가 보인다
    await requireFinanceOwner();
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
    // 부원장 차단(2026-11-14 원장 결정): 월 일괄 발행·미리보기·일괄 문자·발송 진행은 원장만 — 학원 전체 청구 규모가 보인다
    await requireFinanceOwner();
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
            // 새 청구가 설치되면 구형 고정액 생성으로 이월·0원 정산을 우회하지 못하게 한다.
            await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext('STIZ_BILLING_WORKBENCH'))");
            const installed = await tx.$queryRawUnsafe<Array<{ found: string | null }>>(`SELECT to_regclass('public."BillingWorkbenchDraft"')::text AS found`);
            if (installed[0]?.found) throw new Error("이번 달 청구 준비에서 금액을 확인해 발행해 주세요.");
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

// ── 수강료 청구 안내·미납 안내 = 발송 대기열(2026-11-13) ─────────────────────────────
// 예전: sentAt 을 먼저 전부 찍고 문자를 한 통씩 → 60초 한도에 끊기면 뒷사람 유실(«발송됨»인데 못 받음).
// 지금: «발송 예약 → 매분 cron 이 묶음 발송 → 실제 성공한 건만 sentAt» (규칙·계산은 src/lib/billing/noticeQueue.ts).
// 잠금(BILLING_PARENT_SEND_ENABLED)과 /admin/sms 규칙은 예약할 때 여기서, 보낼 때 cron(claimManualMessageQueue)에서 두 번 본다.

// 학원 대표 전화 — 청구 틀의 «문의: #{학원전화}». 조회 실패는 빈 값(금고 기본값이 대신 채운다)
async function billingAcademyPhone(): Promise<string> {
    const rows = await prisma.$queryRawUnsafe<Array<{ contactPhone: string | null }>>(
        `SELECT "contactPhone" FROM "AcademySettings" WHERE id = 'singleton' LIMIT 1`,
    ).catch(() => [] as Array<{ contactPhone: string | null }>);
    return String(rows[0]?.contactPhone ?? "").trim();
}

// 연결부: 트랜잭션 실행기(규칙 모듈은 prisma 를 직접 import 하지 않는다)
const billingNoticeTx: NoticeTx = (fn) => prisma.$transaction((tx) => fn(tx));

// 연결부: 문자 대기열 예약 — 가입 안내·대량 발송과 같은 큐(매분 cron manual-message-dispatch 가 묶음으로 보낸다)
function billingNoticeReserveQueue(actor: { appUserId: string; appUserName?: string | null }): ReserveQueueFn {
    return (input) => reserveManualMessageQueue({
        requestId: input.requestId,
        actorUserId: actor.appUserId,
        actorName: actor.appUserName ?? null,
        purpose: input.purpose,
        reason: input.reason,
        audienceScope: "EXTERNAL",
        body: input.body,
        recipients: input.recipients,
        items: input.items,
        requestedChannel: input.items.some((item) => item.kakao) ? "ALIMTALK" : "SMS",
    });
}

// 지난 발송 결과를 먼저 반영한다(끝난 건은 sentAt 이 찍혀 대상에서 빠지고, 실패한 건은 다시 대상이 된다)
async function settleBillingNoticeResults() {
    await applyBillingNoticeResults(prisma, billingNoticeTx, null).catch((error) => {
        console.warn("[billing-notice] 지난 발송 결과 반영 실패:", error instanceof Error ? error.message : error);
    });
}

const UNPAID_NOTICE_LABEL = "수강료 미납 안내";
const INVOICE_NOTICE_LABEL = "수강료 청구서 안내";

export async function sendInvoiceLinksForMonth(year: number, month: number, forceResend?: boolean) {
    // 부원장 차단(2026-11-14 원장 결정): 월 일괄 발행·미리보기·일괄 문자·발송 진행은 원장만 — 학원 전체 청구 규모가 보인다
    const admin = await requireFinanceOwner();
    // 학부모 청구 안내는 랠리즈 전담 — 잠금이면 DB 를 건드리기 전에 바로 돌려보낸다.
    // (throw 대신 결과로 돌려줘야 운영 빌드에서도 안내 문구가 가려지지 않는다)
    if (!isBillingParentSendEnabled()) {
        return { sent: 0, ok: false, locked: true, message: BILLING_PARENT_SEND_LOCKED_MESSAGE };
    }
    // 예약 시점 규칙 검사(/admin/sms 문자 틀·자동 발송 규칙·채널). 꺼져 있으면 앱 알림·기록도 만들지 않는다
    const rule = await checkBillingSendRule(prisma, BILLING_NOTICE_TRIGGER.INVOICE);
    if (!rule.ok) return { sent: 0, ok: false, message: `${rule.message} 켠 뒤 다시 눌러 주세요. 아무것도 보내지 않았습니다.` };

    await ensurePaymentInfrastructure();
    await ensureInvoicesForMonth(year, month);
    await settleBillingNoticeResults();

    const dueStart = `${year}-${String(month).padStart(2, "0")}-01`;
    const nextMonth = month === 12 ? 1 : month + 1;
    const nextYear = month === 12 ? year + 1 : year;
    const dueEnd = `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`;
    // 다시 누르면 «아직 못 받은 청구서»만(실패한 건은 sentAt 이 비어 있어 다시 대상이 된다)
    const sentFilter = forceResend ? "" : `AND i."sentAt" IS NULL`;
    const periodKey = `${year}-${String(month).padStart(2, "0")}`;

    try {
        const invoiceCandidates = await prisma.$queryRawUnsafe<Array<Omit<InvoiceNoticeRow, "amount"> & {
            id: string;
            amount: number;
            notificationHeld: boolean;
            parentHasAccount: boolean | null;
        }>>(
            `
            SELECT
              i.id,
              i.id AS "invoiceId",
              i."paymentId",
              i."studentId",
              s.name AS "studentName",
              i."parentId",
              u.phone,
              -- 가입(로그인 계정 연결) 여부 — 가입 안내 발송과 같은 기준. 없으면 비회원 결제 링크로 보낸다
              (u."authUserId" IS NOT NULL) AS "parentHasAccount",
              p.amount::int AS amount,
              -- dueDate(청구서)는 timestamptz 라 AT TIME ZONE 을 «한 번»만 건다(한국 달력 날짜)
              TO_CHAR(i."dueDate" AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS "dueYmd",
              EXISTS (
                SELECT 1 FROM "BillingNoticeDelivery" n WHERE n."noticeKey" = 'invoice:' || i.id
              ) AS "hadPriorNotice",
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
            LEFT JOIN "Student" s ON s.id = i."studentId"
            LEFT JOIN "User" u ON u.id = i."parentId"
            WHERE i.status NOT IN ('PAID', 'CANCELED')
              AND p.amount > 0
              -- 학부모 미연결(i."parentId" IS NULL) 청구서도 읽는다 — 조용히 빼지 않고 «대상 아님» 이름으로 보여 준다
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

        // 알림톡 틀 id 가 있으면 알림톡(거절되면 cron 이 같은 본문+링크를 문자로), 없으면 같은 본문+링크를 문자(LMS)로
        const templateId = alimtalkTemplateIdForEnv(BILLING_ALIMTALK_TEMPLATES.BILLING_INVOICE_PARENT.envKey);
        // 가입하지 않은 학부모 → 청구서 한 장 전용 비회원 링크(pay/<토큰>). 발급 실패한 건은 예전 로그인 링크로 나간다
        const guestPaths = await issueGuestPayPathsForNotices(invoices, { source: "INVOICE_NOTICE", createdByUserId: admin.appUserId });
        for (const row of invoices) row.payPath = guestPaths.get(row.invoiceId) ?? null;
        const plan = planInvoiceNotices(invoices, {
            month,
            academyPhone: await billingAcademyPhone(),
            templateId,
            resendYmd: forceResend ? todayKst() : null,
        });

        const reserved = await reserveBillingNotices({
            db: prisma,
            tx: billingNoticeTx,
            kind: "INVOICE",
            periodKey,
            notices: plan.notices,
            actorUserId: admin.appUserId,
            reserveQueue: billingNoticeReserveQueue(admin),
            label: `${month}월 ${INVOICE_NOTICE_LABEL}`,
        });

        // 앱 알림 — 이번에 새로 예약된 청구서만(실패 뒤 다시 보내는 건은 앱 알림을 또 만들지 않는다)
        const appIds = reserved.queued
            .filter((notice) => forceResend || !notice.hadPriorNotice)
            .flatMap((notice) => notice.invoiceIds);
        if (appIds.length > 0) {
            const placeholders = appIds.map((_, index) => `$${index + 1}`).join(",");
            await prisma.$executeRawUnsafe(
                `
                INSERT INTO "Notification" (
                    id, "userId", type, title, message, "linkUrl", "isRead", "createdAt"
                )
                SELECT
                    gen_random_uuid()::text,
                    i."parentId",
                    'PAYMENT',
                    CONCAT($${appIds.length + 1}::text, '월 수강료 청구서 안내'),
                    CONCAT(
                        s.name,
                        ' 학생 청구서가 발행되었습니다. 금액 ',
                        TO_CHAR(i.amount, 'FM999,999,999'),
                        '원, 납부기한 ',
                        TO_CHAR(i."dueDate" AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD'),
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
                ...appIds,
                String(month),
            ).catch((error) => console.error("[billing-notice] 청구서 앱 알림 생성 실패:", error));
        }

        await recordPaymentAudit({
            actorType: "ADMIN",
            actorId: admin.appUserId,
            action: "INVOICE_LINKS_QUEUED",
            message: `${reserved.queued.length} invoice notices queued`,
            metadata: {
                year, month, batchId: reserved.batchId, queueFailed: reserved.queueFailed,
                invoiceIds: reserved.queued.flatMap((notice) => notice.invoiceIds),
                unlinkedInvoiceIds: plan.unlinked.flatMap((item) => item.invoiceIds),
                // 비회원 결제 링크로 보낸 청구서(토큰 원문은 남기지 않는다)
                guestLinkInvoiceIds: [...guestPaths.keys()],
            },
        }).catch(() => undefined);

        revalidateFinanceCaches();
        revalidatePath("/mypage");

        const message = describeReservation({
            label: `${month}월 청구서 안내`,
            queued: reserved.queued,
            skippedActive: reserved.skippedActive,
            unlinked: plan.unlinked,
        }) + (reserved.queueFailed ? " 문자 대기열 예약에 실패해 문자는 보내지 않았습니다. 잠시 후 다시 눌러 주세요." : "");
        return {
            sent: reserved.queued.length,
            ok: !reserved.queueFailed,
            queued: reserved.queued.length,
            unlinked: plan.unlinked.map((item) => item.studentName),
            batchId: reserved.batchId,
            message,
        };
    } catch (e) {
        console.error("Failed to send invoice links:", e);
        throw new Error("청구서 링크 발송 실패");
    }
}

export async function sendUnpaidReminders() {
    // 부원장 차단(2026-11-14 원장 결정): 월 일괄 발행·미리보기·일괄 문자·발송 진행은 원장만 — 학원 전체 청구 규모가 보인다
    const admin = await requireFinanceOwner();
    // 학부모 청구 안내는 랠리즈 전담 — 잠금이면 미납 상태 갱신·발송 전에 바로 돌려보낸다.
    // (throw 대신 결과로 돌려줘야 운영 빌드에서도 안내 문구가 가려지지 않는다)
    if (!isBillingParentSendEnabled()) {
        return { sent: 0, failed: 0, smsSent: 0, errors: [] as string[], ok: false, locked: true, message: BILLING_PARENT_SEND_LOCKED_MESSAGE };
    }
    // 예약 시점 규칙 검사(/admin/sms 미납 문자 틀·자동 발송 규칙·채널)
    const rule = await checkBillingSendRule(prisma, BILLING_NOTICE_TRIGGER.UNPAID);
    if (!rule.ok) {
        return { sent: 0, failed: 0, smsSent: 0, errors: [rule.message], ok: false, message: `${rule.message} 켠 뒤 다시 눌러 주세요. 아무것도 보내지 않았습니다.` };
    }
    await ensurePaymentColumns();
    await ensurePaymentInfrastructure();
    await markOverduePayments();
    await settleBillingNoticeResults();

    try {
        const kstYmd = todayKst();
        // 미납 대상: 납부기한이 지난(OVERDUE) 결제이고 마지막 미납 안내 뒤 3일이 지난 것.
        //  - PENDING(기한 전·미리 만든 다음 달 청구)은 «미납»이 아니므로 보내지 않는다. 바로 위 markOverduePayments 가
        //    한국 날짜로 기한이 지난 PENDING 을 OVERDUE 로 바꿔 두었다(검수 H2 · 2026-11-13)
        //  - 예약 중·결과 확인 필요(UNCERTAIN)·최근 3일 안에 나간 안내에 들어 있는 결제도 빼서 두 번 나가지 않게
        //  - 랠리즈 청구서의 장부용 사본은 랠리즈가 이미 안내하므로 뺀다
        const unpaid = await prisma.$queryRawUnsafe<Array<UnpaidNoticeRow & { parentHasAccount: boolean | null; invoiceParentId: string | null }>>(
            `SELECT p.id AS "paymentId", i.id AS "invoiceId", p."studentId", s.name AS "studentName",
                    s."parentId", u.phone, p.amount,
                    -- 가입 여부(가입 안내와 같은 기준) — 미가입 + 미납 한 장이면 비회원 결제 링크
                    (u."authUserId" IS NOT NULL) AS "parentHasAccount",
                    -- 청구서의 대표 보호자 — 받는 사람(학생의 지금 보호자)과 다르면 비회원 링크를 쓰지 않는다
                    i."parentId" AS "invoiceParentId"
               FROM "Payment" p
               -- 학부모 묶음용 parentId 만 붙인다. 병합 필터를 ON 절에 걸어 결제 행(안내 대상)은 숨기지 않는다
               LEFT JOIN "Student" s ON s.id = p."studentId" AND ${notMergedStudent("s")}
               LEFT JOIN "User" u ON u.id = s."parentId"
               LEFT JOIN "PaymentInvoice" i ON i."paymentId" = p.id
              WHERE p.status = 'OVERDUE'
                AND p.amount > 0
                AND (p."lastReminderAt" IS NULL OR p."lastReminderAt" <= NOW() - make_interval(days => $1::int))
                AND NOT EXISTS (
                  SELECT 1 FROM "BillingNoticeDelivery" n
                   WHERE n.kind = 'UNPAID' AND p.id = ANY(n."paymentIds")
                     AND (${unpaidBlockingNoticeSql("n", "$1")})
                )
                AND ${rallyzMirrorExclusionSql("p")}`,
            UNPAID_REMINDER_INTERVAL_DAYS,
        );

        if (unpaid.length === 0) {
            return { sent: 0, message: `보낼 미납 안내가 없습니다(납부기한이 지났고, 마지막 안내 뒤 ${UNPAID_REMINDER_INTERVAL_DAYS}일이 지난 미납만 보냅니다).` };
        }

        // 알림톡 id(ALIMTALK_TPL_BILLING_UNPAID)가 있으면 미납 알림톡, 없으면 /admin/sms 미납 문자 틀 + 결제 링크
        const unpaidTemplateId = alimtalkTemplateIdForEnv(BILLING_ALIMTALK_TEMPLATES.UNPAID_PARENT.envKey);
        const smsTemplateBody = await renderSmsTemplate("UNPAID_PARENT", {
            childName: "{{childName}}", unpaidCount: "{{unpaidCount}}", totalAmount: "{{totalAmount}}",
            academyPhone: "{{academyPhone}}", paymentLink: "{{paymentLink}}",
        });
        if (!smsTemplateBody) {
            return { sent: 0, failed: 0, smsSent: 0, errors: ["미납 문자 틀이 꺼져 있습니다."], ok: false, message: "/admin/sms 에서 미납 문자 틀이 꺼져 있습니다. 켠 뒤 다시 눌러 주세요." };
        }
        // 미가입 학부모 + 그 학생의 미납이 «청구서 한 장»이면 비회원 결제 링크(여러 장 묶음은 이번 범위 밖 — 예전 경로)
        const unpaidRowsByStudent = new Map<string, number>();
        for (const row of unpaid) unpaidRowsByStudent.set(row.studentId, (unpaidRowsByStudent.get(row.studentId) ?? 0) + 1);
        const unpaidGuestPaths = await issueGuestPayPathsForNotices(
            // 받는 사람(학생의 지금 보호자 s.parentId)과 청구서 대표 보호자(i.parentId)가 같을 때만 — 엇갈리면 예전 링크
            unpaid.filter((row) => unpaidRowsByStudent.get(row.studentId) === 1
                && Boolean(row.invoiceParentId) && row.invoiceParentId === row.parentId),
            { source: "UNPAID_NOTICE", createdByUserId: admin.appUserId },
        );
        for (const row of unpaid) row.payPath = row.invoiceId ? unpaidGuestPaths.get(row.invoiceId) ?? null : null;
        const plan = planUnpaidNotices(unpaid, {
            kstYmd,
            academyPhone: await billingAcademyPhone(),
            templateId: unpaidTemplateId,
            // DB 틀의 {{변수}} 를 이 학생 값으로(관리자가 고친 문구를 그대로 쓴다)
            renderSms: (variables) => renderTemplate(smsTemplateBody, variables),
        });

        const reserved = await reserveBillingNotices({
            db: prisma,
            tx: billingNoticeTx,
            kind: "UNPAID",
            periodKey: kstYmd,
            notices: plan.notices,
            actorUserId: admin.appUserId,
            reserveQueue: billingNoticeReserveQueue(admin),
            label: UNPAID_NOTICE_LABEL,
        });

        // 학부모별로 묶어 "그 학부모 자녀의 미납만" 건수·금액을 앱 알림으로 보낸다(이번에 예약된 학생만).
        // (예전엔 학원 전체 합계를 모든 학부모에게 똑같이 보냈다)
        const reservedStudents = new Set(reserved.queued.map((notice) => notice.studentId));
        const parentSummaries = summarizeUnpaidByParent(
            unpaid
                .filter((row) => reservedStudents.has(row.studentId))
                .map((row) => ({ parentId: row.parentId, studentId: row.studentId, amount: row.amount ?? 0 })),
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

        revalidateFinanceCaches();
        const smsQueued = reserved.queued.filter((notice) => notice.channel !== "APP_ONLY").length;
        const message = describeReservation({
            label: UNPAID_NOTICE_LABEL,
            queued: reserved.queued,
            skippedActive: reserved.skippedActive,
            unlinked: plan.unlinked,
        }) + (reserved.queueFailed ? " 문자 대기열 예약에 실패해 문자는 보내지 않았습니다. 잠시 후 다시 눌러 주세요." : "");
        return {
            sent: reserved.queued.length,
            failed: reserved.queueFailed ? smsQueued : 0,
            smsSent: reserved.queueFailed ? 0 : smsQueued,
            errors: [] as string[],
            ok: !reserved.queueFailed,
            unlinked: plan.unlinked.map((item) => item.studentName),
            batchId: reserved.batchId,
            message,
        };
    } catch (e) {
        console.error("Failed to send unpaid reminders:", e);
        throw new Error("미납 알림 발송 실패");
    }
}

// 화면 진행 상황 — 이번 달 청구서 안내·오늘 미납 안내의 예약 N·발송 N·실패 N(지난 결과를 먼저 반영한다)
export async function getBillingNoticeProgress(year: number, month: number) {
    // 부원장 차단(2026-11-14 원장 결정): 월 일괄 발행·미리보기·일괄 문자·발송 진행은 원장만 — 학원 전체 청구 규모가 보인다
    await requireFinanceOwner();
    try {
        await settleBillingNoticeResults();
        const periodKey = `${year}-${String(month).padStart(2, "0")}`;
        const [invoice, unpaid] = await Promise.all([
            loadBillingNoticeProgress(prisma, "INVOICE", periodKey),
            // 미납 «결과 확인 필요»(UNCERTAIN)는 날짜와 상관없이 보인다 — 기간 없이 다시 보내기를 막으므로 원장이 확인해야 한다
            loadBillingNoticeProgress(prisma, "UNPAID", todayKst(), { includeAllUncertain: true }),
        ]);
        return { ok: true as const, invoice, unpaid };
    } catch (error) {
        console.error("[billing-notice] 진행 상황 조회 실패:", error);
        return { ok: false as const, message: "발송 진행 상황을 불러오지 못했습니다." };
    }
}

// ── 일괄 수납 상태 변경 ──────────────────────────────────────────────────────────
// 선택한 결제 건들의 상태를 한번에 변경 (체크박스 일괄 처리용)
export async function bulkUpdatePaymentStatus(ids: string[], newStatus: string) {
    await requireFinanceOwner();
    // 일괄 납부완료도 방법·근거 없이는 만들지 않는다 — recordBankTransferPayment 를 쓴다
    if (newStatus === "PAID") throw new Error(DIRECT_PAID_BLOCKED_MESSAGE);
    if (newStatus === "REFUNDED") throw new Error(DIRECT_REFUND_BLOCKED_MESSAGE);
    if (ids.length === 0) return;

    try {
        await ensurePaymentInfrastructure();
        // 납부완료가 섞여 있으면 학생 상세와 같은 규칙으로 판정(DB 에서 다시 읽음 · 2026-11-10).
        // 하나라도 막히면 아무것도 바꾸지 않는다(전부 아니면 전무). 수기 납부완료를 «대기로» 일괄 정정하는 것은
        // 화면에 없는 길이라(수납 목록은 이 함수를 부르지 않는다) 여기서도 열지 않는다 — 한 건씩 확인받는 학생 상세에서만.
        const uniqueIds = Array.from(new Set(ids));
        const rows = await prisma.$queryRawUnsafe<PaymentStatusGuardRow[]>(PAYMENT_STATUS_GUARD_SELECT, uniqueIds);
        if (rows.length !== uniqueIds.length) throw new PaymentStatusGuardError("수납 기록을 찾을 수 없습니다. 다시 조회해 주세요.");
        for (const row of rows) {
            const decision = judgePaymentStatusChange(row, newStatus);
            if (!decision.ok) throw new PaymentStatusGuardError(decision.message);
            if (decision.kind === "REVERT_PAID") {
                throw new PaymentStatusGuardError("납부완료를 대기로 되돌리는 것은 학생 상세에서 한 건씩 해 주세요.");
            }
        }

        const placeholders = ids.map((_, i) => `$${i + 2}`).join(",");
        const invoiceStatus = newStatus === "OVERDUE"
            ? "OVERDUE"
            : ["REFUNDED", "CANCELED"].includes(newStatus)
                ? "CANCELED"
                : "ISSUED";
        // Payment·청구서를 한 트랜잭션으로 — 건수가 맞지 않으면(그 사이 납부완료가 된 청구) 전체를 되돌린다
        await prisma.$transaction(async (tx) => {
            // 조건부 UPDATE — 판정 뒤 그 사이 납부완료가 된 청구는 덮지 않는다
            const updated = await tx.$executeRawUnsafe(
                `UPDATE "Payment" SET status = $1, "paidDate" = NULL, "updatedAt" = NOW() WHERE id IN (${placeholders}) AND status <> 'PAID'`,
                newStatus,
                ...ids,
            );
            if (Number(updated) !== uniqueIds.length) {
                // 일부만 바뀌었다 — 던져서 트랜잭션 전체를 롤백(하나도 바뀌지 않음)
                throw new PaymentStatusGuardError(PAYMENT_STATUS_RACE_MESSAGE);
            }
            await tx.$executeRawUnsafe(
                `UPDATE "PaymentInvoice" SET status = $1, "updatedAt" = NOW() WHERE "paymentId" IN (${placeholders})`,
                invoiceStatus,
                ...ids,
            );
        });
        await recordPaymentAudit({
            actorType: "ADMIN",
            action: "PAYMENT_BULK_STATUS_UPDATE",
            message: `Payment bulk status changed to ${newStatus}`,
            metadata: { paymentIds: ids },
        });
    } catch (e) {
        // 규칙 거절은 안내 문구 그대로
        if (e instanceof PaymentStatusGuardError) throw new Error(e.message);
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
    let entries = TRIAL_LEAD_COLUMNS
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

    // 희망 요일·교시를 고치면 옛 수업 키도 함께 갱신한다. 확정 반·일시는 별도로 보존한다.
    const preferencePatch = normalizedTrialPreferencePatch(data, previousLead);
    Object.assign(data, preferencePatch);
    entries = TRIAL_LEAD_COLUMNS
        .filter((col) => data[col] !== undefined)
        .map((col) => [col, data[col]] as const);

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

    // 체험 완료 감사 문자(TRIAL_ATTENDED_PARENT)는 2026-11-09 원장 결정으로 없앴다(가입 유도 문구 · 알림톡 심사 반려 위험).
    // 화면·테스트가 쓰는 응답 모양은 그대로 두고 «보내지 않음»으로 고정한다.
    const attendedSmsResult: { attempted: boolean; sent: boolean; message?: string } = {
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

        // 체험 날짜·반이 바뀌면 선생님이 예전 일정에 찍은 체험 출결은 새 일정과 무관하다 → 비운다(검수 MED-2).
        // 남겨 두면 새 수업 출석부에 «이미 출석»으로 떠서 선생님이 못 찍는다.
        // 본 저장과 따로 둔다 — 체험 출결 칸 마이그레이션 전이어도 관리자 저장은 실패하지 않게(로그만 남김).
        if (data.scheduledDate !== undefined || data.scheduledClassId !== undefined) {
            try {
                await prisma.$executeRawUnsafe(
                    `UPDATE "TrialLead"
                        SET "staffAttendanceStatus" = NULL, "staffAttendanceAt" = NULL, "staffAttendanceByUserId" = NULL
                      WHERE id = $1
                        AND ("scheduledDate" IS DISTINCT FROM $2::timestamptz OR "scheduledClassId" IS DISTINCT FROM $3::text)`,
                    id,
                    previousLead.scheduledDate ?? previousLead.scheduleddate ?? null,
                    previousLead.scheduledClassId ?? previousLead.scheduledclassid ?? null,
                );
            } catch (resetError) {
                console.warn("[updateTrialLead] 체험 출결 초기화 실패:", (resetError as Error).message);
            }
        }

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

// (2026-11-09) 체험 완료 문자 재시도 액션 resendTrialAttendedSms 는 문자 자체를 없애며 함께 지웠다.

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
        // 주 보호자 관계 — 체험 전환 창엔 칸이 없어 비우면 «보호자»로 저장
        parentRelation?: string | null;
        // 예전 화면 호환용으로 받기만 하고 쓰지 않는다(이메일로 계정을 찾지 않는다)
        parentEmail?: string | null;
        memo?: string | null;
    }
): Promise<AdminStudentCreateResult> {
    await requireAdmin();
    await ensureTrialLeadTable();

    const name = String(studentData.name ?? "").trim();
    if (!name || !studentData.birthDate) return { ok: false, error: "아이 이름과 생년월일을 입력해 주세요." };
    // 학부모 계정은 목록 «원생 등록»과 같은 규칙(parentAccountLink) — 주 보호자 휴대폰 필수
    const guardian = validatePrimaryGuardian({
        relation: studentData.parentRelation?.trim() || "보호자",
        name: studentData.parentName,
        phone: studentData.parentPhone,
    });
    if (!guardian.ok) return { ok: false, error: guardian.error };

    let result: AdminStudentCreateResult;
    try {
        result = await prisma.$transaction(async (tx) => {
            // 1. 학부모 계정 확정 + Student + 주 보호자 Guardian
            const created = await insertAdminStudentWithGuardian(
                tx,
                { name, birthDate: studentData.birthDate, gender: studentData.gender, memo: studentData.memo },
                guardian.value,
            );
            // 2. TrialLead 전환 처리 (상태 + 전환일 + 연결 Student ID) — 같은 트랜잭션이라 학생만 생기고 전환이 빠지는 일이 없다
            await tx.$executeRawUnsafe(
                `UPDATE "TrialLead"
                 SET status = 'CONVERTED', "convertedDate" = NOW(), "convertedStudentId" = $1, "updatedAt" = NOW()
                 WHERE id = $2`,
                created.studentId, leadId,
            );
            return { ok: true as const, ...created };
        }, { timeout: 15_000 });
    } catch (e) {
        if (e instanceof ParentAccountLinkError) return { ok: false, error: e.message };
        console.error("Failed to convert trial to student:", e);
        throw new Error("정규 등록 전환 실패");
    }
    revalidatePath("/admin/trial");
    revalidatePath("/admin/apply");
    revalidatePath("/admin/students");
    revalidatePath("/admin");
    revalidateTrialAdminCaches();
    revalidateStudentAdminCaches();
    return result;
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
            // 2026-11-14 보안 HIGH: 개시일 = 오늘(KST). 되살리기도 오늘부터, 이미 ACTIVE 면 기존 개시일 유지.
            await prisma.$executeRawUnsafe(
                `INSERT INTO "Enrollment" (id, "studentId", "classId", status, "startsOn", "createdAt", "updatedAt")
                 VALUES (gen_random_uuid()::text, $1, $2, 'ACTIVE', (NOW() AT TIME ZONE 'Asia/Seoul')::date, NOW(), NOW())
                 ON CONFLICT ("studentId", "classId") DO UPDATE SET status = 'ACTIVE', "startsOn" = CASE WHEN "Enrollment".status = 'ACTIVE' THEN "Enrollment"."startsOn" ELSE (NOW() AT TIME ZONE 'Asia/Seoul')::date END, "updatedAt" = NOW()`,
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
                -- makeupDate 는 timestamptz, DB 는 UTC — 한국 날짜로 바꿔 센다(학부모 예약은 KST 자정 = 전날 15:00Z 로 저장된다. 2026-11-14)
                AND (ms."makeupDate" AT TIME ZONE 'Asia/Seoul')::date = $2::date
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
        await prisma.$transaction(async tx => {
            await lockCompensation(tx);
            await assertRegularMakeupAllowed(tx, { studentId: data.studentId, classId: data.originalClassId, dateYmd: data.originalDate.slice(0, 10) });
            await tx.$executeRawUnsafe(
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
        });
    } catch (e) {
        if (e instanceof CompensationConflict) throw e;
        console.error("Failed to book makeup session:", e);
        throw new Error("보강 예약 실패");
    }
    revalidatePath("/admin/makeup");
    revalidateMakeupAdminCaches();
}

/**
 * 보강 취소 — 상태 변경(CANCELLED)과 같은 길을 탄다.
 * 예전엔 MakeupSession 만 바꿔서 보강권이 «예약됨»에 묶인 채 남았다(다시 못 씀).
 * updateMakeupStatus 가 잠금 + 보강권 복구(RESERVED → AVAILABLE)까지 한다.
 */
export async function cancelMakeupSession(id: string) {
    await requireAdmin();
    const [row] = await prisma.$queryRawUnsafe<{ status: string }[]>(
        `SELECT status FROM "MakeupSession" WHERE id = $1`,
        id,
    );
    if (!row) throw new Error("보강을 찾을 수 없습니다.");
    if (row.status === "CANCELLED") return; // 이미 취소됨
    // 다녀온(ATTENDED)·노쇼(NO_SHOW) 보강을 취소하면 사용완료·차감된 보강권이 되살아난다 → 예약 상태만 허용
    if (row.status !== "BOOKED") throw new Error("예약 상태인 보강만 취소할 수 있습니다.");
    await updateMakeupStatus(id, "CANCELLED");
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
        await prisma.$transaction(async tx => {
            await lockCompensation(tx);
            if (status !== "CANCELLED") await assertMakeupSessionAllowed(tx, id);
            await tx.$executeRawUnsafe(
            `UPDATE "MakeupSession" SET status = $1, "updatedAt" = NOW() WHERE id = $2`,
            status,
            id,
            );
        });
    } catch (e) {
        if (e instanceof CompensationConflict) throw e;
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
        startOn?: string;         // 관리자가 확인한 개시일(없으면 신청 날짜)
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
        // 각 반의 정원과 '현재 ACTIVE 수강 인원(병합 제외)'을 비교한다 — 새 «원생 등록»과 같은 함수(class-capacity) 한 곳.
        const overCapacity = await findOverCapacityClasses(prisma, data.classIds);
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

    let registrationGuide: { studentId: string; usesShuttle: boolean } | null;
    try {
        registrationGuide = await prisma.$transaction(async (tx) => {
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
        const startOn = requireCommencement(data.startOn ?? commencementYmd(app.requestedStartOn ?? app.requestedstarton));

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
            // 이미 수강 중인 반은 새 신청의 개시일로 덮을 수 없다. 첫 쓰기 전에 충돌을 차단한다.
            const activeConflicts = await tx.$queryRawUnsafe<Array<{ classId: string }>>(
                `SELECT "classId" FROM "Enrollment" WHERE "studentId"=$1
                   AND "classId"=ANY($2::text[]) AND status='ACTIVE' FOR UPDATE`, studentId, data.classIds,
            );
            if (activeConflicts.length) throw new Error("이미 수강 중인 반이 포함되어 있습니다. 기존 수강은 유지하고 새로 등록할 반만 선택해 주세요.");
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
                 VALUES (gen_random_uuid()::text, $1, $2::timestamptz, $3, $4, $5, $6, $7, $8, $9, $10::date, NOW(), NOW())
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
                startOn,
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
        let enrollmentChanged = false;
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
            enrollmentChanged = true;

            const [enrollment] = await tx.$queryRawUnsafe<Array<{ id: string; updatedAt: Date }>>(
                `INSERT INTO "Enrollment" (id, "studentId", "classId", status, "startsOn", "createdAt", "updatedAt")
                 VALUES (gen_random_uuid()::text, $1, $2, 'ACTIVE', $3::date, NOW(), NOW())
                 ON CONFLICT ("studentId", "classId") DO UPDATE
                   SET status = 'ACTIVE', "startsOn" = EXCLUDED."startsOn", "updatedAt" = NOW()
                 RETURNING id, "updatedAt"`,
                studentId, classId, startOn,
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
                effectiveDate: startOn,
            });
            if (event) await enqueueWebsiteOperationsEventInTransaction(tx, event);
        }

        // 학부모가 지도에서 확인한 탑승·하차 위치는 함께 저장한다.
        if (shouldCopyShuttleLocations) {
            // 저장 SQL(INSERT INTO "StudentShuttleLocation" … ON CONFLICT ("studentId", kind) DO UPDATE)은
            // 새 «원생 등록»과 같은 함수(student-shuttle-location-upsert) 한 곳에 있다. 값은 신청서에서 그대로 읽는다.
            const upsertLocation = (
                kind: "PICKUP" | "DROPOFF",
                prefix: "shuttlePickup" | "shuttleDropoff",
            ) => upsertStudentShuttleLocation(tx, {
                studentId: studentId!,
                kind,
                // 장소명(라벨) — G2에서 EnrollmentApplication.shuttlePickup/shuttleDropoff 라벨 컬럼에 저장된 값.
                // prefix 자체가 라벨 컬럼명(접미사 없는 shuttlePickup/shuttleDropoff)이라 그대로 읽는다.
                // 값이 없으면 공용 함수가 도로명주소 -> 지번주소 순으로 폴백한다(name null 방지).
                name: readAppField(prefix),
                address: readAppField(`${prefix}Address`),
                roadAddress: readAppField(`${prefix}RoadAddress`),
                latitude: readAppField(`${prefix}Latitude`),
                longitude: readAppField(`${prefix}Longitude`),
                placeId: readAppField(`${prefix}PlaceId`),
                source: readAppField(`${prefix}Source`),
                accuracyMeters: readAppField(`${prefix}AccuracyMeters`),
                confirmedAt: readAppField(`${prefix}ConfirmedAt`),
                consentVersion,
            });
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
                     "requestedStartOn" = $6::date,
                 "updatedAt" = NOW()
             WHERE id = $4`,
            studentId,
            data.processedNote || null,
            data.classIds.join(","),
            applicationId,
            parentId,
            startOn,
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
        return enrollmentChanged ? { studentId, usesShuttle: shuttleNeeded } : null;
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

    // 등록이 확정된 뒤에만 별도 자동 발송 설정을 적용한다.
    if (registrationGuide) {
        try {
            const guide = await sendEnrollGuideIfEnabled(registrationGuide.studentId, { usesShuttle: registrationGuide.usesShuttle });
            smsResult.parentSent = guide.sent;
            smsResult.parentFailed = !guide.sent && guide.reason !== "OFF";
        } catch {
            smsResult.parentFailed = true;
        }
    }
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
    "requestedStartOn", "enrollmentMonths", "preferredSlotKeys", "assignedClassId",
    "basketballExp", "uniformSize",
    "shuttleNeeded", "shuttlePickup", "shuttleTime", "shuttleDropoff",
    "paymentMethod", "referralSource", "memo",
    "applicationNoticeConfirmed", "shuttleNoticeConfirmed", "processedNote",
] as const;

type EnrollApplicationColumn = (typeof ENROLL_APPLICATION_COLUMNS)[number];

// 관리자 수정 화면이 직접 손대지 않는 셔틀 위치·동의 컬럼.
// 셔틀을 끌 때 **한 묶음으로 전부** 비워야 한다 — DB 제약이 "일부만 남은 상태"도 거부한다.
// 순서·구성은 마이그레이션의 shuttle_location_complete_check ROW(...) 와 같게 유지한다.
const SHUTTLE_LOCATION_COLUMNS = [
    "shuttlePickupAddress", "shuttlePickupRoadAddress",
    "shuttlePickupLatitude", "shuttlePickupLongitude", "shuttlePickupPlaceId",
    "shuttlePickupSource", "shuttlePickupAccuracyMeters", "shuttlePickupConfirmedAt",
    "shuttleDropoffAddress", "shuttleDropoffRoadAddress",
    "shuttleDropoffLatitude", "shuttleDropoffLongitude", "shuttleDropoffPlaceId",
    "shuttleDropoffSource", "shuttleDropoffAccuracyMeters", "shuttleDropoffConfirmedAt",
    "shuttleLocationConsentVersion", "shuttleLocationConsentAt",
] as const;

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
    requestedStartOn: "수강 개시일",
    enrollmentMonths: "기존 신청 월",
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

        if (data.requestedStartOn !== undefined) data = { ...data, requestedStartOn: requireCommencement(data.requestedStartOn) };

        const entries = ENROLL_APPLICATION_COLUMNS
            .filter((col) => data[col] !== undefined)
            .map((col) => [col, data[col]] as const);
        if (entries.length === 0) return;

        // 셔틀을 끄면 지도 좌표와 위치정보 동의까지 함께 비운다.
        // DB 제약(EnrollmentApplication_shuttle_location_complete_check)이 "셔틀 미이용인데 좌표가 남은 상태"를
        // 아예 거부하므로, 라벨만 지우고 좌표를 두면 UPDATE 가 통째로 실패해 **관리자가 셔틀을 취소할 방법이 없다**
        // (승인 화면까지 가지도 못하고 "수강 신청 수정 실패" 로 끝난다).
        // 학부모 신청 경로(public.ts)는 이미 같은 방식으로 함께 비운다 — 관리자 경로만 빠져 있었다.
        const clearsShuttleLocation = data.shuttleNeeded === false;
        const hadShuttleLocation = clearsShuttleLocation
            && SHUTTLE_LOCATION_COLUMNS.some((col) => (apps[0][col] ?? apps[0][col.toLowerCase()]) != null);

        const historyNote = [
            buildEnrollApplicationUpdateNote(apps[0], entries),
            // 개인정보(좌표)를 지운 사실은 이력에 남긴다.
            hadShuttleLocation ? "셔틀 위치정보·동의 기록 삭제" : null,
        ].filter(Boolean).join(" / ");

        const setClauses = [
            ...entries.map(([col], index) => {
                const isDate = ["childBirthDate"].includes(col);
                return `"${col}" = $${index + 1}${col === "requestedStartOn" ? "::date" : isDate ? "::timestamptz" : ""}`;
            }),
            ...(clearsShuttleLocation ? SHUTTLE_LOCATION_COLUMNS.map((col) => `"${col}" = NULL`) : []),
        ].join(", ");
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
    // 문구에 «문의: 학원 전화»를 넣기 위해 설정의 대표 번호를 함께 넘긴다.
    const settingsRows = await prisma.$queryRawUnsafe<any[]>(
        `SELECT "contactPhone" FROM "AcademySettings" WHERE id = 'singleton' LIMIT 1`,
    );
    const academyPhone = settingsRows[0]?.contactPhone ?? settingsRows[0]?.contactphone ?? "";
    const templateVariables = { childName, parentName, enrollLink, academyPhone };
    const renderedMessage = await renderSmsTemplate("TRIAL_ENROLL_GUIDE_PARENT", templateVariables);
    if (!renderedMessage) {
        return {
            enrollLink,
            sent: false,
            message: "수강신청 안내 문자 템플릿을 사용할 수 없습니다.",
        };
    }

    // 2026-11-07: 준비물·스포츠고글 제휴 안내가 들어가며 단문(한글 45자)을 넘는다.
    // 단문 강제를 풀어 길이에 따라 SMS/LMS 가 자동으로 정해지게 한다(장문 건당 45원).
    const smsResult = await sendParentSmsWithResult(
        parentPhone || "",
        "TRIAL_ENROLL_GUIDE_PARENT",
        templateVariables,
        {
            eventType: "TRIAL_ENROLL_GUIDE",
            eventId: `trial:${trialLeadId}:enroll-guide`,
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
            // DB 틀이 없을 때의 대체 문구 — 기본 틀(TRIAL_CONFIRM_PARENT)과 글자를 맞췄다(머리말 통일·«확정 시»)
            || `${PARENT_MESSAGE_PREFIX} ${childName} 체험수업 신청이 접수되었습니다.\n일정 확정 시 다시 안내드리겠습니다.\n문의: ${academyPhone}`;
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
    // 머리말(2026-11-09): 학부모(EXTERNAL) = [스티즈농구교실], 직원(INTERNAL) = 예전 [STIZ]
    const body = `${manualMessagePrefix(options.audienceScope || "EXTERNAL")} ${message.trim()}`;
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

    const purpose = options?.purpose?.trim() || "관리자 수동 문자 발송";
    const reason = options?.reason?.trim() || "관리자 문자센터에서 직접 발송";
    const audienceScope = options?.audienceScope || "INTERNAL";
    // 머리말(2026-11-09): 학부모(EXTERNAL) = [스티즈농구교실], 직원(INTERNAL) = 예전 [STIZ]
    const body = `${manualMessagePrefix(audienceScope)} ${message.trim()}`;
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

// 알림톡으로 바뀐 학부모 문구의 본문 수정 거절 안내(화면이 그대로 보여 준다)
const SMS_TEMPLATE_ALIMTALK_LOCKED = "카카오 알림톡에 등록한 문구라 여기서 고칠 수 없습니다. 바꾸려면 개발 요청 후 카카오 재심사가 필요합니다.";

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
            // 알림톡 등록 문구(코드 금고가 정본)는 화면에서 본문을 바꿀 수 없다 — 켜기/끄기만 허용
            if (data.body !== undefined && data.body !== before.body && isParentAlimtalkTrigger(before.trigger)) {
                throw new Error(SMS_TEMPLATE_ALIMTALK_LOCKED);
            }
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
        if ((e as Error).message === SMS_TEMPLATE_ALIMTALK_LOCKED) throw e;
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
            // 학부모 문구 — 머리말 [스티즈농구교실] 통일(2026-11-09). 수강 확정·수납 안내는 보내는 코드가 없어 뺐다.
            TRIAL_CONFIRM_PARENT: `${PARENT_MESSAGE_PREFIX} {{childName}} 체험수업 신청이 접수되었습니다.\n일정 확정 시 다시 안내드리겠습니다.\n문의: {{academyPhone}}`,
            ENROLL_CONFIRM_PARENT: `${PARENT_MESSAGE_PREFIX} {{childName}} 수강 신청이 접수되었습니다.\n승인 후 안내드리겠습니다.\n문의: {{academyPhone}}`,
            // 미납 안내 = 결제 링크 포함 문구(smsTemplate.ts 기본값과 같은 상수 · 2026-11-13)
            UNPAID_PARENT: UNPAID_PARENT_DEFAULT_BODY,
        };

        // 알림톡 금고 트리거는 금고 문구로 복원한다(체험 일정 확정·수강신청서 안내·셔틀·특강 5종)
        const defaultBody = isParentAlimtalkTrigger(trigger)
            ? parentAlimtalkSmsTemplateBody(trigger)
            : defaultBodies[trigger];
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
            // 알림톡 금고 문구는 «문구만 맞추고» 켜짐/꺼짐은 그대로 둔다(꺼 둔 특강 접수·승인이 켜지지 않게)
            const keepActive = isParentAlimtalkTrigger(trigger);
            await tx.$executeRawUnsafe(
                `UPDATE "SmsTemplate" SET body = $1, "isActive" = CASE WHEN $3::boolean THEN "isActive" ELSE true END, "updatedAt" = NOW() WHERE id = $2`,
                defaultBody,
                id,
                keepActive,
            );
            if (availability.automationAvailable && !keepActive) {
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

// createStaffUser(«직접 추가» — 로그인 계정 없는 직원 기록 생성)는 2026-11-12 원장 결정으로 없앴다.
// 직원은 초대로만 추가한다. 이미 있는 직접 추가 기록은 convertDirectStaffToInvite 로 앱 계정에 연결한다.

// 스태프 화면 역할 선택칸의 값 전부 / 코치 프로필을 연결해 쓰는 역할(화면 canLinkCoach 와 같은 집합)
type StaffRoleValue = "ADMIN" | "VICE_ADMIN" | "INSTRUCTOR" | "DRIVER" | "PARENT";
const STAFF_ROLE_VALUES: readonly StaffRoleValue[] = ["ADMIN", "VICE_ADMIN", "INSTRUCTOR", "DRIVER", "PARENT"];
const COACH_LINKABLE_ROLES: readonly StaffRoleValue[] = ["ADMIN", "VICE_ADMIN", "INSTRUCTOR"];

/**
 * updateUserRole — 사용자 역할 변경 (requireOwner: ADMIN만)
 * ADMIN은 다른 사용자의 역할을 변경할 수 있지만, 자기 자신을 변경할 수 없음
 */
export async function updateUserRole(userId: string, newRole: "ADMIN" | "VICE_ADMIN" | "INSTRUCTOR" | "DRIVER" | "PARENT") {
    const user = await requireOwner();
    await ensureStaffColumns();

    // 화면 선택칸 밖에서 들어온 값은 막는다(DB 형변환 오류 대신 알아듣는 안내).
    if (!STAFF_ROLE_VALUES.includes(newRole)) {
        throw new Error("바꿀 수 없는 역할입니다.");
    }

    try {
        // 자기 자신의 역할 변경 방지 (실수로 ADMIN 권한을 잃는 것 방지)
        // 2026-11-12: 이메일 글자 비교만으로는 대소문자가 다르면 빠져나가 앱 사용자 ID 로도 확인한다.
        if (userId === user.appUserId) {
            throw new Error("자기 자신의 역할은 변경할 수 없습니다.");
        }
        const targetRows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT email FROM "User" WHERE id = $1 LIMIT 1`,
            userId,
        );
        if (targetRows.length === 0) {
            throw new Error("대상 직원을 찾을 수 없습니다. 목록을 새로고침해 주세요.");
        }
        if (String(targetRows[0].email || "").toLowerCase() === String(user.email || "").toLowerCase()) {
            throw new Error("자기 자신의 역할은 변경할 수 없습니다.");
        }

        await prisma.$transaction(async (tx) => {
            // 대상 줄을 먼저 잠근다 — 가입 처리(acceptInvitation)도 같은 순서(직원 기록 → 초대)로 잠가 서로 기다린다
            const before = await tx.$queryRawUnsafe<Array<{ role: string }>>(
                `SELECT role::text AS role FROM "User" WHERE id = $1 FOR UPDATE`,
                userId,
            );
            await tx.$executeRawUnsafe(
                `UPDATE "User" SET role = $1::"Role", "updatedAt" = NOW() WHERE id = $2`,
                newRole,
                userId,
            );
            // 2026-11-12 검수: 역할이 바뀌면 이 사람을 향한 대기·처리 중 초대(앱 계정 전환·재설정·재입사)를 취소한다.
            // 그대로 두면 강등 뒤 옛 전환 링크로 가입할 때 역할이 다시 올라간다(가입이 역할을 되돌리는 길).
            // 처리 중(PROCESSING)도 취소 — 가입 거래가 마지막에 «PROCESSING 그대로인가»를 확인하므로 그쪽이 전부 되돌린다.
            if (before[0] && before[0].role !== newRole) {
                await tx.$executeRawUnsafe(
                    `UPDATE "StaffInvitation" SET status = 'CANCELLED', "updatedAt" = NOW()
                      WHERE "targetUserId" = $1 AND status IN ('PENDING', 'PROCESSING')`,
                    userId,
                );
            }
            // 2026-11-12 고장 수정: 코치/강사 → 셔틀 기사·학부모로 바꾸면 코치 프로필 연결(Coach.userId)이 남았다.
            // 기사 줄에는 코치 연결 칸이 없고 학부모는 목록에서 빠져서 «해제할 길이 없는 연결»이 되고,
            // 그 코치 프로필은 다른 사람에게도 연결할 수 없었다(선택칸에서 [연결됨]으로 막힘).
            // → 코치 연결을 쓰는 역할(원장·부원장·코치)이 아니면 같은 거래 안에서 연결을 푼다.
            //   단, 승인된 «선생님» 추가 역할(UserRoleGrant ACTIVE)이 있으면 그 역할로 코치 일을 하므로 그대로 둔다.
            if (!COACH_LINKABLE_ROLES.includes(newRole)) {
                await tx.$executeRawUnsafe(
                    `UPDATE "Coach" SET "userId" = NULL, "updatedAt" = NOW()
                      WHERE "userId" = $1
                        AND NOT EXISTS (
                          SELECT 1 FROM "UserRoleGrant"
                           WHERE "userId" = $1 AND role = 'INSTRUCTOR' AND status = 'ACTIVE'
                        )`,
                    userId,
                );
            }
        });
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
        // 2026-11-12 고장 수정: 예전에는 «기존 연결 해제 → 새 연결»이 따로따로 실행돼서,
        // 그 사이 다른 사람이 같은 코치를 잡거나 코치가 지워졌으면 기존 연결만 풀리고 새 연결은 0건으로 조용히 끝났다.
        // → 한 거래로 묶고, 새 연결이 정확히 1건 바뀌었는지 확인한다(아니면 전부 되돌린다).
        await prisma.$transaction(async (tx) => {
            if (coachId) {
                // 코치 연결은 원장·부원장·코치(또는 승인된 선생님 역할)에게만 — 화면 선택칸과 같은 기준
                const targets = await tx.$queryRawUnsafe<Array<{ role: string; hasInstructorGrant: boolean }>>(
                    `SELECT u.role::text AS role,
                            EXISTS (
                              SELECT 1 FROM "UserRoleGrant" g
                               WHERE g."userId" = u.id AND g.role = 'INSTRUCTOR' AND g.status = 'ACTIVE'
                            ) AS "hasInstructorGrant"
                       FROM "User" u WHERE u.id = $1 LIMIT 1`,
                    userId,
                );
                const target = targets[0];
                if (!target) throw new Error("대상 직원을 찾을 수 없습니다. 목록을 새로고침해 주세요.");
                if (!COACH_LINKABLE_ROLES.includes(target.role as StaffRoleValue) && !target.hasInstructorGrant) {
                    throw new Error("코치 프로필은 원장·부원장·코치/강사 계정에만 연결할 수 있습니다.");
                }

                // 기존에 이 유저에게 연결된 코치가 있으면 해제
                await tx.$executeRawUnsafe(
                    `UPDATE "Coach" SET "userId" = NULL, "updatedAt" = NOW() WHERE "userId" = $1 AND id <> $2`,
                    userId,
                    coachId,
                );

                // 새 코치 연결 — 비어 있거나 이미 이 사람에게 연결된 코치만(다른 사람 연결은 빼앗지 않는다)
                const linked = await tx.$executeRawUnsafe(
                    `UPDATE "Coach" SET "userId" = $1, "updatedAt" = NOW()
                      WHERE id = $2 AND ("userId" IS NULL OR "userId" = $1)`,
                    userId,
                    coachId,
                );
                if (linked !== 1) {
                    throw new Error("이 코치는 이미 다른 사용자에게 연결되어 있거나 삭제되었습니다.");
                }
            } else {
                // 연결 해제
                await tx.$executeRawUnsafe(
                    `UPDATE "Coach" SET "userId" = NULL, "updatedAt" = NOW() WHERE "userId" = $1`,
                    userId,
                );
            }
        });
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
const STAFF_ROLE_LABEL: Record<string, string> = { ADMIN: "원장", VICE_ADMIN: "부원장", INSTRUCTOR: "코치/강사", DRIVER: "셔틀 기사" };

/**
 * 초대 거절 사유 — throw 하면 운영 빌드에서 서버 액션 오류 문구가 가려져 화면엔 «만들지 못했습니다»만 보인다
 * (2026-11-12 김영중 기사: 이미 가입된 계정인데 이유가 안 보임). 예상된 거절은 값으로 돌려준다.
 */
function inviteStaffRejected(error: string, extra: { resetAvailable?: boolean } = {}) {
    return { rejected: true as const, error, resetAvailable: extra.resetAvailable === true };
}

export async function inviteStaff(data: {
    name: string;
    phone: string;
    role: "INSTRUCTOR" | "DRIVER";
}) {
    const user = await requireOwner();
    await ensureStaffInvitationTable();

    if (data.role !== "INSTRUCTOR" && data.role !== "DRIVER") {
        return inviteStaffRejected("초대는 선생님 또는 기사 역할만 선택할 수 있습니다.");
    }
    const staffRole = data.role;
    const staffRoleLabel = staffRole === "DRIVER" ? "셔틀 기사" : "코치/강사";

    const cleanName = data.name.trim();
    const cleanPhone = data.phone.replace(/\D/g, "");
    if (!cleanName) {
        return inviteStaffRejected("이름을 입력해 주세요.");
    }
    if (!/^010\d{8}$/.test(cleanPhone)) {
        return inviteStaffRejected("휴대전화 번호는 010으로 시작하는 11자리 숫자로 입력해 주세요.");
    }

    // 같은 번호로 PENDING 상태인 초대가 이미 있는지 확인
    const existing = await prisma.$queryRawUnsafe<any[]>(
        `SELECT id FROM "StaffInvitation"
         WHERE phone = $1 AND status = 'PENDING' AND "expiresAt" > NOW()
         LIMIT 1`,
        cleanPhone,
    );
    if (existing.length > 0) {
        return inviteStaffRejected("이 번호로 대기 중인 초대가 이미 있습니다. 대기 중인 초대 목록에서 다시 보내거나 취소한 뒤 만들어 주세요.");
    }

    // 이미 가입된 스태프인지 확인
    // 번호는 숫자만 비교한다(「010-1234-5678」과 「01012345678」을 같은 사람으로).
    const existingUser = await prisma.$queryRawUnsafe<Array<{ id: string; name: string; role: string; createdAt: Date | null; email: string | null; authUserId: string | null }>>(
        `SELECT id, name, role::text AS role, "createdAt", email, "authUserId" FROM "User"
          WHERE regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = $1
            AND role IN ('ADMIN','VICE_ADMIN','INSTRUCTOR','DRIVER') AND "withdrawnAt" IS NULL
          LIMIT 1`,
        cleanPhone,
    );
    if (existingUser.length > 0) {
        const found = existingUser[0];
        // 2026-11-12 검수: «직접 추가»(로그인 없음) 기록이면 비밀번호 재설정이 아니라 [초대로 전환]이 맞는 길이다
        if (staffLoginKind(found) === "none") {
            return inviteStaffRejected(
                `${found.name}님은 로그인 없이 직접 추가된 직원입니다. 스태프 목록에서 ${found.name}님을 눌러 패널의 [초대로 전환]을 눌러 주세요.`,
            );
        }
        const roleLabel = STAFF_ROLE_LABEL[found.role] ?? "스태프";
        const joined = found.createdAt ? ` ${new Date(found.createdAt).toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" })} 가입` : "";
        const resettable = found.role === "INSTRUCTOR" || found.role === "DRIVER";
        const loginId = found.email ? ` 로그인 아이디는 ${found.email} 입니다.` : "";
        return inviteStaffRejected(
            `이미 가입된 ${roleLabel} 계정이 있습니다(${found.name}${joined}). 새 초대는 필요 없습니다.${loginId}`
                + (resettable ? " 비밀번호를 모르면 아래 [비밀번호 재설정 링크 보내기]를 눌러 주세요." : ""),
            { resetAvailable: resettable },
        );
    }

    // 다중 역할(2026-10-25): 이 번호의 학부모 계정이 이미 있으면 새 계정을 만들지 않고
    // 그 계정에 역할을 붙인다. 초대 수락은 항상 새 로그인 계정(전화번호@staff)을 만들어서,
    // 그대로 두면 같은 사람의 계정이 둘로 갈린다(학부모 계정 + 직원 계정).
    //
    // ⚠️ 붙이는 조건은 엄격하다 — 휴대폰 인증까지 끝났고(번호 주인이 확인됨) 탈퇴하지 않은 학부모
    //    계정이 «정확히 하나»일 때만. 번호만 같은 미인증 계정에 붙이면 엉뚱한 사람에게 학생 정보가 열린다.
    //    둘 이상이면 누군지 모르므로 예전처럼 초대 링크를 보낸다.
    //    원장이 직접 초대하는 것이므로 승인과 같다(requireOwner) — 신청 중이던 건이 있으면 그대로 승인된다.
    // 번호는 숫자만 남겨 비교한다 — 글자 그대로 비교하면 「010-1234-5678」과 「01012345678」이
    // 다른 사람이 된다(2026-09-28 4가족 사고). 빈 번호·자리채움 번호는 열쇠로 쓰지 않는다.
    const inviteDigits = parentPhoneDigits(cleanPhone);
    const parentAccounts = isUsablePhoneKey(inviteDigits)
        ? await prisma.$queryRawUnsafe<Array<{ id: string; name: string }>>(
            `SELECT id, name FROM "User"
              WHERE regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = $1 AND role = 'PARENT'
                AND "phoneVerifiedAt" IS NOT NULL AND "withdrawnAt" IS NULL
              LIMIT 2`,
            inviteDigits,
        )
        : [];
    if (parentAccounts.length === 1) {
        const account = parentAccounts[0];
        await prisma.$executeRawUnsafe(
            `INSERT INTO "UserRoleGrant" ("userId", role, status, source, "decidedAt", "decidedBy", note)
             VALUES ($1, $2, 'ACTIVE', 'INVITE', NOW(), $3, '원장 초대')
             ON CONFLICT ("userId", role) WHERE status IN ('PENDING', 'ACTIVE')
             DO UPDATE SET status = 'ACTIVE', source = 'INVITE', "decidedAt" = NOW(),
                           "decidedBy" = EXCLUDED."decidedBy", note = '원장 초대', "updatedAt" = NOW()`,
            account.id,
            staffRole,
            user.appUserId,
        );
        revalidateStaffAdminCaches();
        revalidatePath("/admin/staff");
        revalidatePath("/admin/role-requests");
        return {
            grantedExisting: true as const,
            accountName: account.name,
            token: null,
            inviteUrl: null,
            smsSent: false as const,
            smsError: undefined,
        };
    }

    // 2026-11-12 퇴사 처리 뒤 다시 일하게 된 경우: 그 사람의 옛 직원 기록(학부모로 내려간 직원 전용 계정)에
    // 새 초대를 붙인다(targetUserId). 가입하면 새 계정을 만들지 않고 그 기록을 다시 연다 — 같은 아이디로
    // 새 로그인을 만들려다 «이미 있는 계정»으로 막히던 길을 없앤다(acceptInvitation 의 targetUserId 분기).
    // 2026-11-12 검수: 이름까지 같을 때만 자동으로 붙인다(번호만 같은 다른 사람에게 옛 기록이 붙지 않게).
    const retiredRecords = await prisma.$queryRawUnsafe<Array<{ id: string; name: string; email: string | null }>>(
        `SELECT id, name, email FROM "User"
          WHERE regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = $1
            AND role = 'PARENT' AND "withdrawnAt" IS NULL
            AND lower(email) IN ($2, $3)
          ORDER BY "updatedAt" DESC
          LIMIT 2`,
        cleanPhone,
        `${cleanPhone}@staff.stiz.kr`,
        `${cleanPhone}@staff.local`,
    );
    const reinvite = decideRetiredReinvite(retiredRecords, cleanName);
    if (reinvite.kind === "reject") {
        return inviteStaffRejected(
            `같은 번호의 이전 직원 기록(${reinvite.previousName})이 있어요. 같은 사람이면 이름을 «${reinvite.previousName}»(으)로 맞춰 다시 초대해 주세요. 다른 사람이면 개발 담당에게 확인해 주세요.`,
        );
    }
    const retiredTargetUserId = reinvite.kind === "attach" ? reinvite.userId : null;
    const previousRecordNotice = reinvite.kind === "notice"
        ? `같은 번호의 이전 직원 기록(${reinvite.previousName})이 있어요. 연결하지 않고 새로 초대했습니다.`
        : undefined;

    try {
        // 초대 레코드 생성 — 만료: 7일 후
        const rows = await prisma.$queryRawUnsafe<any[]>(
            `INSERT INTO "StaffInvitation" (id, token, name, phone, role, status, "expiresAt", "targetUserId", "createdBy", "createdAt", "updatedAt")
             VALUES (
               (gen_random_uuid())::text,
               (gen_random_uuid())::text,
               $1, $2, $3::"Role", 'PENDING',
               NOW() + INTERVAL '7 days',
               $5, $4, NOW(), NOW()
             )
             RETURNING id, token`,
            cleanName,
            cleanPhone,
            staffRole,
            user.id,
            retiredTargetUserId,
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
            grantedExisting: false as const,
            accountName: null,
            token,
            inviteUrl,
            smsSent: smsResult.ok,
            smsError: smsResult.ok
                ? undefined
                : baseUrl ? SMS_SEND_FAILED : SMS_SITE_URL_MISSING,
            previousRecordNotice,
        };
    } catch (e) {
        console.error("[inviteStaff] failed:", e);
        throw new Error((e as Error).message || "초대 생성 실패");
    }
}

/**
 * 원장·부원장 비밀번호 재설정 링크(2026-11-12 검수 정확 4) — sendStaffPasswordReset({ userId }) 에서만 부른다(원장 확인 뒤).
 * 대상 = 직원 전용 로그인(@staff.stiz.kr, authUserId 있음)이 있는 원장·부원장 기록, 본인 제외.
 * PASSWORD_RESET + targetUserId · 24시간 · 문자 자동 발송 없음([링크 복사]·[문자 보내기]) · 감사 기록.
 * 가입 처리(acceptInvitation)가 대상의 지금 역할 = 초대 역할·번호 일치를 다시 보고 비밀번호만 바꾼다(역할은 그대로).
 */
async function createOwnerPasswordReset(owner: { id: string; appUserId: string }, targetId: string) {
    if (!targetId) return inviteStaffRejected("대상 직원을 찾을 수 없습니다. 목록을 새로고침해 주세요.");
    if (targetId === owner.appUserId) {
        return inviteStaffRejected("본인 계정은 여기서 재설정할 수 없어요. 다른 원장에게 요청해 주세요.");
    }
    const targets = await prisma.$queryRawUnsafe<Array<{ id: string; name: string; phone: string | null; role: string; email: string | null; authUserId: string | null }>>(
        `SELECT id, name, phone, role::text AS role, email, "authUserId"
           FROM "User" WHERE id = $1 AND "withdrawnAt" IS NULL LIMIT 1`,
        targetId,
    );
    const target = targets[0];
    if (!target) return inviteStaffRejected("대상 직원을 찾을 수 없습니다. 목록을 새로고침해 주세요.");
    if (!isLoginLinkRole(target.role)) {
        return inviteStaffRejected("여기서는 원장·부원장 계정만 재설정합니다. 코치·기사는 [새 스태프 초대]에서 번호로 재설정해 주세요.");
    }
    if (!target.authUserId || staffLoginKind(target) !== "staffLogin") {
        return inviteStaffRejected("전화번호 아이디로 로그인하는 계정만 재설정할 수 있어요. 로그인이 없으면 [로그인 연결]을 써 주세요.");
    }
    const cleanPhone = String(target.phone ?? "").replace(/\D/g, "");
    if (!/^010\d{8}$/.test(cleanPhone)) {
        return inviteStaffRejected("저장된 휴대전화 번호가 올바르지 않습니다. 번호를 고친 뒤 다시 시도해 주세요.");
    }

    const created = await prisma.$transaction(async (tx) => {
        // 같은 번호의 초대 만들기를 줄 세운다(두 번 눌러도 링크 하나)
        await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, `staff-invite-phone:${cleanPhone}`);
        const pending = await tx.$queryRawUnsafe<Array<{ id: string; token: string; targetUserId: string | null; purpose: string | null; role: string }>>(
            `SELECT id, token, "targetUserId", purpose, role::text AS role FROM "StaffInvitation"
              WHERE phone = $1 AND status = 'PENDING' AND "expiresAt" > NOW()
              ORDER BY "createdAt" DESC LIMIT 1`,
            cleanPhone,
        );
        if (pending[0]) {
            if (pending[0].targetUserId === target.id && pending[0].purpose === "PASSWORD_RESET" && pending[0].role === target.role) {
                return { id: pending[0].id, token: pending[0].token, reused: true };
            }
            return null;
        }
        const rows = await tx.$queryRawUnsafe<Array<{ id: string; token: string }>>(
            `INSERT INTO "StaffInvitation" (id, token, name, phone, role, status, "expiresAt", purpose, "targetUserId", "createdBy", "createdAt", "updatedAt")
             VALUES ((gen_random_uuid())::text, (gen_random_uuid())::text, $1, $2, $3::"Role", 'PENDING',
                     NOW() + INTERVAL '1 day', 'PASSWORD_RESET', $4, $5, NOW(), NOW())
             RETURNING id, token`,
            target.name,
            cleanPhone,
            target.role,
            target.id,
            owner.id,
        );
        if (!rows[0]) throw new Error("재설정 링크 생성 실패");
        // 감사 기록 — 누가 누구의 재설정 링크를 만들었는가(토큰은 남기지 않는다)
        await tx.$executeRawUnsafe(
            `INSERT INTO "OperationsAuditLog" (id, action, "actorType", "actorUserId", "detailsJson")
             VALUES (gen_random_uuid()::text, 'STAFF_PASSWORD_RESET_LINK_CREATED', 'ADMIN', $1, $2::jsonb)`,
            owner.appUserId,
            JSON.stringify({ targetUserId: target.id, targetName: target.name, role: target.role, invitationId: rows[0].id }),
        );
        return { id: rows[0].id, token: rows[0].token, reused: false };
    });
    if (!created) {
        return inviteStaffRejected("이 번호로 대기 중인 다른 초대가 있습니다. 그 초대를 취소한 뒤 다시 눌러 주세요.");
    }
    revalidateStaffAdminCaches();
    revalidatePath("/admin/staff");
    return {
        rejected: false as const,
        name: target.name,
        loginId: target.email,
        inviteUrl: getStaffInvitationUrl(created.token),
        smsSent: false, // 자동 발송 없음 — 원장이 초대 줄 ⚡ [재발송] 또는 링크 복사로 전한다
        smsError: undefined,
        reused: created.reused,
        // 인증번호가 갈 번호(끝 4자리만) — 원장이 «그 사람 번호가 맞는지» 확인하게
        phoneMasked: maskedPhoneLast4(cleanPhone),
    };
}

/**
 * sendStaffPasswordReset — 이미 가입된 선생님·기사의 비밀번호 재설정 링크 (requireOwner: 원장만, 2026-11-12)
 * 직원 아이디는 가짜 메일(전화번호@staff.stiz.kr)이라 메일로는 재설정할 수 없다.
 * 초대와 같은 절차(개인 링크 → 등록 번호 문자 인증 → 비밀번호 설정)를 쓰되, 새 계정을 만들지 않고
 * 이 직원 계정의 로그인 비밀번호만 바꾼다(acceptInvitation 의 PASSWORD_RESET 분기).
 * 2026-11-12 검수 정확 4: userId 를 주면 원장·부원장 계정 재설정(스태프 화면 패널에서 그 사람을 콕 집어) — createOwnerPasswordReset.
 */
export async function sendStaffPasswordReset(data: { phone: string; userId?: string }) {
    const user = await requireOwner();
    await ensureStaffInvitationTable();
    // 원장·부원장은 번호로 고르지 않고 그 기록(userId)으로만 — 문자 자동 발송 없음
    if (data.userId) return createOwnerPasswordReset(user, String(data.userId).trim());
    const cleanPhone = String(data.phone ?? "").replace(/\D/g, "");
    if (!/^010\d{8}$/.test(cleanPhone)) {
        return inviteStaffRejected("휴대전화 번호는 010으로 시작하는 11자리 숫자로 입력해 주세요.");
    }
    const staff = await prisma.$queryRawUnsafe<Array<{ id: string; name: string; role: string; email: string | null }>>(
        `SELECT id, name, role::text AS role, email FROM "User"
          WHERE regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = $1
            AND role IN ('INSTRUCTOR','DRIVER') AND "withdrawnAt" IS NULL
          LIMIT 2`,
        cleanPhone,
    );
    if (staff.length !== 1) {
        return inviteStaffRejected(
            staff.length === 0
                ? "이 번호로 가입된 선생님·기사 계정이 없습니다. 새 초대를 만들어 주세요."
                : "이 번호로 가입된 직원 계정이 둘 이상이라 자동으로 고를 수 없습니다. 개발 담당에게 확인해 주세요.",
        );
    }
    const target = staff[0];
    const pending = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM "StaffInvitation" WHERE phone = $1 AND status = 'PENDING' AND "expiresAt" > NOW() LIMIT 1`,
        cleanPhone,
    );
    if (pending.length > 0) {
        return inviteStaffRejected("이 번호로 대기 중인 초대·재설정 링크가 이미 있습니다. 대기 중인 초대 목록에서 다시 보내거나 취소해 주세요.");
    }
    const rows = await prisma.$queryRawUnsafe<Array<{ id: string; token: string }>>(
        `INSERT INTO "StaffInvitation" (id, token, name, phone, role, status, "expiresAt", purpose, "targetUserId", "createdBy", "createdAt", "updatedAt")
         VALUES ((gen_random_uuid())::text, (gen_random_uuid())::text, $1, $2, $3::"Role", 'PENDING',
                 NOW() + INTERVAL '1 day', 'PASSWORD_RESET', $4, $5, NOW(), NOW())
         RETURNING id, token`,
        target.name,
        cleanPhone,
        target.role,
        target.id,
        user.id,
    );
    const invitationId = rows[0]?.id;
    const token = rows[0]?.token;
    if (!invitationId || !token) throw new Error("재설정 링크 생성 실패");
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
            body: `[STIZ 농구교실] ${target.name}님, 스태프 앱 비밀번호 재설정 링크입니다(24시간 유효).\n아래 링크에서 문자 인증 후 새 비밀번호를 정해 주세요:\n${inviteUrl}`,
        })
        : { ok: false, reason: SMS_SITE_URL_MISSING };
    if (baseUrl && !smsResult.ok) {
        console.error("[sendStaffPasswordReset SMS] failed:", "reason" in smsResult ? smsResult.reason : smsResult.errorCode);
    }
    revalidateStaffAdminCaches();
    revalidatePath("/admin/staff");
    return {
        rejected: false as const,
        name: target.name,
        loginId: target.email,
        inviteUrl,
        smsSent: smsResult.ok,
        smsError: smsResult.ok ? undefined : baseUrl ? SMS_SEND_FAILED : SMS_SITE_URL_MISSING,
    };
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
            `SELECT token, name, phone, role::text AS role, "expiresAt", purpose, "targetUserId"
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

        // 만료되었으면 7일 연장 — 원장·부원장 로그인 연결 초대는 24시간만(2026-11-12 안전장치)
        if (expiresAt < new Date()) {
            await prisma.$executeRawUnsafe(
                `UPDATE "StaffInvitation"
                 SET "expiresAt" = NOW() + CASE WHEN role IN ('ADMIN'::"Role", 'VICE_ADMIN'::"Role") THEN INTERVAL '1 day' ELSE INTERVAL '7 days' END,
                     "updatedAt" = NOW()
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
                body: inv.purpose === "PASSWORD_RESET"
                    ? `[STIZ 농구교실] ${inv.name}님, 비밀번호 재설정 링크를 다시 보냅니다.
아래 링크에서 문자 인증 후 새 비밀번호를 정해 주세요:
${inviteUrl}`
                    : inv.targetUserId && isLoginLinkRole(String(inv.role ?? ""))
                        // 원장·부원장 로그인 연결 — 원장이 [문자 보내기]를 눌렀을 때만(자동 발송 없음)
                        ? `[STIZ 농구교실] ${inv.name}님, 관리자 로그인 연결 링크입니다(24시간 유효).
아래 링크에서 문자 인증 후 비밀번호를 정해 주세요:
${inviteUrl}`
                    : inv.targetUserId
                        // 직접 추가 직원의 앱 계정 전환 — 첫 발송도 원장이 [문자 보내기]로 보낸다(자동 발송 없음)
                        ? `[STIZ 농구교실] ${inv.name}님, 스태프 앱 가입 링크입니다.\n아래 링크에서 문자 인증 후 비밀번호를 정해 주세요:\n${inviteUrl}`
                        : `[STIZ 농구교실] ${inv.name}님, 스태프 초대 링크를 재발송합니다.\n아래 링크에서 가입을 완료해주세요:\n${inviteUrl}`,
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

/**
 * convertDirectStaffToInvite — «직접 추가» 직원 기록을 앱 계정으로 바꾸는 초대 만들기 (requireOwner: 원장만, 2026-11-12)
 *
 * 직접 추가 기록(전화번호@staff.local)은 로그인 계정이 없어 앱을 못 쓴다. 같은 번호 초대는 «이미 등록된 스태프»로
 * 막히므로, 이 경우만 그 기록을 대상으로 한 초대(SIGNUP + targetUserId)를 만든다. 가입하면 새 직원 기록을 만들지 않고
 * 이 기록에 로그인을 붙인다 — 직원 id 가 그대로라 역할·코치 연결·수업 기록이 모두 이어진다(acceptInvitation).
 * 문자는 보내지 않는다 — 원장이 [링크 복사]·[문자 보내기]로 전한다.
 * 같은 사람의 대기 초대가 이미 있으면 그것을 돌려준다(두 번 눌러도 하나).
 */
export async function convertDirectStaffToInvite(userId: string) {
    const owner = await requireOwner();
    await ensureStaffInvitationTable();
    const targetId = String(userId ?? "").trim();
    if (!targetId) return inviteStaffRejected("대상 직원을 찾을 수 없습니다. 목록을 새로고침해 주세요.");

    const targets = await prisma.$queryRawUnsafe<Array<{ id: string; name: string; phone: string | null; role: string; email: string | null; authUserId: string | null }>>(
        `SELECT id, name, phone, role::text AS role, email, "authUserId"
           FROM "User" WHERE id = $1 AND "withdrawnAt" IS NULL LIMIT 1`,
        targetId,
    );
    const target = targets[0];
    if (!target) return inviteStaffRejected("대상 직원을 찾을 수 없습니다. 목록을 새로고침해 주세요.");
    if (staffLoginKind(target) !== "none") return inviteStaffRejected("이미 로그인 계정이 있는 직원입니다.");
    if (!isConvertibleStaffRole(target.role)) {
        return inviteStaffRejected("코치/강사·셔틀 기사 역할만 초대로 전환할 수 있습니다.");
    }
    const cleanPhone = String(target.phone ?? "").replace(/\D/g, "");
    if (!/^010\d{8}$/.test(cleanPhone)) {
        return inviteStaffRejected("저장된 휴대전화 번호가 올바르지 않습니다. 번호를 고친 뒤 다시 시도해 주세요.");
    }

    const created = await prisma.$transaction(async (tx) => {
        // 같은 번호의 초대 만들기를 줄 세운다(두 번 눌러도 초대 하나)
        await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, `staff-invite-phone:${cleanPhone}`);
        const pending = await tx.$queryRawUnsafe<Array<{ id: string; token: string; targetUserId: string | null; purpose: string | null }>>(
            `SELECT id, token, "targetUserId", purpose FROM "StaffInvitation"
              WHERE phone = $1 AND status = 'PENDING' AND "expiresAt" > NOW()
              ORDER BY "createdAt" DESC LIMIT 1`,
            cleanPhone,
        );
        if (pending[0]) {
            if (pending[0].targetUserId === target.id && pending[0].purpose !== "PASSWORD_RESET") {
                return { id: pending[0].id, token: pending[0].token, reused: true };
            }
            return null;
        }
        const rows = await tx.$queryRawUnsafe<Array<{ id: string; token: string }>>(
            `INSERT INTO "StaffInvitation" (id, token, name, phone, role, status, "expiresAt", purpose, "targetUserId", "createdBy", "createdAt", "updatedAt")
             VALUES ((gen_random_uuid())::text, (gen_random_uuid())::text, $1, $2, $3::"Role", 'PENDING',
                     NOW() + INTERVAL '7 days', 'SIGNUP', $4, $5, NOW(), NOW())
             RETURNING id, token`,
            target.name,
            cleanPhone,
            target.role,
            target.id,
            owner.id,
        );
        if (!rows[0]) throw new Error("초대 생성 실패");
        return { id: rows[0].id, token: rows[0].token, reused: false };
    });
    if (!created) {
        return inviteStaffRejected("이 번호로 대기 중인 다른 초대가 있습니다. 그 초대를 취소한 뒤 다시 눌러 주세요.");
    }

    revalidateStaffAdminCaches();
    revalidatePath("/admin/staff");
    return {
        rejected: false as const,
        invitationId: created.id,
        token: created.token,
        inviteUrl: getStaffInvitationUrl(created.token),
        reused: created.reused,
    };
}

/**
 * linkOwnerStaffLogin — 원장·부원장 «로그인 연결» 링크 만들기 (requireOwner: 원장만, 2026-11-12 원장 지시 — 권혜미 대표원장)
 *
 * 직접 추가된 원장·부원장 기록(@staff.local, 로그인 없음)은 로그인을 못 한다. [초대로 전환]은 코치·기사만 받으므로,
 * 이 경우만 그 기록을 향한 전용 초대(SIGNUP + targetUserId, 역할 = 대상의 지금 역할 그대로)를 만든다.
 * 안전장치: 유효 24시간 · 초대에 적힌 그 사람 번호 문자 인증(기존 흐름) · 가입 거래에서 대상 역할·로그인 없음을 다시 확인 ·
 * 연결되면 다른 원장·부원장 알림 + 감사 기록(acceptInvitation). 비밀번호는 본인이 가입 화면에서 정한다.
 * 문자는 보내지 않는다 — 원장이 [링크 복사]·[문자 보내기]로 전한다. 같은 사람의 대기 링크가 있으면 그것을 돌려준다.
 */
export async function linkOwnerStaffLogin(userId: string) {
    const owner = await requireOwner();
    await ensureStaffInvitationTable();
    const targetId = String(userId ?? "").trim();
    if (!targetId) return inviteStaffRejected("대상 직원을 찾을 수 없습니다. 목록을 새로고침해 주세요.");
    if (targetId === owner.appUserId) return inviteStaffRejected("이미 로그인한 본인 계정입니다.");

    const targets = await prisma.$queryRawUnsafe<Array<{ id: string; name: string; phone: string | null; role: string; email: string | null; authUserId: string | null }>>(
        `SELECT id, name, phone, role::text AS role, email, "authUserId"
           FROM "User" WHERE id = $1 AND "withdrawnAt" IS NULL LIMIT 1`,
        targetId,
    );
    const target = targets[0];
    if (!target) return inviteStaffRejected("대상 직원을 찾을 수 없습니다. 목록을 새로고침해 주세요.");
    if (staffLoginKind(target) !== "none") return inviteStaffRejected("이미 로그인 계정이 있는 직원입니다.");
    // 원장·부원장만 — 코치·기사는 기존 [초대로 전환](7일 링크)을 쓴다
    if (!isLoginLinkRole(target.role)) {
        return inviteStaffRejected("원장·부원장 기록만 로그인 연결을 할 수 있습니다. 코치·기사는 [초대로 전환]을 써 주세요.");
    }
    const cleanPhone = String(target.phone ?? "").replace(/\D/g, "");
    if (!/^010\d{8}$/.test(cleanPhone)) {
        return inviteStaffRejected("저장된 휴대전화 번호가 올바르지 않습니다. 번호를 고친 뒤 다시 시도해 주세요.");
    }

    const created = await prisma.$transaction(async (tx) => {
        // 같은 번호의 초대 만들기를 줄 세운다(두 번 눌러도 링크 하나) — 초대로 전환과 같은 잠금 열쇠
        await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, `staff-invite-phone:${cleanPhone}`);
        const pending = await tx.$queryRawUnsafe<Array<{ id: string; token: string; targetUserId: string | null; purpose: string | null; role: string }>>(
            `SELECT id, token, "targetUserId", purpose, role::text AS role FROM "StaffInvitation"
              WHERE phone = $1 AND status = 'PENDING' AND "expiresAt" > NOW()
              ORDER BY "createdAt" DESC LIMIT 1`,
            cleanPhone,
        );
        if (pending[0]) {
            // 같은 사람·같은 역할의 로그인 연결 링크면 그대로 돌려준다(유효기간은 처음 만든 때부터 24시간)
            if (pending[0].targetUserId === target.id && pending[0].purpose !== "PASSWORD_RESET" && pending[0].role === target.role) {
                return { id: pending[0].id, token: pending[0].token, reused: true };
            }
            return null;
        }
        const rows = await tx.$queryRawUnsafe<Array<{ id: string; token: string }>>(
            `INSERT INTO "StaffInvitation" (id, token, name, phone, role, status, "expiresAt", purpose, "targetUserId", "createdBy", "createdAt", "updatedAt")
             VALUES ((gen_random_uuid())::text, (gen_random_uuid())::text, $1, $2, $3::"Role", 'PENDING',
                     NOW() + INTERVAL '1 day', 'SIGNUP', $4, $5, NOW(), NOW())
             RETURNING id, token`,
            target.name,
            cleanPhone,
            target.role,
            target.id,
            owner.id,
        );
        if (!rows[0]) throw new Error("로그인 연결 링크 생성 실패");
        // 감사 기록 — 누가 누구의 로그인 연결 링크를 만들었는가(링크 주소·토큰은 남기지 않는다)
        await tx.$executeRawUnsafe(
            `INSERT INTO "OperationsAuditLog" (id, action, "actorType", "actorUserId", "detailsJson")
             VALUES (gen_random_uuid()::text, 'STAFF_LOGIN_LINK_CREATED', 'ADMIN', $1, $2::jsonb)`,
            owner.appUserId,
            JSON.stringify({ targetUserId: target.id, targetName: target.name, role: target.role, invitationId: rows[0].id }),
        );
        return { id: rows[0].id, token: rows[0].token, reused: false };
    });
    if (!created) {
        return inviteStaffRejected("이 번호로 대기 중인 다른 초대가 있습니다. 그 초대를 취소한 뒤 다시 눌러 주세요.");
    }

    revalidateStaffAdminCaches();
    revalidatePath("/admin/staff");
    return {
        rejected: false as const,
        invitationId: created.id,
        token: created.token,
        inviteUrl: getStaffInvitationUrl(created.token),
        reused: created.reused,
        // 인증번호가 갈 번호(끝 4자리만) — 원장이 «그 사람 번호가 맞는지» 확인하게(보안 검수 ③)
        phoneMasked: maskedPhoneLast4(cleanPhone),
    };
}

/**
 * retireStaffMember — 퇴사 처리 (requireOwner: 원장만, 2026-11-12)
 *
 * 한 거래 안에서: 주 역할 → 학부모(스태프 목록에서 빠짐, 기존 «학부모로 바꾸기»와 같은 관례) · 코치 프로필 연결 해제 ·
 * 추가 역할 회수(ACTIVE → REVOKED, 신청 중 → REJECTED) · 이 사람을 향한 대기 초대(전환·재설정) 취소 · 감사 기록.
 * 거래 뒤: 직원 전용 로그인(초대 가입 계정)이고 자기 자녀가 없으면 Supabase 로그인을 막는다(새로 로그인·토큰 갱신 불가).
 * 이미 로그인한 화면도 다음 요청부터 권한이 없다 — 권한 판정이 매번 DB 역할을 다시 읽는다(auth-guard 캐시 확인).
 * 다시 눌러도 안전하다(바꿀 것이 없으면 «이미 처리됨», 로그인 차단만 다시 시도).
 */
export async function retireStaffMember(userId: string) {
    const owner = await requireOwner();
    await ensureStaffColumns();
    const targetId = String(userId ?? "").trim();
    if (!targetId) return { ok: false as const, error: "대상 직원을 찾을 수 없습니다. 목록을 새로고침해 주세요." };
    if (targetId === owner.appUserId) return { ok: false as const, error: "자기 자신은 퇴사 처리할 수 없습니다." };

    let outcome: {
        name: string;
        email: string | null;
        authUserId: string | null;
        changed: boolean;
        coachNames: string[];
        revokedRoles: string[];
        hasOwnChildren: boolean;
        auditId: string | null;
    };
    try {
        outcome = await prisma.$transaction(async (tx) => {
            // 대상 줄을 잠그고 시작 — 같은 사람에게 역할 변경·퇴사가 동시에 들어와도 한 번에 하나만
            const rows = await tx.$queryRawUnsafe<Array<{ id: string; name: string; email: string | null; authUserId: string | null; role: string }>>(
                `SELECT id, name, email, "authUserId", role::text AS role
                   FROM "User" WHERE id = $1 AND "withdrawnAt" IS NULL FOR UPDATE`,
                targetId,
            );
            const target = rows[0];
            if (!target) throw new Error("대상 직원을 찾을 수 없습니다. 목록을 새로고침해 주세요.");
            if (String(target.email || "").toLowerCase() === String(owner.email || "").toLowerCase()) {
                throw new Error("자기 자신은 퇴사 처리할 수 없습니다.");
            }
            const wasStaff = ["ADMIN", "VICE_ADMIN", "INSTRUCTOR", "DRIVER"].includes(target.role);
            if (!wasStaff && target.role !== "PARENT") throw new Error("퇴사 처리할 수 없는 계정입니다.");

            // 1) 주 역할 → 학부모(지금 역할이 그대로일 때만 — 그 사이 바뀌었으면 되돌린다)
            const roleChanged = wasStaff
                ? await tx.$executeRawUnsafe(
                    `UPDATE "User" SET role = 'PARENT'::"Role", "updatedAt" = NOW() WHERE id = $1 AND role = $2::"Role"`,
                    targetId,
                    target.role,
                )
                : 0;
            if (wasStaff && roleChanged !== 1) throw new Error("직원 상태가 바뀌었습니다. 목록을 새로고침해 주세요.");
            // 2) 코치 프로필 연결 해제 — 시간표 배정은 코치 프로필에 남아 다른 사람에게 다시 연결할 수 있다
            const coaches = await tx.$queryRawUnsafe<Array<{ name: string }>>(
                `UPDATE "Coach" SET "userId" = NULL, "updatedAt" = NOW() WHERE "userId" = $1 RETURNING name`,
                targetId,
            );
            // 3) 추가 역할 회수(승인됨 → 회수, 신청 중 → 반려)
            const grants = await tx.$queryRawUnsafe<Array<{ role: string }>>(
                `UPDATE "UserRoleGrant"
                    SET status = CASE WHEN status = 'ACTIVE' THEN 'REVOKED' ELSE 'REJECTED' END,
                        "decidedAt" = NOW(), "decidedBy" = $2, note = '퇴사 처리', "updatedAt" = NOW()
                  WHERE "userId" = $1 AND status IN ('PENDING', 'ACTIVE')
                  RETURNING role`,
                targetId,
                owner.appUserId,
            );
            // 4) 이 사람을 향한 대기·처리 중 초대(앱 계정 전환·비밀번호 재설정) 취소 — 링크로 다시 들어오지 못하게.
            //    처리 중(PROCESSING)도 취소하면 가입 거래가 마지막 확인에서 실패해 전부 되돌린다.
            const invites = await tx.$executeRawUnsafe(
                `UPDATE "StaffInvitation" SET status = 'CANCELLED', "updatedAt" = NOW()
                  WHERE "targetUserId" = $1 AND status IN ('PENDING', 'PROCESSING')`,
                targetId,
            );
            // 자기 자녀가 있으면(학부모 화면을 계속 써야 하면) 로그인은 막지 않는다
            const children = await tx.$queryRawUnsafe<Array<{ one: number }>>(
                `SELECT 1 AS one FROM "Student" s WHERE s."parentId" = $1 AND ${notMergedStudent("s")} LIMIT 1`,
                targetId,
            );
            const changed = roleChanged > 0 || coaches.length > 0 || grants.length > 0 || invites > 0;
            let auditId: string | null = null;
            if (changed) {
                // 5) 감사 기록 — 누가·언제·무엇을(되돌릴 때 근거)
                const audit = await tx.$queryRawUnsafe<Array<{ id: string }>>(
                    `INSERT INTO "OperationsAuditLog" (id, action, "actorType", "actorUserId", "detailsJson")
                     VALUES (gen_random_uuid()::text, 'STAFF_RETIRED', 'ADMIN', $1, $2::jsonb)
                     RETURNING id`,
                    owner.appUserId,
                    JSON.stringify({
                        targetUserId: targetId,
                        targetName: target.name,
                        previousRole: target.role,
                        coachNames: coaches.map((coach) => coach.name),
                        revokedRoles: grants.map((grant) => grant.role),
                        cancelledInvites: invites,
                    }),
                );
                auditId = audit[0]?.id ?? null;
            }
            return {
                name: target.name,
                email: target.email,
                authUserId: target.authUserId,
                changed,
                coachNames: coaches.map((coach) => coach.name),
                revokedRoles: grants.map((grant) => grant.role),
                hasOwnChildren: children.length > 0,
                auditId,
            };
        });
    } catch (e) {
        console.error("[retireStaffMember] failed:", e);
        return { ok: false as const, error: (e as Error).message || "퇴사 처리에 실패했습니다." };
    }

    // 6) 로그인 차단 — 거래 밖(외부 서비스). 실패해도 권한은 이미 회수됐고, 다시 누르면 이것만 다시 시도한다.
    const account = { id: targetId, email: outcome.email, authUserId: outcome.authUserId };
    const kind = staffLoginKind(account);
    const authId = staffAuthId(account);
    let loginBlocked: "blocked" | "kept" | "none" | "failed" = kind === "none" ? "none" : "kept";
    if (authId && shouldBlockLoginOnRetire({ kind, hasOwnChildren: outcome.hasOwnChildren })) {
        try {
            const { error } = await createAdminClient().auth.admin.updateUserById(authId, { ban_duration: RETIRED_LOGIN_BAN_DURATION });
            loginBlocked = error ? "failed" : "blocked";
            if (error) console.error("[retireStaffMember] login block failed:", { status: error.status, code: error.code, message: error.message });
        } catch (error) {
            loginBlocked = "failed";
            console.error("[retireStaffMember] login block failed:", error instanceof Error ? error.message : String(error));
        }
    }
    if (outcome.auditId) {
        await prisma.$executeRawUnsafe(
            `UPDATE "OperationsAuditLog" SET "detailsJson" = "detailsJson" || $2::jsonb WHERE id = $1`,
            outcome.auditId,
            JSON.stringify({ loginBlocked }),
        ).catch(() => undefined);
    }

    // 7) 이 서버의 역할 캐시도 바로 비운다(다른 서버는 캐시 확인 때 역할을 다시 읽는다)
    forgetAppUserRoleCache(targetId);
    revalidateStaffAdminCaches();
    revalidatePath("/admin/staff");
    revalidatePath("/admin/role-requests");
    return {
        ok: true as const,
        alreadyDone: !outcome.changed,
        name: outcome.name,
        coachNames: outcome.coachNames,
        revokedRoles: outcome.revokedRoles,
        loginBlocked,
    };
}

/**
 * retryRetiredLoginBlocks — 퇴사 처리 때 로그인 차단이 실패한 직원을 다시 막는다 (requireOwner: 원장만, 2026-11-12 검수)
 * 대상 = 감사 기록 STAFF_RETIRED 중 loginBlocked:"failed" 이고 지금도 학부모(재입사 안 함)·탈퇴 안 한 계정.
 * 퇴사 처리와 같은 판정(직원 전용 로그인 + 자기 자녀 없음)일 때만 막고, 결과를 감사 기록에 덧붙인다(다시 눌러도 안전).
 */
export async function retryRetiredLoginBlocks() {
    await requireOwner();
    const rows = await prisma.$queryRawUnsafe<Array<{ auditId: string; userId: string; email: string | null; authUserId: string | null; hasOwnChildren: boolean }>>(
        `SELECT DISTINCT ON (a."detailsJson"->>'targetUserId')
                a.id AS "auditId", u.id AS "userId", u.email, u."authUserId",
                EXISTS (SELECT 1 FROM "Student" s WHERE s."parentId" = u.id AND ${notMergedStudent("s")}) AS "hasOwnChildren"
           FROM "OperationsAuditLog" a
           JOIN "User" u ON u.id = a."detailsJson"->>'targetUserId'
          WHERE a.action = 'STAFF_RETIRED' AND a."detailsJson"->>'loginBlocked' = 'failed'
            AND u.role = 'PARENT' AND u."withdrawnAt" IS NULL
          ORDER BY a."detailsJson"->>'targetUserId', a."createdAt" DESC`,
    );
    let done = 0;
    let failed = 0;
    for (const row of rows) {
        const account = { id: row.userId, email: row.email, authUserId: row.authUserId };
        const kind = staffLoginKind(account);
        const authId = staffAuthId(account);
        let state: "blocked" | "kept" | "failed" = "kept";
        if (authId && shouldBlockLoginOnRetire({ kind, hasOwnChildren: Boolean(row.hasOwnChildren) })) {
            try {
                const { error } = await createAdminClient().auth.admin.updateUserById(authId, { ban_duration: RETIRED_LOGIN_BAN_DURATION });
                state = error ? "failed" : "blocked";
                if (error) console.error("[retryRetiredLoginBlocks] failed:", { status: error.status, code: error.code, message: error.message });
            } catch (error) {
                state = "failed";
                console.error("[retryRetiredLoginBlocks] failed:", error instanceof Error ? error.message : String(error));
            }
        }
        if (state === "failed") failed += 1;
        else done += 1;
        // 결과를 감사 기록에 덧붙인다 — «failed» 가 아니게 되면 다음 목록에서 빠진다
        await prisma.$executeRawUnsafe(
            `UPDATE "OperationsAuditLog" SET "detailsJson" = "detailsJson" || $2::jsonb WHERE id = $1`,
            row.auditId,
            JSON.stringify({ loginBlocked: state }),
        ).catch(() => undefined);
    }
    revalidateStaffAdminCaches();
    revalidatePath("/admin/staff");
    return { ok: true as const, done, failed };
}
