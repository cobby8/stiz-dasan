// 우리 사이트(서버) API 계약 — 플러그인이 부르는 주소와 응답 해석을 «이 파일 한 곳»에만 둔다.
// 근거: docs/toss-pos-plugin-plan.md 2-2 절(경로) · 3 절(토큰 Bearer 인증).
// 서버는 다른 브랜치(claude/pos-charge-request)에서 동시에 만들어지므로, 응답 칸 이름이
// camelCase 로 오든 snake_case 로 오든(사이트 apiSuccess 가 snake_case 로 자동 변환하는 함정) 둘 다 읽는다.

/** 개발자센터 ACL 에 등록해야 하는 주소. 플러그인은 ACL 에 있는 주소만 호출할 수 있다. */
export const SERVER_ORIGIN = "https://www.stiz-dasan.kr";

/** 서버 API 경로 모음 */
export const API_PATHS = {
  /** 열린(PENDING) 현장 결제 요청 목록 */
  chargeRequests: "/api/pos-plugin/charge-requests",
  /**
   * 롱폴링: 서버가 최대 waitSec 초 기다렸다가 «모르는 대기 요청»이 생기면 바로 답한다(2026-11-08).
   * known = 이미 알림을 띄운 대기 요청 id(서버가 이것 때문에 즉시 답하지 않게). 최대 20개.
   * cancels=1 = «결제 취소할 일»도 받는다는 표시(2026-11-08) — 이걸 보낸 기기만 새 취소 요청으로도 대기가 깨어난다.
   *   known 에는 이미 받은 취소 요청 id 도 넣는다(같은 id 공간).
   */
  chargeRequestsWait: (waitSec: number, known: string[] = []) => {
    const q = `wait=${Math.max(0, Math.floor(waitSec))}&cancels=1&dismiss=1`;
    const ids = known.slice(0, 20).map(encodeURIComponent).join(",");
    return `/api/pos-plugin/charge-requests?${q}${ids ? `&known=${ids}` : ""}`;
  },
  /** 요청 선점(PENDING → SENT). 응답으로 금액·면세·메모 문구를 받는다 */
  claim: (id: string) => `/api/pos-plugin/charge-requests/${encodeURIComponent(id)}/claim`,
  startCheck: (id: string) => `/api/pos-plugin/charge-requests/${encodeURIComponent(id)}/start-check`,
  /** 납부 상태 조회(읽기 전용) — startPayment 오류 뒤 웹훅이 이미 납부를 기록했는지 확인 */
  paymentState: (id: string) => `/api/pos-plugin/charge-requests/${encodeURIComponent(id)}/payment-state`,
  /** «결제 시도됨» 참고 보고. 납부 처리는 서버가 웹훅+재조회로만 한다 */
  report: (id: string) => `/api/pos-plugin/charge-requests/${encodeURIComponent(id)}/report`,
  /** 미납 청구서 검색(이름 일부) */
  unpaid: (q: string) => `/api/pos-plugin/unpaid?q=${encodeURIComponent(q)}`,
  /**
   * 미납 청구서를 골라 «요청 생성 + 선점»을 한 번에. 설계안에 경로 이름이 없어 이 이름을 제안한다
   * (보고서 «계약 변경 제안» 참고).
   */
  chargeUnpaid: (paymentId: string) => `/api/pos-plugin/unpaid/${encodeURIComponent(paymentId)}/charge`,
  /** «결제 취소할 일» 가져가기(REQUESTED → SENT). 응답으로 취소할 토스 주문·결제 ID(서버 DB 값)를 받는다 */
  cancelClaim: (id: string) => `/api/pos-plugin/charge-requests/${encodeURIComponent(id)}/cancel/claim`,
  /** 결제 취소 결과 참고 보고 { result: done|failed, message }. 환불은 서버가 토스 웹훅+재조회로만 한다 */
  cancelReport: (id: string) => `/api/pos-plugin/charge-requests/${encodeURIComponent(id)}/cancel/report`,
  dismissReport: (id: string) => `/api/pos-plugin/charge-requests/${encodeURIComponent(id)}/dismiss/report`,
} as const;

export type DismissJob = { id: string; shortCode: string };
export type DismissReport = { outcome: "DONE" | "FAILED" | "NEEDS_LOCAL_CANCEL"; reason?: string };

/** 사이트에서 «결제 취소»를 누른 요청 1건(롱폴링 응답 cancels[]) — 결제 ID 는 선점 응답에서만 온다 */
export type CancelJob = {
  id: string;
  shortCode: string;
  amount: number;
  /** 가린 이름 */
  studentName: string;
  title: string;
};

/** 선점한 «결제 취소할 일» — 취소할 토스 주문·결제 ID(분할이면 여러 건) */
export type CancelClaim = CancelJob & { tossOrderId: string; tossPaymentIds: string[] };

/** 취소 결과 보고 본문 */
export type CancelReportBody = { result: "done" | "failed"; message?: string };

/**
 * POS 주문 항목 1개(청구서 1건) — 묶음 요청(같은 학생 여러 건을 결제 한 번, 2026-11-08)은 여러 개, 단건은 1개.
 * 서버 계약: 요청의 items[] = { itemName, amount, taxFreeAmount, memo }. 합계 = 요청 amount, 면세 합계 = 요청 taxFreeAmount.
 */
export type ChargeItem = {
  /** 상품명, 예: 2026년 11월 수강료(홍*동) */
  title: string;
  amount: number;
  taxFreeAmount: number;
};

/** 현장 결제 요청 1건(서버가 준 값 그대로 — 이름은 서버가 마스킹해서 준다) */
export type ChargeRequest = {
  id: string;
  /** 사람이 읽는 번호, 예: S-4821 */
  shortCode: string;
  /** 마스킹된 이름, 예: 김○○ */
  studentName: string;
  /** 상품명, 예: 수강료(11월) */
  title: string;
  amount: number;
  taxFreeAmount: number;
  /** 만료 시각(ISO 문자열, 시간대 포함). 없으면 null */
  expiresAt: string | null;
  status: string;
  /**
   * POS 주문 항목들(서버 items[]). 없으면(옛 서버) 요청 하나 = 항목 하나로 본다 — order.ts itemsOf.
   * 칸이 하나라도 이상하면 NaN 이 들어가 validateForPos 가 결제창을 열지 않는다.
   */
  items?: ChargeItem[];
};

/** 미납 청구서 1건 */
export type UnpaidItem = {
  paymentId: string;
  studentName: string;
  className: string;
  title: string;
  amount: number;
};

/** 결과 보고 본문 */
export type ReportBody = {
  event: "paid" | "cancel" | "start_failed";
  tossOrderId?: string;
  tossPaymentId?: string;
  amount?: number;
  taxExemptAmount?: number;
  reason?: string;
};

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** {success, data} 같은 감싸개를 벗긴다. 감싸개가 없으면 그대로 */
export function unwrap(body: unknown): unknown {
  if (isObj(body) && "data" in body && (body.data === null || typeof body.data === "object")) {
    return body.data;
  }
  return body;
}

/** camelCase 이름과 snake_case 이름을 차례로 찾아 첫 값을 돌려준다 */
function pick(o: Obj, ...names: string[]): unknown {
  for (const n of names) {
    if (o[n] !== undefined && o[n] !== null) return o[n];
    const snake = n.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());
    if (o[snake] !== undefined && o[snake] !== null) return o[snake];
  }
  return undefined;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}

/** 숫자 또는 숫자 문자열만 받는다. 아니면 NaN(→ 이후 검증에서 걸러짐) */
function num(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return Number(v.trim());
  return Number.NaN;
}

/** 요청 1건 해석. 필수 칸(id·번호·금액)이 없으면 null(=무시) */
export function parseChargeRequest(raw: unknown): ChargeRequest | null {
  if (!isObj(raw)) return null;
  const id = str(pick(raw, "id", "requestId"));
  const shortCode = str(pick(raw, "shortCode", "code"));
  const amount = num(pick(raw, "amount"));
  if (!id || !shortCode || !Number.isFinite(amount)) return null;
  const taxFreeRaw = pick(raw, "taxFreeAmount");
  const out: ChargeRequest = {
    id,
    shortCode,
    studentName: str(pick(raw, "studentName", "studentLabel", "name")) || "(이름 없음)",
    title: str(pick(raw, "itemTitle", "itemName", "title", "label")),
    amount,
    // 면세 금액이 비어 오면 NaN 으로 두어 검증에서 막는다(과세로 잘못 결제되는 것 방지)
    taxFreeAmount: taxFreeRaw === undefined ? Number.NaN : num(taxFreeRaw),
    expiresAt: str(pick(raw, "expiresAt")) || null,
    status: str(pick(raw, "status")) || "PENDING",
  };
  // 묶음 항목(2026-11-08). 배열이 오면 그대로 읽고, 칸이 비면 NaN(→ 결제창을 열지 않음). 안 오면(옛 서버) 비워 둔다.
  const itemsRaw = pick(raw, "items", "lineItems");
  if (Array.isArray(itemsRaw) && itemsRaw.length > 0) {
    out.items = itemsRaw.map((it): ChargeItem => {
      if (!isObj(it)) return { title: "", amount: Number.NaN, taxFreeAmount: Number.NaN };
      const tf = pick(it, "taxFreeAmount");
      return {
        title: str(pick(it, "itemTitle", "itemName", "title")),
        amount: num(pick(it, "amount")),
        taxFreeAmount: tf === undefined ? Number.NaN : num(tf),
      };
    });
  }
  return out;
}

/** 목록 응답 해석: 배열 그 자체 또는 {requests: [...]} / {items: [...]} */
function listOf(body: unknown, ...keys: string[]): unknown[] {
  const b = unwrap(body);
  if (Array.isArray(b)) return b;
  if (isObj(b)) {
    for (const k of keys) {
      const v = b[k];
      if (Array.isArray(v)) return v;
    }
  }
  return [];
}

export function parseChargeRequestList(body: unknown): ChargeRequest[] {
  return listOf(body, "requests", "items", "chargeRequests", "charge_requests")
    .map(parseChargeRequest)
    .filter((r): r is ChargeRequest => r !== null);
}

/** 취소할 일 1건 해석. 필수 칸(id·번호)이 없으면 null(=무시) */
export function parseCancelJob(raw: unknown): CancelJob | null {
  if (!isObj(raw)) return null;
  const id = str(pick(raw, "id", "requestId"));
  const shortCode = str(pick(raw, "shortCode", "code"));
  if (!id || !shortCode) return null;
  const amount = num(pick(raw, "amount"));
  return {
    id,
    shortCode,
    amount: Number.isFinite(amount) ? amount : 0,
    studentName: str(pick(raw, "studentName", "studentLabel")) || "(이름 없음)",
    title: str(pick(raw, "itemName", "itemTitle", "title")),
  };
}

/**
 * 롱폴링 응답: 목록 + 서버가 실제로 기다려 준 초(waitSec) + 취소할 일(cancels).
 * waitSec 이 없으면 wait 를 모르는 옛 서버다. cancels 가 없으면(옛 서버) 빈 목록.
 */
export type WaitListResult = { requests: ChargeRequest[]; longPoll: boolean; cancels: CancelJob[]; dismissals: DismissJob[] };

export function parseWaitList(body: unknown): WaitListResult {
  const b = unwrap(body);
  const w = isObj(b) ? num(pick(b, "waitSec")) : NaN;
  const cancels = listOf(body, "cancels").map(parseCancelJob).filter((c): c is CancelJob => c !== null);
  const dismissals = listOf(body, "dismissals").flatMap((raw) => {
    if (!isObj(raw)) return [];
    const id = str(pick(raw, "id"));
    const shortCode = str(pick(raw, "shortCode"));
    return id && /^S-\d{4,6}$/.test(shortCode) ? [{ id, shortCode }] : [];
  });
  return { requests: parseChargeRequestList(body), longPoll: Number.isFinite(w) && w > 0, cancels, dismissals };
}

/** 취소 선점 응답 {cancel: {...}} 해석. 주문 ID·결제 ID 가 하나도 없으면 null(취소하지 않는다) */
export function parseStartAllowed(body: unknown): true | null {
  const raw = unwrap(body);
  return isObj(raw) && raw.allowed === true ? true : null;
}

export function parseCancelClaim(body: unknown): CancelClaim | null {
  const b = unwrap(body);
  const raw = isObj(b) && isObj(b.cancel) ? b.cancel : b;
  const job = parseCancelJob(raw);
  if (!job || !isObj(raw)) return null;
  const tossOrderId = str(pick(raw, "tossOrderId"));
  const idsRaw = pick(raw, "tossPaymentIds");
  const tossPaymentIds = Array.isArray(idsRaw) ? idsRaw.map(str).filter((x) => x.length > 0) : [];
  if (!tossOrderId || tossPaymentIds.length === 0) return null;
  return { ...job, tossOrderId, tossPaymentIds };
}

/** 취소 보고 응답 → 서버의 취소 상태(DONE 이면 사이트 환불까지 끝남) */
export function parseCancelReport(body: unknown): string {
  const b = unwrap(body);
  if (!isObj(b)) return "";
  if (b.refunded === true) return "DONE";
  return str(pick(b, "cancelState"));
}

/** 선점·미납결제 응답: {request: {...}} 또는 요청 객체 그 자체 */
export function parseClaimResponse(body: unknown): ChargeRequest | null {
  const b = unwrap(body);
  if (isObj(b) && isObj(b.request)) return parseChargeRequest(b.request);
  return parseChargeRequest(b);
}

export function parseUnpaidList(body: unknown): UnpaidItem[] {
  const out: UnpaidItem[] = [];
  for (const raw of listOf(body, "items", "payments", "unpaid")) {
    if (!isObj(raw)) continue;
    const paymentId = str(pick(raw, "paymentId", "id"));
    const amount = num(pick(raw, "amount"));
    if (!paymentId || !Number.isFinite(amount)) continue;
    out.push({
      paymentId,
      studentName: str(pick(raw, "studentName", "studentLabel", "name")) || "(이름 없음)",
      className: str(pick(raw, "className", "programName")),
      title: str(pick(raw, "itemTitle", "title", "label")),
      amount,
    });
  }
  return out;
}

/** 납부 상태 조회 응답 { status, paid } → paid 여부. 못 읽으면 null */
export function parsePaymentState(body: unknown): { status: string; paid: boolean } | null {
  const b = unwrap(body);
  if (!isObj(b)) return null;
  const status = str(pick(b, "status"));
  const paid = b.paid === true || status === "PAID";
  if (!status && b.paid === undefined) return null;
  return { status, paid };
}

/** 보고 응답에서 요청 상태만 읽는다(PAID 면 «사이트 납부완료» 안내) */
export function parseReportStatus(body: unknown): string {
  const b = unwrap(body);
  if (!isObj(b)) return "";
  // 서버 계약 8장: { ok, status, paid, duplicate } — paid 가 true 면 납부완료로 본다
  if (b.paid === true) return "PAID";
  if (isObj(b.request)) return str(pick(b.request, "status"));
  return str(pick(b, "status"));
}
