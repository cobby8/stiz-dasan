// 대타 선생님 지정(f4) — 관리자 화면용 읽기 함수. DB 는 $queryRawUnsafe 만 쓴다(PgBouncer).
// 호출하는 쪽(관리자 page.tsx · 서버 액션)이 먼저 requireAdmin 을 통과해야 한다.
import { prisma } from "@/lib/prisma";
import { todayKst } from "@/lib/datetime/kst";
import { SUBSTITUTE_TEACHER_SQL } from "@/lib/staff/classSubstitute";

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
 * 대타로 고를 수 있는 선생님 조건 — 정본은 순수 규칙 모듈(classSubstitute.ts) 한 곳.
 * 화면 목록·서버 액션·출석부 판정(staff-class-access)이 같은 조건을 쓴다.
 */
export { SUBSTITUTE_TEACHER_SQL };

/** Postgres «표 없음»(42P01) — Prisma raw 오류는 meta.code 또는 메시지에 담긴다. */
function isMissingTable(error: unknown): boolean {
    const e = error as { code?: string; meta?: { code?: string }; message?: string } | null;
    return e?.code === "42P01" || e?.meta?.code === "42P01" || /42P01|relation "ClassSubstitute" does not exist/.test(e?.message ?? "");
}

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
        ).catch((error: unknown) => {
            // 마이그레이션 전(표 없음 42P01)이면 빈 목록 — 스태프 관리 화면 전체가 멈추지 않게. 다른 오류는 그대로.
            if (isMissingTable(error)) return [] as ClassSubstituteItem[];
            throw error;
        }),
    ]);
    return { today, classes, teachers, items };
}
