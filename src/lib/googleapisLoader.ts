/**
 * googleapis 를 «쓸 때만» 불러오는 한 곳(2026-11-19 전 화면 속도 3회차).
 *
 * googleapis 는 구글 전체 API 를 담은 서버 코드 11MB 묶음이다. 맨 위에서 import 하면 그 파일을 거치는
 * 수강 신청·대관·학부모 홈 화면까지 따라 들어가, 서버가 그 화면을 처음 열 때마다 CPU 0.7~0.9초를 썼다.
 * 불러오는 자리를 이 파일 하나로 모아 빌드 결과도 한 벌만 생기게 한다(자리마다 따로 두면 12MB 묶음이 두 벌 생겼다).
 */
export async function loadGoogleapis() {
  return (await import("googleapis")).google;
}
