import { NextResponse } from "next/server";
import { createLinkVerificationId } from "@/lib/account/social-link";
import { getPortoneConfig } from "@/lib/identity/portone";
import { currentSocialOnlyUser } from "../shared";

// 본인인증 건 번호를 서버가 만들어 준다 — 번호에 이 간편로그인 사용자 표식이 들어간다(남의 인증 건 재사용 차단).
export async function POST() {
  if (!getPortoneConfig()) {
    return NextResponse.json({ error: "본인인증 설정이 아직 끝나지 않았습니다. 학원에 문의해 주세요." }, { status: 503 });
  }
  const current = await currentSocialOnlyUser();
  if ("error" in current) return NextResponse.json({ error: current.error }, { status: 401 });
  return NextResponse.json({ identityVerificationId: createLinkVerificationId(current.user.id) });
}
