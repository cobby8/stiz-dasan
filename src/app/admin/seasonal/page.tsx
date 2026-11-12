import { requireAdmin } from "@/lib/auth-guard";
import SeasonalAdminClient from "./SeasonalAdminClient";
import { getSeasonalAdminOverview } from "@/lib/seasonal/admin-overview";

export const dynamic = "force-dynamic";

export default async function SeasonalAdminPage() {
  // 레이아웃 검사만 믿지 않고 화면마다 관리자 확인(d3 — 레이아웃이 바뀌거나 우회돼도 데이터가 새지 않게)
  await requireAdmin();
  const overview = await getSeasonalAdminOverview();
  const initialData = JSON.parse(JSON.stringify(overview)) as Record<string, unknown>;

  return <SeasonalAdminClient initialData={initialData} />;
}
