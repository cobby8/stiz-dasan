import { prisma } from "@/lib/prisma";
import { requireVerifiedParent } from "@/lib/auth-guard";
import { childAccessSql } from "@/lib/account/child-access";
import { notMergedStudent } from "@/lib/studentVisibility";
import { getStaffClassAccessContext, requireStaffStudentAccess, type StaffClassAccessContext } from "@/lib/staff-class-access";

/**
 * 프로필 사진 권한 판정 — 올리기·지우기·보기 API 가 전부 이 파일만 부른다(한 곳).
 *
 * 누가 무엇을 할 수 있나
 *   올리기·지우기 : 학부모 본인(내 사진) · 그 아이의 보호자(아이 사진)
 *   아이 사진 보기 : 그 아이의 보호자 · 그 아이를 맡은 선생님 · 관리자(원장·부원장)
 *   학부모 사진 보기: 본인 · 관리자 · 그 학부모의 아이를 맡은 선생님
 *   그 밖(기사님 전용 계정·다른 학부모·비로그인)은 전부 «아니오».
 *
 * 원칙: 조회가 실패하면 «아니오»다 — 실패가 권한을 넓히는 쪽으로 흐르지 않는다.
 */

/**
 * 이 학부모의 아이인가 — 학생 id 와 로그인 보호자를 **같은 SQL** 에서 묶는다(IDOR 방지).
 * 가족 연결(승인된 보호자)도 포함하고, 병합돼 사라진 옛 학생은 제외한다.
 */
export async function parentOwnsStudent(parentUserId: string, studentId: string): Promise<boolean> {
  if (!parentUserId || !studentId) return false;
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT s.id FROM "Student" s
      WHERE s.id = $2 AND ${await childAccessSql("s", "$1")} AND ${notMergedStudent("s")}
      LIMIT 1`,
    parentUserId,
    studentId,
  );
  return rows.length === 1;
}

/** 로그인한 직원 정보 — 직원이 아니면 null(오류를 «권한 없음»으로 바꾼다) */
async function staffContext(): Promise<StaffClassAccessContext | null> {
  return getStaffClassAccessContext().catch(() => null);
}

/**
 * 이 선생님이 (반, 학생) 묶음 중 하나라도 맡고 있는가.
 * 판정은 기존 공용 함수 requireStaffStudentAccess 그대로 — 담당 반이고, 그 학생이 그 반에 ACTIVE 로 다닌다.
 */
async function teachesAny(access: StaffClassAccessContext, pairs: Array<{ classId: string; studentId: string }>): Promise<boolean> {
  for (const pair of pairs) {
    try {
      await requireStaffStudentAccess(pair.classId, pair.studentId, access);
      return true;
    } catch {
      // 이 반은 담당이 아니다 → 다음 반을 본다
    }
  }
  return false;
}

/** 아이 사진을 볼 수 있는가 — 보호자 · 담당 선생님 · 관리자 */
export async function canViewStudentPhoto(studentId: string): Promise<boolean> {
  if (!studentId) return false;

  // ① 학부모: 내 아이일 때만
  const parent = await requireVerifiedParent().catch(() => null);
  if (parent && (await parentOwnsStudent(parent.appUserId, studentId))) return true;

  // ② 직원: 관리자는 전부, 선생님은 맡은 반의 학생만. 기사님 전용 계정은 1차에서 제외
  const access = await staffContext();
  if (!access) return false;
  if (access.canAccessAllClasses) return true;
  if (!access.staff.roles?.teacher) return false;

  const classes = await prisma.$queryRawUnsafe<Array<{ classId: string }>>(
    `SELECT DISTINCT e."classId" AS "classId"
       FROM "Enrollment" e JOIN "Student" s ON s.id = e."studentId"
      WHERE e."studentId" = $1 AND e.status = 'ACTIVE' AND ${notMergedStudent("s")}`,
    studentId,
  );
  return teachesAny(access, classes.map((row) => ({ classId: row.classId, studentId })));
}

/** 학부모(사용자) 사진을 볼 수 있는가 — 본인 · 관리자 · 그 학부모의 아이를 맡은 선생님 */
export async function canViewUserPhoto(userId: string): Promise<boolean> {
  if (!userId) return false;

  // ① 본인
  const parent = await requireVerifiedParent().catch(() => null);
  if (parent && parent.appUserId === userId) return true;

  // ② 직원
  const access = await staffContext();
  if (!access) return false;
  if (access.canAccessAllClasses) return true;
  if (!access.staff.roles?.teacher) return false;

  // 그 학부모의 아이들(가족 연결 포함)이 다니는 반 — 그중 하나라도 이 선생님 담당이면 본다
  const pairs = await prisma.$queryRawUnsafe<Array<{ classId: string; studentId: string }>>(
    `SELECT DISTINCT e."classId" AS "classId", s.id AS "studentId"
       FROM "Student" s JOIN "Enrollment" e ON e."studentId" = s.id AND e.status = 'ACTIVE'
      WHERE ${await childAccessSql("s", "$1")} AND ${notMergedStudent("s")}`,
    userId,
  );
  return teachesAny(access, pairs);
}
