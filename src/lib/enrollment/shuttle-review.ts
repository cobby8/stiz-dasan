import { createHash } from "node:crypto";
import type { ShuttleReviewProposal } from "./shuttle-review-types";

export class ShuttleReviewError extends Error {
  constructor(message: string, public status = 400, public code = "INVALID_SHUTTLE_REVIEW") { super(message); }
}
export function reviewMonth(value: unknown): string {
  if (typeof value !== "string" || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(value)) throw new ShuttleReviewError("적용 월을 확인해 주세요.");
  return value;
}
export function reviewId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new ShuttleReviewError("신청 정보를 확인해 주세요.");
  return value;
}
export function reviewPage(value: unknown): number {
  if (value == null) return 1;
  if (!/^[1-9]\d{0,3}$/.test(String(value)) || Number(value) > 1000) throw new ShuttleReviewError("목록 페이지를 확인해 주세요.");
  return Number(value);
}
export function reviewFingerprint(value: unknown): string {
  const sorted = (v: unknown): unknown => Array.isArray(v) ? v.map(sorted) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sorted(x)])) : v;
  return createHash("sha256").update(JSON.stringify(sorted(value))).digest("hex");
}
export function assertReviewFingerprint(expected: unknown, actual: string) {
  if (typeof expected !== "string" || expected !== actual) throw new ShuttleReviewError("신청 또는 노선이 변경됐습니다. 새로 확인한 뒤 다시 요청해 주세요.", 409, "STALE_SHUTTLE_REVIEW");
}
export function parseReviewResponse(input: Record<string, unknown>, days: string[], classes: { dayOfWeek: string; startTime: string; endTime: string }[] = []) {
  if (input.result !== "PROPOSED" && input.result !== "NEEDS_CONFIRMATION") throw new ShuttleReviewError("검토 결과를 선택해 주세요.");
  const note = typeof input.note === "string" ? input.note.trim() : "";
  if (!note || note.length > 1000) throw new ShuttleReviewError("검토 의견을 1~1,000자로 입력해 주세요.");
  const source = input.proposals == null ? [] : input.proposals;
  if (!Array.isArray(source) || source.length > 14) throw new ShuttleReviewError("제안 시각을 확인해 주세요.");
  const proposals: ShuttleReviewProposal[] = [];
  for (const raw of source) {
    const row = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    if (typeof row.dayOfWeek !== "string" || !days.includes(row.dayOfWeek) || !["PICKUP", "DROPOFF"].includes(String(row.direction)) || typeof row.time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(row.time)) throw new ShuttleReviewError("수업 요일과 제안 시각을 확인해 주세요.");
    if (proposals.some(p => p.dayOfWeek === row.dayOfWeek && p.direction === row.direction)) throw new ShuttleReviewError("같은 요일·방향의 시각을 중복 입력할 수 없습니다.");
    const dayClasses = classes.filter(c => c.dayOfWeek === row.dayOfWeek);
    if (dayClasses.some(c => !/^([01]\d|2[0-3]):[0-5]\d$/.test(c.startTime) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(c.endTime))) throw new ShuttleReviewError("수업 시각을 먼저 확인해 주세요.");
    if (dayClasses.length && (row.direction === "PICKUP" ? row.time > dayClasses.map(c => c.startTime).sort()[0] : row.time < dayClasses.map(c => c.endTime).sort().at(-1)!)) throw new ShuttleReviewError("등원은 수업 시작 전, 하원은 수업 종료 후 시각을 제안해 주세요.");
    proposals.push({ dayOfWeek: row.dayOfWeek, direction: row.direction as "PICKUP" | "DROPOFF", time: row.time });
  }
  if (input.result === "PROPOSED" && days.some(day => ["PICKUP", "DROPOFF"].some(direction => !proposals.some(p => p.dayOfWeek === day && p.direction === direction)))) throw new ShuttleReviewError("각 수업 요일의 승차·하차 제안 시각을 모두 입력해 주세요.");
  return { status: input.result, note, proposals };
}
