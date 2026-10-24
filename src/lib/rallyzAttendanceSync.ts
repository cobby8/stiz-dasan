import { createHash } from "node:crypto";

export type SiteAttendanceStatus = "PRESENT" | "LATE" | "ABSENT";

export type RallyzAttendanceInput = {
  date: string;
  rallyzClassId?: string;
  className: string;
  studentName: string;
  managementName?: string;
  status: string;
};

export type ParsedRallyzAttendance = RallyzAttendanceInput & {
  slotKey: string | null;
  siteStatus: SiteAttendanceStatus | null;
  idempotencyKey: string;
};

const DAY_KEY: Record<string, string> = {
  월요일: "Mon", 화요일: "Tue", 수요일: "Wed", 목요일: "Thu",
  금요일: "Fri", 토요일: "Sat", 일요일: "Sun",
};

export function classNameToSlotKey(className: string) {
  const match = className.match(/(월요일|화요일|수요일|목요일|금요일|토요일|일요일)\s*(\d+)교시/);
  return match ? `${DAY_KEY[match[1]]}-${match[2]}` : null;
}

export function rallyzStatusToSite(status: string): SiteAttendanceStatus | null {
  const normalized = status.trim().toUpperCase();
  if (normalized === "출석" || normalized === "PRESENT") return "PRESENT";
  if (normalized === "지각" || normalized === "LATE") return "LATE";
  if (normalized === "결석" || normalized === "ABSENT") return "ABSENT";
  return null;
}

export function parseRallyzAttendanceJson(sourceText: string): ParsedRallyzAttendance[] {
  let value: unknown;
  try { value = JSON.parse(sourceText); } catch { throw new Error("랠리즈 출석 자료가 올바른 JSON 형식이 아닙니다."); }
  if (!Array.isArray(value) || value.length === 0) throw new Error("가져올 출석 행이 없습니다.");
  if (value.length > 500) throw new Error("한 번에 500명까지만 가져올 수 있습니다.");

  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object") throw new Error(`${index + 1}번째 출석 행을 확인해 주세요.`);
    const row = raw as Record<string, unknown>;
    const date = String(row.date || "").trim();
    const className = String(row.className || "").trim();
    const studentName = String(row.studentName || "").trim();
    const status = String(row.status || "").trim();
    if (!/^20\d{2}-\d{2}-\d{2}$/.test(date) || !className || !studentName || !status) {
      throw new Error(`${index + 1}번째 행의 날짜·반·학생·상태를 확인해 주세요.`);
    }
    const rallyzClassId = String(row.rallyzClassId || "").trim() || undefined;
    const managementName = String(row.managementName || "").trim() || undefined;
    const slotKey = classNameToSlotKey(className);
    const siteStatus = rallyzStatusToSite(status);
    const identity = [date, rallyzClassId || slotKey || className, studentName, managementName || "", status].join("|");
    return {
      date, rallyzClassId, className, studentName, managementName, status, slotKey, siteStatus,
      idempotencyKey: createHash("sha256").update(identity).digest("hex"),
    };
  });
}

export function decideAttendanceWrite(existing: { status: string; note: string | null } | null, nextStatus: SiteAttendanceStatus) {
  if (!existing) return "APPLY" as const;
  if (existing.status === nextStatus) return "SKIP" as const;
  if (existing.note?.startsWith("[RALLYZ_SYNC]")) return "APPLY" as const;
  return "HOLD" as const;
}
