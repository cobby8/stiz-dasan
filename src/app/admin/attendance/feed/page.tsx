import { requireAdmin } from "@/lib/auth-guard";
import { getAdminFeedItems } from "@/lib/feed/adminFeedServer";
import { normalizeFeedDays } from "@/lib/feed/adminFeedRules";
import AdminFeedClient from "./AdminFeedClient";

// 선생님이 방금 올린 사진·한 줄이 바로 보여야 해서 캐시하지 않는다
export const dynamic = "force-dynamic";

export default async function AdminFeedPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
    // 레이아웃 검사만 믿지 않고 화면에서도 관리자 확인
    await requireAdmin();
    const params = await searchParams;
    const days = normalizeFeedDays(params.days);
    const items = await getAdminFeedItems(days);
    return <AdminFeedClient items={items} days={days} />;
}
