import { createClient } from "@/lib/supabase/server";
import { getMyPageHistory, getMyPageData } from "@/lib/queries";
import { requireVerifiedParent } from "@/lib/auth-guard";
import Link from "next/link";
import ScheduleHub from "./ScheduleHub";
import { RememberChildSync } from "../useRememberedChild";
import { getParentShuttleOverview, getShuttleDriverContact } from "@/lib/shuttle/parent";
import { getMonthlyClassDates, loadAnnualPlanEvents } from "@/lib/enrollment/monthlyClassDates";
import { buildParentMonth, classDatesForCalendarMonth, parseMonthParam } from "@/lib/mypage/parentSchedule";
import { todayKst } from "@/lib/datetime/kst";

// «일정» 탭 — 연간일정·수업일·출결을 한 달 달력으로(자녀 보안 체크가 있어 실시간)
export const dynamic = "force-dynamic";

export default async function MyPageHistoryPage({
    searchParams,
}: {
    // ?child=<studentId> 로 자녀, ?month=YYYY-MM 로 달을 고른다 (Next 16: searchParams는 Promise)
    searchParams: Promise<{ child?: string; month?: string }>;
}) {
    // 로그인 확인
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
        return (
            <div className="flex flex-col items-center justify-center py-20 text-center">
                <h2 className="academy-heading mb-2">로그인이 필요합니다</h2>
                <p className="text-[var(--color-academy-muted)] mb-6">일정은 학부모 계정으로 로그인 후 확인할 수 있습니다.</p>
                <Link
                    href="/login"
                    className="academy-button-primary"
                >
                    로그인하기
                </Link>
            </div>
        );
    }

    // 인증 게이트가 검증한 부모 User.id(appUserId)를 조회 기준으로 사용 (이메일 매칭 없음)
    const parentAuth = await requireVerifiedParent();
    // 출결 기록(getMyPageHistory) · 수강 반(getMyPageData) · 셔틀 · 연간일정(공개 /annual·청구와 같은 원본).
    // 셔틀·연간일정 조회가 실패해도 화면은 열리게 하나씩 빈 값으로 받는다.
    const [data, home, shuttleItems, driverContact, planEvents] = await Promise.all([
        getMyPageHistory(parentAuth.appUserId),
        getMyPageData(parentAuth.appUserId),
        getParentShuttleOverview(parentAuth.appUserId).catch(() => []),
        getShuttleDriverContact().catch(() => null),
        loadAnnualPlanEvents().catch(() => []),
    ]);

    if (!data || data.children.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center py-20 text-center">
                <h2 className="academy-heading mb-2">등록된 자녀가 없습니다</h2>
                <p className="text-[var(--color-academy-faint)] text-sm">학원에 자녀를 등록하시면 일정을 확인할 수 있습니다.</p>
            </div>
        );
    }

    const { child, month: monthParam } = await searchParams;
    const todayYmd = todayKst();
    const month = parseMonthParam(monthParam, todayYmd);

    // 자녀 선택 — 주소의 child 가 내 자녀일 때만, 아니면 첫 자녀(남의 학생 id 는 무시)
    const childList = home?.children ?? [];
    const selected = childList.find((c) => c.id === child) ?? childList[0];
    const selectedId = selected?.id ?? data.children[0].id;

    // 우리 아이 수업일 — 수강 반 요일마다 연간일정(개강·종강·주차·휴무)으로 계산(공개 연간일정·청구와 같은 함수)
    // 복귀 예정 반은 복귀일 당일부터 수업일로 잡는다(startsOn 자리에 복귀일 — 2026-11-14)
    const classDates = (selected?.scheduleEnrollments ?? selected?.enrollments ?? []).flatMap((e) =>
        classDatesForCalendarMonth(month, e.dayOfWeek, e.startsOn, (ym, dow) => getMonthlyClassDates(planEvents, ym, dow)),
    );
    const attendance = data.children.find((c) => c.id === selectedId)?.attendance.records ?? [];
    const view = buildParentMonth({ month, todayYmd, events: planEvents, classDates, attendance });

    return (
        <>
        {/* 마지막으로 고른 아이 유지 — 주소에 child 가 없으면 기기 기억(내 자녀일 때만)으로 다시 연다 */}
        <RememberChildSync childIds={childList.map((c) => c.id)} selectedId={selectedId} />
        <ScheduleHub
            childList={childList}
            selectedChildId={selectedId}
            view={view}
            planReady={classDates.length > 0}
            shuttleItems={shuttleItems}
            driverContact={driverContact}
        />
        </>
    );
}
