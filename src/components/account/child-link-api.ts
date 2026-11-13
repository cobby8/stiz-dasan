export type ChildLinkRow = {
  id: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "CANCELED" | "EXPIRED";
  childName?: string;
  requesterName?: string;
  requesterPhoneLast4?: string;
  relation: string;
  createdAt: string;
};
export type ChildLinkState = { enabled: boolean; verified: boolean; outgoing: ChildLinkRow[]; incoming: ChildLinkRow[] };

export async function childLinkRequest(body?: Record<string, unknown>, signal?: AbortSignal) {
  const response = await fetch("/api/account/child-links", {
    method: body ? "POST" : "GET", credentials: "same-origin", cache: "no-store", signal,
    ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data || typeof data !== "object") {
    throw new Error(typeof data?.error === "string" ? data.error : "연결 정보를 확인하지 못했습니다. 다시 시도해 주세요.");
  }
  return data;
}

export function isChildLinkState(value: unknown): value is ChildLinkState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<ChildLinkState>;
  return typeof state.enabled === "boolean" && typeof state.verified === "boolean"
    && Array.isArray(state.outgoing) && Array.isArray(state.incoming);
}

/** 형제 간편 연결 제안(2026-11-13 f8) — 서버가 이름·반·처리 방법만 보낸다(학생 id·번호 없음) */
export type SiblingAction = "LINK" | "REQUEST_APPROVAL" | "ALREADY_LINKED" | "PENDING" | "ASK_ACADEMY";
export type SiblingProposal = { items: { name: string; className: string | null; action: SiblingAction }[]; canLinkAll: boolean };

const SIBLING_ACTIONS: readonly string[] = ["LINK", "REQUEST_APPROVAL", "ALREADY_LINKED", "PENDING", "ASK_ACADEMY"];

export function isSiblingProposal(value: unknown): value is SiblingProposal {
  if (!value || typeof value !== "object") return false;
  const data = value as Partial<SiblingProposal>;
  return typeof data.canLinkAll === "boolean" && Array.isArray(data.items) && data.items.every((item) =>
    item && typeof item.name === "string" && (item.className === null || typeof item.className === "string") && SIBLING_ACTIONS.includes(item.action));
}
