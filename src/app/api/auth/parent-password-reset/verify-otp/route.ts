import { NextResponse } from "next/server";
import { verifyParentPasswordResetOtp } from "@/lib/parent-password-reset";

// 2단계 — 인증번호 확인. 통과하면 그 번호의 학부모 계정 아이디와 일회용 증표를 돌려준다.
export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { challengeToken?: unknown; otp?: unknown } | null;
  const result = await verifyParentPasswordResetOtp(String(body?.challengeToken || ""), String(body?.otp || ""));
  return NextResponse.json(result, { status: "error" in result ? 400 : 200 });
}
