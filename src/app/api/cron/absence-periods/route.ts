import { NextRequest, NextResponse } from "next/server";
import { extendOpenAbsencePeriods } from "@/lib/regular/absence-period-runner";
import { withCronAlert } from "@/lib/cron/withCronAlert";
import { claimOpenEndedPeriodReminders } from "@/lib/regular/parent-absence-period";
import { notifyParentsOfStudents } from "@/lib/notification";
import { kstAt, kstLabel } from "@/lib/datetime/kst";

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
  // 학부모 «여러 날 결석»(2026-11-15) 중 끝일 «아직 몰라요» 기간 — 끝나기 전에 «연장/복귀» 앱 알림 1회(문자·알림톡 없음).
  // 자동 연장과 따로 실패한다 — 알림이 실패해도 위 연장 결과는 그대로 돌려준다(다음 날 다시 보내지는 않는다: 표시를 먼저 찍는다).
  let reminded = 0;
  try {
    for (const item of await claimOpenEndedPeriodReminders()) {
      try {
        await notifyParentsOfStudents(
          [item.studentId], "ABSENCE", "결석 기간이 곧 끝나요",
          `${item.studentName}의 결석 기간이 ${kstLabel(kstAt(item.endDate))}에 끝나요. 더 쉬면 «결석 알리기»에서 다시 알려 주시고, 나오면 «복귀했어요»를 눌러 주세요.`,
          "/mypage/regular-absence",
        );
        reminded += 1;
      } catch (error) {
        console.error("[cron/absence-periods] 기간 종료 안내 실패:", error instanceof Error ? error.name : "");
      }
    }
  } catch (error) {
    console.error("[cron/absence-periods] 기간 종료 안내 대상 조회 실패:", error instanceof Error ? error.name : "");
  }
  if (result.created > 0 || result.results.some((r) => r.error)) {
    console.log(`[cron/absence-periods] 기간 ${result.checked}건 확인 · 결석 ${result.created}회 추가`);
  }
  return NextResponse.json({ ok: true, ...result, reminded });
}

// 실패(예외·500 이상)하면 원장 슬랙으로 한 줄 알림 — 같은 작업은 1시간에 1번(d4)
export const GET = withCronAlert("absence-periods", handleGet);
