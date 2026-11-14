/**
 * «반 추가» 신청 규칙 — 순수 함수(DB·시계 없음). 2026-11-14 결정표 c8.
 *
 * 반 추가 = 지금 다니는 반은 그대로 두고 다른 요일·시간 반을 하나 더 다니겠다는 신청.
 * 반 변경(CLASS_CHANGE)과 달리 «떠나는 반»이 없다 — 그래서 신청 행의 enrollmentId·fromClassId 는 비워 두고
 * toClassId(추가할 반)만 채운다. 학부모 화면(후보 목록)·서버 접수·원장 승인이 이 파일의 판정을 같이 쓴다.
 *
 * 날짜는 "YYYY-MM-DD" 문자열만. 오늘은 부르는 쪽이 todayKst() 로 넣는다.
 */
import { makeupGradeFit } from "@/lib/makeup/credit-rules";

/** EnrollmentChangeRequest.kind 값. 운영 원장(OperationsCommand.kind)의 «수강 등록»과 같은 낱말이다. */
export const CLASS_ADD_KIND = "CLASS_ADD" as const;

export type ClassAddCandidateClass = {
  classId: string;
  className?: string | null;
  /** 시간표 학년 구성(예: ["초4","초5"]) */
  grades: string[];
  /** 학년 구성이 비어 있을 때 보조로 읽는 대상 학년 글자 */
  gradeRangeText?: string | null;
};

/**
 * 이 학생이 «반 추가»로 고를 수 있는 반.
 * - 이미 다니는 반(휴원 중 포함)·이미 반 추가를 신청해 둔 반은 뺀다.
 * - 학년 판정은 보강 예약과 같은 함수(makeupGradeFit: 학년이 포함되는 반 먼저 → 가까운 학년).
 * - 학생 학년을 끝내 모르면(생일·학년 글자 둘 다 없음) 거르지 않고 모두 보인다 — 원장이 승인 때 확인한다.
 *   (모른다고 다 숨기면 학부모가 신청할 길이 없다.)
 */
export function classAddCandidateIds(input: {
  studentGrade: number | null;
  classes: readonly ClassAddCandidateClass[];
  enrolledClassIds: readonly string[];
  pendingClassIds: readonly string[];
}): { classIds: string[]; gradeKnown: boolean } {
  const taken = new Set<string>([...input.enrolledClassIds, ...input.pendingClassIds]);
  const open = input.classes.filter((c) => !taken.has(c.classId));
  if (input.studentGrade == null) return { classIds: open.map((c) => c.classId), gradeKnown: false };
  const fits = open
    .map((c, index) => ({ c, index, fit: makeupGradeFit(input.studentGrade, c) }))
    .filter((x) => x.fit != null)
    // 학년이 포함되는 반(0)이 위로, 같은 순위 안에서는 받은 순서 그대로
    .sort((a, b) => (a.fit as number) - (b.fit as number) || a.index - b.index);
  return { classIds: fits.map((x) => x.c.classId), gradeKnown: true };
}

export type ClassAddSubmitError =
  | "TO_CLASS_REQUIRED"
  | "REASON_TOO_LONG"
  | "NO_ACTIVE_CLASS"
  | "ALREADY_ENROLLED"
  | "ALREADY_REQUESTED"
  | "CLASS_NOT_FOUND"
  | "GRADE_NOT_MATCHED";

export const CLASS_ADD_MESSAGE: Record<ClassAddSubmitError, string> = {
  TO_CLASS_REQUIRED: "추가할 반을 선택해 주세요.",
  REASON_TOO_LONG: "사유는 500자 이내로 적어 주세요.",
  NO_ACTIVE_CLASS: "지금 다니는 반이 있어야 반을 추가할 수 있어요.",
  ALREADY_ENROLLED: "이미 다니고 있는 반이에요. 다른 반을 선택해 주세요.",
  ALREADY_REQUESTED: "이미 추가 신청한 반이에요. 학원 확인을 기다려 주세요.",
  CLASS_NOT_FOUND: "선택한 반을 찾을 수 없습니다.",
  GRADE_NOT_MATCHED: "아이 학년에 맞는 반만 추가할 수 있어요. 목록을 새로고침해 다시 골라 주세요.",
};

/**
 * 접수 판정(서버). 소유권·날짜는 부르는 쪽이 먼저 본다(SQL·resolveEffectiveFrom).
 * candidateIds = classAddCandidateIds 가 «지금» 다시 계산한 값 — 화면이 보낸 목록을 믿지 않는다.
 */
export function validateClassAdd(input: {
  toClassId: unknown;
  reason: unknown;
  /** 그 학생의 수강(정규 반) — 다니는 중·휴원 중 */
  enrollments: ReadonlyArray<{ classId: string; status: string }>;
  /** 그 학생이 이미 낸 «반 추가» 검토 중 신청의 반 */
  pendingClassIds: readonly string[];
  /** 대상 반이 실재하는 정규 반인가 */
  targetExists: boolean;
  candidateIds: readonly string[];
}): { ok: true; toClassId: string } | { ok: false; error: ClassAddSubmitError } {
  const toClassId = typeof input.toClassId === "string" ? input.toClassId.trim() : "";
  if (!toClassId) return { ok: false, error: "TO_CLASS_REQUIRED" };
  if (typeof input.reason === "string" && input.reason.length > 500) return { ok: false, error: "REASON_TOO_LONG" };
  // «하나 더»는 다니는 반이 있을 때만 — 휴원 중인 반만 있으면 복귀가 먼저다.
  if (!input.enrollments.some((e) => e.status === "ACTIVE")) return { ok: false, error: "NO_ACTIVE_CLASS" };
  if (input.enrollments.some((e) => e.classId === toClassId)) return { ok: false, error: "ALREADY_ENROLLED" };
  if (input.pendingClassIds.includes(toClassId)) return { ok: false, error: "ALREADY_REQUESTED" };
  if (!input.targetExists) return { ok: false, error: "CLASS_NOT_FOUND" };
  if (!input.candidateIds.includes(toClassId)) return { ok: false, error: "GRADE_NOT_MATCHED" };
  return { ok: true, toClassId };
}

export type ClassAddApprovalPlan =
  /** 새 수강을 만든다(그만둔 기록이 있으면 그 행을 되살린다). startsOn = 개시일 */
  | { action: "CREATE"; startsOn: string }
  /** 이미 그 반을 다니는 중 — 수강은 건드리지 않고 신청만 «반영 완료»로 닫는다 */
  | { action: "ALREADY" }
  | { action: "BLOCK"; message: string };

/**
 * 원장 승인 때의 판정. 정원은 «지금» 다시 센 값으로 본다(신청 당시 값이 아니다).
 * 정원이 찼으면 승인하지 않고 신청을 그대로 둔다(= 대기) — 자리가 난 뒤 다시 승인하면 된다.
 */
export function planClassAddApproval(input: {
  target: { name: string; capacity: number; activeCount: number; deleted: boolean; seasonal: boolean } | null;
  /** 그 학생·그 반의 기존 수강 상태(없으면 null) */
  existingStatus: string | null;
  effectiveFrom: string;
  today: string;
}): ClassAddApprovalPlan {
  const { target } = input;
  if (!target || target.deleted || target.seasonal) {
    return { action: "BLOCK", message: "추가할 반을 찾을 수 없어요. 거절하고 학부모에게 다른 반을 안내해 주세요." };
  }
  if (input.existingStatus === "ACTIVE") return { action: "ALREADY" };
  if (input.existingStatus === "PAUSED") {
    return { action: "BLOCK", message: `${target.name}은(는) 휴원 중인 반이에요. 반 추가가 아니라 복귀로 처리해 주세요.` };
  }
  if (target.activeCount >= target.capacity) {
    return { action: "BLOCK", message: `${target.name} 정원이 찼어요. 자리가 난 뒤 다시 승인해 주세요(신청은 대기로 남습니다).` };
  }
  // 늦게 승인해 시작일이 이미 지났으면 오늘부터 — 다니지 않은 지난 수업(출결·사진)이 열리지 않게.
  const startsOn = input.effectiveFrom > input.today ? input.effectiveFrom : input.today;
  return { action: "CREATE", startsOn };
}
