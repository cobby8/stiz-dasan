import { NextRequest, NextResponse } from "next/server";
import { extendOpenAbsencePeriods } from "@/lib/regular/absence-period-runner";
import { withCronAlert } from "@/lib/cron/withCronAlert";

export const dynamic = "force-dynamic";

/**
 * 기간 결석 자동 연장(매일 KST 00:40).
 *
 * «복귀 미정» 기간 결석은 등록할 때 KST 다음 달 말일까지만 날짜별 결석을 만들어 둔다.
 * 매일 이 크론이 그 끝을 다시 «다음 달 말일»로 늘리고, 그 사이 새로 수강 시작한 반의 수업일도 채운다.
 * 연간 일정에 아직 없는 달은 건너뛰었다가 일정이 들어온 다음 날 채운다. 하루에 여러 번 돌아도 안전하다(이미 만든 날은 다시 안 만든다).
 * 학부모·코치·기사 알림은 보내지 않는다.
 */
async function handleGet(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (
    process.env.NODE_ENV !== "development" &&
    (!secret || req.headers.get("authorization") !== `Bearer ${secret}`)
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await extendOpenAbsencePeriods();
  if (result.created > 0 || result.results.some((r) => r.error)) {
    console.log(`[cron/absence-periods] 기간 ${result.checked}건 확인 · 결석 ${result.created}회 추가`);
  }
  return NextResponse.json({ ok: true, ...result });
}

// 실패(예외·500 이상)하면 원장 슬랙으로 한 줄 알림 — 같은 작업은 1시간에 1번(d4)
export const GET = withCronAlert("absence-periods", handleGet);
