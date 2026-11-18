import { anonIdentityStartResponse } from "@/lib/identity/anonymous-identity-server";

// 아이디·비밀번호 찾기의 본인인증 시작(로그인 전, 2026-11-18 4단계 B). 가입과 같은 방식 — 목적(RESET)이 달라 서로 섞어 쓸 수 없다.
export async function POST(request: Request) {
  return anonIdentityStartResponse(request, "RESET");
}
