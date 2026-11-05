/**
 * 수강신청서 셔틀 「타는 곳 / 내리는 곳 이름」 규칙 — 순수 모듈(DB·next 의존 0).
 *
 * ■ 왜 필요한가
 *   예전에는 지도에 핀을 찍으면 장소명이 없을 때 주소를 이름 칸에 자동으로 넣었다.
 *   그래서 학부모가 「경기 남양주시 다산동 4002-1」 같은 주소만 남기고 넘어가,
 *   기사님이 아파트 어느 문 앞에서 태워야 하는지 알 수 없었다.
 *   → 이름 칸은 주소로 채우지 않고, 비었거나 주소와 같으면 다음 단계로 못 가게 막는다.
 *
 * ■ 같은 규칙을 화면(EnrollApplicationForm)과 서버(submitEnrollApplication)가 함께 쓴다.
 *   한쪽만 고치면 한쪽 길로 주소만 든 신청이 들어오므로 여기 한 곳에서만 정한다.
 */

export type ShuttlePlaceKind = "pickup" | "dropoff";

/** 비교에 필요한 위치 정보(지도 선택 결과의 일부) */
export type ShuttlePlaceAddressLike = {
    address?: string | null;
    roadAddress?: string | null;
    placeName?: string | null;
} | null | undefined;

/** 공백을 모두 지워 비교용 문자열로 만든다(「다산동 4002-1」 = 「다산동4002-1」). */
function compactText(value: string | null | undefined): string {
    return (value ?? "").replace(/\s+/g, "");
}

/** 적은 이름이 고른 위치의 지번주소/도로명주소와 같은가(공백 무시) */
export function isPlaceNameSameAsAddress(name: string | null | undefined, location: ShuttlePlaceAddressLike): boolean {
    const compactName = compactText(name);
    if (!compactName || !location) return false;
    return [location.address, location.roadAddress]
        .map(compactText)
        .some((address) => address.length > 0 && address === compactName);
}

/** 화면·서버 공용 오류 문구. 문제 없으면 null */
export function shuttlePlaceNameError(
    name: string | null | undefined,
    location: ShuttlePlaceAddressLike,
    kind: ShuttlePlaceKind,
): string | null {
    const empty = compactText(name).length === 0;
    if (empty || isPlaceNameSameAsAddress(name, location)) {
        return kind === "pickup"
            ? "타는 곳 이름을 적어 주세요(예: OO아파트 후문)."
            : "내리는 곳 이름을 적어 주세요(예: OO아파트 후문).";
    }
    return null;
}

/**
 * 지도에서 위치를 고른 직후 이름 칸에 미리 넣을 값.
 * 지도가 가게·건물 이름(placeName)을 주면 그걸 쓰고, 주소뿐이면 빈칸으로 둔다(주소 자동 채움 금지).
 */
export function initialPlaceNameFromMap(location: ShuttlePlaceAddressLike): string {
    const placeName = location?.placeName?.trim() ?? "";
    if (!placeName || isPlaceNameSameAsAddress(placeName, location)) return "";
    return placeName;
}

/** 이전 신청을 불러올 때: 예전에 주소가 이름으로 저장된 경우 빈칸으로 바꿔 다시 적게 한다. */
export function sanitizeLoadedPlaceName(name: string | null | undefined, location: ShuttlePlaceAddressLike): string {
    const trimmed = name?.trim() ?? "";
    if (!trimmed || isPlaceNameSameAsAddress(trimmed, location)) return "";
    return trimmed;
}
