import type { Metadata } from "next";
import { PARENT_OAUTH_LABELS, parseParentOAuthProvider } from "@/lib/parent-oauth";
import { isMaskedAccountLabel, linkDoneErrorMessage } from "@/lib/account-link-handoff/rules";
import { LinkHandoffShell } from "../LinkHandoffShell";

// 앱에서 넘어온 연결의 마지막 화면(바깥 브라우저, 2026-11-15 A안).
// 이 브라우저의 로그인은 콜백에서 이미 지웠다 — 여기서는 결과만 알리고 «앱으로 돌아가기»를 안내한다.
// 주소의 글자는 그대로 보이지 않는다(검수 반영): 실패는 정해 둔 코드(e) → 문구, 성공의 가린 아이디(acct)는
// 정해진 모양(«아이디 sn****»·«김** 님»)일 때만 보인다.

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "간편로그인 연결 | 스티즈 농구교실",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default async function LinkHandoffDonePage({
  searchParams,
}: {
  searchParams: Promise<{ linked?: string | string[]; acct?: string | string[]; e?: string | string[] }>;
}) {
  const params = await searchParams;
  const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
  const linked = parseParentOAuthProvider(first(params.linked) ?? "");
  const errorCode = first(params.e);
  const account = first(params.acct);

  if (linked && !errorCode) {
    const label = PARENT_OAUTH_LABELS[linked];
    const message = isMaskedAccountLabel(account)
      ? `${account} 계정에 ${label} 연결을 마쳤습니다. 스티즈 앱으로 돌아가 주세요.`
      : `${label} 연결을 마쳤습니다. 스티즈 앱으로 돌아가 주세요.`;
    return (
      <LinkHandoffShell title="연결을 마쳤어요" message={message} tone="success">
        <p className="mt-3 text-sm text-[var(--color-academy-muted)]">이 브라우저 창은 닫아도 됩니다.</p>
      </LinkHandoffShell>
    );
  }

  return (
    <LinkHandoffShell title="연결하지 못했어요" message={linkDoneErrorMessage(errorCode)} tone="danger">
      <p className="mt-3 text-sm text-[var(--color-academy-muted)]">스티즈 앱으로 돌아가 «연결하기»를 다시 눌러 주세요.</p>
    </LinkHandoffShell>
  );
}
