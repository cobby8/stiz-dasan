/**
 * 순수 DB 조회 함수들 (mutations 제외)
 * react.cache() 로 감싸 동일 요청 내 중복 DB 호출을 자동 제거 (request-level memoization)
 * "use server" 없음 — 일반 서버 모듈로 import 가능
 */
import { cache } from "react";
import { unstable_cache } from "next/cache";
import { prisma } from "@/lib/prisma";
import { ensurePaymentInfrastructure } from "@/lib/payment-ledger";
import { notMergedStudent, notMergedStudentOptional } from "@/lib/studentVisibility";
import { kstDow } from "@/lib/datetime/kst";
// 보강 잔여석 계산은 화면·조회·저장 검증이 같은 식을 쓰도록 공용 모듈로 분리해 둔다.
import { activeMakeupSql, computeRemainingSeats } from "@/lib/makeup/capacity";
import type { SheetClassSlot } from "@/lib/googleSheetsSchedule";

// 값을 불리언으로 안전 변환 (TEXT 컬럼에서 'false' 문자열이 올 수 있음)
const toBool = (v: any, fallback: boolean): boolean => {
    if (v === true || v === 'true') return true;
    if (v === false || v === 'false') return false;
    return fallback;
};

function isMissingApplicationContactLogError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes("ApplicationContactLog") && message.includes("does not exist");
}

type AdminListQueryOptions = {
    status?: string;
    limit?: number;
    offset?: number;
};

function normalizeAdminListQueryOptions(input?: string | AdminListQueryOptions): AdminListQueryOptions {
    if (typeof input === "string") return { status: input };
    if (!input) return {};

    const limit =
        typeof input.limit === "number" && Number.isFinite(input.limit) && input.limit > 0
            ? Math.min(Math.floor(input.limit), 201)
            : undefined;
    const offset =
        typeof input.offset === "number" && Number.isFinite(input.offset) && input.offset > 0
            ? Math.floor(input.offset)
            : 0;

    return {
        status: input.status,
        limit,
        offset,
    };
}

function adminListLimitClause(options: AdminListQueryOptions) {
    if (!options.limit) return "";
    return ` LIMIT ${options.limit} OFFSET ${options.offset ?? 0}`;
}

export const ACADEMY_SETTINGS_CACHE_TAG = "academy-settings";

async function fetchAcademySettings() {
    // PgBouncer 트랜잭션 모드 호환을 위해 $queryRawUnsafe 사용 (prepared statement 우회)
    try {
        const rows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT * FROM "AcademySettings" WHERE id = 'singleton' LIMIT 1`
        );
        if (rows[0]) {
            const r = rows[0];
            // 컬럼명 대소문자 차이 대응: camelCase 우선, 소문자 fallback
            return {
                id: r.id,
                introductionTitle: r.introductionTitle ?? r.introductiontitle ?? null,
                introductionText: r.introductionText ?? r.introductiontext ?? null,
                shuttleInfoText: r.shuttleInfoText ?? r.shuttleinfotext ?? null,
                contactPhone: r.contactPhone ?? r.contactphone ?? null,
                address: r.address ?? null,
                operatingHours: r.operatingHours ?? r.operatinghours ?? null,
                privacyPolicy: r.privacyPolicy ?? r.privacypolicy ?? null,
                footerDescription: r.footerDescription ?? r.footerdescription ?? null,
                footerCopyright: r.footerCopyright ?? r.footercopyright ?? null,
                pageDesignJSON: r.pageDesignJSON ?? r.pagedesignjson ?? null,
                googleCalendarIcsUrl: r.googleCalendarIcsUrl ?? r.googlecalendaricsurl ?? null,
                googleSheetsScheduleUrl: r.googleSheetsScheduleUrl ?? r.googlesheetsscheduleurl ?? null,
                classDays: r.classDays ?? r.classdays ?? null,
                siteBodyFont: r.siteBodyFont ?? r.sitebodyfont ?? "system",
                siteHeadingFont: r.siteHeadingFont ?? r.siteheadingfont ?? "system",
                termsOfService: r.termsOfService ?? r.termsofservice ?? null,
                trialTitle: r.trialTitle ?? r.trialtitle ?? "체험수업 안내",
                trialContent: r.trialContent ?? r.trialcontent ?? null,
                trialFormUrl: r.trialFormUrl ?? r.trialformurl ?? null,
                enrollTitle: r.enrollTitle ?? r.enrolltitle ?? "수강신청 안내",
                enrollContent: r.enrollContent ?? r.enrollcontent ?? null,
                enrollFormUrl: r.enrollFormUrl ?? r.enrollformurl ?? null,
                youtubeUrl: r.youtubeUrl ?? r.youtubeurl ?? null,
                instagramUrl: r.instagramUrl ?? r.instagramurl ?? null,
                instagramBusinessAccountId: r.instagramBusinessAccountId ?? r.instagrambusinessaccountid ?? null,
                instagramAutoPublishEnabled: toBool(r.instagramAutoPublishEnabled ?? r.instagramautopublishenabled, false),
                kakaoChannelUrl: r.kakaoChannelUrl ?? r.kakaochannelurl ?? null,
                philosophyText: r.philosophyText ?? r.philosophytext ?? null,
                facilitiesText: r.facilitiesText ?? r.facilitiestext ?? null,
                facilitiesImagesJSON: r.facilitiesImagesJSON ?? r.facilitiesimagesjson ?? null,
                galleryImagesJSON: r.galleryImagesJSON ?? r.galleryimagesjson ?? null,
                naverPlaceUrl: r.naverPlaceUrl ?? r.naverplaceurl ?? null,
                uniformFormUrl: r.uniformFormUrl ?? r.uniformformurl ?? null,
                // 셔틀 노선의 출발지·도착지로 쓰는 학원 위치(정본). 좌표는 TEXT라 읽는 쪽에서 Number()로 변환한다.
                academyPlaceName: r.academyPlaceName ?? r.academyplacename ?? null,
                academyAddress: r.academyAddress ?? r.academyaddress ?? null,
                academyLatitude: r.academyLatitude ?? r.academylatitude ?? null,
                academyLongitude: r.academyLongitude ?? r.academylongitude ?? null,
                // 셔틀 확정 명단 킬 스위치(true=확정 명단 사용 / false·NULL=끔).
                // ⚠️ 이 값은 unstable_cache(5분)를 타므로 실제 판정에는 쓰지 않는다.
                //    게이트웨이(shuttleRoster.ts)가 DB를 직접 읽는다. 여기 매핑은 설정 화면 표시용이다.
                shuttleRosterConfirmedMode: toBool(r.shuttleRosterConfirmedMode ?? r.shuttlerosterconfirmedmode, false),
                // 자체 폼 ON/OFF 플래그 (false=구글폼 모드, true=자체 폼 모드)
                // TEXT 컬럼에서 'false' 문자열이 올 수 있어 toBool로 안전 변환
                useBuiltInTrialForm: toBool(r.useBuiltInTrialForm ?? r.usebuiltintrialform, false),
                useBuiltInEnrollForm: toBool(r.useBuiltInEnrollForm ?? r.usebuiltinenrollform, false),
            } as any;
        }
    } catch {
        // 쿼리 실패 시 안전한 기본값 반환
    }
    return {
        pageDesignJSON: null,
        contactPhone: "010-0000-0000",
        operatingHours: "평일 13:00~21:00 / 토 09:00~18:00 (일요일·공휴일 휴무)",
        privacyPolicy: null,
        footerDescription: null,
        footerCopyright: null,
        instagramUrl: null,
        instagramBusinessAccountId: null,
        instagramAutoPublishEnabled: false,
        kakaoChannelUrl: null,
        address: "다산신도시 체육관",
    } as any;
}

const getCachedAcademySettings = unstable_cache(
    fetchAcademySettings,
    ["academy-settings"],
    { revalidate: 300, tags: [ACADEMY_SETTINGS_CACHE_TAG] },
);

export const getAcademySettings = cache(getCachedAcademySettings);

export const getPrograms = cache(async () => {
    // Use $queryRawUnsafe (simple query protocol) for PgBouncer transaction mode compatibility
    try {
        const rows = await prisma.$queryRawUnsafe<any[]>(
            // deletedAt IS NULL: 소프트 삭제된 프로그램은 관리자 목록·공개 카탈로그에서 제외.
            //   (이력 화면은 별도로 id 조인해 이름을 조회하므로 삭제돼도 이름은 계속 보인다)
            `SELECT id, name, "targetAge", frequency, "weeklyFrequency", description,
                    price, "order", days, "priceWeek1", "priceWeek2", "priceWeek3",
                    "priceDaily", "shuttleFeeOverride", "imageUrl", "runsShuttle", "createdAt", "updatedAt"
             FROM "Program"
             WHERE "deletedAt" IS NULL
             ORDER BY "order" ASC, "createdAt" DESC`
        );
        return rows.map((r: any) => ({
            ...r,
            price: Number(r.price ?? 0),
            order: Number(r.order ?? 0),
            priceWeek1: r.priceWeek1 != null ? Number(r.priceWeek1) : null,
            priceWeek2: r.priceWeek2 != null ? Number(r.priceWeek2) : null,
            priceWeek3: r.priceWeek3 != null ? Number(r.priceWeek3) : null,
            priceDaily: r.priceDaily != null ? Number(r.priceDaily) : null,
            shuttleFeeOverride: r.shuttleFeeOverride != null ? Number(r.shuttleFeeOverride) : null,
            runsShuttle: r.runsShuttle !== false, // null/undefined 는 운행(true)로 간주
            imageUrl: r.imageUrl ?? r.imageurl ?? null,
        }));
    } catch (e) {
        console.error("[getPrograms] failed:", e);
        return [];
    }
});

export const getClasses = cache(async () => {
    try {
        const rows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT c.id, c."programId", c."instructorId", c.name, c."dayOfWeek",
                    c."startTime", c."endTime",
                    ss."startTime" AS "scheduleStartTime", ss."endTime" AS "scheduleEndTime",
                    ss."activeFrom" AS "scheduleActiveFrom", ss."activeTo" AS "scheduleActiveTo",
                    cso."startTimeOverride", cso."endTimeOverride",
                    ccs."startTime" AS "customStartTime", ccs."endTime" AS "customEndTime",
                    c.location, c.capacity, c."slotKey",
                    c."createdAt", c."updatedAt",
                    p.id AS p_id, p.name AS p_name,
                    u.name AS instructor_name,
                    COALESCE(ss_co.id, cso_co.id, ccs_co.id) AS coach_id,
                    COALESCE(ss_co.name, cso_co.name, ccs_co.name, u.name) AS coach_name
             FROM "Class" c
             LEFT JOIN "Program" p ON c."programId" = p.id
             LEFT JOIN "User" u ON c."instructorId" = u.id
             LEFT JOIN "ScheduleSlot" ss ON ss."slotKey" = c."slotKey"
             LEFT JOIN "Coach" ss_co ON ss_co.id = ss."coachId"
             LEFT JOIN "ClassSlotOverride" cso ON cso."slotKey" = c."slotKey"
             LEFT JOIN "Coach" cso_co ON cso_co.id = cso."coachId"
             LEFT JOIN "CustomClassSlot" ccs ON c."slotKey" = ccs.id OR c."slotKey" = CONCAT('custom-', ccs.id)
             LEFT JOIN "Coach" ccs_co ON ccs_co.id = ccs."coachId"
             ORDER BY CASE c."dayOfWeek"
                        WHEN 'Mon' THEN 0 WHEN 'Tue' THEN 1 WHEN 'Wed' THEN 2
                        WHEN 'Thu' THEN 3 WHEN 'Fri' THEN 4 WHEN 'Sat' THEN 5
                        WHEN 'Sun' THEN 6 ELSE 7 END ASC,
                     c."startTime" ASC`
        );
        return rows.map((r: any) => ({
            id: r.id,
            programId: r.programId ?? r.programid,
            instructorId: r.instructorId ?? r.instructorid ?? null,
            name: r.name,
            dayOfWeek: r.dayOfWeek ?? r.dayofweek,
            startTime: r.startTime ?? r.starttime ?? "",
            endTime: r.endTime ?? r.endtime ?? "",
            scheduleStartTime: r.scheduleStartTime ?? r.schedulestarttime ?? null,
            scheduleEndTime: r.scheduleEndTime ?? r.scheduleendtime ?? null,
            scheduleActiveFrom: r.scheduleActiveFrom ?? r.scheduleactivefrom ?? null,
            scheduleActiveTo: r.scheduleActiveTo ?? r.scheduleactiveto ?? null,
            startTimeOverride: r.startTimeOverride ?? r.starttimeoverride ?? null,
            endTimeOverride: r.endTimeOverride ?? r.endtimeoverride ?? null,
            customStartTime: r.customStartTime ?? r.customstarttime ?? null,
            customEndTime: r.customEndTime ?? r.customendtime ?? null,
            location: r.location ?? null,
            capacity: Number(r.capacity ?? 0),
            slotKey: r.slotKey ?? r.slotkey ?? null,
            coachId: r.coach_id ?? r.coachId ?? r.coachid ?? null,
            coachName: r.coach_name ?? r.coachName ?? r.coachname ?? null,
            instructorName: r.instructor_name ?? r.instructorName ?? r.instructorname ?? null,
            createdAt: r.createdAt ?? r.createdat,
            updatedAt: r.updatedAt ?? r.updatedat,
            program: r.p_id ? { id: r.p_id, name: r.p_name } : null,
        }));
    } catch (e) {
        console.error("[getClasses] failed:", e);
        return [];
    }
});

/** 원생 목록 조회 (학부모 정보 포함) */
const ATTENDANCE_DAY_KEYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

type AttendanceClassKind = "REGULAR" | "SEASONAL";

export type AttendanceClassOption = {
    id: string;
    lessonKey: string;
    kind: AttendanceClassKind;
    name: string;
    dayOfWeek: string;
    startTime: string;
    endTime: string;
    location: string | null;
    program: { id: string; name: string } | null;
    sessionDateId: string | null;
    sessionId: string | null;
    sessionStatus: string | null;
    studentCount: number;
    coachName: string | null;
};

function normalizedAttendanceDateKey(date?: string | null) {
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Seoul",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(new Date());
}

function attendanceDayOfWeek(date: string) {
    // 달력 숫자 그대로 요일을 구한다(서버 시간대 무관). 예전 T12:00+getDay() 는 우연히 맞던 방식이라 kst 모듈로 옮김.
    return ATTENDANCE_DAY_KEYS[kstDow(date)];
}

type SeasonalAttendanceClassRow = {
    id: string;
    name: string;
    startTime: string;
    endTime: string;
    location: string | null;
    sessionDateId: string;
    sessionId: string | null;
    sessionStatus: string | null;
    studentCount: number | string | null;
    coachName: string | null;
};

export const getAttendanceClassOptions = cache(async (date?: string | null): Promise<AttendanceClassOption[]> => {
    const dateKey = normalizedAttendanceDateKey(date);
    const dayOfWeek = attendanceDayOfWeek(dateKey);
    const [classes, seasonalRows] = await Promise.all([
        getClasses(),
        prisma.$queryRawUnsafe<SeasonalAttendanceClassRow[]>(
            `WITH occurrence AS (
               SELECT c.id,
                      c.name,
                      sd."startsAt",
                      sd."endsAt",
                      COALESCE(MIN(sd.location), MIN(o.location), c.location) AS location,
                      (ARRAY_AGG(sd.id ORDER BY CASE WHEN existing_s.id IS NULL THEN 1 ELSE 0 END, sd.id))[1] AS "sessionDateId",
                      COUNT(DISTINCT app."convertedStudentId") FILTER (WHERE app."convertedStudentId" IS NOT NULL)::int AS "studentCount"
                 FROM "SpecialProgramSessionDate" sd
                 JOIN "SpecialProgramOffering" o ON o.id = sd."offeringId"
                 JOIN "SpecialProgramSeason" season ON season.id = o."seasonId"
                 JOIN "Class" c ON c.id = o."linkedClassId"
                 LEFT JOIN "Session" existing_s ON existing_s."specialProgramSessionDateId" = sd.id
                 LEFT JOIN "SpecialProgramApplicationItem" item
                   ON item."offeringId" = o.id
                  AND item.status = 'APPROVED'
                  AND item."conversionStatus" IN ('COMPLETED', 'INVOICE_RETRY_REQUIRED')
                 LEFT JOIN "SpecialProgramApplication" app
                   ON app.id = item."applicationId"
                  AND app."convertedStudentId" IS NOT NULL
                  AND (
                    COALESCE(cardinality(app."selectedWeekdays"), 0) = 0
                    OR CASE EXTRACT(ISODOW FROM sd."startsAt" AT TIME ZONE 'Asia/Seoul')::int
                      WHEN 1 THEN 'MON' WHEN 2 THEN 'TUE' WHEN 3 THEN 'WED' WHEN 4 THEN 'THU'
                      WHEN 5 THEN 'FRI' WHEN 6 THEN 'SAT' ELSE 'SUN'
                    END = ANY(app."selectedWeekdays")
                  )
                WHERE (sd."startsAt" AT TIME ZONE 'Asia/Seoul')::date = $1::date
                  AND o."linkedClassId" IS NOT NULL
                  AND o.status <> 'CANCELLED'
                  AND season.status <> 'ARCHIVED'
                GROUP BY c.id, c.name, c.location, sd."startsAt", sd."endsAt"
             )
             SELECT occurrence.id,
                    occurrence.name,
                    to_char(occurrence."startsAt" AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS "startTime",
                    to_char(occurrence."endsAt" AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS "endTime",
                    occurrence.location,
                    occurrence."sessionDateId",
                    s.id AS "sessionId",
                    s.status AS "sessionStatus",
                    occurrence."studentCount",
                    coach.name AS "coachName"
               FROM occurrence
               LEFT JOIN "Session" s ON s."specialProgramSessionDateId" = occurrence."sessionDateId"
               LEFT JOIN "Coach" coach ON coach.id = s."coachId"
              ORDER BY occurrence."startsAt", occurrence.name`,
            dateKey,
        ),
    ]);

    const regularOptions = classes
        .filter((klass: any) => klass.dayOfWeek === dayOfWeek)
        .map((klass: any) => ({
            id: klass.id,
            lessonKey: `regular:${klass.id}`,
            kind: "REGULAR" as const,
            name: klass.name,
            dayOfWeek: klass.dayOfWeek,
            startTime: klass.startTime,
            endTime: klass.endTime,
            location: klass.location ?? null,
            program: klass.program,
            sessionDateId: null,
            sessionId: null,
            sessionStatus: null,
            studentCount: 0,
            coachName: klass.coachName ?? klass.instructorName ?? null,
        }));

    const seasonalOptions = seasonalRows.map((row) => ({
        id: row.id,
        lessonKey: `seasonal:${row.sessionDateId}`,
        kind: "SEASONAL" as const,
        name: row.name,
        dayOfWeek,
        startTime: row.startTime,
        endTime: row.endTime,
        location: row.location ?? null,
        program: { id: "seasonal", name: "방학특강" },
        sessionDateId: row.sessionDateId,
        sessionId: row.sessionId,
        sessionStatus: row.sessionStatus,
        studentCount: Number(row.studentCount ?? 0),
        coachName: row.coachName,
    }));

    return [...regularOptions, ...seasonalOptions].sort((left, right) =>
        left.startTime.localeCompare(right.startTime) || left.name.localeCompare(right.name),
    );
});

export const getStudents = cache(async (limit?: number) => {
    try {
        const normalizedLimit =
            typeof limit === "number" && Number.isFinite(limit) && limit > 0
                ? Math.min(Math.floor(limit), 500)
                : null;
        // 학생 목록 조회: 서브쿼리로 수강(Enrollment+Class) 정보를 JSON 배열로 포함
        const rows = await prisma.$queryRawUnsafe<any[]>(
            `WITH selected_students AS (
                SELECT s.id, s.name, s."birthDate", s.gender, s."parentId",
                       s.phone, s.school, s.grade, s.address, s."enrollDate",
                       s."createdAt", s."updatedAt"
                FROM "Student" s
                WHERE ${notMergedStudent("s")}
                ORDER BY s.name ASC${normalizedLimit ? ` LIMIT ${normalizedLimit}` : ""}
             ),
             enrollment_json AS (
                SELECT
                    e."studentId",
                    json_agg(
                        json_build_object(
                            'classId', e."classId",
                            'className', c.name,
                            'status', e.status,
                            'dayOfWeek', c."dayOfWeek",
                            'startTime', c."startTime",
                            'slotKey', c."slotKey",
                            'createdAt', e."createdAt"
                        )
                        ORDER BY e."createdAt" DESC
                    ) AS enrollments
                FROM "Enrollment" e
                JOIN selected_students ss ON ss.id = e."studentId"
                JOIN "Class" c ON e."classId" = c.id
                GROUP BY e."studentId"
             ),
             latest_batch AS (
                SELECT id
                FROM "StudentSheetImportBatch"
                WHERE status = 'COMPLETED'
                ORDER BY "createdAt" DESC
                LIMIT 1
             ),
             selected_month AS (
                SELECT parsed."monthNumber"
                FROM (
                    SELECT (
                        string_to_array(
                            trim(both ',' from regexp_replace(COALESCE(r."registrationMonth", ''), '[^0-9]+', ',', 'g')),
                            ','
                        )
                    )[2]::int AS "monthNumber"
                    FROM "StudentRegistrationLedger" r
                    JOIN latest_batch lb ON lb.id = r."batchId"
                    WHERE r."studentId" IS NOT NULL
                ) parsed
                WHERE parsed."monthNumber" IS NOT NULL
                GROUP BY parsed."monthNumber"
                ORDER BY parsed."monthNumber" DESC
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
                JOIN selected_students ss ON ss.id = r."studentId"
                JOIN latest_batch lb ON lb.id = r."batchId"
                WHERE r."studentId" IS NOT NULL
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
             )
             SELECT s.id, s.name, s."birthDate", s.gender, s."parentId",
                    s.phone, s.school, s.grade, s.address, s."enrollDate",
                    s."createdAt", s."updatedAt",
                    u.name AS parent_name, u.phone AS parent_phone, u.email AS parent_email,
                    COALESCE(ej.enrollments, '[]'::json) AS enrollments,
                    css.status AS current_status
             FROM selected_students s
             LEFT JOIN "User" u ON s."parentId" = u.id
             LEFT JOIN enrollment_json ej ON ej."studentId" = s.id
             LEFT JOIN current_student_status css ON css."studentId" = s.id
             ORDER BY s.name ASC`
        );
        return rows.map((r: any) => ({
            id: r.id,
            name: r.name,
            birthDate: r.birthDate ?? r.birthdate,
            gender: r.gender ?? null,
            parentId: r.parentId ?? r.parentid,
            phone: r.phone ?? null,
            school: r.school ?? null,
            grade: r.grade ?? null,
            address: r.address ?? null,
            enrollDate: r.enrollDate ?? r.enrolldate ?? null,
            createdAt: r.createdAt ?? r.createdat,
            updatedAt: r.updatedAt ?? r.updatedat,
            parent: {
                name: r.parent_name ?? null,
                phone: r.parent_phone ?? null,
                email: r.parent_email ?? null,
            },
            currentStatus: r.current_status ?? null,
            // 수강 정보 배열 (없으면 빈 배열)
            enrollments: r.enrollments ?? [],
        }));
    } catch (e) {
        console.error("[getStudents] failed:", e);
        return [];
    }
});

/** 원생 상세 조회 (수강 내역 포함) */
export const getStudentWithEnrollments = cache(async (id: string) => {
    try {
        // 원생 기본 정보: 새 필드(phone, school, grade, address, enrollDate) 포함
        const sRows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT s.id, s.name, s."birthDate", s.gender, s."parentId",
                    s.phone, s.school, s.grade, s.address, s."enrollDate",
                    s."createdAt", s."updatedAt",
                    u.name AS parent_name, u.phone AS parent_phone, u.email AS parent_email
             FROM "Student" s
             LEFT JOIN "User" u ON s."parentId" = u.id
             WHERE s.id = $1`,
            id
        );
        if (!sRows[0]) return null;
        const r = sRows[0];
        // 수강 내역
        const eRows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT e.id, e."classId", e.status, e."createdAt",
                    c.name AS class_name, c."dayOfWeek", c."startTime", c."endTime",
                    p.name AS program_name
             FROM "Enrollment" e
             LEFT JOIN "Class" c ON e."classId" = c.id
             LEFT JOIN "Program" p ON c."programId" = p.id
             WHERE e."studentId" = $1
             ORDER BY e."createdAt" DESC`,
            id
        );
        return {
            id: r.id,
            name: r.name,
            birthDate: r.birthDate ?? r.birthdate,
            gender: r.gender ?? null,
            parentId: r.parentId ?? r.parentid,
            phone: r.phone ?? null,
            school: r.school ?? null,
            grade: r.grade ?? null,
            address: r.address ?? null,
            enrollDate: r.enrollDate ?? r.enrolldate ?? null,
            createdAt: r.createdAt ?? r.createdat,
            updatedAt: r.updatedAt ?? r.updatedat,
            parent: {
                name: r.parent_name ?? null,
                phone: r.parent_phone ?? null,
                email: r.parent_email ?? null,
            },
            enrollments: eRows.map((e: any) => ({
                id: e.id,
                classId: e.classId ?? e.classid,
                status: e.status,
                createdAt: e.createdAt ?? e.createdat,
                className: e.class_name,
                dayOfWeek: e.dayOfWeek ?? e.dayofweek,
                startTime: e.startTime ?? e.starttime,
                endTime: e.endTime ?? e.endtime,
                programName: e.program_name,
            })),
        };
    } catch (e) {
        console.error("[getStudentWithEnrollments] failed:", e);
        return null;
    }
});

export const getClassSlotOverrides = cache(async () => {
    try {
        const rows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT
                cso.id, cso."slotKey", cso.label, cso.note, cso."isHidden", cso.capacity,
                cso."startTimeOverride", cso."endTimeOverride",
                cso."coachId", cso."programId", cso."createdAt", cso."updatedAt",
                c.id AS c_id, c.name AS c_name, c.role AS c_role,
                c."imageUrl" AS c_imageurl, c.description AS c_desc, c."order" AS c_order
             FROM "ClassSlotOverride" cso
             LEFT JOIN "Coach" c ON cso."coachId" = c.id
             ORDER BY cso."slotKey" ASC`
        );
        return rows.map((r: any) => ({
            id: r.id,
            slotKey: r.slotKey ?? r.slotkey,
            label: r.label ?? null,
            note: r.note ?? null,
            isHidden: r.isHidden ?? r.ishidden ?? false,
            capacity: Number(r.capacity ?? 12),
            coachId: r.coachId ?? r.coachid ?? null,
            startTimeOverride: r.startTimeOverride ?? r.starttimeoverride ?? null,
            endTimeOverride: r.endTimeOverride ?? r.endtimeoverride ?? null,
            programId: r.programId ?? r.programid ?? null,
            createdAt: r.createdAt ?? r.createdat,
            updatedAt: r.updatedAt ?? r.updatedat,
            coach: r.c_id ? {
                id: r.c_id, name: r.c_name, role: r.c_role,
                imageUrl: r.c_imageurl ?? null, description: r.c_desc ?? null,
                order: Number(r.c_order ?? 0),
                createdAt: new Date(), updatedAt: new Date(), slots: [], customSlots: [],
            } : null,
        }));
    } catch (e) {
        console.error("[getClassSlotOverrides] failed:", e);
        return [];
    }
});

export const getCoaches = cache(async () => {
    try {
        const rows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT id, name, role, description, "imageUrl", phone, "order", "createdAt", "updatedAt"
             FROM "Coach" ORDER BY "order" ASC`
        );
        return rows.map((r: any) => ({ ...r, order: Number(r.order ?? 0) }));
    } catch (e) {
        console.error("[getCoaches] failed:", e);
        return [];
    }
});

export const getCustomClassSlots = cache(async () => {
    try {
        const rows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT
                cs.id, cs."dayKey", cs."startTime", cs."endTime", cs.label,
                cs."gradeRange", cs.enrolled, cs.capacity, cs.note, cs."isHidden",
                cs."coachId", cs."programId", cs."createdAt", cs."updatedAt",
                c.id AS c_id, c.name AS c_name, c.role AS c_role,
                c."imageUrl" AS c_imageurl, c.description AS c_desc, c."order" AS c_order
             FROM "CustomClassSlot" cs
             LEFT JOIN "Coach" c ON cs."coachId" = c.id
             ORDER BY cs."dayKey" ASC, cs."startTime" ASC`
        );
        return rows.map((r: any) => ({
            id: r.id,
            dayKey: r.dayKey ?? r.daykey,
            startTime: r.startTime ?? r.starttime,
            endTime: r.endTime ?? r.endtime,
            label: r.label ?? "",
            gradeRange: r.gradeRange ?? r.graderange ?? null,
            enrolled: Number(r.enrolled ?? 0),
            capacity: Number(r.capacity ?? 12),
            note: r.note ?? null,
            isHidden: r.isHidden ?? r.ishidden ?? false,
            coachId: r.coachId ?? r.coachid ?? null,
            programId: r.programId ?? r.programid ?? null,
            createdAt: r.createdAt ?? r.createdat,
            updatedAt: r.updatedAt ?? r.updatedat,
            coach: r.c_id ? {
                id: r.c_id, name: r.c_name, role: r.c_role,
                imageUrl: r.c_imageurl ?? null, description: r.c_desc ?? null,
                order: Number(r.c_order ?? 0),
                createdAt: new Date(), updatedAt: new Date(), slots: [], customSlots: [],
            } : null,
            program: null,
        }));
    } catch (e) {
        console.error("[getCustomClassSlots] failed:", e);
        return [];
    }
});

/** 연간일정 DB 조회 */
export const getAnnualEvents = cache(async () => {
    try {
        const rows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT id, title, date, "endDate", description, category, "createdAt", "updatedAt"
             FROM "AnnualEvent" ORDER BY date ASC`
        );
        return rows.map((r: any) => ({
            id: r.id,
            title: r.title,
            date: r.date,
            endDate: r.endDate ?? r.enddate ?? null,
            description: r.description ?? null,
            category: r.category ?? "일반",
            createdAt: r.createdAt ?? r.createdat,
            updatedAt: r.updatedAt ?? r.updatedat,
        }));
    } catch (e) {
        console.error("[getAnnualEvents] failed:", e);
        return [];
    }
});

/** 대시보드 통계 쿼리 */
export const getDashboardStats = cache(async () => {
    const zero = { studentCount: 0, programCount: 0, coachCount: 0, classCount: 0 };
    try {
        const rows = await prisma.$queryRawUnsafe<any[]>(`
            SELECT
                (SELECT COUNT(*)::int FROM "Student" s WHERE ${notMergedStudent("s")}) AS "studentCount",
                (SELECT COUNT(*)::int FROM "Program") AS "programCount",
                (SELECT COUNT(*)::int FROM "Coach") AS "coachCount",
                (SELECT COUNT(*)::int FROM "Class") AS "classCount"
        `);
        if (!rows[0]) return zero;
        return {
            studentCount: Number(rows[0].studentCount ?? 0),
            programCount: Number(rows[0].programCount ?? 0),
            coachCount: Number(rows[0].coachCount ?? 0),
            classCount: Number(rows[0].classCount ?? 0),
        };
    } catch (e) {
        console.error("[getDashboardStats] failed:", e);
        return zero;
    }
});

/** 출결: 특정 날짜+반의 세션 및 출석 데이터 조회 */
export const getAttendanceByDateAndClass = cache(async (date: string, classId: string, sessionDateId?: string | null) => {
    try {
        // 세션 조회
        if (sessionDateId) {
            const sessionDates = await prisma.$queryRawUnsafe<any[]>(
                `SELECT sd.id, sd."startsAt", sd."endsAt", o."linkedClassId"
                   FROM "SpecialProgramSessionDate" sd
                   JOIN "SpecialProgramOffering" o ON o.id = sd."offeringId"
                  WHERE sd.id = $1
                    AND o."linkedClassId" = $2
                    AND (sd."startsAt" AT TIME ZONE 'Asia/Seoul')::date = $3::date
                  LIMIT 1`,
                sessionDateId, classId, date,
            );
            if (!sessionDates[0]) return { session: null, students: [] };

            const sessions = await prisma.$queryRawUnsafe<any[]>(
                `SELECT s.id, s."classId", s.date, s.notes, s.status
                   FROM "Session" s
                  WHERE s."specialProgramSessionDateId" = $1
                  LIMIT 1`,
                sessionDateId,
            );
            const session = sessions[0] ?? null;

            const roster = await prisma.$queryRawUnsafe<any[]>(
                `SELECT DISTINCT st.id AS "studentId", st.name AS student_name
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
                   JOIN "Student" st ON st.id = app."convertedStudentId"
                        AND ${notMergedStudent("st")}
                  WHERE anchor_sd.id = $1
                  ORDER BY st.name`,
                sessionDateId,
            );

            const attendances = session
                ? await prisma.$queryRawUnsafe<any[]>(
                    `SELECT id, "studentId", status FROM "Attendance" WHERE "sessionId" = $1`,
                    session.id,
                )
                : [];

            return {
                session,
                students: roster.map((student: any) => {
                    const studentId = student.studentId ?? student.studentid;
                    const attendance = attendances.find((item: any) => (item.studentId ?? item.studentid) === studentId);
                    return {
                        studentId,
                        studentName: student.student_name,
                        status: attendance?.status ?? null,
                        attendanceId: attendance?.id ?? null,
                    };
                }),
            };
        }

        const sessions = await prisma.$queryRawUnsafe<any[]>(
            `SELECT id, "classId", date, notes FROM "Session"
             WHERE "classId" = $1 AND date::date = $2::date AND "specialProgramSessionDateId" IS NULL LIMIT 1`,
            classId, date
        );
        const session = sessions[0] ?? null;

        // 해당 반 수강생 목록
        const enrolled = await prisma.$queryRawUnsafe<any[]>(
            `SELECT e."studentId", s.name AS student_name
             FROM "Enrollment" e
             JOIN "Student" s ON e."studentId" = s.id AND ${notMergedStudent("s")}
             WHERE e."classId" = $1 AND e.status = 'ACTIVE'
             ORDER BY s.name ASC`,
            classId
        );

        // 세션이 있으면 출석 기록 조회
        let attendances: any[] = [];
        if (session) {
            attendances = await prisma.$queryRawUnsafe<any[]>(
                `SELECT id, "studentId", status FROM "Attendance" WHERE "sessionId" = $1`,
                session.id
            );
        }

        return {
            session,
            students: enrolled.map((e: any) => ({
                studentId: e.studentId ?? e.studentid,
                studentName: e.student_name,
                status: attendances.find(
                    (a: any) => (a.studentId ?? a.studentid) === (e.studentId ?? e.studentid)
                )?.status ?? null,
                attendanceId: attendances.find(
                    (a: any) => (a.studentId ?? a.studentid) === (e.studentId ?? e.studentid)
                )?.id ?? null,
            })),
        };
    } catch (e) {
        console.error("[getAttendanceByDateAndClass] failed:", e);
        return { session: null, students: [] };
    }
});

/** 수납: 월별 수납 내역 조회 */
function getMonthDateRange(year: number, month: number) {
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 1);
    const startStr = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, "0")}-01`;
    const endStr = `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, "0")}-01`;

    return { startStr, endStr };
}

export const getPayments = cache(async (year?: number, month?: number) => {
    try {
        await ensurePaymentInfrastructure();
        let where = "";
        const params: any[] = [];
        if (year && month) {
            const { startStr, endStr } = getMonthDateRange(year, month);
            where = `WHERE p."dueDate" >= $1::timestamp AND p."dueDate" < $2::timestamp`;
            params.push(startStr, endStr);
        }
        // 새 필드(type, description, month, year, autoGenerated, notifiedAt) 포함
        const rows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT p.id, p."studentId", p.amount, p.status, p."dueDate", p."paidDate",
                    p.type, p.method, p.description, p.month, p.year, p."autoGenerated", p."notifiedAt",
                    p."invoiceNo", p."issuedAt", p."payableUntil", p."paidProvider",
                    p."providerOrderId", p."receiptUrl", p."lastReminderAt", p."reminderCount",
                    p."createdAt", p."classId", c.name AS class_name, s.name AS student_name,
                    i.id AS invoice_id, i.status AS invoice_status, i."sentAt" AS invoice_sent_at,
                    i."checkoutUrl" AS invoice_checkout_url,
                    tx.status AS transaction_status, tx.provider AS transaction_provider
             FROM "Payment" p
             JOIN "Student" s ON p."studentId" = s.id
             LEFT JOIN "Class" c ON p."classId" = c.id
             LEFT JOIN "PaymentInvoice" i ON i."paymentId" = p.id
             LEFT JOIN LATERAL (
                SELECT status, provider
                FROM "PaymentTransaction"
                WHERE "paymentId" = p.id
                ORDER BY "createdAt" DESC
                LIMIT 1
             ) tx ON true
             ${where}
             ORDER BY p."dueDate" DESC`,
            ...params
        );
        return rows.map((r: any) => ({
            id: r.id,
            studentId: r.studentId ?? r.studentid,
            studentName: r.student_name,
            classId: r.classId ?? r.classid ?? null,
            className: r.class_name ?? null,
            amount: Number(r.amount),
            status: r.status,
            dueDate: r.dueDate ?? r.duedate,
            paidDate: r.paidDate ?? r.paiddate ?? null,
            type: r.type ?? "MONTHLY",
            method: r.method ?? null,
            description: r.description ?? null,
            month: r.month != null ? Number(r.month) : null,
            year: r.year != null ? Number(r.year) : null,
            autoGenerated: r.autoGenerated ?? r.autogenerated ?? false,
            notifiedAt: r.notifiedAt ?? r.notifiedat ?? null,
            invoiceId: r.invoice_id ?? null,
            invoiceNo: r.invoiceNo ?? r.invoiceno ?? null,
            invoiceStatus: r.invoice_status ?? null,
            invoiceSentAt: r.invoice_sent_at ?? null,
            invoiceCheckoutUrl: r.invoice_checkout_url ?? null,
            issuedAt: r.issuedAt ?? r.issuedat ?? null,
            payableUntil: r.payableUntil ?? r.payableuntil ?? null,
            paidProvider: r.paidProvider ?? r.paidprovider ?? r.transaction_provider ?? null,
            providerOrderId: r.providerOrderId ?? r.providerorderid ?? null,
            receiptUrl: r.receiptUrl ?? r.receipturl ?? null,
            lastReminderAt: r.lastReminderAt ?? r.lastreminderat ?? null,
            reminderCount: Number(r.reminderCount ?? r.remindercount ?? 0),
            transactionStatus: r.transaction_status ?? null,
            createdAt: r.createdAt ?? r.createdat,
        }));
    } catch (e) {
        console.error("[getPayments] failed:", e);
        return [];
    }
});

// ── 청구 템플릿 조회 ────────────────────────────────────────────────────────────
export const getBillingTemplates = cache(async () => {
    try {
        const rows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT id, name, amount, type, description, "isActive", "dueDay", "programId",
                    "createdAt", "updatedAt"
             FROM "BillingTemplate"
             ORDER BY "createdAt" DESC`
        );
        return rows.map((r: any) => ({
            id: r.id,
            name: r.name,
            amount: Number(r.amount),
            type: r.type ?? "MONTHLY",
            description: r.description ?? null,
            isActive: r.isActive ?? r.isactive ?? true,
            dueDay: Number(r.dueDay ?? r.dueday ?? 10),
            programId: r.programId ?? r.programid ?? null,
            createdAt: r.createdAt ?? r.createdat,
            updatedAt: r.updatedAt ?? r.updatedat,
        }));
    } catch (e) {
        console.error("[getBillingTemplates] failed:", e);
        return [];
    }
});

// 활성 청구 템플릿만 조회 (자동 청구서 생성용)
export const getActiveBillingTemplates = cache(async () => {
    try {
        const rows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT id, name, amount, type, description, "dueDay", "programId"
             FROM "BillingTemplate"
             WHERE "isActive" = true
             ORDER BY "createdAt" DESC`
        );
        return rows.map((r: any) => ({
            id: r.id,
            name: r.name,
            amount: Number(r.amount),
            type: r.type ?? "MONTHLY",
            description: r.description ?? null,
            dueDay: Number(r.dueDay ?? r.dueday ?? 10),
            programId: r.programId ?? r.programid ?? null,
        }));
    } catch (e) {
        console.error("[getActiveBillingTemplates] failed:", e);
        return [];
    }
});

// 특정 월의 수납 요약 (총 청구/수납/미납 금액 + 건수)
export const getPaymentSummary = cache(async (year: number, month: number) => {
    try {
        const { startStr, endStr } = getMonthDateRange(year, month);
        const rows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT
                COUNT(*)::int AS total_count,
                COALESCE(SUM(amount), 0)::int AS total_amount,
                COALESCE(SUM(CASE WHEN status = 'PAID' THEN amount ELSE 0 END), 0)::int AS paid_amount,
                COALESCE(SUM(CASE WHEN status IN ('PENDING','OVERDUE') THEN amount ELSE 0 END), 0)::int AS unpaid_amount,
                COUNT(CASE WHEN status = 'PAID' THEN 1 END)::int AS paid_count,
                COUNT(CASE WHEN status IN ('PENDING','OVERDUE') THEN 1 END)::int AS unpaid_count
             FROM "Payment"
             WHERE "dueDate" >= $1::timestamp AND "dueDate" < $2::timestamp`,
            startStr, endStr
        );
        const r = rows[0] || {};
        return {
            totalCount: Number(r.total_count ?? 0),
            totalAmount: Number(r.total_amount ?? 0),
            paidAmount: Number(r.paid_amount ?? 0),
            unpaidAmount: Number(r.unpaid_amount ?? 0),
            paidCount: Number(r.paid_count ?? 0),
            unpaidCount: Number(r.unpaid_count ?? 0),
        };
    } catch (e) {
        console.error("[getPaymentSummary] failed:", e);
        return { totalCount: 0, totalAmount: 0, paidAmount: 0, unpaidAmount: 0, paidCount: 0, unpaidCount: 0 };
    }
});

// 미납 결제 목록 (PENDING + OVERDUE, 알림 발송용)
export const getUnpaidPayments = cache(async () => {
    try {
        await ensurePaymentInfrastructure();
        const rows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT p.id, p."studentId", p.amount, p.status, p."dueDate", p."notifiedAt",
                    p.type, p.description, p."lastReminderAt", p."reminderCount",
                    i.id AS invoice_id, i."invoiceNo", i.status AS invoice_status,
                    s.name AS student_name
             FROM "Payment" p
             JOIN "Student" s ON p."studentId" = s.id
             LEFT JOIN "PaymentInvoice" i ON i."paymentId" = p.id
             WHERE p.status IN ('PENDING', 'OVERDUE')
             ORDER BY p."dueDate" ASC`
        );
        return rows.map((r: any) => ({
            id: r.id,
            studentId: r.studentId ?? r.studentid,
            studentName: r.student_name,
            amount: Number(r.amount),
            status: r.status,
            dueDate: r.dueDate ?? r.duedate,
            notifiedAt: r.notifiedAt ?? r.notifiedat ?? null,
            type: r.type ?? "MONTHLY",
            description: r.description ?? null,
            invoiceId: r.invoice_id ?? null,
            invoiceNo: r.invoiceNo ?? r.invoiceno ?? null,
            invoiceStatus: r.invoice_status ?? null,
            lastReminderAt: r.lastReminderAt ?? r.lastreminderat ?? null,
            reminderCount: Number(r.reminderCount ?? r.remindercount ?? 0),
        }));
    } catch (e) {
        console.error("[getUnpaidPayments] failed:", e);
        return [];
    }
});

/** 마이페이지: 학부모(User)의 자녀 목록 + 수강/출결/수납 요약
 *  ⚠️ 반드시 인증 게이트(requireVerifiedParent)가 검증한 부모 User.id(appUserId)를 넘길 것.
 *  이전에는 이메일로 부모를 찾았는데, 소셜 로그인 이메일 ≠ 학원 등록 이메일이면
 *  부모를 못 찾아 "자녀 없음"으로 표시되는 버그가 있었다. → id 기준으로 통일. */
export async function getMyPageData(parentUserId: string) {
    try {
        await ensurePaymentInfrastructure();
        // 학부모 User 조회 (게이트가 검증한 부모 User.id로 직접 조회 — 이메일 매칭 제거)
        const users = await prisma.$queryRawUnsafe<any[]>(
            `SELECT id, name, email, phone FROM "User" WHERE id = $1 LIMIT 1`,
            parentUserId
        );
        if (!users[0]) return null;
        const parent = users[0];

        // 자녀 목록
        const students = await prisma.$queryRawUnsafe<any[]>(
            `SELECT id, name, "birthDate", gender FROM "Student" s
             WHERE s."parentId" = $1 AND ${notMergedStudent("s")}
             ORDER BY s."createdAt" ASC`,
            parent.id
        );

        // 각 자녀별 수강/출결/수납 정보
        const children = await Promise.all(
            students.map(async (s: any) => {
                const studentId = s.id;

                // 수강 중인 반
                const enrollments = await prisma.$queryRawUnsafe<any[]>(
                    `SELECT e.id, e."classId", e.status, c.name AS class_name, c."dayOfWeek", c."startTime", c."endTime",
                            p.name AS program_name
                     FROM "Enrollment" e
                     JOIN "Class" c ON e."classId" = c.id
                     LEFT JOIN "Program" p ON c."programId" = p.id
                     WHERE e."studentId" = $1 AND e.status = 'ACTIVE'`,
                    studentId
                );

                // 이번 달 출결
                const now = new Date();
                const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
                const attendances = await prisma.$queryRawUnsafe<any[]>(
                    `SELECT a.status, se.date
                     FROM "Attendance" a
                     JOIN "Session" se ON a."sessionId" = se.id
                     WHERE a."studentId" = $1 AND se.date >= $2::timestamp
                     ORDER BY se.date DESC`,
                    studentId, monthStart
                );

                // 최근 수납
                const payments = await prisma.$queryRawUnsafe<any[]>(
                    `SELECT p.id, p.amount, p.status, p."dueDate", p."paidDate",
                            p.type, p.description, p.method, p."receiptUrl",
                            i.id AS invoice_id, i."invoiceNo", i.status AS invoice_status,
                            i."checkoutUrl" AS invoice_checkout_url
                     FROM "Payment" p
                     LEFT JOIN "PaymentInvoice" i ON i."paymentId" = p.id
                     WHERE p."studentId" = $1
                     ORDER BY p."dueDate" DESC LIMIT 5`,
                    studentId
                );

                return {
                    id: studentId,
                    name: s.name,
                    birthDate: s.birthDate ?? s.birthdate,
                    gender: s.gender,
                    enrollments: enrollments.map((e: any) => ({
                        id: e.id,
                        classId: e.classId ?? e.classid,
                        status: e.status,
                        className: e.class_name,
                        dayOfWeek: e.dayOfWeek ?? e.dayofweek,
                        startTime: e.startTime ?? e.starttime,
                        endTime: e.endTime ?? e.endtime,
                        programName: e.program_name,
                    })),
                    attendance: {
                        total: attendances.length,
                        present: attendances.filter((a: any) => a.status === "PRESENT").length,
                        absent: attendances.filter((a: any) => a.status === "ABSENT").length,
                        late: attendances.filter((a: any) => a.status === "LATE").length,
                        records: attendances.map((a: any) => ({
                            status: a.status,
                            date: a.date,
                        })),
                    },
                    payments: payments.map((p: any) => ({
                        id: p.id,
                        amount: Number(p.amount),
                        status: p.status,
                        dueDate: p.dueDate ?? p.duedate,
                        paidDate: p.paidDate ?? p.paiddate ?? null,
                        type: p.type ?? "MONTHLY",
                        description: p.description ?? null,
                        method: p.method ?? null,
                        receiptUrl: p.receiptUrl ?? p.receipturl ?? null,
                        invoiceId: p.invoice_id ?? null,
                        invoiceNo: p.invoiceNo ?? p.invoiceno ?? null,
                        invoiceStatus: p.invoice_status ?? null,
                        invoiceCheckoutUrl: p.invoice_checkout_url ?? null,
                    })),
                };
            })
        );

        return {
            parent: {
                id: parent.id,
                name: parent.name,
                email: parent.email,
                phone: parent.phone,
            },
            children,
        };
    } catch (e) {
        console.error("[getMyPageData] failed:", e);
        return null;
    }
}

/** 마이페이지 히스토리: 학부모(User)의 자녀별 "출결 전체 + 수납 전체" 조회 (표시/조회 전용)
 *  - getMyPageData가 "이번 달 출결 / 최근 5건 수납"만 보여주는 것과 달리,
 *    지난 기록까지 전부 추적할 수 있도록 월 필터·LIMIT 없이 최신순 전체를 반환한다.
 *  - ⚠️ 반드시 인증 게이트(requireVerifiedParent)가 검증한 부모 User.id(appUserId)를 넘길 것.
 *    자녀는 Student.parentId = 부모.id 로만 조회 → 남의 자녀 조회 불가(IDOR 안전).
 *  - 쓰기 없음(읽기 전용). $queryRawUnsafe 사용(PgBouncer 트랜잭션 모드 대응). */
export async function getMyPageHistory(parentUserId: string) {
    try {
        await ensurePaymentInfrastructure();
        // 부모 User 조회 (게이트가 검증한 id로 직접 조회 — 이메일 매칭 없음)
        const users = await prisma.$queryRawUnsafe<any[]>(
            `SELECT id, name FROM "User" WHERE id = $1 LIMIT 1`,
            parentUserId
        );
        if (!users[0]) return null;
        const parent = users[0];

        // 자녀 목록 (부모 소유 자녀만)
        const students = await prisma.$queryRawUnsafe<any[]>(
            `SELECT id, name, "birthDate", gender FROM "Student" s
             WHERE s."parentId" = $1 AND ${notMergedStudent("s")}
             ORDER BY s."createdAt" ASC`,
            parent.id
        );

        const children = await Promise.all(
            students.map(async (s: any) => {
                const studentId = s.id;

                // 출결 전체 (월 필터 제거 · 반 이름 포함 · 최신순)
                const attendances = await prisma.$queryRawUnsafe<any[]>(
                    `SELECT a.status, se.date, c.name AS class_name
                     FROM "Attendance" a
                     JOIN "Session" se ON a."sessionId" = se.id
                     LEFT JOIN "Class" c ON se."classId" = c.id
                     WHERE a."studentId" = $1
                     ORDER BY se.date DESC`,
                    studentId
                );

                // 수납 전체 (LIMIT 제거 · 최신순)
                const payments = await prisma.$queryRawUnsafe<any[]>(
                    `SELECT p.id, p.amount, p.status, p."dueDate", p."paidDate",
                            p.type, p.description, p.method, p."receiptUrl",
                            i.id AS invoice_id, i."invoiceNo", i.status AS invoice_status,
                            i."checkoutUrl" AS invoice_checkout_url
                     FROM "Payment" p
                     LEFT JOIN "PaymentInvoice" i ON i."paymentId" = p.id
                     WHERE p."studentId" = $1
                     ORDER BY p."dueDate" DESC`,
                    studentId
                );

                // 누적 출석률 요약 (표시용 계산 — present/(present+absent+late), 0건이면 null)
                const present = attendances.filter((a: any) => a.status === "PRESENT").length;
                const absent = attendances.filter((a: any) => a.status === "ABSENT").length;
                const late = attendances.filter((a: any) => a.status === "LATE").length;
                const attTotal = attendances.length;
                const attendanceRate = attTotal > 0 ? Math.round((present / attTotal) * 100) : null;

                return {
                    id: studentId,
                    name: s.name,
                    attendance: {
                        total: attTotal,
                        present,
                        absent,
                        late,
                        rate: attendanceRate, // null = 기록 없음
                        records: attendances.map((a: any) => ({
                            status: a.status,
                            date: a.date,
                            className: a.class_name ?? null,
                        })),
                    },
                    payments: payments.map((p: any) => ({
                        id: p.id,
                        amount: Number(p.amount),
                        status: p.status,
                        dueDate: p.dueDate ?? p.duedate,
                        paidDate: p.paidDate ?? p.paiddate ?? null,
                        type: p.type ?? "MONTHLY",
                        description: p.description ?? null,
                        method: p.method ?? null,
                        receiptUrl: p.receiptUrl ?? p.receipturl ?? null,
                        invoiceId: p.invoice_id ?? null,
                        invoiceNo: p.invoiceNo ?? p.invoiceno ?? null,
                        invoiceStatus: p.invoice_status ?? null,
                        invoiceCheckoutUrl: p.invoice_checkout_url ?? null,
                    })),
                };
            })
        );

        return {
            parent: { id: parent.id, name: parent.name },
            children,
        };
    } catch (e) {
        console.error("[getMyPageHistory] failed:", e);
        return null;
    }
}

// ── 갤러리 조회 ──────────────────────────────────────────────────────────────
export const getGalleryPosts = cache(async (options?: { limit?: number; offset?: number; publicOnly?: boolean }) => {
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;
    const publicFilter = options?.publicOnly ? `WHERE g."isPublic" = true` : "";
    try {
        const rows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT g.id, g."classId", g.title, g.caption, g."mediaJSON",
                    g."isPublic", g."createdAt", g."updatedAt",
                    c.name AS class_name
             FROM "GalleryPost" g
             LEFT JOIN "Class" c ON g."classId" = c.id
             ${publicFilter}
             ORDER BY g."createdAt" DESC
             LIMIT $1 OFFSET $2`,
            limit,
            offset,
        );
        return rows.map((r: any) => ({
            id: r.id,
            classId: r.classId ?? r.classid ?? null,
            title: r.title ?? null,
            caption: r.caption ?? null,
            mediaJSON: r.mediaJSON ?? r.mediajson ?? "[]",
            isPublic: r.isPublic ?? r.ispublic ?? true,
            createdAt: r.createdAt ?? r.createdat,
            updatedAt: r.updatedAt ?? r.updatedat,
            className: r.class_name ?? null,
        }));
    } catch (e) {
        console.error("[getGalleryPosts] failed:", e);
        return [];
    }
});

/** 특정 classId 목록에 해당하는 갤러리 (마이페이지용) */
export async function getGalleryByClassIds(classIds: string[], limit = 20) {
    if (classIds.length === 0) return [];
    try {
        const placeholders = classIds.map((_, i) => `$${i + 1}`).join(", ");
        const rows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT g.id, g."classId", g.title, g.caption, g."mediaJSON",
                    g."createdAt", c.name AS class_name
             FROM "GalleryPost" g
             LEFT JOIN "Class" c ON g."classId" = c.id
             WHERE g."classId" IN (${placeholders})
             ORDER BY g."createdAt" DESC
             LIMIT $${classIds.length + 1}`,
            ...classIds, limit
        );
        return rows.map((r: any) => ({
            id: r.id,
            classId: r.classId ?? r.classid ?? null,
            title: r.title ?? null,
            caption: r.caption ?? null,
            mediaJSON: r.mediaJSON ?? r.mediajson ?? "[]",
            createdAt: r.createdAt ?? r.createdat,
            className: r.class_name ?? null,
        }));
    } catch (e) {
        console.error("[getGalleryByClassIds] failed:", e);
        return [];
    }
}

// ── 공지사항 조회 ────────────────────────────────────────────────────────────
export const getNotices = cache(async (options?: { limit?: number; offset?: number; publicOnly?: boolean }) => {
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;
    const publicFilter = options?.publicOnly ? `WHERE "targetType" = 'ALL'` : "";
    try {
        const rows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT id, title, content, "targetType", "targetClassIds",
                    "attachmentsJSON", "isPinned", "createdAt", "updatedAt"
             FROM "Notice"
             ${publicFilter}
             ORDER BY "isPinned" DESC, "createdAt" DESC
             LIMIT $1 OFFSET $2`,
            limit,
            offset
        );
        return rows.map((r: any) => ({
            id: r.id,
            title: r.title,
            content: r.content,
            targetType: r.targetType ?? r.targettype ?? "ALL",
            targetClassIds: r.targetClassIds ?? r.targetclassids ?? null,
            attachmentsJSON: r.attachmentsJSON ?? r.attachmentsjson ?? null,
            isPinned: r.isPinned ?? r.ispinned ?? false,
            createdAt: r.createdAt ?? r.createdat,
            updatedAt: r.updatedAt ?? r.updatedat,
        }));
    } catch (e) {
        console.error("[getNotices] failed:", e);
        return [];
    }
});

export const getNoticeById = cache(async (id: string) => {
    try {
        const rows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT id, title, content, "targetType", "targetClassIds",
                    "attachmentsJSON", "isPinned", "createdAt", "updatedAt"
             FROM "Notice" WHERE id = $1 LIMIT 1`,
            id
        );
        if (!rows[0]) return null;
        const r = rows[0];
        return {
            id: r.id,
            title: r.title,
            content: r.content,
            targetType: r.targetType ?? r.targettype ?? "ALL",
            targetClassIds: r.targetClassIds ?? r.targetclassids ?? null,
            attachmentsJSON: r.attachmentsJSON ?? r.attachmentsjson ?? null,
            isPinned: r.isPinned ?? r.ispinned ?? false,
            createdAt: r.createdAt ?? r.createdat,
            updatedAt: r.updatedAt ?? r.updatedat,
        };
    } catch (e) {
        console.error("[getNoticeById] failed:", e);
        return null;
    }
});

/** 특정 classId 목록에 해당하는 공지 (마이페이지용) - 전체 공지 포함 */
export async function getNoticesByClassIds(classIds: string[], limit = 20) {
    try {
        // 전체 공지 OR 해당 반 공지
        const rows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT id, title, content, "targetType", "targetClassIds",
                    "attachmentsJSON", "isPinned", "createdAt"
             FROM "Notice"
             WHERE "targetType" = 'ALL'
                OR "targetType" = 'CLASS'
             ORDER BY "isPinned" DESC, "createdAt" DESC
             LIMIT $1`,
            limit
        );
        // 클라이언트 필터: CLASS 타입이면 해당 classId 포함 여부 확인
        return rows
            .filter((r: any) => {
                const type = r.targetType ?? r.targettype ?? "ALL";
                if (type === "ALL") return true;
                const ids = (r.targetClassIds ?? r.targetclassids ?? "").split(",").map((s: string) => s.trim());
                return classIds.some(cid => ids.includes(cid));
            })
            .map((r: any) => ({
                id: r.id,
                title: r.title,
                content: r.content,
                targetType: r.targetType ?? r.targettype ?? "ALL",
                attachmentsJSON: r.attachmentsJSON ?? r.attachmentsjson ?? null,
                isPinned: r.isPinned ?? r.ispinned ?? false,
                createdAt: r.createdAt ?? r.createdat,
            }));
    } catch (e) {
        console.error("[getNoticesByClassIds] failed:", e);
        return [];
    }
}

// ── 경영 대시보드 통계 ──────────────────────────────────────────────────────
export const getDashboardExtendedStats = cache(async () => {
    try {
        const now = new Date();

        // 6개월 전 1일을 시작점으로 계산 (이번 달 포함 6개월치)
        const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);
        const sixMonthsAgoStr = `${sixMonthsAgo.getFullYear()}-${String(sixMonthsAgo.getMonth() + 1).padStart(2, "0")}-01`;

        // 이번 달 다음 달 1일 (상한 경계)
        const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
        const nextMonthStr = `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, "0")}-01`;

        // 이번 달 / 지난 달 키 (월별 매출 맵에서 꺼내기 위해)
        const thisMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
        const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const lastMonthKey = `${lastMonthDate.getFullYear()}-${String(lastMonthDate.getMonth() + 1).padStart(2, "0")}`;

        // 4개 쿼리를 Promise.all로 병렬 실행 (순차 → 병렬: 응답 시간 단축)
        const [revenueByMonth, attendanceByMonth, unpaidRows, programStudents] = await Promise.all([
            // [쿼리 1] 6개월 매출을 GROUP BY로 한 번에 가져옴
            prisma.$queryRawUnsafe<any[]>(
                `SELECT TO_CHAR(DATE_TRUNC('month', "paidDate"), 'YYYY-MM') AS month,
                        COALESCE(SUM(amount), 0)::int AS total
                 FROM "Payment"
                 WHERE status = 'PAID'
                   AND "paidDate" >= $1::timestamp
                   AND "paidDate" < $2::timestamp
                 GROUP BY DATE_TRUNC('month', "paidDate")
                 ORDER BY DATE_TRUNC('month', "paidDate")`,
                sixMonthsAgoStr, nextMonthStr
            ),
            // [쿼리 2] 6개월 출석률을 GROUP BY로 한 번에 가져옴
            prisma.$queryRawUnsafe<any[]>(
                `SELECT TO_CHAR(DATE_TRUNC('month', se.date), 'YYYY-MM') AS month,
                        COUNT(*)::int AS total,
                        COUNT(CASE WHEN a.status = 'PRESENT' THEN 1 END)::int AS present
                 FROM "Attendance" a
                 JOIN "Session" se ON a."sessionId" = se.id
                 WHERE se.date >= $1::timestamp
                   AND se.date < $2::timestamp
                 GROUP BY DATE_TRUNC('month', se.date)
                 ORDER BY DATE_TRUNC('month', se.date)`,
                sixMonthsAgoStr, nextMonthStr
            ),
            // [쿼리 3] 미납 건수/금액
            prisma.$queryRawUnsafe<any[]>(
                `SELECT COUNT(*)::int AS cnt, COALESCE(SUM(amount), 0)::int AS total
                 FROM "Payment" WHERE status IN ('PENDING', 'OVERDUE')`
            ),
            // [쿼리 4] 프로그램별 원생 수
            prisma.$queryRawUnsafe<any[]>(
                `SELECT p.name, COUNT(DISTINCT e."studentId")::int AS cnt
                 FROM "Program" p
                 LEFT JOIN "Class" c ON c."programId" = p.id
                 LEFT JOIN "Enrollment" e ON e."classId" = c.id AND e.status = 'ACTIVE'
                 WHERE p."deletedAt" IS NULL
                 GROUP BY p.id, p.name, p."order"
                 ORDER BY p."order" ASC`
            ),
        ]);

        // 매출 결과를 월별 맵으로 변환 (빠른 조회용)
        const revenueMap = new Map<string, number>();
        for (const row of revenueByMonth) {
            revenueMap.set(row.month, Number(row.total ?? 0));
        }

        // 이번 달 / 지난 달 매출을 맵에서 추출
        const thisMonthRevenue = revenueMap.get(thisMonthKey) ?? 0;
        const lastMonthRevenue = revenueMap.get(lastMonthKey) ?? 0;

        // 6개월 매출 추이 배열 구성 (과거→현재 순서)
        const monthlyRevenue: { month: string; amount: number }[] = [];
        for (let i = 5; i >= 0; i--) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
            monthlyRevenue.push({
                month: `${d.getMonth() + 1}월`,
                amount: revenueMap.get(key) ?? 0,
            });
        }

        // 출석 결과를 월별 맵으로 변환
        const attendanceMap = new Map<string, { total: number; present: number }>();
        for (const row of attendanceByMonth) {
            attendanceMap.set(row.month, {
                total: Number(row.total ?? 0),
                present: Number(row.present ?? 0),
            });
        }

        // 이번 달 출석률 계산
        const thisMonthAtt = attendanceMap.get(thisMonthKey);
        const attendanceRate = thisMonthAtt && thisMonthAtt.total > 0
            ? Math.round((thisMonthAtt.present / thisMonthAtt.total) * 100)
            : 0;

        // 6개월 출석률 추이 배열 구성 (과거→현재 순서)
        const monthlyAttendance: { month: string; rate: number }[] = [];
        for (let i = 5; i >= 0; i--) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
            const att = attendanceMap.get(key);
            monthlyAttendance.push({
                month: `${d.getMonth() + 1}월`,
                rate: att && att.total > 0 ? Math.round((att.present / att.total) * 100) : 0,
            });
        }

        // 미납 결과 추출
        const unpaidCount = Number(unpaidRows[0]?.cnt ?? 0);
        const unpaidAmount = Number(unpaidRows[0]?.total ?? 0);

        return {
            thisMonthRevenue,
            lastMonthRevenue,
            attendanceRate,
            unpaidCount,
            unpaidAmount,
            monthlyRevenue,
            monthlyAttendance,
            programStudents: programStudents.map((r: any) => ({
                name: r.name,
                count: Number(r.cnt ?? 0),
            })),
        };
    } catch (e) {
        console.error("[getDashboardExtendedStats] failed:", e);
        return {
            thisMonthRevenue: 0, lastMonthRevenue: 0, attendanceRate: 0,
            unpaidCount: 0, unpaidAmount: 0,
            monthlyRevenue: [], monthlyAttendance: [], programStudents: [],
        };
    }
});

type StudentMonthlyClass = {
    slotKey: string;
    className: string;
    dayOfWeek: string | null;
    startTime: string | null;
    endTime: string | null;
    programName: string | null;
};

type StudentMonthlyChange = {
    summary: string | null;
    note: string | null;
    occurredAt: Date | string | null;
    createdAt: Date | string | null;
};

type StudentMonthlyClassRaw = {
    slotKey?: unknown;
    slotkey?: unknown;
    className?: unknown;
    dayOfWeek?: unknown;
    dayofweek?: unknown;
    startTime?: unknown;
    starttime?: unknown;
    endTime?: unknown;
    endtime?: unknown;
    programName?: unknown;
    programname?: unknown;
};

type StudentMonthlyChangeRaw = {
    summary?: unknown;
    note?: unknown;
    occurredAt?: Date | string | null;
    occurredat?: Date | string | null;
    createdAt?: Date | string | null;
    createdat?: Date | string | null;
};

type StudentMonthlyHistoryRawRow = {
    id: string;
    registrationMonth?: unknown;
    registrationmonth?: unknown;
    status?: unknown;
    paymentAmount?: unknown;
    paymentamount?: unknown;
    tuitionAmount?: unknown;
    tuitionamount?: unknown;
    shuttleFee?: unknown;
    shuttlefee?: unknown;
    carryOverAmount?: unknown;
    carryoveramount?: unknown;
    paymentMethod?: unknown;
    paymentmethod?: unknown;
    paymentDate?: Date | string | null;
    paymentdate?: Date | string | null;
    shuttleNeeded?: unknown;
    shuttleneeded?: unknown;
    shuttlePickup?: unknown;
    shuttlepickup?: unknown;
    shuttlePreferredTime?: unknown;
    shuttlepreferredtime?: unknown;
    shuttleDropoff?: unknown;
    shuttledropoff?: unknown;
    school?: unknown;
    grade?: unknown;
    classes?: unknown;
    changes?: unknown;
};

const DAY_ORDER: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

function parseRegistrationMonthParts(value: unknown) {
    const numbers = String(value ?? "")
        .match(/\d+/g)
        ?.map(Number) ?? [];

    if (numbers.length >= 2 && numbers[0] >= 2000) {
        return { year: numbers[0], month: numbers[1] };
    }

    if (numbers.length >= 1) {
        return { year: null, month: numbers[0] };
    }

    return { year: null, month: null };
}

function parseJsonList<T>(value: unknown): T[] {
    if (Array.isArray(value)) return value;
    if (typeof value !== "string" || value.trim() === "") return [];

    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function toNullableString(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function addNumber(total: number, value: unknown) {
    const numeric = Number(value ?? 0);
    return Number.isFinite(numeric) ? total + numeric : total;
}

function chooseLedgerStatus(current: string, next: unknown) {
    const nextStatus = typeof next === "string" ? next : "NONE";
    const order: Record<string, number> = { WITHDRAWN: 3, ACTIVE: 2, PAUSED: 1, NONE: 0 };
    return (order[nextStatus] ?? 0) > (order[current] ?? 0) ? nextStatus : current;
}

function buildStudentMonthlyHistory(rows: StudentMonthlyHistoryRawRow[]) {
    const monthMap = new Map<string, {
        id: string;
        registrationMonth: string | null;
        year: number | null;
        month: number | null;
        status: string;
        rowCount: number;
        classes: StudentMonthlyClass[];
        classKeys: Set<string>;
        paymentAmount: number;
        tuitionAmount: number;
        shuttleFee: number;
        carryOverAmount: number;
        paymentMethods: Set<string>;
        paymentDate: Date | string | null;
        shuttle: {
            needed: boolean;
            pickup: string | null;
            preferredTime: string | null;
            dropoff: string | null;
        };
        school: string | null;
        grade: string | null;
        changes: StudentMonthlyChange[];
    }>();

    for (const row of rows) {
        const registrationMonth = toNullableString(row.registrationMonth ?? row.registrationmonth);
        const { year, month } = parseRegistrationMonthParts(registrationMonth);
        const key = `${year ?? "unknown"}-${month ?? registrationMonth ?? row.id}`;

        if (!monthMap.has(key)) {
            monthMap.set(key, {
                id: key,
                registrationMonth,
                year,
                month,
                status: "NONE",
                rowCount: 0,
                classes: [],
                classKeys: new Set<string>(),
                paymentAmount: 0,
                tuitionAmount: 0,
                shuttleFee: 0,
                carryOverAmount: 0,
                paymentMethods: new Set<string>(),
                paymentDate: null,
                shuttle: {
                    needed: false,
                    pickup: null,
                    preferredTime: null,
                    dropoff: null,
                },
                school: null,
                grade: null,
                changes: [],
            });
        }

        const item = monthMap.get(key)!;
        item.rowCount += 1;
        item.status = chooseLedgerStatus(item.status, row.status);
        item.paymentAmount = addNumber(item.paymentAmount, row.paymentAmount ?? row.paymentamount);
        item.tuitionAmount = addNumber(item.tuitionAmount, row.tuitionAmount ?? row.tuitionamount);
        item.shuttleFee = addNumber(item.shuttleFee, row.shuttleFee ?? row.shuttlefee);
        item.carryOverAmount = addNumber(item.carryOverAmount, row.carryOverAmount ?? row.carryoveramount);

        const paymentMethod = toNullableString(row.paymentMethod ?? row.paymentmethod);
        if (paymentMethod) item.paymentMethods.add(paymentMethod);

        const paymentDate = row.paymentDate ?? row.paymentdate ?? null;
        if (paymentDate) item.paymentDate = paymentDate;

        item.school ||= toNullableString(row.school);
        item.grade ||= toNullableString(row.grade);

        if (row.shuttleNeeded ?? row.shuttleneeded) {
            item.shuttle.needed = true;
        }
        item.shuttle.pickup ||= toNullableString(row.shuttlePickup ?? row.shuttlepickup);
        item.shuttle.preferredTime ||= toNullableString(row.shuttlePreferredTime ?? row.shuttlepreferredtime);
        item.shuttle.dropoff ||= toNullableString(row.shuttleDropoff ?? row.shuttledropoff);

        for (const classItem of parseJsonList<StudentMonthlyClassRaw>(row.classes)) {
            const slotKey = toNullableString(classItem.slotKey) ?? toNullableString(classItem.slotkey) ?? toNullableString(classItem.className) ?? "";
            if (!slotKey || item.classKeys.has(slotKey)) continue;

            item.classKeys.add(slotKey);
            item.classes.push({
                slotKey,
                className: toNullableString(classItem.className) ?? slotKey,
                dayOfWeek: toNullableString(classItem.dayOfWeek ?? classItem.dayofweek),
                startTime: toNullableString(classItem.startTime ?? classItem.starttime),
                endTime: toNullableString(classItem.endTime ?? classItem.endtime),
                programName: toNullableString(classItem.programName ?? classItem.programname),
            });
        }

        for (const changeItem of parseJsonList<StudentMonthlyChangeRaw>(row.changes)) {
            const summary = toNullableString(changeItem.summary);
            const note = toNullableString(changeItem.note);
            if (!summary && !note) continue;

            item.changes.push({
                summary,
                note,
                occurredAt: changeItem.occurredAt ?? changeItem.occurredat ?? null,
                createdAt: changeItem.createdAt ?? changeItem.createdat ?? null,
            });
        }
    }

    return Array.from(monthMap.values())
        .map((item) => ({
            id: item.id,
            registrationMonth: item.registrationMonth,
            year: item.year,
            month: item.month,
            status: item.status,
            rowCount: item.rowCount,
            classes: item.classes.sort((a, b) => {
                const dayDiff = (DAY_ORDER[a.dayOfWeek ?? ""] ?? 99) - (DAY_ORDER[b.dayOfWeek ?? ""] ?? 99);
                if (dayDiff !== 0) return dayDiff;
                return (a.startTime ?? "").localeCompare(b.startTime ?? "");
            }),
            paymentAmount: item.paymentAmount,
            tuitionAmount: item.tuitionAmount,
            shuttleFee: item.shuttleFee,
            carryOverAmount: item.carryOverAmount,
            paymentMethods: Array.from(item.paymentMethods),
            paymentDate: item.paymentDate,
            shuttle: item.shuttle,
            school: item.school,
            grade: item.grade,
            changes: item.changes,
        }))
        .sort((a, b) => {
            const yearDiff = (b.year ?? 0) - (a.year ?? 0);
            if (yearDiff !== 0) return yearDiff;
            return (b.month ?? 0) - (a.month ?? 0);
        });
}

// ── 원생 상세 활동 현황 ─────────────────────────────────────────────────────
export async function getStudentActivity(studentId: string) {
    try {
        // 1단계: 원생 기본 + 학부모 정보 (null이면 즉시 반환해야 하므로 먼저 실행)
        const sRows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT s.id, s.name, s."birthDate", s.gender, s.memo, s."parentId",
                    s.phone, s.school, s.grade, s.address, s."enrollDate",
                    s."createdAt", s."updatedAt",
                    u.name AS parent_name, u.phone AS parent_phone, u.email AS parent_email
             FROM "Student" s
             LEFT JOIN "User" u ON s."parentId" = u.id
             WHERE s.id = $1`,
            studentId
        );
        if (!sRows[0]) return null;
        const r = sRows[0];

        // 2단계: 수강/출결/수납/통계/갤러리/월별 이력을 모두 병렬로 실행
        // classIds를 별도 쿼리로 가져와서 갤러리도 2단계에 합류 (3단계 직렬 제거)
        const [enrollments, attendances, payments, attStats, galleryPosts, monthlyHistoryRows] = await Promise.all([
            // 수강 내역
            prisma.$queryRawUnsafe<any[]>(
                `SELECT e.id, e."classId", e.status, e."createdAt",
                        c.name AS class_name, c."dayOfWeek", c."startTime", c."endTime",
                        p.name AS program_name
                 FROM "Enrollment" e
                 LEFT JOIN "Class" c ON e."classId" = c.id
                 LEFT JOIN "Program" p ON c."programId" = p.id
                 WHERE e."studentId" = $1
                 ORDER BY e."createdAt" DESC`,
                studentId
            ),
            // 전체 출결 기록 (최근 50건)
            prisma.$queryRawUnsafe<any[]>(
                `SELECT a.id, a.status, se.date, c.name AS class_name
                 FROM "Attendance" a
                 JOIN "Session" se ON a."sessionId" = se.id
                 JOIN "Class" c ON se."classId" = c.id
                 WHERE a."studentId" = $1
                 ORDER BY se.date DESC LIMIT 50`,
                studentId
            ),
            // 전체 수납 기록
            prisma.$queryRawUnsafe<any[]>(
                `SELECT p.id, p.amount, p.status, p."dueDate", p."paidDate", p."createdAt",
                        p.type, p.description, p.method, p."invoiceNo", p."issuedAt",
                        p."payableUntil", p."receiptUrl",
                        i.id AS invoice_id, i.status AS invoice_status, i."sentAt" AS invoice_sent_at,
                        i."checkoutUrl" AS invoice_checkout_url
                 FROM "Payment" p
                 LEFT JOIN "PaymentInvoice" i ON i."paymentId" = p.id
                 WHERE p."studentId" = $1
                 ORDER BY p."dueDate" DESC`,
                studentId
            ),
            // 출석 통계
            prisma.$queryRawUnsafe<any[]>(
                `SELECT COUNT(*)::int AS total,
                        COUNT(CASE WHEN a.status = 'PRESENT' THEN 1 END)::int AS present,
                        COUNT(CASE WHEN a.status = 'ABSENT' THEN 1 END)::int AS absent,
                        COUNT(CASE WHEN a.status = 'LATE' THEN 1 END)::int AS late,
                        COUNT(CASE WHEN a.status = 'EXCUSED' THEN 1 END)::int AS excused
                 FROM "Attendance" a
                 WHERE a."studentId" = $1`,
                studentId
            ),
            // 갤러리: classIds를 서브쿼리로 직접 가져와서 별도 단계 없이 병렬 실행
            // enrollments 결과를 기다리지 않고 DB에서 직접 classId 목록을 조회
            prisma.$queryRawUnsafe<any[]>(
                `SELECT id, title, "mediaJSON", "createdAt"
                 FROM "GalleryPost"
                 WHERE "classId" IN (
                     SELECT e."classId" FROM "Enrollment" e WHERE e."studentId" = $1
                 )
                 ORDER BY "createdAt" DESC LIMIT 6`,
                studentId
            ),
            // 최신 완료 import 배치 기준 월별 원장 이력
            prisma.$queryRawUnsafe<StudentMonthlyHistoryRawRow[]>(
                `WITH target_batch AS (
                    SELECT b.id
                    FROM "StudentSheetImportBatch" b
                    JOIN "StudentRegistrationLedger" rb ON rb."batchId" = b.id
                    WHERE b.status = 'COMPLETED'
                      AND rb."studentId" = $1
                    ORDER BY b."createdAt" DESC
                    LIMIT 1
                 )
                 SELECT r.id, r."registrationMonth", r.status, r."paymentAmount", r."tuitionAmount",
                        r."shuttleFee", r."carryOverAmount", r."paymentMethod", r."paymentDate",
                        r."shuttleNeeded", r."shuttlePickup", r."shuttlePreferredTime", r."shuttleDropoff",
                        r.school, r.grade, r."rowNumber",
                        (
                            SELECT COALESCE(json_agg(json_build_object(
                                'slotKey', slot.slot_key,
                                'className', COALESCE(c.name, slot.slot_key),
                                'dayOfWeek', c."dayOfWeek",
                                'startTime', c."startTime",
                                'endTime', c."endTime",
                                'programName', p.name
                            ) ORDER BY c."dayOfWeek", c."startTime", slot.slot_key), '[]'::json)
                            FROM jsonb_array_elements_text(
                                COALESCE(NULLIF(r."selectedSlotKeysJSON", ''), '[]')::jsonb
                            ) AS slot(slot_key)
                            LEFT JOIN "Class" c ON c."slotKey" = slot.slot_key
                            LEFT JOIN "Program" p ON c."programId" = p.id
                        ) AS classes,
                        (
                            SELECT COALESCE(json_agg(json_build_object(
                                'summary', c."changeSummary",
                                'note', c.note,
                                'occurredAt', c."occurredAt",
                                'createdAt', c."createdAt"
                            ) ORDER BY COALESCE(c."occurredAt", c."createdAt") DESC), '[]'::json)
                            FROM "StudentChangeLog" c
                            WHERE (r."rawRowId" IS NOT NULL AND c."rawRowId" = r."rawRowId")
                               OR (c."batchId" = r."batchId" AND c."rowNumber" = r."rowNumber")
                        ) AS changes
                 FROM "StudentRegistrationLedger" r
                 JOIN target_batch tb ON tb.id = r."batchId"
                 WHERE r."studentId" = $1
                 ORDER BY r."rowNumber" DESC
                 LIMIT 240`,
                studentId
            ),
        ]);

        const stats = attStats[0] || {};
        return {
            student: {
                id: r.id,
                name: r.name,
                birthDate: r.birthDate ?? r.birthdate,
                gender: r.gender ?? null,
                memo: r.memo ?? null,
                parentId: r.parentId ?? r.parentid,
                phone: r.phone ?? null,
                school: r.school ?? null,
                grade: r.grade ?? null,
                address: r.address ?? null,
                enrollDate: r.enrollDate ?? r.enrolldate ?? null,
                createdAt: r.createdAt ?? r.createdat,
                parent: {
                    name: r.parent_name ?? null,
                    phone: r.parent_phone ?? null,
                    email: r.parent_email ?? null,
                },
            },
            enrollments: enrollments.map((e: any) => ({
                id: e.id,
                classId: e.classId ?? e.classid,
                status: e.status,
                createdAt: e.createdAt ?? e.createdat,
                className: e.class_name,
                dayOfWeek: e.dayOfWeek ?? e.dayofweek,
                startTime: e.startTime ?? e.starttime,
                endTime: e.endTime ?? e.endtime,
                programName: e.program_name,
            })),
            attendances: attendances.map((a: any) => ({
                id: a.id,
                status: a.status,
                date: a.date,
                className: a.class_name,
            })),
            payments: payments.map((p: any) => ({
                id: p.id,
                amount: Number(p.amount),
                status: p.status,
                dueDate: p.dueDate ?? p.duedate,
                paidDate: p.paidDate ?? p.paiddate ?? null,
                type: p.type ?? "MONTHLY",
                description: p.description ?? null,
                method: p.method ?? null,
                invoiceId: p.invoice_id ?? null,
                invoiceNo: p.invoiceNo ?? p.invoiceno ?? null,
                invoiceStatus: p.invoice_status ?? null,
                invoiceSentAt: p.invoice_sent_at ?? null,
                invoiceCheckoutUrl: p.invoice_checkout_url ?? null,
                issuedAt: p.issuedAt ?? p.issuedat ?? null,
                payableUntil: p.payableUntil ?? p.payableuntil ?? null,
                receiptUrl: p.receiptUrl ?? p.receipturl ?? null,
                createdAt: p.createdAt ?? p.createdat,
            })),
            attendanceStats: {
                total: Number(stats.total ?? 0),
                present: Number(stats.present ?? 0),
                absent: Number(stats.absent ?? 0),
                late: Number(stats.late ?? 0),
                excused: Number(stats.excused ?? 0),
                rate: Number(stats.total ?? 0) > 0
                    ? Math.round((Number(stats.present ?? 0) / Number(stats.total ?? 0)) * 100)
                    : 0,
            },
            galleryPosts: galleryPosts.map((g: any) => ({
                id: g.id,
                title: g.title ?? null,
                mediaJSON: g.mediaJSON ?? g.mediajson ?? "[]",
                createdAt: g.createdAt ?? g.createdat,
            })),
            monthlyHistory: buildStudentMonthlyHistory(monthlyHistoryRows),
        };
    } catch (e) {
        console.error("[getStudentActivity] failed:", e);
        throw e;
    }
}

// 배차용 실제 셔틀 위치(StudentShuttleLocation) 조회 — PICKUP/DROPOFF 최대 2행
// 수강생 상세에서 위치 편집 카드의 표시·프리필용. 프로젝트 규칙대로 $queryRawUnsafe 사용.
export type StudentShuttleLocationRow = {
    kind: string;               // "PICKUP" | "DROPOFF"
    name: string | null;
    address: string | null;
    roadAddress: string | null;
    latitude: number | null;
    longitude: number | null;
    confirmedAt: Date | string | null;
};
export async function getStudentShuttleLocations(studentId: string): Promise<StudentShuttleLocationRow[]> {
    try {
        const rows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT kind, name, address, "roadAddress", latitude, longitude, "confirmedAt"
             FROM "StudentShuttleLocation"
             WHERE "studentId" = $1`,
            studentId
        );
        // 원시 SQL 컬럼은 camelCase 그대로 오지만, 방어적으로 lower 케이스도 흡수
        return rows.map((r: any) => ({
            kind: r.kind,
            name: r.name ?? null,
            address: r.address ?? null,
            roadAddress: r.roadAddress ?? r.roadaddress ?? null,
            latitude: r.latitude !== null && r.latitude !== undefined ? Number(r.latitude) : null,
            longitude: r.longitude !== null && r.longitude !== undefined ? Number(r.longitude) : null,
            confirmedAt: r.confirmedAt ?? r.confirmedat ?? null,
        }));
    } catch (e) {
        console.error("[getStudentShuttleLocations] failed:", e);
        return [];
    }
}

/** Google Sheets 동기화 캐시 조회 (SheetSlotCache 테이블 싱글턴 row) */
export const getSheetSlotCache = cache(async (): Promise<SheetClassSlot[] | null> => {
    try {
        const rows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT "slotsJson" FROM "SheetSlotCache" WHERE id = 'singleton' LIMIT 1`
        );
        if (!rows[0]) return null;
        const json = rows[0].slotsJson ?? rows[0].slotsjson ?? "[]";
        return JSON.parse(json) as SheetClassSlot[];
    } catch {
        return null;
    }
});

// ── 알림 조회 ─────────────────────────────────────────────────────────────────
// userId 기준으로 알림 목록 조회 (최신순, 최대 50개)
export const getNotifications = cache(async (userId: string) => {
    try {
        const rows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT id, "userId", type, title, message, "linkUrl", "isRead", "createdAt"
             FROM "Notification"
             WHERE "userId" = $1
             ORDER BY "createdAt" DESC
             LIMIT 50`,
            userId
        );
        return rows.map((r: any) => ({
            id: r.id,
            userId: r.userId ?? r.userid,
            type: r.type,
            title: r.title,
            message: r.message,
            linkUrl: r.linkUrl ?? r.linkurl ?? null,
            isRead: r.isRead ?? r.isread ?? false,
            createdAt: r.createdAt ?? r.createdat,
        }));
    } catch {
        return [];
    }
});

// 읽지 않은 알림 개수
export const getUnreadNotificationCount = cache(async (userId: string) => {
    try {
        const rows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT COUNT(*)::int as count FROM "Notification"
             WHERE "userId" = $1 AND "isRead" = false`,
            userId
        );
        return rows[0]?.count ?? 0;
    } catch {
        return 0;
    }
});

// ── 학부모 요청 조회 ──────────────────────────────────────────────────────────

// 학부모 본인의 요청 목록
export const getMyRequests = cache(async (userId: string) => {
    try {
        const rows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT r.id, r."userId", r."studentId", r.type, r.title, r.content,
                    r.date, r.status, r."adminNote", r."createdAt", r."updatedAt",
                    s.name AS student_name
             FROM "ParentRequest" r
             LEFT JOIN "Student" s ON r."studentId" = s.id
             WHERE r."userId" = $1
             ORDER BY r."createdAt" DESC
             LIMIT 30`,
            userId
        );
        return rows.map((r: any) => ({
            id: r.id,
            userId: r.userId ?? r.userid,
            studentId: r.studentId ?? r.studentid,
            type: r.type,
            title: r.title,
            content: r.content,
            date: r.date,
            status: r.status,
            adminNote: r.adminNote ?? r.adminnote ?? null,
            createdAt: r.createdAt ?? r.createdat,
            updatedAt: r.updatedAt ?? r.updatedat,
            studentName: r.student_name,
        }));
    } catch {
        return [];
    }
});

// 관리자용: 전체 요청 목록 (최신순)
export const getAllRequests = cache(async (options?: string | { statusFilter?: string; limit?: number; offset?: number }) => {
    const statusFilter = typeof options === "string" ? options : options?.statusFilter;
    const limit =
        typeof options === "object" && typeof options.limit === "number" && Number.isFinite(options.limit) && options.limit > 0
            ? Math.min(Math.floor(options.limit), 100)
            : 30;
    const offset =
        typeof options === "object" && typeof options.offset === "number" && Number.isFinite(options.offset) && options.offset > 0
            ? Math.floor(options.offset)
            : 0;
    try {
        // statusFilter 유무에 따라 WHERE절 포함 여부를 분기
        // $queryRawUnsafe의 $1 파라미터 바인딩으로 SQL 인젝션 방지
        const baseQuery = `SELECT r.id, r."userId", r."studentId", r.type, r.title, r.content,
                    r.date, r.status, r."adminNote", r."createdAt", r."updatedAt",
                    s.name AS student_name,
                    u.name AS parent_name, u.phone AS parent_phone
             FROM "ParentRequest" r
             LEFT JOIN "Student" s ON r."studentId" = s.id
             LEFT JOIN "User" u ON r."userId" = u.id`;
        const orderClause = `ORDER BY
                CASE r.status WHEN 'PENDING' THEN 0 WHEN 'CONFIRMED' THEN 1 ELSE 2 END,
                r."createdAt" DESC
             LIMIT ${statusFilter ? "$2" : "$1"} OFFSET ${statusFilter ? "$3" : "$2"}`;
        const rows = statusFilter
            ? await prisma.$queryRawUnsafe<any[]>(
                `${baseQuery} WHERE r.status = $1 ${orderClause}`,
                statusFilter,
                limit,
                offset
              )
            : await prisma.$queryRawUnsafe<any[]>(
                `${baseQuery} ${orderClause}`,
                limit,
                offset
              );
        return rows.map((r: any) => ({
            id: r.id,
            userId: r.userId ?? r.userid,
            studentId: r.studentId ?? r.studentid,
            type: r.type,
            title: r.title,
            content: r.content,
            date: r.date,
            status: r.status,
            adminNote: r.adminNote ?? r.adminnote ?? null,
            createdAt: r.createdAt ?? r.createdat,
            updatedAt: r.updatedAt ?? r.updatedat,
            studentName: r.student_name,
            parentName: r.parent_name,
            parentPhone: r.parent_phone,
        }));
    } catch {
        return [];
    }
});

// 관리자 대시보드용: 미처리 요청 수
export const getPendingRequestCount = cache(async () => {
    try {
        const rows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT COUNT(*)::int as count FROM "ParentRequest" WHERE status = 'PENDING'`
        );
        return rows[0]?.count ?? 0;
    } catch {
        return 0;
    }
});

// 관리자 대시보드용: 최근 미처리 요청 (최대 5개)
export const getRecentPendingRequests = cache(async () => {
    try {
        const rows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT r.id, r.type, r.title, r.status, r."createdAt",
                    s.name AS student_name, u.name AS parent_name
             FROM "ParentRequest" r
             LEFT JOIN "Student" s ON r."studentId" = s.id
             LEFT JOIN "User" u ON r."userId" = u.id
             WHERE r.status = 'PENDING'
             ORDER BY r."createdAt" DESC
             LIMIT 5`
        );
        return rows.map((r: any) => ({
            id: r.id,
            type: r.type,
            title: r.title,
            status: r.status,
            createdAt: r.createdAt ?? r.createdat,
            studentName: r.student_name,
            parentName: r.parent_name,
        }));
    } catch {
        return [];
    }
});

// ── 학습 피드백 조회 ──────────────────────────────────────────────────────────

// 학생별 피드백 목록 (최신순, 코치 이름 포함)
export const getFeedbacksByStudent = cache(async (studentId: string) => {
    try {
        const rows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT f.id, f."studentId", f."coachId", f."sessionDate", f.category,
                    f.title, f.content, f.rating, f."isPublic", f."createdAt",
                    c.name AS coach_name
             FROM "Feedback" f
             LEFT JOIN "Coach" c ON f."coachId" = c.id
             WHERE f."studentId" = $1
             ORDER BY f."createdAt" DESC
             LIMIT 30`,
            studentId
        );
        return rows.map((r: any) => ({
            id: r.id,
            studentId: r.studentId ?? r.studentid,
            coachId: r.coachId ?? r.coachid,
            sessionDate: r.sessionDate ?? r.sessiondate ?? null,
            category: r.category,
            title: r.title,
            content: r.content,
            rating: r.rating != null ? Number(r.rating) : null,
            isPublic: r.isPublic ?? r.ispublic ?? true,
            createdAt: r.createdAt ?? r.createdat,
            coachName: r.coach_name,
        }));
    } catch { return []; }
});

// 관리자용: 전체 피드백 목록 (최신순, 코치+원생 이름 포함)
export const getAllFeedbacks = cache(async () => {
    try {
        const rows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT f.id, f."studentId", f."coachId", f."sessionDate", f.category,
                    f.title, f.content, f.rating, f."isPublic", f."createdAt",
                    c.name AS coach_name, s.name AS student_name
             FROM "Feedback" f
             LEFT JOIN "Coach" c ON f."coachId" = c.id
             LEFT JOIN "Student" s ON f."studentId" = s.id
             ORDER BY f."createdAt" DESC
             LIMIT 100`
        );
        return rows.map((r: any) => ({
            id: r.id,
            studentId: r.studentId ?? r.studentid,
            coachId: r.coachId ?? r.coachid,
            sessionDate: r.sessionDate ?? r.sessiondate ?? null,
            category: r.category,
            title: r.title,
            content: r.content,
            rating: r.rating != null ? Number(r.rating) : null,
            isPublic: r.isPublic ?? r.ispublic ?? true,
            createdAt: r.createdAt ?? r.createdat,
            coachName: r.coach_name,
            studentName: r.student_name,
        }));
    } catch { return []; }
});

// ── FAQ 조회 ─────────────────────────────────────────────────────────────────

// 공개 FAQ만 조회 (공개 페이지용 — isPublic=true, order 오름차순)
export const getPublicFaqs = cache(async () => {
    try {
        const rows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT id, question, answer, "order", "isPublic", "createdAt", "updatedAt"
             FROM "Faq"
             WHERE "isPublic" = true
             ORDER BY "order" ASC, "createdAt" ASC`
        );
        return rows.map((r: any) => ({
            id: r.id,
            question: r.question,
            answer: r.answer,
            order: Number(r.order ?? 0),
            isPublic: r.isPublic ?? r.ispublic ?? true,
            createdAt: r.createdAt ?? r.createdat,
            updatedAt: r.updatedAt ?? r.updatedat,
        }));
    } catch (e) {
        console.error("[getPublicFaqs] failed:", e);
        return [];
    }
});

// 전체 FAQ 조회 (관리자용 — 공개/비공개 모두, order 오름차순)
export const getAllFaqs = cache(async () => {
    try {
        const rows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT id, question, answer, "order", "isPublic", "createdAt", "updatedAt"
             FROM "Faq"
             ORDER BY "order" ASC, "createdAt" ASC`
        );
        return rows.map((r: any) => ({
            id: r.id,
            question: r.question,
            answer: r.answer,
            order: Number(r.order ?? 0),
            isPublic: r.isPublic ?? r.ispublic ?? true,
            createdAt: r.createdAt ?? r.createdat,
            updatedAt: r.updatedAt ?? r.updatedat,
        }));
    } catch (e) {
        console.error("[getAllFaqs] failed:", e);
        return [];
    }
});

// ── 학부모 후기 조회 ─────────────────────────────────────────────────────────

// 공개 후기만 조회 (랜딩 페이지용 — isPublic=true, order 오름차순)
export const getPublicTestimonials = cache(async () => {
    try {
        const rows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT id, name, info, text, rating, "order", "isPublic", "createdAt", "updatedAt"
             FROM "Testimonial"
             WHERE "isPublic" = true
             ORDER BY "order" ASC, "createdAt" ASC`
        );
        return rows.map((r: any) => ({
            id: r.id,
            name: r.name,
            info: r.info,
            text: r.text,
            rating: Number(r.rating ?? 5),
            order: Number(r.order ?? 0),
            isPublic: r.isPublic ?? r.ispublic ?? true,
            createdAt: r.createdAt ?? r.createdat,
            updatedAt: r.updatedAt ?? r.updatedat,
        }));
    } catch (e) {
        console.error("[getPublicTestimonials] failed:", e);
        return [];
    }
});

// 전체 후기 조회 (관리자용 — 공개/비공개 모두, order 오름차순)
export const getAllTestimonials = cache(async () => {
    try {
        const rows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT id, name, info, text, rating, "order", "isPublic", "createdAt", "updatedAt"
             FROM "Testimonial"
             ORDER BY "order" ASC, "createdAt" ASC`
        );
        return rows.map((r: any) => ({
            id: r.id,
            name: r.name,
            info: r.info,
            text: r.text,
            rating: Number(r.rating ?? 5),
            order: Number(r.order ?? 0),
            isPublic: r.isPublic ?? r.ispublic ?? true,
            createdAt: r.createdAt ?? r.createdat,
            updatedAt: r.updatedAt ?? r.updatedat,
        }));
    } catch (e) {
        console.error("[getAllTestimonials] failed:", e);
        return [];
    }
});

// 학부모 마이페이지용: 자녀들의 공개 피드백만 조회
export const getChildrenFeedbacks = cache(async (studentIds: string[]) => {
    try {
        if (studentIds.length === 0) return [];
        // 자녀 ID 개수에 맞춰 동적 placeholder 생성 ($1, $2, ...)
        const placeholders = studentIds.map((_, i) => `$${i + 1}`).join(",");
        const rows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT f.id, f."studentId", f."coachId", f."sessionDate", f.category,
                    f.title, f.content, f.rating, f."createdAt",
                    c.name AS coach_name, s.name AS student_name
             FROM "Feedback" f
             LEFT JOIN "Coach" c ON f."coachId" = c.id
             LEFT JOIN "Student" s ON f."studentId" = s.id
             WHERE f."studentId" IN (${placeholders}) AND f."isPublic" = true
             ORDER BY f."createdAt" DESC
             LIMIT 20`,
            ...studentIds
        );
        return rows.map((r: any) => ({
            id: r.id,
            studentId: r.studentId ?? r.studentid,
            sessionDate: r.sessionDate ?? r.sessiondate ?? null,
            category: r.category,
            title: r.title,
            content: r.content,
            rating: r.rating != null ? Number(r.rating) : null,
            createdAt: r.createdAt ?? r.createdat,
            coachName: r.coach_name,
            studentName: r.student_name,
        }));
    } catch { return []; }
});

// ── 수업 기록(클래스 상세) 조회 ─────────────────────────────────────────────────

/** 반 상세 + 수강생 목록 조회 (클래스 상세 페이지용) */
export const getClassWithStudents = cache(async (classId: string) => {
    try {
        // 반 정보와 수강생 목록을 병렬로 동시 조회 (classId만 있으면 독립 실행 가능)
        const [classRows, studentRows] = await Promise.all([
            // 반 기본 정보 + 프로그램명 JOIN
            prisma.$queryRawUnsafe<any[]>(
                `SELECT c.id, c.name, c."dayOfWeek", c."startTime", c."endTime", c.capacity, c."slotKey",
                        p.name AS program_name, p.id AS program_id
                 FROM "Class" c
                 LEFT JOIN "Program" p ON c."programId" = p.id
                 WHERE c.id = $1`,
                classId
            ),
            // ACTIVE 상태의 수강생 목록 (이름순 정렬)
            prisma.$queryRawUnsafe<any[]>(
                `SELECT e.id AS enrollment_id, e.status, e."createdAt" AS enrolled_at,
                        s.id AS student_id, s.name AS student_name, s.phone, s.school, s.grade,
                        s."birthDate", s.gender
                 FROM "Enrollment" e
                 JOIN "Student" s ON e."studentId" = s.id AND ${notMergedStudent("s")}
                 WHERE e."classId" = $1 AND e.status = 'ACTIVE'
                 ORDER BY s.name ASC`,
                classId
            ),
        ]);
        // 반 정보가 없으면 null 반환 (수강생 쿼리 결과는 무시)
        if (!classRows[0]) return null;
        const c = classRows[0];

        return {
            // 반 정보 — 컬럼명 대소문자 fallback 처리
            id: c.id,
            name: c.name,
            dayOfWeek: c.dayOfWeek ?? c.dayofweek,
            startTime: c.startTime ?? c.starttime ?? "",
            endTime: c.endTime ?? c.endtime ?? "",
            capacity: Number(c.capacity ?? 0),
            slotKey: c.slotKey ?? c.slotkey ?? null,
            programName: c.program_name ?? null,
            programId: c.program_id ?? null,
            // 수강생 배열
            students: studentRows.map((s: any) => ({
                enrollmentId: s.enrollment_id,
                status: s.status,
                enrolledAt: s.enrolled_at,
                studentId: s.student_id,
                studentName: s.student_name,
                phone: s.phone ?? null,
                school: s.school ?? null,
                grade: s.grade ?? null,
                birthDate: s.birthDate ?? s.birthdate ?? null,
                gender: s.gender ?? null,
            })),
        };
    } catch (e) {
        console.error("[getClassWithStudents] failed:", e);
        throw e;
    }
});

/** 반의 수업 기록 목록 조회 (출석 카운트 포함, 최신순) */
export const getSessionsByClass = cache(async (classId: string, limit: number = 20) => {
    try {
        const rows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT se.id, se.date, se.topic, se.notes, se."photosJSON", se."coachId",
                    co.name AS coach_name,
                    COUNT(a.id)::int AS attendance_count,
                    COUNT(CASE WHEN a.status = 'PRESENT' THEN 1 END)::int AS present_count
             FROM "Session" se
             LEFT JOIN "Coach" co ON se."coachId" = co.id
             LEFT JOIN "Attendance" a ON a."sessionId" = se.id
             WHERE se."classId" = $1
             GROUP BY se.id, se.date, se.topic, se.notes, se."photosJSON", se."coachId", co.name
             ORDER BY se.date DESC
             LIMIT $2`,
            classId, limit
        );
        return rows.map((r: any) => ({
            id: r.id,
            date: r.date,
            topic: r.topic ?? null,
            notes: r.notes ?? null,
            photosJSON: r.photosJSON ?? r.photosjson ?? null,
            coachId: r.coachId ?? r.coachid ?? null,
            coachName: r.coach_name ?? null,
            attendanceCount: Number(r.attendance_count ?? 0),
            presentCount: Number(r.present_count ?? 0),
        }));
    } catch (e) {
        console.error("[getSessionsByClass] failed:", e);
        return [];
    }
});

/** 수업 기록 상세 조회 (수정용 — content 필드 포함) */
export const getSessionDetail = cache(async (sessionId: string) => {
    try {
        const rows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT se.id, se."classId", se.date, se.topic, se.content, se.notes,
                    se."photosJSON", se."coachId", co.name AS coach_name
             FROM "Session" se
             LEFT JOIN "Coach" co ON se."coachId" = co.id
             WHERE se.id = $1`,
            sessionId
        );
        if (!rows[0]) return null;
        const r = rows[0];
        return {
            id: r.id,
            classId: r.classId ?? r.classid,
            date: r.date,
            topic: r.topic ?? null,
            content: r.content ?? null,
            notes: r.notes ?? null,
            photosJSON: r.photosJSON ?? r.photosjson ?? null,
            coachId: r.coachId ?? r.coachid ?? null,
            coachName: r.coach_name ?? null,
        };
    } catch (e) {
        console.error("[getSessionDetail] failed:", e);
        return null;
    }
});

// ══════════════════════════════════════════════════════════════════════════════
// Phase 2: 일일 수업 리포트 — 조회 함수
// ══════════════════════════════════════════════════════════════════════════════

/**
 * 세션 리포트 상세 조회 (관리자용)
 * - 세션 정보 + 반 + 코치 + 출석 목록 + 학생별 개별 노트
 * - 관리자가 리포트를 작성/편집할 때 사용
 */
export const getSessionReport = cache(async (sessionId: string) => {
    try {
        // 1. 세션 기본 정보 (반 이름, 프로그램 이름, 코치 이름 포함)
        const sRows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT se.id, se."classId", se.date, se.topic, se.content,
                    se."photosJSON", se."coachId", se.published, se."publishedAt",
                    c.name AS class_name, c."dayOfWeek", c."startTime", c."endTime",
                    p.name AS program_name,
                    co.name AS coach_name
             FROM "Session" se
             JOIN "Class" c ON se."classId" = c.id
             LEFT JOIN "Program" p ON c."programId" = p.id
             LEFT JOIN "Coach" co ON se."coachId" = co.id
             WHERE se.id = $1`,
            sessionId
        );
        if (!sRows[0]) return null;
        const r = sRows[0];

        // 2. 출석 목록 + 학생별 노트를 병렬 조회
        const [attendances, notes] = await Promise.all([
            prisma.$queryRawUnsafe<any[]>(
                `SELECT a.id, a."studentId", a.status,
                        s.name AS student_name
                 FROM "Attendance" a
                 -- 병합 시 같은 세션 출석행은 UNIQUE 충돌로 흡수된 쪽에 그대로 남는다.
                 -- 필터가 없으면 출석부에 같은 학생이 두 줄 뜬다.
                 JOIN "Student" s ON a."studentId" = s.id AND ${notMergedStudent("s")}
                 WHERE a."sessionId" = $1
                 ORDER BY s.name ASC`,
                sessionId
            ),
            prisma.$queryRawUnsafe<any[]>(
                `SELECT ssn.id, ssn."studentId", ssn.note, ssn.rating,
                        s.name AS student_name
                 FROM "StudentSessionNote" ssn
                 JOIN "Student" s ON ssn."studentId" = s.id AND ${notMergedStudent("s")}
                 WHERE ssn."sessionId" = $1
                 ORDER BY s.name ASC`,
                sessionId
            ),
        ]);

        return {
            id: r.id,
            classId: r.classId ?? r.classid,
            date: r.date,
            topic: r.topic ?? null,
            content: r.content ?? null,
            photosJSON: r.photosJSON ?? r.photosjson ?? null,
            coachId: r.coachId ?? r.coachid ?? null,
            coachName: r.coach_name ?? null,
            published: r.published ?? false,
            publishedAt: r.publishedAt ?? r.publishedat ?? null,
            className: r.class_name,
            dayOfWeek: r.dayOfWeek ?? r.dayofweek,
            startTime: r.startTime ?? r.starttime,
            endTime: r.endTime ?? r.endtime,
            programName: r.program_name ?? null,
            attendances: attendances.map((a: any) => ({
                id: a.id,
                studentId: a.studentId ?? a.studentid,
                status: a.status,
                studentName: a.student_name,
            })),
            notes: notes.map((n: any) => ({
                id: n.id,
                studentId: n.studentId ?? n.studentid,
                note: n.note,
                rating: n.rating != null ? Number(n.rating) : null,
                studentName: n.student_name,
            })),
        };
    } catch (e) {
        console.error("[getSessionReport] failed:", e);
        throw e;
    }
});

/**
 * 학부모용: 내 자녀의 발행된 리포트 목록 조회
 * - parentId로 자녀 찾기 → 자녀의 출석이 있는 세션 중 published=true인 것만
 * - 자기 자녀 리포트만 볼 수 있도록 parentId 필터링 (보안)
 */
export async function getStudentReports(parentId: string, studentId?: string) {
    try {
        // parentId에 속한 자녀 ID 목록 (보안: 다른 사람의 자녀는 조회 불가)
        const myStudents = await prisma.$queryRawUnsafe<any[]>(
            `SELECT id, name FROM "Student" s WHERE s."parentId" = $1 AND ${notMergedStudent("s")}`,
            parentId
        );
        if (myStudents.length === 0) return [];

        // 특정 자녀만 필터할 경우 검증
        let targetIds = myStudents.map((s: any) => s.id);
        if (studentId) {
            if (!targetIds.includes(studentId)) return []; // 보안: 내 자녀가 아니면 빈 배열
            targetIds = [studentId];
        }

        const placeholders = targetIds.map((_: string, i: number) => `$${i + 1}`).join(",");
        const rows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT DISTINCT se.id AS session_id, se.date, se.topic,
                    se."publishedAt", se."photosJSON",
                    c.name AS class_name, c."dayOfWeek", c."startTime", c."endTime",
                    p.name AS program_name,
                    co.name AS coach_name
             FROM "Session" se
             JOIN "Attendance" a ON a."sessionId" = se.id
             JOIN "Class" c ON se."classId" = c.id
             LEFT JOIN "Program" p ON c."programId" = p.id
             LEFT JOIN "Coach" co ON se."coachId" = co.id
             WHERE a."studentId" IN (${placeholders})
               AND se.published = true
             ORDER BY se.date DESC
             LIMIT 50`,
            ...targetIds
        );

        return rows.map((r: any) => ({
            sessionId: r.session_id,
            date: r.date,
            topic: r.topic ?? null,
            publishedAt: r.publishedAt ?? r.publishedat ?? null,
            photosJSON: r.photosJSON ?? r.photosjson ?? null,
            className: r.class_name,
            dayOfWeek: r.dayOfWeek ?? r.dayofweek,
            startTime: r.startTime ?? r.starttime,
            endTime: r.endTime ?? r.endtime,
            programName: r.program_name ?? null,
            coachName: r.coach_name ?? null,
        }));
    } catch (e) {
        console.error("[getStudentReports] failed:", e);
        return [];
    }
}

/**
 * 관리자용: 리포트 목록 (세션 목록 + 발행 상태)
 * - 최근 세션을 날짜순으로 조회
 * - 출결이 기록된 세션만 표시 (출결 없으면 리포트 의미 없음)
 */
export const getSessionsForReportList = cache(async (limit = 50) => {
    try {
        const rows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT se.id, se."classId", se.date, se.topic, se.published,
                    se."publishedAt",
                    c.name AS class_name, c."dayOfWeek", c."startTime", c."endTime",
                    p.name AS program_name,
                    co.name AS coach_name,
                    COUNT(a.id)::int AS attendance_count
             FROM "Session" se
             JOIN "Class" c ON se."classId" = c.id
             LEFT JOIN "Program" p ON c."programId" = p.id
             LEFT JOIN "Coach" co ON se."coachId" = co.id
             LEFT JOIN "Attendance" a ON a."sessionId" = se.id
             GROUP BY se.id, c.id, p.id, co.id
             HAVING COUNT(a.id) > 0
             ORDER BY se.date DESC
             LIMIT $1`,
            limit
        );

        return rows.map((r: any) => ({
            id: r.id,
            classId: r.classId ?? r.classid,
            date: r.date,
            topic: r.topic ?? null,
            published: r.published ?? false,
            publishedAt: r.publishedAt ?? r.publishedat ?? null,
            className: r.class_name,
            dayOfWeek: r.dayOfWeek ?? r.dayofweek,
            startTime: r.startTime ?? r.starttime,
            endTime: r.endTime ?? r.endtime,
            programName: r.program_name ?? null,
            coachName: r.coach_name ?? null,
            attendanceCount: r.attendance_count ?? 0,
        }));
    } catch (e) {
        console.error("[getSessionsForReportList] failed:", e);
        return [];
    }
});

// ── 체험수업 CRM 조회 ──────────────────────────────────────────────────────────

/**
 * 체험 리드 목록 조회 (상태별 필터 가능, 최신순 정렬)
 * - status 파라미터가 없으면 전체 조회
 * - status가 있으면 해당 상태만 필터
 */
export const getTrialLeads = cache(async (statusOrOptions?: string | AdminListQueryOptions) => {
    try {
        const options = normalizeAdminListQueryOptions(statusOrOptions);
        const status = options.status;
        const limitClause = adminListLimitClause(options);
        let rows: any[];
        try {
            rows = status
                ? await prisma.$queryRawUnsafe<any[]>(
                  `SELECT tl.*,
                          latest_log.action AS latest_contact_action,
                          latest_log.note AS latest_contact_note,
                          latest_log."createdAt" AS latest_contact_at,
                          latest_log."createdByName" AS latest_contact_by,
                          open_followup."nextFollowUpAt" AS open_followup_at,
                          open_followup.note AS open_followup_note,
                          sms_delivery.sms_total,
                          sms_delivery.sms_sent,
                          sms_delivery.sms_failed,
                          sms_delivery.sms_pending,
                          sms_delivery.sms_latest_at,
                          sms_delivery.sms_error
                   FROM "TrialLead" tl
                   LEFT JOIN LATERAL (
                       SELECT action, note, "createdAt", "createdByName"
                       FROM "ApplicationContactLog" acl
                       WHERE acl."targetType" = 'TRIAL'
                         AND acl."trialLeadId" = tl.id
                       ORDER BY acl."createdAt" DESC
                       LIMIT 1
                   ) latest_log ON true
                   LEFT JOIN LATERAL (
                       SELECT "nextFollowUpAt", note
                       FROM "ApplicationContactLog" acl
                       WHERE acl."targetType" = 'TRIAL'
                         AND acl."trialLeadId" = tl.id
                         AND acl."nextFollowUpAt" IS NOT NULL
                         AND acl."followUpCompletedAt" IS NULL
                       ORDER BY acl."nextFollowUpAt" ASC
                       LIMIT 1
                   ) open_followup ON true
                   LEFT JOIN LATERAL (
                       SELECT
                           COUNT(*)::int AS sms_total,
                           COUNT(*) FILTER (WHERE latest.status = 'SENT')::int AS sms_sent,
                           COUNT(*) FILTER (WHERE latest.status = 'FAILED')::int AS sms_failed,
                           COUNT(*) FILTER (WHERE latest.status = 'PENDING')::int AS sms_pending,
                           MAX(latest."updatedAt") AS sms_latest_at,
                           MAX(latest."errorCode") FILTER (WHERE latest.status = 'FAILED') AS sms_error
                       FROM (
                           SELECT DISTINCT ON (
                               nd."recipientPhone",
                               nd."payloadJSON"->>'recipientRole',
                               nd."payloadJSON"->>'trigger'
                           )
                               nd.status,
                               nd."updatedAt",
                               nd."errorCode"
                           FROM "NotificationDelivery" nd
                           WHERE nd."eventType" = 'TRIAL_APPLICATION'
                             AND nd.channel = 'SMS'
                             AND nd."dedupeKey" LIKE ('sms:TRIAL_APPLICATION:' || tl.id || ':%')
                           ORDER BY
                               nd."recipientPhone",
                               nd."payloadJSON"->>'recipientRole',
                               nd."payloadJSON"->>'trigger',
                               nd."updatedAt" DESC
                       ) latest
                   ) sms_delivery ON true
                   WHERE tl.status = $1
                   ORDER BY tl."createdAt" DESC${limitClause}`,
                  status
              )
                : await prisma.$queryRawUnsafe<any[]>(
                  `SELECT tl.*,
                          latest_log.action AS latest_contact_action,
                          latest_log.note AS latest_contact_note,
                          latest_log."createdAt" AS latest_contact_at,
                          latest_log."createdByName" AS latest_contact_by,
                          open_followup."nextFollowUpAt" AS open_followup_at,
                          open_followup.note AS open_followup_note,
                          sms_delivery.sms_total,
                          sms_delivery.sms_sent,
                          sms_delivery.sms_failed,
                          sms_delivery.sms_pending,
                          sms_delivery.sms_latest_at,
                          sms_delivery.sms_error
                   FROM "TrialLead" tl
                   LEFT JOIN LATERAL (
                       SELECT action, note, "createdAt", "createdByName"
                       FROM "ApplicationContactLog" acl
                       WHERE acl."targetType" = 'TRIAL'
                         AND acl."trialLeadId" = tl.id
                       ORDER BY acl."createdAt" DESC
                       LIMIT 1
                   ) latest_log ON true
                   LEFT JOIN LATERAL (
                       SELECT "nextFollowUpAt", note
                       FROM "ApplicationContactLog" acl
                       WHERE acl."targetType" = 'TRIAL'
                         AND acl."trialLeadId" = tl.id
                         AND acl."nextFollowUpAt" IS NOT NULL
                         AND acl."followUpCompletedAt" IS NULL
                       ORDER BY acl."nextFollowUpAt" ASC
                       LIMIT 1
                   ) open_followup ON true
                   LEFT JOIN LATERAL (
                       SELECT
                           COUNT(*)::int AS sms_total,
                           COUNT(*) FILTER (WHERE latest.status = 'SENT')::int AS sms_sent,
                           COUNT(*) FILTER (WHERE latest.status = 'FAILED')::int AS sms_failed,
                           COUNT(*) FILTER (WHERE latest.status = 'PENDING')::int AS sms_pending,
                           MAX(latest."updatedAt") AS sms_latest_at,
                           MAX(latest."errorCode") FILTER (WHERE latest.status = 'FAILED') AS sms_error
                       FROM (
                           SELECT DISTINCT ON (
                               nd."recipientPhone",
                               nd."payloadJSON"->>'recipientRole',
                               nd."payloadJSON"->>'trigger'
                           )
                               nd.status,
                               nd."updatedAt",
                               nd."errorCode"
                           FROM "NotificationDelivery" nd
                           WHERE nd."eventType" = 'TRIAL_APPLICATION'
                             AND nd.channel = 'SMS'
                             AND nd."dedupeKey" LIKE ('sms:TRIAL_APPLICATION:' || tl.id || ':%')
                           ORDER BY
                               nd."recipientPhone",
                               nd."payloadJSON"->>'recipientRole',
                               nd."payloadJSON"->>'trigger',
                               nd."updatedAt" DESC
                       ) latest
                   ) sms_delivery ON true
                   ORDER BY tl."createdAt" DESC${limitClause}`
              );
        } catch (error) {
            if (!isMissingApplicationContactLogError(error)) throw error;
            rows = status
                ? await prisma.$queryRawUnsafe<any[]>(
                    `SELECT * FROM "TrialLead" WHERE status = $1 ORDER BY "createdAt" DESC${limitClause}`,
                    status,
                )
                : await prisma.$queryRawUnsafe<any[]>(
                    `SELECT * FROM "TrialLead" ORDER BY "createdAt" DESC${limitClause}`,
                );
        }

        return rows.map((r: any) => ({
            id: r.id,
            childName: r.childName ?? r.childname,
            childAge: r.childAge ?? r.childage ?? null,
            parentName: r.parentName ?? r.parentname,
            parentPhone: r.parentPhone ?? r.parentphone,
            source: r.source ?? "WEBSITE",
            status: r.status ?? "NEW",
            scheduledDate: r.scheduledDate ?? r.scheduleddate ?? null,
            scheduledClassId: r.scheduledClassId ?? r.scheduledclassid ?? null,
            attendedDate: r.attendedDate ?? r.attendeddate ?? null,
            postTrialConsultedAt: r.postTrialConsultedAt ?? r.posttrialconsultedat ?? null,
            enrollGuideSentAt: r.enrollGuideSentAt ?? r.enrollguidesentat ?? null,
            enrollApplicationReceivedAt: r.enrollApplicationReceivedAt ?? r.enrollapplicationreceivedat ?? null,
            enrollApplicationId: r.enrollApplicationId ?? r.enrollapplicationid ?? null,
            coachNoticeSentAt: r.coachNoticeSentAt ?? r.coachnoticesentat ?? null,
            coachNoticeSentTo: r.coachNoticeSentTo ?? r.coachnoticesentto ?? null,
            convertedDate: r.convertedDate ?? r.converteddate ?? null,
            convertedStudentId: r.convertedStudentId ?? r.convertedstudentid ?? null,
            lostReason: r.lostReason ?? r.lostreason ?? null,
            memo: r.memo ?? null,
            createdAt: r.createdAt ?? r.createdat,
            updatedAt: r.updatedAt ?? r.updatedat,
            // Phase A 추가 필드
            childBirthDate: r.childBirthDate ?? r.childbirthdate ?? null,
            childGrade: r.childGrade ?? r.childgrade ?? null,
            childGender: r.childGender ?? r.childgender ?? null,
            childSchool: r.childSchool ?? r.childschool ?? null,
            basketballExp: r.basketballExp ?? r.basketballexp ?? null,
            preferredSlotKey: r.preferredSlotKey ?? r.preferredslotkey ?? null,
            preferredDay: r.preferredDay ?? r.preferredday ?? null,
            preferredPeriod: r.preferredPeriod ?? r.preferredperiod ?? null,
            trialDate: r.trialDate ?? r.trialdate ?? null,
            trialFeeConfirmed: r.trialFeeConfirmed ?? r.trialfeeconfirmed ?? false,
            // 학부모 「비용·계좌 확인」 체크 시각 — 입금 확인과 별개(화면에서 「입금 대기(학부모 동의함)」)
            trialFeeNoticeAgreedAt: r.trialFeeNoticeAgreedAt ?? r.trialfeenoticeagreedat ?? null,
            hopeNote: r.hopeNote ?? r.hopenote ?? null,
            agreedTerms: r.agreedTerms ?? r.agreedterms ?? false,
            agreedPrivacy: r.agreedPrivacy ?? r.agreedprivacy ?? false,
            latestContactAction: r.latest_contact_action ?? null,
            latestContactNote: r.latest_contact_note ?? null,
            latestContactAt: r.latest_contact_at ?? null,
            latestContactBy: r.latest_contact_by ?? null,
            openFollowUpAt: r.open_followup_at ?? null,
            openFollowUpNote: r.open_followup_note ?? null,
            smsDeliveryTotal: Number(r.sms_total ?? 0),
            smsDeliverySent: Number(r.sms_sent ?? 0),
            smsDeliveryFailed: Number(r.sms_failed ?? 0),
            smsDeliveryPending: Number(r.sms_pending ?? 0),
            smsDeliveryLatestAt: r.sms_latest_at ?? null,
            smsDeliveryError: r.sms_error ?? null,
        }));
    } catch (e) {
        console.error("[getTrialLeads] failed:", e);
        return [];
    }
});

/**
 * 체험 CRM 파이프라인 통계 — 상태별 건수 + 전환율
 * - 각 상태(NEW, CONTACTED, SCHEDULED, ATTENDED, CONVERTED, LOST, CANCELLED)별 count
 * - 전환율: CONVERTED / (ATTENDED + CONVERTED) * 100 (체험 참석 대비 등록 비율)
 */
export const getTrialStats = cache(async () => {
    try {
        const rows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT status, COUNT(*)::int AS count FROM "TrialLead" GROUP BY status`
        );

        // 상태별 건수 맵 생성
        const statusMap: Record<string, number> = {};
        for (const r of rows) {
            statusMap[r.status] = r.count;
        }

        const attended = statusMap["ATTENDED"] ?? 0;
        const converted = statusMap["CONVERTED"] ?? 0;
        // 체험 참석 대비 전환율 (체험 참석 + 전환 완료 중 전환 비율)
        const conversionRate = (attended + converted) > 0
            ? Math.round((converted / (attended + converted)) * 100)
            : 0;

        return {
            NEW: statusMap["NEW"] ?? 0,
            CONTACTED: statusMap["CONTACTED"] ?? 0,
            SCHEDULED: statusMap["SCHEDULED"] ?? 0,
            ATTENDED: statusMap["ATTENDED"] ?? 0,
            CONVERTED: statusMap["CONVERTED"] ?? 0,
            LOST: statusMap["LOST"] ?? 0,
            CANCELLED: statusMap["CANCELLED"] ?? 0,
            total: rows.reduce((sum, r) => sum + r.count, 0),
            conversionRate,
        };
    } catch (e) {
        console.error("[getTrialStats] failed:", e);
        return {
            NEW: 0, CONTACTED: 0, SCHEDULED: 0, ATTENDED: 0, CONVERTED: 0, LOST: 0, CANCELLED: 0,
            total: 0, conversionRate: 0,
        };
    }
});

// ── 대기자(Waitlist) 조회 ────────────────────────────────────────────────────

/**
 * 전체 대기자 목록 — 학생명, 반명 JOIN + priority 순 정렬
 */
export const getWaitlistAll = cache(async () => {
    try {
        const rows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT w.id, w."studentId", w."classId", w.priority, w.status,
                    w."offeredAt", w."respondBy", w.memo,
                    w."createdAt", w."updatedAt",
                    s.name AS student_name,
                    c.name AS class_name, c."dayOfWeek" AS class_day,
                    c."startTime" AS class_start, c."endTime" AS class_end
             FROM "Waitlist" w
             LEFT JOIN "Student" s ON w."studentId" = s.id
             LEFT JOIN "Class" c ON w."classId" = c.id
             -- LEFT JOIN 이라 학생이 안 붙은 행은 살려 두고, 붙었는데 흡수된 경우만 제외한다.
             WHERE ${notMergedStudentOptional("s")}
             ORDER BY w."classId", w.priority ASC, w."createdAt" ASC`
        );
        return rows.map((r: any) => ({
            id: r.id,
            studentId: r.studentId ?? r.studentid,
            classId: r.classId ?? r.classid,
            priority: Number(r.priority ?? 0),
            status: r.status ?? "WAITING",
            offeredAt: r.offeredAt ?? r.offeredat ?? null,
            respondBy: r.respondBy ?? r.respondby ?? null,
            memo: r.memo ?? null,
            createdAt: r.createdAt ?? r.createdat,
            updatedAt: r.updatedAt ?? r.updatedat,
            studentName: r.student_name ?? "알 수 없음",
            className: r.class_name ?? "알 수 없음",
            classDay: r.class_day ?? r.class_day ?? "",
            classStart: r.class_start ?? "",
            classEnd: r.class_end ?? "",
        }));
    } catch (e) {
        console.error("[getWaitlistAll] failed:", e);
        return [];
    }
});

/**
 * 반별 정원/등록인원/잔여석/대기자수 현황
 * - enrolled: Enrollment status='ACTIVE' 건수
 * - waiting: Waitlist status='WAITING' 또는 'OFFERED' 건수
 */
export const getClassCapacityInfo = cache(async () => {
    try {
        const rows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT c.id, c.name, c."dayOfWeek", c."startTime", c."endTime",
                    c.capacity,
                    COUNT(DISTINCT CASE WHEN e.status = 'ACTIVE' THEN e.id END)::int AS enrolled,
                    COUNT(DISTINCT CASE WHEN wl.status IN ('WAITING','OFFERED') THEN wl.id END)::int AS waiting
             FROM "Class" c
             LEFT JOIN "Enrollment" e ON c.id = e."classId"
             LEFT JOIN "Waitlist" wl ON c.id = wl."classId"
             GROUP BY c.id, c.name, c."dayOfWeek", c."startTime", c."endTime", c.capacity
             ORDER BY c.name`
        );
        return rows.map((r: any) => ({
            id: r.id,
            name: r.name,
            dayOfWeek: r.dayOfWeek ?? r.dayofweek ?? "",
            startTime: r.startTime ?? r.starttime ?? "",
            endTime: r.endTime ?? r.endtime ?? "",
            capacity: Number(r.capacity ?? 0),
            enrolled: Number(r.enrolled ?? 0),
            remaining: Math.max(0, Number(r.capacity ?? 0) - Number(r.enrolled ?? 0)),
            waiting: Number(r.waiting ?? 0),
        }));
    } catch (e) {
        console.error("[getClassCapacityInfo] failed:", e);
        return [];
    }
});

// ── 보강(메이크업) 수업 조회 ─────────────────────────────────────────────────

/**
 * 보강 예약 목록 조회 — 학생명, 원래 반, 보강 반 정보를 JOIN
 * status 필터를 주면 해당 상태만, 안 주면 전체 반환
 */
export const getMakeupSessions = cache(async (status?: string) => {
    try {
        // 기본 쿼리: 학생/원래반/보강반 이름을 함께 조회
        const baseQuery = `
            SELECT ms.id, ms."studentId", ms."originalClassId", ms."originalDate",
                   ms."makeupClassId", ms."makeupDate", ms.status, ms."requestId",
                   ms."createdAt", ms."updatedAt",
                   s.name AS student_name,
                   oc.name AS original_class_name, oc."dayOfWeek" AS original_day,
                   mc.name AS makeup_class_name, mc."dayOfWeek" AS makeup_day,
                   mc."startTime" AS makeup_start, mc."endTime" AS makeup_end,
                   p.name AS program_name
            FROM "MakeupSession" ms
            LEFT JOIN "Student" s ON ms."studentId" = s.id
            LEFT JOIN "Class" oc ON ms."originalClassId" = oc.id
            LEFT JOIN "Class" mc ON ms."makeupClassId" = mc.id
            LEFT JOIN "Program" p ON mc."programId" = p.id
        `;
        // 상태 필터 분기
        const rows = status
            ? await prisma.$queryRawUnsafe<any[]>(
                  baseQuery + ` WHERE ms.status = $1 ORDER BY ms."createdAt" DESC`,
                  status,
              )
            : await prisma.$queryRawUnsafe<any[]>(
                  baseQuery + ` ORDER BY ms."createdAt" DESC`,
              );

        return rows.map((r: any) => ({
            id: r.id,
            studentId: r.studentId ?? r.studentid,
            originalClassId: r.originalClassId ?? r.originalclassid,
            originalDate: r.originalDate ?? r.originaldate,
            makeupClassId: r.makeupClassId ?? r.makeupclassid,
            makeupDate: r.makeupDate ?? r.makeupdate,
            status: r.status ?? "BOOKED",
            requestId: r.requestId ?? r.requestid ?? null,
            createdAt: r.createdAt ?? r.createdat,
            updatedAt: r.updatedAt ?? r.updatedat,
            studentName: r.student_name ?? "알 수 없음",
            originalClassName: r.original_class_name ?? "알 수 없음",
            originalDay: r.original_day ?? "",
            makeupClassName: r.makeup_class_name ?? "알 수 없음",
            makeupDay: r.makeup_day ?? "",
            makeupStart: r.makeup_start ?? "",
            makeupEnd: r.makeup_end ?? "",
            programName: r.program_name ?? "",
        }));
    } catch (e) {
        console.error("[getMakeupSessions] failed:", e);
        return [];
    }
});

/**
 * 보강 가능한 슬롯 조회 — 같은 프로그램의 다른 반에서 빈자리(정원 - 등록인원 - 예약된보강)가 있는 반 목록
 * excludeClassId: 원래 반은 제외 (같은 반에서 보강은 의미 없음)
 */
export const getAvailableMakeupSlots = cache(
    async (programId: string, excludeClassId: string) => {
        try {
            // 같은 프로그램의 다른 반에서 정원 여유가 있는 반 조회
            // enrolled: ACTIVE 상태 등록인원, bookedMakeups: BOOKED 상태 보강 예약 건수
            const rows = await prisma.$queryRawUnsafe<any[]>(
                `SELECT c.id, c.name, c."dayOfWeek", c."startTime", c."endTime", c.capacity,
                        COUNT(DISTINCT CASE WHEN e.status = 'ACTIVE' THEN e.id END)::int AS enrolled,
                        COUNT(DISTINCT CASE WHEN ms.status = 'BOOKED' THEN ms.id END)::int AS booked_makeups
                 FROM "Class" c
                 LEFT JOIN "Enrollment" e ON c.id = e."classId"
                 LEFT JOIN "MakeupSession" ms ON c.id = ms."makeupClassId" AND ms.status = 'BOOKED'
                 WHERE c."programId" = $1 AND c.id != $2
                 GROUP BY c.id, c.name, c."dayOfWeek", c."startTime", c."endTime", c.capacity
                 HAVING c.capacity > (COUNT(DISTINCT CASE WHEN e.status = 'ACTIVE' THEN e.id END)
                                    + COUNT(DISTINCT CASE WHEN ms.status = 'BOOKED' THEN ms.id END))
                 ORDER BY c.name`,
                programId,
                excludeClassId,
            );
            return rows.map((r: any) => ({
                id: r.id,
                name: r.name,
                dayOfWeek: r.dayOfWeek ?? r.dayofweek ?? "",
                startTime: r.startTime ?? r.starttime ?? "",
                endTime: r.endTime ?? r.endtime ?? "",
                capacity: Number(r.capacity ?? 0),
                enrolled: Number(r.enrolled ?? 0),
                bookedMakeups: Number(r.booked_makeups ?? 0),
                remaining: Math.max(
                    0,
                    Number(r.capacity ?? 0) - Number(r.enrolled ?? 0) - Number(r.booked_makeups ?? 0),
                ),
            }));
        } catch (e) {
            console.error("[getAvailableMakeupSlots] failed:", e);
            return [];
        }
    },
);

/**
 * 보강 반 + 특정 날짜의 잔여석 조회 (보강 예약 모달용)
 *
 * 잔여석 = 정원 − 그 반의 실제 수강 인원 − "그 날" 그 반에 이미 잡힌 활성 보강 수
 *  - 수강 인원 판정: 출결 화면(getAttendanceByDateAndClass)과 동일하게
 *    ACTIVE Enrollment + 통합(merge)된 학생 제외.
 *  - 활성 보강: status <> 'CANCELLED' (기존 중복 방지 로직과 동일 판정).
 * getAvailableMakeupSlots 와 달리 정원이 찬 반도 함께 반환한다 —
 * 화면에서 "정원 마감"으로 보여주고 선택만 막기 위함.
 */
export const getMakeupSlotAvailability = cache(
    async (programId: string, excludeClassId: string, makeupDate: string) => {
        try {
            // 1) 같은 프로그램의 다른 반 + 수강 인원
            const rows = await prisma.$queryRawUnsafe<any[]>(
                `SELECT c.id, c.name, c."dayOfWeek", c."startTime", c."endTime", c.capacity,
                        (SELECT COUNT(*)::int
                           FROM "Enrollment" e
                           JOIN "Student" s ON s.id = e."studentId" AND ${notMergedStudent("s")}
                          WHERE e."classId" = c.id AND e.status = 'ACTIVE') AS enrolled
                 FROM "Class" c
                 WHERE c."programId" = $1 AND c.id <> $2
                 ORDER BY c.name`,
                programId,
                excludeClassId,
            );

            // 2) 그 날 잡힌 활성 보강 수 (반별 집계)
            //    MakeupSession 테이블이 아직 없을 수 있어 별도 try — 없으면 보강 0건으로 본다.
            const bookedByClass = new Map<string, number>();
            try {
                const makeupRows = await prisma.$queryRawUnsafe<any[]>(
                    `SELECT ms."makeupClassId" AS "classId", COUNT(*)::int AS booked
                       FROM "MakeupSession" ms
                      WHERE ms."makeupDate"::date = $1::date AND ${activeMakeupSql("ms")}
                      GROUP BY ms."makeupClassId"`,
                    makeupDate,
                );
                makeupRows.forEach((r: any) => {
                    const classId = r.classId ?? r.classid;
                    if (classId) bookedByClass.set(classId, Number(r.booked ?? 0));
                });
            } catch (e) {
                console.warn("[getMakeupSlotAvailability] makeup count skipped:", (e as Error).message);
            }

            return rows.map((r: any) => {
                const usage = {
                    capacity: Number(r.capacity ?? 0),
                    enrolled: Number(r.enrolled ?? 0),
                    bookedMakeups: bookedByClass.get(r.id) ?? 0,
                };
                return {
                    id: r.id,
                    name: r.name,
                    dayOfWeek: r.dayOfWeek ?? r.dayofweek ?? "",
                    startTime: r.startTime ?? r.starttime ?? "",
                    endTime: r.endTime ?? r.endtime ?? "",
                    ...usage,
                    remaining: computeRemainingSeats(usage),
                };
            });
        } catch (e) {
            console.error("[getMakeupSlotAvailability] failed:", e);
            return [];
        }
    },
);

// ── 통계 대시보드용 집계 함수 ─────────────────────────────────────────────────

/**
 * 월별 매출 추이 — 최근 N개월간 PAID 상태 Payment 합산
 * getDashboardExtendedStats와 유사하지만 12개월까지 지원 + 전월 대비 변화율 포함
 */
export const getMonthlyRevenue = cache(async (months: number = 12) => {
    try {
        const now = new Date();
        // N개월 전 1일부터
        const startDate = new Date(now.getFullYear(), now.getMonth() - months + 1, 1);
        const startStr = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, "0")}-01`;
        // 다음 달 1일 (상한 경계)
        const endDate = new Date(now.getFullYear(), now.getMonth() + 1, 1);
        const endStr = `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, "0")}-01`;

        const rows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT TO_CHAR(DATE_TRUNC('month', "paidDate"), 'YYYY-MM') AS month,
                    COALESCE(SUM(amount), 0)::int AS total,
                    COUNT(*)::int AS count
             FROM "Payment"
             WHERE status = 'PAID'
               AND "paidDate" >= $1::timestamp
               AND "paidDate" < $2::timestamp
             GROUP BY DATE_TRUNC('month', "paidDate")
             ORDER BY DATE_TRUNC('month', "paidDate")`,
            startStr, endStr
        );

        // 월별 맵 생성
        const revenueMap = new Map<string, { total: number; count: number }>();
        for (const r of rows) {
            revenueMap.set(r.month, { total: Number(r.total ?? 0), count: Number(r.count ?? 0) });
        }

        // N개월 배열 구성 (과거→현재)
        const result: { month: string; label: string; amount: number; count: number }[] = [];
        for (let i = months - 1; i >= 0; i--) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
            const data = revenueMap.get(key);
            result.push({
                month: key,
                label: `${d.getMonth() + 1}월`,
                amount: data?.total ?? 0,
                count: data?.count ?? 0,
            });
        }

        return result;
    } catch (e) {
        console.error("[getMonthlyRevenue] failed:", e);
        return [];
    }
});

/**
 * 월별 출석률 추이 — 최근 N개월간 Attendance PRESENT 비율
 */
export const getMonthlyAttendanceRate = cache(async (months: number = 12) => {
    try {
        const now = new Date();
        const startDate = new Date(now.getFullYear(), now.getMonth() - months + 1, 1);
        const startStr = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, "0")}-01`;
        const endDate = new Date(now.getFullYear(), now.getMonth() + 1, 1);
        const endStr = `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, "0")}-01`;

        const rows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT TO_CHAR(DATE_TRUNC('month', se.date), 'YYYY-MM') AS month,
                    COUNT(*)::int AS total,
                    COUNT(CASE WHEN a.status = 'PRESENT' THEN 1 END)::int AS present
             FROM "Attendance" a
             JOIN "Session" se ON a."sessionId" = se.id
             WHERE se.date >= $1::timestamp
               AND se.date < $2::timestamp
             GROUP BY DATE_TRUNC('month', se.date)
             ORDER BY DATE_TRUNC('month', se.date)`,
            startStr, endStr
        );

        const attMap = new Map<string, { total: number; present: number }>();
        for (const r of rows) {
            attMap.set(r.month, { total: Number(r.total ?? 0), present: Number(r.present ?? 0) });
        }

        const result: { month: string; label: string; rate: number; total: number; present: number }[] = [];
        for (let i = months - 1; i >= 0; i--) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
            const data = attMap.get(key);
            const rate = data && data.total > 0 ? Math.round((data.present / data.total) * 100) : 0;
            result.push({
                month: key,
                label: `${d.getMonth() + 1}월`,
                rate,
                total: data?.total ?? 0,
                present: data?.present ?? 0,
            });
        }

        return result;
    } catch (e) {
        console.error("[getMonthlyAttendanceRate] failed:", e);
        return [];
    }
});

/**
 * 신규/퇴원 추이 — 최근 N개월간 Enrollment의 createdAt/updatedAt 기준
 * 신규: createdAt이 해당 월에 속하는 ACTIVE 등록
 * 퇴원: status가 DROPPED이고 updatedAt이 해당 월에 속하는 건
 */
export const getEnrollmentTrend = cache(async (months: number = 12) => {
    try {
        const now = new Date();
        const startDate = new Date(now.getFullYear(), now.getMonth() - months + 1, 1);
        const startStr = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, "0")}-01`;
        const endDate = new Date(now.getFullYear(), now.getMonth() + 1, 1);
        const endStr = `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, "0")}-01`;

        // 병렬로 신규 등록과 퇴원을 각각 조회
        const [newRows, dropRows] = await Promise.all([
            // 신규 등록: createdAt 기준 월별 집계
            prisma.$queryRawUnsafe<any[]>(
                `SELECT TO_CHAR(DATE_TRUNC('month', "createdAt"), 'YYYY-MM') AS month,
                        COUNT(*)::int AS count
                 FROM "Enrollment"
                 WHERE "createdAt" >= $1::timestamp
                   AND "createdAt" < $2::timestamp
                 GROUP BY DATE_TRUNC('month', "createdAt")
                 ORDER BY DATE_TRUNC('month', "createdAt")`,
                startStr, endStr
            ),
            // 퇴원: status='DROPPED'이고 updatedAt 기준 월별 집계
            prisma.$queryRawUnsafe<any[]>(
                `SELECT TO_CHAR(DATE_TRUNC('month', "updatedAt"), 'YYYY-MM') AS month,
                        COUNT(*)::int AS count
                 FROM "Enrollment"
                 WHERE status = 'DROPPED'
                   AND "updatedAt" >= $1::timestamp
                   AND "updatedAt" < $2::timestamp
                 GROUP BY DATE_TRUNC('month', "updatedAt")
                 ORDER BY DATE_TRUNC('month', "updatedAt")`,
                startStr, endStr
            ),
        ]);

        const newMap = new Map<string, number>();
        for (const r of newRows) newMap.set(r.month, Number(r.count ?? 0));

        const dropMap = new Map<string, number>();
        for (const r of dropRows) dropMap.set(r.month, Number(r.count ?? 0));

        const result: { month: string; label: string; newCount: number; dropCount: number }[] = [];
        for (let i = months - 1; i >= 0; i--) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
            result.push({
                month: key,
                label: `${d.getMonth() + 1}월`,
                newCount: newMap.get(key) ?? 0,
                dropCount: dropMap.get(key) ?? 0,
            });
        }

        return result;
    } catch (e) {
        console.error("[getEnrollmentTrend] failed:", e);
        return [];
    }
});

/**
 * 코치별 워크로드 — 코치별 담당 수업 수 + 담당 원생 수
 * ClassSlotOverride의 coachId 기준으로 수업 연결, Enrollment로 원생 수 집계
 */
export const getCoachWorkload = cache(async () => {
    try {
        const rows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT co.id, co.name, co."imageUrl",
                    COUNT(DISTINCT cso."slotKey")::int AS class_count,
                    COUNT(DISTINCT e."studentId")::int AS student_count
             FROM "Coach" co
             LEFT JOIN "ClassSlotOverride" cso ON cso."coachId" = co.id
             LEFT JOIN "Class" c ON c."slotKey" = cso."slotKey"
             LEFT JOIN "Enrollment" e ON e."classId" = c.id AND e.status = 'ACTIVE'
             GROUP BY co.id, co.name, co."imageUrl"
             ORDER BY co."order" ASC`
        );

        return rows.map((r: any) => ({
            id: r.id,
            name: r.name,
            imageUrl: r.imageUrl ?? r.imageurl ?? null,
            classCount: Number(r.class_count ?? 0),
            studentCount: Number(r.student_count ?? 0),
        }));
    } catch (e) {
        console.error("[getCoachWorkload] failed:", e);
        return [];
    }
});

/**
 * 수납률 — 특정 연월 기준 Payment 중 PAID 비율
 */
export const getPaymentCollectionRate = cache(async () => {
    try {
        const now = new Date();
        const year = now.getFullYear();
        const month = now.getMonth() + 1;
        const { startStr, endStr } = getMonthDateRange(year, month);

        const rows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT COUNT(*)::int AS total,
                    COUNT(CASE WHEN status = 'PAID' THEN 1 END)::int AS paid
             FROM "Payment"
             WHERE "dueDate" >= $1::timestamp AND "dueDate" < $2::timestamp`,
            startStr, endStr
        );

        const total = Number(rows[0]?.total ?? 0);
        const paid = Number(rows[0]?.paid ?? 0);
        const rate = total > 0 ? Math.round((paid / total) * 100) : 0;

        return { total, paid, unpaid: total - paid, rate };
    } catch (e) {
        console.error("[getPaymentCollectionRate] failed:", e);
        return { total: 0, paid: 0, unpaid: 0, rate: 0 };
    }
});

// ── 수강 신청서 관리 (Phase C) ─────────────────────────────────────────────────

/**
 * 수강 신청서 목록 조회 — 상태별 필터 지원
 * - status가 있으면 해당 상태만, 없으면 전체
 * - 최신순 정렬
 */
export const getEnrollApplications = cache(async (statusOrOptions?: string | AdminListQueryOptions) => {
    try {
        const options = normalizeAdminListQueryOptions(statusOrOptions);
        const status = options.status;
        const limitClause = adminListLimitClause(options);
        let rows: any[];
        try {
            rows = status
                ? await prisma.$queryRawUnsafe<any[]>(
                  `SELECT ea.*,
                          latest_log.action AS latest_contact_action,
                          latest_log.note AS latest_contact_note,
                          latest_log."createdAt" AS latest_contact_at,
                          latest_log."createdByName" AS latest_contact_by,
                          open_followup."nextFollowUpAt" AS open_followup_at,
                          open_followup.note AS open_followup_note
                   FROM "EnrollmentApplication" ea
                   LEFT JOIN LATERAL (
                       SELECT action, note, "createdAt", "createdByName"
                       FROM "ApplicationContactLog" acl
                       WHERE acl."targetType" = 'ENROLL'
                         AND acl."enrollmentApplicationId" = ea.id
                       ORDER BY acl."createdAt" DESC
                       LIMIT 1
                   ) latest_log ON true
                   LEFT JOIN LATERAL (
                       SELECT "nextFollowUpAt", note
                       FROM "ApplicationContactLog" acl
                       WHERE acl."targetType" = 'ENROLL'
                         AND acl."enrollmentApplicationId" = ea.id
                         AND acl."nextFollowUpAt" IS NOT NULL
                         AND acl."followUpCompletedAt" IS NULL
                       ORDER BY acl."nextFollowUpAt" ASC
                       LIMIT 1
                   ) open_followup ON true
                   WHERE ea.status = $1
                   ORDER BY ea."createdAt" DESC${limitClause}`,
                  status
              )
                : await prisma.$queryRawUnsafe<any[]>(
                  `SELECT ea.*,
                          latest_log.action AS latest_contact_action,
                          latest_log.note AS latest_contact_note,
                          latest_log."createdAt" AS latest_contact_at,
                          latest_log."createdByName" AS latest_contact_by,
                          open_followup."nextFollowUpAt" AS open_followup_at,
                          open_followup.note AS open_followup_note
                   FROM "EnrollmentApplication" ea
                   LEFT JOIN LATERAL (
                       SELECT action, note, "createdAt", "createdByName"
                       FROM "ApplicationContactLog" acl
                       WHERE acl."targetType" = 'ENROLL'
                         AND acl."enrollmentApplicationId" = ea.id
                       ORDER BY acl."createdAt" DESC
                       LIMIT 1
                   ) latest_log ON true
                   LEFT JOIN LATERAL (
                       SELECT "nextFollowUpAt", note
                       FROM "ApplicationContactLog" acl
                       WHERE acl."targetType" = 'ENROLL'
                         AND acl."enrollmentApplicationId" = ea.id
                         AND acl."nextFollowUpAt" IS NOT NULL
                         AND acl."followUpCompletedAt" IS NULL
                       ORDER BY acl."nextFollowUpAt" ASC
                       LIMIT 1
                   ) open_followup ON true
                   ORDER BY ea."createdAt" DESC${limitClause}`
              );
        } catch (error) {
            if (!isMissingApplicationContactLogError(error)) throw error;
            rows = status
                ? await prisma.$queryRawUnsafe<any[]>(
                    `SELECT * FROM "EnrollmentApplication" WHERE status = $1 ORDER BY "createdAt" DESC${limitClause}`,
                    status,
                )
                : await prisma.$queryRawUnsafe<any[]>(
                    `SELECT * FROM "EnrollmentApplication" ORDER BY "createdAt" DESC${limitClause}`,
                );
        }

        // camelCase 우선, 소문자 fallback (PgBouncer 반환 형식 대응)
        return rows.map((r: any) => ({
            id: r.id,
            trialLeadId: r.trialLeadId ?? r.trialleadid ?? null,
            childName: r.childName ?? r.childname,
            childBirthDate: r.childBirthDate ?? r.childbirthdate,
            childGender: r.childGender ?? r.childgender ?? null,
            childGrade: r.childGrade ?? r.childgrade ?? null,
            childSchool: r.childSchool ?? r.childschool ?? null,
            childPhone: r.childPhone ?? r.childphone ?? null,
            parentName: r.parentName ?? r.parentname,
            parentPhone: r.parentPhone ?? r.parentphone,
            parentRelation: r.parentRelation ?? r.parentrelation ?? null,
            address: r.address ?? null,
            enrollmentMonths: r.enrollmentMonths ?? r.enrollmentmonths ?? null,
            preferredSlotKeys: r.preferredSlotKeys ?? r.preferredslotkeys ?? null,
            assignedClassId: r.assignedClassId ?? r.assignedclassid ?? null,
            basketballExp: r.basketballExp ?? r.basketballexp ?? null,
            uniformSize: r.uniformSize ?? r.uniformsize ?? null,
            shuttleNeeded: r.shuttleNeeded ?? r.shuttleneeded ?? false,
            shuttlePickup: r.shuttlePickup ?? r.shuttlepickup ?? null,
            shuttleTime: r.shuttleTime ?? r.shuttletime ?? null,
            shuttleDropoff: r.shuttleDropoff ?? r.shuttledropoff ?? null,
            paymentMethod: r.paymentMethod ?? r.paymentmethod ?? null,
            referralSource: r.referralSource ?? r.referralsource ?? null,
            memo: r.memo ?? null,
            agreedTerms: r.agreedTerms ?? r.agreedterms ?? false,
            agreedPrivacy: r.agreedPrivacy ?? r.agreedprivacy ?? false,
            applicationNoticeConfirmed: r.applicationNoticeConfirmed ?? r.applicationnoticeconfirmed ?? false,
            shuttleNoticeConfirmed: r.shuttleNoticeConfirmed ?? r.shuttlenoticeconfirmed ?? false,
            status: r.status ?? "PENDING",
            processedAt: r.processedAt ?? r.processedat ?? null,
            processedNote: r.processedNote ?? r.processednote ?? null,
            convertedStudentId: r.convertedStudentId ?? r.convertedstudentid ?? null,
            createdAt: r.createdAt ?? r.createdat,
            updatedAt: r.updatedAt ?? r.updatedat,
            latestContactAction: r.latest_contact_action ?? null,
            latestContactNote: r.latest_contact_note ?? null,
            latestContactAt: r.latest_contact_at ?? null,
            latestContactBy: r.latest_contact_by ?? null,
            openFollowUpAt: r.open_followup_at ?? null,
            openFollowUpNote: r.open_followup_note ?? null,
        }));
    } catch (e) {
        console.error("[getEnrollApplications] failed:", e);
        return [];
    }
});

/**
 * 수강 신청서 통계 — 상태별 건수
 */
export const getEnrollApplicationStats = cache(async () => {
    try {
        const rows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT status, COUNT(*)::int AS count FROM "EnrollmentApplication" GROUP BY status`
        );

        const statusMap: Record<string, number> = {};
        for (const r of rows) {
            statusMap[r.status] = r.count;
        }

        return {
            PENDING: statusMap["PENDING"] ?? 0,
            APPROVED: statusMap["APPROVED"] ?? 0,
            REJECTED: statusMap["REJECTED"] ?? 0,
            CANCELLED: statusMap["CANCELLED"] ?? 0,
            total: rows.reduce((sum, r) => sum + r.count, 0),
        };
    } catch (e) {
        console.error("[getEnrollApplicationStats] failed:", e);
        return { PENDING: 0, APPROVED: 0, REJECTED: 0, CANCELLED: 0, total: 0 };
    }
});

// ── SMS 템플릿 조회 ─────────────────────────────────────────────────────────
import { ensureSmsTemplates } from "@/lib/smsTemplate";

// 전체 템플릿 목록 조회 (관리자 페이지용)
export const getSmsTemplates = cache(async () => {
    await ensureSmsTemplates();
    try {
        const rows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT id, trigger, name, target, body, "isActive", description, variables, "createdAt", "updatedAt"
             FROM "SmsTemplate"
             ORDER BY
                CASE target WHEN 'ADMIN' THEN 1 WHEN 'COACH' THEN 2 WHEN 'PARENT' THEN 3 END,
                trigger`
        );
        return rows.map((r: any) => ({
            id: r.id,
            trigger: r.trigger,
            name: r.name,
            target: r.target,
            body: r.body,
            isActive: r.isActive ?? r.isactive ?? true,
            description: r.description,
            variables: r.variables,
            createdAt: r.createdAt ?? r.createdat,
            updatedAt: r.updatedAt ?? r.updatedat,
        }));
    } catch (e) {
        console.error("[getSmsTemplates] failed:", e);
        return [];
    }
});

// 특정 트리거의 템플릿 1건 조회
export const getSmsTemplate = cache(async (trigger: string) => {
    await ensureSmsTemplates();
    try {
        const rows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT id, trigger, name, target, body, "isActive", description, variables
             FROM "SmsTemplate" WHERE trigger = $1 LIMIT 1`,
            trigger,
        );
        if (rows.length === 0) return null;
        const r = rows[0];
        return {
            id: r.id,
            trigger: r.trigger,
            name: r.name,
            target: r.target,
            body: r.body,
            isActive: r.isActive ?? r.isactive ?? true,
            description: r.description,
            variables: r.variables,
        };
    } catch (e) {
        console.error("[getSmsTemplate] failed:", e);
        return null;
    }
});

// ── 스태프 목록 조회 (ADMIN / VICE_ADMIN / INSTRUCTOR / DRIVER) ─────────────────────
// 스태프 관리 페이지에서 사용 — role이 PARENT가 아닌 유저 + Coach 연결 정보
export const getStaffUsers = cache(async () => {
    try {
        // User 테이블에서 ADMIN/VICE_ADMIN/INSTRUCTOR/DRIVER 조회 + Coach 연결 (LEFT JOIN)
        const rows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT u.id, u.email, u.name, u.phone, u.role::text AS role, u."createdAt",
                    c.id AS "coachId", c.name AS "coachName"
             FROM "User" u
             LEFT JOIN "Coach" c ON c."userId" = u.id
             WHERE u.role::text IN ('ADMIN', 'VICE_ADMIN', 'INSTRUCTOR', 'DRIVER')
             ORDER BY
               CASE u.role::text
                  WHEN 'ADMIN' THEN 1
                  WHEN 'VICE_ADMIN' THEN 2
                  WHEN 'INSTRUCTOR' THEN 3
                  WHEN 'DRIVER' THEN 4
                END,
               u."createdAt" ASC`
        );
        return rows.map((r: any) => ({
            id: r.id,
            email: r.email,
            name: r.name,
            phone: r.phone,
            role: r.role,
            createdAt: r.createdAt ?? r.createdat,
            coachId: r.coachId ?? r.coachid ?? null,
            coachName: r.coachName ?? r.coachname ?? null,
        }));
    } catch (e) {
        console.error("[getStaffUsers] failed:", e);
    }

    try {
        // 오래된 DB에서 Coach.userId 컬럼이 아직 없으면 연결 정보 없이 스태프만 표시한다.
        const rows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT u.id, u.email, u.name, u.phone, u.role::text AS role, u."createdAt"
             FROM "User" u
             WHERE u.role::text IN ('ADMIN', 'VICE_ADMIN', 'INSTRUCTOR', 'DRIVER')
             ORDER BY
               CASE u.role::text
                  WHEN 'ADMIN' THEN 1
                  WHEN 'VICE_ADMIN' THEN 2
                  WHEN 'INSTRUCTOR' THEN 3
                  WHEN 'DRIVER' THEN 4
                END,
               u."createdAt" ASC`
        );

        return rows.map((r: any) => ({
            id: r.id,
            email: r.email,
            name: r.name,
            phone: r.phone,
            role: r.role,
            createdAt: r.createdAt ?? r.createdat,
            coachId: null,
            coachName: null,
        }));
    } catch (fallbackError) {
        console.error("[getStaffUsers:fallback] failed:", fallbackError);
        return [];
    }
});

// ── 전체 코치 목록 (스태프 관리용 Coach 드롭다운) ─────────────────────────
export const getAllCoaches = cache(async () => {
    try {
        const rows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT id, name, role, phone, "userId"
             FROM "Coach"
             ORDER BY "order" ASC, name ASC`
        );
        return rows.map((r: any) => ({
            id: r.id,
            name: r.name,
            role: r.role,
            phone: r.phone ?? null,
            userId: r.userId ?? r.userid ?? null,
        }));
    } catch (e) {
        console.error("[getAllCoaches] failed:", e);
    }

    try {
        // 오래된 DB에서 Coach.userId 컬럼이 아직 없으면 연결 상태 없이 코치 목록만 표시한다.
        const rows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT id, name, role
             FROM "Coach"
             ORDER BY "order" ASC, name ASC`
        );

        return rows.map((r: any) => ({
            id: r.id,
            name: r.name,
            role: r.role,
            phone: null,
            userId: null,
        }));
    } catch (fallbackError) {
        console.error("[getAllCoaches:fallback] failed:", fallbackError);
        return [];
    }
});

// ── 스태프 초대 목록 조회 (관리자용) ─────────────────────────────────────────
// PENDING/ACCEPTED/CANCELLED 상태의 초대를 최신순으로 조회
export const getStaffInvitations = cache(async () => {
    try {
        const rows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT id, token, name, phone, role, status,
                    "expiresAt", "acceptedAt", "acceptedUserId",
                    "createdBy", "createdAt"
             FROM "StaffInvitation"
             ORDER BY "createdAt" DESC
             LIMIT 100`
        );
        return rows.map((r: any) => ({
            id: r.id,
            token: r.token,
            name: r.name,
            phone: r.phone,
            role: r.role,
            status: r.status,
            expiresAt: r.expiresAt ?? r.expiresat,
            acceptedAt: r.acceptedAt ?? r.acceptedat ?? null,
            acceptedUserId: r.acceptedUserId ?? r.accepteduserid ?? null,
            createdBy: r.createdBy ?? r.createdby,
            createdAt: r.createdAt ?? r.createdat,
        }));
    } catch (e) {
        console.error("[getStaffInvitations] failed:", e);
        return [];
    }
});

// ── 토큰으로 초대 조회 (공개 — 초대 수락 페이지용) ──────────────────────────
// PENDING 상태 + 만료 전인 초대만 유효하게 반환
export const getInvitationByToken = cache(async (token: string) => {
    try {
        const rows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT id, token, name, phone, role, status, "expiresAt", "createdAt"
             FROM "StaffInvitation"
             WHERE token = $1
             LIMIT 1`,
            token
        );
        if (rows.length === 0) return null;
        const r = rows[0];
        return {
            id: r.id,
            token: r.token,
            name: r.name,
            phone: r.phone,
            role: r.role,
            status: r.status,
            expiresAt: r.expiresAt ?? r.expiresat,
            createdAt: r.createdAt ?? r.createdat,
        };
    } catch (e) {
        console.error("[getInvitationByToken] failed:", e);
        return null;
    }
});
