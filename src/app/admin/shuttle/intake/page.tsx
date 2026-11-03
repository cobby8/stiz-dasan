import { requireAdmin } from "@/lib/auth-guard";
import { isServiceMonth, koreaServiceMonth } from "@/lib/regular/serviceMonth";
import ShuttleIntakeClient from "@/components/shuttle/intake/ShuttleIntakeClient";
import ShuttleSectionTabs from "../ShuttleSectionTabs";

export const dynamic = "force-dynamic";

export default async function AdminShuttleIntakePage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  await requireAdmin();
  const { month } = await searchParams;
  const initialMonth = month && isServiceMonth(month) ? month : koreaServiceMonth();
  return <><ShuttleSectionTabs /><ShuttleIntakeClient mode="admin" initialMonth={initialMonth} /></>;
}
