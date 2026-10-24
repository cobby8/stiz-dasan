import { GoogleGenerativeAI } from "@google/generative-ai";

// 홈페이지 상담 AI(/api/chat)와 카카오 정책 답변이 함께 쓰는 Gemini 설정.
// 모델 이름과 키 읽는 곳을 한 군데로 모아, 한쪽만 바뀌는 일을 막는다.
export const GEMINI_CHAT_MODEL = "gemini-2.5-flash";

let client: GoogleGenerativeAI | null | undefined;

/** GEMINI_API_KEY 가 없으면 null. 클라이언트는 프로세스당 한 번만 만든다. */
export function getGeminiClient(): GoogleGenerativeAI | null {
  if (client !== undefined) return client;
  const key = process.env.GEMINI_API_KEY?.trim();
  client = key ? new GoogleGenerativeAI(key) : null;
  return client;
}
