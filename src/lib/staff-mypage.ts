import { prisma } from "@/lib/prisma";
import type { StaffAuthUser } from "@/lib/auth-guard";
import { getAccessibleClassIds, getStaffClassAccessContext, type StaffClassAccessContext } from "@/lib/staff-class-access";
import { TODAY_KST_SQL } from "@/lib/feed/rules";
import { profilePhotoUpdatedAtSql, profilePhotoUrl, profilePhotoVersion } from "@/lib/profilePhoto/rules";
import { notMergedStudent } from "@/lib/studentVisibility";
import { sortStaffClasses, type StaffMyClassRow } from "@/lib/staff/mypageRules";

/**
 * 선생님 «마이페이지»(/staff/mypage)의 조회 — 내 정보 · 내 담당 반(2026-11-16 원장 지시).
 * 이번 달 수업 숫자는 지난 수업 목록과 같은 판정을 쓰려고 @/lib/staff-past-sessions 에 둔다.
 * DB 는 $queryRawUnsafe 만(PgBouncer 트랜잭션 모드).
 */

export type StaffMyProfile = {
  name: string;
  phone: string | null;
  /** 프로필 사진 주소(권한 확인 API). 사진이 없으면 null → 화면은 이름 첫 글자 */
  photoSrc: string | null;
};

/**
 * 내 정보 — 이름·연락처·프로필 사진. 본인 행만 읽는다(id 는 로그인 정보에서 온다 — 요청 값이 아니다).
 * 조회가 실패해도 화면은 로그인 이름으로 그대로 뜬다.
 */
export async function getStaffMyProfile(staff: StaffAuthUser): Promise<StaffMyProfile> {
  const rows = await prisma.$queryRawUnsafe<Array<{ name: string | null; phone: string | null; photoUpdatedAt: Date | string | null }>>(
    `SELECT u.name, u.phone, ${profilePhotoUpdatedAtSql("u")} AS "photoUpdatedAt"
       FROM "User" u
      WHERE u.id = $1
      LIMIT 1`,
    staff.appUserId,
  ).catch(() => [] as Array<{ name: string | null; phone: string | null; photoUpdatedAt: Date | string | null }>);
  const row = rows[0];
  return {
    name: row?.name || staff.appUserName,
    phone: row?.phone || null,
    // 사진 주소 규칙은 학부모·학생과 같은 한 곳(profilePhoto/rules). 40px 로 그리므로 작은 사진이면 충분하다
    photoSrc: profilePhotoUrl({ kind: "user", id: staff.appUserId }, profilePhotoVersion(row?.photoUpdatedAt), true),
  };
}

/**
 * «본인이 코치로 연결된 반»만 보는 판정 정보.
 * 원장·부원장은 공용 판정(getStaffClassAccessContext)이 «전체 반»이라, 마이페이지에서는
 * 본인 계정에 연결된 코치를 따로 찾아 선생님과 같은 기준(getAccessibleClassIds)으로 좁힌다.
 */
async function ownClassAccess(): Promise<StaffClassAccessContext> {
  const access = await getStaffClassAccessContext();
  if (!access.canAccessAllClasses) return access;
  const rows = await prisma.$queryRawUnsafe<Array<{ coachId: string }>>(
    `SELECT id AS "coachId" FROM "Coach" WHERE "userId" = $1 LIMIT 1`,
    access.staff.appUserId,
  );
  return { staff: access.staff, coachId: rows[0]?.coachId ?? null, canAccessAllClasses: false };
}

/**
 * 내 담당 반 — 반 이름 · 요일 · 시간 · 학생 수(요일·시작 시간 순).
 * 학생 수 = 지금 다니는 수강생(ACTIVE, 개시일이 오늘(KST) 이전이거나 비어 있음, 병합돼 사라진 학생 제외).
 * 로그인한 직원 화면이라 숫자를 보여도 된다(공개 화면 금지 규칙과 무관).
 */
export async function getStaffMyClasses(): Promise<StaffMyClassRow[]> {
  const classIds = await getAccessibleClassIds(await ownClassAccess());
  if (classIds.length === 0) return [];
  const rows = await prisma.$queryRawUnsafe<StaffMyClassRow[]>(
    `SELECT c.id, c.name, c."dayOfWeek", c."startTime", c."endTime",
            (SELECT COUNT(*)
               FROM "Enrollment" e
               JOIN "Student" st ON st.id = e."studentId"
              WHERE e."classId" = c.id AND e.status = 'ACTIVE'
                AND (e."startsOn" IS NULL OR e."startsOn" <= ${TODAY_KST_SQL})
                AND ${notMergedStudent("st")})::int AS "studentCount"
       FROM "Class" c
      WHERE c.id = ANY($1::text[])`,
    classIds,
  );
  return sortStaffClasses(rows.map((row) => ({ ...row, studentCount: Number(row.studentCount) || 0 })));
}
