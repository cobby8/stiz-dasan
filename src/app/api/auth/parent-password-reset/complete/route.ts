import { NextResponse } from "next/server";
import { completeParentPasswordReset } from "@/lib/parent-password-reset";

// 3단계 — 인증한 번호의 학부모 계정 하나에 새 비밀번호를 저장한다(증표 1회 사용).
export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "입력값을 확인해 주세요." }, { status: 400 });
  const result = await completeParentPasswordReset({
    token: String(body.challengeToken || ""),
    proof: String(body.proof || ""),
    accountId: String(body.accountId || ""),
    password: typeof body.password === "string" ? body.password : "",
  });
  return NextResponse.json(result, { status: "error" in result ? 400 : 200 });
}
