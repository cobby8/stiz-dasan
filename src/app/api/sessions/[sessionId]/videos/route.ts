import { NextResponse } from "next/server";
import { requireVerifiedParent } from "@/lib/auth-guard";
import { listSessionVideos, loadSessionForVideo, parentCanViewSessionVideos, toPlayback } from "@/lib/sessionVideo/server";

export const dynamic = "force-dynamic";

/**
 * 학부모 수업 영상 재생 정보.
 * - 휴대폰 인증까지 끝난 보호자만(requireVerifiedParent)
 * - 그 수업에 참여한 학생(출결 기록 또는 그 반 ACTIVE 수강)의 보호자만 — sessionId 를 바꿔 넣어도
 *   자기 아이가 없는 수업은 403(IDOR 차단, parentCanViewSessionVideos)
 * - 끝난 수업(COMPLETED)만 — 사진과 같은 기준
 * 응답: 유튜브 일부공개 완료면 { kind:"youtube", youtubeId }, 아니면 { kind:"file", url(10분 서명 주소) }.
 */
export async function GET(_req: Request, context: { params: Promise<{ sessionId: string }> }) {
  try {
    const { sessionId } = await context.params;
    const parent = await requireVerifiedParent();
    const session = await loadSessionForVideo(sessionId);
    // 수업이 없거나 권한이 없을 때 같은 응답 — 다른 수업 ID 가 있는지 떠볼 수 없게
    if (!session || session.status !== "COMPLETED"
      || !await parentCanViewSessionVideos(parent.appUserId, sessionId, session.classId)) {
      return NextResponse.json({ error: "영상 접근 권한이 없습니다." }, { status: 403 });
    }
    const videos = await toPlayback(await listSessionVideos(sessionId));
    return NextResponse.json({ videos }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return NextResponse.json({ error: "영상 접근 권한이 없습니다." }, { status: 403 });
  }
}
