import { requireAdmin } from "@/lib/auth-guard";
import { redirect } from "next/navigation";
import { isServiceMonth } from "@/lib/regular/serviceMonth";

export const dynamic = "force-dynamic";

// 「신규 셔틀 신청」 화면은 2026-11-05 정규 배차 화면으로 합쳤다(원장 지시: 따로 두지 말고 배차 화면에서 보고 바로 넣기).
// 옛 주소·즐겨찾기로 들어와도 정규 배차로 보낸다. 고른 월(?month=)은 그대로 넘긴다. 권한은 도착 화면이 확인한다.
export default async function AdminShuttleIntakePage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  // 레이아웃 검사만 믿지 않고 화면마다 관리자 확인(d3 — 레이아웃이 바뀌거나 우회돼도 데이터가 새지 않게)
  await requireAdmin();
  const { month } = await searchParams;
  redirect(month && isServiceMonth(month) ? `/admin/shuttle/regular-dispatch?month=${encodeURIComponent(month)}` : "/admin/shuttle/regular-dispatch");
}
