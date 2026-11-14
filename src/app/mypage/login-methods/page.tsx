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
import { customerMessage } from "@/components/parent/customerMessage";
import LinkProviderButton, { StoreAppLinkNotice } from "./LinkProviderButton";

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
  // 주소로 넘어온 안내문은 고객용 한국어 문장일 때만 그대로 보인다(영어 원문·개발 용어면 쉬운 문장으로 바꿈)
  const error = typeof params.error === "string" && params.error
    ? customerMessage(params.error.slice(0, 200), "간편로그인 연결을 마치지 못했습니다. 다시 시도해 주세요.")
    : "";

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <div className="mb-2 flex items-center gap-2">
        {/* 뒤로가기 = 누르는 영역 44×44(academy-back-link) */}
        <Link href="/mypage" aria-label="마이페이지로" className="academy-back-link">
          <span aria-hidden="true">←</span>
        </Link>
        <h1 className="academy-heading">
          간편로그인 연결
        </h1>
      </div>
      {/* 화면 맨 위 설명 한 줄 = 본문 14px */}
      <p className="mb-4 text-sm text-[var(--color-academy-muted)]">
        연결하면 아이디·비밀번호 없이 로그인할 수 있어요
      </p>

      {/* 스토어 앱에서는 «연결하기»를 숨기고 한 줄 안내(앱 밖으로 나가 돌아오지 못한다) */}
      <StoreAppLinkNotice />
      {justLinked && (
        <p role="status" className="mb-3 rounded-xl bg-[var(--color-academy-success-soft)] px-3 py-2 text-sm font-medium text-[var(--color-academy-success)]">
          {PARENT_OAUTH_LABELS[justLinked]} 연결을 마쳤습니다.
        </p>
      )}
      {error && (
        <p className="mb-3 rounded-xl bg-[var(--color-academy-danger-soft)] px-3 py-2 text-sm font-medium text-[var(--color-academy-danger)]">{error}</p>
      )}

      {rows.length === 0 ? (
        <p className="rounded-2xl border border-[var(--color-academy-line)] p-3.5 text-sm text-[var(--color-academy-muted)]">
          지금 연결할 수 있는 간편로그인이 없습니다.
        </p>
      ) : (
        <div className="grid gap-2">
          {rows.map((provider) => (
            <div key={provider} className="flex min-h-14 items-center gap-3 rounded-2xl border border-[var(--color-academy-line)] px-3.5 py-2.5">
              <span className="flex min-w-0 flex-1 items-center gap-2 text-sm font-medium text-[var(--color-academy-ink)]">
                {provider === "apple" && <AppleLogo />}
                {PARENT_OAUTH_LABELS[provider]}
              </span>
              {linked.has(provider) ? (
                <span className="inline-flex shrink-0 items-center rounded bg-[var(--color-academy-success-soft)] px-2 py-1 text-xs text-[var(--color-academy-success)]">
                  연결됨
                </span>
              ) : (
                // 일반 링크(<a>)는 LinkProviderButton 안에 있다 — 스토어 앱에서는 숨긴다
                <LinkProviderButton provider={provider} />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
