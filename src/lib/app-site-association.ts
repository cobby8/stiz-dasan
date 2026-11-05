// Apple App Site Association(AASA) — 아이폰 앱이 «www.stiz-dasan.kr 의 주인»임을 애플에 증명하는 파일.
// 이 파일이 있어야 https 링크로 앱을 바로 여는 «유니버설 링크»와, 앱에서 사이트 비밀번호 자동완성(webcredentials)을 쓸 수 있다.
//
// 비유: 건물(도메인) 입구에 «이 가게(앱)는 우리 건물 입주자입니다» 라고 붙여 두는 확인증이다.
//
// 왜 값이 없으면 null(=404)인가: 팀 ID 를 틀리게 내보내면 애플이 그 결과를 오래 캐시해
// 고친 뒤에도 한동안 연결이 안 되는데 원인을 찾기 매우 어렵다. assetlinks 와 같은 규칙이다.
//
// 설정값 (Vercel 환경변수)
//   APPLE_TEAM_ID  업턴랩스 Apple Developer 팀 ID (영문 대문자·숫자 10자리, 예: AB12CD34EF)
//
// ⚠️ 앱 간편로그인을 운영에서 켜는 스위치가 아니다. 그 스위치는 src/lib/native-auth/policy.ts 에 있고 계속 막혀 있다.

export const IOS_BUNDLE_ID = "kr.co.upturnlabs.stizdasan";

/** 앱이 가로챌 https 주소. 아직 운영에서 쓰지 않는 앱 로그인 복귀 주소 하나로 좁혀 둔다(웹 화면을 앱이 빼앗지 않게). */
export const IOS_UNIVERSAL_LINK_PATHS = ["/auth/native/return"] as const;

export function appleTeamId(raw: string | undefined): string | null {
  const value = String(raw ?? "").trim().toUpperCase();
  return /^[A-Z0-9]{10}$/.test(value) ? value : null;
}

export function buildAppleAppSiteAssociation(env: Record<string, string | undefined> = process.env) {
  const team = appleTeamId(env.APPLE_TEAM_ID);
  if (!team) return null;
  const appID = `${team}.${IOS_BUNDLE_ID}`;
  return {
    applinks: {
      details: [
        {
          appIDs: [appID],
          components: IOS_UNIVERSAL_LINK_PATHS.map((path) => ({ "/": path })),
        },
      ],
    },
    webcredentials: { apps: [appID] },
  };
}
