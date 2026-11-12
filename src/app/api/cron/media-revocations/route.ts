import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { processMediaRevocationQueue } from "@/lib/mediaRevocationQueue";
import { processSessionPhotoDeletionQueue } from "@/lib/sessionPhotoDeletionQueue";
import { withCronAlert } from "@/lib/cron/withCronAlert";

export const dynamic = "force-dynamic";

async function handleGet(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (process.env.NODE_ENV !== "development"
    && (!secret || req.headers.get("authorization") !== `Bearer ${secret}`)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const [result, photoDeletion] = await Promise.all([
    processMediaRevocationQueue(20),
    processSessionPhotoDeletionQueue(20),
  ]);
  if (result.removed > 0) {
    revalidatePath("/admin/gallery");
    revalidatePath("/gallery");
    revalidatePath("/");
  }
  const success = result.failed === 0 && photoDeletion.failed === 0;
  return NextResponse.json({ success, ...result, photoDeletion });
}

// 실패(예외·500 이상)하면 원장 슬랙으로 한 줄 알림 — 같은 작업은 1시간에 1번(d4)
export const GET = withCronAlert("media-revocations", handleGet);
