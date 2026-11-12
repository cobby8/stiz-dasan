import { NextRequest, NextResponse } from "next/server";
import { applyDueEnrollmentChangesWithSummary } from "@/lib/enrollment/admin-change-request";
import { revalidateEnrollmentStatusCaches } from "@/lib/enrollment/change-cache";
import { applyOpenPauseCarries } from "@/lib/enrollment/pause-settlement";
import { prisma } from "@/lib/prisma";
import { withCronAlert } from "@/lib/cron/withCronAlert";

export const dynamic = "force-dynamic";

/**
 * 승인된 수강 변경을 적용일에 처리한다(매일 KST 00:10).
 *
 * 승인은 "예약"이다. 원장이 8월에 승인해도 변경은 9월 1일에 일어나야
 * 8월 남은 수업의 출석부와 청구가 어긋나지 않는다.
 * 원장 결정(2026-10-05): 휴원·퇴원은 사이트 수강 상태를 자동으로 바꾸고 시트·랠리즈는 "확인 필요"로 남긴다.
 * 반 변경은 보류(HELD) 원장만 만든다. 이미 처리한 건은 건너뛰므로 두 번 실행돼도 안전하다.
 * 휴원 수강료 «이월»(2026-11-10 m6)이 남아 있으면 그사이 생긴 다음 미납 청구에서 뺀다(전역 잠금 안, 두 번 실행돼도 안전).
 */
async function handleGet(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (
    process.env.NODE_ENV !== "development" &&
    (!secret || req.headers.get("authorization") !== `Bearer ${secret}`)
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { applied, held } = await applyDueEnrollmentChangesWithSummary();
  // 수강 상태가 바뀌었으니 관리자 즉시 변경과 같은 범위의 캐시를 비운다.
  if (applied > 0) revalidateEnrollmentStatusCaches();
  // 이월 차감 실패가 적용 결과를 가리지 않게 따로 잡는다(남은 이월은 다음 날 다시)
  const carry = await applyOpenPauseCarries(prisma as any).catch((error) => {
    console.error("[cron/enrollment-changes] 휴원 이월 차감 실패", error instanceof Error ? error.name : "");
    return { applied: 0, amount: 0 };
  });
  // applied = 사이트에 실제 적용한 건수, held = 사람 확인이 필요해 보류 원장만 만든 건수, carryApplied = 이월을 뺀 청구 수
  return NextResponse.json({ ok: true, applied, held, carryApplied: carry.applied });
}

// 실패(예외·500 이상)하면 원장 슬랙으로 한 줄 알림 — 같은 작업은 1시간에 1번(d4)
export const GET = withCronAlert("enrollment-changes", handleGet);
