import { NextRequest, NextResponse } from "next/server";
import { ensureRegularRosterMonths } from "@/lib/shuttle/regularRosterEdit";

export const dynamic = "force-dynamic";

/**
 * 셔틀 명단 월 자동 생성(매일 KST 00:05).
 *
 * 이번 달과 다음 달 명단이 항상 있게 한다 — 원장이 다음 달 수강 변경을 미리 반영할 수 있도록.
 * 없는 달만 직전 달을 복사해 만들고, 이미 있으면 아무것도 하지 않는다(하루에 여러 번 돌아도 안전).
 * 셔틀 명단·정규 배차 화면을 열 때도 같은 함수가 돌므로, 이 크론이 하루 빠져도 화면에서 채워진다.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (
    process.env.NODE_ENV !== "development" &&
    (!secret || req.headers.get("authorization") !== `Bearer ${secret}`)
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await ensureRegularRosterMonths();
  if (result.created.length > 0) {
    console.log(`[cron/regular-shuttle-months] ${result.created.map((c) => `${c.sourceMonth}→${c.targetMonth}(${c.copied}행·노선 ${c.routesCopied})`).join(", ")}`);
  }
  return NextResponse.json({ ok: true, ...result });
}
