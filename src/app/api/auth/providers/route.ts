import { NextResponse } from "next/server";
import { getEnabledParentOAuthProviders } from "@/lib/auth-providers";

// 로그인·가입 화면이 «지금 켜진 간편로그인»을 묻는 곳. 두 화면 모두 클라이언트 컴포넌트라
// 서버 판정을 여기서 받아 간다. 같은 판정을 로그인 시작 라우트도 쓴다.
export async function GET() {
  const providers = await getEnabledParentOAuthProviders();
  return NextResponse.json(
    { providers },
    { headers: { "Cache-Control": "public, max-age=60" } },
  );
}
