import { NextRequest } from "next/server";
import { getCachedAdminFinancePayload } from "@/lib/adminReadPayloads";
import { createAdminTiming, requireTimedAdmin, timedJson } from "@/lib/adminTiming";
import { maskFinancePayloadForRole } from "@/lib/payments/financeRoleMask";

const FINANCE_CACHE_HEADERS = {
    // 브라우저 캐시 금지(검수 S3) — 공용 PC 에서 원장 응답(납부 완료 금액·합계)을 부원장이 다시 받지 않게
    "Cache-Control": "private, no-store",
};

export async function GET(request: NextRequest) {
    const timing = createAdminTiming("admin-finance");

    let role: string;
    try {
        role = (await requireTimedAdmin(timing)).appUserRole;
    } catch {
        return timedJson(timing, { error: "Authentication required" }, { status: 401 });
    }

    const { searchParams } = request.nextUrl;
    const year = parseInt(searchParams.get("year") || "");
    const month = parseInt(searchParams.get("month") || "");

    if (!year || !month) {
        return timedJson(timing, { error: "year and month required" }, { status: 400 });
    }

    try {
        // 캐시는 역할과 무관하게 공유된다 → 꺼낸 «뒤» 역할로 가린다(부원장 = 미납 금액만·요약 null)
        const data = maskFinancePayloadForRole(
            await timing.measure("data", () => getCachedAdminFinancePayload(year, month)),
            role,
        );

        return timedJson(
            timing,
            data,
            { headers: FINANCE_CACHE_HEADERS },
        );
    } catch (error) {
        console.error("[api/admin/finance] failed:", error);
        return timedJson(timing, { error: "Failed to load payments" }, { status: 500 });
    }
}
