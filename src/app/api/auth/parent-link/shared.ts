import { prisma } from "@/lib/prisma";
import { oauthProviderMethod } from "@/lib/parent-signup-verification";
import { createClient } from "@/lib/supabase/server";

/**
 * 본인인증 연결을 시작할 수 있는 사람 = 간편로그인만 막 한 사람(앱 계정이 아직 없는 Supabase 사용자).
 * 이미 앱 계정이 있는 사람은 마이페이지 「간편로그인 연결」을 쓴다 — 여기서 다른 계정으로 바꿔 주지 않는다.
 */
export async function currentSocialOnlyUser() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  const user = data.user;
  if (!user) return { error: "간편로그인 정보가 만료되었습니다. 처음부터 다시 시도해 주세요." } as const;
  const provider = String(user.app_metadata?.provider || user.identities?.[0]?.provider || "");
  if (!oauthProviderMethod(provider)) return { error: "간편로그인으로 들어온 경우에만 쓸 수 있습니다." } as const;
  const linked = await prisma.$queryRawUnsafe<Array<{ found: boolean }>>(
    `SELECT EXISTS(SELECT 1 FROM "User" WHERE "authUserId" = $1 OR id = $1) AS found`,
    user.id,
  );
  if (linked[0]?.found) return { error: "이미 학원 계정과 연결된 로그인입니다. 마이페이지에서 확인해 주세요." } as const;
  return { supabase, user, provider: provider === "custom:naver" ? "naver" : provider } as const;
}
