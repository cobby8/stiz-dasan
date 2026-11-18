import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["node-ical", "rrule-temporal", "@js-temporal/polyfill"],
  experimental: {
    // 2026-11-13: Vercel 표준 빌드 머신(8GB)에서 webpack 빌드가 메모리 부족(OOM, SIGKILL)으로 3번 연속 실패했다.
    // 라우트가 늘어 한계에 닿은 것 — 빌드 속도를 조금 내주고 webpack 최대 메모리를 줄인다.
    webpackMemoryOptimizations: true,
    // 서버 빌드 추적(build traces)을 컴파일과 동시에 돌리지 않는다 — 동시에 돌면 최대 메모리가 겹친다.
    parallelServerBuildTraces: false,
    parallelServerCompiles: false,
  },
  images: {
    remotePatterns: [
      // Supabase Storage (코치 이미지 등 사용자 업로드 파일)
      { protocol: "https", hostname: "*.supabase.co" },
      { protocol: "https", hostname: "*.supabase.in" },
      // Instagram/Facebook CDN (인스타그램에서 가져온 갤러리 이미지)
      { protocol: "https", hostname: "**.cdninstagram.com" },
      { protocol: "https", hostname: "**.fbcdn.net" },
    ],
  },

  async redirects() {
    // 2026-11-17 원장 승인: 설치 안내는 스토어 앱 안내(/install) 하나로 모은다.
    // 예전에는 학부모·선생님이 따로 «홈 화면 바로가기»를 만드는 안내 화면이 있었다(/parent-app·/teacher-app).
    // 이미 문자·메신저로 나간 옛 주소가 있어 주소는 살려 두고 전부 /install 로 넘긴다.
    // permanent 가 아닌 이유: 되돌릴 수 있게(영구 이동은 브라우저가 기억해 되돌려도 안 먹는다).
    // 옛 설치 화면(ParentAppInstallClient·StaffAppInstallClient)은 2026-11-18 지웠다 — src/app/parent-app·teacher-app 의 page.tsx 는
    // /install 로 넘기는 일만 한다(이 규칙이 빠져도 옛 화면이 다시 뜨지 않게). 되살리려면 git 기록에서 꺼낸다.
    // redirects 는 미들웨어보다 먼저 적용돼, 로그인하지 않은 사람도 /staff/install·/mypage/install 에서 바로 넘어간다.
    return [
      { source: "/app", destination: "/install", permanent: false },
      { source: "/staff/install", destination: "/install", permanent: false },
      { source: "/mypage/install", destination: "/install", permanent: false },
      { source: "/teacher-app", destination: "/install", permanent: false },
      { source: "/parent-app", destination: "/install", permanent: false },
      {
        // 2026-11-17: 출석·지각·결석 알림이 없는 주소(/parent/attendance)를 가리켰다 → 404 화면에서 공개 홈으로만 나갈 수 있었다.
        // 알림 주소는 /mypage/history(일정 탭 출결 기록)로 고쳤고, 이미 보낸 알림(DB 에 남은 주소)은 여기서 넘긴다.
        source: "/parent/attendance",
        destination: "/mypage/history",
        permanent: false,
      },
    ];
  },

  async rewrites() {
    return [
      {
        // 안드로이드 TWA 의 Digital Asset Links. 이 주소는 규격으로 정해져 있어 바꿀 수 없다.
        // 점으로 시작하는 폴더는 라우트로 쓰기 까다로워 API 라우트에 연결한다.
        // 서명키 지문이 설정되기 전에는 그 라우트가 404 를 돌려준다(일부러 그렇게 뒀다).
        source: "/.well-known/assetlinks.json",
        destination: "/api/assetlinks",
      },
      {
        // 아이폰 유니버설 링크·비밀번호 자동완성용 Apple App Site Association. 확장자 없는 고정 주소다.
        // 팀 ID 환경변수(APPLE_TEAM_ID)가 없으면 404 를 돌려준다.
        source: "/.well-known/apple-app-site-association",
        destination: "/api/apple-app-site-association",
      },
      // (2026-11-17) /staff/install → /teacher-app, /mypage/install → /parent-app 로 화면을 빌려 쓰던 규칙은 없앴다.
      // 그 주소들은 위 redirects 에서 스토어 앱 설치 안내(/install)로 넘긴다.
      {
        // 카카오채널 인증 링크 주소는 그대로 두고, 화면은 마이페이지 레이아웃 밖(/kakao-connect)에서 그린다.
        // 마이페이지 레이아웃은 로그인 안 된 사람을 먼저 튕겨 내서 상황별 안내를 보여줄 수 없기 때문이다.
        source: "/mypage/kakao-connect",
        destination: "/kakao-connect",
      },
      {
        // 설치 앱 주소는 /staff 범위에 유지하면서 공용 로그인 화면을 재사용한다.
        source: "/staff/login",
        // (2026-11-17) 직원 전용 화면은 없앴다 — 같은 로그인 화면을 /staff 범위 주소로 보여 줄 뿐이다.
        destination: "/login",
      },
      {
        // 학부모 앱도 역할 판별 화면을 제 영역(/mypage) 안에 둔다.
        // 밖으로 나가면 설치된 앱이 주소표시줄을 띄우며 브라우저로 새어 나간다.
        source: "/mypage/continue",
        destination: "/auth/continue",
      },
      {
        // 로그인 직후 역할 판별 화면도 /staff 범위 안에 둔다.
        // 선생님 앱(PWA)의 manifest scope 가 /staff 라, 여기서 벗어나면 설치된 앱이
        // 브라우저로 튕긴다. 화면 자체는 /auth/continue 와 같은 것을 쓴다.
        source: "/staff/continue",
        destination: "/auth/continue",
      },
    ];
  },

  // 보안 헤더 — 클릭재킹, MIME 스니핑, 불필요 권한 차단
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [
          {
            key: "Cache-Control",
            value: "no-cache, no-store, must-revalidate",
          },
          {
            key: "Service-Worker-Allowed",
            value: "/",
          },
        ],
      },
      {
        source: "/manifest.json",
        headers: [
          {
            key: "Cache-Control",
            value: "no-cache, no-store, must-revalidate",
          },
        ],
      },
      {
        source: "/manifest-staff.json",
        headers: [
          {
            key: "Cache-Control",
            value: "no-cache, no-store, must-revalidate",
          },
        ],
      },
      {
        // 옛 선생님 설치 안내 주소. 지금은 /install 로 넘기지만(위 redirects) 넘기는 응답에도 같은 최소권한 정책을 둔다.
        source: "/teacher-app",
        headers: [
          {
            key: "Cache-Control",
            value: "no-cache, no-store, must-revalidate",
          },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
      {
        // 앱 «연결하기» 확인·시작·완료 화면(2026-11-15 A안) — 주소에 1회용 표가 실린다.
        // 캐시 저장·검색 노출을 막는다. :path* 는 0개 이상이라 /auth/link-handoff 자체도 포함된다.
        // 다른 사이트로 주소 전달(리퍼러)은 화면 메타데이터 referrer=no-referrer 가, 끼워 넣기(X-Frame-Options DENY)는
        // 맨 아래 전역 규칙이 맡는다 — 같은 헤더를 여기 또 쓰면 뒤 규칙이 덮어써 헷갈리기만 한다.
        source: "/auth/link-handoff/:path*",
        headers: [
          { key: "Cache-Control", value: "no-store" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
      {
        source: "/uploads/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
      {
        source: "/staff/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(self), microphone=(self), geolocation=()" },
        ],
      },
      {
        source: "/admin/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=(self)" },
        ],
      },
      {
        // 일반 staff 권한 규칙 뒤에서 설치 화면의 카메라·마이크 권한을 다시 최소화한다.
        source: "/staff/install",
        headers: [
          {
            key: "Cache-Control",
            value: "no-cache, no-store, must-revalidate",
          },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
      {
        source: "/api/staff/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(self), microphone=(self), geolocation=()" },
        ],
      },
      {
        // 위치 입력 페이지에서만 현재 위치 버튼을 허용한다. 아래 일반 규칙과 겹치면 교집합으로 다시 차단된다.
        source: "/shuttle/location/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(self)" },
        ],
      },
      {
        // 실제 기사 화면의 단일 토큰 주소만 위치를 허용한다. 하위 페이지에는 권한을 넓히지 않는다.
        source: "/driver/:token",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(self)" },
        ],
      },
      {
        source: "/shuttle/run/:token",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(self)" },
        ],
      },
      {
        source: "/shuttle/regular/:token",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(self)" },
        ],
      },
      {
        // 체험비 결제 링크(/apply/trial/pay/[token] · 완료 /apply/trial/pay/done?t=) — 주소에 결제 열쇠가 있어
        // 다른 사이트로 리퍼러를 보내지 않고 검색·보관도 막는다(/driver/:token 과 같은 방식). 위치 권한은 주지 않는다.
        source: "/apply/trial/pay/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
      {
        // 비회원 결제 링크(/pay/[token] · 복귀 /pay/[token]/success) — 주소가 곧 청구서 한 장의 결제 열쇠라
        // 다른 사이트로 리퍼러를 보내지 않고, 검색·보관·캐시를 막는다(체험비 결제 링크와 같은 방식).
        source: "/pay/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
          { key: "Cache-Control", value: "private, no-store, max-age=0" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
      {
        // 권한 허용 경로가 차단 헤더와 겹치지 않도록 한다. 기사 화면은 단일 토큰 주소만 제외한다.
        // 체험비 결제 링크(apply/trial/pay 와 그 아래)·비회원 결제 링크(pay 와 그 아래)도 위 전용 규칙이 맡으므로 제외(헤더 중복 방지).
        source: "/((?!staff(?:/|$)|api/staff(?:/|$)|admin(?:/|$)|shuttle/location(?:/|$))(?!driver/[^/]+/?$|shuttle/(?:run|regular)/[^/]+/?$|apply/trial/pay(?:/|$)|pay(?:/|$)).*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" }, // 클릭재킹 방지: iframe 삽입 차단
          { key: "X-Content-Type-Options", value: "nosniff" }, // MIME 스니핑 방지
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" }, // 리퍼러 정보 제한
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" }, // 불필요한 브라우저 권한 차단
        ],
      },
    ];
  },
};

export default nextConfig;
