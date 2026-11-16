import Link from "next/link";
import { redirect } from "next/navigation";
import { logout } from "@/app/actions/auth";
import { resolveContinueDestination } from "@/lib/auth/continue-destination";

type ContinuePageProps = {
  searchParams: Promise<{
    context?: string | string[];
    redirect?: string | string[];
    bounced?: string | string[];
  }>;
};

export default async function AuthContinuePage({ searchParams }: ContinuePageProps) {
  let destination: string | null = null;
  try {
    const params = await searchParams;
    const context = Array.isArray(params.context) ? params.context[0] : params.context;
    const requestedPathParam = Array.isArray(params.redirect) ? params.redirect[0] : params.redirect;
    // 보호 화면이 "방금 이 사용자를 거절했다"고 알려온 경우. 그 화면으로 되돌려보내면
    // 거절 → 여기 → 그 화면 → 거절 이 끝없이 반복된다(ERR_TOO_MANY_REDIRECTS).
    // 목적지를 버리고 역할 기본 화면으로 보내면 한 번 튕기고 끝난다.
    const bounced = (Array.isArray(params.bounced) ? params.bounced[0] : params.bounced) === "1";
    const requestedPath = bounced ? undefined : requestedPathParam;
    // 어디로 보낼지는 공용 함수 한 곳에서 정한다(스토어 앱 시작 주소 /store-app 도 같은 함수를 쓴다).
    destination = await resolveContinueDestination({ context, requestedPath });
  } catch (error) {
    // Next.js redirects are implemented as thrown control-flow errors.
    if (error && typeof error === "object" && "digest" in error) throw error;
    destination = null;
  }

  // redirect 는 «던지는» 방식이라 try 밖에서 부른다.
  if (destination) redirect(destination);

  return (
      <main className="grid min-h-screen place-items-center bg-surface-warm px-4 dark:bg-gray-950">
        <section className="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-6 text-center shadow-sm dark:border-gray-700 dark:bg-gray-900">
          <h1 className="text-xl font-bold text-brand-navy-900 dark:text-white">
            계정 권한을 확인하지 못했습니다
          </h1>
          <p className="mt-2 text-sm leading-6 text-gray-600 dark:text-gray-300">
            잠시 후 다시 시도해 주세요. 같은 문제가 계속되면 학원 관리자에게 문의해 주세요.
          </p>
          <div className="mt-5 grid gap-2">
            <Link
              href="/auth/continue"
              className="public-btn-primary w-full"
            >
              다시 시도
            </Link>
            <form action={logout}>
              <button
                type="submit"
                className="public-btn-secondary w-full"
              >
                로그아웃
              </button>
            </form>
          </div>
        </section>
      </main>
  );
}
