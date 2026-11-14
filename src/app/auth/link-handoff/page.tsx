import type { Metadata } from "next";
import { PARENT_OAUTH_LABELS, parseParentOAuthProvider } from "@/lib/parent-oauth";
import {
  LINK_HANDOFF_EXPIRED_MESSAGE,
  LINK_HANDOFF_START_PATH,
  confirmAccountLabel,
  linkHandoffErrorMessage,
} from "@/lib/account-link-handoff/rules";
import { isLinkHandoffToken } from "@/lib/account-link-handoff/token";
import { linkHandoffAccountLabel, peekLinkHandoff } from "@/lib/account-link-handoff/store";
import { LinkHandoffShell } from "./LinkHandoffShell";
import StripHandoffToken from "./StripHandoffToken";

// 앱에서 «연결하기»를 누르면 휴대폰 기본 브라우저에 열리는 확인 화면(2026-11-15 A안).
// 여기서는 표를 «읽기만» 한다 — 카카오톡 링크 미리보기 같은 자동 열람이 열어도 표가 쓰이지 않는다.
// 실제 사용은 [계속](폼 POST)을 눌렀을 때 한 번만(/auth/link-handoff/start).
// 주소에 1회용 표가 있으므로 검색 노출·다른 사이트로 주소 전달·캐시 저장을 모두 막는다
// (next.config 헤더 + 아래 메타데이터, force-dynamic 은 no-store). 첫 화면에서 주소의 t 도 지운다(StripHandoffToken).
// referrer 는 same-origin — no-referrer 로 두면 일부 브라우저가 같은 사이트 폼 POST 에도 «Origin: null» 을 붙여
// 시작 단계 출처 검사가 늘 거절한다(검수 반영). same-origin 은 다른 사이트로는 주소를 보내지 않는다.

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "간편로그인 연결 | 스티즈 농구교실",
  referrer: "same-origin",
  robots: { index: false, follow: false },
};

export default async function LinkHandoffConfirmPage({
  searchParams,
}: {
  searchParams: Promise<{ t?: string | string[]; e?: string | string[] }>;
}) {
  const params = await searchParams;
  const token = Array.isArray(params.t) ? params.t[0] : params.t;
  const errorCode = Array.isArray(params.e) ? params.e[0] : params.e;

  // 시작 단계에서 실패해 돌아온 경우 — 정해 둔 문구만 보인다
  const startError = linkHandoffErrorMessage(errorCode);
  if (startError) return <LinkHandoffShell title="연결하지 못했어요" message={startError} tone="danger" />;

  const claim = isLinkHandoffToken(token) ? await peekLinkHandoff(token).catch(() => null) : null;
  const provider = claim ? parseParentOAuthProvider(claim.provider) : null;
  if (!claim || !provider || !token) {
    return <LinkHandoffShell title="연결 시간이 지났어요" message={LINK_HANDOFF_EXPIRED_MESSAGE} tone="danger" />;
  }

  const account = await linkHandoffAccountLabel(claim.authUserId).catch(() => null);
  const label = PARENT_OAUTH_LABELS[provider];

  return (
    <LinkHandoffShell title={`${label} 로그인 연결`}>
      <StripHandoffToken />
      <p className="text-sm text-[var(--color-academy-ink)]">
        <span className="font-semibold">{confirmAccountLabel(account ?? {})}</span> 계정에 {label} 로그인을 연결합니다.
      </p>
      <p className="mt-1 text-sm text-[var(--color-academy-muted)]">
        본인 계정이 아니면 이 화면을 닫아 주세요. 연결하는 동안 이 브라우저에는 스티즈 로그인이 남지 않습니다.
      </p>
      {/* 폼 POST — 링크 미리보기·자동 열람은 POST 를 보내지 않으므로 표가 여기서만 쓰인다 */}
      <form method="post" action={LINK_HANDOFF_START_PATH} className="mt-4">
        <input type="hidden" name="t" value={token} />
        <button type="submit" className="academy-button-primary w-full">
          계속
        </button>
      </form>
    </LinkHandoffShell>
  );
}
