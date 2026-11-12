import { NextRequest, NextResponse } from "next/server";
import { withCronAlert } from "@/lib/cron/withCronAlert";

export const dynamic = "force-dynamic";

async function handleGet(req: NextRequest) {
    const cronSecret = process.env.CRON_SECRET;
    if (process.env.NODE_ENV !== "development") {
        if (!cronSecret || req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
    }

    return NextResponse.json({
        success: true,
        mode: "manual",
        message: "자동 청구 생성은 비활성화되어 있습니다. 관리자 페이지에서 미리보기 후 수동 발행합니다.",
    });
}

// 실패(예외·500 이상)하면 원장 슬랙으로 한 줄 알림 — 같은 작업은 1시간에 1번(d4)
export const GET = withCronAlert("billing", handleGet);
