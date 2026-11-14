import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-guard";
import { getCachedAdminAttendancePayload } from "@/lib/adminReadPayloads";
import { getAttendanceByDateAndClass } from "@/lib/queries";
import { todayKst } from "@/lib/datetime/kst";
import { compareWeekLessons, mapWithLimit, normalizeWeekStart, weekDays } from "@/lib/attendance/weekBoard";

export const dynamic = "force-dynamic";

// 수업별 명단·하루치 목록을 동시에 몇 개까지 부를지. 서버 한 대의 DB 연결이 5개(connection_limit=5)라
// 3 으로 둔다 — 6 이면 연결 대기(P2024 «Timed out fetching a new connection», 운영 11-14 에 실제 발생)가 다른 화면까지 번진다.
// (속도: 수업 1회 = 쿼리 3~4개. 운영에서 느리면 이 숫자보다 «한 번에 묶는 조회»를 검토할 것)
const DETAIL_CONCURRENCY = 3;

/**
 * 출결 «주간 보드» — GET ?start=YYYY-MM-DD (월요일. 다른 요일이면 그 주 월요일로 보정)
 * 날짜별 화면과 숫자가 어긋나지 않게 **같은 함수**를 그대로 부른다:
 *   수업 목록 = getCachedAdminAttendancePayload(날짜) / 명단·출결 = getAttendanceByDateAndClass(날짜, 반, 특강회차)
 */
export async function GET(request: NextRequest) {
    // 관리자 확인이 맨 먼저(테스트로 순서를 못 박음)
    try {
        await requireAdmin();
    } catch {
        return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    const start = normalizeWeekStart(request.nextUrl.searchParams.get("start"), todayKst());
    const days = weekDays(start);

    try {
        // 1) 7일치 수업 목록(날짜별 화면과 같은 캐시 함수).
        //    하루가 실패해도 주 전체를 500 으로 만들지 않는다 — 그날만 failedDays 에 담아 보드가 «다시 시도»를 띄운다
        const failedDays: string[] = [];
        const perDay = await mapWithLimit(days, DETAIL_CONCURRENCY, async (date) => {
                try {
                    const { classes } = await getCachedAdminAttendancePayload(date);
                    return classes.map((lesson) => ({ date, lesson }));
                } catch (error) {
                    console.error(`[api/admin/attendance/week] classes failed (${date}):`, error);
                    failedDays.push(date);
                    return [];
                }
        });
        failedDays.sort();
        const occurrences = perDay.flat().sort(compareWeekLessons);

        // 2) 수업마다 명단·출결 — 입력 패널과 같은 함수, 동시 3개 제한
        const lessons = await mapWithLimit(occurrences, DETAIL_CONCURRENCY, async ({ date, lesson }) => {
            const detail = await getAttendanceByDateAndClass(date, lesson.id, lesson.sessionDateId ?? null);
            return { date, lesson, students: detail.students };
        });

        return NextResponse.json(
            { start, days, lessons, failedDays },
            { headers: { "Cache-Control": "no-store" } },
        );
    } catch (error) {
        console.error("[api/admin/attendance/week] failed:", error);
        return NextResponse.json({ error: "Failed to load week" }, { status: 500 });
    }
}
