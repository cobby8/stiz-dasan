"use client";

import { useEffect, useState, useTransition } from "react";
import {
  acceptParentAccountClaim,
  sendParentAccountOtp,
  verifyParentAccountOtp,
} from "@/app/actions/parent-account";

type Step = "PHONE" | "OTP" | "ACCOUNT";
type ActivationResult =
  | { error: string }
  | { ok: true; redirectPath: string; sessionEstablished: boolean; loginRedirect?: string };

function safeInternalPath(value: string | undefined, fallback = "/mypage") {
  if (!value || !value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(value)) return fallback;
  try {
    const decoded = decodeURIComponent(value);
    if (!decoded.startsWith("/") || decoded.startsWith("//") || decoded.includes("\\")) return fallback;
    const parsed = new URL(value, window.location.origin);
    return parsed.origin === window.location.origin ? `${parsed.pathname}${parsed.search}${parsed.hash}` : fallback;
  } catch {
    return fallback;
  }
}

export default function ParentAccountActivateClient({
  token,
  maskedPhone,
  expiresAt,
  redirectPath,
  initialStep = "PHONE",
  selfService = false,
}: {
  token: string;
  maskedPhone: string;
  expiresAt: string | Date;
  redirectPath: string;
  // ACCOUNT: 회원가입 화면에서 문자 인증을 이미 끝내고 넘어온 경우
  initialStep?: Step;
  // 학부모가 직접 시작한 활성화(특강 결제 링크가 아님) — 안내 문구만 다르다
  selfService?: boolean;
}) {
  const [step, setStep] = useState<Step>(initialStep);
  const [otp, setOtp] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    const cleanUrl = new URL(window.location.href);
    cleanUrl.searchParams.delete("token");
    window.history.replaceState(window.history.state, "", `${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}`);
  }, []);

  const expiryLabel = new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Seoul",
  }).format(new Date(expiresAt));

  function runServerAction(action: () => Promise<void>, fallbackMessage: string) {
    setMessage(null);
    startTransition(async () => {
      try {
        await action();
      } catch {
        setMessage({ kind: "error", text: fallbackMessage });
      }
    });
  }

  function requestOtp() {
    runServerAction(async () => {
      const result = await sendParentAccountOtp(token);
      if ("error" in result) {
        setMessage({ kind: "error", text: result.error || "인증번호를 발송하지 못했습니다." });
        return;
      }
      setStep("OTP");
      setMessage({ kind: "success", text: "인증번호를 발송했습니다. 문자로 받은 6자리 번호를 입력해 주세요." });
    }, "인증번호를 발송하지 못했습니다. 네트워크를 확인한 뒤 다시 시도해 주세요.");
  }

  function verifyOtp() {
    if (otp.length !== 6) return;
    runServerAction(async () => {
      const result = await verifyParentAccountOtp(token, otp);
      if ("error" in result && result.error) {
        setMessage({ kind: "error", text: result.error });
        return;
      }
      if (!("verified" in result) || !result.verified) {
        setMessage({ kind: "error", text: "인증을 완료하지 못했습니다. 인증번호를 다시 확인해 주세요." });
        return;
      }
      setStep("ACCOUNT");
    }, "인증번호를 확인하지 못했습니다. 네트워크를 확인한 뒤 다시 시도해 주세요.");
  }

  function activateAccount() {
    const cleanEmail = email.trim();
    setMessage(null);
    if (!cleanEmail || !cleanEmail.includes("@")) {
      setMessage({ kind: "error", text: "로그인에 사용할 실제 이메일을 입력해 주세요." });
      return;
    }
    if (password.length < 10) {
      setMessage({ kind: "error", text: "비밀번호는 10자 이상 입력해 주세요." });
      return;
    }
    if (password !== passwordConfirm) {
      setMessage({ kind: "error", text: "비밀번호와 비밀번호 확인이 일치하지 않습니다." });
      return;
    }

    runServerAction(async () => {
      const result = await acceptParentAccountClaim(token, cleanEmail, password) as ActivationResult;
      if ("error" in result) {
        setMessage({ kind: "error", text: result.error });
        return;
      }
      const destination = safeInternalPath(result.redirectPath || redirectPath);
      const loginDestination = safeInternalPath(
        result.loginRedirect,
        `/login?redirect=${encodeURIComponent(destination)}`,
      );
      window.location.assign(result.sessionEstablished ? destination : loginDestination);
    }, "계정을 만들지 못했습니다. 네트워크를 확인한 뒤 다시 시도해 주세요.");
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-10 dark:bg-gray-950">
      <section className="w-full max-w-md overflow-hidden rounded-3xl bg-white shadow-lg dark:bg-gray-900" aria-labelledby="activate-title">
        <header className="bg-brand-navy-900 px-6 py-7 text-white">
          <p className="text-sm font-bold text-[var(--brand-accent)]">{selfService ? "STIZ 농구교실" : "STIZ 특강"}</p>
          <h1 id="activate-title" className="mt-1 text-2xl font-black">{selfService ? "기존 학부모 계정 활성화" : "보호자 계정 활성화"}</h1>
          <p className="mt-2 text-sm leading-6 text-gray-300">{selfService ? "휴대폰 인증이 끝났어요. 앞으로 로그인에 쓸 이메일과 비밀번호만 정해 주세요." : "본인 확인 후 결제에 사용할 로그인 정보를 만들어 주세요."}</p>
        </header>

        <div className="space-y-5 p-6">
          <ol className="grid grid-cols-3 gap-2 text-center text-xs font-bold" aria-label="계정 활성화 진행 단계">
            <ProgressStep active step="1" label="휴대폰 확인" />
            <ProgressStep active={step !== "PHONE"} step="2" label="인증번호" />
            <ProgressStep active={step === "ACCOUNT"} step="3" label="계정 설정" />
          </ol>

          {step === "PHONE" && (
            <div className="space-y-4">
              <div className="rounded-2xl bg-gray-50 p-4 dark:bg-gray-800">
                <p className="text-xs font-bold text-gray-500">인증번호를 받을 휴대폰</p>
                <p className="mt-1 text-lg font-black text-gray-900 dark:text-white">{maskedPhone}</p>
                <p className="mt-2 text-xs text-gray-500">링크 유효기간: {expiryLabel}</p>
              </div>
              <PrimaryButton pending={pending} onClick={requestOtp} label="인증번호 받기" pendingLabel="발송 중…" />
            </div>
          )}

          {step === "OTP" && (
            <div className="space-y-4">
              <div>
                <label htmlFor="parent-otp" className="text-sm font-bold text-gray-800 dark:text-gray-100">문자로 받은 인증번호</label>
                <input id="parent-otp" inputMode="numeric" autoComplete="one-time-code" value={otp} onChange={(event) => setOtp(event.target.value.replace(/\D/g, "").slice(0, 6))} maxLength={6} placeholder="000000" className="mt-2 min-h-14 w-full rounded-xl border border-gray-300 bg-white px-4 text-center text-2xl font-black tracking-[0.35em] outline-none focus:border-[var(--brand-accent)] dark:border-gray-700 dark:bg-gray-800" />
              </div>
              <PrimaryButton pending={pending} disabled={otp.length !== 6} onClick={verifyOtp} label="본인 확인" pendingLabel="확인 중…" />
              <button type="button" disabled={pending} onClick={requestOtp} className="min-h-11 w-full text-sm font-bold text-gray-500 underline disabled:opacity-50">인증번호 다시 받기</button>
            </div>
          )}

          {step === "ACCOUNT" && (
            <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); activateAccount(); }}>
              <Field id="parent-email" label="로그인 이메일" type="email" value={email} onChange={setEmail} autoComplete="email" placeholder="name@example.com" />
              <Field id="parent-password" label="비밀번호" type="password" value={password} onChange={setPassword} autoComplete="new-password" placeholder="10자 이상" />
              <Field id="parent-password-confirm" label="비밀번호 확인" type="password" value={passwordConfirm} onChange={setPasswordConfirm} autoComplete="new-password" placeholder="비밀번호 다시 입력" />
              <PrimaryButton pending={pending} onClick={activateAccount} label={selfService ? "계정 활성화하고 계속하기" : "계정 만들고 결제 페이지로 이동"} pendingLabel="계정 만드는 중…" submit />
            </form>
          )}

          {message && <p role={message.kind === "error" ? "alert" : "status"} aria-live={message.kind === "error" ? "assertive" : "polite"} className={`rounded-xl p-3 text-sm font-bold leading-6 ${message.kind === "error" ? "bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-200" : "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-200"}`}>{message.text}</p>}
          <p className="text-center text-xs leading-5 text-gray-500">링크가 만료되거나 계정이 잠기면 반복해서 시도하지 말고 학원에 문의해 주세요.</p>
        </div>
      </section>
    </main>
  );
}

function ProgressStep({ active, step, label }: { active: boolean; step: string; label: string }) {
  return <li className={active ? "text-brand-navy-900 dark:text-white" : "text-gray-400"}><span className={`mx-auto mb-1 flex size-7 items-center justify-center rounded-full ${active ? "bg-[var(--brand-accent)] text-[var(--brand-accent-contrast)]" : "bg-gray-100 dark:bg-gray-800"}`}>{step}</span>{label}</li>;
}

function Field({ id, label, type, value, onChange, autoComplete, placeholder }: { id: string; label: string; type: string; value: string; onChange: (value: string) => void; autoComplete: string; placeholder: string }) {
  return <div><label htmlFor={id} className="text-sm font-bold text-gray-800 dark:text-gray-100">{label}</label><input id={id} type={type} value={value} onChange={(event) => onChange(event.target.value)} autoComplete={autoComplete} placeholder={placeholder} required className="mt-2 min-h-12 w-full rounded-xl border border-gray-300 bg-white px-4 outline-none focus:border-[var(--brand-accent)] dark:border-gray-700 dark:bg-gray-800" /></div>;
}

function PrimaryButton({ pending, disabled = false, onClick, label, pendingLabel, submit = false }: { pending: boolean; disabled?: boolean; onClick: () => void; label: string; pendingLabel: string; submit?: boolean }) {
  return <button type={submit ? "submit" : "button"} disabled={pending || disabled} onClick={submit ? undefined : onClick} className="min-h-12 w-full rounded-xl bg-[var(--brand-accent)] px-4 font-black text-[var(--brand-accent-contrast)] disabled:cursor-not-allowed disabled:opacity-50">{pending ? pendingLabel : label}</button>;
}
