import { requireAdmin } from "@/lib/auth-guard";
import { getAdminFeedFacets, getAdminFeedPage } from "@/lib/feed/adminFeedServer";
import { DEFAULT_ADMIN_FEED_FILTER } from "@/lib/feed/adminFeedRules";
import AdminFeedClient from "./AdminFeedClient";

// 선생님이 방금 올린 사진·한 줄이 바로 보여야 해서 캐시하지 않는다
export const dynamic = "force-dynamic";

/**
 * 관리자 «수업 피드»(2026-11-14 인스타식 개편) — 왼쪽 피드(스크롤·필터) + 오른쪽 편집 패널.
 * 첫 20개와 필터 목록만 서버에서 그리고, 다음 20개·필터 적용은 /api/admin/feed 로 이어 받는다.
 */
export default async function AdminFeedPage() {
    // 레이아웃 검사만 믿지 않고 화면에서도 관리자 확인
    await requireAdmin();
    const filter = DEFAULT_ADMIN_FEED_FILTER;
    const [page, facets] = await Promise.all([
        getAdminFeedPage(filter, null),
        getAdminFeedFacets(filter.days),
    ]);
    return <AdminFeedClient initialItems={page.items} initialNextCursor={page.nextCursor} initialFacets={facets} />;
}
