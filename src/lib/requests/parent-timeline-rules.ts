/**
 * 학부모 «수업» 탭 신청 내역 타임라인 규칙 — 순수 함수(DB·React·시계 없음).
 *
 * 종류·상태 이름과 색 뜻은 신청 종류 목록(catalog.ts) 한 곳에서 가져온다 — 관리자 신청함과 같은 말을 쓰기 위해.
 * 여기서는 «학부모에게 보이는 단계(접수→검토→승인/거절→적용)»와 «학부모가 누를 수 있는 버튼»만 정한다.
 *
 * 날짜는 "YYYY-MM-DD" 문자열만. 오늘은 부르는 쪽이 todayKst() 로 넣는다.
 */
import { deriveEnrollmentChangeStatus, kindLabel, statusEntry, type RequestKind } from "@/lib/requests/catalog";
import { parentKindName, shortMd } from "@/lib/enrollment/parentChangeStatus";
import type { StatusTone } from "@/lib/ui/statusTones";

/** 학부모 «취소 요청»(원장 결정 d8) 상태 — 승인됐지만 적용 전인 휴원·퇴원에 학부모가 낸 되돌림 요청 */
export type CancelRequestInfo = {
  status: "PENDING" | "APPROVED" | "REJECTED";
  requestedOn: string | null;
  /** 원장이 남긴 말(거절 사유 등) */
  decisionNote: string | null;
};

export type TimelineStepState = "done" | "current" | "todo" | "stopped";
export type TimelineStep = { label: string; state: TimelineStepState };

export type ParentTimelineRow = {
  /** 목록 키(종류:id) */
  key: string;
  kind: RequestKind;
  id: string;
  studentId: string;
  studentName: string;
  /** 한 줄 제목(예: «휴원 · 월요반») */
  title: string;
  /** 대상 날짜 한 줄(예: «12/1부터», «11/17(월)») — 없으면 빈 문자열 */
  when: string;
  /** 신청일 KST */
  createdOn: string;
  /** 정렬용(ISO) */
  createdAt: string;
  /** 표의 원래 상태(파생 상태 포함 — 수강 변경 APPLIED) */
  rawStatus: string;
  /** 상세 칸에 보일 덧붙임 줄 */
  details: string[];
  /** 원장 답변·거절 사유(학부모에게 보여도 되는 것만) */
  answer: string | null;
  /** 수강 변경일 때만: 원래 종류(PAUSE 등)와 적용일 — 단계·취소 요청 판정용 */
  change?: { kind: string; effectiveFrom: string; applied: boolean };
  /** 취소 요청(d8) — 수강 변경에만 */
  cancelRequest?: CancelRequestInfo | null;
  /** 정규 결석일 때만: 그 결석의 보강권 상태(AVAILABLE·RESERVED·USED·NO_SHOW 등, 없으면 null) — 2026-11-10 신고 즉시 발급 */
  absenceCredit?: string | null;
  /** 원래 신청 화면(자세히·다른 처리) */
  openHref: string;
};

/** 결석 신고의 보강권 상태 → 상세 칸 한 줄(짧게). 보여줄 게 없으면 null */
export function absenceCreditLine(status: string | null | undefined): string | null {
  if (status === "AVAILABLE") return "보강권 1장이 생겼어요";
  if (status === "RESERVED") return "보강권으로 보강 예약됨";
  if (status === "USED" || status === "NO_SHOW") return "보강권 사용 완료";
  return null;
}

/** 칩·배지에 쓰는 상태 이름·색 뜻 — catalog 그대로. 취소 요청 중이면 그 말을 앞세운다. */
export function timelineStatus(row: Pick<ParentTimelineRow, "kind" | "rawStatus" | "cancelRequest">): { label: string; tone: StatusTone } {
  // 취소 요청 대기 = catalog 의 파생 상태(관리자 신청함과 같은 이름·색). rawStatus 는 단계·버튼 판정에 그대로 둔다.
  const shown = row.kind === "ENROLLMENT_CHANGE"
    ? deriveEnrollmentChangeStatus(row.rawStatus, null, row.cancelRequest?.status)
    : row.rawStatus;
  const entry = statusEntry(row.kind, shown);
  return { label: entry.label, tone: entry.tone };
}

/** 종류 이름 — catalog 그대로(수강 변경은 안의 종류 이름으로: 휴원·퇴원·반 변경·복귀) */
export function timelineKindLabel(row: Pick<ParentTimelineRow, "kind" | "change">): string {
  if (row.kind === "ENROLLMENT_CHANGE" && row.change) return parentKindName(row.change.kind);
  return kindLabel(row.kind);
}

/**
 * 단계 표시.
 * - 수강 변경: 접수 → 검토 → 승인/거절 → 적용(적용일)
 * - 나머지: 접수 → 확인 → 결과 (catalog 칸: 처리 필요=확인 중 / 진행 중 / 완료)
 */
export function timelineSteps(row: Pick<ParentTimelineRow, "kind" | "rawStatus" | "change">): TimelineStep[] {
  const s = row.rawStatus;
  if (row.kind === "ENROLLMENT_CHANGE") {
    const from = shortMd(row.change?.effectiveFrom);
    const apply = from ? `적용 ${from}` : "적용";
    if (s === "PENDING") return [{ label: "접수", state: "done" }, { label: "검토", state: "current" }, { label: "승인", state: "todo" }, { label: apply, state: "todo" }];
    if (s === "APPROVED") return [{ label: "접수", state: "done" }, { label: "검토", state: "done" }, { label: "승인", state: "done" }, { label: `${apply} 예정`, state: "current" }];
    if (s === "APPLIED") return [{ label: "접수", state: "done" }, { label: "검토", state: "done" }, { label: "승인", state: "done" }, { label: apply, state: "done" }];
    if (s === "REJECTED") return [{ label: "접수", state: "done" }, { label: "검토", state: "done" }, { label: "거절", state: "stopped" }];
    if (s === "CANCELED") return [{ label: "접수", state: "done" }, { label: "취소", state: "stopped" }];
  }
  const entry = statusEntry(row.kind, s);
  if (entry.bucket === "ACTION") return [{ label: "접수", state: "done" }, { label: "확인 중", state: "current" }, { label: "완료", state: "todo" }];
  if (entry.bucket === "ONGOING") return [{ label: "접수", state: "done" }, { label: "확인", state: "done" }, { label: entry.label, state: "current" }];
  if (entry.tone === "neutral") return [{ label: "접수", state: "done" }, { label: entry.label, state: "stopped" }];
  return [{ label: "접수", state: "done" }, { label: "확인", state: "done" }, { label: entry.label, state: entry.tone === "danger" ? "stopped" : "done" }];
}

/**
 * 학부모가 바로 [취소]할 수 있는가 — 기존 취소 API 가 있는 두 종류만.
 * (서버가 다시 확인한다: 수강 변경 = PENDING 만, 결석 = REPORTED 만. 여기는 버튼을 보일지 정할 뿐)
 * 나머지 종류는 원래 신청 화면에서 취소한다(openHref).
 */
export function canCancelNow(row: Pick<ParentTimelineRow, "kind" | "rawStatus" | "absenceCredit">): boolean {
  if (row.kind === "REGULAR_ABSENCE") {
    // 이미 그 결석의 보강을 들었다(무단 불참 포함) — 결석 신고 취소 불가(서버도 같은 규칙으로 막는다)
    if (row.absenceCredit === "USED" || row.absenceCredit === "NO_SHOW") return false;
    return row.rawStatus === "REPORTED";
  }
  return row.kind === "ENROLLMENT_CHANGE" && row.rawStatus === "PENDING";
}

/**
 * [취소 요청](원장 결정 d8) 버튼을 보일까 — 승인됐지만 아직 적용 전(적용일 > 오늘 KST)인 휴원·퇴원,
 * 그리고 취소 요청을 아직 안 냈을 때만. 한 번 거절된 요청은 다시 내지 않는다(학원과 직접 이야기).
 * 서버(requestScheduledChangeCancel)가 같은 조건을 SQL 로 다시 건다.
 */
export function canRequestCancel(row: Pick<ParentTimelineRow, "kind" | "rawStatus" | "change" | "cancelRequest">, today: string): boolean {
  if (row.kind !== "ENROLLMENT_CHANGE" || row.rawStatus !== "APPROVED" || !row.change) return false;
  if (row.change.applied) return false;
  if (row.change.kind !== "PAUSE" && row.change.kind !== "WITHDRAW") return false;
  if (!(row.change.effectiveFrom > today)) return false;
  return !row.cancelRequest;
}

/** 취소 요청 상태 한 줄(상세 칸) */
export function cancelRequestLine(info: CancelRequestInfo | null | undefined): string | null {
  if (!info) return null;
  if (info.status === "PENDING") return `취소 요청을 보냈어요${info.requestedOn ? ` (${shortMd(info.requestedOn)})` : ""} · 원장님 확인 중`;
  if (info.status === "APPROVED") return "취소 요청이 받아들여졌어요";
  return `취소 요청이 받아들여지지 않았어요${info.decisionNote ? `: ${info.decisionNote}` : ""}`;
}

/** 화면에 넘길 완성본 — 화면(클라이언트)은 catalog 를 직접 부르지 않고 이 값만 그린다 */
export type ParentTimelineView = ParentTimelineRow & {
  kindName: string;
  statusLabel: string;
  tone: StatusTone;
  steps: TimelineStep[];
  canCancel: boolean;
  canRequestCancel: boolean;
  cancelLine: string | null;
};

export function toTimelineView(row: ParentTimelineRow, today: string): ParentTimelineView {
  const status = timelineStatus(row);
  return {
    ...row,
    kindName: timelineKindLabel(row),
    statusLabel: status.label,
    tone: status.tone,
    steps: timelineSteps(row),
    canCancel: canCancelNow(row),
    canRequestCancel: canRequestCancel(row, today),
    cancelLine: cancelRequestLine(row.cancelRequest),
  };
}

/** 최근 신청이 위로(같으면 키 순서로 고정) */
export function sortTimeline<T extends { createdAt: string; key: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.key.localeCompare(b.key)));
}
