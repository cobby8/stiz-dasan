import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireStaffSessionAccess } from "@/lib/staff-class-access";
import { userFacingError } from "@/lib/user-facing-error";
import { checkSessionVideoFile, SESSION_VIDEO_BUCKET, sessionVideoStoragePath } from "@/lib/sessionVideo/rules";
import { ensureSessionVideoBucket, loadSessionForVideo, sessionVideoMaxBytes, uploadWindowError } from "@/lib/sessionVideo/server";

/** 수업 하나에 올릴 수 있는 영상 수(예약 포함) — 잘못 누른 반복 요청으로 저장소가 차지 않게 */
const MAX_VIDEOS_PER_SESSION = 20;

/**
 * 영상 «업로드 주소» 발급(선생님).
 * 왜 주소만 주나: Vercel 함수는 요청 본문이 4.5MB 로 막혀 영상을 받을 수 없다.
 * 그래서 서버는 권한·시간·형식·크기만 확인하고, 브라우저가 저장소(비공개 버킷)로 «직접» 올린다.
 * 주소를 줄 때 행을 «예약»으로 만들어 두고(registeredAt NULL), 업로드가 끝나면 POST …/videos 로 등록한다.
 * 등록되지 않은 예약은 cron(/api/cron/youtube-upload)이 저장소 파일까지 치운다.
 */
export async function POST(req: Request, context: { params: Promise<{ sessionId: string }> }) {
  try {
    const { sessionId } = await context.params;
    const session = await loadSessionForVideo(sessionId);
    if (!session) return NextResponse.json({ error: "수업 기록을 찾을 수 없습니다." }, { status: 404 });
    // 수업 시작·출석·사진과 같은 권한 함수(특강 회차면 특강 담당 강사 기준)
    const { access } = await requireStaffSessionAccess(sessionId);
    const windowError = uploadWindowError(session, access.canAccessAllClasses);
    if (windowError) return NextResponse.json({ error: windowError }, { status: 409 });

    const body = await req.json().catch(() => null) as { mimeType?: unknown; sizeBytes?: unknown; fileName?: unknown } | null;
    const maxBytes = await sessionVideoMaxBytes();
    const check = checkSessionVideoFile({
      mimeType: typeof body?.mimeType === "string" ? body.mimeType : null,
      fileName: typeof body?.fileName === "string" ? body.fileName.slice(0, 200) : null,
      sizeBytes: Number(body?.sizeBytes),
      maxBytes,
    });
    if (!check.ok) return NextResponse.json({ error: check.message, maxBytes }, { status: 400 });

    const countRows = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
      `SELECT COUNT(*)::int AS count FROM "SessionVideo" WHERE "sessionId" = $1 AND "deletedAt" IS NULL`,
      sessionId,
    );
    if ((countRows[0]?.count ?? 0) >= MAX_VIDEOS_PER_SESSION) {
      return NextResponse.json({ error: `한 수업에는 영상을 ${MAX_VIDEOS_PER_SESSION}개까지 올릴 수 있습니다.` }, { status: 409 });
    }

    await ensureSessionVideoBucket();
    const videoId = randomUUID();
    const storagePath = sessionVideoStoragePath({ classId: session.classId, sessionId, videoId, mimeType: check.mimeType });
    // 예약 행을 «먼저» 남긴다 — 업로드가 끊겨도 cron 이 이 행을 보고 파일을 치운다.
    await prisma.$executeRawUnsafe(
      `INSERT INTO "SessionVideo" (id, "sessionId", "storageBucket", "storagePath", "mimeType", "sizeBytes", "uploadedByUserId", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())`,
      videoId, sessionId, SESSION_VIDEO_BUCKET, storagePath, check.mimeType, Math.floor(Number(body?.sizeBytes)), access.staff.appUserId,
    );
    // 서명 업로드 주소(2시간 유효, 그 경로 한 개에만 쓸 수 있다. 덮어쓰기 금지)
    const { data, error } = await createAdminClient().storage.from(SESSION_VIDEO_BUCKET).createSignedUploadUrl(storagePath, { upsert: false });
    if (error || !data?.signedUrl) {
      await prisma.$executeRawUnsafe(`UPDATE "SessionVideo" SET "deletedAt" = NOW(), "youtubeStatus" = 'SKIPPED', "updatedAt" = NOW() WHERE id = $1`, videoId);
      throw new Error("영상 업로드 주소를 만들지 못했습니다. 잠시 뒤 다시 시도해 주세요.");
    }
    return NextResponse.json({ videoId, uploadUrl: data.signedUrl, mimeType: check.mimeType, maxBytes });
  } catch (error) {
    const message = userFacingError(error, "영상 업로드를 준비하지 못했습니다.");
    return NextResponse.json({ error: message }, { status: error instanceof Error && error.message.includes("권한") ? 403 : 500 });
  }
}
