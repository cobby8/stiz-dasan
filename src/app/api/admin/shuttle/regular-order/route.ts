import { NextResponse } from "next/server";
import { saveRegularStopOrder } from "@/lib/shuttle/regularImport";
import { validateRegularStopOrderPayload } from "@/lib/regular/regularOrderPayload";

export const dynamic = "force-dynamic";

// 정규 셔틀 정차 순서·도착시각 저장. requireAdmin은 라이브러리에서 강제.
export async function POST(request: Request) {
  try {
    // 월과 행 구조를 한 검증기에서 확인해 다른 월의 정류장을 잘못 수정하지 않게 한다.
    const body = validateRegularStopOrderPayload(await request.json().catch(() => null));
    const result = await saveRegularStopOrder(body.updates, body.serviceMonth);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    console.error("[regular-order POST]", e);
    const msg = String((e as { message?: string })?.message ?? "");
    const status = /원장|권한|로그인|인증|Unauthorized|Forbidden/i.test(msg) ? 403 : 400;
    return NextResponse.json({ error: msg || "저장하지 못했습니다." }, { status });
  }
}
