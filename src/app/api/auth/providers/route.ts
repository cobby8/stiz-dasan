import { NextResponse } from "next/server";
import { getEnabledParentOAuthProviders } from "@/lib/auth-providers";
import { nativeAuthEnabled } from "@/lib/native-auth/policy";

// 로그인·가입 화면이 «지금 켜진 간편로그인»을 묻는 곳. 두 화면 모두 클라이언트 컴포넌트라
// 서버 판정을 여기서 받아 간다. 같은 판정을 로그인 시작 라우트도 쓴다.
// nativeApp = 앱(스토어 앱) 안 간편로그인 스위치(NATIVE_AUTH_ENABLED + 암호화 키). 꺼져 있으면
// 앱 화면은 간편로그인 버튼을 숨기고 아이디·비밀번호 로그인으로 안내한다(2026-11-13 a1).
export async function GET() {
  const providers = await getEnabledParentOAuthProviders();
  return NextResponse.json(
    { providers, nativeApp: nativeAuthEnabled() },
    { headers: { "Cache-Control": "public, max-age=60" } },
  );
}
