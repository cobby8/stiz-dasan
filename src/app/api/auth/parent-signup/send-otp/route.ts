import { NextResponse } from "next/server";
import { sendParentSignupOtp } from "@/lib/parent-signup-verification";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { token?: unknown } | null;
  // 요청 IP 기준 남용 제한 — 키를 안 넘기면 모든 요청이 "unknown" 한 칸을 같이 써서 시간당 5회에서 전원이 막힌다.
  const forwarded = request.headers.get("x-vercel-forwarded-for") || request.headers.get("x-forwarded-for") || request.headers.get("x-real-ip") || "unknown";
  const result = await sendParentSignupOtp(String(body?.token || ""), forwarded.split(",")[0]?.trim() || "unknown");
  return NextResponse.json(result, { status: "error" in result ? 400 : 200 });
}
