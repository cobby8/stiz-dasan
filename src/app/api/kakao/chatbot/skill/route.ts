import { after, NextRequest, NextResponse } from "next/server";
import {
  getKakaoUserKey,
  handleLinkedMessage,
  issueLink,
  kakaoText,
  resolveIdentity,
  verifySkillSecret,
  type KakaoSkillPayload,
  type LinkedPolicyHook,
} from "@/lib/kakao-parent-chatbot";
import { getKakaoRequestId, type ParentRequestKind } from "@/lib/kakao-chatbot-contract";
import { hasKakaoNewEnrollmentHint, isKakaoParentAuthIntent, kakaoConnectLinkReply, kakaoGuestEntry } from "@/lib/kakao-guest-entry";
import { guestPolicyEscalateResponse, isGuestPolicyCandidate, runPolicyFlow } from "@/lib/kakao-policy-qa";
import { hashPolicyUserKey, realPolicyFlowDeps } from "@/lib/kakao-policy-qa-service";

export const dynamic = "force-dynamic";
// 카카오 콜백(최대 1분) 동안 백그라운드 답변을 끝내야 한다(vercel.json 도 60초).
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  // 동기 정책 답변이 카카오 5초 제한 안에 끝나도록, 요청을 받은 시각부터 남은 시간을 잰다
  const startedAt = Date.now();
  if (!verifySkillSecret(request.headers.get("x-stiz-kakao-skill-secret"))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const contentLength = Number(request.headers.get("content-length") || "0");
  if (contentLength > 64 * 1024) {
    return NextResponse.json({ error: "payload too large" }, { status: 413 });
  }
  let payload: KakaoSkillPayload;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json(kakaoText("요청을 읽지 못했어요. 다시 말씀해 주세요."), { status: 400 });
  }
  const botId = payload.bot?.id?.trim();
  const userKey = getKakaoUserKey(payload);
  const utterance = payload.userRequest?.utterance?.trim() || "메뉴";
  if (!botId || !userKey) return NextResponse.json(kakaoText("카카오 사용자 정보를 확인하지 못했어요."));
  // 오픈빌더 블록에 「AI 챗봇 콜백」이 켜져 있을 때만 온다(없으면 동기 3.5초 경로)
  const callbackUrl = payload.userRequest?.callbackUrl;

  // 정책 답변 흐름(꺼져 있으면 null → 아래 기존 응답이 그대로 나간다)
  const askPolicy = (
    question: string,
    linked: boolean,
    escalate: () => Promise<Record<string, unknown>>,
    kind: ParentRequestKind | null,
  ) =>
    runPolicyFlow(
      { question, linked, userKeyHash: hashPolicyUserKey(botId, userKey), callbackUrl, escalate, kind, startedAt },
      realPolicyFlowDeps((task) => after(task)),
    );

  try {
    // 시작한 쓰기를 시간 제한 경주로 버리지 않는다. 응답 실패 뒤 DB만 반영되는
    // 불일치는 빠른 실패보다 위험하므로, 각 쿼리를 짧게 유지하고 결과를 기다린다.
    const identity = await resolveIdentity(botId, userKey);
    if (!identity || identity.status !== "ACTIVE" || !identity.parentUserId) {
      const origin = process.env.NEXT_PUBLIC_SITE_URL || request.nextUrl.origin;
      // 인증 의도·신규 신호(체험·수강 신청·상담 등)가 아닌 "질문"만 정책 답변을 시도한다.
      // 답을 못 하면 원장님 확인 안내 + 상담 버튼. 꺼짐·한도 초과면 null → 아래 기존 안내.
      if (isGuestPolicyCandidate(utterance, isKakaoParentAuthIntent(utterance), hasKakaoNewEnrollmentHint(utterance))) {
        const policyReply = await askPolicy(utterance, false, async () => guestPolicyEscalateResponse(origin), null);
        if (policyReply) return NextResponse.json(policyReply);
      }
      const guestResponse = kakaoGuestEntry(utterance, origin);
      if (guestResponse) return NextResponse.json(guestResponse);
      // 명시적으로 기존 수강생 인증을 선택할 때만 일회용 인증 레코드를 만든다.
      // 아직 유효한 링크가 있으면 같은 링크를 다시 보여주고, 새로 만들면 이전 링크 무효를 알린다.
      const link = await issueLink(botId, userKey, origin);
      return NextResponse.json(kakaoConnectLinkReply(link));
    }
    const requestId = getKakaoRequestId(payload, request.headers.get("x-kakao-request-id"));
    // 연결된 학부모: 업무·메뉴·작성 중 접수를 다 지난 질문만 이 연결점에 온다. 답을 못 하면 기존 접수로 넘긴다.
    const policyHook: LinkedPolicyHook = (question, escalate, kind) => askPolicy(question, true, escalate, kind);
    return NextResponse.json(await handleLinkedMessage(identity, utterance, requestId, policyHook));
  } catch (error) {
    console.error("[kakao chatbot skill] failed:", error instanceof Error ? error.message : "UNKNOWN");
    return NextResponse.json(kakaoText("지금은 접수 연결이 원활하지 않아요. 잠시 후 다시 시도해 주세요."));
  }
}
