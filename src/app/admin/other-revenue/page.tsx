import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth-guard";
import { canSeeAllMoney } from "@/lib/auth/moneyAccess";
import { prisma } from "@/lib/prisma";
import { todayKst } from "@/lib/datetime/kst";
import { listOtherRevenue, type OtherRevenueRow } from "@/lib/billing/other-revenue";
import { otherRevenueMonthRange } from "@/lib/billing/other-revenue-rules";
import OtherRevenueClient from "./OtherRevenueClient";

export const dynamic = "force-dynamic";

/**
 * 기타 매출 화면(2026-11-17) — 수강료 청구가 아닌 수입(학교 스포츠클럽 강사료·사이트 학생 아닌 특강생 등)을 원장이 적는다.
 * 원장 전용: 부원장은 금액을 못 보므로 관리자 첫 화면으로 보낸다(서버 동작도 requireOwner 로 한 번 더 막는다).
 * 보는 달은 주소의 ?ym=YYYY-MM — 없거나 틀리면 이번 달(KST).
 */
export default async function OtherRevenuePage({ searchParams }: { searchParams: Promise<{ ym?: string }> }) {
    const admin = await requireAdmin();
    // 부원장 차단 — 금액 화면은 원장만
    if (!canSeeAllMoney(admin.appUserRole)) redirect("/admin");

    const params = await searchParams;
    const thisMonth = todayKst().slice(0, 7);
    const ym = otherRevenueMonthRange(params?.ym) ? String(params.ym).trim() : thisMonth;

    let ready = true;
    let rows: OtherRevenueRow[] = [];
    let loadFailed = false;
    try {
        ({ ready, rows } = await listOtherRevenue(prisma, ym));
    } catch (error) {
        console.error("[other-revenue] 화면 읽기 실패:", error instanceof Error ? error.name : "");
        loadFailed = true;
    }

    return (
        <OtherRevenueClient
            ym={ym}
            thisMonth={thisMonth}
            today={todayKst()}
            ready={ready}
            loadFailed={loadFailed}
            rows={rows}
        />
    );
}
