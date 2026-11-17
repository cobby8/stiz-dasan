/**
 * 개별 알림(푸시)에 주소가 없을 때 열 화면 — 순수 규칙(2026-11-17 화면 이동 전수 조사).
 *
 * 왜 /auth/continue 인가: 예전 기본값은 "/admin" 이었다. 개별 알림은 관리자뿐 아니라 학부모·선생님에게도 가는데,
 * 주소 없는 알림을 누르면 그분들도 관리자 화면으로 가서 거절당했다. /auth/continue 는 로그인한 사람의 역할을
 * 서버가 확인해 그 사람의 홈(관리자 /admin · 선생님 /staff · 학부모 /mypage)으로 넘겨 준다. 로그인이 풀려 있으면 로그인 화면으로 간다.
 *
 * 왜 /store-app 이 아닌가: /store-app 은 «스토어 앱» 표식을 찍는 앱 시작 주소라 브라우저(웹푸시)에서 열면 안 된다.
 * /auth/continue 는 표식을 찍지 않고, 스토어 앱(안드로이드·아이폰)의 주소 정책도 이 주소는 통과시킨다.
 *
 * 이 파일은 import 없이 단독으로 읽힌다(테스트가 실제로 실행한다).
 */
export const NOTIFICATION_DEFAULT_PUSH_PATH = "/auth/continue";

/** 알림에 적힌 주소가 있으면 그대로, 없으면(빈 값·공백 포함) 역할 홈으로 넘겨 주는 기본 주소 */
export function resolveNotificationPushUrl(linkUrl: string | null | undefined): string {
  const link = typeof linkUrl === "string" ? linkUrl.trim() : "";
  return link || NOTIFICATION_DEFAULT_PUSH_PATH;
}
