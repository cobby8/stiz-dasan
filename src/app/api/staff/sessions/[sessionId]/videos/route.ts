import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireStaffSessionAccess } from "@/lib/staff-class-access";
import { userFacingError } from "@/lib/user-facing-error";
import { classifyStaffFailure, staffAccessFailure } from "@/lib/staff-session-rules";
import { checkSessionVideoFile, isValidSessionVideoRef, oversizeMessage } from "@/lib/sessionVideo/rules";
import { listSessionVideos, loadSessionForVideo, sessionVideoMaxBytes, toPlayback, uploadWindowError } from "@/lib/sessionVideo/server";

/**
 * 선생님 화면의 영상 목록(미리보기 재생 정보 + 지금 올리거나 지울 수 있는지).
 * 보기는 수업 권한만 있으면 되고, 올리기·지우기는 «수업 기록 수정 기간»(선생님 수업일 포함 7일·원장·부원장 제한 없음) 안에서만(canManage).
 */
export async function GET(_req: Request, context: { params: Promise<{ sessionId: string }> }) {
  let sessionId = "";
  try {
    ({ sessionId } = await context.params);
    const session = await loadSessionForVideo(sessionId);
    if (!session) return NextResponse.json({ error: "수업 기록을 찾을 수 없습니다." }, { status: 404 });
    const { access } = await requireStaffSessionAccess(sessionId);
    const [videos, maxBytes] = await Promise.all([listSessionVideos(sessionId).then(toPlayback), sessionVideoMaxBytes()]);
    // 원장·부원장은 수정 기간 제한이 없다(선생님은 수업일 포함 7일)
    const windowError = uploadWindowError(session, access.canAccessAllClasses);
    return NextResponse.json(
      { videos, canManage: windowError === null, windowMessage: windowError, maxBytes },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    // 2026-11-15 검수: 예전엔 모든 오류를 403 으로 돌려, DB·저장소 문제도 «권한 없음»처럼 보여 원인을 알 수 없었다.
    // 권한 판정 자체는 그대로(requireStaffSessionAccess) — 돌려주는 상태 코드와 문구만 가른다.
    const raw = error instanceof Error ? error.message : String(error ?? "");
    const kind = classifyStaffFailure(raw);
    const access = staffAccessFailure(error);
    if (kind === "login" && access) return NextResponse.json({ error: access.message }, { status: 401 });
    if (kind === "forbidden" && access) return NextResponse.json({ error: access.message }, { status: 403 });
    // 서버 내부 오류(DB·저장소 서명 등) — 원인은 서버 로그에만 남긴다. 주소의 서명·토큰이 섞이지 않게 물음표 뒤는 지운다.
    console.error("[staff videos GET] 영상 목록 조회 실패", {
      sessionId,
      name: error instanceof Error ? error.name : typeof error,
      reason: raw.replace(/\?[^\s"']*/g, "?…").slice(0, 200),
    });
    return NextResponse.json({ error: "영상 목록을 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요." }, { status: 500 });
  }
}

/**
 * 업로드 끝난 영상 «등록». 저장소에 실제 파일이 있는지·크기·형식을 서버가 다시 확인한 뒤에만
 * registeredAt 을 찍는다(브라우저가 보낸 크기·형식은 믿지 않는다).
 * 등록되면 유튜브 이동 대기(PENDING)가 되고, 학부모 화면에 보인다. 학부모 알림은 보내지 않는다(원장 결정).
 */
export async function POST(req: Request, context: { params: Promise<{ sessionId: string }> }) {
  try {
    const { sessionId } = await context.params;
    const session = await loadSessionForVideo(sessionId);
    if (!session) return NextResponse.json({ error: "수업 기록을 찾을 수 없습니다." }, { status: 404 });
    const { access } = await requireStaffSessionAccess(sessionId);
    const windowError = uploadWindowError(session, access.canAccessAllClasses);
    if (windowError) return NextResponse.json({ error: windowError }, { status: 409 });

    const body = await req.json().catch(() => null) as { videoId?: unknown; durationSec?: unknown } | null;
    const videoId = typeof body?.videoId === "string" ? body.videoId : "";
    const duration = Number(body?.durationSec);
    const durationSec = Number.isFinite(duration) && duration > 0 && duration < 24 * 3600 ? Math.round(duration) : null;

    // 주소의 수업과 같은 수업의 «예약» 행만 등록한다(다른 수업 영상 ID 를 넣어도 못 건드린다 — IDOR)
    const rows = await prisma.$queryRawUnsafe<Array<{ id: string; storageBucket: string; storagePath: string; mimeType: string }>>(
      `SELECT id, "storageBucket", "storagePath", "mimeType" FROM "SessionVideo"
        WHERE id = $1 AND "sessionId" = $2 AND "registeredAt" IS NULL AND "deletedAt" IS NULL LIMIT 1`,
      videoId, sessionId,
    );
    const video = rows[0];
    if (!video) return NextResponse.json({ error: "등록할 영상을 찾을 수 없습니다. 다시 올려 주세요." }, { status: 404 });
    if (!isValidSessionVideoRef({ ...video, classId: session.classId, sessionId, videoId: video.id })) {
      return NextResponse.json({ error: "영상 저장 경로가 올바르지 않습니다." }, { status: 400 });
    }

    const { data: info, error } = await createAdminClient().storage.from(video.storageBucket).info(video.storagePath);
    if (error || !info) return NextResponse.json({ error: "영상 업로드가 끝나지 않았습니다. 다시 올려 주세요." }, { status: 409 });
    const maxBytes = await sessionVideoMaxBytes();
    const size = Number(info.size ?? info.metadata?.size);
    const check = checkSessionVideoFile({ mimeType: info.contentType ?? info.metadata?.mimetype ?? video.mimeType, sizeBytes: size, maxBytes });
    if (!check.ok) {
      // 크기·형식이 맞지 않는 파일은 등록하지 않고 지운다(cron 이 예약 행을 정리)
      await createAdminClient().storage.from(video.storageBucket).remove([video.storagePath]).catch(() => undefined);
      return NextResponse.json({ error: size > maxBytes ? oversizeMessage(maxBytes) : check.message }, { status: 400 });
    }

    const updated = await prisma.$executeRawUnsafe(
      `UPDATE "SessionVideo"
          SET "registeredAt" = NOW(), "sizeBytes" = $3, "mimeType" = $4, "durationSec" = $5,
              "youtubeStatus" = 'PENDING', "updatedAt" = NOW()
        WHERE id = $1 AND "sessionId" = $2 AND "registeredAt" IS NULL AND "deletedAt" IS NULL`,
      video.id, sessionId, Math.floor(size), check.mimeType, durationSec,
    );
    if (updated !== 1) return NextResponse.json({ error: "영상 상태가 바뀌었습니다. 목록을 새로 불러와 주세요." }, { status: 409 });
    return NextResponse.json({ ok: true, videoId: video.id });
  } catch (error) {
    const message = userFacingError(error, "영상을 등록하지 못했습니다.");
    return NextResponse.json({ error: message }, { status: error instanceof Error && error.message.includes("권한") ? 403 : 500 });
  }
}
