import { NextResponse } from "next/server";

// Digital Asset Links — 안드로이드 TWA(구글플레이에 올리는 앱 껍데기)가 이 도메인을
// 제 것으로 인정받기 위한 파일. `/.well-known/assetlinks.json` 으로 서빙된다(next.config rewrite).
//
// 왜 정적 파일이 아니라 라우트인가: 이 파일의 핵심은 **서명키 SHA-256 지문**이고,
// 지문이 확정되기 전에 아무 값이나 넣어 두면 TWA 가 "검증 실패"로 주소표시줄을 띄우는데
// 원인을 찾기가 매우 어렵다. 그래서 값이 없으면 **404**(= 파일이 없는 것과 같음)로 두고,
// 환경변수가 채워지는 순간 올바른 내용이 나가게 한다.
//
// 설정값 (Vercel 환경변수)
//   ANDROID_APP_PACKAGE_NAME       예: kr.co.upturnlabs.stizdasan
//   ANDROID_APP_SHA256_FINGERPRINTS 콤마로 여러 개. **업로드 키와 Play 앱 서명 키를 모두** 넣는다.
//     Play Console → 설정 → 앱 서명 에서 두 지문을 볼 수 있다. 하나만 넣으면 어느 한쪽 경로로
//     설치된 앱에서 검증이 실패한다(가장 흔한 실수다).

export const dynamic = "force-dynamic";

/** "AA:BB:...:FF" 형식(32바이트=95자)만 통과시킨다. 잘못된 값이 나가면 디버깅이 어렵다. */
function parseFingerprints(raw: string | undefined): string[] {
  return String(raw ?? "")
    .split(",")
    .map((value) => value.trim().toUpperCase())
    .filter((value) => /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(value));
}

export async function GET() {
  const packageName = process.env.ANDROID_APP_PACKAGE_NAME?.trim() || "";
  const fingerprints = parseFingerprints(process.env.ANDROID_APP_SHA256_FINGERPRINTS);

  // 아직 안드로이드 앱을 만들지 않았거나 지문이 비었으면 이 파일은 존재하지 않는 것이 맞다.
  if (!packageName || fingerprints.length === 0) {
    return new NextResponse("Not Found", { status: 404 });
  }

  const body = [
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: {
        namespace: "android_app",
        package_name: packageName,
        sha256_cert_fingerprints: fingerprints,
      },
    },
  ];

  return NextResponse.json(body, {
    headers: {
      // 안드로이드가 주기적으로 다시 읽는다. 지문을 바꾼 뒤 오래 캐시되면 검증이 안 풀린다.
      "Cache-Control": "public, max-age=300",
      "Content-Type": "application/json",
    },
  });
}
