import { NextRequest, NextResponse } from "next/server";
import { applyDueEnrollmentChangesWithSummary } from "@/lib/enrollment/admin-change-request";
import { revalidateEnrollmentStatusCaches } from "@/lib/enrollment/change-cache";

export const dynamic = "force-dynamic";

/**
 * 승인된 수강 변경을 적용일에 처리한다(매일 KST 00:10).
 *
 * 승인은 "예약"이다. 원장이 8월에 승인해도 변경은 9월 1일에 일어나야
 * 8월 남은 수업의 출석부와 청구가 어긋나지 않는다.
 * 원장 결정(2026-10-05): 휴원·퇴원은 사이트 수강 상태를 자동으로 바꾸고 시트·랠리즈는 "확인 필요"로 남긴다.
 * 반 변경은 보류(HELD) 원장만 만든다. 이미 처리한 건은 건너뛰므로 두 번 실행돼도 안전하다.
 */
export async function GET(req: NextRequest) {
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
  // applied = 사이트에 실제 적용한 건수, held = 사람 확인이 필요해 보류 원장만 만든 건수
  return NextResponse.json({ ok: true, applied, held });
}
