import { isKstYmd, kstDow, todayKst } from "@/lib/datetime/kst";
import type { SeatLevel } from "@/lib/seats/seatLevel";

export type TrialScheduleSelection = { trialDate: string; trialDay: string; trialPeriod: string };
// 남은 자리는 숫자 대신 3단계(여유/임박/마감)로만 받는다(재원생 수 비공개 · 2026-11-13 f9)
export type TrialSelectionSlot = { slotKey: string; dayLabel: string; seatLevel: SeatLevel };
const DAYS = ["일", "월", "화", "수", "목", "금", "토"];

export function trialDayForDate(date: string): string {
  return isKstYmd(date) ? DAYS[kstDow(date)] : "";
}

export function trialSlotPeriod(slotKey: string): string {
  return slotKey.split("-").at(-1) || "";
}

export function trialScheduleForDate(previous: TrialScheduleSelection, date: string, slots: TrialSelectionSlot[]): TrialScheduleSelection {
  const day = trialDayForDate(date);
  const keepPeriod = day && previous.trialDay === day && slots.some((slot) =>
    slot.dayLabel === day && trialSlotPeriod(slot.slotKey) === previous.trialPeriod && slot.seatLevel !== "FULL");
  return { trialDate: date, trialDay: day, trialPeriod: keepPeriod ? previous.trialPeriod : "" };
}

/**
 * 시간표 카드의 «체험 신청»(/apply/trial?day=Mon&slot=4)으로 들어왔을 때 쓸 초기값.
 * 지금 시간표에 있고 마감이 아닌 수업일 때만 요일·교시를 돌려준다(그 밖의 값은 무시 = null).
 * 날짜는 비워 둔다 — 학부모가 그 요일의 날짜를 고르면 trialScheduleForDate 가 이 교시를 그대로 살린다.
 * 검증·제출 기준(trialScheduleError)은 건드리지 않는다. 초기값일 뿐이다.
 */
export function initialTrialScheduleFromQuery(
  day: string | undefined,
  period: string | undefined,
  slots: (TrialSelectionSlot & { dayOfWeek: string })[],
): { trialDay: string; trialPeriod: string } | null {
  if (!day || !period) return null;
  const slot = slots.find((item) => item.dayOfWeek === day && trialSlotPeriod(item.slotKey) === period);
  if (!slot || slot.seatLevel === "FULL") return null;
  return { trialDay: slot.dayLabel, trialPeriod: period };
}

/** 화면 단계 이동·기존 신청 로드·최종 제출에서 같은 일정 기준을 사용한다. */
export function trialScheduleError(selection: TrialScheduleSelection, slots: TrialSelectionSlot[], nowMs = Date.now()): string {
  if (!selection.trialDate) return "체험수업 희망일을 선택해주세요.";
  if (!isKstYmd(selection.trialDate)) return "올바른 체험수업 날짜를 선택해주세요.";
  if (selection.trialDate < todayKst(nowMs)) return "오늘 이후의 체험수업 날짜를 다시 선택해주세요.";
  const expectedDay = trialDayForDate(selection.trialDate);
  if (selection.trialDay !== expectedDay) return "날짜와 요일이 맞지 않습니다. 선택한 날짜의 요일을 다시 확인해주세요.";
  if (slots.length === 0) return "시간표 정보를 확인할 수 없습니다. 학원으로 문의해주세요.";
  const daySlots = slots.filter((slot) => slot.dayLabel === expectedDay);
  if (daySlots.length === 0) return "선택한 날짜의 요일에는 등록된 수업이 없습니다. 다른 날짜를 선택해주세요.";
  if (!selection.trialPeriod) return "교시를 선택해주세요.";
  const slot = daySlots.find((item) => trialSlotPeriod(item.slotKey) === selection.trialPeriod);
  if (!slot) return "선택한 교시가 현재 시간표에 없습니다. 교시를 다시 선택해주세요.";
  if (slot.seatLevel === "FULL") return "선택한 수업은 마감되었습니다. 다른 교시를 선택해주세요.";
  return "";
}
