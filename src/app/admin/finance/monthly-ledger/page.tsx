import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth-guard";
import { canSeeAllMoney } from "@/lib/auth/moneyAccess";
import MonthlyLedgerClient from "./MonthlyLedgerClient";
import { toKstYmd } from "@/lib/datetime/kst";

export const dynamic = "force-dynamic";

export default async function MonthlyLedgerPage() {
  const admin = await requireAdmin();
  // 부원장 차단(2026-11-14 원장 결정): 원장만 — 부원장은 수납 관리로 돌려보낸다(API 도 따로 막는다)
  if (!canSeeAllMoney(admin.appUserRole)) redirect("/admin/finance");
  const initialMonth = toKstYmd(new Date()).slice(0, 7);
  return <MonthlyLedgerClient initialMonth={initialMonth} />;
}
