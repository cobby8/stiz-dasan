/**
 * 토스 POS «현장 결제» 요청 — 순수 규칙 모듈 (DB·네트워크·환경변수 없음)
 *
 * ■ 무엇을 하나
 *   관리자가 청구서에서 «현장 결제»를 누르면 번호(S-482193)가 붙은 요청이 생긴다.
 *   선생님이 POS 주문 메모에 «STIZ:S-482193» 을 넣고(또는 플러그인이 넣고) 결제를 받으면(카드·현금·QR·계좌이체 등 방식 무관, 분할 포함),
 *   토스 웹훅 → 주문 재조회 → 이 모듈의 판정(decideChargeMatch)으로 «자동 납부 / 보류 / 넘김»을 정한다.
 *
 * ■ 여기 있는 것
 *   - 상태 목록(DB CHECK·부분 유일 인덱스와 같은 목록 — 테스트가 마이그레이션과 비교한다)
 *   - 번호 만들기·형식 검사, 주문 메모에서 번호 찾기
 *   - 매칭 판정(금액·상태·만료·분할 결제 합계·부분취소) · 결제 방식 → Payment.method 값·표시
 *   - 이름 가리기, POS 상품명·메모 문구
 *
 * 설계: docs/toss-pos-plugin-plan.md. 테스트: tests/pos-charge-request.test.mjs
 */

// ───────────────────────────── 상수 ─────────────────────────────

/** 요청 상태. DB CHECK 와 같은 목록이다. */
export const CHARGE_STATUS = Object.freeze({
  PENDING: "PENDING", // 사이트에서 만듦(POS 가 아직 안 가져감)
  SENT: "SENT", // 플러그인이 가져감(선점)
  PAID: "PAID", // 토스 웹훅 + 재조회로 확인 → 청구서 납부완료
  CANCELLED: "CANCELLED", // 관리자·플러그인이 취소
  EXPIRED: "EXPIRED", // 30분 지남
  HELD: "HELD", // 결제는 왔는데 자동 반영 조건이 안 맞음 → 원장이 슬랙에서 확인
});

/** «열린» 요청 — 같은 청구서·같은 번호로 하나만 있을 수 있다(부분 유일 인덱스와 같은 목록). */
export const OPEN_CHARGE_STATUSES = Object.freeze(["PENDING", "SENT"]);

/** «현장 결제»를 만들 수 있는 청구서 종류 — 수강료·셔틀비(둘 다 면세, 원장 결정 D2). */
export const CHARGEABLE_PAYMENT_TYPES = Object.freeze(["MONTHLY", "SHUTTLE"]);

/** «현장 결제»를 만들 수 있는 청구서 상태 — 미납만. */
export const CHARGEABLE_PAYMENT_STATUSES = Object.freeze(["PENDING", "OVERDUE"]);

/** 요청 유효 시간(분). SQL 에서 now() + interval 로 쓴다(서버 시계 대신 DB 시계). */
export const CHARGE_EXPIRES_MINUTES = 30;

/**
 * 번호 형식: S- + 숫자 6자리 (예: S-482193).
 * 6자리인 이유(검수 2026-11-07): 선생님이 손으로 잘못 친 번호가 «같은 금액의 다른 열린 요청»과 우연히 맞을 확률을
 * 낮춘다(4자리는 1만 개 중 하나, 6자리는 100만 개 중 하나).
 */
export const SHORT_CODE_RE = /^S-\d{6}$/;
/** 번호 숫자 자리 수 */
export const SHORT_CODE_DIGITS = 6;

/** POS 메모 앞머리 — 학원 결제임을 표시해 다른 메모(이름·반)와 섞여도 찾을 수 있게 한다. */
export const MEMO_PREFIX = "STIZ:";

/**
 * 메모에서 번호 찾기. 선생님이 손으로 칠 때의 흔한 변형을 받아 준다:
 *   «STIZ:S-482193» «stiz: s-482193» «STIZ S482193» «STIZ：S-482193»(전각 콜론)
 * 단, «STIZ» 머리말은 반드시 있어야 한다 — 맨 숫자는 전화번호·금액과 헷갈린다.
 * 숫자는 4~6자리까지 읽는다(플러그인 계약 /STIZ:S-\d{4,6}/). 지금 번호는 6자리라 4·5자리는 읽혀도
 * 맞는 요청이 없어 자동 처리되지 않는다. 7자리 이상 이어지면 번호가 아니다.
 */
const MEMO_CODE_RE = /STIZ\s*[:：]?\s*S\s*-?\s*(\d{4,6})(?!\d)/gi;

// ───────────────────────────── 번호 ─────────────────────────────

/** 0~999999 숫자 → «S-000042» */
export function formatShortCode(n) {
  const value = Math.trunc(Number(n));
  if (!Number.isFinite(value) || value < 0 || value > 999999) throw new Error(`번호 범위 밖: ${n}`);
  return `S-${String(value).padStart(SHORT_CODE_DIGITS, "0")}`;
}

/**
 * 무작위 번호. randomInt(max) 는 0 이상 max 미만 정수를 돌려주는 함수(서버는 crypto.randomInt).
 * 충돌(열린 요청끼리 같은 번호)은 DB 부분 유일 인덱스가 막고, 호출한 쪽이 다시 뽑는다.
 */
export function randomShortCode(randomInt) {
  return formatShortCode(randomInt(1_000_000));
}

export function isShortCode(value) {
  return typeof value === "string" && SHORT_CODE_RE.test(value);
}

/** 메모 문구(POS 주문 메모에 넣는 값). 예: «STIZ:S-482193» */
export function buildChargeMemo(shortCode) {
  if (!isShortCode(shortCode)) throw new Error(`번호 형식이 아닙니다: ${shortCode}`);
  return `${MEMO_PREFIX}${shortCode}`;
}

/** 아무 글에서 번호를 모두 찾아 «S-숫자» 로 정리(중복 제거, 나온 순서). */
export function extractChargeCodesFromText(text) {
  const out = [];
  for (const m of String(text ?? "").matchAll(MEMO_CODE_RE)) {
    const code = `S-${m[1]}`;
    if (!out.includes(code)) out.push(code);
  }
  return out;
}

/**
 * 토스 주문에서 번호를 찾는다 — 주문 메모 · 품목 메모 · 품목 상품의 메모·상품 코드.
 * 플러그인은 SDK 에 «주문 전체 메모» 함수가 없어 번호를 **lineItems[].memo 와 item.code** 에 넣는다(플러그인 팀 계약).
 * 선생님이 손으로 넣을 때는 주문 메모에 넣는다.
 */
export function extractChargeCodes(order) {
  const memos = [];
  const push = (v) => {
    if (typeof v === "string" && v.trim()) memos.push(v);
  };
  push(order?.memo);
  for (const li of Array.isArray(order?.lineItems) ? order.lineItems : []) {
    push(li?.memo);
    push(li?.code);
    push(li?.item?.memo);
    push(li?.item?.code);
  }
  return extractChargeCodesFromText(memos.join("\n"));
}

/**
 * 주문 안의 «승인 아닌» 결제(취소·부분취소 등). 이 중 하나라도 있으면 자동 반영하지 않는다.
 * 승인 결제 목록(방식 무관)은 payment-notice.mjs 의 extractChargePayments 한 벌을 쓴다(사본 금지).
 */
/**
 * 주문의 결제별 면세 금액(토스플레이스 결제의 taxExemptAmount). 칸이 없으면 null.
 * 결제 ID → 면세 금액. 판정은 decideChargeMatch 가 한다.
 */
export function taxExemptAmountsOf(order) {
  const out = {};
  for (const p of Array.isArray(order?.payments) ? order.payments : []) {
    if (p?.id == null) continue;
    const raw = p?.taxExemptAmount;
    const n = raw == null || raw === "" ? NaN : Number(raw);
    out[String(p.id)] = Number.isFinite(n) ? Math.round(n) : null;
  }
  return out;
}

export function nonApprovedPayments(order) {
  const out = [];
  for (const p of Array.isArray(order?.payments) ? order.payments : []) {
    const state = String(p?.state ?? "").toUpperCase();
    if (state === "APPROVED") continue;
    out.push({ id: p?.id == null ? "" : String(p.id), state, sourceType: String(p?.sourceType ?? "").toUpperCase() });
  }
  return out;
}

// ───────────────────────────── 청구서 판정 ─────────────────────────────

/** 이 청구서로 «현장 결제»를 만들 수 있나. 못 하면 사람이 읽는 이유. */
export function chargeEligibility(payment) {
  if (!payment) return { ok: false, reason: "청구서를 찾지 못했습니다." };
  if (!CHARGEABLE_PAYMENT_TYPES.includes(String(payment.type))) {
    return { ok: false, reason: "현장 결제는 수강료·셔틀비 청구서에만 쓸 수 있습니다." };
  }
  if (!CHARGEABLE_PAYMENT_STATUSES.includes(String(payment.status))) {
    return { ok: false, reason: "미납 청구서에만 현장 결제를 요청할 수 있습니다." };
  }
  const amount = Number(payment.amount);
  if (!Number.isSafeInteger(amount) || amount <= 0) return { ok: false, reason: "청구 금액이 올바르지 않습니다." };
  return { ok: true, reason: "" };
}

// ───────────────────────────── 매칭 판정 ─────────────────────────────

/** 판정 결과 */
export const MATCH_ACTION = Object.freeze({
  PAY: "PAY", // 자동 납부(요청 PAID 선점 → 원장부 함수)
  HOLD: "HOLD", // 요청 HELD + 기존 슬랙 확인 흐름
  ALREADY_DONE: "ALREADY_DONE", // 같은 결제로 이미 PAID(웹훅이 주문·결제로 두 번 옴) → 조용히 끝
  SKIP: "SKIP", // 이 요청과 상관없이 기존 흐름 그대로
});

const toMs = (v) => {
  if (v == null || v === "") return null;
  if (v instanceof Date) return v.getTime();
  const ms = Date.parse(String(v));
  return Number.isFinite(ms) ? ms : null;
};

/** 결제 금액·면세 금액을 정수로(못 읽으면 null) */
const intOrNull = (v) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
};

/**
 * 웹훅으로 온 주문 1건 ↔ 요청 1건 판정.
 *
 * ■ 결제 방식(2026-11-08 원장 지시): 카드·현금·QR/토스페이(BARCODE)·계좌이체·외부·선불 — **방식과 무관하게**
 *   APPROVED 결제를 전부 인정한다. 번호가 붙은 주문은 학생·금액이 서버에서 이미 정해져 있기 때문이다.
 * ■ 분할 결제: 한 주문의 승인 결제가 여러 건이면 «합계 금액 = 요청 금액» + «합계 면세 = 요청 면세»일 때 납부.
 *   - 합계가 아직 모자라면 주문이 끝나기 전에는 SKIP(waiting) — 다음 결제의 웹훅·주문 완료 웹훅에서 다시 본다.
 *   - 주문이 끝났는데도 모자라면 HOLD.
 *   - 대표 결제 = 가장 먼저 승인된 것(요청의 tossPaymentId 유일 칸에 들어간다).
 *
 * @param input.request   { status, amount, taxFreeAmount, tossPaymentId, expiresAt }   (DB 값)
 * @param input.site      { status, amount, type }                        (청구서 DB 값)
 * @param input.approved  [{ tossPaymentId, amount, approvedAtIso, taxExemptAmount, sourceType }]  (방식 무관 승인 결제)
 * @param input.others    [{ id, state }]                                 (승인 아닌 결제)
 * @param input.orderCompleted  주문이 끝났나(모르면 true = 기다리지 않고 보수적으로 보류)
 * @param input.nowMs     승인 시각을 모를 때 쓸 현재 시각
 * @returns {{ action: string, reason: string, payment: object|null, payments: object[], paidAtIso: string|null, waiting?: boolean }}
 *   payment = 대표 결제, payments = 이 요청에 쓰인 승인 결제 전부(승인 순), paidAtIso = 마지막 승인 시각(납부일·만료 판단)
 */
export function decideChargeMatch({ request, site, approved = [], others = [], orderCompleted = true, nowMs = Date.now() }) {
  const none = (action, reason, extra = {}) => ({ action, reason, payment: null, payments: [], paidAtIso: null, ...extra });
  if (!request) return none(MATCH_ACTION.SKIP, "번호에 맞는 요청이 없습니다.");
  const status = String(request.status);

  // 승인 순서로 정렬(시각을 모르면 뒤로) — 대표 결제는 맨 앞, 납부일은 맨 뒤 시각.
  const sorted = [...approved].sort((a, b) => {
    const am = toMs(a?.approvedAtIso);
    const bm = toMs(b?.approvedAtIso);
    if (am !== bm) return am == null ? 1 : bm == null ? -1 : am - bm;
    return String(a?.tossPaymentId).localeCompare(String(b?.tossPaymentId));
  });
  const payment = sorted[0] ?? null;
  // 승인 시각을 하나라도 모르면 «마지막 시각»을 알 수 없다 → null(호출한 쪽이 지금 시각을 쓴다)
  const allTimed = sorted.length > 0 && sorted.every((p) => toMs(p.approvedAtIso) != null);
  const lastIso = allTimed ? sorted[sorted.length - 1].approvedAtIso : null;
  const sumAmount = sorted.reduce((acc, p) => acc + (intOrNull(p.amount) ?? 0), 0);
  const base = { payment, payments: sorted, paidAtIso: lastIso };

  // 이미 납부 반영된 요청: 같은 대표 결제면 «처리 끝», 다른 결제면 중복 결제 → 기존 흐름(ALREADY_PAID 로 원장 확인)
  if (status === CHARGE_STATUS.PAID) {
    const same = sorted.find((p) => p.tossPaymentId && p.tossPaymentId === request.tossPaymentId);
    if (!same) return none(MATCH_ACTION.SKIP, "요청은 이미 다른 결제로 납부 반영됐습니다(중복 결제 의심).");
    // 분할 결제였으면(합계 = 요청 금액) 그 주문의 승인 결제 전부가 이 요청 몫이다. 아니면 대표 결제만.
    const mine = sumAmount === Number(request.amount) ? sorted : [same];
    return { action: MATCH_ACTION.ALREADY_DONE, reason: "이미 자동 납부 반영된 결제입니다.", payment: same, payments: mine, paidAtIso: lastIso };
  }
  // 취소·보류된 요청은 다시 자동 처리하지 않는다 → 기존 슬랙 흐름
  if (status === CHARGE_STATUS.CANCELLED) return none(MATCH_ACTION.SKIP, "취소된 요청입니다.");
  if (status === CHARGE_STATUS.HELD) return none(MATCH_ACTION.SKIP, "이미 확인 대기 중인 요청입니다.");

  if (sorted.length === 0) return none(MATCH_ACTION.SKIP, "승인된 결제가 아직 없습니다.");
  const hold = (reason) => ({ action: MATCH_ACTION.HOLD, reason, ...base });
  const split = sorted.length > 1;
  const what = split ? `결제 ${sorted.length}건 합계` : "결제 금액";

  // 취소·부분취소가 섞인 주문은 합계를 믿을 수 없다 → 원장 확인
  if (others.length > 0) {
    return hold(`주문에 취소·부분취소된 결제가 있습니다(${others.map((o) => o.state || "상태 없음").join(", ")}).`);
  }
  if (sorted.some((p) => intOrNull(p.amount) == null)) return hold("결제 금액을 읽지 못한 결제가 있습니다.");
  const want = Number(request.amount);
  if (sumAmount < want && !orderCompleted) {
    // 분할 결제 중간(첫 결제만 승인됨) — 아직 판단하지 않는다. 다음 웹훅·주문 완료 웹훅에서 다시 본다.
    return {
      action: MATCH_ACTION.SKIP,
      reason: `${what}(${sumAmount}원)가 요청 금액(${want}원)보다 적어 남은 결제를 기다립니다.`,
      waiting: true,
      ...base,
    };
  }
  if (sumAmount !== want) {
    return hold(`${what}(${sumAmount}원)이 요청 금액(${want}원)과 다릅니다.`);
  }
  // 면세 금액: 토스 결제의 면세(taxExemptAmount) 합계가 요청 면세액과 다르면 세금 신고가 틀어진다 → 원장 확인.
  // 한 건이라도 칸을 못 읽으면(null) 면세로 처리됐는지 알 수 없으니 역시 보류한다(보수적).
  if (sorted.some((p) => intOrNull(p.taxExemptAmount) == null)) {
    return hold("토스 결제의 면세 금액을 확인하지 못했습니다(과세로 결제됐을 수 있음).");
  }
  const sumExempt = sorted.reduce((acc, p) => acc + intOrNull(p.taxExemptAmount), 0);
  if (sumExempt !== Number(request.taxFreeAmount)) {
    const label = split ? `면세 금액 합계(${sumExempt}원)` : `면세 금액(${sumExempt}원)`;
    return hold(`${label}이 요청 면세액(${Number(request.taxFreeAmount)}원)과 다릅니다.`);
  }
  if (!site) return hold("청구서를 찾지 못했습니다.");
  if (!CHARGEABLE_PAYMENT_STATUSES.includes(String(site.status))) {
    return hold(site.status === "PAID" ? "청구서가 이미 납부완료입니다." : `청구서 상태가 미납이 아닙니다(${site.status}).`);
  }
  if (Number(site.amount) !== Number(request.amount)) {
    return hold("요청을 만든 뒤 청구 금액이 바뀌었습니다.");
  }
  // 만료: 마지막 결제 승인 시각이 만료 시각보다 늦으면 자동 반영하지 않는다(승인 시각을 모르면 지금 시각).
  const expiresMs = toMs(request.expiresAt);
  const paidMs = toMs(lastIso) ?? nowMs;
  if (status === CHARGE_STATUS.EXPIRED && (expiresMs == null || paidMs > expiresMs)) {
    return hold("요청 유효 시간(30분)이 지난 뒤 결제됐습니다.");
  }
  if (expiresMs != null && paidMs > expiresMs) return hold("요청 유효 시간(30분)이 지난 뒤 결제됐습니다.");
  if (![CHARGE_STATUS.PENDING, CHARGE_STATUS.SENT, CHARGE_STATUS.EXPIRED].includes(status)) {
    return hold(`요청 상태가 올바르지 않습니다(${status}).`);
  }
  return {
    action: MATCH_ACTION.PAY,
    reason: split ? `번호·분할 결제 ${sorted.length}건 합계·청구서 상태 일치` : "번호·금액·청구서 상태 일치",
    ...base,
  };
}

/**
 * 주문이 끝났나(분할 결제의 «마지막 판단» 시점). 웹훅 종류(order.order.completed) 또는 토스 재조회 주문의 상태·완료 시각으로 본다.
 * 셋 다 없으면 false — 아직 결제가 더 올 수 있다고 본다(합계가 맞으면 그대로 납부되니 기다림은 «모자랄 때»만 생긴다).
 */
export function isOrderCompleted(order, eventType = "") {
  if (/order\.completed/i.test(String(eventType ?? ""))) return true;
  const state = String(order?.orderState ?? order?.state ?? "").toUpperCase();
  if (["COMPLETED", "COMPLETE", "DONE", "PAID", "CLOSED"].includes(state)) return true;
  return Boolean(order?.completedAt);
}

// ───────────────────────────── 결제 방식 ─────────────────────────────

/**
 * 토스 결제 sourceType → 사이트 Payment.method 값.
 * 기존 값(CARD·CASH·BANK_TRANSFER)은 그대로 쓰고, 새로 생긴 것만 EASY_PAY(QR·토스페이)·ETC(외부·선불·모름).
 * 단건 카드는 예전과 같은 «CARD» 라 월 대사(p.method = 'CARD')·기존 화면이 그대로 동작한다.
 */
export const POS_METHOD_BY_SOURCE = Object.freeze({
  CARD: "CARD",
  CASH: "CASH",
  BARCODE: "EASY_PAY",
  ACCOUNT_TRANSFER: "BANK_TRANSFER",
});

/** Payment.method 조각 → 화면 이름 */
export const POS_METHOD_LABELS = Object.freeze({
  CARD: "카드",
  CASH: "현금",
  EASY_PAY: "간편결제(QR·토스페이)",
  BANK_TRANSFER: "계좌이체",
  ETC: "기타",
});

/** 승인 결제들의 sourceType 목록 → Payment.method 값. 분할이면 «CARD+CASH»(나온 순서, 중복 제거). */
export function posMethodOf(sourceTypes) {
  const out = [];
  for (const raw of Array.isArray(sourceTypes) ? sourceTypes : []) {
    const code = POS_METHOD_BY_SOURCE[String(raw ?? "").toUpperCase()] ?? "ETC";
    if (!out.includes(code)) out.push(code);
  }
  return out.length > 0 ? out.join("+") : "ETC";
}

/**
 * 토스 POS 로 받은 결제의 화면 표시. «CARD» → «현장 · 카드», «CARD+CASH» → «현장 · 카드+현금».
 * 모르는 조각이 섞이면 null(호출한 쪽이 기존 표시를 쓴다).
 */
export function posMethodLabel(method) {
  const parts = String(method ?? "").split("+").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0 || parts.some((p) => !POS_METHOD_LABELS[p])) return null;
  return `현장 · ${parts.map((p) => POS_METHOD_LABELS[p]).join("+")}`;
}

/** 이 주문 결제 기록 문구(요청 note·감사 기록용). 예: «분할 결제 2건: tp-1(카드 100,000원) + tp-2(현금 80,000원)» */
export function describeChargePayments(payments) {
  const list = Array.isArray(payments) ? payments : [];
  const parts = list.map((p) => {
    const code = POS_METHOD_BY_SOURCE[String(p?.sourceType ?? "").toUpperCase()] ?? "ETC";
    return `${p?.tossPaymentId}(${POS_METHOD_LABELS[code]} ${formatChargeWon(p?.amount)})`;
  });
  return `분할 결제 ${list.length}건: ${parts.join(" + ")}`;
}

// ───────────────────────────── 표시 ─────────────────────────────

/**
 * 이름 가리기(플러그인 화면용). 홍길동 → 홍*동, 홍길 → 홍*, 남궁민수 → 남**수, 한 글자는 그대로 *.
 */
export function maskStudentName(name) {
  const chars = [...String(name ?? "").trim()];
  if (chars.length === 0) return "";
  if (chars.length === 1) return "*";
  if (chars.length === 2) return `${chars[0]}*`;
  return `${chars[0]}${"*".repeat(chars.length - 2)}${chars[chars.length - 1]}`;
}

/** 청구서 종류 → 사람 말 */
export function paymentTypeLabel(type) {
  return type === "SHUTTLE" ? "셔틀비" : type === "MONTHLY" ? "수강료" : "청구";
}

/** POS 상품명. 예: «2026년 11월 수강료(홍*동)» — 이름은 가린 값을 받는다. */
export function buildChargeItemName({ year, month, type, maskedName }) {
  const when = year && month ? `${year}년 ${month}월 ` : "";
  const who = maskedName ? `(${maskedName})` : "";
  return `${when}${paymentTypeLabel(type)}${who}`.slice(0, 60);
}

/** 원 단위 표시 (180000 → «180,000원») */
export function formatChargeWon(amount) {
  return `${Math.round(Number(amount) || 0).toLocaleString("ko-KR")}원`;
}
