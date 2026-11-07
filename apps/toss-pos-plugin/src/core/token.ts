// 매장 토큰 보관 — 사람이 POS 에서 입력한 값을 secureStore(기기 암호화 저장소)에 둔다.
// 근거: https://docs.tossplace.com/reference/plugin-sdk/pos/secureStore.html
//       https://docs.tossplace.com/reference/plugin-sdk/pos/setting.html
// 입력 경로 두 가지:
//   ① 탭 화면의 «연결 코드» 칸 → 바로 secureStore 에 저장(권장)
//   ② POS 설정 → 외부 서비스 설정의 «POS 연결 코드» 칸(setting) → 워커가 읽어 secureStore 로 옮긴다
// 토큰은 코드·zip·README 어디에도 넣지 않는다.

export const TOKEN_KEY = "stiz_site_token";
export const SETTING_TOKEN_ID = "stiz_site_token";

export type SecureStoreLike = {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  del(key: string): Promise<void>;
};

/** 토큰 모양 검사: 공백 제거 후 20~200자, 영문·숫자·-_. 만(서버는 32바이트 랜덤을 base64url/hex 로 준다) */
export function normalizeToken(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (t.length < 20 || t.length > 200) return null;
  if (!/^[A-Za-z0-9._~-]+$/.test(t)) return null;
  return t;
}

/** 화면 표시용: 끝 4자리만 «••••abcd» */
export function maskToken(t: string | undefined): string {
  if (!t) return "없음";
  return `••••${t.slice(-4)}`;
}

/**
 * 메모리 캐시를 둔 토큰 보관함. 매 폴링마다 secureStore 를 읽으면 그것도 POS 요청 제한에 잡히므로
 * 처음 한 번만 읽고, 바뀔 때(set/clear/reload)만 다시 읽는다.
 */
export function createTokenStore(secure: SecureStoreLike) {
  let cache: string | undefined;
  let loaded = false;
  return {
    async get(): Promise<string | undefined> {
      if (!loaded) {
        cache = normalizeToken(await secure.get(TOKEN_KEY)) ?? undefined;
        loaded = true;
      }
      return cache;
    },
    /** 새 토큰 저장. 모양이 틀리면 false */
    async set(raw: string): Promise<boolean> {
      const t = normalizeToken(raw);
      if (!t) return false;
      await secure.set(TOKEN_KEY, t);
      cache = t;
      loaded = true;
      return true;
    },
    async clear(): Promise<void> {
      await secure.del(TOKEN_KEY);
      cache = undefined;
      loaded = true;
    },
    /** 다른 화면(탭)이 바꿨을 수 있을 때 다시 읽기 */
    reload(): void {
      loaded = false;
    },
  };
}

export type TokenStore = ReturnType<typeof createTokenStore>;
