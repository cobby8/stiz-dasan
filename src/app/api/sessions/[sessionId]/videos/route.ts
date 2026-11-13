import { NextResponse } from "next/server";
import { requireVerifiedParent } from "@/lib/auth-guard";
import { listSessionVideos, parentCanViewSessionVideos, toPlayback } from "@/lib/sessionVideo/server";

export const dynamic = "force-dynamic";

/**
 * 학부모 수업 영상 재생 정보.
 * - 휴대폰 인증까지 끝난 보호자만(requireVerifiedParent)
 * - 수업 피드 공용 판정 하나(parentCanViewSessionVideos → @/lib/feed/server parentCanViewSession):
 *   끝났고 발행된 수업(COMPLETED + published) + 그 수업에 참여한 내 아이(출결 기록 또는 그 반 ACTIVE 수강).
 *   sessionId 를 바꿔 넣어도 자기 아이가 없는 수업은 403(IDOR 차단). 사진·소식 상세와 같은 기준(2026-11-14 통일).
 * 응답: 유튜브 일부공개 완료면 { kind:"youtube", youtubeId }, 아니면 { kind:"file", url(10분 서명 주소) }.
 */
export async function GET(_req: Request, context: { params: Promise<{ sessionId: string }> }) {
  try {
    const { sessionId } = await context.params;
    const parent = await requireVerifiedParent();
    // 수업이 없거나·미발행이거나·권한이 없을 때 같은 응답 — 다른 수업 ID 가 있는지 떠볼 수 없게
    if (!await parentCanViewSessionVideos(parent.appUserId, sessionId)) {
      return NextResponse.json({ error: "영상 접근 권한이 없습니다." }, { status: 403 });
    }
    const videos = await toPlayback(await listSessionVideos(sessionId));
    return NextResponse.json({ videos }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return NextResponse.json({ error: "영상 접근 권한이 없습니다." }, { status: 403 });
  }
}
