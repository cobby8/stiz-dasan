import "server-only";
import { createClient } from "@/lib/supabase/server";
import { isLinkStartTokenFor } from "@/lib/account/link-start";

/**
 * 연결 시작 표식이 «지금 이 브라우저에 로그인한 계정 + 이 제공자»의 것인지(2026-11-17).
 * 문지기(resolveLinkActor)를 대신하지 않는다 — 문지기를 통과한 직원에게 GET 시작을 허용할지만 정한다.
 */
export async function isLinkStartForCurrentUser(token: string | null | undefined, provider: string): Promise<boolean> {
  if (!token) return false;
  const { data } = await (await createClient()).auth.getUser();
  return Boolean(data.user) && isLinkStartTokenFor(token, data.user!.id, provider);
}
