import { NextResponse } from "next/server";
import { completeParentSignup, parentUsernameAuthEmail } from "@/lib/parent-signup-verification";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "입력값을 확인해 주세요." }, { status: 400 });
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  const provider = String(data.user?.app_metadata?.provider || data.user?.identities?.[0]?.provider || "").toLowerCase() || null;
  const result = await completeParentSignup({
    token: String(body.challengeToken || body.token || ""),
    proof: String(body.proof || ""),
    username: String(body.username || ""),
    name: String(body.name || ""),
    password: typeof body.password === "string" ? body.password : undefined,
    enrollmentHandoff: typeof body.handoff === "string"
      ? body.handoff
      : typeof body.enrollmentHandoff === "string"
        ? body.enrollmentHandoff
        : null,
    consents: {
      terms: Boolean((body.consents as Record<string, unknown> | undefined)?.terms),
      privacy: Boolean((body.consents as Record<string, unknown> | undefined)?.privacy),
      age: Boolean((body.consents as Record<string, unknown> | undefined)?.age),
    },
    authenticatedOAuthUser: data.user ? { id: data.user.id, email: data.user.email, provider } : null,
  });
  if ("error" in result) return NextResponse.json(result, { status: 400 });

  // 아이디 가입은 바로 로그인까지 해 둔다(2026-11-13 a7) — 방금 만든 아이디·비밀번호로 서버에서 세션을 만들어
  // 쿠키에 싣는다. 실패해도 가입은 끝났으므로 성공으로 답하고, 화면이 지금처럼 «로그인하기»로 안내한다(폴백).
  // 간편가입은 비밀번호를 보내지 않는다(이미 그 간편로그인으로 로그인된 상태) — 비밀번호가 있을 때만 로그인한다.
  let sessionEstablished = false;
  const password = typeof body.password === "string" ? body.password : "";
  if (password && result.username) {
    try {
      const signedIn = await supabase.auth.signInWithPassword({
        email: parentUsernameAuthEmail(result.username),
        password,
      });
      sessionEstablished = !signedIn.error && Boolean(signedIn.data.session);
    } catch {
      sessionEstablished = false;
    }
  }
  return NextResponse.json({ ...result, sessionEstablished }, { status: 200 });
}
