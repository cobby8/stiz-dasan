import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { isNativeSession, nativeSessionCookieOptions } from "@/lib/native-session-cookies";

export async function createClient() {
  const cookieStore = await cookies();
  const native = isNativeSession(cookieStore.getAll());

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, nativeSessionCookieOptions(options, native))
            );
          } catch {
            // setAll은 Server Component에서 호출될 수 있음
            // 미들웨어에서 세션 갱신이 처리되므로 무시 가능
          }
        },
      },
    }
  );
}
