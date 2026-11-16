import { buildIcsCalendar } from "@/lib/calendar/ics";
import { loadAcademyIcsEvents } from "@/lib/calendar/feedServer";

// 학원 일정 공개 구독 주소 — 로그인 없이 누구나(공개 연간일정표 /annual 과 같은 내용).
// 캘린더 앱이 주기적으로 다시 받아 간다. 원본(구글 캘린더·관리자 등록 일정)과 같은 5분 캐시.
// 캐시는 응답 머리말(s-maxage)로 건다 — 빌드할 때 미리 만들지 않아서, 실패 응답(503)이 5분 동안 굳는 일이 없다.
export const dynamic = "force-dynamic";
const CACHE_5_MIN = "public, max-age=300, s-maxage=300, stale-while-revalidate=600";

export async function GET() {
  try {
    const events = await loadAcademyIcsEvents();
    const body = buildIcsCalendar({ name: "스티즈 농구교실 일정", events });
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": 'inline; filename="stiz-academy.ics"',
        "Cache-Control": CACHE_5_MIN,
      },
    });
  } catch (error) {
    // 실패하면 «빈 캘린더»를 주지 않는다 — 캘린더 앱이 기존 일정을 지워 버린다. 다음 차례에 다시 받게 둔다
    console.error("[calendar/academy] 일정 만들기 실패:", error instanceof Error ? error.message : "UNKNOWN");
    return new Response("Service Unavailable", { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
