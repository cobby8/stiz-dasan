import { createClient } from "@/lib/supabase/server";
import { getMyPageData, getGalleryByClassIds, getNoticesByClassIds, getNotifications, getUnreadNotificationCount, getMyRequests, getChildrenFeedbacks } from "@/lib/queries";
import MyPageClient from "./MyPageClient";
import EmptyParentState from "@/components/account/EmptyParentState";
import Link from "next/link";
import { requireVerifiedParent } from "@/lib/auth-guard";
import { getParentShuttleOverview, getShuttleDriverContact } from "@/lib/shuttle/parent";
import { getPendingSeasonalChildren } from "@/lib/seasonal/parent-pending";

export const dynamic = "force-dynamic";

export default async function MyPageDashboard() {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
        return (
            <div className="flex flex-col items-center justify-center py-20 text-center">
                <div className="text-5xl mb-4">🔒</div>
                <h2 className="text-xl font-bold text-gray-900 dark:text-white mb-2">로그인이 필요합니다</h2>
                <p className="text-gray-500 dark:text-gray-400 mb-6">마이페이지는 학부모 계정으로 로그인 후 이용할 수 있습니다.</p>
                <Link
                    href="/login"
                    className="bg-brand-orange-500 dark:bg-brand-neon-lime dark:text-brand-navy-900 text-white font-bold px-6 py-3 rounded-xl hover:bg-orange-600 transition"
                >
                    로그인하기
                </Link>
            </div>
        );
    }

    // 인증 게이트가 검증한 부모 User.id(appUserId)를 자녀 조회 기준으로 사용한다.
    // (이메일 매칭은 소셜/이메일 불일치 시 자녀를 못 찾는 버그가 있었다)
    const parentAuth = await requireVerifiedParent();
    const data = await getMyPageData(parentAuth.appUserId);

    // 정식 자녀가 없어도 특강 신청 내역과 연결 요청 경로는 확인할 수 있어야 한다.
    const studentIds = data?.children.map(c => c.id) ?? [];
    const pendingSeasonalChildren = await getPendingSeasonalChildren(parentAuth.appUserId, studentIds);
    if (!data || data.children.length === 0) {
        return <EmptyParentState pendingSeasonalChildren={pendingSeasonalChildren} />;
    }

    // 자녀의 수강 중인 반 ID 목록 추출
    const classIds = data.children.flatMap(c =>
        c.enrollments.map((e: { classId: string | null }) => e.classId).filter((id): id is string => typeof id === "string" && id.length > 0)
    );
    // 갤러리/공지/알림/피드백 데이터 가져오기
    const [gallery, notices, notifications, unreadCount, myRequests, feedbacks, shuttleOverview, driverContact] = await Promise.all([
        getGalleryByClassIds(classIds, 10),
        getNoticesByClassIds(classIds, 10),
        getNotifications(data.parent.id),
        getUnreadNotificationCount(data.parent.id),
        getMyRequests(data.parent.id),
        getChildrenFeedbacks(studentIds),
        getParentShuttleOverview(parentAuth.appUserId),
        getShuttleDriverContact(),
    ]);


    return <MyPageClient data={data} gallery={gallery} notices={notices} notifications={notifications} unreadCount={unreadCount} myRequests={myRequests} feedbacks={feedbacks} parentShuttleOverview={shuttleOverview} shuttleDriverContact={driverContact} pendingSeasonalChildren={pendingSeasonalChildren} />;
}
