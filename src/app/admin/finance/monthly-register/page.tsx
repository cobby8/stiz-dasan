import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth-guard";
import { canSeeAllMoney } from "@/lib/auth/moneyAccess";
import MonthlyRegisterClient from "./MonthlyRegisterClient";

export const dynamic = "force-dynamic";

export default async function MonthlyRegisterPage({ searchParams }: {
  searchParams: Promise<{ studentId?: string; month?: string }>;
}) {
  const admin = await requireAdmin();
  // 부원장 차단(2026-11-14 원장 결정): 원장만 — 부원장은 수납 관리로 돌려보낸다(API 도 따로 막는다)
  if (!canSeeAllMoney(admin.appUserRole)) redirect("/admin/finance");
  const params = await searchParams;
  return <MonthlyRegisterClient initialStudentId={params.studentId ?? ""} initialMonth={params.month ?? ""} />;
}
