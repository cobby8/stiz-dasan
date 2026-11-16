import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-guard";
import { todayKst } from "@/lib/datetime/kst";
import { getClassDayBoard } from "@/lib/class-nudge/boardServer";

// 관리자 대시보드 «오늘 수업 처리 현황»(2026-11-17) 읽기.
// 원장·부원장만. 금액·연락처는 싣지 않아 부원장도 그대로 본다.
// 브라우저 캐시 금지 — «지금 시각» 기준 판정이라 받아 둔 응답을 다시 쓰면 낡은 상태가 보인다.
const NO_STORE = { "Cache-Control": "private, no-store" };

export const dynamic = "force-dynamic";

export async function GET() {
    try {
        await requireAdmin();
    } catch {
        return NextResponse.json({ error: "Authentication required" }, { status: 401, headers: NO_STORE });
    }

    try {
        // 날짜 인자를 받지 않는다(1단계는 오늘만). nowMs 는 절대 시각이라 서버 시간대와 무관하고, «오늘»은 KST 로 바꿔 구한다.
        const nowMs = Date.now();
        const board = await getClassDayBoard(todayKst(nowMs), nowMs);
        return NextResponse.json(board, { headers: NO_STORE });
    } catch (error) {
        console.error("[api/admin/class-day-board] failed:", error);
        return NextResponse.json({ error: "Failed to load class day board" }, { status: 500, headers: NO_STORE });
    }
}
