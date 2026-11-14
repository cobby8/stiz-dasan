import { getCachedAdminDashboardPayload } from "@/lib/adminReadPayloads";
import { stripDashboardMoneyForRole } from "@/lib/auth/dashboardMoneyStrip";
import { createAdminTiming, requireTimedAdmin, timedJson } from "@/lib/adminTiming";

// 브라우저 캐시 금지(2026-11-14 검수 S3): 학원 공용 PC 에서 원장 → 부원장으로 바꿔 로그인하면
// 원장이 받은 응답(매출·미납 합계)을 브라우저가 그대로 다시 쓸 수 있었다. 서버 캐시(unstable_cache)는 그대로다.
const ADMIN_DASHBOARD_CACHE_HEADERS = {
    "Cache-Control": "private, no-store",
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
