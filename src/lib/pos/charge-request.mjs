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

// ───────────────────────────── 묶음(같은 학생 여러 건을 결제 한 번) ─────────────────────────────
//
// 2026-11-08 원장 결정 «같은 학생이면 한 번에 결제». 요청 1건 = POS 주문 1건 = 청구 N건(항목 N개).
// 단건 요청도 «항목 1개 묶음»으로 같은 규칙을 지난다.

/** 한 요청에 묶을 수 있는 청구 수. POS 주문 항목이 그만큼 늘어 플러그인 SDK 호출도 늘어난다(요청 한도). */
export const MAX_CHARGE_ITEMS = 10;

/** 한 요청 합계 상한 — 플러그인 MAX_AMOUNT(apps/toss-pos-plugin/src/core/order.ts)와 같은 값. 넘으면 POS 가 결제창을 열지 않는다. */
export const MAX_CHARGE_TOTAL = 5_000_000;

/**
 * 청구 여러 건을 한 요청으로 묶을 수 있나. 못 하면 사람이 읽는 이유.
 * @param payments [{ id, studentId, type, status, amount }] (서버 DB 값)
 */
export function chargeBundleEligibility(payments) {
  const list = Array.isArray(payments) ? payments : [];
  if (list.length === 0) return { ok: false, reason: "현장 결제할 청구를 선택해 주세요." };
  if (list.length > MAX_CHARGE_ITEMS) {
    return { ok: false, reason: `한 번에 현장 결제할 수 있는 청구는 ${MAX_CHARGE_ITEMS}건까지입니다.` };
  }
  const ids = list.map((p) => String(p?.id ?? ""));
  if (new Set(ids).size !== ids.length) return { ok: false, reason: "같은 청구가 두 번 들어 있습니다." };
  for (const p of list) {
    const one = chargeEligibility(p);
    if (!one.ok) return list.length > 1 ? { ok: false, reason: `선택한 청구 중 ${one.reason}` } : one;
  }
  // 학생이 섞이면 POS 결제 한 번이 누구 돈인지 갈린다 → 같은 학생만(형제는 학생별로 따로)
  const students = new Set(list.map((p) => String(p?.studentId ?? "")));
  if (students.size !== 1 || students.has("")) {
    return { ok: false, reason: "같은 학생의 청구만 한 번에 현장 결제할 수 있습니다. 학생별로 나눠 보내 주세요." };
  }
  const total = list.reduce((acc, p) => acc + Number(p.amount), 0);
  if (total > MAX_CHARGE_TOTAL) {
    return { ok: false, reason: `합계(${formatChargeWon(total)})가 한 번에 받을 수 있는 금액(${formatChargeWon(MAX_CHARGE_TOTAL)})을 넘습니다.` };
  }
  return { ok: true, reason: "" };
}

/**
 * POS 주문 항목 순서 — 연·월 오름차순, 같은 달이면 수강료 → 셔틀비, 마지막은 id.
 * 맨 앞 항목이 요청의 «대표 청구»(PosChargeRequest.paymentId)가 된다. 원본 배열은 바꾸지 않는다.
 */
export function sortChargeItems(payments) {
  const typeRank = (t) => (t === "MONTHLY" ? 0 : t === "SHUTTLE" ? 1 : 2);
  const n = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? Number.MAX_SAFE_INTEGER : Number(v));
  return [...(Array.isArray(payments) ? payments : [])].sort((a, b) =>
    n(a?.year) - n(b?.year)
    || n(a?.month) - n(b?.month)
    || typeRank(a?.type) - typeRank(b?.type)
    || String(a?.id).localeCompare(String(b?.id)));
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
 * @param input.request   { status, amount, taxFreeAmount, tossPaymentId, expiresAt, isExpiredNow? }   (DB 값 · isExpiredNow = DB 시계로 지금 만료됐나)
 * @param input.site      { status, amount, type }                        (청구서 DB 값 — 단건·대표 청구)
 * @param input.items     [{ status, paymentAmount, amount, type }]       (묶음일 때 묶인 청구 전부: 청구 DB 상태·금액 + 항목 스냅샷 금액.
 *                        2건 이상이면 site 대신 이것으로 «전부 미납·금액 그대로·합계 = 요청 금액»을 본다)
 * @param input.approved  [{ tossPaymentId, amount, approvedAtIso, taxExemptAmount, sourceType }]  (방식 무관 승인 결제)
 * @param input.others    [{ id, state }]                                 (승인 아닌 결제)
 * @param input.orderCompleted  주문이 끝났나(모르면 true = 기다리지 않고 보수적으로 보류)
 * @param input.nowMs     승인 시각을 모를 때 쓸 현재 시각
 * @returns {{ action: string, reason: string, payment: object|null, payments: object[], paidAtIso: string|null, waiting?: boolean }}
 *   payment = 대표 결제, payments = 이 요청에 쓰인 승인 결제 전부(승인 순), paidAtIso = 마지막 승인 시각(납부일·만료 판단)
 */
export function decideChargeMatch({ request, site, items = null, approved = [], others = [], orderCompleted = true, nowMs = Date.now() }) {
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
  // 분할 결제 대기는 «요청 유효 시간 안»에서만(2026-11-08 검수): 주문이 끝나지 않은 채 버려지면
  // 완료 웹훅이 영영 안 와서 슬랙 확인·보류 알림이 사라진다. 유효 시간이 지나면 기다리지 않고 보류한다
  // (웹훅 처리부는 대기 판정이면 처리 완료로 표시하지 않아, 10분 스윕이 다시 와서 이 줄로 보류시킨다).
  // 지금 만료됐나 = DB 시계 값(request.isExpiredNow)이 있으면 그것, 없으면 nowMs 와 만료 시각 비교
  const waitExpiresMs = toMs(request.expiresAt);
  const waitExpired = status === CHARGE_STATUS.EXPIRED
    || (typeof request.isExpiredNow === "boolean" ? request.isExpiredNow : waitExpiresMs != null && nowMs > waitExpiresMs);
  if (sumAmount < want && !orderCompleted && waitExpired) {
    return hold(`${what}(${sumAmount}원)가 요청 금액(${want}원)보다 적은 채 요청 유효 시간(30분)이 지났습니다.`);
  }
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
  if (Array.isArray(items) && items.length > 1) {
    // 묶음: 묶인 청구 «전부»가 미납·금액 그대로일 때만. 하나라도 어긋나면 일부만 납부하지 않고 전체 보류.
    const n = items.length;
    const paid = items.filter((it) => String(it?.status) === "PAID").length;
    if (paid > 0) return hold(`묶인 청구 ${n}건 중 ${paid}건이 이미 납부완료입니다.`);
    const notUnpaid = items.filter((it) => !CHARGEABLE_PAYMENT_STATUSES.includes(String(it?.status)));
    if (notUnpaid.length > 0) {
      return hold(`묶인 청구 ${n}건 중 ${notUnpaid.length}건이 미납이 아닙니다(${notUnpaid.map((it) => it?.status ?? "없음").join(", ")}).`);
    }
    if (items.some((it) => !CHARGEABLE_PAYMENT_TYPES.includes(String(it?.type)))) {
      return hold("묶인 청구에 수강료·셔틀비가 아닌 청구가 있습니다.");
    }
    const changed = items.filter((it) => Number(it?.paymentAmount) !== Number(it?.amount)).length;
    if (changed > 0) return hold(`요청을 만든 뒤 묶인 청구 ${changed}건의 금액이 바뀌었습니다.`);
    const itemSum = items.reduce((acc, it) => acc + Number(it?.amount), 0);
    if (itemSum !== Number(request.amount)) {
      return hold(`묶인 청구 합계(${itemSum}원)가 요청 금액(${Number(request.amount)}원)과 다릅니다.`);
    }
  } else {
    // 단건(항목 1개·옛 요청): 예전 판정 그대로
    if (!site) return hold("청구서를 찾지 못했습니다.");
    if (!CHARGEABLE_PAYMENT_STATUSES.includes(String(site.status))) {
      return hold(site.status === "PAID" ? "청구서가 이미 납부완료입니다." : `청구서 상태가 미납이 아닙니다(${site.status}).`);
    }
    if (Number(site.amount) !== Number(request.amount)) {
      return hold("요청을 만든 뒤 청구 금액이 바뀌었습니다.");
    }
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

// ───────────────────────────── 결제 취소(사이트 → POS) · 환불 판정 ─────────────────────────────
//
// 2026-11-08 원장 지시 «사이트에서 결제 취소하면 POS 결제도 취소되게».
// 흐름: 관리자 «결제 취소» → 요청 cancelState=REQUESTED → 플러그인이 가져가(SENT) payment.cancel 호출
//       → 토스 웹훅 → 주문 재조회 → decideChargeCancel 이 «전부 취소»면 청구서 환불(REFUNDED).
// 환불 확정은 토스 웹훅 재조회로만 한다(플러그인 보고는 기록만 — 납부 확정과 같은 원칙).
// POS 에서 사람이 직접 취소해도 같은 웹훅이 오므로 같은 길로 환불된다.

/** 결제 취소 진행 상태. DB CHECK 와 같은 목록이다(테스트가 마이그레이션과 비교). */
export const CANCEL_STATE = Object.freeze({
  REQUESTED: "REQUESTED", // 사이트에서 취소 요청(플러그인이 아직 안 가져감)
  SENT: "SENT", // 플러그인이 가져가 POS 에서 취소 중
  FAILED: "FAILED", // 플러그인이 취소하지 못함 → POS 에서 직접 취소 안내
  PARTIAL: "PARTIAL", // 분할 결제 중 일부만 취소됨 → 사람 확인(청구서는 그대로)
  DONE: "DONE", // 토스 웹훅으로 전부 취소 확인 → 청구서 환불
});

/** 다시 «결제 취소»를 누를 수 있는 상태(취소 없음·실패·일부만 취소) */
export const RETRYABLE_CANCEL_STATES = Object.freeze([CANCEL_STATE.FAILED, CANCEL_STATE.PARTIAL]);

/** 토스 결제 상태 중 «취소 끝»으로 보는 값(부분취소 등 그 밖의 값은 취소 끝이 아니다) */
export const CANCELLED_PAYMENT_STATES = Object.freeze(["CANCELLED", "CANCELED", "REFUNDED"]);

/** 사이트 취소 요청 뒤 플러그인이 이 시간(초) 안에 안 가져가면 «POS 에서 직접 취소» 안내 */
export const CANCEL_PICKUP_TIMEOUT_SEC = 90;

const PAYMENT_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * 이 요청으로 납부된 토스 결제 ID 전부. 분할 결제는 대표 결제만 유일 칸(tossPaymentId)에 있어서
 * 감사 기록(POS_CHARGE_PAYMENTS metadata.payments) → note(«분할 결제 N건: id(…) + id(…)») → 대표 결제 순으로 찾는다.
 * 대표 결제는 항상 포함한다. 나온 순서, 중복 제거.
 * @param {{ tossPaymentId?: string|null, note?: string|null, auditPaymentIds?: string[]|null }} input
 * @returns {string[]}
 */
export function chargePaymentIdsOf({ tossPaymentId, note, auditPaymentIds }) {
  const out = [];
  const push = (v) => {
    const id = String(v ?? "").trim();
    if (PAYMENT_ID_RE.test(id) && !out.includes(id)) out.push(id);
  };
  push(tossPaymentId);
  if (Array.isArray(auditPaymentIds) && auditPaymentIds.length > 0) {
    for (const id of auditPaymentIds) push(id);
    return out;
  }
  const m = /분할 결제 \d+건:\s*(.+)/.exec(String(note ?? ""));
  if (m) for (const part of m[1].matchAll(/([A-Za-z0-9_-]{1,100})\(/g)) push(part[1]);
  return out;
}

/**
 * 토스 재조회 주문 ↔ 이 요청의 결제들 → 취소 판정.
 *   FULL    요청의 결제가 «전부» 취소 끝 → 청구서 환불
 *   PARTIAL 일부만 취소·부분취소·주문에서 사라짐 → 청구서 그대로, 사람 확인
 *   NONE    전부 아직 승인 → 할 일 없음
 * @param {{ paymentIds: string[], order: any }} input
 * @returns {{ action: "FULL"|"PARTIAL"|"NONE", cancelled: string[], other: { id: string, state: string }[] }}
 */
export function decideChargeCancel({ paymentIds, order }) {
  const byId = new Map();
  for (const p of Array.isArray(order?.payments) ? order.payments : []) {
    if (p?.id != null) byId.set(String(p.id), String(p?.state ?? "").toUpperCase());
  }
  const ids = Array.isArray(paymentIds) ? paymentIds : [];
  const cancelled = [];
  const other = [];
  let approved = 0;
  for (const id of ids) {
    const state = byId.has(id) ? byId.get(id) : "MISSING";
    if (CANCELLED_PAYMENT_STATES.includes(state)) cancelled.push(id);
    else if (state === "APPROVED") approved += 1;
    else other.push({ id, state });
  }
  if (ids.length > 0 && cancelled.length === ids.length) return { action: "FULL", cancelled, other };
  if (approved === ids.length) return { action: "NONE", cancelled, other };
  return { action: "PARTIAL", cancelled, other };
}

/**
 * 관리자 «결제 취소»를 걸 수 있나. 못 하면 사람이 읽는 이유.
 * @param {{ request: { status: string, cancelState: string|null } | null, site: { status: string, paidProvider: string|null } | null }} input
 */
export function cancelEligibility({ request, site, sites = null }) {
  if (!request) return { ok: false, reason: "현장 결제로 납부된 기록을 찾지 못했습니다." };
  if (String(request.status) !== CHARGE_STATUS.PAID) return { ok: false, reason: "현장 결제로 납부된 요청이 아닙니다." };
  if (Array.isArray(sites) && sites.length > 1) {
    // 묶음: POS 결제 하나를 취소하면 묶인 청구가 «전부» 환불된다 → 전부 토스 POS 납부완료일 때만
    const notPaid = sites.filter((s) => s?.status !== "PAID").length;
    if (notPaid > 0) return { ok: false, reason: `묶인 청구 ${sites.length}건 중 ${notPaid}건이 납부완료가 아닙니다. 수납 화면에서 확인해 주세요.` };
    if (sites.some((s) => s?.paidProvider !== "TOSS_POS")) {
      return { ok: false, reason: "묶인 청구 중 토스 POS 가 아닌 방법으로 납부된 건이 있습니다. POS 에서 직접 취소해 주세요." };
    }
  } else {
    if (!site || site.status !== "PAID") return { ok: false, reason: "납부완료 청구서만 결제 취소할 수 있습니다." };
    if (site.paidProvider !== "TOSS_POS") return { ok: false, reason: "토스 POS 로 받은 결제만 여기서 취소할 수 있습니다." };
  }
  const cs = request.cancelState ?? null;
  if (cs === CANCEL_STATE.DONE) return { ok: false, reason: "이미 환불 처리됐습니다." };
  if (cs === CANCEL_STATE.REQUESTED || cs === CANCEL_STATE.SENT) return { ok: false, reason: "이미 POS 에 결제 취소를 보냈습니다." };
  if (cs !== null && !RETRYABLE_CANCEL_STATES.includes(cs)) return { ok: false, reason: `취소 상태가 올바르지 않습니다(${cs}).` };
  return { ok: true, reason: "" };
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

/**
 * 묶음 요약(관리자 화면·슬랙). 항목 순서대로 받는다(sortChargeItems).
 *   1건 → «2026년 11월 수강료»  /  여러 건 → «수강료 11월 외 1건»
 * @param items [{ year, month, type }]
 */
export function chargeItemsSummary(items) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return "";
  const [first] = list;
  if (list.length === 1) return buildChargeItemName({ year: first.year, month: first.month, type: first.type, maskedName: "" }).trim();
  const when = first.month ? ` ${first.month}월` : "";
  return `${paymentTypeLabel(first.type)}${when} 외 ${list.length - 1}건`;
}

/**
 * 묶음 요청의 POS 대표 상품명(플러그인 알림·목록). 예: «2026년 11월 수강료 외 1건(홍*동)».
 * 항목별 상품명은 buildChargeItemName 을 그대로 쓴다. 1건이면 buildChargeItemName 과 같다.
 */
export function buildChargeBundleName({ items, maskedName }) {
  const list = Array.isArray(items) ? items : [];
  const [first] = list;
  if (!first) return buildChargeItemName({ year: null, month: null, type: "", maskedName });
  if (list.length === 1) return buildChargeItemName({ ...first, maskedName });
  const when = first.year && first.month ? `${first.year}년 ${first.month}월 ` : "";
  const who = maskedName ? `(${maskedName})` : "";
  return `${when}${paymentTypeLabel(first.type)} 외 ${list.length - 1}건${who}`.slice(0, 60);
}

/** 원 단위 표시 (180000 → «180,000원») */
export function formatChargeWon(amount) {
  return `${Math.round(Number(amount) || 0).toLocaleString("ko-KR")}원`;
}
