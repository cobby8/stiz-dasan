import { NextRequest, NextResponse } from "next/server";
import { runAdminDailyDigest } from "@/lib/admin-daily-digest-service";

export const dynamic = "force-dynamic";

/**
 * 원장 아침 요약 알림(매일 KST 08:30 = UTC 23:30).
 *
 * 미납·수강 변경 확인 필요·승인 대기를 한 건으로 묶어 원장·부원장에게만 앱 알림 + 웹 푸시로 보낸다.
 * 학부모 발송·문자(SMS)는 없다. 같은 날 두 번 돌아도 관리자당 한 번만 보낸다.
 */
export async function GET(req: NextRequest) {
  // Vercel Cron 인증 — 다른 크론과 같은 방식(CRON_SECRET Bearer)
  const secret = process.env.CRON_SECRET;
  if (
    process.env.NODE_ENV !== "development" &&
    (!secret || req.headers.get("authorization") !== `Bearer ${secret}`)
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await runAdminDailyDigest();
  if (result.sent > 0) console.log(`[cron/admin-daily-digest] 관리자 ${result.sent}명에게 요약 알림`);
  return NextResponse.json({ ok: true, ...result });
}
