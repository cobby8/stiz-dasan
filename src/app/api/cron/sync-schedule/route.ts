/**
 * GET /api/cron/sync-schedule
 *
 * 구글 시트 → DB 동기화 예비 엔드포인트.
 * 기본 운영은 /api/admin/sync-schedule 수동 동기화를 사용한다.
 * 자동 동기화가 필요해지면 vercel.json crons에 다시 등록한다.
 *
 * (2026-10-06) 구글 시트 원장 은퇴 — 은퇴 상태면 시트를 읽지 않고 410(Gone)을 돌려준다.
 * 라우트는 지우지 않는다: STIZ_SHEET_SYNC_RETIRED="0" 이면 옛 동작 그대로 되살아난다.
 */

import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { syncSheetSlots } from "@/lib/syncSheetSlots";
import { isSheetSyncRetired } from "@/lib/operations-sync/sheetRetirement";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
    // Cron 인증 필수화 — CRON_SECRET 없으면 무조건 거부 (개발환경 예외)
    const cronSecret = process.env.CRON_SECRET;
    if (process.env.NODE_ENV !== "development") {
        if (!cronSecret || req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
    }

    // 시트 원장 은퇴면 시트를 읽지 않는다(시간표 원본은 사이트 DB ScheduleSlot)
    if (isSheetSyncRetired(process.env)) {
        return NextResponse.json({ error: "구글 시트 원장이 종료되어(2026-10) 시간표 시트 동기화를 하지 않습니다.", retired: true }, { status: 410 });
    }

    const result = await syncSheetSlots();

    if ("error" in result) {
        console.error("[cron/sync-schedule]", result.error);
        return NextResponse.json({ error: result.error }, { status: 400 });
    }

    revalidatePath("/schedule");
    revalidatePath("/simulator");

    console.log(`[cron/sync-schedule] 완료: ${result.synced}개 슬롯, ${result.syncedAt}`);
    return NextResponse.json({ success: true, ...result });
}
