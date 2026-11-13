import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireStaffSessionAccess } from "@/lib/staff-class-access";
import { userFacingError } from "@/lib/user-facing-error";
import { isValidSessionVideoRef } from "@/lib/sessionVideo/rules";
import { loadSessionForVideo, uploadWindowError } from "@/lib/sessionVideo/server";

/**
 * 영상 삭제(선생님) — 올리기와 같은 시간 범위(수업 당일 KST 자정까지)만.
 * 1) DB 에서 먼저 «지움» 표시(deletedAt) → 학부모 화면에서 바로 사라진다.
 * 2) 저장소 사본은 여기서 바로 지워 보고, 실패하면 cron 이 다시 지운다.
 * 3) 유튜브에 이미 올라간 영상은 cron 이 유튜브에서 지운다(구글 호출을 이 요청에 붙이지 않는다).
 */
export async function DELETE(_req: Request, context: { params: Promise<{ sessionId: string; videoId: string }> }) {
  try {
    const { sessionId, videoId } = await context.params;
    const session = await loadSessionForVideo(sessionId);
    if (!session) return NextResponse.json({ error: "수업 기록을 찾을 수 없습니다." }, { status: 404 });
    await requireStaffSessionAccess(sessionId);
    const windowError = uploadWindowError(session);
    if (windowError) return NextResponse.json({ error: windowError }, { status: 409 });

    // 주소의 수업에 속한 영상만(다른 수업 영상 ID 로 지우기 차단 — IDOR)
    const rows = await prisma.$queryRawUnsafe<Array<{ id: string; storageBucket: string; storagePath: string }>>(
      `UPDATE "SessionVideo"
          SET "deletedAt" = NOW(),
              "youtubeStatus" = CASE WHEN "youtubeStatus" = 'PENDING' THEN 'SKIPPED' ELSE "youtubeStatus" END,
              "updatedAt" = NOW()
        WHERE id = $1 AND "sessionId" = $2 AND "deletedAt" IS NULL
        RETURNING id, "storageBucket", "storagePath"`,
      videoId, sessionId,
    );
    const video = rows[0];
    if (!video) return NextResponse.json({ error: "영상을 찾을 수 없습니다." }, { status: 404 });

    if (isValidSessionVideoRef({ ...video, classId: session.classId, sessionId, videoId: video.id })) {
      const { error } = await createAdminClient().storage.from(video.storageBucket).remove([video.storagePath]);
      if (!error) {
        await prisma.$executeRawUnsafe(
          `UPDATE "SessionVideo" SET "storageDeletedAt" = NOW(), "updatedAt" = NOW() WHERE id = $1 AND "storageDeletedAt" IS NULL`,
          video.id,
        );
      }
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = userFacingError(error, "영상을 삭제하지 못했습니다.");
    return NextResponse.json({ error: message }, { status: error instanceof Error && error.message.includes("권한") ? 403 : 500 });
  }
}
