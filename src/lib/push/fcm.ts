import { createSign } from "node:crypto";
import { safeNativePushPath, type NativePushPlatform } from "@/lib/push/nativePushPolicy";

/**
 * FCM(Firebase Cloud Messaging) HTTP v1 발송 — 스토어 앱(안드로이드·아이폰) 알림(e2, 2026-11-14).
 *
 * 왜 FCM 하나인가: 안드로이드는 FCM 이 직접, 아이폰은 FCM 이 애플 알림 서버(APNs)로 중계한다.
 * 서버는 «토큰 + 메시지»만 FCM 에 보내면 되고, 애플 인증 키(.p8)는 Firebase 콘솔에만 올린다.
 *
 * 설정: Vercel 환경변수 FCM_SERVICE_ACCOUNT_JSON = Firebase 서비스 계정 JSON(원문 또는 base64).
 *   없거나 깨져 있으면 앱 발송은 «조용히 건너뜀»(NOT_CONFIGURED) — 웹푸시·문자는 그대로 나간다.
 *
 * 외부 라이브러리(firebase-admin) 없이 node:crypto 로 서명한다 — 서버 함수 크기·의존성을 늘리지 않으려고.
 */

export const FCM_ENV_NAME = "FCM_SERVICE_ACCOUNT_JSON";

export type FcmServiceAccount = { projectId: string; clientEmail: string; privateKey: string };

export type FcmPayload = { title: string; body: string; url?: string; tag?: string };

/** 한 토큰에 보낸 결과 — invalid-token 이면 그 토큰은 지운다(앱 삭제·재설치로 죽은 토큰) */
export type FcmSendOutcome =
  | { kind: "sent" }
  | { kind: "invalid-token"; code: string }
  | { kind: "failed"; code: string };

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}>;

/** FCM·구글 인증 요청 하나를 기다리는 최대 시간 — 넘으면 그 기기만 실패로(서버 함수 전체가 멈추지 않게) */
export const FCM_REQUEST_TIMEOUT_MS = 10_000;

/** 문자열을 UTF-8 바이트 수 기준으로 자른다(한글이 반쪽으로 깨지지 않게 글자 단위로 멈춘다) */
export function truncateUtf8(text: string, maxBytes: number): string {
  let bytes = 0;
  let out = "";
  for (const ch of text) {
    const size = Buffer.byteLength(ch, "utf8");
    if (bytes + size > maxBytes) break;
    bytes += size;
    out += ch;
  }
  return out;
}

/** 환경변수 값(JSON 원문 또는 base64)을 서비스 계정으로. 필요한 칸이 하나라도 없으면 null */
export function parseServiceAccount(raw: string | null | undefined): FcmServiceAccount | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  let json: unknown;
  try {
    json = JSON.parse(text.startsWith("{") ? text : Buffer.from(text, "base64").toString("utf8"));
  } catch {
    return null;
  }
  if (!json || typeof json !== "object") return null;
  const v = json as { project_id?: unknown; client_email?: unknown; private_key?: unknown };
  if (typeof v.project_id !== "string" || typeof v.client_email !== "string" || typeof v.private_key !== "string") return null;
  if (!v.project_id || !v.client_email || !v.private_key.includes("PRIVATE KEY")) return null;
  // Vercel 에 한 줄로 넣으면 줄바꿈이 «\n» 글자로 남는 경우가 있다 — 진짜 줄바꿈으로 되돌린다
  return { projectId: v.project_id, clientEmail: v.client_email, privateKey: v.private_key.replace(/\\n/g, "\n") };
}

/** 지금 환경에서 앱 발송이 켜져 있나(서비스 계정이 올바르게 들어 있나) */
export function fcmServiceAccount(): FcmServiceAccount | null {
  return parseServiceAccount(process.env[FCM_ENV_NAME]);
}

/**
 * 플랫폼별 FCM 메시지.
 * - 안드로이드: «데이터만» 보낸다 → 앱(StizMessagingService)이 직접 알림을 그려, 누르면 그 주소를 앱 안에서 연다.
 * - 아이폰: APNs 알림(제목·본문·소리)을 붙인다 → 아이폰이 직접 띄우고, 누르면 앱이 data.url 을 연다.
 * url 은 우리 사이트 «경로»로만 보낸다(safeNativePushPath). 앱이 한 번 더 주소 정책으로 거른다.
 */
export function buildFcmMessage(platform: NativePushPlatform, token: string, payload: FcmPayload) {
  const data: Record<string, string> = {
    // FCM 메시지는 전체 4KB 제한 — 제목 200바이트·본문 2,000바이트(한글 약 660자)로 자른다
    title: truncateUtf8(payload.title, 200),
    body: truncateUtf8(payload.body, 2000),
    url: safeNativePushPath(payload.url),
    tag: String(payload.tag ?? "").slice(0, 64),
  };
  if (platform === "android") {
    return { message: { token, data, android: { priority: "HIGH", ttl: "86400s" } } };
  }
  return {
    message: {
      token,
      data: { url: data.url, tag: data.tag },
      apns: {
        headers: { "apns-priority": "10", "apns-push-type": "alert" },
        payload: { aps: { alert: { title: data.title, body: data.body }, sound: "default" } },
      },
    },
  };
}

/**
 * FCM 오류 응답 → 이 토큰을 지울지(invalid-token), 아니면 실패로 남길지(failed).
 * 지우는 경우: UNREGISTERED(앱 삭제·토큰 만료) · 400 INVALID_ARGUMENT 중 «registration token» 이 문제라고 한 것.
 * 지우지 않는 경우: SENDER_ID_MISMATCH(서버 키가 다른 Firebase 프로젝트 것 — 설정 실수라 토큰을 지우면 고친 뒤에도 못 보낸다)
 *            · 본문 없는 404 · 429·5xx·인증 오류(토큰 잘못이 아니다).
 */
export function classifyFcmError(status: number, bodyText: string): FcmSendOutcome {
  let errorCode = "";
  let message = "";
  try {
    const parsed = JSON.parse(bodyText) as { error?: { status?: string; message?: string; details?: Array<{ errorCode?: string }> } };
    message = String(parsed.error?.message ?? "");
    errorCode = parsed.error?.details?.find((d) => d?.errorCode)?.errorCode ?? parsed.error?.status ?? "";
  } catch {
    // 본문이 JSON 이 아니면 상태 코드로만 판단
  }
  if (errorCode === "UNREGISTERED") return { kind: "invalid-token", code: errorCode };
  if (status === 400 && errorCode === "INVALID_ARGUMENT" && /registration token/i.test(message)) {
    return { kind: "invalid-token", code: "INVALID_TOKEN" };
  }
  return { kind: "failed", code: `FCM_${errorCode || status}` };
}

function base64url(input: string | Buffer) {
  return Buffer.from(input).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/** 구글 OAuth 접근 토큰(1시간) — 함수 인스턴스 안에서 만료 1분 전까지 다시 쓴다 */
let cachedAccess: { email: string; token: string; expiresAt: number } | null = null;
/** 발급 중인 요청 하나를 같이 기다린다 — 전체 공지처럼 동시에 수백 건이 나가도 인증 요청은 한 번만 */
let inflightAccess: { email: string; promise: Promise<string> } | null = null;

export function resetFcmAccessTokenCache() {
  cachedAccess = null;
  inflightAccess = null;
}

async function accessToken(account: FcmServiceAccount, fetchImpl: FetchLike, nowMs: number): Promise<string> {
  if (cachedAccess && cachedAccess.email === account.clientEmail && cachedAccess.expiresAt - 60_000 > nowMs) {
    return cachedAccess.token;
  }
  if (inflightAccess && inflightAccess.email === account.clientEmail) return inflightAccess.promise;
  const promise = fetchAccessToken(account, fetchImpl, nowMs);
  inflightAccess = { email: account.clientEmail, promise };
  try {
    return await promise;
  } finally {
    if (inflightAccess?.promise === promise) inflightAccess = null;
  }
}

async function fetchAccessToken(account: FcmServiceAccount, fetchImpl: FetchLike, nowMs: number): Promise<string> {
  const iat = Math.floor(nowMs / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(JSON.stringify({
    iss: account.clientEmail,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat,
    exp: iat + 3600,
  }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  const assertion = `${header}.${claims}.${base64url(signer.sign(account.privateKey))}`;
  const res = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${encodeURIComponent(assertion)}`,
    signal: AbortSignal.timeout(FCM_REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`FCM_AUTH_${res.status}`);
  const parsed = JSON.parse(text) as { access_token?: string; expires_in?: number };
  if (!parsed.access_token) throw new Error("FCM_AUTH_NO_TOKEN");
  cachedAccess = { email: account.clientEmail, token: parsed.access_token, expiresAt: nowMs + (parsed.expires_in ?? 3600) * 1000 };
  return parsed.access_token;
}

/**
 * 토큰 하나에 보낸다. 설정이 없으면 호출하는 쪽(pushNotification.ts)이 미리 건너뛴다.
 * 네트워크·인증 오류는 throw 하지 않고 failed 로 돌려준다(다른 토큰 발송을 막지 않게).
 */
export async function sendFcm(
  account: FcmServiceAccount,
  platform: NativePushPlatform,
  token: string,
  payload: FcmPayload,
  deps: { fetch?: FetchLike; now?: () => number } = {},
): Promise<FcmSendOutcome> {
  const fetchImpl = deps.fetch ?? (globalThis.fetch as unknown as FetchLike);
  try {
    const bearer = await accessToken(account, fetchImpl, (deps.now ?? Date.now)());
    const res = await fetchImpl(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.projectId)}/messages:send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify(buildFcmMessage(platform, token, payload)),
      signal: AbortSignal.timeout(FCM_REQUEST_TIMEOUT_MS),
    });
    if (res.ok) return { kind: "sent" };
    const outcome = classifyFcmError(res.status, await res.text());
    // 인증이 거절되면 저장해 둔 접근 토큰을 버린다(다음 발송에서 새로 받는다)
    if (res.status === 401) cachedAccess = null;
    return outcome;
  } catch (error) {
    return { kind: "failed", code: error instanceof Error ? error.message.slice(0, 60) : "FCM_FAILED" };
  }
}
