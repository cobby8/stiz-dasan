import { NextResponse } from "next/server";
import { issueIdentityVerifiedPasswordReset } from "@/lib/parent-password-reset";
import { clearAnonIdentityCookie, confirmAnonIdentityRequest } from "@/lib/identity/anonymous-identity-server";

/**
 * 아이디·비밀번호 찾기의 본인인증 확인(로그인 전, 2026-11-18 4단계 B).
 * 표식 대조·포트원 재조회·장부 1회 소진(confirmAnonIdentity) → 명의 번호·실명으로 계정 하나 고르기
 * (여럿이거나 이름이 다르면 막는다 — selectIdentityResetAccount). 응답 모양은 문자 인증 확인(verify-otp)과 같다.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { identityVerificationId?: unknown } | null;
  const identityVerificationId = typeof body?.identityVerificationId === "string" ? body.identityVerificationId.slice(0, 100) : "";
  const confirmed = await confirmAnonIdentityRequest(request, "RESET", identityVerificationId);
  if (!confirmed.ok) return NextResponse.json({ error: confirmed.error }, { status: confirmed.status });
  const result = await issueIdentityVerifiedPasswordReset({ phone: confirmed.phone, verifiedName: confirmed.verifiedName });
  if ("error" in result) return clearAnonIdentityCookie(NextResponse.json({ error: result.error }, { status: 409 }), "RESET");
  return clearAnonIdentityCookie(NextResponse.json({ ok: true, reset: true, challengeToken: result.token, proof: result.proof, accounts: result.accounts, verifiedPhone: confirmed.phone }), "RESET");
}
