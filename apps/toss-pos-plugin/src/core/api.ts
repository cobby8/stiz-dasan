// 우리 서버 호출 — 토큰을 Authorization: Bearer 헤더로 붙이고, 결과를 «종류별»로 나눠 돌려준다.
// 토스 POS 의 http 모듈(ACL 등록 주소만 호출 가능)을 인자로 받는다. 토큰 원문은 절대 로그에 남기지 않는다.
import {
  API_PATHS,
  SERVER_ORIGIN,
  parseCancelClaim,
  parseCancelReport,
  parseChargeRequestList,
  parseClaimResponse,
  parseReportStatus,
  parseStartAllowed,
  parseUnpaidList,
  parseWaitList,
} from "./contract.ts";
import type { CancelClaim, CancelReportBody, ChargeRequest, DismissReport, ReportBody, UnpaidItem, WaitListResult } from "./contract.ts";
import type { HttpLike, HttpResponseLike } from "./pos-types.ts";

/** 실패 종류 — 화면 안내와 백오프가 이 값으로 갈린다 */
export type ApiErrorKind =
  | "no_token" // 토큰을 아직 안 넣음
  | "auth" // 401/403: 토큰이 틀렸거나 폐기됨
  | "conflict" // 409/410: 이미 다른 기기가 가져갔거나 만료
  | "not_found" // 404
  | "rate" // POS 요청 제한(PosPluginSdkRateLimitError) 또는 서버 429
  | "network" // 인터넷 끊김·시간 초과
  | "server" // 5xx
  | "bad_response"; // 응답을 읽을 수 없음

/** 실패 결과: kind = 화면·백오프 분기용 종류, error = 서버가 준 오류 코드(예: NOT_ELIGIBLE), message = 화면 안내 */
export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; kind: ApiErrorKind; code: number; message: string; error?: string; retryAfterSeconds?: number };

export type ApiDeps = {
  http: HttpLike;
  /** 토큰 읽기(메모리 캐시). 없으면 undefined */
  getToken: () => Promise<string | undefined>;
  /** SDK 의 요청 제한 오류인지 판별(PosPluginSdkRateLimitError.isPosPluginSdkRateLimitError) */
  isRateLimitError?: (e: unknown) => boolean;
  origin?: string;
  timeoutMs?: number;
};

const KIND_MESSAGE: Record<ApiErrorKind, string> = {
  no_token: "POS 연결 코드가 없어요. [연결 코드]에서 넣어 주세요.",
  auth: "POS 연결 코드가 맞지 않거나 끊겼어요. 원장님께 새 연결 코드를 받아 다시 넣어 주세요.",
  conflict: "이미 다른 곳에서 결제 중이거나 만료된 요청이에요.",
  not_found: "요청을 찾을 수 없어요. 사이트에서 취소됐을 수 있어요.",
  rate: "요청이 너무 많아 잠시 쉬고 있어요. 1~2분 뒤 다시 시도해 주세요.",
  network: "인터넷 연결이 불안정해요. 잠시 뒤 다시 시도해 주세요.",
  server: "사이트 서버에 문제가 있어요. 잠시 뒤 다시 시도해 주세요.",
  bad_response: "사이트 응답을 읽지 못했어요. 플러그인 업데이트가 필요할 수 있어요.",
};

export function kindMessage(kind: ApiErrorKind): string {
  return KIND_MESSAGE[kind];
}

/** HTTP 상태 코드 → 실패 종류 */
export function classifyStatus(code: number): ApiErrorKind | null {
  if (code >= 200 && code < 300) return null;
  if (code === 401 || code === 403) return "auth";
  if (code === 409 || code === 410) return "conflict";
  if (code === 404) return "not_found";
  if (code === 429) return "rate";
  if (code >= 500) return "server";
  if (code === 0) return "network";
  return "bad_response";
}

/**
 * 서버 오류 코드 → 화면 안내(서버 계약 docs/toss-pos-plugin-plan.md 8장).
 * 여기 없는 코드는 서버가 준 message 를, 그것도 없으면 종류별 기본 안내를 쓴다.
 */
export const ERROR_CODE_MESSAGE: Record<string, string> = {
  UNAUTHORIZED: KIND_MESSAGE.auth,
  RATE_LIMITED: KIND_MESSAGE.rate,
  NOT_CLAIMABLE: "다른 POS 가 이미 가져갔거나 만료·취소된 요청이에요. 사이트에서 확인해 주세요.",
  NOT_ELIGIBLE: "미납 청구서가 아니에요. 이미 납부됐거나 현장 결제 대상이 아니에요.",
  CHANGED: "청구 금액이 바뀌었어요. 사이트에서 청구서를 확인한 뒤 다시 요청해 주세요.",
  NOT_FOUND: KIND_MESSAGE.not_found,
  CODE_EXHAUSTED: "요청 번호가 모자라요. 잠시 뒤 다시 시도하거나 원장님께 알려 주세요.",
  BAD_REQUEST: "요청 형식이 맞지 않아요. 플러그인 업데이트가 필요할 수 있어요.",
  SERVER_ERROR: KIND_MESSAGE.server,
};

/** 실패 응답 본문 {ok:false, error, message, retryAfterSeconds} 에서 안내를 만든다 */
export function failureFromBody(kind: ApiErrorKind, code: number, rawBody: string | undefined) {
  let error: string | undefined;
  let serverMessage: string | undefined;
  let retryAfterSeconds: number | undefined;
  try {
    const b = rawBody ? JSON.parse(rawBody) : null;
    if (b && typeof b === "object") {
      if (typeof b.error === "string") error = b.error;
      if (typeof b.message === "string" && b.message.trim()) serverMessage = b.message.trim().slice(0, 120);
      const ra = b.retryAfterSeconds ?? b.retry_after_seconds;
      if (typeof ra === "number" && ra > 0) retryAfterSeconds = ra;
    }
  } catch {
    /* 본문이 JSON 이 아니면 종류별 기본 안내 */
  }
  const message = (error && ERROR_CODE_MESSAGE[error]) || serverMessage || KIND_MESSAGE[kind];
  return { ok: false as const, kind, code, message, error, retryAfterSeconds };
}

function fail<T>(kind: ApiErrorKind, code = 0): ApiResult<T> {
  return { ok: false, kind, code, message: KIND_MESSAGE[kind] };
}

export function createServerApi(deps: ApiDeps) {
  const origin = deps.origin ?? SERVER_ORIGIN;
  const timeoutMs = deps.timeoutMs ?? 10_000;

  /** 공통 호출: 토큰 붙이기 → 호출 → 상태 분류 → JSON 해석 */
  async function call<T>(
    method: "GET" | "POST",
    path: string,
    payload: unknown,
    parse: (body: unknown) => T | null,
    callTimeoutMs = timeoutMs,
  ): Promise<ApiResult<T>> {
    const token = await deps.getToken();
    if (!token) return fail("no_token");
    const headers: [string, string][] = [
      ["Authorization", `Bearer ${token}`],
      ["Content-Type", "application/json"],
      ["Accept", "application/json"],
    ];
    let res: HttpResponseLike;
    try {
      res =
        method === "GET"
          ? await deps.http.get(origin + path, headers, { timeoutMs: callTimeoutMs })
          : await deps.http.post(origin + path, payload ?? {}, headers, { timeoutMs: callTimeoutMs });
    } catch (e) {
      if (deps.isRateLimitError?.(e)) return fail("rate");
      return fail("network");
    }
    const kind = classifyStatus(res.code);
    // 실패면 서버가 준 오류 코드·문구를 버리지 않고 안내에 반영한다
    if (kind) return failureFromBody(kind, res.code, res.body);
    let body: unknown;
    try {
      body = res.body ? JSON.parse(res.body) : {};
    } catch {
      return fail("bad_response", res.code);
    }
    const data = parse(body);
    if (data === null) return fail("bad_response", res.code);
    return { ok: true, data };
  }

  return {
    listRequests: (): Promise<ApiResult<ChargeRequest[]>> =>
      call("GET", API_PATHS.chargeRequests, null, parseChargeRequestList),
    /**
     * 롱폴링 목록(워커 전용). 서버가 최대 waitSec 초 붙잡고 있다가 답하므로 시간 제한을 «대기 + 5초»로 늘린다
     * (20초 대기 → 25초). 근거: SDK http.get(url, headers, { timeoutMs }) — docs.tossplace.com/reference/plugin-sdk/pos/http.html
     */
    waitRequests: (opts: { waitSec: number; known?: string[] }): Promise<ApiResult<WaitListResult>> =>
      call("GET", API_PATHS.chargeRequestsWait(opts.waitSec, opts.known), null, parseWaitList, longPollTimeoutMs(opts.waitSec)),
    claim: (id: string): Promise<ApiResult<ChargeRequest>> => call("POST", API_PATHS.claim(id), {}, parseClaimResponse),
    startCheck: (id: string): Promise<ApiResult<true>> => call("POST", API_PATHS.startCheck(id), {}, parseStartAllowed),
    report: (id: string, body: ReportBody): Promise<ApiResult<string>> =>
      call("POST", API_PATHS.report(id), body, parseReportStatus),
    searchUnpaid: (q: string): Promise<ApiResult<UnpaidItem[]>> =>
      call("GET", API_PATHS.unpaid(q), null, parseUnpaidList),
    chargeUnpaid: (paymentId: string): Promise<ApiResult<ChargeRequest>> =>
      call("POST", API_PATHS.chargeUnpaid(paymentId), {}, parseClaimResponse),
    /** «결제 취소할 일» 가져가기 — 취소할 주문·결제 ID 는 서버 값만 쓴다 */
    cancelClaim: (id: string): Promise<ApiResult<CancelClaim>> => call("POST", API_PATHS.cancelClaim(id), {}, parseCancelClaim),
    /** 취소 결과 참고 보고(환불 확정은 서버가 토스 웹훅으로) */
    cancelReport: (id: string, body: CancelReportBody): Promise<ApiResult<string>> =>
      call("POST", API_PATHS.cancelReport(id), body, parseCancelReport),
    dismissReport: (id: string, body: DismissReport): Promise<ApiResult<boolean>> =>
      call("POST", API_PATHS.dismissReport(id), body, () => true),
  };
}

/** 롱폴링 한 번의 시간 제한: 서버 대기 + 여유 5초(20초 → 25초) */
export function longPollTimeoutMs(waitSec: number): number {
  return Math.max(0, Math.floor(waitSec)) * 1000 + 5_000;
}

export type ServerApi = ReturnType<typeof createServerApi>;
