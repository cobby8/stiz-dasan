import { headers } from "next/headers";
import AppleLogo from "@/components/auth/AppleLogo";
import { staffLinkErrorMessage } from "@/lib/account/login-methods-rules";
import { requireStaff } from "@/lib/auth-guard";
import { getEnabledParentOAuthProviders } from "@/lib/auth-providers";
import {
  PARENT_OAUTH_LABELS,
  PARENT_OAUTH_PROVIDERS,
  parseParentOAuthProvider,
  type ParentOAuthProvider,
} from "@/lib/parent-oauth";
import { looksLikeStoreApp } from "@/lib/storeApp";
import { createClient } from "@/lib/supabase/server";
import StaffLinkProviderButton, { StaffStoreAppLinkNotice } from "./StaffLinkProviderButton";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "간편로그인 연결 | 스티즈 선생님",
};

/**
 * 직원(원장·부원장·선생님·기사님) «간편로그인 연결»(2026-11-17 원장 지시 「선생님·원장 계정에도 간편로그인 연결 열어」).
 * 계기: 원장이 앱에서 Apple 로그인을 눌렀는데 연결된 적이 없어 «가입된 학원 계정이 없습니다»가 나왔다.
 * 여기서 연결해 두면 앱·브라우저 모두에서 그 간편로그인으로 들어올 수 있다.
 *
 * 왜 이 화면에서만 연결하나: 아이디·비밀번호로 로그인한 «본인»임이 확인된 상태라서다(학부모 화면과 같은 이유).
 * 학부모 화면과 다른 점 하나: 스토어 앱 안에서는 연결하지 못한다. 앱에서 바깥 브라우저로 넘기는 1회용 표는
 * 학생 정보가 열리는 직원 계정에는 만들지 않기로 했다(보안 검수 결정) → 앱에서는 안내만 보인다.
 */

function identityProvider(value: string): ParentOAuthProvider | null {
  return parseParentOAuthProvider(value === "custom:naver" ? "naver" : value);
}

export default async function StaffLoginMethodsPage({
  searchParams,
}: {
  searchParams: Promise<{ linked?: string; e?: string }>;
}) {
  // 문지기 = 직원 로그인(마이페이지와 같은 방식). 직원이 아니면 여기서 예외가 나 화면이 열리지 않는다.
  await requireStaff();

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
  // 스토어 앱인지 서버에서 먼저 본다(사용자 에이전트 표식). 표식 없는 옛 앱은 화면 부품이 브라우저 저장소로 알아본다.
  const serverStoreApp = looksLikeStoreApp({ userAgent: requestHeaders.get("user-agent") });
  // 실패 안내는 주소의 «코드»(e)로만 받는다 — 주소에 실린 문장은 읽지 않는다(가짜 안내문 방지).
  // 표에 없는 코드·빈 값이면 아무것도 보이지 않는다.
  const error = staffLinkErrorMessage(params.e);

  return (
    <main className="mx-auto max-w-lg space-y-3 px-4 pb-8 pt-5">
      {/* 뒤로 가기는 선생님 화면 머리줄의 버튼(AppBackButton)이 맡는다 */}
      <div>
        <h1 className="academy-heading">간편로그인 연결</h1>
        <p className="mt-1 text-sm text-[var(--color-academy-muted)]">
          연결하면 아이디·비밀번호 없이 로그인할 수 있어요
        </p>
      </div>

      {/* 스토어 앱 안에서는 «연결하기» 대신 이 안내 한 줄만 보인다 */}
      <StaffStoreAppLinkNotice serverStoreApp={serverStoreApp} />
      {justLinked && (
        <p role="status" className="rounded-xl bg-[var(--color-academy-success-soft)] px-3 py-2 text-sm font-medium text-[var(--color-academy-success)]">
          {PARENT_OAUTH_LABELS[justLinked]} 연결을 마쳤습니다.
        </p>
      )}
      {error && (
        <p role="alert" className="rounded-xl bg-[var(--color-academy-danger-soft)] px-3 py-2 text-sm font-medium text-[var(--color-academy-danger)]">{error}</p>
      )}

      {rows.length === 0 ? (
        // 흐린 글자색은 안쪽 span 에 준다 — academy-panel 과 같은 요소에 두면 테마 CSS 의 글자색이 이겨 무시된다
        <p className="academy-panel px-4 py-3 text-sm">
          <span className="text-[var(--color-academy-muted)]">지금 연결할 수 있는 간편로그인이 없습니다.</span>
        </p>
      ) : (
        <ul className="academy-panel divide-y divide-[var(--color-academy-line)] overflow-hidden">
          {rows.map((provider) => (
            <li key={provider} className="flex min-h-14 items-center gap-3 px-4 py-1.5">
              <span className="flex min-w-0 flex-1 items-center gap-2 text-sm font-medium text-[var(--color-academy-ink)]">
                {provider === "apple" && <AppleLogo />}
                {PARENT_OAUTH_LABELS[provider]}
              </span>
              {linked.has(provider) ? (
                <span className="inline-flex shrink-0 items-center rounded bg-[var(--color-academy-success-soft)] px-2 py-1 text-xs text-[var(--color-academy-success)]">
                  연결됨
                </span>
              ) : enabled.includes(provider) ? (
                // 폼 POST 버튼은 부품 안에 있다 — 스토어 앱이면 그리지 않는다
                <StaffLinkProviderButton provider={provider} serverStoreApp={serverStoreApp} />
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
