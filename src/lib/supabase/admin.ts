import { createClient } from "@supabase/supabase-js";

// Service Role 키를 사용하는 관리자 전용 클라이언트
// 서버 사이드에서만 사용할 것 (RLS 우회)
export function createAdminClient(options?: { fetch?: typeof fetch }) {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      ...(options?.fetch ? { global: { fetch: options.fetch } } : {}),
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    }
  );
}
