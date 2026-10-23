import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedParent } from "@/lib/auth-guard";
import {
  submitShuttleException,
  cancelShuttleException,
  getShuttleExceptionOptions,
  getParentShuttleExceptionStatus,
} from "@/lib/shuttle/parent-shuttle-exception";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  let parent;
  try { parent = await requireVerifiedParent(); }
  catch { return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 }); }
  try {
    const id = request.nextUrl.searchParams.get("id");
    if (id) {
      const record = await getParentShuttleExceptionStatus(parent.appUserId, id);
      if (!record) return NextResponse.json({ error: "신청을 찾을 수 없습니다." }, { status: 404 });
      return NextResponse.json({ record });
    }
    return NextResponse.json(await getShuttleExceptionOptions(parent.appUserId));
  } catch {
    return NextResponse.json({ error: "저장 결과를 조회하지 못했습니다." }, { status: 503 });
  }
}

// 신청(submit) / 취소(cancel) — body.action 으로 분기
export async function POST(request: NextRequest) {
  let parent;
  try {
    parent = await requireVerifiedParent();
  } catch {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("INVALID_BODY");
    body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  try {
    const result =
      body?.action === "cancel"
        ? await cancelShuttleException(parent.appUserId, String(body?.id ?? ""))
        : await submitShuttleException(parent.appUserId, body ?? {});
    if (!result.ok) return NextResponse.json({ error: result.message }, { status: 400 });
    // 장부 원본에는 내부 수신자 ID가 있으므로 부모에게는 요약만 반환한다.
    const { notification, ...safeResult } = result;
    return NextResponse.json({ ...safeResult, notification: notification ? {
      driver: notification.driver, admin: notification.admin, coach: notification.coach,
      recipientCount: notification.recipientCount, deliveredCount: notification.deliveredCount, failedCount: notification.failedCount,
    } : null });
  } catch (error) {
    console.error("[api/mypage/shuttle-exception] POST failed:", error);
    return NextResponse.json({ error: "처리에 실패했습니다." }, { status: 500 });
  }
}
