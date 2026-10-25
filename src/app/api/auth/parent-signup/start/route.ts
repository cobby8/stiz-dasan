import { NextResponse } from "next/server";
import { REGISTERED_PHONE_MESSAGE, oauthProviderMethod, sendParentSignupOtp, startParentSignup, type ParentSignupMethod } from "@/lib/parent-signup-verification";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "입력값을 확인해 주세요." }, { status: 400 });
  const { data } = await (await createClient()).auth.getUser();
  const oauthUser = data.user ? { id: data.user.id, email: data.user.email } : null;
  const rawProvider = data.user?.app_metadata?.provider || data.user?.identities?.[0]?.provider;
  const method: ParentSignupMethod = oauthProviderMethod(rawProvider) ?? "PASSWORD";
  if (body.social === true && (method === "PASSWORD" || !oauthUser)) {
    return NextResponse.json(
      // 카카오톡 안의 브라우저는 간편로그인 세션이 이어지지 않는 경우가 많다. 막히지 않게 다른 길을 함께 알려준다.
      { error: "간편가입 연결이 만료되었습니다. 카카오톡 안에서 열었다면 외부 브라우저에서 다시 시도하거나, 아래 '아이디·휴대폰 인증으로 계속'을 눌러 주세요. 이미 다니는 학부모님도 같은 휴대폰 인증으로 기존 계정을 활성화할 수 있어요.", socialSessionMissing: true },
      { status: 401 },
    );
  }
  const result = await startParentSignup({
    phone: String(body.phone || ""), signupMethod: method,
    email: oauthUser?.email, pendingAuthUserId: method === "PASSWORD" ? null : oauthUser?.id,
  });
  if ("error" in result) {
    // 간편로그인으로 왔는데 이미 가입된 번호 → 화면이 「본인인증으로 기존 계정에 연결」을 띄운다.
    const phoneRegistered = method !== "PASSWORD" && result.error === REGISTERED_PHONE_MESSAGE;
    return NextResponse.json({ ...result, ...(phoneRegistered ? { phoneRegistered: true } : {}) }, { status: 400 });
  }
  const forwarded = request.headers.get("x-vercel-forwarded-for") || request.headers.get("x-forwarded-for") || request.headers.get("x-real-ip") || "unknown";
  const requestKey = forwarded.split(",")[0]?.trim() || "unknown";
  const sent = await sendParentSignupOtp(result.token, requestKey);
  if ("error" in sent) return NextResponse.json(sent, { status: 400 });
  return NextResponse.json({ ok: true, challengeToken: result.token });
}
