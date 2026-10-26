/** 인증창의 표시 로고만 지정한다. 계약된 상점명·채널 설정을 바꾸지는 않는다. */
export const STIZ_IDENTITY_LOGO_URL = "https://www.stiz-dasan.kr/stiz-logo.png";

export function getStizIdentityBypass() {
  return {
    inicisUnified: {
      flgFixedUser: "N" as const,
      logoUrl: STIZ_IDENTITY_LOGO_URL,
    },
  };
}
