import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  const claimsResult = await supabase.auth.getClaims();
  let isAuthenticated = false;

  if (!claimsResult.error && claimsResult.data?.claims?.sub) {
    isAuthenticated = true;
  } else {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    isAuthenticated = Boolean(user);
  }

  const pathname = request.nextUrl.pathname;
  const isStaffLogin = pathname === "/staff/login";
  // 로그인 후 역할을 판별하는 중간 경로. redirect 목적지로 다시 쓰이면 순환한다.
  const isContinuePath = (path: string) => {
    const bare = path.split("?")[0];
    return bare === "/auth/continue" || bare === "/staff/continue" || bare === "/mypage/continue";
  };
  const isStaffModeLogin =
    isStaffLogin || (pathname === "/login" && request.nextUrl.searchParams.get("mode") === "staff");
  const isStaffInstall = pathname === "/staff/install";
  // 설치 안내는 로그인 전에 봐야 한다. 학부모 앱의 manifest scope 가 /mypage 라
  // 안내 화면도 그 안에 있어야 브라우저가 설치를 제안한다(선생님 앱과 같은 구조).
  const isMyPageInstall = pathname === "/mypage/install";
  // 카카오채널 인증 링크 화면. 로그인 안 된 학부모에게 "로그인 / 기존 계정 활성화" 안내를 직접 보여줘야 해서
  // 로그인 강제에서 뺀다. 화면이 스스로 로그인 상태를 확인하고, 연결은 검증된 학부모만 할 수 있다.
  const isMyPageKakaoConnect = pathname === "/mypage/kakao-connect";
  const isAdminPath = pathname === "/admin" || pathname.startsWith("/admin/");
  const isStaffPath = pathname === "/staff" || pathname.startsWith("/staff/");
  const isMyPagePath = pathname === "/mypage" || pathname.startsWith("/mypage/");
  const protectedPath =
    isAdminPath || (isStaffPath && !isStaffLogin && !isStaffInstall) || (isMyPagePath && !isMyPageInstall && !isMyPageKakaoConnect);

  if (protectedPath && !isAuthenticated) {
    const url = request.nextUrl.clone();
    const requestedPath = `${pathname}${request.nextUrl.search}`;
    url.pathname = pathname.startsWith("/staff") ? "/staff/login" : "/login";
    url.search = "";
    if (isAdminPath) {
      url.searchParams.set("mode", "staff");
    }
    url.searchParams.set("redirect", requestedPath);
    return NextResponse.redirect(url);
  }

  if ((pathname === "/login" || isStaffLogin) && isAuthenticated) {
    // Middleware cannot safely query the application DB. Route through a server
    // page that resolves the current DB role instead of trusting stale metadata.
    const url = request.nextUrl.clone();
    const requestedPath = request.nextUrl.searchParams.get("redirect");
    // 선생님 앱(PWA)의 manifest scope 는 /staff 다. 로그인 직후 /auth/continue 로
    // 나가면 설치된 앱이 그 순간 scope 를 벗어나 브라우저로 튕길 수 있다.
    // /staff 안에 머무는 주소로 보낸다(next.config 가 /staff/continue → /auth/continue).
    url.pathname = isStaffLogin ? "/staff/continue" : "/auth/continue";
    url.search = "";
    if (isStaffModeLogin) {
      // 설치된 선생님 앱의 로그인(/staff/login)과 브라우저의 관리자 로그인(/login?mode=staff)을
      // 구분한다. 앱에서는 앱 화면(/staff)에 머물러야 하고, 브라우저에서는 역할 기본 화면
      // (원장이면 /admin)이 맞다. 둘을 같은 값으로 묶으면 원장이 앱을 열 때마다
      // 관리자 화면으로 튕긴다.
      url.searchParams.set("context", isStaffLogin ? "staff-app" : "staff");
    }
    // redirect 가 continue 경로 자신을 가리키면 무한 리다이렉트가 된다
    // (미인증 상태로 /staff/continue 에 직접 들어온 경우 등).
    if (requestedPath && !isContinuePath(requestedPath)) {
      url.searchParams.set("redirect", requestedPath);
    }
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}
