import { createClient } from "@/lib/supabase/server";
import { getMyPageHistory, getMyPageData } from "@/lib/queries";
import { requireVerifiedParent } from "@/lib/auth-guard";
import Link from "next/link";
import HistoryClient from "./HistoryClient";
import ScheduleHub from "./ScheduleHub";
import { getParentShuttleOverview, getShuttleDriverContact } from "@/lib/shuttle/parent";
import { getMakeupOverviewForParent } from "@/lib/makeup/parent-makeup";
import { getUpcomingSeasonalSeats } from "@/lib/seasonal/parent-absence";

// 출결·수납 전체 히스토리는 실시간 데이터 필요 (자녀 보안 체크)
export const dynamic = "force-dynamic";

export default async function MyPageHistoryPage({
    searchParams,
}: {
    // ?child=<studentId> 로 진입 자녀를 선택 (Next 16: searchParams는 Promise)
    searchParams: Promise<{ child?: string }>;
}) {
    // 로그인 확인
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
        return (
            <div className="flex flex-col items-center justify-center py-20 text-center">
                <div className="text-5xl mb-4">🔒</div>
                <h2 className="text-xl font-bold text-gray-900 dark:text-white mb-2">로그인이 필요합니다</h2>
                <p className="text-gray-500 dark:text-gray-400 mb-6">출결·수납 히스토리는 학부모 계정으로 로그인 후 확인할 수 있습니다.</p>
                <Link
                    href="/login"
                    className="bg-brand-orange-500 dark:bg-brand-neon-lime dark:text-brand-navy-900 text-white font-bold px-6 py-3 rounded-xl hover:bg-orange-600 transition"
                >
                    로그인하기
                </Link>
            </div>
        );
    }

    // 인증 게이트가 검증한 부모 User.id(appUserId)를 조회 기준으로 사용 (이메일 매칭 없음)
    const parentAuth = await requireVerifiedParent();
    // «일정» 탭(2026-11-09 안 A) — 기존 출결·수납 기록 위에 수강 반·결석·보강·셔틀을 함께 보인다.
    // 전부 읽기 전용이고, 위쪽 칸 조회가 실패해도 기존 기록 화면은 그대로 보이게 하나씩 빈 값으로 받는다.
    const [data, home, shuttleItems, driverContact, makeup, seasonal] = await Promise.all([
        getMyPageHistory(parentAuth.appUserId),
        getMyPageData(parentAuth.appUserId),
        getParentShuttleOverview(parentAuth.appUserId).catch(() => []),
        getShuttleDriverContact().catch(() => null),
        getMakeupOverviewForParent(parentAuth.appUserId).catch(() => null),
        getUpcomingSeasonalSeats(parentAuth.appUserId).catch(() => null),
    ]);

    if (!data || data.children.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center py-20 text-center">
                <div className="text-5xl mb-4">👋</div>
                <h2 className="text-xl font-bold text-gray-900 dark:text-white mb-2">등록된 자녀가 없습니다</h2>
                <p className="text-gray-400 text-sm">학원에 자녀를 등록하시면 출결·수납 기록을 확인할 수 있습니다.</p>
            </div>
        );
    }

    const { child } = await searchParams;

    return (
        <div>
            <ScheduleHub
                childList={home?.children ?? []}
                shuttleItems={shuttleItems}
                driverContact={driverContact}
                makeupAvailable={makeup?.counts.available ?? 0}
                seasonalUpcoming={seasonal?.seats.length ?? 0}
            />
            <HistoryClient initialChildId={child} embedded>{data.children}</HistoryClient>
        </div>
    );
}
