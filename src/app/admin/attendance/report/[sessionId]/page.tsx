import { requireAdmin } from "@/lib/auth-guard";
import ReportEditClient from "./ReportEditClient";
import { getCoaches, getSessionReport } from "@/lib/queries";
import { notFound } from "next/navigation";

// 관리자 리포트 편집은 30초 캐시
export const revalidate = 30;

export default async function AdminReportEditPage({
    params,
}: {
    params: Promise<{ sessionId: string }>;
}) {
    // 레이아웃 검사만 믿지 않고 화면마다 관리자 확인(d3 — 레이아웃이 바뀌거나 우회돼도 데이터가 새지 않게)
    await requireAdmin();
    const { sessionId } = await params;
    const [report, coaches] = await Promise.all([
        getSessionReport(sessionId),
        getCoaches(),
    ]);

    if (!report) notFound();

    return <ReportEditClient sessionId={sessionId} report={report} coaches={coaches} />;
}
