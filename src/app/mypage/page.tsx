import { createClient } from "@/lib/supabase/server";
import { getMyPageData, getNoticesByClassIds, getNotifications, getUnreadNotificationCount, getMyRequests } from "@/lib/queries";
import { getMakeupOverviewForParent } from "@/lib/makeup/parent-makeup";
import { getUpcomingSeasonalSeats } from "@/lib/seasonal/parent-absence";
import MyPageClient from "./MyPageClient";
import EmptyParentState from "@/components/account/EmptyParentState";
import Link from "next/link";
import { requireVerifiedParent } from "@/lib/auth-guard";
import { getParentShuttleOverview, getShuttleDriverContact } from "@/lib/shuttle/parent";
import { getPendingSeasonalChildren } from "@/lib/seasonal/parent-pending";
import { getParentPaymentRequests } from "@/lib/payments/parent-payment-request";

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
    // 홈 «오늘 할 일» 판 데이터 (2026-11-09 안 A).
    // 사진·학습 피드백은 «소식» 탭으로 옮겨 홈에서는 읽지 않는다. 공지는 «새 공지 N건» 줄을 세는 데만 쓴다.
    // 보강권·방학특강 회차는 «처리할 일» 줄용 — 실패해도 홈이 깨지지 않게 빈 값으로 받는다.
    // 납부할 청구 합계·입금 계좌는 «청구» 탭과 같은 목록(getParentPaymentRequests)으로 센다 —
    // getMyPageData 의 자녀별 최근 5건으로 세면 오래된 미납이 빠져 탭과 숫자가 달라진다(2026-11-09). 실패하면 null → 예전 기준으로.
    const [notices, notifications, unreadCount, myRequests, shuttleOverview, driverContact, makeup, seasonal, paymentRows] = await Promise.all([
        getNoticesByClassIds(classIds, 10),
        getNotifications(data.parent.id),
        getUnreadNotificationCount(data.parent.id),
        getMyRequests(data.parent.id),
        getParentShuttleOverview(parentAuth.appUserId),
        getShuttleDriverContact(),
        getMakeupOverviewForParent(parentAuth.appUserId).catch(() => null),
        getUpcomingSeasonalSeats(parentAuth.appUserId).catch(() => null),
        getParentPaymentRequests(parentAuth.appUserId).catch(() => null),
    ]);
    // 미납만 홈으로 넘긴다(필요한 칸만 — 요청 내역·영수증은 청구 탭이 본다)
    const pendingPayments = paymentRows
        ? paymentRows
            .filter((row) => row.status === "PENDING" || row.status === "OVERDUE")
            .map((row) => ({ id: row.paymentId, amount: row.amount, status: row.status, canCheckout: row.canCheckout, virtualAccount: row.virtualAccount }))
        : null;

    return <MyPageClient data={data} notices={notices} notifications={notifications} unreadCount={unreadCount} myRequests={myRequests} parentShuttleOverview={shuttleOverview} shuttleDriverContact={driverContact} pendingSeasonalChildren={pendingSeasonalChildren} makeupAvailable={makeup?.counts.available ?? 0} seasonalUpcoming={seasonal?.seats.length ?? 0} pendingPayments={pendingPayments} />;
}
