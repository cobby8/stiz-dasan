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
  /** 요청 선점(PENDING → SENT). 응답으로 금액·면세·메모 문구를 받는다 */
  claim: (id: string) => `/api/pos-plugin/charge-requests/${encodeURIComponent(id)}/claim`,
  /** «결제 시도됨» 참고 보고. 납부 처리는 서버가 웹훅+재조회로만 한다 */
  report: (id: string) => `/api/pos-plugin/charge-requests/${encodeURIComponent(id)}/report`,
  /** 미납 청구서 검색(이름 일부) */
  unpaid: (q: string) => `/api/pos-plugin/unpaid?q=${encodeURIComponent(q)}`,
  /**
   * 미납 청구서를 골라 «요청 생성 + 선점»을 한 번에. 설계안에 경로 이름이 없어 이 이름을 제안한다
   * (보고서 «계약 변경 제안» 참고).
   */
  chargeUnpaid: (paymentId: string) => `/api/pos-plugin/unpaid/${encodeURIComponent(paymentId)}/charge`,
} as const;

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
  return {
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

/** 보고 응답에서 요청 상태만 읽는다(PAID 면 «사이트 납부완료» 안내) */
export function parseReportStatus(body: unknown): string {
  const b = unwrap(body);
  if (!isObj(b)) return "";
  // 서버 계약 8장: { ok, status, paid, duplicate } — paid 가 true 면 납부완료로 본다
  if (b.paid === true) return "PAID";
  if (isObj(b.request)) return str(pick(b.request, "status"));
  return str(pick(b, "status"));
}
