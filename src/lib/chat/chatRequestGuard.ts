/**
 * 상담 챗봇(/api/chat) 요청 문지기 — 순수 함수만 둔다(테스트에서 바로 부를 수 있게).
 *
 * 왜 필요한가(d3, 2026-11-13): /api/chat 은 로그인 없이 열려 있고, 한 번 부를 때마다 Gemini 유료 호출이
 * 나간다. 누가 반복해서 부르거나 아주 긴 글을 넣으면 요금·응답 지연이 그대로 학원 몫이 된다.
 * 그래서 ① IP 마다 횟수(분당·하루) ② 입력 길이 ③ 대화 기록 길이를 막는다.
 */

/** IP 당 횟수 제한 — 분당 5번, 하루 50번. 평범한 상담(한 번에 몇 문장)은 걸리지 않는 수준. */
export const CHAT_RATE_LIMITS = [
  { scope: "minute", limit: 5, windowMs: 60_000 },
  { scope: "day", limit: 50, windowMs: 24 * 60 * 60 * 1000 },
] as const;

/** 이번 질문(마지막 메시지) 최대 글자 수 */
export const CHAT_MAX_INPUT_CHARS = 1000;
/** 앞 대화는 최근 몇 개까지만 Gemini 에 넘기나 */
export const CHAT_MAX_HISTORY = 20;
/** 앞 대화 한 개당 최대 글자 수(챗봇 답이 길 수 있어 질문보다 넉넉히, 넘치면 잘라 쓴다) */
export const CHAT_MAX_HISTORY_CHARS = 2000;

export type ChatMessage = { role: "user" | "model"; content: string };

export type SanitizeResult =
  | { ok: true; messages: ChatMessage[] }
  | { ok: false; error: string };

/**
 * 받은 messages 를 검사·정리한다.
 * - 배열이 아니거나 비었으면 거절
 * - 마지막(이번 질문)이 사용자 글이 아니거나 비었거나 너무 길면 거절
 * - 앞 대화는 최근 CHAT_MAX_HISTORY 개만, 글자 수는 잘라서 쓴다(오래 대화한 학부모를 막지 않으려고)
 * - Gemini 는 대화 기록이 사용자 글로 시작해야 하므로, 자른 뒤 앞쪽 챗봇 답은 버린다
 */
export function sanitizeChatMessages(raw: unknown): SanitizeResult {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: "messages 배열이 필요합니다." };
  }

  // 모양이 맞는 것만 남긴다(role 은 user/model 만, content 는 문자열만)
  const cleaned: ChatMessage[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const role = (item as { role?: unknown }).role;
    const content = (item as { content?: unknown }).content;
    if ((role !== "user" && role !== "model") || typeof content !== "string") continue;
    cleaned.push({ role, content });
  }

  const last = cleaned[cleaned.length - 1];
  if (!last || last.role !== "user" || last.content.trim().length === 0) {
    return { ok: false, error: "질문 내용을 입력해 주세요." };
  }
  if (last.content.length > CHAT_MAX_INPUT_CHARS) {
    return { ok: false, error: `질문은 ${CHAT_MAX_INPUT_CHARS.toLocaleString("ko-KR")}자 이내로 적어 주세요.` };
  }

  // 앞 대화: 최근 것만, 너무 긴 글은 잘라서
  let history = cleaned
    .slice(0, -1)
    .slice(-CHAT_MAX_HISTORY)
    .map((m) => ({ role: m.role, content: m.content.slice(0, CHAT_MAX_HISTORY_CHARS) }));
  // 사용자 글로 시작하도록 앞쪽 챗봇 답을 버린다
  while (history.length > 0 && history[0].role !== "user") history = history.slice(1);

  return { ok: true, messages: [...history, last] };
}

/** 횟수 초과 안내 문구 — 화면(ChatPanel)은 error 글을 그대로 보여 준다. */
export function chatRateLimitMessage(scope: "minute" | "day"): string {
  return scope === "day"
    ? "오늘 챗봇 질문 횟수를 모두 썼어요. 궁금한 점은 상담 신청이나 전화로 문의해 주세요."
    : "질문이 너무 빨라요. 1분 뒤에 다시 물어봐 주세요.";
}
