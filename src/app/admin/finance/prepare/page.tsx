import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth-guard";
import { canSeeAllMoney } from "@/lib/auth/moneyAccess";
import BillingWorkbench from "./BillingWorkbench";

export default async function BillingPreparationPage() {
    const admin = await requireAdmin();
    // 부원장 차단(2026-11-14 원장 결정): 원장만 — 부원장은 수납 관리로 돌려보낸다(API 도 따로 막는다)
    if (!canSeeAllMoney(admin.appUserRole)) redirect("/admin/finance");
    return <BillingWorkbench />;
}
