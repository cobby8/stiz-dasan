import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["node-ical", "rrule-temporal", "@js-temporal/polyfill"],
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
    return [
      {
        // 학부모에게 공유하는 짧은 주소. rewrite 가 아니라 redirect 인 이유는,
        // 브라우저 주소가 실제로 /mypage/install 로 바뀌어야 학부모 앱의
        // manifest scope(/mypage) 안에 들어가 설치가 제안되기 때문이다.
        source: "/app",
        destination: "/mypage/install",
        permanent: false,
      },
    ];
  },

  async rewrites() {
    return [
      {
        // 선생님에게 공유하는 주소는 기억하기 쉬운 /staff/install로 유지한다.
        source: "/staff/install",
        destination: "/teacher-app",
      },
      {
        // 학부모 설치 안내도 /mypage 범위 안에 둔다.
        // 학부모 앱의 manifest scope 가 /mypage 라, 범위 밖에서는 브라우저가 설치를
        // 제안하지 않는다. 화면 자체는 /parent-app 과 같은 것을 쓴다.
        source: "/mypage/install",
        destination: "/parent-app",
      },
      {
        // 카카오채널 인증 링크 주소는 그대로 두고, 화면은 마이페이지 레이아웃 밖(/kakao-connect)에서 그린다.
        // 마이페이지 레이아웃은 로그인 안 된 사람을 먼저 튕겨 내서 상황별 안내를 보여줄 수 없기 때문이다.
        source: "/mypage/kakao-connect",
        destination: "/kakao-connect",
      },
      {
        // 설치 앱 주소는 /staff 범위에 유지하면서 공용 로그인 화면을 재사용한다.
        source: "/staff/login",
        destination: "/login?mode=staff",
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
        // rewrite의 내부 구현 주소로 직접 접근해도 같은 공개·최소권한 정책을 적용한다.
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
        // 권한 허용 경로가 차단 헤더와 겹치지 않도록 한다. 기사 화면은 단일 토큰 주소만 제외한다.
        source: "/((?!staff(?:/|$)|api/staff(?:/|$)|admin(?:/|$)|shuttle/location(?:/|$))(?!driver/[^/]+/?$|shuttle/(?:run|regular)/[^/]+/?$).*)",
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
