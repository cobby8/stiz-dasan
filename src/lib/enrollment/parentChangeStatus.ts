/**
 * 학부모에게 보이는 수강 변경 «상태 한 줄»과 «결정 알림 문구» — 순수 함수(DB·시계 없음).
 *
 * 왜 한 파일인가: 홈 한 줄(«휴원 예정 · 12/1부터»), 수강 변경 화면, 앱 알림 문구가
 * 같은 낱말을 써야 학부모가 헷갈리지 않는다. 화면마다 따로 적으면 한쪽만 바뀐다.
 * 다음 단계(학부모 «수업» 탭 반 카드 상태 칩)도 이 함수를 그대로 쓴다.
 *
 * 날짜는 "YYYY-MM-DD" 문자열만 받는다(Date 객체를 만들지 않는다 — 시간대가 끼어들 틈이 없다).
 */

/** 신청 종류 이름(학부모용). 모르는 값이면 «수강 변경». */
const KIND_NAME: Record<string, string> = {
  CLASS_CHANGE: "반 변경",
  PAUSE: "휴원",
  WITHDRAW: "퇴원",
  RESUME: "복귀",
};

export function parentKindName(kind: string): string {
  return KIND_NAME[kind] ?? "수강 변경";
}

/** "2026-12-01" → "12/1". 형식이 아니면 빈 문자열(추측해서 그럴듯한 날짜를 만들지 않는다). */
export function shortMd(ymd: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd ?? ""));
  if (!m) return "";
  return `${Number(m[2])}/${Number(m[3])}`;
}

export type ClassStatusTone = "info" | "warning" | "muted";

export type ClassStatusInput = {
  /** 지금 수강 상태(ACTIVE = 다니는 중, PAUSED = 휴원 중) */
  enrollmentStatus: string;
  /** 원장 승인됐지만 아직 반영 전인 신청(가장 이른 1건) */
  scheduled: { kind: string; effectiveFrom: string; resumeOn: string | null } | null;
  /** 원장 검토를 기다리는 신청 */
  pending: { kind: string; effectiveFrom: string } | null;
  /** 휴원 중일 때 마지막 휴원 신청에 적힌 복귀 예정일(없으면 null) */
  pausedResumeOn: string | null;
  /** 오늘(KST "YYYY-MM-DD"). 적용일이 지났는데 아직 반영 전인 승인 건을 «예정»이라 부르지 않으려고 받는다. */
  today: string;
};

/**
 * 반 하나의 상태 한 줄. 보여 줄 것이 없으면(그냥 다니는 중) null.
 * 우선순위: 승인된 예정 > 검토 중 > 휴원 중 — 학부모가 가장 궁금한 «앞으로 바뀌는 것»을 먼저.
 */
export function buildClassStatusLine(input: ClassStatusInput): { text: string; tone: ClassStatusTone } | null {
  const paused = input.enrollmentStatus === "PAUSED";

  if (input.scheduled) {
    const name = parentKindName(input.scheduled.kind);
    const from = shortMd(input.scheduled.effectiveFrom);
    // 적용일이 이미 지났는데 반영 전 = 학원이 마무리 중(반 변경 확인 등). «예정»이라 하면 날짜가 틀린 말이 된다.
    if (input.scheduled.effectiveFrom <= input.today) {
      return { text: `${name} 승인 · 학원에서 반영 중`, tone: "info" };
    }
    let text = `${name} 예정 · ${from}부터`;
    // 휴원 예정에 복귀일이 적혀 있으면 함께 보여 준다.
    if (input.scheduled.kind === "PAUSE" && shortMd(input.scheduled.resumeOn)) {
      text += ` · ${shortMd(input.scheduled.resumeOn)} 복귀 예정`;
    }
    return { text, tone: "info" };
  }

  if (input.pending) {
    const text = `${parentKindName(input.pending.kind)} 신청 검토 중`;
    // 휴원 중인 반의 복귀 신청이면 지금 상태도 같이 적는다.
    return { text: paused ? `휴원 중 · ${text}` : text, tone: "warning" };
  }

  if (paused) {
    const back = shortMd(input.pausedResumeOn);
    return { text: back ? `휴원 중 · 복귀 예정 ${back}` : "휴원 중", tone: "muted" };
  }
  return null;
}

/** 알림 사유 한 줄 길이 상한 — 휴대폰 알림 칸에서 잘리지 않을 만큼. */
const NOTE_MAX = 80;

// CANCEL_* = 승인된 휴원·퇴원에 학부모가 낸 «취소 요청»(d8)에 대한 원장 결정
export type ChangeNoticeEvent = "APPROVED" | "REJECTED" | "APPLIED" | "CANCEL_APPROVED" | "CANCEL_REJECTED";

/**
 * 원장 결정·적용 시 학부모 앱 알림 문구.
 * 예) «김루빈 월요일 4교시 휴원 신청이 승인됐어요(12/1부터)»
 *     «김루빈 월요일 4교시 휴원 신청이 거절됐어요: 이번 달은 어렵습니다»
 *     «김루빈 월요일 4교시 휴원이 시작됐어요(12/1부터)»
 */
export function buildChangeDecisionNotice(input: {
  event: ChangeNoticeEvent;
  studentName: string;
  className: string | null;
  kind: string;
  effectiveFrom: string;
  decisionNote?: string | null;
}): { title: string; message: string } {
  const who = [input.studentName, input.className].filter(Boolean).join(" ");
  const name = parentKindName(input.kind);
  const from = shortMd(input.effectiveFrom);
  const when = from ? `(${from}부터)` : "";

  if (input.event === "APPROVED") {
    return { title: "수강 변경 신청 승인", message: `${who} ${name} 신청이 승인됐어요${when}` };
  }
  if (input.event === "CANCEL_APPROVED") {
    return { title: "수강 변경 취소 요청 결과", message: `${who} ${name} 예정${when}이 취소됐어요. 지금처럼 수업을 이어 가요` };
  }
  if (input.event === "CANCEL_REJECTED") {
    const note = (input.decisionNote ?? "").replace(/\s+/g, " ").trim();
    const shortNote = note.length > NOTE_MAX ? `${note.slice(0, NOTE_MAX)}…` : note;
    return { title: "수강 변경 취소 요청 결과", message: `${who} ${name} 취소 요청이 받아들여지지 않았어요${shortNote ? `: ${shortNote}` : ""}` };
  }
  if (input.event === "REJECTED") {
    const note = (input.decisionNote ?? "").replace(/\s+/g, " ").trim();
    const shortNote = note.length > NOTE_MAX ? `${note.slice(0, NOTE_MAX)}…` : note;
    return { title: "수강 변경 신청 결과", message: `${who} ${name} 신청이 거절됐어요${shortNote ? `: ${shortNote}` : ""}` };
  }
  // APPLIED — 적용일에 사이트 수강 상태가 실제로 바뀐 순간
  const applied: Record<string, string> = {
    PAUSE: "휴원이 시작됐어요",
    WITHDRAW: "퇴원이 처리됐어요",
    RESUME: "복귀가 반영됐어요",
    CLASS_CHANGE: "반 변경이 반영됐어요",
  };
  return { title: "수강 변경 반영", message: `${who} ${applied[input.kind] ?? "수강 변경이 반영됐어요"}${when}` };
}

/** 학부모 알림이 가리키는 화면(결과·사유를 볼 수 있는 곳). */
export const CHANGE_NOTICE_LINK = "/mypage/enrollment-change";
