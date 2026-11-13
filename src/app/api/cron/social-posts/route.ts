import { NextRequest, NextResponse } from "next/server";
import { revalidatePath, revalidateTag } from "next/cache";
import { processSocialPostPublishQueue } from "@/lib/socialPostPublishing";
import { withCronAlert } from "@/lib/cron/withCronAlert";

export const dynamic = "force-dynamic";
// 2026-11-14 검수: 실행 시간 제한을 명시한다(vercel.json 의 기본값과 같은 60초).
// «시도 잡기»가 5분 동안 유효하므로 이 값은 반드시 5분보다 짧아야 한다 — 길어지면 한 초안을 두 실행이 동시에 잡을 수 있다.
export const maxDuration = 60;

async function handleGet(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (process.env.NODE_ENV !== "development") {
    if (!cronSecret || req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const result = await processSocialPostPublishQueue(1);

  if (result.processed > 0) {
    revalidateTag("admin-gallery", { expire: 0 });
    revalidatePath("/admin/gallery");
    revalidatePath("/staff/quick-post");
    revalidatePath("/gallery");
    revalidatePath("/mypage");
    revalidatePath("/");
  }

  console.log(
    `[cron/social-posts] processed=${result.processed} succeeded=${result.succeeded} retry=${result.retryScheduled} failed=${result.failed}`,
  );

  return NextResponse.json({
    success: result.ok,
    ...result,
  });
}

// 실패(예외·500 이상)하면 원장 슬랙으로 한 줄 알림 — 같은 작업은 1시간에 1번(d4)
export const GET = withCronAlert("social-posts", handleGet);
