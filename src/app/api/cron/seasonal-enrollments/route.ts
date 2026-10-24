import { NextRequest, NextResponse } from "next/server";
import { endFinishedSeasonalEnrollments } from "@/lib/seasonal/auto-end";

export const dynamic = "force-dynamic";

/**
 * 끝난 방학특강 수강을 퇴원(WITHDRAWN) 처리한다(매일 KST 00:20).
 *
 * 특강 전용 반(dayOfWeek='Seasonal')에 연결된 모든 특강의 마지막 회차가 어제 이전이면
 * 그 반의 ACTIVE·PAUSED 수강을 WITHDRAWN 으로 바꾸고 변경 이력을 남긴다.
 * 정규반은 대상이 아니다. 자세한 규칙은 src/lib/seasonal/auto-end.ts.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (
    process.env.NODE_ENV !== "development" &&
    (!secret || req.headers.get("authorization") !== `Bearer ${secret}`)
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { ended, items } = await endFinishedSeasonalEnrollments();
  if (ended > 0) console.log(`[cron/seasonal-enrollments] 특강 수강 ${ended}건 퇴원 처리`);
  return NextResponse.json({ ok: true, ended, items });
}
