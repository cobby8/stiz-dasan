/**
 * 광고 추적(Meta 픽셀)을 하면 안 되는 주소 — 한 곳 목록(순수 모듈, 외부 import 없음).
 *
 * ■ 왜 필요한가 (보안 검수 HIGH, 2026-11-10)
 *   Meta 픽셀 PageView·이벤트는 현재 주소 전체(dl=…)를 facebook.com 으로 보낸다. 주소에 «열쇠»(결제 링크 토큰·
 *   기사 화면 토큰·초대 링크 등)가 들어 있는 화면에서 픽셀이 돌면 열쇠가 외부로 새어 나간다.
 *   그래서 아래 경로·쿼리에서는 픽셀 초기화·PageView·이벤트를 전부 하지 않는다.
 *
 * ■ 새 «토큰 주소»를 만들면 반드시 여기에 추가한다(가드 테스트 tests/tracking-exclusion.test.mjs 가
 *   src/app 의 [token]·[code] 동적 경로가 이 목록에 다 있는지 확인한다).
 */

/** 주소 «경로»에 열쇠가 들어가는 화면 — 이 접두어로 시작하는 경로(하위 포함) 전부 */
export const TOKEN_PATH_PREFIXES = [
    "/apply/trial/pay", // 체험비 결제 링크 /apply/trial/pay/[token] · 완료 /apply/trial/pay/done?t=
    "/apply/uniform/free/", // 무료 유니폼 신청 링크 /apply/uniform/free/[token]
    "/driver/", // 기사님 운행 화면 /driver/[token]
    "/shuttle/run/", // 셔틀 운행 /shuttle/run/[token]
    "/shuttle/regular/", // 정규 셔틀 /shuttle/regular/[token]
    "/shuttle/location/", // 셔틀 위치 입력 /shuttle/location/[token]
    "/invite/", // 직원 초대 /invite/[token]
    "/request/", // 학부모 요청 링크 /request/[token] · /request/reconfirm/[token]
    "/e/", // 수강 신청서 짧은 링크 /e/[code]
    "/account/activate", // 학부모 계정 활성화 ?token=
    "/kakao-connect", // 카카오 채널 연결 ?token=
    "/mypage/kakao-connect", // 카카오 채널 연결(앱 범위) ?token=
] as const;

/** 주소 «쿼리»에 열쇠가 들어가는 이름 — 어느 경로든 이 이름이 있으면 추적하지 않는다 */
export const TOKEN_QUERY_KEYS = ["token", "t", "access"] as const;

/** 경로만으로 판정(서버 렌더에서도 같은 결과 — 픽셀 스크립트를 아예 싣지 않을지 정할 때) */
export function isTrackingBlockedPath(pathname: string | null | undefined): boolean {
    const path = String(pathname ?? "");
    // "/driver/" 와 "/driver" 는 같은 뜻 — 그 경로 자체 또는 그 아래만(«/driverish» 같은 다른 경로는 아님)
    return TOKEN_PATH_PREFIXES.some((prefix) => {
        const base = prefix.replace(/\/$/, "");
        return path === base || path.startsWith(`${base}/`);
    });
}

/** 경로 + 쿼리로 판정(브라우저에서 이벤트를 보내기 직전) */
export function isTrackingBlockedLocation(pathname: string | null | undefined, search: string | null | undefined): boolean {
    if (isTrackingBlockedPath(pathname)) return true;
    const params = new URLSearchParams(String(search ?? ""));
    return TOKEN_QUERY_KEYS.some((key) => params.has(key));
}
