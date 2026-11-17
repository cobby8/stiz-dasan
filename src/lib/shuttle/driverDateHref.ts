// 기사님 운행 화면 날짜 이동(‹ 이전 · 오늘로 · 다음 ›)의 주소 조립 — 순수 모듈(외부 import 금지: 테스트가 그대로 실행한다).
//
// 왜 따로 두나(2026-11-17 뒤로 가기 전수 조사 staff #10):
//   예전 링크는 `?date=날짜` 만 써서 주소의 다른 값을 지웠다. 원장·부원장이 «선생님 운행»(?mode=drive) 중
//   날짜를 넘기면 보기 모드로 돌아갔다. 날짜는 «같은 화면의 보기 설정»이므로 다른 값은 그대로 두고 date 만 바꾼다.

/** 날짜를 옮길 때 버리는 값 — focus 는 알림 «노선 확인하기»가 그 날짜 화면을 처음 열 때 한 번만 쓰는 값이다(다른 날짜까지 끌고 가면 날짜를 넘길 때마다 화면이 스크롤된다). */
const DROP_ON_DATE_MOVE = ["focus"];

/**
 * 지금 주소의 쿼리(`?mode=drive&date=…` 또는 앞의 «?» 없는 모양)와 옮길 날짜로 링크 주소(`?…`)를 만든다.
 * - date 만 바꾸고 나머지(mode 등)는 순서까지 그대로 둔다.
 * - 날짜는 "YYYY-MM-DD" 문자열 그대로 싣는다(여기서 날짜 계산을 하지 않는다 — 계산은 서버의 kst 모듈 몫).
 */
export function driverDateHref(currentSearch: string | null | undefined, date: string): string {
  const params = new URLSearchParams(String(currentSearch ?? ""));
  for (const key of DROP_ON_DATE_MOVE) params.delete(key);
  params.set("date", date);
  return `?${params.toString()}`;
}
