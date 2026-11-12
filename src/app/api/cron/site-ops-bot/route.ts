import { NextRequest, NextResponse } from "next/server";
import { runSiteOpsBot } from "@/lib/siteOpsBot";
import { withCronAlert } from "@/lib/cron/withCronAlert";

export const dynamic = "force-dynamic";

async function handleGet(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;

  if (process.env.NODE_ENV !== "development") {
    if (!cronSecret || req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  try {
    const result = await runSiteOpsBot("cron");

    console.log(
      `[cron/site-ops-bot] ok=${result.ok} fixed=${result.fixedCount} manual=${result.manualActionCount} critical=${result.criticalCount} notified=${result.notified}`,
    );

    return NextResponse.json({
      success: result.ok,
      ...result,
    });
  } catch (error) {
    console.error("[cron/site-ops-bot] failed:", error);
    return NextResponse.json({ error: "Failed to run site ops bot" }, { status: 500 });
  }
}

// 실패(예외·500 이상)하면 원장 슬랙으로 한 줄 알림 — 같은 작업은 1시간에 1번(d4)
export const GET = withCronAlert("site-ops-bot", handleGet);
