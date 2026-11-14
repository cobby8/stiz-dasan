import { requireAdmin } from "@/lib/auth-guard";
import AdminDashboardClient from "./AdminDashboardClient";
import { getCachedAdminDashboardPrimaryPayload, getCachedAdminDashboardSummary } from "@/lib/adminReadPayloads";
import { getInboxCounts } from "@/lib/requests/admin-inbox";
import { canSeeStats } from "@/lib/auth/moneyAccess";

// 30초 캐시: Server Action 호출 시 즉시 무효화됨
export const revalidate = 30;

export default async function AdminDashboard() {
    // 레이아웃 검사만 믿지 않고 화면마다 관리자 확인(d3 — 레이아웃이 바뀌거나 우회돼도 데이터가 새지 않게)
    const admin = await requireAdmin();
    // 2026-11-14 부원장 금액 가림: 카드 6개(수납률·통계로 가는 링크 포함)는 원장만 — 부원장이면 «조회 자체를» 하지 않는다
    const showSummary = canSeeStats(admin.appUserRole);
    // «처리할 신청» 숫자는 신청함과 같은 개수(getInboxCounts — SQL 한 번)로 맞춘다
    // 2026-11-13: 맨 위 카드 6개 숫자도 첫 렌더에 같이 읽는다(«상세 데이터 불러오기» 버튼을 없앴다).
    //   카드 조회가 실패해도 신청·오늘 수업은 보여야 하므로 카드만 null 로 비운다.
    const [initialData, inboxCounts, summary] = await Promise.all([
        getCachedAdminDashboardPrimaryPayload(),
        getInboxCounts(),
        showSummary
            ? getCachedAdminDashboardSummary().catch((error) => {
                console.error("[admin-dashboard] summary failed:", error);
                return null;
            })
            : Promise.resolve(null),
    ]);

    return <AdminDashboardClient initialData={initialData} inboxCounts={inboxCounts} summary={summary} />;
}
