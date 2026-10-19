import { parseAppRole, type AppRole } from "@/lib/auth-routes";
import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";

/**
 * 공개 페이지의 계정 이동 버튼에 사용할 실제 DB 역할을 조회한다.
 *
 * 토큰 metadata는 오래되거나 클라이언트에서 변조될 수 있으므로 목적지 판단에
 * 사용하지 않는다. 인증 또는 DB 조회가 실패하면 로그인 버튼으로 안전하게
 * 축소되도록 null을 반환한다.
 */
export async function getPublicAccountRole(): Promise<AppRole | null> {
  try {
    const supabase = await createClient();
    const claimsResult = await supabase.auth.getClaims();
    let authUserId =
      !claimsResult.error && typeof claimsResult.data?.claims?.sub === "string"
        ? claimsResult.data.claims.sub
        : null;
    let email =
      !claimsResult.error && typeof claimsResult.data?.claims?.email === "string"
        ? claimsResult.data.claims.email
        : null;

    // 일부 기존 세션에서 claims를 온전히 읽지 못하는 경우 서버 검증 API로 보완한다.
    if (!authUserId || !email) {
      const {
        data: { user },
        error,
      } = await supabase.auth.getUser();
      if (error || !user) return null;
      authUserId ||= user.id;
      email ||= user.email ?? null;
    }

    // 초대·소셜 로그인은 앱 ID가 달라도 명시적인 Auth 연결이 가장 정확합니다.
    const boundUser = authUserId
      ? await prisma.user.findUnique({ where: { authUserId }, select: { role: true } })
      : null;
    if (boundUser) return parseAppRole(boundUser.role);

    // Supabase 계정 ID와 앱 User ID가 같은 신규 계정은 ID로 가장 정확하게 찾는다.
    const userById = authUserId
      ? await prisma.user.findUnique({
          where: { id: authUserId },
          select: { role: true },
        })
      : null;
    if (userById) return parseAppRole(userById.role);

    if (!email) return null;

    // 기존 계정은 서로 다른 UUID를 사용할 수 있어 이메일을 보조 열쇠로 사용한다.
    // 이전에 대문자가 섞여 저장된 계정도 찾도록 PostgreSQL 대소문자 무시 비교를 적용한다.
    const userByEmail = await prisma.user.findFirst({
      where: {
        email: {
          equals: email.trim(),
          mode: "insensitive",
        },
      },
      select: { role: true },
    });

    return parseAppRole(userByEmail?.role);
  } catch (error) {
    console.error("공개 페이지 계정 역할 조회 실패:", error);
    return null;
  }
}
