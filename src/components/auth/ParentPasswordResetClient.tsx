"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";

// 학부모 아이디·비밀번호 찾기(2026-11-13) — 가입한 휴대폰 문자 인증 → 아이디 확인 → 새 비밀번호.
// 학부모 아이디는 받을 수 없는 메일 주소(아이디@member.stiz.kr)로 만들어져 메일 재설정이 닿지 않는다.

type Step = "phone" | "otp" | "accounts" | "done";
type Account = { id: string; loginId: string; kind: "PASSWORD" | "SOCIAL"; socialLabels: string[] };
type ApiData = { ok?: boolean; error?: string; challengeToken?: string; proof?: string; accounts?: Account[]; loginId?: string };

const inputClass =
  "min-h-12 w-full rounded-xl border border-[var(--color-public-line)] bg-white px-4 text-[var(--color-public-ink)] outline-none transition focus:border-[var(--color-public-accent)] focus:ring-2 focus:ring-[var(--color-public-accent)]/20 dark:border-[var(--color-public-line)] dark:bg-[var(--color-public-paper)] dark:text-white";

async function postJson(path: string, body: object): Promise<ApiData> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as ApiData;
  if (!response.ok) throw new Error(data.error || "요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.");
  return data;
}

function friendly(reason: unknown) {
  return reason instanceof Error && reason.message ? reason.message : "잠시 문제가 생겼습니다. 다시 시도해 주세요.";
}

export default function ParentPasswordResetClient() {
  const [step, setStep] = useState<Step>("phone");
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [challengeToken, setChallengeToken] = useState("");
  const [proof, setProof] = useState("");
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [loginId, setLoginId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const passwordAccounts = accounts.filter((account) => account.kind === "PASSWORD");

  async function sendCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const data = await postJson("/api/auth/parent-password-reset/start", { phone });
      setChallengeToken(data.challengeToken || "");
      setOtp("");
      setStep("otp");
    } catch (reason) {
      setError(friendly(reason));
    } finally {
      setLoading(false);
    }
  }

  async function verifyCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const data = await postJson("/api/auth/parent-password-reset/verify-otp", { challengeToken, otp });
      const list = data.accounts || [];
      setProof(data.proof || "");
      setAccounts(list);
      setSelectedId(list.find((account) => account.kind === "PASSWORD")?.id || "");
      setStep("accounts");
    } catch (reason) {
      setError(friendly(reason));
    } finally {
      setLoading(false);
    }
  }

  async function savePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") || "");
    if (password !== String(form.get("passwordConfirm") || "")) {
      setError("비밀번호가 서로 다릅니다.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await postJson("/api/auth/parent-password-reset/complete", {
        challengeToken,
        proof,
        accountId: selectedId,
        password,
      });
      setLoginId(data.loginId || "");
      setStep("done");
    } catch (reason) {
      setError(friendly(reason));
    } finally {
      setLoading(false);
    }
  }

  function restart() {
    setStep("phone");
    setChallengeToken("");
    setProof("");
    setOtp("");
    setAccounts([]);
    setError(null);
  }

  return (
    <div className="space-y-6">
      {error && <p role="alert" className="rounded-xl border border-[var(--color-academy-danger-line)] bg-[var(--color-academy-danger-soft)] p-3 text-sm text-[var(--color-academy-danger)]">{error}</p>}

      {step === "phone" && (
        <form onSubmit={sendCode} className="space-y-4">
          <div>
            <h1 className="text-xl font-bold">아이디·비밀번호 찾기</h1>
            <p className="mt-1 text-sm text-[var(--color-public-muted)]">가입할 때 인증한 휴대폰 번호로 본인 확인 후 아이디를 알려 드리고 비밀번호를 새로 정할 수 있어요.</p>
          </div>
          <label className="block text-sm font-semibold">휴대폰 번호<input className={`${inputClass} mt-2`} type="tel" value={phone} onChange={(event) => setPhone(event.target.value.replace(/[^0-9]/g, ""))} inputMode="numeric" autoComplete="tel" placeholder="01012345678" minLength={10} maxLength={11} required /></label>
          <button disabled={loading} className="min-h-12 w-full rounded-xl bg-[var(--color-public-accent)] font-bold text-white hover:bg-[var(--color-public-strong)] disabled:opacity-50">{loading ? "보내는 중..." : "인증번호 받기"}</button>
          <p className="text-xs leading-5 text-[var(--color-public-muted)]">선생님·기사님 계정은 원장님께 비밀번호 재설정 링크를 요청해 주세요.</p>
        </form>
      )}

      {step === "otp" && (
        <form onSubmit={verifyCode} className="space-y-4">
          <div><h1 className="text-xl font-bold">인증번호 입력</h1><p className="mt-1 text-sm text-[var(--color-public-muted)]">{phone}로 보낸 6자리 번호를 입력해 주세요.</p></div>
          <label className="block text-sm font-semibold">인증번호<input className={`${inputClass} mt-2 text-center text-xl tracking-[0.4em]`} value={otp} onChange={(event) => setOtp(event.target.value.replace(/[^0-9]/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" required /></label>
          <button disabled={loading || otp.length !== 6} className="min-h-12 w-full rounded-xl bg-[var(--color-public-accent)] font-bold text-white hover:bg-[var(--color-public-strong)] disabled:opacity-50">{loading ? "확인 중..." : "확인"}</button>
          <button type="button" onClick={restart} className="w-full text-sm text-[var(--color-public-muted)] underline">번호 다시 입력하기</button>
        </form>
      )}

      {step === "accounts" && (
        <div className="space-y-4">
          <div><h1 className="text-xl font-bold">가입된 계정</h1><p className="mt-1 text-sm text-[var(--color-public-muted)]">이 번호로 가입된 학부모 계정이에요.</p></div>
          <ul className="space-y-2">
            {accounts.map((account) => (
              <li key={account.id} className="rounded-xl border border-[var(--color-public-line)] p-3 text-sm">
                {account.kind === "PASSWORD" ? (
                  <label className="flex items-center gap-3">
                    {passwordAccounts.length > 1 && <input type="radio" name="account" checked={selectedId === account.id} onChange={() => setSelectedId(account.id)} />}
                    <span>로그인 아이디 <strong className="break-all">{account.loginId}</strong></span>
                  </label>
                ) : (
                  <span>
                    로그인 아이디 <strong className="break-all">{account.loginId}</strong>
                    <span className="mt-1 block text-xs text-[var(--color-public-muted)]">{account.socialLabels.join("·") || "간편로그인"}으로 가입한 계정이에요. 비밀번호 없이 로그인 화면의 {account.socialLabels[0] || "간편로그인"} 버튼으로 로그인해 주세요.</span>
                  </span>
                )}
              </li>
            ))}
          </ul>
          {passwordAccounts.length > 0 ? (
            <form onSubmit={savePassword} className="space-y-4">
              <label className="block text-sm font-semibold">새 비밀번호<input name="password" type="password" className={`${inputClass} mt-2`} autoComplete="new-password" minLength={8} maxLength={72} placeholder="8자 이상" required /></label>
              <label className="block text-sm font-semibold">새 비밀번호 확인<input name="passwordConfirm" type="password" className={`${inputClass} mt-2`} autoComplete="new-password" minLength={8} maxLength={72} required /></label>
              <button disabled={loading || !selectedId} className="min-h-12 w-full rounded-xl bg-[var(--color-public-accent)] font-bold text-white hover:bg-[var(--color-public-strong)] disabled:opacity-50">{loading ? "저장하는 중..." : "새 비밀번호 저장"}</button>
              <p className="text-xs leading-5 text-[var(--color-public-muted)]">10분 안에 마쳐 주세요. 시간이 지나면 처음부터 다시 인증하면 됩니다.</p>
            </form>
          ) : (
            <Link href="/login" className="flex min-h-12 items-center justify-center rounded-xl bg-[var(--color-public-accent)] font-bold text-white hover:bg-[var(--color-public-strong)]">로그인 화면으로</Link>
          )}
        </div>
      )}

      {step === "done" && (
        <div className="py-6 text-center">
          <span className="material-symbols-outlined text-5xl text-[var(--color-public-accent)]" aria-hidden="true">check_circle</span>
          <h1 className="mt-3 text-xl font-bold">비밀번호를 새로 정했어요</h1>
          {loginId && <p className="mt-2 text-sm text-[var(--color-public-muted)]">로그인 아이디 <strong className="break-all text-[var(--color-public-ink)]">{loginId}</strong></p>}
          <Link href="/login" className="mt-6 flex min-h-12 items-center justify-center rounded-xl bg-[var(--color-public-accent)] font-bold text-white hover:bg-[var(--color-public-strong)]">로그인하기</Link>
        </div>
      )}
    </div>
  );
}
