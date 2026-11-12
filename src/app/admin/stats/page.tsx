import { requireAdmin } from "@/lib/auth-guard";
import StatsClient from "./StatsClient";
import { getCachedAdminStatsPayload } from "@/lib/adminReadPayloads";

// 30초 캐시: Server Action 호출 시 즉시 무효화됨
export const revalidate = 30;

export default async function StatsPage() {
    // 레이아웃 검사만 믿지 않고 화면마다 관리자 확인(d3 — 레이아웃이 바뀌거나 우회돼도 데이터가 새지 않게)
    await requireAdmin();
    const stats = await getCachedAdminStatsPayload();

    return <StatsClient {...stats} />;
}
