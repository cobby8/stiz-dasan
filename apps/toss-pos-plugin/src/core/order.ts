// 순수 규칙: 현장 결제 요청 → POS 임시 주문 항목 변환, 메모 형식, 금액 검증, 알림 문구.
// SDK 를 부르지 않는 «계산만» 하는 함수들이라 node --test 로 그대로 검사한다.
import type { ChargeRequest } from "./contract.ts";
import type { DraftLineItemInput, OrderLike } from "./pos-types.ts";

/** 메모 머리말. 서버 웹훅 매칭이 이 글자를 찾는다 */
export const MEMO_PREFIX = "STIZ:";
/** 요청 번호 형식: S- 뒤에 숫자 4~6자리(설계안 예시 S-4821) */
const SHORT_CODE_RE = /^S-\d{4,6}$/;
const MEMO_FIND_RE = /STIZ:(S-\d{4,6})(?!\d)/;

/** 한 번에 받을 수 있는 최대 금액 — 오타(0 하나 더)로 큰돈이 결제되는 것 방지 */
export const MAX_AMOUNT = 5_000_000;

export function isValidShortCode(code: string): boolean {
  return SHORT_CODE_RE.test(code);
}

/** 메모 문구: «STIZ:S-4821» */
export function formatMemo(shortCode: string): string {
  if (!isValidShortCode(shortCode)) throw new Error(`잘못된 요청 번호: ${shortCode}`);
  return `${MEMO_PREFIX}${shortCode}`;
}

/** 아무 글자에서 STIZ:S-xxxx 를 찾아 번호(S-xxxx)만 돌려준다. 없으면 null */
export function parseMemo(text: string | undefined | null): string | null {
  if (!text) return null;
  const m = MEMO_FIND_RE.exec(text);
  return m ? m[1] : null;
}

/** 결제된 주문에서 우리 요청 번호를 찾는다(항목 메모 → 상품 코드 → 주문 메모 순) */
export function findShortCodeInOrder(order: OrderLike | null | undefined): string | null {
  if (!order) return null;
  for (const li of order.lineItems ?? []) {
    const code = parseMemo(li.memo) ?? parseMemo(li.item?.code);
    if (code) return code;
  }
  return parseMemo(order.memo);
}

/** 100000 → «100,000원» (기기 언어 설정과 무관하게 같은 결과) */
export function formatWon(n: number): string {
  const s = String(Math.trunc(Math.abs(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${n < 0 ? "-" : ""}${s}원`;
}

/** 상품명: 서버가 준 이름(예: 수강료(11월)), 없으면 «수강료». POS 화면에 맞게 40자 제한 */
export function itemTitleFor(req: Pick<ChargeRequest, "title">): string {
  const t = (req.title ?? "").trim() || "수강료";
  return t.length > 40 ? t.slice(0, 40) : t;
}

/** 만료 여부. expiresAt 은 시간대가 붙은 절대 시각이라 기기 시간대와 무관하다 */
export function isExpired(req: Pick<ChargeRequest, "expiresAt">, nowMs: number): boolean {
  if (!req.expiresAt) return false;
  const t = Date.parse(req.expiresAt);
  return Number.isFinite(t) && t <= nowMs;
}

export type Validation = { ok: true } | { ok: false; reason: string };

/**
 * POS 로 넘기기 전 마지막 검사. 하나라도 걸리면 결제 화면을 열지 않는다.
 * - 수강료는 전액 면세라 «면세 금액 = 금액»일 때만 통과(한 항목 안에 과세·면세를 섞을 수 없다)
 */
export function validateForPos(req: ChargeRequest, nowMs: number): Validation {
  if (!isValidShortCode(req.shortCode)) return { ok: false, reason: "요청 번호 형식이 올바르지 않아요." };
  if (!Number.isInteger(req.amount) || req.amount <= 0) return { ok: false, reason: "금액이 올바르지 않아요." };
  if (req.amount > MAX_AMOUNT) return { ok: false, reason: `금액이 너무 커요(${formatWon(req.amount)}). 사이트에서 확인해 주세요.` };
  if (!Number.isInteger(req.taxFreeAmount)) return { ok: false, reason: "면세 금액 정보가 없어요. 사이트에서 확인해 주세요." };
  if (req.taxFreeAmount !== req.amount) {
    return { ok: false, reason: "면세·과세가 섞인 청구는 플러그인으로 결제할 수 없어요. POS 에서 직접 입력해 주세요." };
  }
  if (isExpired(req, nowMs)) return { ok: false, reason: "만료된 요청이에요. 사이트에서 다시 «현장 결제»를 눌러 주세요." };
  return { ok: true };
}

/**
 * 요청 → draftOrder.addLineItem 인자.
 * - item.id 0 = 토스 POS 에 등록되지 않은 상품(문서 TIP)
 * - 주문 전체 메모를 넣는 SDK 함수가 없어(0.0.31), 번호를 «항목 메모»와 «상품 코드» 두 곳에 넣는다
 * - 수량·메모를 선생님이 실수로 바꾸지 못하게 잠근다(바뀌면 금액·매칭이 틀어진다)
 */
export function buildLineItem(req: ChargeRequest): DraftLineItemInput {
  const memo = formatMemo(req.shortCode);
  const title = itemTitleFor(req);
  return {
    key: `stiz-${req.shortCode}`,
    item: {
      id: 0,
      title,
      category: { id: 0, title: "STIZ 수강료" },
      options: [],
      code: memo,
      type: "ITEM",
    },
    itemPrice: {
      isTaxFree: req.taxFreeAmount === req.amount,
      priceType: "FIXED",
      priceUnit: 1,
      priceValue: req.amount,
      title,
    },
    discount: [],
    memo,
    optionChoices: [],
    quantity: 1,
    diningOption: "HERE",
    metadata: { disableMemoEdit: true, disableOptionEdit: true, disableQuantityEdit: true },
  };
}

/** POS 알림 문구: «김○○ 수강료(11월) 100,000원 현장 결제 요청 (S-4821)» */
export function notificationMessage(req: ChargeRequest): string {
  return `${req.studentName} ${itemTitleFor(req)} ${formatWon(req.amount)} 현장 결제 요청 (${req.shortCode})`;
}
