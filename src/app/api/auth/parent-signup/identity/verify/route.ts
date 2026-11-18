import { NextResponse } from "next/server";
import { parentClaimProofCookieName } from "@/lib/parent-account-claim";
import { REGISTERED_PHONE_MESSAGE, issueIdentityVerifiedSignup, resolveVerifiedSignupPhone } from "@/lib/parent-signup-verification";
import { clearAnonIdentityCookie, confirmAnonIdentityRequest } from "@/lib/identity/anonymous-identity-server";

/**
 * 아이디 가입·기존 계정 활성화의 본인인증 확인(로그인 전, 2026-11-18 4단계).
 *
 * 1. 쿠키 nonce ↔ 건 번호 표식 대조 → 포트원 재조회(VERIFIED·10분 안) → 장부 1회 소진 (confirmAnonIdentity)
 * 2. 본인인증 결과로 «문자 인증을 마친 것과 같은» 아이디 가입 요청을 만든다(issueIdentityVerifiedSignup, PASSWORD)
 * 3. 문자 인증 확인과 같은 갈래(resolveVerifiedSignupPhone): 처음 번호 → 계정 정보 단계 / 학원이 등록해 둔 빈 보호자 계정 →
 *    활성화 화면 / 로그인 수단이 있는 번호 → «아이디·비밀번호 찾기» 안내 / 빈 계정 여럿 → 학원 문의
 * 응답 모양은 간편가입 본인인증(parent-link/verify)의 가입 이어가기와 같다 — 화면이 같은 다음 단계를 쓴다.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { identityVerificationId?: unknown; next?: unknown } | null;
  const identityVerificationId = typeof body?.identityVerificationId === "string" ? body.identityVerificationId.slice(0, 100) : "";
  const confirmed = await confirmAnonIdentityRequest(request, "SIGNUP", identityVerificationId);
  if (!confirmed.ok) return NextResponse.json({ error: confirmed.error }, { status: confirmed.status });

  const issued = await issueIdentityVerifiedSignup({
    phone: confirmed.phone,
    signupMethod: "PASSWORD",
    verifiedName: confirmed.verifiedName,
    verifiedAt: confirmed.verifiedAt,
  });
  if ("error" in issued) {
    // 로그인 수단이 있는 번호 — 화면이 문구가 아니라 표식으로 «아이디·비밀번호 찾기» 버튼을 띄운다
    const registered = issued.error === REGISTERED_PHONE_MESSAGE;
    return clearAnonIdentityCookie(NextResponse.json({ error: issued.error, ...(registered ? { registeredPhone: true } : {}) }, { status: registered ? 409 : 400 }), "SIGNUP");
  }
  const handoff = await resolveVerifiedSignupPhone({
    token: issued.token,
    proof: issued.proof,
    redirectPath: typeof body?.next === "string" ? body.next : null,
    authenticatedOAuthUser: null,
  });
  if ("error" in handoff && !("kind" in handoff)) return clearAnonIdentityCookie(NextResponse.json({ error: handoff.error }, { status: 400 }), "SIGNUP");
  if (!("kind" in handoff) || handoff.kind === "NEW_SIGNUP") {
    return clearAnonIdentityCookie(NextResponse.json({ ok: true, signup: true, challengeToken: issued.token, proof: issued.proof, verifiedName: confirmed.verifiedName, verifiedPhone: confirmed.phone }), "SIGNUP");
  }
  if (handoff.kind === "REGISTERED" || handoff.kind === "CONTACT_ACADEMY") {
    return clearAnonIdentityCookie(NextResponse.json({
      error: handoff.error,
      existingParent: handoff.kind,
      ...(handoff.kind === "REGISTERED" ? { registeredPhone: true } : {}),
    }, { status: 409 }), "SIGNUP");
  }
  if (handoff.kind === "LINKED_EXISTING") {
    // 아이디 가입(로그인 전)에서는 생기지 않는 갈래지만, 모양을 맞춰 둔다
    return clearAnonIdentityCookie(NextResponse.json({ ok: true, signup: true, existingParent: "LINKED", redirectPath: handoff.redirectPath }), "SIGNUP");
  }
  // 학원이 등록해 둔 보호자 — 활성화 화면이 «인증 끝남»을 알아보도록 활성화 증표를 httpOnly 쿠키로 건넨다(문자 인증 확인과 같은 규칙)
  const activation = NextResponse.json({ ok: true, signup: true, existingParent: "ACTIVATE", activationUrl: handoff.activationUrl });
  activation.cookies.set(parentClaimProofCookieName(handoff.claimToken), handoff.claimProof, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 10 * 60 });
  return clearAnonIdentityCookie(activation, "SIGNUP");
}
