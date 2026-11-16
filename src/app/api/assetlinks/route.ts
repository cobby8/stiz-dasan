import { NextResponse } from "next/server";

// Digital Asset Links — 안드로이드 «STIZ 농구교실» 앱(웹뷰로 사이트를 보여 주는 앱, apps/driver-android)이
// 이 도메인의 주인임을 증명하는 파일. `/.well-known/assetlinks.json` 으로 서빙된다(next.config rewrite).
// 이 파일이 맞아야 문자·카카오톡 속 www.stiz-dasan.kr 링크(청구서·마이페이지 등)를 누를 때 «어느 앱으로 열까요?» 없이
// 바로 앱이 열린다(App Links, 앱 인텐트 필터의 autoVerify="true"). 틀리거나 없으면 앱이 아니라 브라우저로 열릴 뿐 앱이 깨지지는 않는다.
// (예전 주석은 TWA 껍데기 기준이었다 — 지금 앱은 TWA 가 아니라 WebView 앱이다. 2026-11-13 정정)
//
// 왜 정적 파일이 아니라 라우트인가: 이 파일의 핵심은 **서명키 SHA-256 지문**이고,
// 지문이 확정되기 전에 아무 값이나 넣어 두면 검증이 조용히 실패해 원인을 찾기가 매우 어렵다.
// 그래서 값이 없으면 **404**(= 파일이 없는 것과 같음)로 두고, 환경변수가 채워지는 순간 올바른 내용이 나가게 한다.
//
// 설정값 (Vercel 환경변수)
//   ANDROID_APP_PACKAGE_NAME        kr.co.upturnlabs.stizdasan (스토어 release 의 정식 ID)
//   ANDROID_APP_SHA256_FINGERPRINTS 콤마로 여러 개.
//     ① Play Console → 앱 무결성(설정 → 앱 서명) 의 «앱 서명 키 인증서» SHA-256 — 플레이에서 받은 앱은 이 키로 서명된다(필수).
//     ② 같은 화면의 «업로드 키 인증서» SHA-256 — 직접 설치한 시험 APK(업로드 키 서명)도 링크를 받게 하려면 함께 넣는다.
//     한쪽만 넣으면 다른 경로로 설치된 앱에서 검증이 실패한다(가장 흔한 실수다).

export const dynamic = "force-dynamic";

/** "AA:BB:...:FF" 형식(32바이트=95자)만 통과시킨다. 잘못된 값이 나가면 디버깅이 어렵다. */
function parseFingerprints(raw: string | undefined): string[] {
  return String(raw ?? "")
    .split(",")
    .map((value) => value.trim().toUpperCase())
    .filter((value) => /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(value));
}

// 2026-11-16: Play 콘솔 «딥 링크 → 도메인 검사 실패»의 원인이 «환경변수가 비어 이 파일이 404» 였다.
// 지문은 비밀이 아니라 공개 값(누구나 스토어 앱에서 꺼낼 수 있다)이므로, Play 콘솔이 알려 준 값을 기본으로 둔다 —
// 환경변수를 깜빡해도 파일이 사라지지 않는다. 환경변수에 값이 있으면 «추가»로 합친다(서명 키를 올렸을 때 등).
//   출처: Play Console → 딥 링크 → www.stiz-dasan.kr → «디지털 애셋 링크 JSON 파일» 해결 방법(앱 서명 키·이전 서명 키·업로드 키).
const DEFAULT_PACKAGE_NAME = "kr.co.upturnlabs.stizdasan";
const DEFAULT_FINGERPRINTS = [
  "F0:E0:9E:CB:5C:AC:12:36:44:E2:97:65:F8:22:1D:2B:63:DC:7C:E8:A8:73:7B:AA:94:F9:AE:71:5E:00:2E:D3",
  "3A:4E:23:1B:C2:87:88:4C:46:9B:CA:F6:78:54:94:0B:3E:73:13:37:5A:D4:34:E3:AF:87:5D:E2:FD:FC:D6:11",
  "B1:0B:25:58:63:EF:3D:9F:D9:63:22:DC:9A:DF:51:B6:FE:F6:00:B0:7D:E8:92:5A:A3:13:48:71:DE:DD:B1:AD",
].join(",");

export async function GET() {
  const packageName = process.env.ANDROID_APP_PACKAGE_NAME?.trim() || DEFAULT_PACKAGE_NAME;
  // 기본 지문 + 환경변수 지문(겹치면 한 번만). 형식이 틀린 값은 걸러진다
  const fingerprints = [...new Set(parseFingerprints(`${DEFAULT_FINGERPRINTS},${process.env.ANDROID_APP_SHA256_FINGERPRINTS ?? ""}`))];

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
