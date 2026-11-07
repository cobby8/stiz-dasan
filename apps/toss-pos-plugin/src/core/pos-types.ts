// 플러그인이 쓰는 토스 POS SDK 기능만 골라 적은 «최소 모양».
// 핵심 로직(core)은 실제 SDK 를 직접 import 하지 않고 이 모양만 받는다 → 단위 테스트에서 가짜 SDK 를 꽂을 수 있다.
// 근거 문서(2026-11-07 확인, SDK 0.0.31):
//   draftOrder  https://docs.tossplace.com/reference/plugin-sdk/pos/draftOrder.html
//   payment     https://docs.tossplace.com/reference/plugin-sdk/pos/payment.html
//   order       https://docs.tossplace.com/reference/plugin-sdk/pos/order.html
//   http        https://docs.tossplace.com/reference/plugin-sdk/pos/http.html

/** draftOrder.addLineItem 에 넘기는 항목(문서의 PluginDraftOrderItem 에서 key 만 선택) */
export type DraftLineItemInput = {
  // 문서엔 «선택»이지만 SDK 0.0.31 타입은 사실상 필수(PluginDraftOrderItem & {key?}) — 항상 넣는다
  key: string;
  item: {
    id: number; // 0 = 토스 POS 에 등록되지 않은 상품
    title: string;
    category: { id: number; title: string };
    options: never[]; // 미등록 상품이라 옵션 없음
    code?: string;
    type: "ITEM";
  };
  itemPrice: {
    isTaxFree: boolean;
    priceType: "FIXED";
    priceUnit: number;
    priceValue: number; // 부가세 포함 가격(면세면 그대로 금액)
    title: string;
  };
  discount: never[];
  memo: string;
  optionChoices: never[];
  quantity: number;
  diningOption: "HERE";
  metadata?: { disableMemoEdit?: boolean; disableOptionEdit?: boolean; disableQuantityEdit?: boolean };
};

export type DraftOrderLike = {
  lineItems: Array<{
    key: string;
    memo?: string;
    quantity: number;
    item?: { code?: string };
    // 담긴 항목의 가격 — 금액 검사(order.ts checkDraftAfterAdd)가 이 값으로 판단한다
    itemPrice?: { priceValue?: number; priceUnit?: number; isTaxFree?: boolean };
  }>;
  memo?: string;
  // orderPriceValue = 원주문금액 + 할인 + 보증금 + 봉사료(SDK 타입 PluginDraftOrderPrice). 담은 직후엔 재계산 전일 수 있다
  price?: { orderPriceValue?: number };
};

export type OrderLike = {
  id: string;
  memo?: string;
  lineItems?: Array<{ memo?: string; item?: { code?: string; title?: string } }>;
};

export type PaymentLike = {
  id: string;
  orderId: string;
  state?: string;
  amountMoney?: number;
  taxExemptMoney?: number;
};

export type HttpResponseLike = { code: number; body: string };
export type Headers = [string, string][];

export type PosSdkLike = {
  draftOrder: {
    get(): Promise<DraftOrderLike>;
    clear(): Promise<void>;
    addLineItem(item: DraftLineItemInput): Promise<DraftOrderLike>;
    startPayment(): Promise<void>;
  };
  order: { getOrder(orderId: string): Promise<OrderLike> };
  payment: { getPayment(paymentId: string): Promise<PaymentLike> };
  toast: {
    success(p: { message: string; button?: { text: string; onClick: () => void } }): void;
    warn(p: { message: string; button?: { text: string; onClick: () => void } }): void;
    error(p: { message: string; button?: { text: string; onClick: () => void } }): void;
  };
  alert: { open(p: { message: string }): void };
  storage: { get(key: string): Promise<string | undefined>; set(key: string, value: string): Promise<void> };
};

export type HttpLike = {
  get(url: string, headers?: Headers, options?: { timeoutMs?: number }): Promise<HttpResponseLike>;
  post(url: string, payload: unknown, headers?: Headers, options?: { timeoutMs?: number }): Promise<HttpResponseLike>;
};
