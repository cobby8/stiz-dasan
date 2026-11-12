import { requireStaff, type StaffAuthUser } from "@/lib/auth-guard";
import { prisma } from "@/lib/prisma";

type CoachLinkRow = {
  coachId: string;
};

type ClassAccessRow = {
  id: string;
};

type StudentAccessRow = {
  id: string;
};

export type StaffSeasonalAccessRow = {
  sessionDateId: string;
  offeringId: string;
  linkedClassId: string;
  title: string;
};

export type StaffClassAccessContext = {
  staff: StaffAuthUser;
  coachId: string | null;
  canAccessAllClasses: boolean;
};

/**
 * 로그인한 직원이 어떤 수업에 접근할 수 있는지 판단할 때 사용하는 공통 정보입니다.
 * 관리자와 부관리자는 모든 수업에 접근하고, 선생님은 연결된 Coach 기준으로 제한됩니다.
 */
export async function getStaffClassAccessContext(): Promise<StaffClassAccessContext> {
  const staff = await requireStaff();
  const canAccessAllClasses =
    staff.appUserRole === "ADMIN" || staff.appUserRole === "VICE_ADMIN";

  if (canAccessAllClasses) {
    return { staff, coachId: null, canAccessAllClasses: true };
  }

  const rows = await prisma.$queryRawUnsafe<CoachLinkRow[]>(
    `SELECT id AS "coachId"
     FROM "Coach"
     WHERE "userId" = $1
     LIMIT 1`,
    staff.appUserId,
  );

  return {
    staff,
    coachId: rows[0]?.coachId ?? null,
    canAccessAllClasses: false,
  };
}

/**
 * 현재 직원이 볼 수 있는 수업 ID 목록을 반환합니다.
 * 시간표 수업은 Coach 배정을 기준으로 하고, 예전 수동 수업만 instructorId를 보조로 사용합니다.
 */
export async function getAccessibleClassIds(
  context?: StaffClassAccessContext,
): Promise<string[]> {
  const access = context ?? (await getStaffClassAccessContext());

  if (access.canAccessAllClasses) {
    const rows = await prisma.$queryRawUnsafe<ClassAccessRow[]>(
      `SELECT id FROM "Class" ORDER BY id`,
    );
    return rows.map((row) => row.id);
  }

  if (!access.coachId) return [];

  const rows = await prisma.$queryRawUnsafe<ClassAccessRow[]>(
    `SELECT DISTINCT c.id
     FROM "Class" c
     LEFT JOIN "ScheduleSlot" ss ON ss."slotKey" = c."slotKey"
     LEFT JOIN "ClassSlotOverride" cso ON cso."slotKey" = c."slotKey"
     LEFT JOIN "CustomClassSlot" ccs ON ccs.id = c."slotKey"
     WHERE (
       c."slotKey" IS NOT NULL
       AND (
         ss."coachId" = $1
         OR cso."coachId" = $1
         OR ccs."coachId" = $1
       )
     )
     OR (
       c."slotKey" IS NULL
       AND c."instructorId" = $2
     )
     ORDER BY c.id`,
    access.coachId,
    access.staff.appUserId,
  );

  return rows.map((row) => row.id);
}

/**
 * 특정 수업에 접근할 권한이 없으면 즉시 중단합니다.
 * 화면에서 메뉴를 숨기는 것과 별개로 서버에서도 반드시 이 검사를 사용해야 합니다.
 */
export async function requireStaffClassAccess(
  classId: string,
  context?: StaffClassAccessContext,
): Promise<StaffClassAccessContext> {
  if (!classId) throw new Error("수업 정보가 필요합니다.");

  const access = context ?? (await getStaffClassAccessContext());
  if (access.canAccessAllClasses) return access;

  if (!access.coachId) {
    throw new Error("선생님 계정에 연결된 코치 정보가 없습니다.");
  }

  const rows = await prisma.$queryRawUnsafe<ClassAccessRow[]>(
    `SELECT c.id
     FROM "Class" c
     LEFT JOIN "ScheduleSlot" ss ON ss."slotKey" = c."slotKey"
     LEFT JOIN "ClassSlotOverride" cso ON cso."slotKey" = c."slotKey"
     LEFT JOIN "CustomClassSlot" ccs ON ccs.id = c."slotKey"
     WHERE c.id = $1
       AND (
         (
           c."slotKey" IS NOT NULL
           AND (
             ss."coachId" = $2
             OR cso."coachId" = $2
             OR ccs."coachId" = $2
           )
         )
         OR (
           c."slotKey" IS NULL
           AND c."instructorId" = $3
         )
       )
     LIMIT 1`,
    classId,
    access.coachId,
    access.staff.appUserId,
  );

  if (!rows[0]) {
    throw new Error("담당 수업에만 접근할 수 있습니다.");
  }

  return access;
}

/** 특강 회차는 정규반 배정이 아니라 특강 상품에 지정된 담당 강사를 기준으로 확인합니다. */
export async function requireStaffSeasonalSessionAccess(
  sessionDateId: string,
  context?: StaffClassAccessContext,
): Promise<{ access: StaffClassAccessContext; seasonal: StaffSeasonalAccessRow }> {
  if (!sessionDateId) throw new Error("특강 회차 정보가 필요합니다.");

  const access = context ?? (await getStaffClassAccessContext());
  const rows = await prisma.$queryRawUnsafe<StaffSeasonalAccessRow[]>(
    `SELECT anchor_sd.id AS "sessionDateId", anchor_o.id AS "offeringId",
            anchor_o."linkedClassId", anchor_o.title
     FROM "SpecialProgramSessionDate" anchor_sd
     JOIN "SpecialProgramOffering" anchor_o ON anchor_o.id = anchor_sd."offeringId"
     LEFT JOIN "SpecialProgramSessionDate" matched_sd
       ON matched_sd."startsAt" = anchor_sd."startsAt" AND matched_sd."endsAt" = anchor_sd."endsAt"
     LEFT JOIN "SpecialProgramOffering" matched_o
       ON matched_o.id = matched_sd."offeringId"
      AND (
        matched_o.id = anchor_o.id
        OR (
          anchor_o."linkedClassId" IS NOT NULL
          AND matched_o."linkedClassId" = anchor_o."linkedClassId"
          AND matched_o."seasonId" = anchor_o."seasonId"
        )
      )
     LEFT JOIN "Session" matched_s ON matched_s."specialProgramSessionDateId" = matched_sd.id
     WHERE anchor_sd.id = $1
       AND anchor_o."linkedClassId" IS NOT NULL
       AND ($2::boolean = true OR matched_s."coachId" = $3 OR (matched_s.id IS NULL AND matched_o."instructorId" = $3))
     LIMIT 1`,
    sessionDateId,
    access.canAccessAllClasses,
    access.coachId,
  );

  if (!rows[0]) throw new Error("담당 특강 회차에만 접근할 수 있습니다.");
  return { access, seasonal: rows[0] };
}

export type StaffSessionAccessRow = {
  id: string;
  classId: string;
  status: string;
  className: string;
  sessionDateId: string | null;
  date: Date | string;
};

/**
 * 수업 기록(Session) 하나에 대한 권한 — 수업 시작·출석·종료와 사진이 **같은 함수**를 쓴다(2026-11-13 G11).
 * 정규 수업은 반 배정, 특강 회차(specialProgramSessionDateId 있음)는 특강 담당 강사 기준으로 본다.
 * 예전엔 사진 API 만 반 배정(requireStaffClassAccess)으로 따로 봐서, 특강만 맡은 선생님이 사진을 못 올렸다.
 */
export async function requireStaffSessionAccess(
  sessionId: string,
  context?: StaffClassAccessContext,
): Promise<{ session: StaffSessionAccessRow; access: StaffClassAccessContext }> {
  const rows = await prisma.$queryRawUnsafe<StaffSessionAccessRow[]>(
    `SELECT s.id, s."classId", s.date::date::text AS date, s.status, c.name AS "className", s."specialProgramSessionDateId" AS "sessionDateId"
     FROM "Session" s JOIN "Class" c ON c.id = s."classId" WHERE s.id = $1 LIMIT 1`,
    sessionId,
  );
  if (!rows[0]) throw new Error("수업 기록을 찾을 수 없습니다.");
  const access = rows[0].sessionDateId
    ? (await requireStaffSeasonalSessionAccess(rows[0].sessionDateId, context)).access
    : await requireStaffClassAccess(rows[0].classId, context);
  return { session: rows[0], access };
}

/**
 * 학생이 해당 수업에 실제로 등록되어 있는지 확인합니다.
 * 선생님이 주소나 요청 값을 바꿔 다른 반 학생을 조회하는 상황을 서버에서 차단합니다.
 */
export async function requireStaffStudentAccess(
  classId: string,
  studentId: string,
  context?: StaffClassAccessContext,
): Promise<StaffClassAccessContext> {
  if (!studentId) throw new Error("학생 정보가 필요합니다.");

  const access = await requireStaffClassAccess(classId, context);
  const rows = await prisma.$queryRawUnsafe<StudentAccessRow[]>(
    `SELECT s.id
     FROM "Student" s
     JOIN "Enrollment" e ON e."studentId" = s.id
     WHERE s.id = $1
       AND e."classId" = $2
       AND e.status = 'ACTIVE'
     LIMIT 1`,
    studentId,
    classId,
  );

  if (!rows[0]) {
    throw new Error("해당 수업에 등록된 학생만 접근할 수 있습니다.");
  }

  return access;
}
