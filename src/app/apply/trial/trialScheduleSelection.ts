import { isKstYmd, kstDow, todayKst } from "@/lib/datetime/kst";

export type TrialScheduleSelection = { trialDate: string; trialDay: string; trialPeriod: string };
export type TrialSelectionSlot = { slotKey: string; dayLabel: string; available: number };
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
    slot.dayLabel === day && trialSlotPeriod(slot.slotKey) === previous.trialPeriod && slot.available > 0);
  return { trialDate: date, trialDay: day, trialPeriod: keepPeriod ? previous.trialPeriod : "" };
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
  if (slot.available <= 0) return "선택한 수업은 마감되었습니다. 다른 교시를 선택해주세요.";
  return "";
}
