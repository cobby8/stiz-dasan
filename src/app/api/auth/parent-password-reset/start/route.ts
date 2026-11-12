import { NextResponse } from "next/server";
import { startParentPasswordReset } from "@/lib/parent-password-reset";

// 학부모 아이디·비밀번호 찾기 1단계 — 가입한 휴대폰으로 인증번호를 보낸다.
export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { phone?: unknown } | null;
  if (!body) return NextResponse.json({ error: "입력값을 확인해 주세요." }, { status: 400 });
  const forwarded = request.headers.get("x-vercel-forwarded-for") || request.headers.get("x-forwarded-for") || request.headers.get("x-real-ip") || "unknown";
  const requestKey = forwarded.split(",")[0]?.trim() || "unknown";
  const result = await startParentPasswordReset(String(body.phone || ""), requestKey);
  if ("error" in result) return NextResponse.json(result, { status: 400 });
  return NextResponse.json({ ok: true, challengeToken: result.token });
}
