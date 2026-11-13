import { requireAdmin } from "@/lib/auth-guard";
import StatsClient from "./StatsClient";
import { getCachedAdminStatsTab } from "@/lib/adminReadPayloads";
import { isStatsTabKey, normalizeStatsPeriod } from "@/lib/stats/statsRules";
import type { StatsPageData } from "@/lib/stats/statsTypes";

// 2026-11-13 통계 개편: 탭·지점·기간이 주소(?tab=&branch=&period=)에 있다 → 요청마다 그 탭만 읽는다.
// 숫자 자체는 getCachedAdminStatsTab 이 60초 캐시한다(유니폼 저장 등은 태그로 즉시 무효화).
export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function StatsPage({ searchParams }: { searchParams: SearchParams }) {
    // 레이아웃 검사만 믿지 않고 화면마다 관리자 확인(d3 — 레이아웃이 바뀌거나 우회돼도 데이터가 새지 않게)
    await requireAdmin();
    const params = await searchParams;
    const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
    // 모르는 값은 기본값으로(주소를 손으로 고쳐도 화면이 깨지지 않게)
    const tabParam = first(params.tab);
    const tab = isStatsTabKey(tabParam) ? tabParam : "students";
    // 2026-11-14: 이 사이트는 다산2호점만 관리 — 지점 고르기가 없으니 옛 주소의 ?branch= 는 무시한다(보이지 않는 필터가 남지 않게)
    const branch = "all" as const;
    const period = normalizeStatsPeriod(tab, first(params.period));

    let data: StatsPageData["data"] = null;
    try {
        data = await getCachedAdminStatsTab(tab, branch, period);
    } catch (error) {
        console.error("[admin-stats] tab load failed:", tab, error);
    }

    return <StatsClient key={`${tab}-${branch}-${period}`} tab={tab} branch={branch} period={period} data={data} />;
}
