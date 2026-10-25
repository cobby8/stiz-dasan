import Link from "next/link";
import { redirect } from "next/navigation";
import { requireVerifiedParent } from "@/lib/auth-guard";
import { getEnabledParentOAuthProviders } from "@/lib/auth-providers";
import AppleLogo from "@/components/auth/AppleLogo";
import {
  PARENT_OAUTH_LABELS,
  PARENT_OAUTH_PROVIDERS,
  parseParentOAuthProvider,
  type ParentOAuthProvider,
} from "@/lib/parent-oauth";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "간편로그인 연결 | 스티즈 농구교실",
};

// 이미 계정이 있는 학부모가 Apple·Google 등을 같은 계정에 붙이는 화면(2026-10-26).
// 왜 여기서만 연결하나: 비밀번호로 로그인한 「본인」임이 확인된 상태라서다. 간편로그인 후 휴대폰 문자만으로
// 기존 계정에 붙이는 길은 만들지 않았다(문자 하나로 자녀 정보에 들어가는 길이 생긴다 — 원장 결정).

function identityProvider(value: string): ParentOAuthProvider | null {
  return parseParentOAuthProvider(value === "custom:naver" ? "naver" : value);
}

export default async function LoginMethodsPage({
  searchParams,
}: {
  searchParams: Promise<{ linked?: string; error?: string }>;
}) {
  const parent = await requireVerifiedParent().catch(() => null);
  // bounced=1 로 목적지를 지운다(roles 화면과 같은 이유 — 거절 → 판별 → 거절 반복 방지).
  if (!parent) redirect("/mypage/continue?bounced=1");

  const supabase = await createClient();
  const [{ data }, enabled, params] = await Promise.all([
    supabase.auth.getUserIdentities(),
    getEnabledParentOAuthProviders(),
    searchParams,
  ]);
  const linked = new Set(
    (data?.identities ?? []).map((identity) => identityProvider(identity.provider)).filter((value) => value !== null),
  );
  // 켜진 것 + 이미 연결된 것(나중에 제공자를 꺼도 연결 사실은 보여 준다)
  const rows = PARENT_OAUTH_PROVIDERS.filter((provider) => enabled.includes(provider) || linked.has(provider));
  const justLinked = parseParentOAuthProvider(params.linked ?? "");
  const error = typeof params.error === "string" ? params.error.slice(0, 200) : "";

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <div className="mb-2 flex items-center gap-2">
        <Link href="/mypage" className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">
          <span className="material-symbols-outlined">arrow_back</span>
        </Link>
        <h1 className="flex items-center gap-2 text-lg font-black text-brand-navy-900 dark:text-white">
          <span className="material-symbols-outlined text-brand-orange-500 dark:text-brand-neon-lime">link</span>
          간편로그인 연결
        </h1>
      </div>
      <p className="mb-4 text-xs text-gray-500 dark:text-gray-400">
        연결해 두면 다음부터 아이디·비밀번호 없이 그 방법으로 같은 계정에 로그인됩니다. 자녀 정보는 그대로입니다.
      </p>

      {justLinked && (
        <p role="status" className="mb-3 rounded-xl bg-green-50 px-3 py-2 text-sm font-semibold text-green-800 dark:bg-green-950/40 dark:text-green-200">
          {PARENT_OAUTH_LABELS[justLinked]} 연결을 마쳤습니다.
        </p>
      )}
      {error && (
        <p className="mb-3 rounded-xl bg-red-50 px-3 py-2 text-sm font-semibold text-red-700 dark:bg-red-950/40 dark:text-red-200">{error}</p>
      )}

      {rows.length === 0 ? (
        <p className="rounded-2xl border border-gray-200 p-3.5 text-sm text-gray-500 dark:border-gray-800 dark:text-gray-400">
          지금 연결할 수 있는 간편로그인이 없습니다.
        </p>
      ) : (
        <div className="grid gap-2">
          {rows.map((provider) => (
            <div key={provider} className="flex min-h-14 items-center gap-3 rounded-2xl border border-gray-200 px-3.5 py-2.5 dark:border-gray-800">
              <span className="flex min-w-0 flex-1 items-center gap-2 text-sm font-bold text-gray-900 dark:text-white">
                {provider === "apple" && <AppleLogo />}
                {PARENT_OAUTH_LABELS[provider]}
              </span>
              {linked.has(provider) ? (
                <span className="inline-flex items-center gap-1 rounded-md bg-green-100 px-2 py-1 text-xs font-bold text-green-800 dark:bg-green-950 dark:text-green-200">
                  <span className="material-symbols-outlined text-sm" aria-hidden>check_circle</span>
                  연결됨
                </span>
              ) : (
                // <Link> 금지 — 미리 불러오기가 시작 주소를 열면 로그인 열쇠(PKCE)가 덮어써진다(2026-10-26 사고).
                <a
                  href={`/auth/oauth/${provider}?intent=link`}
                  className="inline-flex min-h-11 items-center rounded-xl bg-brand-orange-500 px-4 text-sm font-bold text-white dark:bg-brand-neon-lime dark:text-brand-navy-900"
                >
                  연결하기
                </a>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
