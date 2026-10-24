import type { Metadata } from "next";
import { cookies } from "next/headers";
import { getParentAccountClaim } from "@/app/actions/parent-account";
import { parentClaimProofCookieName } from "@/lib/parent-account-claim";
import ParentAccountActivateClient from "./ParentAccountActivateClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { referrer: "no-referrer" };

export default async function ParentAccountActivatePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const token = String((await searchParams).token || "").trim();

  if (!token) {
    return <ClaimUnavailable title="활성화 링크를 확인해 주세요" message="주소에 필요한 인증 정보가 없습니다. 안내받은 링크를 다시 열어 주세요." />;
  }

  const result = await getParentAccountClaim(token);
  if (result.error || !result.data) {
    return <ClaimUnavailable title="계정을 활성화할 수 없습니다" message={result.error || "활성화 링크를 확인해 주세요."} />;
  }

  const claim = result.data;
  const status = String(claim.status || "PENDING").toUpperCase();
  if (status === "EXPIRED" || status === "LOCKED" || status === "ACCEPTED" || status === "COMPLETED") {
    const messages: Record<string, string> = {
      EXPIRED: "활성화 링크가 만료되었습니다. 학원에 새 링크를 요청해 주세요.",
      LOCKED: "인증 시도 횟수를 초과해 계정이 잠겼습니다. 학원에 문의해 주세요.",
      ACCEPTED: "이미 활성화가 끝난 계정입니다. 로그인 후 청구서를 확인해 주세요.",
      COMPLETED: "이미 활성화가 끝난 계정입니다. 로그인 후 청구서를 확인해 주세요.",
    };
    return <ClaimUnavailable title="계정 활성화 안내" message={messages[status]} />;
  }

  // 회원가입 화면에서 문자 인증을 이미 끝내고 넘어온 경우: 같은 브라우저에 활성화 증표 쿠키가 있다.
  // 그때는 인증번호 단계를 건너뛰고 계정 설정(이메일·비밀번호)부터 보여 준다.
  const hasProofCookie = Boolean((await cookies()).get(parentClaimProofCookieName(token))?.value);
  const alreadyVerified = status === "VERIFIED" && hasProofCookie;
  if (claim.selfService && !alreadyVerified) {
    // 학부모가 직접 시작한 활성화는 여기서 문자를 다시 보내지 않는다(인증은 회원가입 화면에서 한다).
    return (
      <ClaimUnavailable
        title="휴대폰 인증을 다시 해 주세요"
        message="인증 후 10분이 지났거나 다른 브라우저에서 열었어요. 기존 학부모 계정 활성화를 처음부터 다시 진행해 주세요."
        actionHref={`/signup/parent?${new URLSearchParams({ existing: "1", next: claim.redirectPath }).toString()}`}
        actionLabel="기존 학부모 계정 활성화"
      />
    );
  }

  return (
    <ParentAccountActivateClient
      token={token}
      maskedPhone={claim.maskedPhone}
      expiresAt={claim.expiresAt}
      redirectPath={claim.redirectPath}
      initialStep={alreadyVerified ? "ACCOUNT" : "PHONE"}
      selfService={Boolean(claim.selfService)}
    />
  );
}

function ClaimUnavailable({
  title,
  message,
  actionHref = "/login",
  actionLabel = "로그인으로 이동",
}: { title: string; message: string; actionHref?: string; actionLabel?: string }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-10 dark:bg-gray-950">
      <section className="w-full max-w-md rounded-3xl bg-white p-8 text-center shadow-lg dark:bg-gray-900" aria-labelledby="claim-unavailable-title">
        <span className="material-symbols-outlined text-5xl text-[var(--brand-accent)]" aria-hidden="true">info</span>
        <h1 id="claim-unavailable-title" className="mt-4 text-xl font-black text-gray-900 dark:text-white">{title}</h1>
        <p className="mt-3 text-sm leading-6 text-gray-600 dark:text-gray-300">{message}</p>
        <a href={actionHref} className="mt-6 inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-brand-navy-900 px-4 font-bold text-white">{actionLabel}</a>
      </section>
    </main>
  );
}
