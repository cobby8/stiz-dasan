import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedParent } from "@/lib/auth-guard";
import { loadReportFeedPage, loadReportFeedPost } from "@/lib/feed/reportFeedServer";
import { clampReportFeedLimit, parseReportFeedCursor, parseSessionIdParam } from "@/lib/feed/reportFeedRules";

export const dynamic = "force-dynamic";

// 학부모 «수업 리포트 피드»(2026-11-14) — 화면 /mypage/reports/feed 가 끝에 닿으면 다음 장을 받는다.
//  GET ?cursor=<YYYY-MM-DD~id>&limit=20 → 그 커서보다 오래된 게시물 한 장 { posts, nextCursor }
//  GET ?session=<id>                    → 게시물 하나만 다시(사진 칸 «다시 불러오기») { post }
// 순서: ① 보호자 확인(실패하면 401, 데이터 없음) ② 입력값 모양 검사(틀리면 400) ③ 조회(공개 기준·내 아이만).

const NO_STORE = { "Cache-Control": "private, no-store" };

export async function GET(req: NextRequest) {
    // ① 보호자 확인 — 실패를 삼켜 빈 목록으로 돌려주지 않는다(로그인이 풀린 것을 화면이 알아야 한다)
    let appUserId: string;
    try {
        appUserId = (await requireVerifiedParent()).appUserId;
    } catch {
        return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401, headers: NO_STORE });
    }
    if (!appUserId) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401, headers: NO_STORE });

    const params = req.nextUrl.searchParams;
    try {
        // 게시물 하나만 다시
        if (params.has("session")) {
            const sessionId = parseSessionIdParam(params.get("session"));
            if (!sessionId) return NextResponse.json({ error: "요청 형식이 올바르지 않습니다." }, { status: 400, headers: NO_STORE });
            const post = await loadReportFeedPost(appUserId, sessionId);
            // 볼 수 없는 수업 = 없는 수업과 같은 응답(다른 수업 id 가 있는지 떠볼 수 없게)
            if (!post) return NextResponse.json({ error: "볼 수 없는 소식입니다." }, { status: 404, headers: NO_STORE });
            return NextResponse.json({ post }, { headers: NO_STORE });
        }

        // 다음 장 — 커서가 있는데 모양이 틀리면 «맨 위부터»로 바꾸지 않고 거절한다(같은 게시물이 두 번 붙지 않게)
        const rawCursor = params.get("cursor");
        const cursor = rawCursor ? parseReportFeedCursor(rawCursor) : null;
        if (rawCursor && !cursor) return NextResponse.json({ error: "요청 형식이 올바르지 않습니다." }, { status: 400, headers: NO_STORE });
        const page = await loadReportFeedPage(appUserId, cursor, clampReportFeedLimit(params.get("limit")));
        return NextResponse.json(page, { headers: NO_STORE });
    } catch (error) {
        console.error("[mypage/report-feed] GET failed:", error);
        return NextResponse.json({ error: "소식을 불러오지 못했습니다." }, { status: 500, headers: NO_STORE });
    }
}
