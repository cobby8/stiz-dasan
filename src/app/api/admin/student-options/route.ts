import { unstable_cache } from "next/cache";
import { prisma } from "@/lib/prisma";
import { createAdminTiming, requireTimedAdmin, timedJson } from "@/lib/adminTiming";
import { notMergedStudent } from "@/lib/studentVisibility";

const STUDENT_OPTIONS_CACHE_SECONDS = 60;
const STUDENT_OPTIONS_CACHE_HEADERS = {
    "Cache-Control": `private, max-age=${STUDENT_OPTIONS_CACHE_SECONDS}, stale-while-revalidate=300`,
};

type StudentOptionRow = {
    id: string;
    name: string;
    parentName: string | null;
    parentId: string | null;
    classId: string | null;
    className: string | null;
    dayOfWeek: string | null;
    startTime: string | null;
    programName: string | null;
};

const getCachedStudentOptions = unstable_cache(
    async () => {
        const rows = await prisma.$queryRawUnsafe<StudentOptionRow[]>(`
            SELECT s.id, s.name, s."parentId", u.name AS "parentName",
                   c.id AS "classId", c.name AS "className", c."dayOfWeek", c."startTime",
                   p.name AS "programName"
            FROM "Student" s
            LEFT JOIN "User" u ON s."parentId" = u.id
            LEFT JOIN "Enrollment" e ON e."studentId" = s.id AND e.status = 'ACTIVE'
            LEFT JOIN "Class" c ON c.id = e."classId"
            LEFT JOIN "Program" p ON p.id = c."programId"
            WHERE ${notMergedStudent("s")}
            ORDER BY s.name ASC, c."dayOfWeek" ASC, c."startTime" ASC
        `);

        const students = new Map<string, {
            id: string;
            name: string;
            parent: { name: string | null };
            hasParent: boolean;
            classes: { id: string; name: string; dayOfWeek: string; startTime: string; programName: string | null }[];
        }>();

        for (const row of rows) {
            const student = students.get(row.id) ?? {
                id: row.id,
                name: row.name,
                parent: { name: row.parentName },
                hasParent: Boolean(row.parentId),
                classes: [],
            };
            if (row.classId && row.className && row.dayOfWeek && row.startTime) {
                student.classes.push({
                    id: row.classId,
                    name: row.className,
                    dayOfWeek: row.dayOfWeek,
                    startTime: row.startTime,
                    programName: row.programName,
                });
            }
            students.set(row.id, student);
        }

        return Array.from(students.values());
    },
    ["admin-student-options-v3"],
    {
        revalidate: STUDENT_OPTIONS_CACHE_SECONDS,
        tags: ["admin-student-options"],
    },
);

export async function GET() {
    const timing = createAdminTiming("admin-student-options");

    try {
        await requireTimedAdmin(timing);
    } catch {
        return timedJson(timing, { error: "Authentication required" }, { status: 401 });
    }

    const students = await timing.measure("data", () => getCachedStudentOptions());

    return timedJson(
        timing,
        { students },
        {
            headers: STUDENT_OPTIONS_CACHE_HEADERS,
        },
    );
}
