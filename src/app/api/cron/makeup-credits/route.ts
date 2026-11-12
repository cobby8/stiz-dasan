import { NextRequest, NextResponse } from "next/server";
import { expireOverdueCredits } from "@/lib/makeup/credit-service";
import { withCronAlert } from "@/lib/cron/withCronAlert";

export const dynamic = "force-dynamic";

/**
 * 기간이 지난 보강권을 소멸시킨다(매일 KST 00:30).
 *
 * 약관: "결석이 발생한 날로부터 2개월 이내 사용, 지나면 자동 소멸".
 * 화면은 크론과 무관하게 시각 기준으로 만료를 보여 주므로(summarize),
 * 이 크론이 하루 늦게 돌아도 학부모가 만료된 보강권을 쓸 수는 없다.
 * 여기서 하는 일은 상태를 실제 데이터에 확정 짓는 것이다.
 */
async function handleGet(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (
    process.env.NODE_ENV !== "development" &&
    (!secret || req.headers.get("authorization") !== `Bearer ${secret}`)
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { expired } = await expireOverdueCredits();
  if (expired > 0) console.log(`[cron/makeup-credits] 보강권 ${expired}장 소멸`);
  return NextResponse.json({ ok: true, expired });
}

// 실패(예외·500 이상)하면 원장 슬랙으로 한 줄 알림 — 같은 작업은 1시간에 1번(d4)
export const GET = withCronAlert("makeup-credits", handleGet);
