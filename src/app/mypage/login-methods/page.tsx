import Link from "next/link";
import { headers } from "next/headers";
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
import { looksLikeStoreApp } from "@/lib/storeApp";
import { nativeAuthEnabled } from "@/lib/native-auth/policy";
import { isLinkHandoffEligible, linkButtonMode, linkHandoffUrl } from "@/lib/account-link-handoff/rules";
import { issueLinkHandoffs, linkHandoffAccountRows } from "@/lib/account-link-handoff/store";
import LinkProviderButton, { LinkHandoffRefresher, StoreAppLinkNotice } from "./LinkProviderButton";

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
  const [{ data }, enabled, params, requestHeaders] = await Promise.all([
    supabase.auth.getUserIdentities(),
    getEnabledParentOAuthProviders(),
    searchParams,
    headers(),
  ]);
  const linked = new Set(
    (data?.identities ?? []).map((identity) => identityProvider(identity.provider)).filter((value) => value !== null),
  );
  // 켜진 것 + 이미 연결된 것(나중에 제공자를 꺼도 연결 사실은 보여 준다)
  const rows = PARENT_OAUTH_PROVIDERS.filter((provider) => enabled.includes(provider) || linked.has(provider));
  const justLinked = parseParentOAuthProvider(params.linked ?? "");

  // 앱(사용자 에이전트 표식)에서 열렸고 앱 로그인 스위치가 켜졌으면, 아직 연결 안 된 켜진 제공자마다
  // 1회용 표를 만들어 «바깥 브라우저에서 연결» 링크를 그린다(2026-11-15 A안). 발급 대상은 위에서 확인한 본인뿐.
  const mode = linkButtonMode({
    storeAppUserAgent: looksLikeStoreApp({ userAgent: requestHeaders.get("user-agent") }),
    nativeAuthEnabled: nativeAuthEnabled(),
  });
  let handoffHrefs: Partial<Record<ParentOAuthProvider, string>> = {};
  // 앱에서 연결할 수 있는 화면인가 — 남은 제공자가 없어도(전부 연결됨) 앱 안내 줄은 그리지 않는다
  let appCanLink = false;
  // 학부모 확인을 통과해도 «학부모 하나·직원 역할 없음·휴대폰 인증·탈퇴 아님»이 아니면 발급하지 않는다(검수 반영).
  // 못 읽으면(마이그레이션 전·DB 오류) 발급하지 않는다 → 지금처럼 숨김 + 안내.
  const eligible = mode === "handoff"
    && isLinkHandoffEligible(await linkHandoffAccountRows(parent.id).catch(() => []));
  if (mode === "handoff" && eligible) {
    const pending = rows.filter((provider) => enabled.includes(provider) && !linked.has(provider));
    // 표를 못 만들면(마이그레이션 전 등) 링크 없이 그린다 → 화면 부품이 앱으로 알아보고 지금처럼 숨긴다
    const tokens = await issueLinkHandoffs(parent.id, pending).catch((issueError: unknown) => {
      console.error("[login-methods] link handoff issue failed:", issueError instanceof Error ? issueError.message : "UNKNOWN");
      return {} as Partial<Record<ParentOAuthProvider, string>>;
    });
    handoffHrefs = Object.fromEntries(
      Object.entries(tokens).map(([provider, token]) => [provider, linkHandoffUrl(token as string)]),
    ) as Partial<Record<ParentOAuthProvider, string>>;
    appCanLink = pending.length === 0 || Object.keys(handoffHrefs).length > 0;
  }
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
        연결해 두면 다음부터 아이디·비밀번호 없이 그 방법으로 같은 계정에 로그인됩니다. 자녀 정보는 그대로입니다.
      </p>

      {/* 앱에서 연결할 수 있으면 돌아왔을 때 새로 그리고, 없으면 «연결하기»를 숨기고 한 줄 안내 */}
      {appCanLink ? <LinkHandoffRefresher /> : <StoreAppLinkNotice />}
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
                // 일반 링크(<a>)는 LinkProviderButton 안에 있다 — 앱이면 바깥 브라우저 링크, 연결 못 하는 앱이면 숨김
                <LinkProviderButton provider={provider} handoffHref={handoffHrefs[provider]} />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
