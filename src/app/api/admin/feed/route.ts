import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-guard";
import { getAdminFeedFacets, getAdminFeedItem, getAdminFeedPage } from "@/lib/feed/adminFeedServer";
import { decodeAdminFeedCursor, normalizeAdminFeedFilter, normalizeFeedId } from "@/lib/feed/adminFeedRules";

// 선생님이 방금 올린 사진·한 줄이 바로 보여야 해서 캐시하지 않는다
export const dynamic = "force-dynamic";

/**
 * 관리자 «수업 피드» 페이지 단위 조회(2026-11-14).
 *   GET ?cursor=&days=&teacher=&weekday=&classId=&publish=&includeEmpty=  → { items, nextCursor, facets? }
 *   GET ?sessionId=…                                                       → { item } (편집 뒤 카드 하나 다시 읽기)
 * - 관리자 확인(requireAdmin)이 가장 먼저 — 통과 못 하면 아무것도 읽지 않는다.
 * - 주소 값은 허용값만 통과시키고(normalizeAdminFeedFilter·decodeAdminFeedCursor·normalizeFeedId),
 *   SQL 에는 바인딩 값으로만 들어간다(adminFeedServer).
 * - 선생님·반 목록(facets)은 첫 장(커서 없음)일 때만 함께 보낸다.
 * 응답은 NextResponse.json 그대로(apiSuccess 의 snake_case 자동 변환을 거치지 않는다).
 */
export async function GET(request: Request) {
  try {
    await requireAdmin();
  } catch {
    return NextResponse.json({ error: "관리자 로그인이 필요합니다." }, { status: 401 });
  }

  const search = new URL(request.url).searchParams;
  const headers = { "Cache-Control": "private, no-store" };

  try {
    // 카드 하나 다시 읽기
    if (search.has("sessionId")) {
      const sessionId = normalizeFeedId(search.get("sessionId"));
      if (!sessionId) return NextResponse.json({ error: "수업 정보가 올바르지 않습니다." }, { status: 400, headers });
      const item = await getAdminFeedItem(sessionId);
      if (!item) return NextResponse.json({ error: "수업을 찾을 수 없습니다." }, { status: 404, headers });
      return NextResponse.json({ item }, { headers });
    }

    const filter = normalizeAdminFeedFilter(Object.fromEntries(search.entries()));
    const rawCursor = search.get("cursor");
    const cursor = decodeAdminFeedCursor(rawCursor);
    // 커서를 보냈는데 모양이 틀리면 처음부터 다시 주지 않고 거절한다(같은 게시물이 두 번 붙지 않게)
    if (rawCursor && !cursor) return NextResponse.json({ error: "다음 목록 위치가 올바르지 않습니다." }, { status: 400, headers });

    const [page, facets] = await Promise.all([
      getAdminFeedPage(filter, cursor),
      cursor ? Promise.resolve(undefined) : getAdminFeedFacets(filter.days),
    ]);
    return NextResponse.json({ ...page, ...(facets ? { facets } : {}) }, { headers });
  } catch (error) {
    console.error("[api/admin/feed] failed:", error);
    return NextResponse.json({ error: "수업 피드를 불러오지 못했습니다." }, { status: 500, headers });
  }
}
