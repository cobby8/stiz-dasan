import { requireAdmin } from "@/lib/auth-guard";
import ReportListClient from "./ReportListClient";
import { getCachedAdminReportListPayload } from "@/lib/adminReadPayloads";

// 관리자 리포트 목록은 30초 캐시 (출결 기록 후 자동 갱신)
export const revalidate = 30;

export default async function AdminReportListPage() {
    // 레이아웃 검사만 믿지 않고 화면마다 관리자 확인(d3 — 레이아웃이 바뀌거나 우회돼도 데이터가 새지 않게)
    await requireAdmin();
    const { sessions } = await getCachedAdminReportListPayload(50);

    return <ReportListClient sessions={sessions} />;
}
