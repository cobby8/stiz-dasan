import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth-guard";
import { canSeeAllMoney } from "@/lib/auth/moneyAccess";
import { todayKst } from "@/lib/datetime/kst";
import { defaultWorkbenchMonth } from "@/lib/billing/billing-schedule";
import { loadWorkbenchCalendar } from "@/lib/billing/workbench-calendar";
import BillingWorkbench from "./BillingWorkbench";

export default async function BillingPreparationPage() {
    const admin = await requireAdmin();
    // 부원장 차단(2026-11-14 원장 결정): 원장만 — 부원장은 수납 관리로 돌려보낸다(API 도 따로 막는다)
    if (!canSeeAllMoney(admin.appUserRole)) redirect("/admin/finance");
    // 기본으로 열 달(2026-11-17 PM 결정): 다음 달 청구일(전달 개강 + 14일)이 지났으면 다음 달, 아니면 이번 달.
    // 날짜는 서버(UTC)가 아니라 한국 날짜로 정한다. 공식 일정을 못 읽으면 이번 달 그대로(화면은 막지 않는다).
    const today = todayKst();
    let defaultMonth = today.slice(0, 7);
    try { defaultMonth = defaultWorkbenchMonth((await loadWorkbenchCalendar()).events, today); } catch { /* 이번 달 그대로 */ }
    return <BillingWorkbench defaultMonth={defaultMonth} />;
}
