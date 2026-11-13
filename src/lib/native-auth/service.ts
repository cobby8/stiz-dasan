import { CODE_TTL_MS, FLOW_TTL_MS, NativeAuthError, digest, equalToken, opaqueToken, openSession, parseStart, sealSession, validFlow, validToken, validVerifier, type NativeConfig, type NativePlatform, type NativeProvider } from "./policy";

export type NativeFlow = {
  id: string; platform: NativePlatform; provider: NativeProvider; challenge: string; state: string;
  expiresAt: Date; status: "CREATED" | "BROWSER" | "READY" | "CONSUMED" | "CANCELLED";
  browserHash: string | null; codeHash: string | null; codeExpiresAt: Date | null; sealedSession: string | null;
};
/**
 * 브라우저 로그인이 실패했을 때 앱에 알려 줄 이유(토큰·개인정보 없음).
 * - no_account: 간편로그인은 됐지만 학원 계정과 연결돼 있지 않음(처음 쓰는 학부모 등)
 * - cancelled : 카카오·구글 화면에서 사용자가 취소함
 * - failed    : 그 밖의 실패
 */
export type NativeBrowserFailure = "no_account" | "cancelled" | "failed";
export const NATIVE_BROWSER_FAILURES: readonly NativeBrowserFailure[] = ["no_account", "cancelled", "failed"];
export type NativeSession = { access_token: string; refresh_token: string; authUserId: string };
export interface NativeFlowStore {
  purgeExpired?(now: Date): Promise<void>;
  create(row: NativeFlow): Promise<void>;
  read(id: string): Promise<NativeFlow | null>;
  bindBrowser(id: string, browserHash: string, now: Date): Promise<boolean>;
  ready(id: string, browserHash: string, codeHash: string, codeExpiresAt: Date, sealedSession: string, now: Date): Promise<boolean>;
  consume(id: string, challenge: string, state: string, codeHash: string, now: Date): Promise<NativeFlow | null>;
  cancel(id: string, challenge: string, state: string, now: Date): Promise<boolean>;
}

export function createNativeAuthService(store: NativeFlowStore, config: NativeConfig, now = () => new Date()) {
  function live(row: NativeFlow | null): NativeFlow {
    if (!row || row.expiresAt.getTime() <= now().getTime()) throw new NativeAuthError(); return row;
  }
  function proof(input: Record<string, unknown>) {
    if (!validFlow(input.flowId) || !validVerifier(input.codeVerifier) || !validToken(input.state)) throw new NativeAuthError();
    return { id: input.flowId, challenge: digest(input.codeVerifier), state: input.state };
  }
  return {
    async start(input: Record<string, unknown>) {
      const parsed = parseStart(input); const id = opaqueToken(); const expiresAt = new Date(now().getTime() + FLOW_TTL_MS);
      await store.purgeExpired?.(now());
      await store.create({ id, ...parsed, expiresAt, status: "CREATED", browserHash: null, codeHash: null, codeExpiresAt: null, sealedSession: null });
      return { flowId: id, browserUrl: `${config.origin}/auth/native/browser?flow=${id}`, expiresAt: expiresAt.toISOString() };
    },
    async beginBrowser(id: unknown) {
      if (!validFlow(id)) throw new NativeAuthError(); const row = live(await store.read(id));
      const binding = opaqueToken();
      if (row.status !== "CREATED" || !await store.bindBrowser(id, digest(binding), now())) throw new NativeAuthError();
      return { row, binding };
    },
    async browserFlow(id: unknown, binding: unknown) {
      if (!validFlow(id) || !validFlow(binding)) throw new NativeAuthError(); const row = live(await store.read(id));
      if (row.status !== "BROWSER" || !row.browserHash || !equalToken(row.browserHash, digest(binding))) throw new NativeAuthError();
      return row;
    },
    async finishBrowser(row: NativeFlow, binding: string, session: NativeSession) {
      if (!session.authUserId || !session.access_token || !session.refresh_token) throw new NativeAuthError();
      const code = opaqueToken(); const codeExpiresAt = new Date(Math.min(row.expiresAt.getTime(), now().getTime() + CODE_TTL_MS));
      if (!await store.ready(row.id, digest(binding), digest(code), codeExpiresAt, sealSession(session, row.id, config.encryptionKey), now())) throw new NativeAuthError();
      const callback = new URL(config.callback(row.platform));
      callback.searchParams.set("flow", row.id); callback.searchParams.set("code", code); callback.searchParams.set("state", row.state);
      return callback.toString();
    },
    /**
     * 이 브라우저가 묶인 요청이 실패하면 JSON 오류 화면에 머무르지 않고 앱으로 돌려보낸다.
     * 복귀 주소에는 flow·state·이유만 싣는다(code 없음 → 로그인 불가). 요청은 바로 취소해 다시 쓰지 못하게 한다.
     */
    async failBrowser(row: NativeFlow, reason: NativeBrowserFailure) {
      await store.cancel(row.id, row.challenge, row.state, now());
      const callback = new URL(config.callback(row.platform));
      callback.searchParams.set("flow", row.id); callback.searchParams.set("state", row.state);
      callback.searchParams.set("error", NATIVE_BROWSER_FAILURES.includes(reason) ? reason : "failed");
      return callback.toString();
    },
    async consume(input: Record<string, unknown>): Promise<NativeSession> {
      const p = proof(input); if (!validFlow(input.code)) throw new NativeAuthError();
      // 단일 UPDATE RETURNING으로 조회·소비를 묶어 동시에 요청해도 한 번만 전달한다.
      const row = await store.consume(p.id, p.challenge, p.state, digest(input.code), now());
      if (!row?.sealedSession) throw new NativeAuthError();
      const value = openSession(row.sealedSession, row.id, config.encryptionKey);
      if (!value || typeof value !== "object") throw new NativeAuthError();
      const session = value as NativeSession;
      if (typeof session.authUserId !== "string" || typeof session.access_token !== "string" || typeof session.refresh_token !== "string") throw new NativeAuthError();
      return session;
    },
    async cancel(input: Record<string, unknown>) {
      const p = proof(input); if (!await store.cancel(p.id, p.challenge, p.state, now())) throw new NativeAuthError();
    },
  };
}
