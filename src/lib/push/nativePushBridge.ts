/**
 * 웹 ↔ 스토어 앱 알림 연결(e2·d2, 2026-11-14) — 브라우저 전용.
 *
 * 앱(안드로이드·아이폰)은 웹 화면에 «알림 창구» 하나를 열어 둔다.
 *   - 안드로이드: window.StizPushTransport (WebMessageListener — 우리 사이트 주소에만 열린다)
 *   - 아이폰:    window.webkit.messageHandlers.stizPush (답을 돌려주는 메시지 처리기)
 * 웹은 "state"(지금 상태) 또는 "request"(알림 권한 묻기)를 보내고, 앱은 JSON 한 줄로 답한다:
 *   {"v":1,"supported":true,"permission":"granted","token":"…","platform":"android"}
 * 안드로이드는 답이 한 곳(onmessage)으로 모이므로 요청에 번호를 붙여("state#7") 답의 "id":7 로 짝짓는다.
 * 아이폰은 요청마다 답이 따로 돌아와 번호가 필요 없다.
 *
 * 창구가 없으면 = 브라우저이거나 알림을 못 하는 옛 앱(1.0.1 이하). 그때는 아무것도 하지 않는다.
 * 토큰 등록은 웹뷰의 로그인 쿠키로 /api/push/native 에 보낸다(앱이 쿠키를 따로 다루지 않는다).
 */

import type { NativePushPlatform } from "@/lib/push/nativePushPolicy";

export type NativePushPermission = "granted" | "denied" | "default";

export type NativePushState = {
  /** 앱에 Firebase 설정이 들어 있어 알림을 받을 수 있나(설정 파일 없이 빌드한 앱은 false) */
  supported: boolean;
  permission: NativePushPermission;
  token: string | null;
  platform: NativePushPlatform;
};

/** 화면에 보일 상태 — 설정 화면·직원 안내가 같은 판정을 쓴다 */
export type NativePushView = "unavailable" | "default" | "denied" | "granted";

/** 앱 답(문자열 또는 객체) → 상태. 모양이 틀리면 null */
export function parseNativePushReply(raw: unknown): NativePushState | null {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.v !== 1) return null;
  if (v.platform !== "android" && v.platform !== "ios") return null;
  if (v.permission !== "granted" && v.permission !== "denied" && v.permission !== "default") return null;
  const token = typeof v.token === "string" && v.token.length >= 20 && v.token.length <= 4096 ? v.token : null;
  return { supported: v.supported === true, permission: v.permission, token, platform: v.platform };
}

/**
 * 상태 → 화면 판정.
 *   unavailable : 창구 없음(옛 앱)·Firebase 설정 없는 앱·서버 발송 키 없음(serverConfigured=false)
 *                 ·아이폰인데 허용했는데도 토큰이 없음(푸시 권한 서명 미연결) → «중요한 안내는 문자·카카오톡으로 보내드려요»
 *   denied      : 사용자가 알림을 거절 → «휴대폰 설정에서 알림을 켜 주세요»
 *   default     : 아직 안 물어봄 → «켜기» 버튼(누르면 휴대폰이 권한을 묻는다)
 *   granted     : 켜짐
 * serverConfigured: GET /api/push/native 의 configured(모르면 null — 로그인 전 등).
 */
export function nativePushView(state: NativePushState | null, serverConfigured: boolean | null = null): NativePushView {
  if (!state || !state.supported) return "unavailable";
  if (serverConfigured === false) return "unavailable";
  if (state.platform === "ios" && state.permission === "granted" && !state.token) return "unavailable";
  return state.permission;
}

/** 화면 판정별 안내 문구(한 곳) */
export const NATIVE_PUSH_NOTES: Record<Exclude<NativePushView, "granted" | "default">, string> = {
  unavailable: "중요한 안내는 문자·카카오톡으로 보내드려요",
  denied: "휴대폰 설정에서 알림을 켜 주세요",
};

type AndroidTransport = { postMessage: (message: string) => void; onmessage: ((event: { data: unknown }) => void) | null };
type IosHandler = { postMessage: (message: string) => Promise<unknown> };

function androidTransport(): AndroidTransport | null {
  try {
    const t = (window as unknown as { StizPushTransport?: AndroidTransport }).StizPushTransport;
    return t && typeof t.postMessage === "function" ? t : null;
  } catch {
    return null;
  }
}

function iosHandler(): IosHandler | null {
  try {
    const h = (window as unknown as { webkit?: { messageHandlers?: { stizPush?: IosHandler } } }).webkit?.messageHandlers?.stizPush;
    return h && typeof h.postMessage === "function" ? h : null;
  } catch {
    return null;
  }
}

/** 이 화면이 «알림 창구가 있는 앱» 안인가 */
export function hasNativePushBridge(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean(androidTransport() || iosHandler());
}

// 안드로이드 창구는 답이 «onmessage» 한 곳으로 온다 — 요청 번호로 답을 짝짓는다(시간 초과된 요청은 지운다)
const androidWaiting = new Map<number, (raw: unknown) => void>();
let androidNextId = 1;

/** 안드로이드 답에서 요청 번호를 꺼낸다(번호 없으면 null) */
export function replyIdOf(raw: unknown): number | null {
  try {
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    const id = (value as { id?: unknown } | null)?.id;
    return typeof id === "number" && Number.isInteger(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * 앱에게 묻는다. "request" 는 아직 안 물어봤을 때만 휴대폰 권한 창을 띄운다(이미 정해졌으면 상태만 답한다).
 * 답이 없으면(앱이 멈춤 등) timeoutMs 뒤 null.
 */
export function askNativePush(command: "state" | "request", timeoutMs = 15000): Promise<NativePushState | null> {
  const ios = iosHandler();
  const android = ios ? null : androidTransport();
  if (!ios && !android) return Promise.resolve(null);
  return new Promise((resolve) => {
    let done = false;
    const id = androidNextId++;
    const finish = (raw: unknown) => {
      if (done) return;
      done = true;
      androidWaiting.delete(id);
      resolve(parseNativePushReply(raw));
    };
    // 권한 창은 사용자가 고를 때까지 기다리므로 "request" 는 넉넉히 기다린다
    setTimeout(() => finish(null), command === "request" ? 120000 : timeoutMs);
    try {
      if (ios) {
        ios.postMessage(command).then(finish, () => finish(null));
        return;
      }
      if (android) {
        android.onmessage = (event) => {
          const replyId = replyIdOf(event.data);
          if (replyId !== null) androidWaiting.get(replyId)?.(event.data);
        };
        androidWaiting.set(id, finish);
        android.postMessage(`${command}#${id}`);
      }
    } catch {
      finish(null);
    }
  });
}

/** 같은 토큰을 짧은 시간에 여러 번 보내지 않게(화면 이동마다 부르므로) — 세션 저장소에 «보낸 토큰·시각» */
const SYNC_KEY = "stiz-native-push-sync";
const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;

export type NativePushSyncResult = "registered" | "skipped" | "logged-out" | "failed";

/**
 * 권한이 켜진 앱이면 토큰을 서버에 등록한다(로그인한 사람 기준 — 서버가 쿠키로 정한다).
 * «방금 보냄» 기록은 «토큰 + 로그인한 사람 id» 짝으로 남긴다 — 다른 계정으로 바꿔 로그인하면 짝이 달라져
 * 바로 다시 보내고, 서버가 토큰 주인을 새 계정으로 옮긴다(2026-11-14 검수 MED1).
 * 401(로그인 안 됨)이면 기록을 지워, 로그인한 뒤 다음 화면에서 바로 다시 등록되게 한다.
 */
export async function syncNativePushToken(
  state: NativePushState | null,
  options: { force?: boolean; userId?: string | null } = {},
): Promise<NativePushSyncResult> {
  if (!state || !state.supported || state.permission !== "granted" || !state.token) return "skipped";
  const user = options.userId ?? "";
  try {
    if (!options.force && user) {
      const saved = JSON.parse(window.sessionStorage.getItem(SYNC_KEY) ?? "null") as { token?: string; user?: string; at?: number } | null;
      if (isFreshSync(saved, state.token, user, Date.now())) return "skipped";
    }
  } catch {
    // 저장소를 못 쓰면 그냥 보낸다
  }
  try {
    const res = await fetch("/api/push/native", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: state.platform, token: state.token }),
    });
    if (res.status === 401 || res.status === 404) {
      clearNativePushSync();
      return "logged-out";
    }
    if (!res.ok) return "failed";
    try {
      window.sessionStorage.setItem(SYNC_KEY, JSON.stringify({ token: state.token, user, at: Date.now() }));
    } catch {
      // 다음 화면에서 한 번 더 보낼 뿐
    }
    return "registered";
  } catch {
    return "failed";
  }
}

/** 같은 토큰·같은 사람에게 6시간 안에 보낸 적이 있나(순수 — 테스트용으로 따로 둔다) */
export function isFreshSync(
  saved: { token?: string; user?: string; at?: number } | null,
  token: string,
  user: string,
  nowMs: number,
): boolean {
  return Boolean(user) && saved?.token === token && saved?.user === user
    && typeof saved?.at === "number" && nowMs - saved.at < SYNC_INTERVAL_MS;
}

/**
 * 서버에 앱 알림 발송 키가 있나(GET /api/push/native 의 configured). 로그인 전·오류면 null(모름).
 * 한 화면 묶음 안에서는 한 번만 묻는다.
 */
let serverConfiguredCache: boolean | null = null;
export async function fetchServerPushConfigured(): Promise<boolean | null> {
  if (serverConfiguredCache !== null) return serverConfiguredCache;
  try {
    const res = await fetch("/api/push/native", { method: "GET" });
    if (!res.ok) return null;
    const body = (await res.json()) as { configured?: unknown };
    serverConfiguredCache = body.configured === true;
    return serverConfiguredCache;
  } catch {
    return null;
  }
}

/** 로그인 화면(/login·/staff/login)인가 — 들어오면 «방금 보냄» 기록을 지워 다음 로그인에서 바로 다시 등록되게 */
export function isLoginPath(pathname: string | null | undefined): boolean {
  const p = String(pathname ?? "");
  return p === "/login" || p.startsWith("/login/") || p === "/staff/login" || p.startsWith("/staff/login/");
}

export function clearNativePushSync() {
  try {
    window.sessionStorage.removeItem(SYNC_KEY);
  } catch {
    // 무시
  }
}

/** 로그인 뒤 첫 화면에서 한 번만 자동으로 권한을 묻는다(기기에 기억) — 거절한 사람을 계속 조르지 않게 */
export const NATIVE_PUSH_ASKED_KEY = "stiz-native-push-asked";

/** 같은 화면의 다른 부품(설정 화면 등)에 «상태가 바뀌었다»를 알리는 신호 */
export const NATIVE_PUSH_CHANGED_EVENT = "stiz-native-push-changed";
