"use server";

/**
 * 관리자 «원생 등록»(창 하나 3단계) 서버 액션 — 2026-11-09 원장 승인 설계(2차).
 *
 * ■ 왜 새로 만들었나
 *   예전 등록은 학생 한 줄만 만들어서 반·보호자·셔틀·동의를 각각 다른 화면에서 다시 넣어야 했고,
 *   새 학생은 수강이 0건이라 목록 기본 필터(활성)에 안 보여 «등록이 안 된다»고 느꼈다.
 *   이제 한 번의 저장 = 트랜잭션 하나로 학생·보호자·수강(개시일)·운영 동기화 이벤트·셔틀 위치·사진 동의를 함께 남긴다.
 *
 * ■ 기존 길과 같은 규칙을 쓴다(한 곳 원칙)
 *   - 학부모 계정 연결: parentAccountLink(1차) — 번호로 찾고, 기존 계정은 절대 UPDATE 하지 않는다.
 *   - 정원 경고: class-capacity — 신청서 승인과 같은 함수.
 *   - 셔틀 위치 저장: student-shuttle-location-upsert — 신청서 승인과 같은 SQL.
 *   - 수강 등록 이벤트: buildEnrollmentOperationsEvent + enqueueWebsiteOperationsEventInTransaction(승인과 같은 원장).
 *   - 입력 검증: student-register-rules — 창과 서버가 같은 함수를 부른다.
 *
 * ■ 하지 않는 것
 *   - 문자·알림톡 발송(승인 경로와 같은 원칙 — 외부 발송은 전용 화면에서만).
 *   - 셔틀 노선 배정(배차 화면 몫), 청구(월 장부 몫).
 */

import { revalidatePath, revalidateTag } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-guard";
import { todayKst } from "@/lib/datetime/kst";
import { notMergedStudent } from "@/lib/studentVisibility";
import { isUsablePhoneKey } from "@/lib/enrollment/parentIdentity";
import { normalizeGuardianPhone } from "@/lib/guardians/guardianLogic";
import { findOverCapacityClasses, type OverCapacityClass } from "@/lib/enrollment/class-capacity";
import { upsertStudentShuttleLocation } from "@/lib/students/student-shuttle-location-upsert";
import {
    decideParentAccount,
    insertPrimaryGuardian,
    linkParentAccountForNewStudent,
    ParentAccountLinkError,
    type PhoneAccountRow,
} from "@/lib/students/parentAccountLink";
import {
    branchFromClassLocations,
    buildAdminRegisterAgreements,
    decideUniformFromOrders,
    findDuplicateSuspects,
    normalizeRegisterClassIds,
    STUDENT_BIRTH_KST_YMD_SQL,
    UNIFORM_ORDER_SOURCE,
    uniformNameKey,
    validateStudentRegisterInput,
    type DuplicateCandidateRow,
    type DuplicateSuspect,
    type StudentRegisterInput,
    type UniformOrderSummary,
} from "@/lib/students/student-register-rules";
import { buildEnrollmentOperationsEvent } from "@/lib/operations-events/admin-hooks";
import { enqueueWebsiteOperationsEventInTransaction } from "@/lib/operations-events";
import { SHUTTLE_LOCATION_CONSENT_VERSION } from "@/lib/seasonal/contracts";
import { STUDENT_MEDIA_POLICY_VERSION } from "@/lib/studentMediaConsentAdmin";

// ── 등록 창이 처음 열릴 때 읽는 반·프로그램 ─────────────────────────────────

export type RegisterClassOption = {
    id: string;
    name: string;
    dayOfWeek: string;
    startTime: string;
    endTime: string;
    location: string | null;
    /** 시간표 슬롯(예: Sun-8) — 셔틀비 미리보기의 대표팀 면제 판정에 쓴다 */
    slotKey: string | null;
    capacity: number;
    /** 지금 ACTIVE 수강 인원(병합 제외) — 정원 경고와 같은 기준 */
    activeCount: number;
    /**
     * 대상 학년(예: 초3~초6) — 공개 시간표와 같은 출처를 차례로 본다:
     * 시간표 슬롯(ScheduleSlot.gradeRange) → 직접 만든 슬롯(CustomClassSlot.gradeRange) → 프로그램 대상(Program.targetAge). 모두 비면 null
     */
    gradeRange: string | null;
    programId: string;
    programName: string;
};

export type RegisterProgramOption = {
    id: string;
    name: string;
    days: string | null;
    /** 주1회 요금(청구 모듈 weeklyTierPrice 가 주1회에 쓰는 값) */
    price: number;
    priceWeek1: number | null;
    priceWeek2: number | null;
    priceWeek3: number | null;
    priceDaily: number | null;
    shuttleFeeOverride: number | null;
    runsShuttle: boolean;
};

export type StudentRegisterOptions = {
    classes: RegisterClassOption[];
    programs: RegisterProgramOption[];
    /** 오늘(KST) — 수강 시작일 기본값 */
    today: string;
};

/** 등록 창의 반 선택지(정규·미삭제 프로그램만 — 저장 때 검사와 같은 조건) */
export async function getStudentRegisterOptions(): Promise<StudentRegisterOptions> {
    await requireAdmin();
    const classes = await prisma.$queryRawUnsafe<RegisterClassOption[]>(
        `SELECT c.id, c.name, c."dayOfWeek", c."startTime", c."endTime", c.location, c."slotKey", c.capacity,
                (SELECT COUNT(*) FROM "Enrollment" e JOIN "Student" s ON s.id = e."studentId"
                  WHERE e."classId" = c.id AND e.status = 'ACTIVE' AND ${notMergedStudent("s")})::int AS "activeCount",
                -- 대상 학년: 슬롯 → 직접 만든 슬롯 → 프로그램 순(빈 글자는 없는 것으로). 하위 질의라 반 줄이 늘지 않는다
                COALESCE(
                    (SELECT NULLIF(btrim(ss."gradeRange"), '') FROM "ScheduleSlot" ss WHERE ss."slotKey" = c."slotKey" LIMIT 1),
                    (SELECT NULLIF(btrim(cs."gradeRange"), '') FROM "CustomClassSlot" cs
                      WHERE cs.id = c."slotKey" OR ('custom-' || cs.id) = c."slotKey" LIMIT 1),
                    NULLIF(btrim(p."targetAge"), '')
                ) AS "gradeRange",
                p.id AS "programId", p.name AS "programName"
           FROM "Class" c JOIN "Program" p ON p.id = c."programId"
          WHERE c."dayOfWeek" <> 'Seasonal' AND p."deletedAt" IS NULL
          ORDER BY c."startTime", c.name`,
    );
    const programs = await prisma.$queryRawUnsafe<RegisterProgramOption[]>(
        `SELECT id, name, days, price, "priceWeek1", "priceWeek2", "priceWeek3", "priceDaily",
                "shuttleFeeOverride", "runsShuttle"
           FROM "Program" WHERE "deletedAt" IS NULL ORDER BY "order", name`,
    );
    return { classes, programs, today: todayKst() };
}

type DbReader = { $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T> };

// ── 1단계 미리보기: 학부모 계정 후보 + 중복 의심 학생 (읽기 전용) ───────────

export type ParentAccountPreview =
    | { kind: "NO_PHONE" }
    | { kind: "CREATE_NEW" }
    | { kind: "AMBIGUOUS"; accountCount: number }
    | { kind: "USE_EXISTING"; staffAccount: boolean; accountName: string | null; loginLinked: boolean; children: string[] };

export type StudentRegisterPreview = {
    account: ParentAccountPreview;
    duplicates: DuplicateSuspect[];
    /** 같은 보호자 번호·학생 이름의 유니폼 주문 내역(없으면 null) — 3단계 요약에 표시만, 저장 때 서버가 다시 읽는다 */
    uniform: UniformOrderSummary | null;
};

/**
 * 같은 보호자 번호(입력한 보호자 휴대폰 중 하나) + 같은 학생 이름(띄어쓰기 무시) 품목이 있는 유니폼 주문.
 * 유니폼 신청서는 학생 id 없이 «보호자 번호 + 학생 이름»만 남기므로 이 둘로 맞춘다. 읽기만 한다.
 */
async function readUniformOrderSummary(db: DbReader, studentName: string, phones: string[]): Promise<UniformOrderSummary | null> {
    const nameKey = uniformNameKey(studentName);
    const phoneKeys = [...new Set(phones.map((p) => normalizeGuardianPhone(p)).filter(isUsablePhoneKey))];
    if (!nameKey || phoneKeys.length === 0) return null;
    const rows = await db.$queryRawUnsafe<Array<{
        orderStatus: string; stizSyncStatus: string; stizOrderNumber: string | null; createdAt: Date; lastSentAt: Date | null;
    }>>(
        `SELECT o."orderStatus", o."stizSyncStatus", o."stizOrderNumber", o."createdAt", o."lastSentAt"
           FROM "UniformOrder" o
          WHERE o."parentPhoneDigits" = ANY($1::text[])
            AND EXISTS (SELECT 1 FROM "UniformOrderItem" i
                         WHERE i."uniformOrderId" = o.id AND regexp_replace(i."studentName", '\\s', '', 'g') = $2)
          ORDER BY o."createdAt"
          LIMIT 50`,
        phoneKeys, nameKey,
    );
    // createdAt·lastSentAt 은 timestamptz 라 Date 로 온다 → 순간(ISO) 그대로 넘긴다(달력 날짜로 자르지 않는다)
    return decideUniformFromOrders(rows.map((r) => ({
        orderStatus: r.orderStatus,
        stizSyncStatus: r.stizSyncStatus,
        stizOrderNumber: r.stizOrderNumber,
        createdAt: new Date(r.createdAt).toISOString(),
        lastSentAt: r.lastSentAt ? new Date(r.lastSentAt).toISOString() : null,
    })));
}

/** 같은 이름 학생 후보(병합 제외) + 그 학생의 보호자 번호들 + 지금 수강 중인 반 이름. db = prisma 또는 트랜잭션 tx */
async function readDuplicateCandidates(db: DbReader, name: string): Promise<DuplicateCandidateRow[]> {
    // 생년은 KST 달력 날짜로 꺼낸다(STUDENT_BIRTH_KST_YMD_SQL — 무tz 컬럼이라 «두 번» 건다).
    // 운영엔 자정 행과 «한국 자정을 UTC 로 넣은 전날 15:00» 행이 섞여 있어, 날짜만 자르면 15:00 행이 하루 앞당겨진다.
    return db.$queryRawUnsafe<DuplicateCandidateRow[]>(
        `SELECT s.id, s.name, ${STUDENT_BIRTH_KST_YMD_SQL("s")} AS "birthDate",
                ARRAY_REMOVE(
                    ARRAY[regexp_replace(COALESCE(u.phone, ''), '[^0-9]', '', 'g')]
                    || COALESCE((SELECT array_agg(regexp_replace(COALESCE(g.phone, ''), '[^0-9]', '', 'g'))
                                   FROM "Guardian" g WHERE g."studentId" = s.id), '{}'::text[]),
                    '') AS "phoneDigits",
                COALESCE((SELECT array_agg(c.name ORDER BY c.name) FROM "Enrollment" e JOIN "Class" c ON c.id = e."classId"
                           WHERE e."studentId" = s.id AND e.status = 'ACTIVE'), '{}'::text[]) AS "classNames"
           FROM "Student" s JOIN "User" u ON u.id = s."parentId"
          WHERE ${notMergedStudent("s")} AND btrim(s.name) = $1
          ORDER BY s."createdAt" DESC
          LIMIT 20`,
        name,
    );
}

/**
 * 1단계 «다음»을 누를 때 — 이 번호로 어느 계정에 붙는지, 이미 있는 학생일 수 있는지 미리 보여 준다.
 * 계정 판정은 저장 때와 같은 decideParentAccount. 아무것도 쓰지 않는다.
 */
export async function previewStudentRegistration(input: {
    name: string;
    birthDate: string;
    primaryPhone: string;
    guardianPhones?: string[];
}): Promise<StudentRegisterPreview> {
    await requireAdmin();
    const name = String(input?.name ?? "").trim();
    const digits = normalizeGuardianPhone(input?.primaryPhone);

    let account: ParentAccountPreview = { kind: "NO_PHONE" };
    if (isUsablePhoneKey(digits)) {
        const rows = await prisma.$queryRawUnsafe<Array<PhoneAccountRow & { name: string | null; linked: boolean }>>(
            `SELECT id, role::text AS role, name, ("authUserId" IS NOT NULL) AS linked FROM "User"
              WHERE regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = $1 AND "withdrawnAt" IS NULL
              ORDER BY id`,
            digits,
        );
        const decision = decideParentAccount(rows);
        if (decision.kind === "CREATE_NEW") account = { kind: "CREATE_NEW" };
        else if (decision.kind === "AMBIGUOUS") account = { kind: "AMBIGUOUS", accountCount: decision.accountCount };
        else {
            const row = rows.find((r) => r.id === decision.parentId);
            const children = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
                `SELECT s.name FROM "Student" s WHERE s."parentId" = $1 AND ${notMergedStudent("s")} ORDER BY s.name LIMIT 10`,
                decision.parentId,
            );
            account = {
                kind: "USE_EXISTING",
                staffAccount: decision.staffAccount,
                accountName: row?.name ?? null,
                loginLinked: Boolean(row?.linked),
                children: children.map((c) => c.name),
            };
        }
    }

    const duplicates = name
        ? findDuplicateSuspects(await readDuplicateCandidates(prisma, name), {
            name,
            birthDate: String(input?.birthDate ?? ""),
            guardianPhones: [digits, ...(input?.guardianPhones ?? [])],
        })
        : [];
    const uniform = name ? await readUniformOrderSummary(prisma, name, [digits, ...(input?.guardianPhones ?? [])]) : null;
    return { account, duplicates, uniform };
}

// ── 저장 ─────────────────────────────────────────────────────────────────────

export type RegisterStudentResult =
    | { ok: true; studentId: string; parentAccountCreated: boolean; staffAccount: boolean; classCount: number }
    | { ok: false; code: "INVALID"; error: string; step?: 1 | 2 | 3 }
    | { ok: false; code: "CAPACITY_WARNING"; error: string; classes: OverCapacityClass[] }
    | { ok: false; code: "DUPLICATE_SUSPECT"; error: string; duplicates: DuplicateSuspect[] };

/** 트랜잭션 안에서 «안내 문구로 멈춤» — 롤백되고 ok:false 로 돌려준다(운영 빌드는 던진 오류 문구를 화면에 안 보낸다) */
class RegisterAbort extends Error {}
/** 트랜잭션 안 중복 재확인에 걸림 — 롤백 후 DUPLICATE_SUSPECT 로 돌려준다 */
class RegisterDuplicate extends RegisterAbort {
    constructor(readonly duplicates: DuplicateSuspect[]) {
        super("방금 같은 학생이 등록된 것 같습니다. 확인 후 새로 등록할지 골라 주세요.");
    }
}

/** 등록 대상 정규반(정규·미삭제 프로그램)만 — 신청서 승인과 같은 조건 */
const REGULAR_CLASS_SQL = `SELECT c.id, c.name, c.location FROM "Class" c JOIN "Program" p ON p.id=c."programId"
          WHERE c.id = ANY($1::text[]) AND c."dayOfWeek" <> 'Seasonal' AND p."deletedAt" IS NULL`;

function revalidateAfterRegister(withTrial: boolean) {
    revalidatePath("/admin/students");
    revalidatePath("/admin/classes");
    revalidatePath("/admin");
    // admin.ts 의 revalidateStudentAdminCaches 와 같은 태그
    for (const tag of ["admin-students", "admin-student-options", "admin-waitlist", "admin-makeup", "admin-dashboard", "admin-finance", "admin-stats", "admin-classes"]) {
        revalidateTag(tag, { expire: 0 });
    }
    if (withTrial) {
        revalidatePath("/admin/trial");
        revalidatePath("/admin/apply");
        revalidateTag("admin-trial", { expire: 0 });
    }
}

/**
 * 원생 등록 — 저장 한 번 = 트랜잭션 하나.
 * 정원 초과(force 없음)·중복 의심(allowDuplicate 없음)은 아무것도 쓰지 않고 경고만 돌려준다 → 창이 재확인 후 다시 부른다.
 */
export async function registerStudent(input: StudentRegisterInput): Promise<RegisterStudentResult> {
    const admin = await requireAdmin();
    const today = todayKst();
    const checked = validateStudentRegisterInput(input, today);
    if (!checked.ok) return { ok: false, code: "INVALID", error: checked.error, step: checked.step };
    const data = checked.value;
    const classIds = normalizeRegisterClassIds(data.classIds);
    // 중복 판정 대상 — 트랜잭션 전 확인과 트랜잭션 안 재확인이 같은 값을 쓴다
    const duplicateTarget = {
        name: data.student.name,
        birthDate: data.student.birthDate,
        guardianPhones: [data.primaryGuardian.phone, ...data.extraGuardians.map((g) => g.phone)],
    };

    // 1) 반 유효성 — 정규·미삭제 프로그램 반만(트랜잭션 전에 읽기만)
    if (classIds.length > 0) {
        const valid = await prisma.$queryRawUnsafe<Array<{ id: string }>>(REGULAR_CLASS_SQL, classIds);
        if (valid.length !== classIds.length) {
            return { ok: false, code: "INVALID", step: 2, error: "현재 개설된 정규 수업만 고를 수 있습니다. 반을 다시 골라 주세요." };
        }
    }
    // 2) 정원 소프트 경고 — 신청서 승인과 같은 함수, 읽기만
    if (!data.force && classIds.length > 0) {
        const over = await findOverCapacityClasses(prisma, classIds);
        if (over.length > 0) {
            return { ok: false, code: "CAPACITY_WARNING", classes: over, error: "정원이 찬 반이 있습니다. 그래도 등록할지 확인해 주세요." };
        }
    }
    // 3) 중복 의심 — 서버에서 한 번 더(창의 미리보기와 같은 판정)
    if (!data.allowDuplicate) {
        const duplicates = findDuplicateSuspects(await readDuplicateCandidates(prisma, data.student.name), duplicateTarget);
        if (duplicates.length > 0) {
            return { ok: false, code: "DUPLICATE_SUSPECT", duplicates, error: "이미 있는 학생일 수 있습니다. 확인 후 새로 등록할지 골라 주세요." };
        }
    }

    try {
        const saved = await prisma.$transaction(async (tx) => {
            // (a) 저장 직전에 반·프로그램을 잠가, 미리 읽은 뒤 폐강된 반을 막는다(승인 경로와 같음)
            const locked = classIds.length > 0
                ? await tx.$queryRawUnsafe<Array<{ id: string; name: string; location: string | null }>>(
                    `${REGULAR_CLASS_SQL} FOR SHARE OF c, p`, classIds,
                )
                : [];
            if (locked.length !== classIds.length) throw new RegisterAbort("고른 반이 바뀌었습니다. 반을 다시 골라 주세요.");

            // (b) 체험 → 원생 전환이면 체험 기록을 잠그고, 이미 전환된 체험이면 멈춘다
            if (data.trialLeadId) {
                const leads = await tx.$queryRawUnsafe<Array<{ id: string; convertedStudentId: string | null }>>(
                    `SELECT id, "convertedStudentId" FROM "TrialLead" WHERE id = $1 FOR UPDATE`, data.trialLeadId,
                );
                if (!leads[0]) throw new RegisterAbort("체험 기록을 찾을 수 없습니다. 체험 목록을 새로 고친 뒤 다시 시도해 주세요.");
                if (leads[0].convertedStudentId) throw new RegisterAbort("이미 원생으로 등록된 체험입니다. 원생 목록에서 확인해 주세요.");
            }

            // (c) 학부모 계정 확정 — 기존 계정은 읽기만(이름·번호·이메일 UPDATE 없음)
            const link = await linkParentAccountForNewStudent(tx, data.primaryGuardian);

            // (c-2) 번호 잠금을 잡은 직후 중복을 한 번 더 — 같은 학생을 두 화면에서 동시에 등록하면 위의 사전 확인은
            //       둘 다 통과한다. 같은 주 보호자 번호는 이 잠금으로 줄을 서므로, 뒤에 온 쪽이 여기서 먼저 온 학생을 본다.
            if (!data.allowDuplicate) {
                const again = findDuplicateSuspects(await readDuplicateCandidates(tx, data.student.name), duplicateTarget);
                if (again.length > 0) throw new RegisterDuplicate(again);
            }

            // (d) 학생 — 지점은 반 장소에서 자동, 모르면 직접 고른 값(원장 결정 s-branch)
            const branch = branchFromClassLocations(locked.map((c) => c.location)) ?? data.branch;
            const agreements = buildAdminRegisterAgreements(admin.appUserId, new Date().toISOString(), today);
            // 유니폼 — 창에서 고르지 않고, 같은 보호자 번호·학생 이름의 기존 주문 내역으로 채운다(없으면 비워 둔다).
            // 시각 칸은 학생 상세 «유니폼» 저장(updateStudentUniform)과 같은 «ISO → ::timestamptz» 방식
            const uniform = await readUniformOrderSummary(tx, data.student.name, duplicateTarget.guardianPhones);
            const [student] = await tx.$queryRawUnsafe<Array<{ id: string }>>(
                `INSERT INTO "Student" (id, name, "birthDate", gender, grade, school, phone, address, "referralSource",
                        "parentId", "enrollDate", memo, "uniformStatus", "uniformAppliedAt", "uniformOrderedAt", "uniformSource",
                        branch, "agreementsJSON", "createdAt", "updatedAt")
                 VALUES (gen_random_uuid()::text, $1, $2::timestamp, $3, $4, $5, $6, $7, $8,
                        $9, $10::date, $11, $12, $15::timestamptz, $16::timestamptz, $17, $13, $14, NOW(), NOW())
                 RETURNING id`,
                data.student.name, data.student.birthDate, data.student.gender, data.student.grade, data.student.school,
                data.student.phone, data.student.address, data.student.referralSource,
                link.parentId, data.startOn, data.memo, uniform?.status ?? null, branch, agreements,
                uniform?.appliedAt ?? null, uniform?.orderedAt ?? null, uniform ? UNIFORM_ORDER_SOURCE : null,
            );
            const studentId = student.id;

            // (e) 보호자 — 주 보호자 1명(isPrimary) + 보조 보호자
            await insertPrimaryGuardian(tx, studentId, data.primaryGuardian);
            for (const guardian of data.extraGuardians) {
                await tx.$executeRawUnsafe(
                    `INSERT INTO "Guardian" (id, "studentId", relation, name, phone, "isPrimary", "createdAt", "updatedAt")
                     VALUES (gen_random_uuid()::text, $1, $2, $3, $4, false, NOW(), NOW())`,
                    studentId, guardian.relation, guardian.name, guardian.phone,
                );
            }

            // (f) 수강 — 개시일(startsOn) + 운영 동기화 원장(홈페이지·시트·랠리즈)을 같은 트랜잭션에
            for (const cls of locked) {
                const [enrollment] = await tx.$queryRawUnsafe<Array<{ id: string; updatedAt: Date }>>(
                    `INSERT INTO "Enrollment" (id, "studentId", "classId", status, "startsOn", "createdAt", "updatedAt")
                     VALUES (gen_random_uuid()::text, $1, $2, 'ACTIVE', $3::date, NOW(), NOW())
                     RETURNING id, "updatedAt"`,
                    studentId, cls.id, data.startOn,
                );
                const event = buildEnrollmentOperationsEvent({
                    enrollmentId: enrollment.id,
                    changedAt: enrollment.updatedAt,
                    actorUserId: admin.appUserId,
                    studentId,
                    studentName: data.student.name,
                    classId: cls.id,
                    className: cls.name,
                    previousStatus: null,
                    nextStatus: "ACTIVE",
                    effectiveDate: data.startOn,
                });
                if (event) await enqueueWebsiteOperationsEventInTransaction(tx, event);
            }

            // (g) 셔틀 탑승·하차 위치(지도에서 고른 것만) — 신청서 승인과 같은 저장 SQL
            const confirmedAt = new Date().toISOString();
            for (const [kind, location] of [["PICKUP", data.shuttle.pickup], ["DROPOFF", data.shuttle.dropoff]] as const) {
                if (!location) continue;
                await upsertStudentShuttleLocation(tx, {
                    studentId, kind,
                    name: location.name,
                    address: location.address,
                    roadAddress: location.roadAddress,
                    latitude: location.latitude,
                    longitude: location.longitude,
                    placeId: location.placeId,
                    source: location.source,
                    accuracyMeters: location.accuracyMeters,
                    confirmedAt,
                    consentVersion: SHUTTLE_LOCATION_CONSENT_VERSION,
                });
            }

            // (h) 사진·초상권 동의(확인했을 때만) — 사진 동의 화면과 같은 이력 행
            if (data.mediaConsent) {
                await tx.$executeRawUnsafe(
                    `INSERT INTO "StudentMediaConsent" (
                        id, "studentId", "guardianUserId", "internalAllowed", "galleryAllowed", "instagramAllowed",
                        "policyVersion", "evidenceJSON", "recordedByUserId", "recordedAt", "revokedAt"
                     ) VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, $8, NOW(), NULL)`,
                    studentId, link.parentId,
                    data.mediaConsent.internalAllowed, data.mediaConsent.galleryAllowed, data.mediaConsent.instagramAllowed,
                    STUDENT_MEDIA_POLICY_VERSION,
                    JSON.stringify({ method: data.mediaConsent.method, guardianName: data.primaryGuardian.name, note: "원생 등록 때 확인" }),
                    admin.appUserId,
                );
            }

            // (i) 체험 → 등록전환(최초 전환일은 보존)
            if (data.trialLeadId) {
                await tx.$executeRawUnsafe(
                    `UPDATE "TrialLead"
                        SET status = 'CONVERTED', "convertedDate" = COALESCE("convertedDate", NOW()),
                            "convertedStudentId" = $1, "updatedAt" = NOW()
                      WHERE id = $2`,
                    studentId, data.trialLeadId,
                );
            }

            return { studentId, parentAccountCreated: link.created, staffAccount: link.staffAccount };
        }, { timeout: 15_000 });

        revalidateAfterRegister(Boolean(data.trialLeadId));
        return { ok: true, ...saved, classCount: classIds.length };
    } catch (e) {
        if (e instanceof RegisterDuplicate) {
            return { ok: false, code: "DUPLICATE_SUSPECT", duplicates: e.duplicates, error: e.message };
        }
        if (e instanceof ParentAccountLinkError || e instanceof RegisterAbort) {
            return { ok: false, code: "INVALID", error: e.message };
        }
        console.error("Failed to register student:", e);
        return { ok: false, code: "INVALID", error: "원생을 등록하지 못했습니다. 잠시 후 다시 시도해 주세요." };
    }
}
