import { NextRequest, NextResponse } from "next/server";
import { runPosNoticeSweep } from "@/lib/pos/paymentNoticeService";

export const dynamic = "force-dynamic";

/**
 * 토스POS 결제 알림 스윕 (10분마다).
 *
 * 왜 필요한가: 웹훅을 받는 순간 바로 DM 을 보내 보지만, 토스 조회가 느리거나 슬랙이 잠깐
 * 실패하면 그 알림이 빠진다. POS 결제마다 DM 한 통이 원장의 유일한 안전망이라
 * 빠진 것을 10분마다 다시 줍는다(처리 안 된 웹훅 · DM 이 안 나간 알림).
 *
 * 여러 번 돌아도 안전하다: 알림은 결제 ID 로, DM 은 선점 UPDATE 로 한 번만 나간다.
 * 청구서(Payment)는 절대 건드리지 않는다.
 */
export async function GET(req: NextRequest) {
    const secret = process.env.CRON_SECRET;
    if (
        process.env.NODE_ENV !== "development" &&
        (!secret || req.headers.get("authorization") !== `Bearer ${secret}`)
    ) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const result = await runPosNoticeSweep();
    return NextResponse.json({ ok: true, ...result });
}
