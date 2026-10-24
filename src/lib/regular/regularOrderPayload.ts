import { isServiceMonth } from "./serviceMonth";

export type RegularStopOrderUpdate = { id: string; sortOrder: number; arriveTime: string | null };

export function validateRegularStopOrderPayload(value: unknown): { serviceMonth: string; updates: RegularStopOrderUpdate[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("요청 형식이 올바르지 않습니다.");
  const body = value as Record<string, unknown>;
  if (!isServiceMonth(body.serviceMonth) || !Array.isArray(body.updates) || body.updates.length === 0 || body.updates.length > 500) {
    throw new Error("적용 월과 정차 목록을 확인해 주세요.");
  }
  const updates = body.updates.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("정차 형식이 올바르지 않습니다.");
    const item = raw as Record<string, unknown>;
    if (typeof item.id !== "string" || !item.id.trim() || item.id.length > 120
      || !Number.isInteger(item.sortOrder) || Number(item.sortOrder) < 0 || Number(item.sortOrder) > 10_000
      || !(item.arriveTime == null || (typeof item.arriveTime === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(item.arriveTime)))) {
      throw new Error("정차 순서 또는 시각 형식이 올바르지 않습니다.");
    }
    return { id: item.id.trim(), sortOrder: Number(item.sortOrder), arriveTime: item.arriveTime == null ? null : item.arriveTime };
  });
  return { serviceMonth: body.serviceMonth, updates } as { serviceMonth: string; updates: RegularStopOrderUpdate[] };
}
