// 우리 서버 호출 — 토큰을 Authorization: Bearer 헤더로 붙이고, 결과를 «종류별»로 나눠 돌려준다.
// 토스 POS 의 http 모듈(ACL 등록 주소만 호출 가능)을 인자로 받는다. 토큰 원문은 절대 로그에 남기지 않는다.
import {
  API_PATHS,
  SERVER_ORIGIN,
  parseChargeRequestList,
  parseClaimResponse,
  parseReportStatus,
  parseUnpaidList,
} from "./contract.ts";
import type { ChargeRequest, ReportBody, UnpaidItem } from "./contract.ts";
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

export type ApiResult<T> = { ok: true; data: T } | { ok: false; kind: ApiErrorKind; code: number; message: string };

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
  no_token: "사이트 연결 토큰이 없어요. 설정에서 토큰을 넣어 주세요.",
  auth: "사이트 연결 토큰이 맞지 않아요. 원장님께 새 토큰을 받아 다시 넣어 주세요.",
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

function fail<T>(kind: ApiErrorKind, code = 0): ApiResult<T> {
  return { ok: false, kind, code, message: KIND_MESSAGE[kind] };
}

export function createServerApi(deps: ApiDeps) {
  const origin = deps.origin ?? SERVER_ORIGIN;
  const timeoutMs = deps.timeoutMs ?? 10_000;

  /** 공통 호출: 토큰 붙이기 → 호출 → 상태 분류 → JSON 해석 */
  async function call<T>(method: "GET" | "POST", path: string, payload: unknown, parse: (body: unknown) => T | null): Promise<ApiResult<T>> {
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
          ? await deps.http.get(origin + path, headers, { timeoutMs })
          : await deps.http.post(origin + path, payload ?? {}, headers, { timeoutMs });
    } catch (e) {
      if (deps.isRateLimitError?.(e)) return fail("rate");
      return fail("network");
    }
    const kind = classifyStatus(res.code);
    if (kind) return fail(kind, res.code);
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
    claim: (id: string): Promise<ApiResult<ChargeRequest>> => call("POST", API_PATHS.claim(id), {}, parseClaimResponse),
    report: (id: string, body: ReportBody): Promise<ApiResult<string>> =>
      call("POST", API_PATHS.report(id), body, parseReportStatus),
    searchUnpaid: (q: string): Promise<ApiResult<UnpaidItem[]>> =>
      call("GET", API_PATHS.unpaid(q), null, parseUnpaidList),
    chargeUnpaid: (paymentId: string): Promise<ApiResult<ChargeRequest>> =>
      call("POST", API_PATHS.chargeUnpaid(paymentId), {}, parseClaimResponse),
  };
}

export type ServerApi = ReturnType<typeof createServerApi>;
