import { parseAppRole, resolveRedirectForRole } from "@/lib/auth-routes";
import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import { getParentViewAccessForAuthUser } from "@/lib/account-view-access";
import { readLastViewDestination } from "@/lib/auth/last-view-server";

/**
 * 로그인한 사람을 어느 화면으로 보낼지 정한다(2026-11-17 속도 개선으로 /auth/continue 화면에서 옮김).
 *
 * 왜 따로 뺐나: 스토어 앱 시작 주소(/store-app)가 «여는 중» 화면 → /auth/continue → 목적 화면으로
 * 서버를 세 번 깨웠다. 시작 주소가 이 함수를 직접 불러 목적 화면으로 곧바로 보내면 한 번이 줄어든다.
 * 판정은 반드시 이 한 곳에서만 한다 — /auth/continue 와 /store-app 이 다른 답을 내면 안 된다.
 *
 * 돌려주는 값은 «갈 주소» 하나. 확인에 실패하면 던진다(부르는 쪽이 안내 화면·기존 경로로 받는다).
 */
export async function resolveContinueDestination(input: {
  /** 로그인 화면이 알려 준 맥락("staff" = 관리자 로그인, "staff-app" = 설치된 선생님 앱) */
  context?: string;
  /** 원래 가려던 주소. 보호 화면이 방금 거절한 경우(bounced)에는 부르는 쪽이 비워서 넘긴다 */
  requestedPath?: string;
  /** 보호 화면이 방금 거절해 되돌아온 경우 — «마지막에 쓰던 화면» 쿠키도 따르지 않는다(반복 방지) */
  bounced?: boolean;
}): Promise<string> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return "/login";

  const { context, requestedPath } = input;

  // 두 확인은 서로 기다릴 이유가 없어 함께 보낸다(동시 2개 — 한 요청의 동시 조회는 3개 이하로 둔다).
  const [rows, parentView] = await Promise.all([
    prisma.$queryRawUnsafe<
      Array<{ role: string; username: string | null; phoneVerifiedAt: Date | null }>
    >(
      // 대표 역할과 자녀 화면 자격은 구분합니다. 자녀는 아래의 직접 인증 연결로 확인합니다.
      `SELECT role, username, "phoneVerifiedAt"
       FROM "User"
       WHERE "authUserId" = $1 OR id = $1 OR LOWER(email) = LOWER($2)
       ORDER BY CASE WHEN "authUserId" = $1 THEN 0 WHEN id = $1 THEN 1 ELSE 2 END
       LIMIT 1`,
      user.id,
      user.email || "",
    ),
    getParentViewAccessForAuthUser(user),
  ]);
  const role = parseAppRole(rows[0]?.role);

  // An OAuth identity is not an application membership. New social users and
  // unverified parents must finish the mandatory phone onboarding first.
  if (!role || (role === "PARENT" && rows[0]?.username !== null && !rows[0]?.phoneVerifiedAt)) {
    const onboarding = new URLSearchParams({ social: "1" });
    if (requestedPath) onboarding.set("next", requestedPath);
    return `/signup/parent?${onboarding.toString()}`;
  }

  // 마지막에 쓰던 화면(2026-11-17 원장 승인): 원래 가려던 화면·로그인 맥락이 없고 방금 거절된 것도 아닐 때만,
  // 화면 전환에서 고른 화면으로 보낸다. 그 계정이 그 화면을 쓸 수 없으면 null — 아래 기본 판정으로 간다.
  const lastView = await readLastViewDestination({
    role,
    access: parentView,
    requestedPath,
    context,
    bounced: input.bounced,
  });
  if (lastView) return lastView;

  return resolveRedirectForRole(role, requestedPath, {
    // 브라우저에서 관리자 로그인으로 들어오면 역할 기본 화면(원장이면 /admin).
    preferRoleHome: context === "staff" && requestedPath === "/staff",
    // 설치된 선생님 앱에서 들어오면 앱 영역(/staff) 안에 머문다.
    stayInStaffApp: context === "staff-app",
    // 자녀가 등록된 직원 계정은 학부모 화면(/mypage)도 열 수 있다.
    hasOwnChildren: parentView.hasOwnChildren,
    // 승인된 추가 역할(선생님·기사님)까지 보고 목적지를 정한다(다중 역할, 2026-10-25).
    roles: parentView.roles,
  });
}
