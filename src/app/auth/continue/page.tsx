import Link from "next/link";
import { redirect } from "next/navigation";
import { logout } from "@/app/actions/auth";
import { parseAppRole, resolveRedirectForRole } from "@/lib/auth-routes";
import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import { getParentViewAccessForAuthUser } from "@/lib/account-view-access";

type ContinuePageProps = {
  searchParams: Promise<{
    context?: string | string[];
    redirect?: string | string[];
    bounced?: string | string[];
  }>;
};

export default async function AuthContinuePage({ searchParams }: ContinuePageProps) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  try {
    const rows = await prisma.$queryRawUnsafe<
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
    );
    const role = parseAppRole(rows[0]?.role);
    const parentView = await getParentViewAccessForAuthUser(user);
    const params = await searchParams;
    const context = Array.isArray(params.context) ? params.context[0] : params.context;
    const requestedPathParam = Array.isArray(params.redirect) ? params.redirect[0] : params.redirect;
    // 보호 화면이 "방금 이 사용자를 거절했다"고 알려온 경우. 그 화면으로 되돌려보내면
    // 거절 → 여기 → 그 화면 → 거절 이 끝없이 반복된다(ERR_TOO_MANY_REDIRECTS).
    // 목적지를 버리고 역할 기본 화면으로 보내면 한 번 튕기고 끝난다.
    const bounced = (Array.isArray(params.bounced) ? params.bounced[0] : params.bounced) === "1";
    const requestedPath = bounced ? undefined : requestedPathParam;

    // An OAuth identity is not an application membership. New social users and
    // unverified parents must finish the mandatory phone onboarding first.
    if (!role || (role === "PARENT" && rows[0]?.username !== null && !rows[0]?.phoneVerifiedAt)) {
      const onboarding = new URLSearchParams({ social: "1" });
      if (requestedPath) onboarding.set("next", requestedPath);
      redirect(`/signup/parent?${onboarding.toString()}`);
    }

    redirect(
      resolveRedirectForRole(role, requestedPath, {
        // 브라우저에서 관리자 로그인으로 들어오면 역할 기본 화면(원장이면 /admin).
        preferRoleHome: context === "staff" && requestedPath === "/staff",
        // 설치된 선생님 앱에서 들어오면 앱 영역(/staff) 안에 머문다.
        stayInStaffApp: context === "staff-app",
        // 자녀가 등록된 직원 계정은 학부모 화면(/mypage)도 열 수 있다.
        hasOwnChildren: parentView.hasOwnChildren,
        // 승인된 추가 역할(선생님·기사님)까지 보고 목적지를 정한다(다중 역할, 2026-10-25).
        roles: parentView.roles,
      }),
    );
  } catch (error) {
    // Next.js redirects are implemented as thrown control-flow errors.
    if (error && typeof error === "object" && "digest" in error) throw error;

    return (
      <main className="grid min-h-screen place-items-center bg-surface-warm px-4 dark:bg-gray-950">
        <section className="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-6 text-center shadow-sm dark:border-gray-700 dark:bg-gray-900">
          <span className="material-symbols-outlined text-4xl text-brand-orange-500" aria-hidden="true">
            sync_problem
          </span>
          <h1 className="mt-3 text-xl font-black text-brand-navy-900 dark:text-white">
            계정 권한을 확인하지 못했습니다
          </h1>
          <p className="mt-2 text-sm leading-6 text-gray-600 dark:text-gray-300">
            잠시 후 다시 시도해 주세요. 같은 문제가 계속되면 학원 관리자에게 문의해 주세요.
          </p>
          <div className="mt-5 grid gap-2">
            <Link
              href="/auth/continue"
              className="flex min-h-11 items-center justify-center rounded-xl bg-brand-orange-500 px-4 font-bold text-white"
            >
              다시 시도
            </Link>
            <form action={logout}>
              <button
                type="submit"
                className="min-h-11 w-full rounded-xl border border-gray-300 px-4 font-bold text-gray-700 dark:border-gray-700 dark:text-gray-200"
              >
                로그아웃
              </button>
            </form>
          </div>
        </section>
      </main>
    );
  }
}
