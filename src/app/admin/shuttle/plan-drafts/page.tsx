import { requireAdmin } from "@/lib/auth-guard";
import { isServiceMonth, koreaServiceMonth } from "@/lib/regular/serviceMonth";
import RoutePlanningClient from "@/components/shuttle/planning/RoutePlanningClient";
import ShuttleSectionTabs from "../ShuttleSectionTabs";

export const dynamic = "force-dynamic";

export default async function ShuttlePlanDraftsPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  await requireAdmin();
  const { month } = await searchParams;
  const initialMonth = month && isServiceMonth(month) ? month : koreaServiceMonth();
  return <><ShuttleSectionTabs /><main className="mx-auto max-w-5xl px-3 py-4"><h1 className="text-xl font-black">배차안 확인·확정</h1><RoutePlanningClient mode="admin" initialMonth={initialMonth} /></main></>;
}
