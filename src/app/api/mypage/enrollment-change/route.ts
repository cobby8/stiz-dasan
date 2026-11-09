import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedParent } from "@/lib/auth-guard";
import {
  getEnrollmentChangeOptions,
  submitEnrollmentChangeRequest,
  cancelEnrollmentChangeRequest,
  requestScheduledChangeCancel,
} from "@/lib/enrollment/parent-change-request";

export const dynamic = "force-dynamic";

// 신청 가능한 반 목록 + 자녀별 현재 반 + 진행 중 신청
export async function GET() {
  let parent;
  try {
    parent = await requireVerifiedParent();
  } catch {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }
  try {
    const data = await getEnrollmentChangeOptions(parent.appUserId);
    return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[api/mypage/enrollment-change] GET failed:", error);
    return NextResponse.json({ error: "조회에 실패했습니다." }, { status: 500 });
  }
}

// 신청(submit) / 신청 취소(cancel) / 승인된 휴원·퇴원 취소 요청(cancel-request, d8) — body.action 으로 분기
export async function POST(request: NextRequest) {
  let parent;
  try {
    parent = await requireVerifiedParent();
  } catch {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  try {
    const result =
      body?.action === "cancel"
        ? await cancelEnrollmentChangeRequest(parent.appUserId, String(body?.id ?? ""))
        : body?.action === "cancel-request"
          ? await requestScheduledChangeCancel(parent.appUserId, String(body?.id ?? ""), body?.reason)
          : await submitEnrollmentChangeRequest(parent.appUserId, body ?? {});
    if (!result.ok) return NextResponse.json({ error: result.message }, { status: 400 });
    return NextResponse.json(result);
  } catch (error) {
    console.error("[api/mypage/enrollment-change] POST failed:", error);
    return NextResponse.json({ error: "처리에 실패했습니다." }, { status: 500 });
  }
}
