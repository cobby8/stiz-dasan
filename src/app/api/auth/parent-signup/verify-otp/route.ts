import { NextResponse } from "next/server";
import { resolveVerifiedSignupPhone, verifyParentSignupOtp } from "@/lib/parent-signup-verification";
import { parentClaimProofCookieName } from "@/lib/parent-account-claim";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { token?: unknown; challengeToken?: unknown; code?: unknown; otp?: unknown; next?: unknown } | null;
  const challengeToken = String(body?.challengeToken || body?.token || "");
  const result = await verifyParentSignupOtp(
    challengeToken,
    String(body?.otp || body?.code || ""),
  );
  if ("error" in result) return NextResponse.json(result, { status: 400 });

  // 문자 인증을 통과한 뒤에만 "이 번호가 학원에 이미 등록된 보호자인지"를 확인해 알려준다.
  const { data } = await (await createClient()).auth.getUser();
  const provider = String(data.user?.app_metadata?.provider || data.user?.identities?.[0]?.provider || "").toLowerCase() || null;
  const handoff = await resolveVerifiedSignupPhone({
    token: challengeToken,
    proof: result.proof,
    redirectPath: typeof body?.next === "string" ? body.next : null,
    authenticatedOAuthUser: data.user ? { id: data.user.id, email: data.user.email, provider } : null,
  });
  if ("error" in handoff && !("kind" in handoff)) return NextResponse.json({ error: handoff.error }, { status: 400 });
  if (!("kind" in handoff) || handoff.kind === "NEW_SIGNUP") return NextResponse.json(result);
  if (handoff.kind === "REGISTERED" || handoff.kind === "CONTACT_ACADEMY") {
    return NextResponse.json({ error: handoff.error, existingParent: handoff.kind }, { status: 409 });
  }
  if (handoff.kind === "LINKED_EXISTING") {
    return NextResponse.json({ ok: true, existingParent: "LINKED", redirectPath: handoff.redirectPath });
  }

  // 활성화 화면이 "문자 인증 끝남"을 알아보도록 활성화 증표를 httpOnly 쿠키로 건넨다(기존 활성화와 같은 쿠키 규칙).
  const response = NextResponse.json({ ok: true, existingParent: "ACTIVATE", activationUrl: handoff.activationUrl });
  response.cookies.set(parentClaimProofCookieName(handoff.claimToken), handoff.claimProof, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 10 * 60,
  });
  return response;
}
