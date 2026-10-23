"use server";

/**
 * 공개 Server Actions: 로그인 없이 접근 가능한 기능입니다.
 * 체험수업 신청, 수강 신청 등 비회원이 사용하는 흐름을 담당합니다.
 */

import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import { ensureTrialLeadTable } from "@/app/actions/admin";
import { decideTrialLeadForNewApplication } from "@/lib/enrollment/trialLeadLinkService";
import { isKstYmd, todayKst } from "@/lib/datetime/kst";
import { notifyAdmins } from "@/lib/notification";
import { buildContactSaveName } from "@/lib/contactSaveName";
import {
    issueEnrollmentAccountHandoff,
} from "@/lib/enrollment-account-handoff";
import { SHUTTLE_LOCATION_CONSENT_VERSION } from "@/lib/seasonal/contracts";

async function issueEnrollmentAccountHandoffSafely(enrollmentApplicationId: string) {
    try {
        return await issueEnrollmentAccountHandoff(enrollmentApplicationId);
    } catch (error) {
        console.error("[enrollment handoff] issue failed:", error);
        return null;
    }
}

// ?? EnrollmentApplication DDL ensure (idempotent) ???????????????????????????
let _enrollTableEnsured = false;
export async function ensureEnrollmentApplicationTable() {
    if (_enrollTableEnsured) return;
    try {
        await prisma.$executeRawUnsafe(`
            CREATE TABLE IF NOT EXISTS "EnrollmentApplication" (
                id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                "trialLeadId" TEXT,
                "childName" TEXT NOT NULL,
                "childBirthDate" TIMESTAMPTZ NOT NULL,
                "childGender" TEXT,
                "childGrade" TEXT,
                "childSchool" TEXT,
                "childPhone" TEXT,
                "parentName" TEXT NOT NULL,
                "parentPhone" TEXT NOT NULL,
                "parentRelation" TEXT,
                address TEXT,
                "enrollmentMonths" TEXT,
                "preferredSlotKeys" TEXT,
                "assignedClassId" TEXT,
                "basketballExp" TEXT,
                "uniformSize" TEXT,
                "shuttleNeeded" BOOLEAN DEFAULT false,
                "shuttlePickup" TEXT,
                "shuttleTime" TEXT,
                "shuttleDropoff" TEXT,
                "paymentMethod" TEXT,
                "referralSource" TEXT,
                memo TEXT,
                "agreedTerms" BOOLEAN DEFAULT false,
                "agreedPrivacy" BOOLEAN DEFAULT false,
                "applicationNoticeConfirmed" BOOLEAN DEFAULT false,
                "shuttleNoticeConfirmed" BOOLEAN DEFAULT false,
                status TEXT DEFAULT 'PENDING',
                "processedAt" TIMESTAMPTZ,
                "processedNote" TEXT,
                "convertedStudentId" TEXT,
                "createdAt" TIMESTAMPTZ DEFAULT NOW(),
                "updatedAt" TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        // 상태, 체험 문의, 생성일 기준 조회 성능을 위한 인덱스입니다.
        await prisma.$executeRawUnsafe(
            `CREATE INDEX IF NOT EXISTS "EnrollmentApplication_status_idx" ON "EnrollmentApplication" (status)`
        );
        await prisma.$executeRawUnsafe(
            `CREATE INDEX IF NOT EXISTS "EnrollmentApplication_trialLeadId_idx" ON "EnrollmentApplication" ("trialLeadId")`
        );
        await prisma.$executeRawUnsafe(
            `CREATE INDEX IF NOT EXISTS "EnrollmentApplication_createdAt_idx" ON "EnrollmentApplication" ("createdAt")`
        );
        const extendedColumns: [string, string][] = [
            ['"enrollmentMonths"', "TEXT"],
            ['"applicationNoticeConfirmed"', "BOOLEAN DEFAULT false"],
            ['"shuttleNoticeConfirmed"', "BOOLEAN DEFAULT false"],
            ['"shuttlePickupAddress"', "TEXT"],
            ['"shuttlePickupRoadAddress"', "TEXT"],
            ['"shuttlePickupLatitude"', "DOUBLE PRECISION"],
            ['"shuttlePickupLongitude"', "DOUBLE PRECISION"],
            ['"shuttlePickupPlaceId"', "TEXT"],
            ['"shuttlePickupSource"', "TEXT"],
            ['"shuttlePickupAccuracyMeters"', "DOUBLE PRECISION"],
            ['"shuttlePickupConfirmedAt"', "TIMESTAMPTZ"],
            ['"shuttleDropoffAddress"', "TEXT"],
            ['"shuttleDropoffRoadAddress"', "TEXT"],
            ['"shuttleDropoffLatitude"', "DOUBLE PRECISION"],
            ['"shuttleDropoffLongitude"', "DOUBLE PRECISION"],
            ['"shuttleDropoffPlaceId"', "TEXT"],
            ['"shuttleDropoffSource"', "TEXT"],
            ['"shuttleDropoffAccuracyMeters"', "DOUBLE PRECISION"],
            ['"shuttleDropoffConfirmedAt"', "TIMESTAMPTZ"],
            ['"shuttleLocationConsentVersion"', "TEXT"],
            ['"shuttleLocationConsentAt"', "TIMESTAMPTZ"],
        ];
        for (const [col, type] of extendedColumns) {
            await prisma.$executeRawUnsafe(
                `ALTER TABLE "EnrollmentApplication" ADD COLUMN IF NOT EXISTS ${col} ${type}`
            );
        }
    } catch (e) {
        console.warn("[DDL] EnrollmentApplication ensure failed:", (e as Error).message);
    }
    _enrollTableEnsured = true;
}

// 체험수업 신청 입력
interface TrialApplicationInput {
    existingId?: string;
    trialDate?: string;
    trialDay?: string;
    trialPeriod?: string;
    childName: string;
    childBirthDate?: string;     // 이전 자체 폼 호환
    childGrade: string;
    childGender?: string;
    childSchool?: string;
    basketballExp?: string;
    parentName?: string;
    parentPhone: string;
    preferredSlotKey?: string;    // 희망 수업 "Mon-4"
    hopeNote?: string;
    source: string;               // 유입 경로
    // 학부모가 「체험수업 비용과 입금 계좌를 확인했습니다」에 체크했는지(입금 완료가 아님!)
    trialFeeNoticeAgreed?: boolean;
    /** @deprecated 배포 직전 열린 옛 화면 호환용. 의미는 trialFeeNoticeAgreed 와 같다(입금 아님). */
    trialFeeConfirmed?: boolean;
    agreedTerms?: boolean;
    agreedPrivacy?: boolean;
    honeypot?: string;            // 스팸 방지용 숨김 필드
}

// 전화번호 정규화
// 010-1234-5678, 01012345678, 010 1234 5678 등을 010-1234-5678로 통일합니다.
function normalizePhone(raw: string): string {
    const digits = raw.replace(/\D/g, "");
    if (digits.length === 11 && digits.startsWith("010")) {
        return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
    }
    return raw.trim();
}

const TRIAL_DAY_KEY_BY_LABEL: Record<string, string> = {
    월: "Mon",
    화: "Tue",
    수: "Wed",
    목: "Thu",
    금: "Fri",
    토: "Sat",
    일: "Sun",
};

function resolveTrialSlotKey(data: TrialApplicationInput): string | null {
    const directSlotKey = data.preferredSlotKey?.trim();
    if (directSlotKey) return directSlotKey;

    const dayKey = TRIAL_DAY_KEY_BY_LABEL[data.trialDay?.trim() || ""];
    const period = data.trialPeriod?.trim();
    if (!dayKey || !period) return null;

    return `${dayKey}-${period}`;
}

function dateInputValue(value: unknown): string | null {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(String(value));
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString().slice(0, 10);
}

function csvToList(value: unknown): string[] {
    if (!value) return [];
    return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function rowValue<T = string>(row: any, camelKey: string, lowerKey: string): T | null {
    return (row?.[camelKey] ?? row?.[lowerKey] ?? null) as T | null;
}

function activeTrialDuplicateWhereClause() {
    return `status IN ('NEW', 'CONTACTED', 'SCHEDULED')`;
}

export interface ExistingTrialApplicationForEdit {
    id: string;
    trialDate: string | null;
    trialDay: string | null;
    trialPeriod: string | null;
    childName: string;
    childGrade: string | null;
    childGender: string | null;
    childSchool: string | null;
    parentName: string | null;
    parentPhone: string;
    source: string | null;
    // 기존 신청서를 다시 불러올 때 「비용·계좌 확인」 체크를 채워 주는 용도(입금 여부 아님)
    trialFeeNoticeAgreed: boolean;
}

export async function findExistingTrialApplicationForEdit(input: {
    childName?: string;
    parentPhone?: string;
}): Promise<ExistingTrialApplicationForEdit | null> {
    const childName = input.childName?.trim();
    const phoneDigits = input.parentPhone?.replace(/\D/g, "") || "";
    if (!childName || phoneDigits.length < 10 || phoneDigits.length > 11) return null;

    await ensureTrialLeadTable();
    const rows = await prisma.$queryRawUnsafe<any[]>(
        `SELECT id, "trialDate", "scheduledDate", "preferredDay", "preferredPeriod",
                "childName", "childGrade", "childGender", "childSchool",
                "parentName", "parentPhone", source, "trialFeeNoticeAgreedAt"
           FROM "TrialLead"
          WHERE LOWER(TRIM("childName")) = LOWER($1)
            AND regexp_replace(COALESCE("parentPhone", ''), '[^0-9]', '', 'g') = $2
            AND ${activeTrialDuplicateWhereClause()}
          ORDER BY "updatedAt" DESC, "createdAt" DESC
          LIMIT 1`,
        childName,
        phoneDigits,
    );

    const row = rows[0];
    if (!row) return null;

    return {
        id: row.id,
        trialDate: dateInputValue(rowValue(row, "trialDate", "trialdate") ?? rowValue(row, "scheduledDate", "scheduleddate")),
        trialDay: rowValue(row, "preferredDay", "preferredday"),
        trialPeriod: rowValue(row, "preferredPeriod", "preferredperiod"),
        childName: rowValue(row, "childName", "childname") || childName,
        childGrade: rowValue(row, "childGrade", "childgrade"),
        childGender: rowValue(row, "childGender", "childgender"),
        childSchool: rowValue(row, "childSchool", "childschool"),
        parentName: rowValue(row, "parentName", "parentname"),
        parentPhone: rowValue(row, "parentPhone", "parentphone") || normalizePhone(input.parentPhone || ""),
        source: row.source ?? null,
        trialFeeNoticeAgreed: Boolean(rowValue(row, "trialFeeNoticeAgreedAt", "trialfeenoticeagreedat")),
    };
}

/**
 * submitTrialApplication - 체험수업 신청을 접수합니다.
 *
 * 검증 사항:
 * 1. honeypot 필드가 비어 있어야 합니다.
 * 2. 이름과 전화번호는 필수입니다.
 * 3. 약관 동의가 필요합니다.
 */
export async function submitTrialApplication(data: TrialApplicationInput) {
    // 스팸 방지: 숨김 필드에 값이 있으면 자동 입력으로 보고 조용히 성공 처리합니다.
    if (data.honeypot) {
        return { success: true, id: "ok" };
    }

    const childName = data.childName?.trim();
    const parentName = data.parentName?.trim() || "미입력";
    const parentPhone = data.parentPhone?.trim();

    if (!data.trialDate) throw new Error("체험수업 희망일을 선택해주세요.");
    if (!data.trialDay) throw new Error("요일을 선택해주세요.");
    if (!data.trialPeriod) throw new Error("교시를 선택해주세요.");
    if (!childName) throw new Error("아이 이름을 입력해주세요.");
    if (!data.childGender) throw new Error("성별을 선택해주세요.");
    if (!data.childSchool?.trim()) throw new Error("학교를 입력해주세요.");
    if (!data.childGrade) throw new Error("학년을 선택해주세요.");
    if (!parentPhone) throw new Error("학부모 연락처를 입력해주세요.");
    if (!data.source) throw new Error("신청경로를 선택해주세요.");
    // 학부모 동의 체크 — 입금 확인과는 별개다. 저장은 trialFeeNoticeAgreedAt(시각)으로만 한다.
    const feeNoticeAgreed = Boolean(data.trialFeeNoticeAgreed ?? data.trialFeeConfirmed);
    if (!feeNoticeAgreed) throw new Error("체험수업 비용 확인을 체크해주세요.");

    // 전화번호 형식 검증: 숫자만 추출해 10~11자리인지 확인합니다.
    const phoneDigits = parentPhone.replace(/\D/g, "");
    if (phoneDigits.length < 10 || phoneDigits.length > 11) {
        throw new Error("올바른 전화번호를 입력해주세요.");
    }

    // 필요한 테이블과 컬럼이 없으면 자동으로 준비합니다.
    await ensureTrialLeadTable();

    try {
        const normalizedParentPhone = normalizePhone(parentPhone);
        const preferredSlotKey = resolveTrialSlotKey(data);
        const normalizedPhoneDigits = normalizedParentPhone.replace(/\D/g, "");

        const existingRows = data.existingId
            ? await prisma.$queryRawUnsafe<{ id: string }[]>(
                `SELECT id
                   FROM "TrialLead"
                  WHERE id = $1
                    AND LOWER(TRIM("childName")) = LOWER($2)
                    AND regexp_replace(COALESCE("parentPhone", ''), '[^0-9]', '', 'g') = $3
                    AND ${activeTrialDuplicateWhereClause()}
                  LIMIT 1`,
                data.existingId,
                childName,
                normalizedPhoneDigits,
            )
            : await prisma.$queryRawUnsafe<{ id: string }[]>(
                `SELECT id
                   FROM "TrialLead"
                  WHERE LOWER(TRIM("childName")) = LOWER($1)
                    AND regexp_replace(COALESCE("parentPhone", ''), '[^0-9]', '', 'g') = $2
                    AND ${activeTrialDuplicateWhereClause()}
                  ORDER BY "updatedAt" DESC, "createdAt" DESC
                  LIMIT 1`,
                childName,
                normalizedPhoneDigits,
            );

        const existingId = existingRows[0]?.id;
        if (existingId) {
            await prisma.$executeRawUnsafe(
                `UPDATE "TrialLead" SET
                    "childAge" = $1,
                    "childBirthDate" = $2::timestamptz,
                    "childGrade" = $3,
                    "childGender" = $4,
                    "childSchool" = $5,
                    "basketballExp" = $6,
                    "parentName" = $7,
                    "parentPhone" = $8,
                    "scheduledDate" = CASE WHEN status='SCHEDULED' THEN "scheduledDate" ELSE $9::timestamptz END,
                    "preferredDays" = $10,
                    "preferredSlotKey" = $11,
                    "preferredDay" = $12,
                    "preferredPeriod" = $13,
                    "trialDate" = $14::timestamptz,
                    "hopeNote" = $15,
                    source = $16,
                    -- 학부모 재제출은 입금 확인(trialFeeConfirmed)을 건드리지 않는다. 동의 시각은 처음 값을 유지.
                    "trialFeeNoticeAgreedAt" = COALESCE("trialFeeNoticeAgreedAt", NOW()),
                    "agreedTerms" = $17,
                    "agreedPrivacy" = $18,
                    "updatedAt" = NOW()
                  WHERE id = $19`,
                data.childGrade || null,
                data.childBirthDate || null,
                data.childGrade || null,
                data.childGender || null,
                data.childSchool?.trim() || null,
                data.basketballExp || null,
                parentName,
                normalizedParentPhone,
                null, // 희망일은 날짜뿐이므로 실제 확정시각 칼럼에 자정으로 저장하지 않는다.
                data.trialDay || null,
                preferredSlotKey,
                data.trialDay || null,
                data.trialPeriod || null,
                data.trialDate || null,
                data.hopeNote?.trim() || null,
                data.source || "WEBSITE",
                data.agreedTerms ?? false,
                data.agreedPrivacy ?? false,
                existingId,
            );

            revalidatePath("/admin");
            revalidatePath("/admin/apply");
            revalidatePath("/admin/trial");
            return { success: true, id: existingId, mode: "updated" as const, duplicate: true };
        }

        const recentSubmissions = await prisma.$queryRawUnsafe<{ count: number }[]>(
            `SELECT COUNT(*)::int AS count
               FROM "TrialLead"
              WHERE regexp_replace(COALESCE("parentPhone", ''), '[^0-9]', '', 'g') = $1
                AND "createdAt" > NOW() - INTERVAL '10 minutes'`,
            normalizedPhoneDigits,
        );
        if (Number(recentSubmissions[0]?.count ?? 0) >= 5) {
            throw new Error("신청이 너무 많이 접수되었습니다. 잠시 후 다시 시도해주세요.");
        }

        // 새 체험 문의는 NEW 상태로 생성합니다.
        const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
            `INSERT INTO "TrialLead" (
                id, "childName", "childAge", "childBirthDate", "childGrade", "childGender", "childSchool",
                "basketballExp", "parentName", "parentPhone",
                "scheduledDate", "preferredDays", "preferredSlotKey", "preferredDay", "preferredPeriod", "trialDate",
                "hopeNote", source, "trialFeeConfirmed", "trialFeeNoticeAgreedAt",
                "agreedTerms", "agreedPrivacy",
                status, "createdAt", "updatedAt"
            ) VALUES (
                gen_random_uuid()::text, $1, $2, $3::timestamptz, $4, $5, $6,
                $7, $8, $9,
                $10::timestamptz, $11, $12, $13, $14, $15::timestamptz,
                $16, $17, false, NOW(),
                $18, $19,
                'NEW', NOW(), NOW()
            ) RETURNING id`,
            childName,
            data.childGrade || null,                              // childAge는 기존 호환을 위해 학년을 저장
            data.childBirthDate || null,                          // childBirthDate
            data.childGrade || null,                              // childGrade
            data.childGender || null,                             // childGender
            data.childSchool?.trim() || null,                     // childSchool
            data.basketballExp || null,                           // basketballExp
            parentName,
            normalizedParentPhone,
            null,                                                 // scheduledDate: 관리자 확정 전에는 비워 둔다.
            data.trialDay || null,                                // preferredDays
            preferredSlotKey,                                      // preferredSlotKey
            data.trialDay || null,                                // preferredDay
            data.trialPeriod || null,                             // preferredPeriod
            data.trialDate || null,                               // trialDate
            data.hopeNote?.trim() || null,                        // hopeNote
            data.source || "WEBSITE",                             // source
            // trialFeeConfirmed 는 SQL 에서 false 고정(관리자가 입금 확인해야 true),
            // trialFeeNoticeAgreedAt 은 NOW() — 학부모가 안내에 동의한 시각
            data.agreedTerms ?? false,                            // agreedTerms
            data.agreedPrivacy ?? false,                          // agreedPrivacy
        );

        // 관리자 페이지 캐시를 무효화해 새 신청이 바로 보이게 합니다.
        revalidatePath("/admin/trial");
        revalidatePath("/admin");
        revalidatePath("/admin/apply");
        revalidatePath("/admin/trial");

        // 관리자, 코치, 학부모 SMS 템플릿에 공통으로 쓰는 변수입니다.
        const smsVars = {
            childName,
            childGrade: data.childGrade || "학년 미입력",
            parentName,
            parentPhone: normalizedParentPhone,
            // 연락처 저장용 이름 `2610 이성빈 목7 초6` — 관리자 알림 문자에서 복사해 쓴다.
            contactSaveName: buildContactSaveName({ childName, childGrade: data.childGrade, slotKeys: preferredSlotKey }),
        };
        const trialLeadId = rows[0]?.id || "ok";

        // 관리자와 학부모 문자 발송은 신청 저장과 분리해 처리합니다.
        // 발송이 실패해도 신청 자체는 유지하고, 결과는 NotificationDelivery에 기록합니다.
        // 템플릿 기반 SMS: TRIAL_NEW_ADMIN(관리자), TRIAL_NEW_COACH(코치)
        // slotKeys가 있으면 해당 수업 담당 코치에게만 SMS를 보낼 수 있습니다.
        await Promise.allSettled([
            notifyAdmins(
                "TRIAL_APPLICATION",
                "체험수업 신청",
                `${childName} (${data.childGrade || "학년 미입력"}) - ${parentName}`,
                "/admin/trial",
                {
                    adminTrigger: "TRIAL_NEW_ADMIN",
                    coachTrigger: "TRIAL_NEW_COACH",
                    notifyCoaches: false,
                    variables: smsVars,
                    slotKeys: preferredSlotKey ? [preferredSlotKey] : undefined,
                    eventId: trialLeadId,
                },
            ),

            // 학부모에게 접수 확인 SMS를 보냅니다. 학원 전화번호는 DB에서 조회해 포함합니다.
            sendParentSmsWithAcademyPhone(
                normalizedParentPhone,
                "TRIAL_CONFIRM_PARENT",
                { childName, parentName },
                { eventType: "TRIAL_APPLICATION", eventId: trialLeadId },
            ),
        ]);

        return { success: true, id: trialLeadId, mode: "created" as const };
    } catch (e) {
        console.error("[submitTrialApplication] failed:", e);
        throw new Error("신청 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.");
    }
}

// 빈자리 수업 조회
export interface AvailableSlot {
    slotKey: string;
    dayOfWeek: string;      // "Mon", "Tue", ...
    dayLabel: string;       // "월", "화", ...
    className: string;      // 수업 이름
    startTime: string;
    endTime: string;
    capacity: number;
    enrolled: number;
    available: number;      // capacity - enrolled
}

// 요일 코드를 한글 라벨로 매핑합니다.
const DAY_LABELS: Record<string, string> = {
    Mon: "월",
    Tue: "화",
    Wed: "수",
    Thu: "목",
    Fri: "금",
    Sat: "토",
    Sun: "일",
};

/**
 * getAvailableTrialSlots - 공개 신청 폼에서 선택 가능한 수업 목록을 반환합니다.
 *
 * Class 테이블에서 활성 등록 인원을 계산하고,
 * 정원보다 등록 인원이 적은 수업만 노출합니다.
 */
export async function getAvailableTrialSlots(): Promise<AvailableSlot[]> {
    try {
        const rows = await prisma.$queryRawUnsafe<any[]>(`
            SELECT
                c."slotKey",
                c."dayOfWeek",
                c.name AS class_name,
                c."startTime",
                c."endTime",
                c.capacity,
                COUNT(CASE WHEN e.status = 'ACTIVE' THEN 1 END)::int AS enrolled
            FROM "Class" c
            LEFT JOIN "Enrollment" e ON c.id = e."classId"
            WHERE c."slotKey" IS NOT NULL
            GROUP BY c.id
            ORDER BY
                CASE c."dayOfWeek"
                    WHEN 'Mon' THEN 1
                    WHEN 'Tue' THEN 2
                    WHEN 'Wed' THEN 3
                    WHEN 'Thu' THEN 4
                    WHEN 'Fri' THEN 5
                    WHEN 'Sat' THEN 6
                    WHEN 'Sun' THEN 7
                END,
                c."startTime"
        `);

        return rows.map((r) => ({
            slotKey: r.slotKey ?? r.slotkey,
            dayOfWeek: r.dayOfWeek ?? r.dayofweek,
            dayLabel: DAY_LABELS[(r.dayOfWeek ?? r.dayofweek)] || (r.dayOfWeek ?? r.dayofweek),
            className: r.class_name,
            startTime: r.startTime ?? r.starttime,
            endTime: r.endTime ?? r.endtime,
            capacity: r.capacity,
            enrolled: r.enrolled,
            available: r.capacity - r.enrolled,
        }));
    } catch (e) {
        console.error("[getAvailableTrialSlots] failed:", e);
        return [];
    }
}

// 수강 신청 입력
export interface EnrollmentShuttleLocationData {
    address: string;
    roadAddress?: string;
    placeName?: string; // 지도에서 선택한 장소명(선택). 라벨(shuttlePickup/shuttleDropoff)에 우선 저장.
    latitude: number;
    longitude: number;
    placeId?: string;
    source: "MAP_PIN" | "SEARCH" | "CURRENT_LOCATION";
    accuracyMeters?: number;
    confirmedAt?: string;
}

interface EnrollApplicationInput {
    existingId?: string;
    accessCode?: string;         // 만료·활성 검증을 거치는 체험 연동 코드
    childName: string;
    childBirthDate: string;      // ISO 문자열 "2018-05-15"
    childGender?: string;
    childGrade?: string;
    childSchool?: string;
    childPhone?: string;
    parentName: string;
    parentPhone: string;
    parentRelation?: string;
    address?: string;
    enrollmentMonths?: string;   // 쉼표 구분 "2026년 7월,2026년 8월"
    preferredSlotKeys?: string;  // 쉼표 구분 "Mon-4,Wed-6"
    basketballExp?: string;      // 농구 경험
    uniformSize?: string;
    shuttleNeeded?: boolean;
    shuttlePickup?: string;
    shuttleTime?: string;        // 셔틀 희망 시간
    shuttleDropoff?: string;     // 셔틀 하차 장소
    shuttlePickupLocationData?: EnrollmentShuttleLocationData;
    shuttleDropoffLocationData?: EnrollmentShuttleLocationData;
    shuttleLocationConsent?: boolean;
    shuttleLocationConsentVersion?: string;
    paymentMethod?: string;
    referralSource?: string;
    memo?: string;
    agreedTerms: boolean;
    agreedPrivacy: boolean;
    applicationNoticeConfirmed?: boolean;
    shuttleNoticeConfirmed?: boolean;
    honeypot?: string;           // 스팸 방지용 숨김 필드
}

export interface ExistingEnrollApplicationForEdit {
    id: string;
    editable: boolean;
    childName: string;
    childBirthDate: string | null;
    childGender: string | null;
    childGrade: string | null;
    childSchool: string | null;
    childPhone: string | null;
    parentName: string;
    parentPhone: string;
    parentRelation: string | null;
    address: string | null;
    enrollmentMonths: string[];
    preferredSlotKeys: string[];
    basketballExp: string | null;
    shuttleNeeded: boolean;
    shuttlePickup: string | null;
    shuttleTime: string | null;
    shuttleDropoff: string | null;
    shuttlePickupLocationData: EnrollmentShuttleLocationData | null;
    shuttleDropoffLocationData: EnrollmentShuttleLocationData | null;
    shuttleLocationConsent: boolean;
    shuttleLocationConsentVersion: string | null;
    referralSource: string | null;
    memo: string | null;
    status: string;
}

function normalizeEnrollmentShuttleLocation(
    value: EnrollmentShuttleLocationData | undefined,
    label: string,
): EnrollmentShuttleLocationData {
    const address = value?.address?.trim();
    const latitude = Number(value?.latitude);
    const longitude = Number(value?.longitude);
    const accuracyMeters = value?.accuracyMeters == null ? undefined : Number(value.accuracyMeters);
    const source = value?.source;
    if (
        !address
        || !Number.isFinite(latitude)
        || !Number.isFinite(longitude)
        || latitude < -90
        || latitude > 90
        || longitude < -180
        || longitude > 180
        || !["MAP_PIN", "SEARCH", "CURRENT_LOCATION"].includes(source || "")
        || (accuracyMeters != null && (!Number.isFinite(accuracyMeters) || accuracyMeters < 0 || accuracyMeters > 1_000_000))
    ) {
        throw new Error(`${label} 위치를 지도에서 다시 선택해주세요.`);
    }
    return {
        address,
        roadAddress: value?.roadAddress?.trim() || undefined,
        placeName: value?.placeName?.trim() || undefined, // 장소명 보존(없으면 undefined, 저장 시 주소 폴백)
        latitude,
        longitude,
        placeId: value?.placeId?.trim() || undefined,
        source: source as EnrollmentShuttleLocationData["source"],
        accuracyMeters,
        confirmedAt: new Date().toISOString(),
    };
}

function enrollmentLocationFromRow(row: any, prefix: "Pickup" | "Dropoff"): EnrollmentShuttleLocationData | null {
    const address = rowValue(row, `shuttle${prefix}Address`, `shuttle${prefix.toLowerCase()}address`);
    const lat = rowValue(row, `shuttle${prefix}Latitude`, `shuttle${prefix.toLowerCase()}latitude`);
    const lng = rowValue(row, `shuttle${prefix}Longitude`, `shuttle${prefix.toLowerCase()}longitude`);
    const confirmedAt = rowValue(row, `shuttle${prefix}ConfirmedAt`, `shuttle${prefix.toLowerCase()}confirmedat`);
    const source = rowValue(row, `shuttle${prefix}Source`, `shuttle${prefix.toLowerCase()}source`);
    if (
        !address
        || lat == null
        || lng == null
        || !confirmedAt
        || !["MAP_PIN", "SEARCH", "CURRENT_LOCATION"].includes(source || "")
    ) return null;
    return {
        address,
        roadAddress: rowValue(row, `shuttle${prefix}RoadAddress`, `shuttle${prefix.toLowerCase()}roadaddress`) || undefined,
        latitude: Number(lat),
        longitude: Number(lng),
        placeId: rowValue(row, `shuttle${prefix}PlaceId`, `shuttle${prefix.toLowerCase()}placeid`) || undefined,
        source: source as EnrollmentShuttleLocationData["source"],
        accuracyMeters: rowValue(row, `shuttle${prefix}AccuracyMeters`, `shuttle${prefix.toLowerCase()}accuracymeters`) ?? undefined,
        confirmedAt: new Date(confirmedAt).toISOString(),
    };
}

async function resolveTrialLeadIdFromEnrollmentAccess(accessCode?: string | null) {
    if (!accessCode || !/^[A-Za-z0-9_-]{16}$/.test(accessCode)) return null;

    const rows = await prisma.$queryRawUnsafe<Array<{ trialLeadId: string }>>(
        `SELECT "trialLeadId"
           FROM "EnrollmentShortLink"
          WHERE code = $1
            AND "isActive" = true
            AND "expiresAt" > NOW()
          LIMIT 1`,
        accessCode,
    );
    return rows[0]?.trialLeadId ?? null;
}

export async function findExistingEnrollApplicationForEdit(input: {
    accessCode?: string | null;
    childName?: string;
    childBirthDate?: string;
    parentPhone?: string;
}): Promise<ExistingEnrollApplicationForEdit | null> {
    const childName = input.childName?.trim();
    const phoneDigits = input.parentPhone?.replace(/\D/g, "") || "";
    if (!input.accessCode && (!childName || phoneDigits.length < 10 || phoneDigits.length > 11)) return null;

    await ensureEnrollmentApplicationTable();
    const trialLeadId = await resolveTrialLeadIdFromEnrollmentAccess(input.accessCode);

    const rows = trialLeadId
        ? await prisma.$queryRawUnsafe<any[]>(
            `SELECT *
               FROM "EnrollmentApplication"
              WHERE "trialLeadId" = $1
                AND status IN ('PENDING', 'APPROVED')
              ORDER BY "updatedAt" DESC, "createdAt" DESC
              LIMIT 1`,
            trialLeadId,
        )
        : await prisma.$queryRawUnsafe<any[]>(
            `SELECT *
               FROM "EnrollmentApplication"
              WHERE LOWER(TRIM("childName")) = LOWER($1)
                AND regexp_replace(COALESCE("parentPhone", ''), '[^0-9]', '', 'g') = $2
                AND ($3::date IS NULL OR "childBirthDate"::date = $3::date)
                AND status IN ('PENDING', 'APPROVED')
              ORDER BY
                CASE status WHEN 'PENDING' THEN 1 ELSE 2 END,
                "updatedAt" DESC,
                "createdAt" DESC
              LIMIT 1`,
            childName,
            phoneDigits,
            input.childBirthDate || null,
        );

    const row = rows[0];
    if (!row) return null;
    const status = row.status || "PENDING";

    return {
        id: row.id,
        editable: status === "PENDING",
        childName: rowValue(row, "childName", "childname") || childName || "",
        childBirthDate: dateInputValue(rowValue(row, "childBirthDate", "childbirthdate")),
        childGender: rowValue(row, "childGender", "childgender"),
        childGrade: rowValue(row, "childGrade", "childgrade"),
        childSchool: rowValue(row, "childSchool", "childschool"),
        childPhone: rowValue(row, "childPhone", "childphone"),
        parentName: rowValue(row, "parentName", "parentname") || "",
        parentPhone: rowValue(row, "parentPhone", "parentphone") || normalizePhone(input.parentPhone || ""),
        parentRelation: rowValue(row, "parentRelation", "parentrelation"),
        address: row.address ?? null,
        enrollmentMonths: csvToList(rowValue(row, "enrollmentMonths", "enrollmentmonths")),
        preferredSlotKeys: csvToList(rowValue(row, "preferredSlotKeys", "preferredslotkeys")),
        basketballExp: rowValue(row, "basketballExp", "basketballexp"),
        shuttleNeeded: Boolean(rowValue(row, "shuttleNeeded", "shuttleneeded")),
        shuttlePickup: rowValue(row, "shuttlePickup", "shuttlepickup"),
        shuttleTime: rowValue(row, "shuttleTime", "shuttletime"),
        shuttleDropoff: rowValue(row, "shuttleDropoff", "shuttledropoff"),
        shuttlePickupLocationData: enrollmentLocationFromRow(row, "Pickup"),
        shuttleDropoffLocationData: enrollmentLocationFromRow(row, "Dropoff"),
        shuttleLocationConsent: Boolean(rowValue(row, "shuttleLocationConsentAt", "shuttlelocationconsentat")),
        shuttleLocationConsentVersion: rowValue(row, "shuttleLocationConsentVersion", "shuttlelocationconsentversion"),
        referralSource: rowValue(row, "referralSource", "referralsource"),
        memo: row.memo ?? null,
        status,
    };
}

/**
 * submitEnrollApplication - 수강 신청을 접수합니다.
 *
 * 검증 사항:
 * 1. honeypot 필드가 비어 있어야 합니다.
 * 2. 아이 이름, 생년월일, 보호자 이름, 전화번호는 필수입니다.
 * 3. 약관 동의가 필요합니다.
 * 4. trialLeadId가 있으면 연결된 체험 문의가 실제로 존재하는지 확인합니다.
 */
export async function submitEnrollApplication(data: EnrollApplicationInput) {
    // 스팸 방지: 숨김 필드에 값이 있으면 자동 입력으로 보고 조용히 성공 처리합니다.
    if (data.honeypot) {
        return { success: true, id: "ok" };
    }

    const childName = data.childName?.trim();
    const parentName = data.parentName?.trim();
    const parentPhone = data.parentPhone?.trim();
    const shuttlePickupLocation = data.shuttleNeeded
        ? normalizeEnrollmentShuttleLocation(data.shuttlePickupLocationData, "탑승")
        : null;
    const shuttleDropoffLocation = data.shuttleNeeded
        ? normalizeEnrollmentShuttleLocation(data.shuttleDropoffLocationData, "하차")
        : null;
    if (
        data.shuttleNeeded
        && (
            data.shuttleLocationConsent !== true
            || data.shuttleLocationConsentVersion !== SHUTTLE_LOCATION_CONSENT_VERSION
        )
    ) {
        throw new Error("셔틀 위치정보 이용 동의가 필요합니다.");
    }
    const shuttleLocationConsentVersion = data.shuttleNeeded ? SHUTTLE_LOCATION_CONSENT_VERSION : null;
    const shuttleLocationConsentAt = data.shuttleNeeded ? new Date() : null;

    if (!childName) throw new Error("아이 이름을 입력해주세요.");
    if (!data.childBirthDate) throw new Error("아이 생년월일을 입력해주세요.");
    if (!data.childPhone?.trim()) throw new Error("학생 전화번호를 입력해주세요.");
    if (!parentName) throw new Error("보호자 이름을 입력해주세요.");
    if (!parentPhone) throw new Error("보호자 연락처를 입력해주세요.");
    if (!data.childSchool?.trim()) throw new Error("학교명을 입력해주세요.");
    if (!data.enrollmentMonths?.trim()) throw new Error("수강신청 월을 선택해주세요.");
    if (!data.referralSource) throw new Error("가입경로를 선택해주세요.");
    if (data.shuttleNeeded && (!data.shuttlePickup?.trim() || !data.shuttleTime || !data.shuttleDropoff?.trim())) {
        throw new Error("셔틀 탑승을 선택한 경우 탑승 장소, 희망 시간, 하차 장소를 모두 입력해주세요.");
    }
    if (data.shuttleNeeded && !data.shuttleNoticeConfirmed) {
        throw new Error("셔틀 주의사항을 확인해주세요.");
    }
    if (!data.agreedTerms || !data.agreedPrivacy) {
        throw new Error("이용약관과 개인정보 수집/이용에 모두 동의해주세요.");
    }
    if (!data.applicationNoticeConfirmed) {
        throw new Error("수강신청 확정 안내를 확인해주세요.");
    }

    const phoneDigits = parentPhone.replace(/\D/g, "");
    if (phoneDigits.length < 10 || phoneDigits.length > 11) {
        throw new Error("올바른 전화번호를 입력해주세요.");
    }

    // 필요한 테이블과 컬럼이 없으면 자동으로 준비합니다.
    await ensureEnrollmentApplicationTable();

    let matchedTrialLeadId = await resolveTrialLeadIdFromEnrollmentAccess(data.accessCode);

    // 같은 아이의 기존 신청서(재제출)를 먼저 찾는다. 이미 체험과 연결돼 있으면 그 연결을 그대로 쓰고,
    // 아니면 판정에 이 신청서 id 를 넘겨 "자기 신청서에 연결된 체험"이 타 신청서 연결로 제외되지 않게 한다.
    let priorApplicationId: string | null = null;
    if (!matchedTrialLeadId) {
        try {
            const priorDigits = normalizePhone(parentPhone).replace(/\D/g, "");
            const priorRows = data.existingId
                ? await prisma.$queryRawUnsafe<Array<{ id: string; trialLeadId: string | null }>>(
                    `SELECT id, "trialLeadId"
                       FROM "EnrollmentApplication"
                      WHERE id = $1
                        AND LOWER(TRIM("childName")) = LOWER($2)
                        AND regexp_replace(COALESCE("parentPhone", ''), '[^0-9]', '', 'g') = $3
                        AND status IN ('PENDING', 'APPROVED')
                      LIMIT 1`,
                    data.existingId,
                    childName,
                    priorDigits,
                )
                : await prisma.$queryRawUnsafe<Array<{ id: string; trialLeadId: string | null }>>(
                    `SELECT id, "trialLeadId"
                       FROM "EnrollmentApplication"
                      WHERE LOWER(TRIM("childName")) = LOWER($1)
                        AND regexp_replace(COALESCE("parentPhone", ''), '[^0-9]', '', 'g') = $2
                        AND "childBirthDate"::date = $3::date
                        AND status IN ('PENDING', 'APPROVED')
                      ORDER BY
                        CASE status WHEN 'PENDING' THEN 1 ELSE 2 END,
                        "updatedAt" DESC,
                        "createdAt" DESC
                      LIMIT 1`,
                    childName,
                    priorDigits,
                    data.childBirthDate,
                );
            priorApplicationId = priorRows[0]?.id ?? null;
            matchedTrialLeadId = priorRows[0]?.trialLeadId ?? null;
        } catch (priorError) {
            console.warn("[submitEnrollApplication] prior application lookup failed:", priorError);
        }
    }

    if (!matchedTrialLeadId) {
        try {
            await ensureTrialLeadTable();
            // 안내 링크 없이 직접 신청한 경우: 같은 보호자 번호의 체험 기록과 비교한다.
            // 이름 완전 일치뿐 아니라 "성 같고 1글자 오타"도 후보가 정확히 1명이면 자동 연결(AUTO).
            // 애매한 경우(SUGGEST)는 여기서 연결하지 않고 관리자 신청 목록에 후보로만 보인다.
            const decision = await decideTrialLeadForNewApplication({
                applicationId: priorApplicationId,
                childName,
                parentPhone,
                childSchool: data.childSchool ?? null,
                childGrade: data.childGrade ?? null,
                childBirthYmd: isKstYmd(data.childBirthDate) ? data.childBirthDate : null,
                preferredSlotKeys: data.preferredSlotKeys ?? null,
                appliedYmd: todayKst(),
            });
            matchedTrialLeadId = decision.decision === "AUTO" ? decision.trialLeadId : null;
        } catch (matchError) {
            console.warn("[submitEnrollApplication] trial lead auto match failed:", matchError);
        }
    }

    try {
        const normalizedParentPhone = normalizePhone(parentPhone);
        const normalizedPhoneDigits = normalizedParentPhone.replace(/\D/g, "");
        const existingRows = data.existingId
            ? await prisma.$queryRawUnsafe<Array<{ id: string; status: string }>>(
                `SELECT id, status
                   FROM "EnrollmentApplication"
                  WHERE id = $1
                    AND LOWER(TRIM("childName")) = LOWER($2)
                    AND regexp_replace(COALESCE("parentPhone", ''), '[^0-9]', '', 'g') = $3
                    AND status IN ('PENDING', 'APPROVED')
                  LIMIT 1`,
                data.existingId,
                childName,
                normalizedPhoneDigits,
            )
            : matchedTrialLeadId
            ? await prisma.$queryRawUnsafe<Array<{ id: string; status: string }>>(
                `SELECT id, status
                   FROM "EnrollmentApplication"
                  WHERE "trialLeadId" = $1
                    AND status IN ('PENDING', 'APPROVED')
                  ORDER BY
                    CASE status WHEN 'PENDING' THEN 1 ELSE 2 END,
                    "updatedAt" DESC,
                    "createdAt" DESC
                  LIMIT 1`,
                matchedTrialLeadId,
            )
            : await prisma.$queryRawUnsafe<Array<{ id: string; status: string }>>(
                `SELECT id, status
                   FROM "EnrollmentApplication"
                  WHERE LOWER(TRIM("childName")) = LOWER($1)
                    AND regexp_replace(COALESCE("parentPhone", ''), '[^0-9]', '', 'g') = $2
                    AND "childBirthDate"::date = $3::date
                    AND status IN ('PENDING', 'APPROVED')
                  ORDER BY
                    CASE status WHEN 'PENDING' THEN 1 ELSE 2 END,
                    "updatedAt" DESC,
                    "createdAt" DESC
                  LIMIT 1`,
                childName,
                normalizedPhoneDigits,
                data.childBirthDate,
            );

        const existingApplication = existingRows[0];
        if (existingApplication?.status === "APPROVED") {
            const handoff = await issueEnrollmentAccountHandoffSafely(existingApplication.id);
            return {
                success: true,
                id: existingApplication.id,
                mode: "existing" as const,
                duplicate: true,
                accountHandoff: handoff ? {
                    token: handoff,
                    next: "/signup/parent",
                    parentName,
                    parentPhone: normalizedParentPhone,
                } : undefined,
            };
        }

        if (existingApplication?.id) {
            await prisma.$executeRawUnsafe(
                `UPDATE "EnrollmentApplication" SET
                    "trialLeadId" = COALESCE($1, "trialLeadId"), -- 재제출로 기존 체험 연결을 지우지 않는다
                    "childName" = $2,
                    "childBirthDate" = $3::timestamptz,
                    "childGender" = $4,
                    "childGrade" = $5,
                    "childSchool" = $6,
                    "childPhone" = $7,
                    "parentName" = $8,
                    "parentPhone" = $9,
                    "parentRelation" = $10,
                    address = $11,
                    "enrollmentMonths" = $12,
                    "preferredSlotKeys" = $13,
                    "basketballExp" = $14,
                    "uniformSize" = $15,
                    "shuttleNeeded" = $16,
                    "shuttlePickup" = $17,
                    "shuttleTime" = $18,
                    "shuttleDropoff" = $19,
                    "paymentMethod" = $20,
                    "referralSource" = $21,
                    memo = $22,
                    "agreedTerms" = $23,
                    "agreedPrivacy" = $24,
                    "applicationNoticeConfirmed" = $25,
                    "shuttleNoticeConfirmed" = $26,
                    "shuttlePickupAddress" = $27,
                    "shuttlePickupRoadAddress" = $28,
                    "shuttlePickupLatitude" = $29,
                    "shuttlePickupLongitude" = $30,
                    "shuttlePickupPlaceId" = $31,
                    "shuttlePickupSource" = $32,
                    "shuttlePickupAccuracyMeters" = $33,
                    "shuttlePickupConfirmedAt" = $34::timestamptz,
                    "shuttleDropoffAddress" = $35,
                    "shuttleDropoffRoadAddress" = $36,
                    "shuttleDropoffLatitude" = $37,
                    "shuttleDropoffLongitude" = $38,
                    "shuttleDropoffPlaceId" = $39,
                    "shuttleDropoffSource" = $40,
                    "shuttleDropoffAccuracyMeters" = $41,
                    "shuttleDropoffConfirmedAt" = $42::timestamptz,
                    "shuttleLocationConsentVersion" = $43,
                    "shuttleLocationConsentAt" = $44::timestamptz,
                    "updatedAt" = NOW()
                  WHERE id = $45`,
                matchedTrialLeadId || null,
                childName,
                data.childBirthDate,
                data.childGender || null,
                data.childGrade || null,
                data.childSchool || null,
                data.childPhone || null,
                parentName,
                normalizedParentPhone,
                data.parentRelation || null,
                data.address?.trim() || null,
                data.enrollmentMonths || null,
                data.preferredSlotKeys || null,
                data.basketballExp || null,
                data.uniformSize || null,
                data.shuttleNeeded ?? false,
                // 라벨 컬럼에 장소명 우선 저장(없으면 기존 텍스트 라벨로 폴백). 좌표/주소 컬럼은 별도로 그대로 저장됨.
                shuttlePickupLocation?.placeName ?? (data.shuttlePickup?.trim() || null),
                data.shuttleTime || null,
                shuttleDropoffLocation?.placeName ?? (data.shuttleDropoff?.trim() || null),
                data.paymentMethod || null,
                data.referralSource || null,
                data.memo?.trim() || null,
                data.agreedTerms,
                data.agreedPrivacy,
                data.applicationNoticeConfirmed ?? false,
                data.shuttleNoticeConfirmed ?? false,
                shuttlePickupLocation?.address ?? null,
                shuttlePickupLocation?.roadAddress ?? null,
                shuttlePickupLocation?.latitude ?? null,
                shuttlePickupLocation?.longitude ?? null,
                shuttlePickupLocation?.placeId ?? null,
                shuttlePickupLocation?.source ?? null,
                shuttlePickupLocation?.accuracyMeters ?? null,
                shuttlePickupLocation?.confirmedAt ?? null,
                shuttleDropoffLocation?.address ?? null,
                shuttleDropoffLocation?.roadAddress ?? null,
                shuttleDropoffLocation?.latitude ?? null,
                shuttleDropoffLocation?.longitude ?? null,
                shuttleDropoffLocation?.placeId ?? null,
                shuttleDropoffLocation?.source ?? null,
                shuttleDropoffLocation?.accuracyMeters ?? null,
                shuttleDropoffLocation?.confirmedAt ?? null,
                shuttleLocationConsentVersion,
                shuttleLocationConsentAt,
                existingApplication.id,
            );

            if (matchedTrialLeadId) {
                await prisma.$executeRawUnsafe(
                    `UPDATE "TrialLead"
                     SET "enrollApplicationReceivedAt" = COALESCE("enrollApplicationReceivedAt", NOW()),
                         "enrollApplicationId" = $1,
                         "updatedAt" = NOW()
                     WHERE id = $2`,
                    existingApplication.id,
                    matchedTrialLeadId,
                );
            }

            revalidatePath("/admin");
            revalidatePath("/admin/apply");
            revalidatePath("/admin/trial");
            const handoff = await issueEnrollmentAccountHandoffSafely(existingApplication.id);
            return {
                success: true,
                id: existingApplication.id,
                mode: "updated" as const,
                duplicate: true,
                accountHandoff: handoff ? {
                    token: handoff,
                    next: "/signup/parent",
                    parentName,
                    parentPhone: normalizedParentPhone,
                } : undefined,
            };
        }

        const recentSubmissions = await prisma.$queryRawUnsafe<{ count: number }[]>(
            `SELECT COUNT(*)::int AS count
               FROM "EnrollmentApplication"
              WHERE regexp_replace(COALESCE("parentPhone", ''), '[^0-9]', '', 'g') = $1
                AND "createdAt" > NOW() - INTERVAL '10 minutes'`,
            normalizedPhoneDigits,
        );
        if (Number(recentSubmissions[0]?.count ?? 0) >= 5) {
            throw new Error("신청이 너무 많이 접수되었습니다. 잠시 후 다시 시도해주세요.");
        }

        const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
            `INSERT INTO "EnrollmentApplication" (
                id, "trialLeadId",
                "childName", "childBirthDate", "childGender", "childGrade", "childSchool", "childPhone",
                "parentName", "parentPhone", "parentRelation", address,
                "enrollmentMonths", "preferredSlotKeys", "basketballExp", "uniformSize",
                "shuttleNeeded", "shuttlePickup", "shuttleTime", "shuttleDropoff",
                "paymentMethod", "referralSource", memo,
                "agreedTerms", "agreedPrivacy", "applicationNoticeConfirmed", "shuttleNoticeConfirmed",
                "shuttlePickupAddress", "shuttlePickupRoadAddress",
                "shuttlePickupLatitude", "shuttlePickupLongitude", "shuttlePickupPlaceId",
                "shuttlePickupSource", "shuttlePickupAccuracyMeters", "shuttlePickupConfirmedAt",
                "shuttleDropoffAddress", "shuttleDropoffRoadAddress",
                "shuttleDropoffLatitude", "shuttleDropoffLongitude", "shuttleDropoffPlaceId",
                "shuttleDropoffSource", "shuttleDropoffAccuracyMeters", "shuttleDropoffConfirmedAt",
                "shuttleLocationConsentVersion", "shuttleLocationConsentAt",
                status, "createdAt", "updatedAt"
            ) VALUES (
                gen_random_uuid()::text, $1,
                $2, $3::timestamptz, $4, $5, $6, $7,
                $8, $9, $10, $11,
                $12, $13, $14, $15,
                $16, $17, $18, $19,
                $20, $21, $22,
                $23, $24, $25, $26,
                $27, $28, $29, $30, $31, $32, $33, $34::timestamptz,
                $35, $36, $37, $38, $39, $40, $41, $42::timestamptz,
                $43, $44::timestamptz,
                'PENDING', NOW(), NOW()
            ) RETURNING id`,
            matchedTrialLeadId || null,         // $1
            childName,                          // $2
            data.childBirthDate,                // $3
            data.childGender || null,           // $4
            data.childGrade || null,            // $5
            data.childSchool || null,           // $6
            data.childPhone || null,            // $7
            parentName,                         // $8
            normalizePhone(parentPhone),        // $9
            data.parentRelation || null,        // $10
            data.address?.trim() || null,       // $11
            data.enrollmentMonths || null,      // $12
            data.preferredSlotKeys || null,     // $13
            data.basketballExp || null,         // $14
            data.uniformSize || null,           // $15
            data.shuttleNeeded ?? false,        // $16
            shuttlePickupLocation?.placeName ?? (data.shuttlePickup?.trim() || null), // $17 라벨: 장소명 우선(폴백=텍스트 라벨)
            data.shuttleTime || null,           // $18
            shuttleDropoffLocation?.placeName ?? (data.shuttleDropoff?.trim() || null),// $19 라벨: 장소명 우선(폴백=텍스트 라벨)
            data.paymentMethod || null,         // $20
            data.referralSource || null,        // $21
            data.memo?.trim() || null,          // $22
            data.agreedTerms,                   // $23
            data.agreedPrivacy,                 // $24
            data.applicationNoticeConfirmed ?? false, // $25
            data.shuttleNoticeConfirmed ?? false,     // $26
            shuttlePickupLocation?.address ?? null, // $27
            shuttlePickupLocation?.roadAddress ?? null, // $28
            shuttlePickupLocation?.latitude ?? null, // $29
            shuttlePickupLocation?.longitude ?? null, // $30
            shuttlePickupLocation?.placeId ?? null, // $31
            shuttlePickupLocation?.source ?? null, // $32
            shuttlePickupLocation?.accuracyMeters ?? null, // $33
            shuttlePickupLocation?.confirmedAt ?? null, // $34
            shuttleDropoffLocation?.address ?? null, // $35
            shuttleDropoffLocation?.roadAddress ?? null, // $36
            shuttleDropoffLocation?.latitude ?? null, // $37
            shuttleDropoffLocation?.longitude ?? null, // $38
            shuttleDropoffLocation?.placeId ?? null, // $39
            shuttleDropoffLocation?.source ?? null, // $40
            shuttleDropoffLocation?.accuracyMeters ?? null, // $41
            shuttleDropoffLocation?.confirmedAt ?? null, // $42
            shuttleLocationConsentVersion, // $43
            shuttleLocationConsentAt, // $44
        );

        if (matchedTrialLeadId && rows[0]?.id) {
            await prisma.$executeRawUnsafe(
                `UPDATE "TrialLead"
                 SET "enrollApplicationReceivedAt" = COALESCE("enrollApplicationReceivedAt", NOW()),
                     "enrollApplicationId" = $1,
                     "updatedAt" = NOW()
                 WHERE id = $2`,
                rows[0].id,
                matchedTrialLeadId,
            );
        }

        revalidatePath("/admin");

        const smsVars = {
            childName,
            childGrade: data.childGrade || "학년 미입력",
            parentName,
            parentPhone: normalizePhone(parentPhone),
            // 연락처 저장용 이름 `2610 이성빈 화6목6 초6` — 관리자 알림 문자에서 복사해 쓴다.
            contactSaveName: buildContactSaveName({ childName, childGrade: data.childGrade, slotKeys: data.preferredSlotKeys }),
        };

        // 관리자에게 알림을 보냅니다. 발송 실패가 신청 저장을 막지는 않습니다.
        // 템플릿 기반 SMS: ENROLL_NEW_ADMIN(관리자), ENROLL_NEW_COACH(코치)
        // slotKeys가 있으면 해당 수업 담당 코치에게만 SMS를 보낼 수 있습니다.
        revalidatePath("/admin");
        revalidatePath("/admin/apply");
        revalidatePath("/admin/trial");

        const enrollSlotKeys = data.preferredSlotKeys
            ? data.preferredSlotKeys.split(",").map(k => k.trim()).filter(Boolean)
            : undefined;
        const enrollmentApplicationId = rows[0]?.id || "ok";
        await notifyAdmins(
            "ENROLL_APPLICATION",
            "수강 신청",
            `${childName} (${data.childGrade || "학년 미입력"}) - ${parentName}`,
            "/admin/apply",
            {
                adminTrigger: "ENROLL_NEW_ADMIN",
                coachTrigger: "ENROLL_NEW_COACH",
                notifyCoaches: false,
                variables: smsVars,
                slotKeys: enrollSlotKeys,
                eventId: enrollmentApplicationId,
            },
        ).catch(() => {});

        // 학부모에게 접수 확인 SMS를 보냅니다.
        await sendParentSmsWithAcademyPhone(
            normalizePhone(parentPhone),
            "ENROLL_CONFIRM_PARENT",
            { childName, parentName },
            { eventType: "ENROLL_APPLICATION", eventId: enrollmentApplicationId },
        ).catch(() => {});

        const handoff = await issueEnrollmentAccountHandoffSafely(enrollmentApplicationId);
        return {
            success: true,
            id: enrollmentApplicationId,
            mode: "created" as const,
            accountHandoff: handoff ? {
                token: handoff,
                next: "/signup/parent",
                parentName,
                parentPhone: normalizePhone(parentPhone),
            } : undefined,
        };
    } catch (e) {
        console.error("[submitEnrollApplication] failed:", e);
        throw new Error("수강 신청 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.");
    }
}

// 체험 데이터 자동 채우기
export interface TrialLeadForEnroll {
    childName: string;
    childBirthDate: string | null;
    childGrade: string | null;
    childGender: string | null;
    childSchool: string | null;
    childPhone: string | null;
    basketballExp: string | null;
    preferredSlotKey: string | null;
    parentName: string;
    parentPhone: string;
    source: string;
}

let _trialLeadChildPhoneColumnEnsured = false;
async function ensureTrialLeadChildPhoneColumn() {
    if (_trialLeadChildPhoneColumnEnsured) return;
    await prisma.$executeRawUnsafe(`ALTER TABLE "TrialLead" ADD COLUMN IF NOT EXISTS "childPhone" TEXT`);
    _trialLeadChildPhoneColumnEnsured = true;
}

/**
 * 유효한 수강신청 접근 코드로 체험 정보를 안전하게 자동 입력합니다.
 *
 * 공개 함수이므로 관리자 메모 등 민감 정보는 제외하고,
 * 이름, 생년월일, 학년, 성별, 학교, 연락처, 농구 경험, 희망 수업, 보호자 정보만 반환합니다.
 */
export async function getTrialLeadForEnrollByAccessCode(accessCode: string): Promise<TrialLeadForEnroll | null> {
    if (!/^[A-Za-z0-9_-]{16}$/.test(accessCode)) return null;

    try {
        // TrialLead 테이블이 존재하는지 먼저 확인합니다.
        await ensureTrialLeadTable();
        await ensureTrialLeadChildPhoneColumn();

        const rows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT t."childName", t."childBirthDate", t."childGrade", t."childGender",
                    t."childSchool", t."childPhone", t."basketballExp",
                    COALESCE(c."slotKey", t."preferredSlotKey") AS "preferredSlotKey",
                    t."parentName", t."parentPhone", t.source
             FROM "EnrollmentShortLink" l
             JOIN "TrialLead" t ON t.id = l."trialLeadId"
             LEFT JOIN "Class" c ON c.id = t."scheduledClassId"
             WHERE l.code = $1
               AND l."isActive" = true
               AND l."expiresAt" > NOW()
             LIMIT 1`,
            accessCode
        );

        if (rows.length === 0) return null;

        const r = rows[0];
        const parentName = (r.parentName ?? r.parentname ?? "").trim();
        return {
            childName: r.childName ?? r.childname ?? "",
            childBirthDate: r.childBirthDate ?? r.childbirthdate
                ? new Date(r.childBirthDate ?? r.childbirthdate).toISOString().split("T")[0]
                : null,
            childGrade: r.childGrade ?? r.childgrade ?? null,
            childGender: r.childGender ?? r.childgender ?? null,
            childSchool: r.childSchool ?? r.childschool ?? null,
            childPhone: r.childPhone ?? r.childphone ?? null,
            basketballExp: r.basketballExp ?? r.basketballexp ?? null,
            preferredSlotKey: r.preferredSlotKey ?? r.preferredslotkey ?? null,
            parentName: parentName === "미입력" ? "" : parentName,
            parentPhone: r.parentPhone ?? r.parentphone ?? "",
            source: r.source ?? "WEBSITE",
        };
    } catch (e) {
        console.error("[getTrialLeadForEnrollByAccessCode] failed:", e);
        return null;
    }
}

// 학부모 SMS 발송: 학원 전화번호를 DB에서 조회해 템플릿 변수에 포함합니다.
// PARENT 템플릿은 {{academyPhone}} 변수를 사용하는 경우가 많습니다.
// fire-and-forget 패턴이라 발송 실패가 메인 로직에 영향을 주지 않습니다.
async function sendParentSmsWithAcademyPhone(
    parentPhone: string,
    trigger: string,
    baseVars: Record<string, string>,
    options?: { eventType?: string; eventId?: string },
) {
    try {
        // 학원 전화번호 조회
        const settings = await prisma.$queryRawUnsafe<any[]>(
            `SELECT "contactPhone" FROM "AcademySettings" WHERE id = 'singleton' LIMIT 1`
        );
        const academyPhone = settings[0]?.contactPhone ?? settings[0]?.contactphone ?? "";

        // 템플릿 변수에 academyPhone 추가
        const vars = { ...baseVars, academyPhone };

        // notification.ts의 sendParentSms 호출
        const { sendParentSms: sps } = await import("@/lib/notification");
        await sps(parentPhone, trigger, vars, options);
    } catch (e) {
        console.error(`[sendParentSmsWithAcademyPhone] trigger=${trigger} failed:`, e);
    }
}
