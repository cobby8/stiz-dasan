// 출석 알림(«○○ 학생이 출석했습니다») 규칙 한 곳 — 선생님 화면과 관리자 화면이 같이 쓴다(2026-11-14 원장 결정표).
//
// 예전에 관리자 화면은 출결을 저장할 때마다 그 반 학부모 전원에게 «출결이 기록되었습니다»를 보냈다
// (고치지 않은 아이·지난 날짜 정리·같은 저장 반복까지). 선생님 화면은 이미 아래 규칙이었다 → 한 곳으로 모은다.
//   - 바뀐 아이만: 저장 전 상태와 같으면 보내지 않는다.
//   - 출석·지각만: 결석은 여기서 보내지 않는다(결석 알림은 3분 뒤 훑기 — absence-parent-notice-sweep 가 출결 표를 보고 보낸다).
//   - 오늘 수업만: 지난 날짜 수업을 뒤늦게 정리할 때는 «방금 출석» 알림을 보내지 않는다.
//   - 한 번만: 출결 행 + 상태 + 학부모로 묶은 dedupeKey(같은 저장을 또 눌러도 다시 안 나간다).
//
// ⚠️ prisma·next import 금지(테스트가 이 파일을 그대로 실행한다).

import { shouldNotifyParentsForSession } from "@/lib/staff-session-rules";
import { todayKst } from "@/lib/datetime/kst";

export type AttendanceNoticeStatus = "PRESENT" | "LATE";

/** 이 저장이 출석 알림을 보낼 일인가 — 바뀌었고, 출석·지각이고, 오늘(또는 앞날) 수업일 때만. */
export function attendanceNoticeNeeded(input: { changed: boolean; status: string; sessionYmd: string; nowMs?: number }): boolean {
  if (!input.changed) return false;
  if (input.status !== "PRESENT" && input.status !== "LATE") return false;
  return shouldNotifyParentsForSession(input.sessionYmd, input.nowMs);
}

/**
 * 여러 명을 한 번에 저장하는 화면(관리자 출결)용 — 저장 «전» 상태와 견줘 알림 보낼 아이만 고른다.
 * previousByStudent: 저장 전 출결(없던 아이는 키 없음). 같은 아이가 두 번 들어오면 마지막 값 하나만.
 */
export function pickAttendanceNoticeTargets(input: {
  records: readonly { studentId: string; status: string }[];
  previousByStudent: ReadonlyMap<string, string | null | undefined>;
  sessionYmd: string;
  /** true 면 오늘(KST) 수업일 때만 — 날짜를 골라 저장하는 관리자 화면용(앞날을 미리 입력해도 알리지 않는다). */
  todayOnly?: boolean;
  nowMs?: number;
}): { studentId: string; status: AttendanceNoticeStatus }[] {
  if (input.todayOnly && String(input.sessionYmd).slice(0, 10) !== todayKst(input.nowMs)) return [];
  const last = new Map<string, string>();
  for (const record of input.records) last.set(record.studentId, record.status);
  const out: { studentId: string; status: AttendanceNoticeStatus }[] = [];
  for (const [studentId, status] of last) {
    const changed = (input.previousByStudent.get(studentId) ?? null) !== status;
    if (!attendanceNoticeNeeded({ changed, status, sessionYmd: input.sessionYmd, nowMs: input.nowMs })) continue;
    out.push({ studentId, status: status as AttendanceNoticeStatus });
  }
  return out;
}

/** 알림 장부의 이벤트 종류 — ATTENDANCE 로 시작해 학부모 «출결» 스위치로 끌 수 있다. */
export function attendanceNoticeEvent(status: string): string {
  return status === "LATE" ? "ATTENDANCE_LATE" : "ATTENDANCE_PRESENT";
}

/**
 * 출석 알림 한 통의 내용 — deliverParentNotification 에 그대로 넘긴다.
 * 선생님 화면·관리자 화면이 같은 문구·같은 키(출결 행 + 상태 + 학부모 = 한 번만)를 쓰게 여기 한 곳에서 만든다.
 */
export function attendanceNoticePayload(input: {
  recipient: { studentId: string; studentName: string; userId: string };
  status: string;
  className: string;
  sessionId: string;
  attendanceId: string;
}) {
  const late = input.status === "LATE";
  return {
    eventType: attendanceNoticeEvent(input.status),
    dedupeKey: `attendance:${input.attendanceId}:status:${late ? "LATE" : "PRESENT"}:user:${input.recipient.userId}`,
    recipient: input.recipient,
    title: `${input.className} 출석 안내`,
    message: `${input.recipient.studentName} 학생이 ${late ? "지각 출석" : "출석"}했습니다.`,
    linkUrl: "/parent/attendance",
    sessionId: input.sessionId,
    attendanceId: input.attendanceId,
  };
}
