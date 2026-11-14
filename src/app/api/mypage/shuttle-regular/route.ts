import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedParent } from "@/lib/auth-guard";
import {
  cancelRegularChangeRequest,
  getRegularChangeOptions,
  submitRegularChangeRequest,
} from "@/lib/shuttle/regularChangeRequest";

export const dynamic = "force-dynamic";

// 셔틀 타는 곳·내리는 곳 «앞으로 계속» 바꾸기 신청(2026-11-14 결정표 c5).
// 로그인한 학부모만 — 아이·요일·명단 상황은 서버가 다시 읽어 판정한다(화면이 보낸 값을 믿지 않는다).

export async function GET() {
  let parent;
  try { parent = await requireVerifiedParent(); }
  catch { return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 }); }
  try {
    return NextResponse.json(await getRegularChangeOptions(parent.appUserId), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[api/mypage/shuttle-regular] GET failed:", error instanceof Error ? error.name : "");
    return NextResponse.json({ error: "조회에 실패했습니다." }, { status: 500 });
  }
}

// 신청(submit) / 취소(cancel) — body.action 으로 분기
export async function POST(request: NextRequest) {
  let parent;
  try { parent = await requireVerifiedParent(); }
  catch { return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 }); }

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("INVALID_BODY");
    body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  try {
    const result = body.action === "cancel"
      ? await cancelRegularChangeRequest(parent.appUserId, body.id)
      : await submitRegularChangeRequest(parent.appUserId, body);
    // code(예: DAILY_LIMIT — 하루 접수 상한)가 있으면 함께 내려 화면이 «학원에 전화하기» 버튼을 보이게 한다
    if (!result.ok) return NextResponse.json({ error: result.message, ...("code" in result && result.code ? { code: result.code } : {}) }, { status: 400 });
    return NextResponse.json(result);
  } catch (error) {
    console.error("[api/mypage/shuttle-regular] POST failed:", error instanceof Error ? error.name : "");
    return NextResponse.json({ error: "처리에 실패했습니다." }, { status: 500 });
  }
}
