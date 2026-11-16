import { buildIcsCalendar } from "@/lib/calendar/ics";
import {
  findFeedToken,
  getFeedAccessForUser,
  kindsAllowedNow,
  loadPersonalIcsEvents,
  touchFeedToken,
} from "@/lib/calendar/feedServer";

// 개인 일정 구독 주소 — 캘린더 앱은 로그인을 못 하므로 주소 안의 확인 값으로 본인을 찾는다.
//  1) 확인 값은 해시(tokenHash)로만 찾는다(원문은 DB 에 없다)
//  2) 없거나 틀리면 404 — 이유를 가르지 않는다(모양 오류·없음·탈퇴·표 없음 모두 같은 응답)
//  3) 찾았어도 «지금» 그 사람의 역할로 항목을 다시 거른다(역할이 회수된 항목은 나가지 않는다)
//  4) 응답은 저장하지 않게(private, no-store). 확인 값은 로그에 남기지 않는다
export const dynamic = "force-dynamic";

const NO_STORE = "private, no-store";

function notFound() {
  return new Response("Not Found", { status: 404, headers: { "Cache-Control": NO_STORE } });
}

export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const row = await findFeedToken(token);
    if (!row) return notFound();

    // 역할 재검증 — 주소를 만든 때가 아니라 지금 기준
    const access = await getFeedAccessForUser(row.userId);
    if (!access) return notFound();
    const kinds = kindsAllowedNow(row.kinds, access);
    if (kinds.length === 0) return notFound();

    const events = await loadPersonalIcsEvents(row.userId, kinds);
    void touchFeedToken(row.id);

    const body = buildIcsCalendar({ name: "스티즈 농구교실 내 일정", events });
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": 'inline; filename="stiz-my.ics"',
        "Cache-Control": NO_STORE,
        "X-Robots-Tag": "noindex",
      },
    });
  } catch (error) {
    // 일시적인 조회 실패 — 404 를 주면 캘린더 앱이 연동을 끊을 수 있어 «잠시 후 다시»로 답한다. 주소·확인 값은 남기지 않는다
    console.error("[calendar/feed] 일정 만들기 실패:", error instanceof Error ? error.message : "UNKNOWN");
    return new Response("Service Unavailable", { status: 503, headers: { "Cache-Control": NO_STORE } });
  }
}
