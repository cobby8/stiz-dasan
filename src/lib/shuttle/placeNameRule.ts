/**
 * 셔틀 위치 «장소명 필수» 규칙 한 곳 (2026-11-09 원장 지시).
 *
 * ■ 왜
 *   기사님 명단·배차 정류장 이름이 이 장소명이다(driverAssignLogic: 장소명 → 없으면 주소).
 *   주소만 있으면 «다산동 4002-1»처럼 남아 어디서 태울지 모른다. 그래서 지도에서 위치를 찍을 때 이름을 꼭 받는다.
 *
 * ■ 쓰는 곳 — 지도 창(LocationPickerModal, requirePlaceName), 관리자 원생 등록(student-register-rules),
 *   학부모 셔틀 위치 링크(regularLocationLink). 저장 SQL 의 «이름 없으면 도로명→지번» 대체는 옛 데이터·다른 경로 호환용으로 남아 있다.
 *
 * 이 파일은 아무것도 import 하지 않는다(화면·서버·테스트가 같이 쓴다).
 */

/** 장소명이 비었을 때 보여 줄 안내 */
export const SHUTTLE_PLACE_NAME_REQUIRED_MESSAGE = "아이가 타는 곳 이름을 적어 주세요(예: 롯데캐슬 정문)";

/** 장소명 최대 길이(StudentShuttleLocation.name 저장 경로들과 같은 150자) */
export const SHUTTLE_PLACE_NAME_MAX = 150;

/** 장소명이 실제로 적혔는지(공백만이면 아님) */
export function hasShuttlePlaceName(value: unknown): boolean {
    return typeof value === "string" && value.trim().length > 0;
}
