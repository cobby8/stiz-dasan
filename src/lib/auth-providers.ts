import { enabledParentOAuthProviders, type ParentOAuthProvider } from "@/lib/parent-oauth";

// 서버 전용 — Supabase 에 지금 켜져 있는 간편로그인 제공자를 묻는다.
// 공개 설정 엔드포인트라 anon 키만 쓴다(비밀 키 아님). 결과는 60초 캐시한다:
// 원장이 Supabase 에서 제공자를 켜면 1분 안에 버튼이 나타난다.

const SETTINGS_TIMEOUT_MS = 5_000;

export async function getEnabledParentOAuthProviders(): Promise<ParentOAuthProvider[]> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!url || !key) return enabledParentOAuthProviders(null);

  try {
    const response = await fetch(`${url.replace(/\/+$/, "")}/auth/v1/settings`, {
      headers: { apikey: key },
      next: { revalidate: 60 },
      signal: AbortSignal.timeout(SETTINGS_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return enabledParentOAuthProviders(await response.json());
  } catch (error) {
    // 조회가 실패하면 «켜진 것 없음»으로 본다. 아이디 로그인은 그대로 되고,
    // 눌러도 안 되는 버튼을 보여주는 것보다 버튼이 잠시 사라지는 편이 낫다.
    console.error(
      "[auth-providers] Supabase 로그인 설정 조회 실패:",
      error instanceof Error ? error.message : String(error),
    );
    return enabledParentOAuthProviders(null);
  }
}
