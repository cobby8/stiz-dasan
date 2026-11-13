// 대타 선생님 지정(f4) — 관리자 화면용 읽기 함수. DB 는 $queryRawUnsafe 만 쓴다(PgBouncer).
// 호출하는 쪽(관리자 page.tsx · 서버 액션)이 먼저 requireAdmin 을 통과해야 한다.
import { prisma } from "@/lib/prisma";
import { todayKst } from "@/lib/datetime/kst";

export type SubstituteClassOption = { id: string; name: string; dayOfWeek: string; startTime: string; endTime: string };
export type SubstituteTeacherOption = { id: string; name: string };
export type ClassSubstituteItem = {
    id: string;
    date: string;
    classId: string;
    className: string;
    startTime: string;
    substituteUserId: string;
    substituteName: string;
};
export type ClassSubstituteAdminData = {
    today: string;
    classes: SubstituteClassOption[];
    teachers: SubstituteTeacherOption[];
    items: ClassSubstituteItem[];
};

/**
 * 대타로 고를 수 있는 선생님 — 주 역할이 선생님(INSTRUCTOR)이거나, 선생님 추가 역할이 승인(ACTIVE)된 사람.
 * 원장·부원장은 이미 모든 반을 보므로 빼고, 탈퇴한 계정도 뺀다. 서버 액션도 같은 조건으로 다시 확인한다.
 */
export const SUBSTITUTE_TEACHER_SQL = `
    u."withdrawnAt" IS NULL
    AND (
      u.role = 'INSTRUCTOR'
      OR EXISTS (
        SELECT 1 FROM "UserRoleGrant" g
         WHERE g."userId" = u.id AND g.role = 'INSTRUCTOR' AND g.status = 'ACTIVE'
      )
    )`;

export async function getClassSubstituteAdminData(): Promise<ClassSubstituteAdminData> {
    const today = todayKst();
    const [classes, teachers, items] = await Promise.all([
        prisma.$queryRawUnsafe<SubstituteClassOption[]>(
            `SELECT id, name, "dayOfWeek", "startTime", "endTime" FROM "Class" ORDER BY "startTime", name`,
        ),
        prisma.$queryRawUnsafe<SubstituteTeacherOption[]>(
            `SELECT u.id, u.name FROM "User" u WHERE ${SUBSTITUTE_TEACHER_SQL} ORDER BY u.name`,
        ),
        // 오늘(KST) 이후 지정만 — 날짜는 "YYYY-MM-DD" 문자열이라 문자열 비교가 곧 날짜 비교다.
        prisma.$queryRawUnsafe<ClassSubstituteItem[]>(
            `SELECT cs.id, cs.date, cs."classId", c.name AS "className", c."startTime",
                    cs."substituteUserId", u.name AS "substituteName"
               FROM "ClassSubstitute" cs
               JOIN "Class" c ON c.id = cs."classId"
               JOIN "User" u ON u.id = cs."substituteUserId"
              WHERE cs.date >= $1
              ORDER BY cs.date, c."startTime", c.name
              LIMIT 100`,
            today,
        ),
    ]);
    return { today, classes, teachers, items };
}
