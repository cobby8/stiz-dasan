/**
 * 공개 화면 «잔여 인원» 3단계 표시 — 한 곳(2026-11-13 원장 점검표 f9).
 *
 * ■ 왜
 *   공개 화면에 «잔여 2명»·«3/12명»처럼 숫자가 나가면 재원생 수가 그대로 드러난다(재원생 수 비공개 원칙).
 *   그래서 학부모·방문자에게는 «여유 / 임박 / 마감» 세 단계만 보여 주고, 공개 응답(JSON)에도 숫자를 싣지 않는다.
 *   관리자 화면은 숫자 그대로 둔다(이 모듈을 쓰지 않는다).
 *
 * ■ 기준(상수 한 곳)
 *   남은 자리 0 이하 = 마감 · 1~3 = 임박 · 그 외 = 여유
 *
 * ⚠️ prisma·next 를 import 하지 않는다(서버·화면·테스트 공용).
 */

/** 이 수 이하로 남으면 «임박» */
export const SEAT_LOW_MAX = 3;

export type SeatLevel = "AVAILABLE" | "LOW" | "FULL";

export const SEAT_LEVEL_LABEL: Record<SeatLevel, string> = {
    AVAILABLE: "여유",
    LOW: "임박",
    FULL: "마감",
};

/** 남은 자리 수 → 3단계. 숫자가 아니면(NaN) 안전 쪽 «마감» */
export function seatLevel(remaining: number): SeatLevel {
    if (!Number.isFinite(remaining) || remaining <= 0) return "FULL";
    if (remaining <= SEAT_LOW_MAX) return "LOW";
    return "AVAILABLE";
}

/** 정원·등록 인원 → 3단계 */
export function seatLevelFromCounts(capacity: number, enrolled: number): SeatLevel {
    return seatLevel(Number(capacity) - Number(enrolled));
}

/** 배지 색(학원 CSS 변수만) — 여유 = 성공색 · 임박 = 경고색 · 마감 = 회색 */
export const SEAT_LEVEL_BADGE_CLASS: Record<SeatLevel, string> = {
    AVAILABLE: "bg-[var(--color-academy-success-soft)] text-[var(--color-academy-success)]",
    LOW: "bg-[var(--color-academy-warning-soft)] text-[var(--color-academy-warning)]",
    FULL: "bg-[var(--color-academy-neutral-soft)] text-[var(--color-academy-neutral)]",
};

/** 글자 색만(배지 없이 한 줄에 넣을 때) */
export const SEAT_LEVEL_TEXT_CLASS: Record<SeatLevel, string> = {
    AVAILABLE: "text-[var(--color-academy-success)]",
    LOW: "text-[var(--color-academy-warning)]",
    FULL: "text-[var(--color-academy-neutral)]",
};

/** 점(도트) 색 */
export const SEAT_LEVEL_DOT_CLASS: Record<SeatLevel, string> = {
    AVAILABLE: "bg-[var(--color-academy-success)]",
    LOW: "bg-[var(--color-academy-warning)]",
    FULL: "bg-[var(--color-academy-neutral)]",
};
