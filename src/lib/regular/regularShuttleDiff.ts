import type { RegularShuttleStop } from "@/lib/shuttle/regularSheet";

export type RegularShuttleChange = {
  key: string;
  studentName: string;
  kind: "ADDED" | "REMOVED" | "CHANGED";
  before: string | null;
  after: string | null;
  parentPhone: string | null;
};

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

function digits(value: string | null | undefined): string {
  return String(value ?? "").replace(/\D/g, "");
}

function riderKey(stop: RegularShuttleStop): string | null {
  if (!stop.studentName || !["BOARD", "ALIGHT"].includes(stop.direction)) return null;
  // 월 사이 전화번호가 바뀌어도 같은 학생으로 비교되도록 DB에서 확정한 학생 ID를 최우선한다.
  if (stop.studentId) return `student:${stop.studentId}`;
  const phone = digits(stop.parentPhone) || digits(stop.studentPhone);
  return phone ? `${phone}:${stop.studentName.replace(/\s/g, "")}` : `name:${stop.studentName.replace(/\s/g, "")}`;
}

function stopLabel(stop: RegularShuttleStop): string {
  const direction = stop.direction === "BOARD" ? "등원" : "하원";
  return `${WEEKDAYS[stop.weekday] ?? stop.weekday} ${direction} ${stop.arriveTime ?? "시간 미정"} ${stop.stopName}${stop.classTime ? ` (${stop.classTime})` : ""}`;
}

function group(stops: RegularShuttleStop[]): Map<string, { name: string; phone: string | null; labels: string[] }> {
  const result = new Map<string, { name: string; phone: string | null; labels: string[] }>();
  for (const stop of stops) {
    const key = riderKey(stop);
    if (!key) continue;
    const current = result.get(key) ?? { name: stop.studentName!, phone: stop.parentPhone ?? null, labels: [] };
    current.labels.push(stopLabel(stop));
    current.labels.sort((a, b) => a.localeCompare(b, "ko"));
    result.set(key, current);
  }
  return result;
}

/** 두 월의 학생별 등·하원 정차를 비교한다. 문자 발송 권한과는 무관한 순수 미리보기다. */
export function diffRegularShuttleMonths(beforeStops: RegularShuttleStop[], afterStops: RegularShuttleStop[]): RegularShuttleChange[] {
  const before = group(beforeStops);
  const after = group(afterStops);
  const keys = new Set([...before.keys(), ...after.keys()]);
  const changes: RegularShuttleChange[] = [];
  for (const key of keys) {
    const a = before.get(key);
    const b = after.get(key);
    const beforeText = a?.labels.join(" / ") ?? null;
    const afterText = b?.labels.join(" / ") ?? null;
    if (beforeText === afterText) continue;
    changes.push({
      key,
      studentName: b?.name ?? a?.name ?? "이름 없음",
      kind: !a ? "ADDED" : !b ? "REMOVED" : "CHANGED",
      before: beforeText,
      after: afterText,
      parentPhone: b?.phone ?? a?.phone ?? null,
    });
  }
  return changes.sort((a, b) => a.studentName.localeCompare(b.studentName, "ko"));
}

export function maskPhone(value: string | null): string {
  const phone = digits(value);
  if (phone.length < 7) return "연락처 확인 필요";
  return `${phone.slice(0, 3)}-****-${phone.slice(-4)}`;
}

/** 승인 화면에 고정해서 보여줄 정규 차량 변동 문자 초안. 이 함수는 발송하지 않는다. */
export function regularShuttleChangeMessage(change: RegularShuttleChange, serviceMonth: string): string | null {
  if (change.kind === "REMOVED" || !change.after) return null;
  return `[STIZ 농구교실] ${change.studentName} 학생 ${serviceMonth} 차량 일정이 변경되었습니다.\n기존: ${change.before ?? "없음"}\n변경: ${change.after}\n확인 부탁드립니다.`;
}
