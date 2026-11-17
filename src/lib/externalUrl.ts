/**
 * 관리자가 설정에 넣은 바깥 주소(유튜브·네이버 플레이스·카카오 채널 등)를 «누를 수 있는 주소»로 다듬는다.
 * 왜 한 곳인가(2026-11-17 검수 반영): 공개 바닥글만 이 정리를 하고, 학부모 화면의 «카카오 문의» 버튼은 저장값을 그대로 써서
 *   `pf.kakao.com/_xxx` 처럼 https:// 없이 저장되면 사이트 안 주소(/mypage/pf.kakao.com/…)로 깨졌다. 두 곳이 같은 규칙을 쓴다.
 * 규칙(바닥글에 있던 그대로 옮김):
 *  - 지도 퍼가기 코드(<iframe src="…">)를 붙여 넣었으면 src 주소만
 *  - 글 중간에 http(s) 주소가 있으면 그 주소만
 *  - http(s) 로 시작하면 그대로, «<»로 시작하는 다른 태그면 버림(""), 그 밖은 앞에 https:// 를 붙인다
 * ★ 이 파일은 다른 모듈을 import 하지 않는다(테스트가 그대로 올려 실행한다).
 */
export function normalizeExternalUrl(url?: string | null) {
  const raw = url?.trim();
  const iframeSrc = raw?.match(/src=["']([^"']+)["']/i)?.[1];
  const firstUrl = raw?.match(/https?:\/\/[^\s"'>]+/i)?.[0];
  const trimmed = iframeSrc || firstUrl || raw;
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith("<")) return "";
  return `https://${trimmed}`;
}
