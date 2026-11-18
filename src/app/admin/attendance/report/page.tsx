import { requireAdmin } from "@/lib/auth-guard";
import { redirect } from "next/navigation";

/**
 * 옛 «수업 리포트» 목록 주소(2026-11-14 수업 피드로 합침) — 북마크·출결 화면 링크가 남아 있어 피드로 보낸다.
 * 수업 하나의 편집 화면(/admin/attendance/report/[sessionId])은 그대로 남아 있다(옛 링크 보존).
 */
export default async function AdminReportListPage() {
    // 레이아웃 검사만 믿지 않고 화면마다 관리자 확인(d3 — 레이아웃이 바뀌거나 우회돼도 데이터가 새지 않게)
    await requireAdmin();
    redirect("/admin/attendance/feed");
}
