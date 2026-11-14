import { getCachedAdminDashboardPayload } from "@/lib/adminReadPayloads";
import { stripDashboardMoneyForRole } from "@/lib/auth/dashboardMoneyStrip";
import { createAdminTiming, requireTimedAdmin, timedJson } from "@/lib/adminTiming";

const ADMIN_DASHBOARD_CACHE_SECONDS = 300;
const ADMIN_DASHBOARD_CACHE_HEADERS = {
    "Cache-Control": `private, max-age=60, stale-while-revalidate=${ADMIN_DASHBOARD_CACHE_SECONDS}`,
};

export async function GET() {
    const timing = createAdminTiming("admin-dashboard");

    let role: string;
    try {
        role = (await requireTimedAdmin(timing)).appUserRole;
    } catch {
        return timedJson(timing, { error: "Authentication required" }, { status: 401 });
    }

    try {
        const cached = await timing.measure("data", () => getCachedAdminDashboardPayload());
        // 2026-11-14 부원장 금액 가림: 캐시는 역할과 무관하게 공유되므로 꺼낸 «뒤»에 매출·미납·통계 칸을 뺀다
        const data = stripDashboardMoneyForRole(cached, role);

        return timedJson(timing, data, { headers: ADMIN_DASHBOARD_CACHE_HEADERS });
    } catch (error) {
        console.error("[api/admin/dashboard] failed:", error);
        return timedJson(timing, { error: "Failed to load dashboard" }, { status: 500 });
    }
}
