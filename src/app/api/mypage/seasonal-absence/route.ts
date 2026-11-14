import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedParent } from "@/lib/auth-guard";
import {
  getUpcomingSeasonalSeats,
  reportSeasonalAbsence,
  cancelSeasonalAbsence,
} from "@/lib/seasonal/parent-absence";

export const dynamic = "force-dynamic";

// 예정 회차 목록 조회
export async function GET() {
  let parent;
  try {
    parent = await requireVerifiedParent();
  } catch {
    return NextResponse.json({ error: "로그인이 필요해요." }, { status: 401 });
  }
  try {
    return NextResponse.json(await getUpcomingSeasonalSeats(parent.appUserId), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("[api/mypage/seasonal-absence] GET failed:", error);
    return NextResponse.json({ error: "불러오지 못했어요." }, { status: 500 });
  }
}

// 결석 신고(report) / 신고 취소(cancel) — body.action 으로 분기
export async function POST(request: NextRequest) {
  let parent;
  try {
    parent = await requireVerifiedParent();
  } catch {
    return NextResponse.json({ error: "로그인이 필요해요." }, { status: 401 });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const action = body?.action;
  if (!body?.enrollmentDateId) {
    return NextResponse.json({ error: "필수 값이 없어요." }, { status: 400 });
  }

  try {
    let result;
    if (action === "cancel") {
      result = await cancelSeasonalAbsence(parent.appUserId, {
        enrollmentDateId: body.enrollmentDateId,
      });
    } else {
      // 기본 = 신고(report)
      result = await reportSeasonalAbsence(parent.appUserId, {
        enrollmentDateId: body.enrollmentDateId,
        reason: body.reason,
      });
    }
    return NextResponse.json(result);
  } catch (error) {
    const code = error instanceof Error ? error.message : "UNKNOWN";
    // 에러코드 → 학부모용 한국어 메시지
    const map: Record<string, string> = {
      NOT_OWNER: "본인 자녀의 회차만 알릴 수 있어요.",
      INVALID_REASON: "결석 사유를 선택해 주세요.",
      SEAT_NOT_FOUND: "회차를 찾을 수 없어요.",
      SEAT_NOT_SCHEDULED: "신청이 유효한 회차만 알릴 수 있어요.",
      PAST_SESSION: "지난 회차는 알릴 수 없어요.",
      ALREADY_CHECKED: "이미 출결이 확정된 회차예요. 학원에 문의해 주세요.",
      ABSENCE_NOT_CANCELABLE: "이미 학원에서 처리된 결석이라 취소할 수 없어요.",
      PARENT_PHONE_UNKNOWN: "계정에 등록된 전화번호가 없어요.",
    };
    const known = map[code];
    if (!known) console.error("[api/mypage/seasonal-absence] POST failed:", error);
    return NextResponse.json({ error: known || "처리하지 못했어요." }, { status: known ? 409 : 500 });
  }
}
