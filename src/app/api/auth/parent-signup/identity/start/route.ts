import { anonIdentityStartResponse } from "@/lib/identity/anonymous-identity-server";

// 아이디 가입·기존 계정 활성화의 본인인증 시작(로그인 전, 2026-11-18 4단계).
// 건 번호는 서버가 만든다 — 이 브라우저에만 있는 1회용 nonce(httpOnly 쿠키 10분)로 표식을 넣는다. 같은 IP 한도가 있다.
export async function POST(request: Request) {
  return anonIdentityStartResponse(request, "SIGNUP");
}
