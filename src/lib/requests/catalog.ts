/**
 * 신청 종류 목록 — 한 곳 (2026-11-10 원장 결정 «신청함 통합» 설계 A·B 공통 바닥)
 *
 * 왜 한 곳인가: 신청이 14가지 표에 흩어져 있고, 표마다 상태 글자(PENDING·REPORTED·REQUESTED…)가 다르다.
 * 관리자 신청함(/admin/inbox)과 학부모 «수업» 탭 타임라인이 같은 상태를 다르게 부르면 원장·학부모가 서로 다른 말을 한다.
 * 그래서 «어느 종류의 어느 상태가 → 어느 칸(처리 필요/진행 중/완료)·어떤 이름·어떤 색 뜻인가»를 여기 한 곳에 둔다.
 *
 * 칸 세 개:
 *   ACTION  처리 필요 — 원장이 손대야 넘어간다(승인·확인·반영)
 *   ONGOING 진행 중   — 원장 손은 떠났고 날짜·상대방을 기다린다(적용일 대기·입금 대기·예약됨)
 *   DONE    완료      — 끝났다(승인 적용·거절·취소·확인 완료)
 *
 * ⚠️ 순수 모듈이다 — DB·React 를 부르지 않는다(node 테스트가 바로 import 한다).
 * ⚠️ 표에 실제로 없는 «파생 상태»가 셋 있다 — 열 값으로 계산해 넣는다(아래 derive* 함수):
 *    수강 변경 APPLIED(= APPROVED + appliedAt) · 탈퇴 REQUESTED/WITHDRAWN · 셔틀 오늘만 ACTIVE/CANCELED
 * ⚠️ 지도에 없는 상태는 신청함 SQL 이 아예 읽지 않는다(statusesOf). 상태를 새로 만들면 여기에 먼저 넣는다.
 */

// @ts-expect-error Node 의 타입 제거 테스트(tests/request-catalog)에서도 같은 파일을 읽어서 확장자를 붙인다.
import { TONE_BADGE_CLASS, type StatusTone } from "../ui/statusTones.ts";

export type InboxBucket = "ACTION" | "ONGOING" | "DONE";

export const INBOX_BUCKETS: readonly InboxBucket[] = ["ACTION", "ONGOING", "DONE"];

/** 관리자 신청함 탭 이름 */
export const BUCKET_LABEL: Record<InboxBucket, string> = {
  ACTION: "처리 필요",
  ONGOING: "진행 중",
  DONE: "완료",
};

/** 학부모 쪽 같은 칸 이름 — 학부모에게 «처리 필요»는 «원장님이 보고 있어요» 뜻이다 */
export const PARENT_BUCKET_LABEL: Record<InboxBucket, string> = {
  ACTION: "검토 중",
  ONGOING: "진행 중",
  DONE: "완료",
};

export type RequestKind =
  | "ENROLLMENT_CHANGE" // 수강 변경(반 변경·휴원·퇴원) EnrollmentChangeRequest
  | "REGULAR_ABSENCE" // 정규 결석 RegularAbsence
  | "MAKEUP" // 보강 예약 MakeupSession
  | "SHUTTLE_DAY" // 셔틀 오늘만 ShuttleDayException(정보용 — 승인 없음)
  | "SEASONAL_ABSENCE" // 방학특강 결석 SpecialProgramAbsence
  | "SEASONAL_MAKEUP" // 방학특강 보강 SpecialProgramMakeup
  | "PARENT_REQUEST" // 문의 ParentRequest
  | "PAYMENT_REQUEST" // 입금했어요·영수증 PaymentParentRequest
  | "KAKAO" // 카카오채널 대화 접수 KakaoParentIntake
  | "RENTAL" // 체육관 대관 GymRentalRequest
  | "WITHDRAWAL" // 회원 탈퇴 User.withdrawRequestedAt
  | "ROLE_GRANT" // 직원 역할 신청 UserRoleGrant
  | "MEDIA_REVOCATION" // 사진 공개 회수 MediaRevocationJob
  | "STAFF_PAYMENT"; // 현장 수납 승인 StaffPaymentConfirmationRequest

export type StatusEntry = {
  bucket: InboxBucket;
  /** 사람이 읽는 상태 이름(관리자·학부모 공통으로 쓸 수 있는 말) */
  label: string;
  /** 색 뜻 — 실제 색은 statusTones 가 정한다 */
  tone: StatusTone;
};

export type KindEntry = {
  kind: RequestKind;
  label: string;
  /** Material Symbols 아이콘 이름 */
  icon: string;
  /** 기존 관리자 화면 — 복잡한 처리는 여기서 연다(d2: 메뉴에선 빠졌지만 주소는 산다) */
  adminHref: string;
  /** 학부모가 낸 신청인가(학부모 타임라인에 보일 수 있는 종류) */
  parentFacing: boolean;
  statuses: Record<string, StatusEntry>;
};

// 자주 쓰는 칸·색 묶음 — 줄을 짧게 하려고 만든 도우미(뜻은 위 칸 세 개 그대로)
const act = (label: string): StatusEntry => ({ bucket: "ACTION", label, tone: "warning" });
const going = (label: string): StatusEntry => ({ bucket: "ONGOING", label, tone: "info" });
const ok = (label: string): StatusEntry => ({ bucket: "DONE", label, tone: "success" });
const no = (label: string): StatusEntry => ({ bucket: "DONE", label, tone: "danger" });
const off = (label: string): StatusEntry => ({ bucket: "DONE", label, tone: "neutral" });

/** 화면에 나오는 순서 그대로(필터 모달의 종류 칩 순서) */
export const REQUEST_KINDS: readonly KindEntry[] = [
  {
    kind: "ENROLLMENT_CHANGE", label: "수강 변경", icon: "swap_horiz", adminHref: "/admin/enrollment-changes", parentFacing: true,
    statuses: {
      PENDING: act("검토 대기"),
      APPROVED: going("승인·적용일 대기"), // 승인은 «예약» — 적용일에 크론이 반영한다
      // 파생: APPROVED + cancelRequestStatus='PENDING'(원장 결정 d8 학부모 «취소 요청») — 원장이 [취소 승인]/[요청 거절]을 눌러야 끝난다
      CANCEL_REQUESTED: act("취소 요청 검토 중"),
      APPLIED: ok("적용됨"), // 파생: APPROVED + appliedAt
      REJECTED: no("거절"),
      CANCELED: off("취소"),
    },
  },
  {
    kind: "REGULAR_ABSENCE", label: "결석", icon: "event_busy", adminHref: "/admin/absence", parentFacing: true,
    statuses: { REPORTED: act("확인 대기"), CONFIRMED: ok("확인됨"), CANCELLED: off("취소") },
  },
  {
    kind: "MAKEUP", label: "보강 예약", icon: "event_repeat", adminHref: "/admin/makeup", parentFacing: true,
    statuses: { BOOKED: going("예약됨"), ATTENDED: ok("보강 출석"), NO_SHOW: no("무단 불참"), CANCELLED: off("취소") },
  },
  {
    // 셔틀 오늘만 — 승인 없이 바로 반영되는 «알림»이라 처리할 게 없다 → 완료 칸(원장 결정 d1)
    kind: "SHUTTLE_DAY", label: "셔틀 오늘만", icon: "airport_shuttle", adminHref: "/admin/shuttle", parentFacing: true,
    statuses: { ACTIVE: ok("반영됨"), CANCELED: off("취소") },
  },
  {
    kind: "SEASONAL_ABSENCE", label: "특강 결석", icon: "event_busy", adminHref: "/admin/seasonal/absence", parentFacing: true,
    statuses: { REPORTED: act("확인 대기"), CONFIRMED: ok("확인됨"), CANCELLED: off("취소") },
  },
  {
    kind: "SEASONAL_MAKEUP", label: "특강 보강", icon: "event_repeat", adminHref: "/admin/seasonal/attendance", parentFacing: true,
    statuses: {
      REQUESTED: act("승인 대기"),
      APPROVED: going("승인됨"),
      SCHEDULED: going("보강 예정"),
      ATTENDED: ok("보강 출석"),
      REJECTED: no("거절"),
      NO_SHOW: no("무단 불참"),
      CANCELLED: off("취소"),
    },
  },
  {
    kind: "PARENT_REQUEST", label: "문의", icon: "chat", adminHref: "/admin/requests", parentFacing: true,
    // REJECTED 는 기존 updateRequestStatus 가 허용하는 «반려»(2026-11-10 추가 — 빠지면 SQL 이 그 행을 못 읽는다)
    statuses: { PENDING: act("새 문의"), CONFIRMED: going("확인함"), COMPLETED: ok("답변 완료"), REJECTED: no("반려") },
  },
  {
    kind: "PAYMENT_REQUEST", label: "입금·영수증", icon: "payments", adminHref: "/admin/payment-requests", parentFacing: true,
    statuses: { PENDING: act("확인 대기"), DONE: ok("처리 완료"), REJECTED: no("반려"), CANCELED: off("취소") },
  },
  {
    // 카카오 — 기존 /admin/kakao-requests 의 «처리·후속 필요/종결» 묶음과 같은 집합(DRAFT 는 대화 중이라 안 보인다)
    kind: "KAKAO", label: "카카오 접수", icon: "forum", adminHref: "/admin/kakao-requests", parentFacing: true,
    statuses: {
      SUBMITTED: act("신규 접수"),
      NEEDS_DETAILS: act("추가 확인 필요"),
      HELD: act("관리자 확인 필요"),
      FAILED: { bucket: "ACTION", label: "처리 실패", tone: "danger" },
      PROCESSING: act("반영 확인"),
      APPROVED: going("운영 원장 이관"),
      CONSULTATION: going("상담 전환"),
      APPLIED: ok("자동 반영 완료"),
      CONSULTATION_CLOSED: off("상담 종결"),
      REJECTED: no("반려"),
      CANCELED: off("학부모 취소"),
    },
  },
  {
    kind: "RENTAL", label: "체육관 대관", icon: "sports_basketball", adminHref: "/admin/rental", parentFacing: false,
    statuses: {
      REQUESTED: act("승인 대기"),
      APPROVED: going("입금 대기"),
      PAID: going("확정"),
      COMPLETED: going("보증금 환불 대기"),
      REFUNDED: ok("환불 완료"),
      REJECTED: no("거절"),
      CANCELLED: off("취소"),
    },
  },
  {
    kind: "WITHDRAWAL", label: "회원 탈퇴", icon: "person_remove", adminHref: "/admin/withdrawals", parentFacing: false,
    statuses: { REQUESTED: act("탈퇴 신청"), WITHDRAWN: off("탈퇴 완료") }, // 파생: withdrawRequestedAt / withdrawnAt
  },
  {
    kind: "ROLE_GRANT", label: "직원 역할", icon: "badge", adminHref: "/admin/role-requests", parentFacing: false,
    statuses: { PENDING: act("승인 대기"), ACTIVE: ok("승인"), REJECTED: no("반려"), REVOKED: off("회수") },
  },
  {
    kind: "MEDIA_REVOCATION", label: "사진 공개 회수", icon: "hide_image", adminHref: "/admin/media-revocations", parentFacing: false,
    statuses: {
      MANUAL_REQUIRED: act("수동 삭제 필요"),
      PENDING: going("회수 대기"),
      PROCESSING: going("처리 중"),
      FAILED: going("재시도 대기"), // 자동 재시도가 다시 돈다 — 원장 손은 아직 필요 없다
      REMOVED: ok("회수 완료"),
    },
  },
  {
    kind: "STAFF_PAYMENT", label: "현장 수납 승인", icon: "point_of_sale", adminHref: "/admin/payment-confirmations", parentFacing: false,
    statuses: { PENDING: act("승인 대기"), APPROVED: ok("승인"), REJECTED: no("반려") },
  },
];

const BY_KIND = new Map<string, KindEntry>(REQUEST_KINDS.map((entry) => [entry.kind, entry]));

export function isRequestKind(value: unknown): value is RequestKind {
  return typeof value === "string" && BY_KIND.has(value);
}

export function kindEntry(kind: RequestKind): KindEntry {
  return BY_KIND.get(kind)!;
}

export function kindLabel(kind: string): string {
  return BY_KIND.get(kind)?.label ?? "기타";
}

/** 지도에 없는 상태 — 모르는 상태를 «완료»로 숨기지 않고 «진행 중·확인 필요»로 둔다 */
const UNKNOWN_STATUS: StatusEntry = { bucket: "ONGOING", label: "상태 확인 필요", tone: "neutral" };

export function statusEntry(kind: string, rawStatus: string | null | undefined): StatusEntry {
  const entry = BY_KIND.get(kind);
  return (entry && rawStatus && entry.statuses[rawStatus]) || UNKNOWN_STATUS;
}

export function bucketFor(kind: string, rawStatus: string | null | undefined): InboxBucket {
  return statusEntry(kind, rawStatus).bucket;
}

export function statusLabel(kind: string, rawStatus: string | null | undefined): string {
  return statusEntry(kind, rawStatus).label;
}

export function statusTone(kind: string, rawStatus: string | null | undefined): StatusTone {
  return statusEntry(kind, rawStatus).tone;
}

/** 상태 배지 클래스 — 화면은 색 클래스를 직접 쓰지 않고 이걸 쓴다(색 가드) */
export function statusBadgeClassFor(kind: string, rawStatus: string | null | undefined): string {
  return TONE_BADGE_CLASS[statusTone(kind, rawStatus)];
}

/**
 * 한 종류에서 특정 칸에 들어가는 «원래 상태» 목록 — SQL 의 `status IN (…)` 에 쓴다.
 * 칸을 안 주면 그 종류의 알려진 상태 전부.
 */
export function statusesOf(kind: RequestKind, bucket?: InboxBucket): string[] {
  const entry = kindEntry(kind);
  return Object.entries(entry.statuses)
    .filter(([, value]) => !bucket || value.bucket === bucket)
    .map(([status]) => status);
}

// ── 파생 상태(표에 그대로 없는 상태) ─────────────────────────────────────────

/** 수강 변경 «취소 요청 검토 중» 파생 상태 이름 — 신청함 SQL·학부모 타임라인이 같은 글자를 쓴다 */
export const ENROLLMENT_CANCEL_REQUESTED = "CANCEL_REQUESTED";

/**
 * 수강 변경 파생 상태.
 * - 승인 + 학부모 취소 요청 대기(cancelRequestStatus='PENDING') → «취소 요청 검토 중»(처리 필요).
 *   반영이 이미 됐어도 먼저 본다 — 원장이 [요청 거절]로 닫아야 하는 일이 남아 있기 때문.
 * - 승인 + 반영 시각 → «적용됨»
 * cancelRequestStatus 를 안 주면(마이그레이션 전 조회) 예전과 똑같이 판정한다.
 */
export function deriveEnrollmentChangeStatus(
  status: string,
  appliedAt: Date | string | null | undefined,
  cancelRequestStatus?: string | null,
): string {
  if (status === "APPROVED" && cancelRequestStatus === "PENDING") return ENROLLMENT_CANCEL_REQUESTED;
  return status === "APPROVED" && appliedAt ? "APPLIED" : status;
}

/** 탈퇴: 탈퇴 완료 시각이 있으면 완료, 아니면 신청 */
export function deriveWithdrawalStatus(withdrawnAt: Date | string | null | undefined): string {
  return withdrawnAt ? "WITHDRAWN" : "REQUESTED";
}

/** 셔틀 오늘만: 취소 시각이 있으면 취소 */
export function deriveShuttleDayStatus(canceledAt: Date | string | null | undefined): string {
  return canceledAt ? "CANCELED" : "ACTIVE";
}

/** 일괄 처리(d4)를 허락하는 종류 — 결석 확정·문의 «확인함»만 */
export const BULK_ACTION_KINDS: readonly RequestKind[] = ["REGULAR_ABSENCE", "PARENT_REQUEST"];
