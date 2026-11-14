/**
 * 학부모 문의 «대화» 순수 규칙 (2026-11-14 원장 결정표 c3·c11) — DB·화면과 떼어 두어 실행 테스트로 고정한다.
 *
 * 문의 한 건 = 첫 글(ParentRequest.content) + 옛 답변 한 줄(adminNote) + 이어 붙인 글들(ParentRequestMessage).
 * 화면(학부모 /mypage/requests · 관리자 요청함)은 이 모듈이 만든 «한 줄로 이은 대화»만 그린다.
 */

/** 글 한 개의 길이 한도 — DB CHECK(ParentRequestMessage_body_check)·첫 문의(createParentRequest)와 같은 값 */
export const INQUIRY_BODY_MAX = 2000;

export type InquiryAuthor = "PARENT" | "ADMIN";

/** 이어 붙인 글(표 한 행) */
export type InquiryMessageRow = { id: string; authorRole: string; body: string; createdAt: string };

/** 문의 머리(ParentRequest 한 행에서 대화에 필요한 것만) */
export type InquiryHead = {
  id: string;
  content: string;
  adminNote: string | null;
  status: string;
  createdAt: string;
};

/** 화면에 그리는 글 한 개. at 이 null 이면 «언제 쓴 답인지 모르는 옛 답변»(시각을 보이지 않는다) */
export type InquiryBubble = { key: string; author: InquiryAuthor; body: string; at: string | null };

/** 학부모에게 보이는 상태 세 가지(+반려) — 관리자 상태(대기중·확인됨…)를 그대로 보이지 않는다 */
export type InquiryParentStatus = "WAITING" | "ANSWERED" | "DONE" | "REJECTED";

export const INQUIRY_PARENT_STATUS_LABEL: Record<InquiryParentStatus, string> = {
  WAITING: "답변 대기",
  ANSWERED: "답변 옴",
  DONE: "완료",
  REJECTED: "반려",
};

/** 상태 색 — 공용 색 지도(statusTones)의 이름: 대기 주의 · 답변 정보 · 완료 정상 · 반려 위험 */
export const INQUIRY_PARENT_STATUS_TONE: Record<InquiryParentStatus, "warning" | "info" | "success" | "danger"> = {
  WAITING: "warning",
  ANSWERED: "info",
  DONE: "success",
  REJECTED: "danger",
};

/**
 * 글 정리: 줄바꿈을 \n 으로 맞추고, 앞뒤 빈칸을 떼고, 빈 줄은 두 줄까지만.
 * 비었거나 한도를 넘으면 거절(넘긴 글을 잘라 저장하지 않는다 — 학부모가 쓴 말이 조용히 잘리면 안 된다).
 */
export function cleanInquiryBody(raw: unknown, options: { /** 빈 글 허용(환불 사유처럼 «선택» 칸) */ allowEmpty?: boolean } = {}): { ok: true; body: string } | { ok: false; error: string } {
  const body = String(raw ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!body && !options.allowEmpty) return { ok: false, error: "내용을 적어 주세요." };
  if (body.length > INQUIRY_BODY_MAX) return { ok: false, error: "2,000자 이내로 적어 주세요." };
  return { ok: true, body };
}

/**
 * 대화 순서: 첫 글 → 옛 답변(adminNote) → 이어 붙인 글(쓴 시각 순, 같으면 id 순).
 * 옛 답변을 항상 두 번째에 두는 이유: adminNote 는 «이어 쓰기»가 생기기 전의 답이라 표의 어떤 글보다 먼저다.
 * (쓴 시각이 따로 없어 시각으로 줄 세울 수 없다)
 */
export function buildInquiryThread(head: InquiryHead, messages: readonly InquiryMessageRow[]): InquiryBubble[] {
  const bubbles: InquiryBubble[] = [{ key: "first", author: "PARENT", body: head.content, at: head.createdAt }];
  const note = (head.adminNote ?? "").trim();
  if (note) bubbles.push({ key: "legacy-answer", author: "ADMIN", body: note, at: null });
  const sorted = [...messages].sort((a, b) => (a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt < b.createdAt ? -1 : 1));
  for (const message of sorted) {
    bubbles.push({
      key: message.id,
      author: message.authorRole === "ADMIN" ? "ADMIN" : "PARENT",
      body: message.body,
      at: message.createdAt,
    });
  }
  return bubbles;
}

/**
 * 학부모에게 보이는 상태.
 * - 종결(COMPLETED) → 완료 · 반려(REJECTED) → 반려
 * - 그 밖에는 «마지막 글을 누가 썼는가»로: 학원이 마지막이면 답변 옴, 학부모가 마지막이면 답변 대기
 */
export function inquiryParentStatus(head: Pick<InquiryHead, "status" | "adminNote">, lastAuthor: InquiryAuthor | null): InquiryParentStatus {
  if (head.status === "COMPLETED") return "DONE";
  if (head.status === "REJECTED") return "REJECTED";
  const last = lastAuthor ?? ((head.adminNote ?? "").trim() ? "ADMIN" : "PARENT");
  return last === "ADMIN" ? "ANSWERED" : "WAITING";
}

/**
 * 학원 답이 오기 전에 학부모가 연달아 이어 쓸 수 있는 글 수(보안 검수 권장 — 같은 문의에 글을 끝없이 쌓지 못하게).
 * 학원이 답하면 다시 0부터 센다. 처음 문의 글(ParentRequest.content)은 세지 않는다.
 */
export const INQUIRY_PARENT_STREAK_MAX = 5;
export const INQUIRY_WAITING_LIMIT_MESSAGE = "답변을 기다리고 있어요. 급하면 학원에 전화해 주세요";

/** 새 문의는 한 사람이 하루(KST)에 이만큼까지(환불 문의 포함 — 같은 표의 건수로 센다) */
export const INQUIRY_DAILY_NEW_MAX = 20;

/**
 * 학부모가 이어 쓴 글에 원장 앱 알림을 만들 것인가 — «바로 앞 글이 학원 글일 때만».
 * 처음 문의 때 이미 알림이 갔고, 학부모가 연달아 쓰는 글마다 알림을 만들면 알림이 쏟아진다.
 * previousAuthor = 방금 쓴 글 바로 앞의 «이어 쓴 글» 글쓴이(없으면 null → 옛 답변이 있으면 학원, 없으면 학부모의 처음 글).
 */
export function shouldNotifyAdminsOfFollowUp(previousAuthor: InquiryAuthor | null, adminNote: string | null | undefined): boolean {
  const previous = previousAuthor ?? ((adminNote ?? "").trim() ? "ADMIN" : "PARENT");
  return previous === "ADMIN";
}

/** 목록 한 줄의 «첫 줄» — 글의 첫 줄만(빈 줄 제외), 길면 화면이 줄여 보인다 */
export function inquiryFirstLine(content: string): string {
  return String(content ?? "").split("\n").map((line) => line.trim()).find(Boolean) ?? "";
}

/**
 * 학부모가 글을 이어 쓴 뒤의 관리자 상태: 언제나 «대기중»으로 되돌린다.
 * 확인됨·종결·반려였던 문의도 다시 요청함 «대기중»에 떠야 학원이 놓치지 않는다.
 */
export function statusAfterParentMessage(): "PENDING" {
  return "PENDING";
}

/**
 * 학원이 답한 뒤의 관리자 상태: 상태를 같이 골랐으면 그 값, 아니면 «대기중»만 «확인됨»으로(나머지는 그대로).
 * 답을 달았는데 «대기중»에 계속 남으면 처리할 일 수가 줄지 않는다.
 */
export const ADMIN_REQUEST_STATUSES = ["PENDING", "CONFIRMED", "COMPLETED", "REJECTED"] as const;
export function statusAfterAdminReply(current: string, chosen?: string | null): string {
  if (chosen && (ADMIN_REQUEST_STATUSES as readonly string[]).includes(chosen)) return chosen;
  return current === "PENDING" ? "CONFIRMED" : current;
}

// ── 환불 문의(c11) ───────────────────────────────────────────────────────────

/** 환불 문의를 낼 수 있는 청구 상태 — 납부 완료만(미납·취소·이미 환불된 청구는 물을 것이 없다) */
export function canAskRefund(paymentStatus: string): boolean {
  return paymentStatus === "PAID";
}

/**
 * 환불 문의 제목 — 관리자 요청함 목록에 그대로 보인다: «환불 문의 · 2026-11 수강료 72,000원».
 * 청구월이 없는 청구(기타 청구)는 월을 빼고 «환불 문의 · 유니폼 30,000원».
 */
export function refundInquiryTitle(input: { year: number | null; month: number | null; label: string; amount: number }): string {
  const ym = input.year && input.month ? `${input.year}-${String(input.month).padStart(2, "0")} ` : "";
  const label = input.label.trim() || "청구";
  return `환불 문의 · ${ym}${label} ${Math.max(0, Math.trunc(input.amount)).toLocaleString("ko-KR")}원`;
}

/** 환불 문의의 첫 글 — 학부모가 사유를 안 적어도 접수된다(제목에 청구가 적혀 있다) */
export function refundInquiryContent(reason: string, title: string): string {
  const trimmed = reason.trim();
  return trimmed ? trimmed : `${title.replace(/^환불 문의 · /, "")} 환불을 문의합니다.`;
}
