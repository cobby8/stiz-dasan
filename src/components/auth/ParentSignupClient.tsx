"use client";

import Link from "next/link";
import IdentityLinkButton, { type IdentitySignupHandoff } from "@/components/auth/IdentityLinkButton";
import { FormEvent, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { parentAuthEntryHref } from "@/lib/auth-entry-navigation";
import AppleLogo from "@/components/auth/AppleLogo";
import { useEnabledOAuthProviders } from "@/hooks/useEnabledOAuthProviders";
import { publicErrorText } from "@/components/ui/public-error-text";
import { safeInternalRedirect } from "@/lib/parent-oauth";
import { useStoreApp, STORE_APP_PASSWORD_LOGIN_NOTICE } from "@/hooks/useStoreApp";
import ParentConsentChecks, { type ParentPolicyTextsProp } from "@/components/auth/ParentConsentChecks";
import { PARENT_PASSWORD_MIN, parentPasswordWarning } from "@/lib/parent-password-rules";
// 모바일 본인인증 «리디렉션 복귀» 때 고른 역할·단계·next 를 되살린다(2026-11-18 4단계)
import { SIGNUP_IDENTITY_STATE_KEY, parseSignupIdentityState, serializeSignupIdentityState } from "@/lib/auth/signup-identity-resume";
import { SMS_FALLBACK_LINK_LABEL } from "@/lib/identity/sms-fallback-label";

// 로그인 전 본인인증 주소(아이디 가입·기존 계정 활성화). 간편가입은 IdentityLinkButton 기본 주소(parent-link)를 쓴다.
const ANON_IDENTITY_URLS = { startUrl: "/api/auth/parent-signup/identity/start", verifyUrl: "/api/auth/parent-signup/identity/verify" } as const;

// existing: 문자 인증 결과 학원에 이미 등록된 보호자(빈 계정)로 확인된 단계
type Step = "method" | "phone" | "account" | "existing" | "done";

type ApiData = {
  error?: string;
  challengeToken?: string;
  proof?: string;
  existingParent?: "ACTIVATE" | "LINKED" | "REGISTERED" | "CONTACT_ACADEMY";
  activationUrl?: string;
  redirectPath?: string;
  socialSessionMissing?: boolean;
  phoneRegistered?: boolean;
  registeredPhone?: boolean;
  // 가입 완료 직후 서버가 로그인까지 해 두었는가(아이디 가입, 2026-11-13 a7)
  sessionEstablished?: boolean;
};

/** 실패 응답의 추가 정보(간편가입 세션 끊김 등)를 화면이 알 수 있게 담아 던진다. */
class ApiError extends Error {
  data: ApiData;
  constructor(message: string, data: ApiData) {
    super(message);
    this.data = data;
  }
}

const inputClass =
  "min-h-12 w-full rounded-xl border border-gray-300 bg-white px-4 text-[var(--color-public-ink)] outline-none transition focus:border-[var(--color-public-accent)] focus:ring-2 focus:ring-[var(--color-public-accent)]/20 dark:border-[var(--color-public-line)] dark:bg-[var(--color-public-paper)] dark:text-white";

function friendlyError(value: unknown) {
  if (value instanceof Error && value.message) return value.message;
  return "잠시 문제가 생겼습니다. 입력 내용을 확인하고 다시 시도해 주세요.";
}

async function postJson(path: string, body: object) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as ApiData;
  if (!response.ok) throw new ApiError(data.error || "요청을 처리하지 못했습니다.", data);
  return data;
}

// 간편가입 표. 실제로 보이는 것은 Supabase 에서 켜진 것뿐이다(아래 visibleSignupOptions).
const SIGNUP_SOCIAL_OPTIONS = [
  { provider: "google", label: "Google로 계속" },
  { provider: "kakao", label: "카카오로 계속" },
  { provider: "naver", label: "네이버로 계속" },
  { provider: "apple", label: "Apple로 계속" },
] as const;

export default function ParentSignupClient({ policies }: { policies: ParentPolicyTextsProp }) {
  const searchParams = useSearchParams();
  // 스토어 앱에서는 간편가입을 숨긴다 — 앱 밖 브라우저로 나갔다가 돌아오지 못한다(a1). null = 아직 모름(그리지 않음)
  const storeApp = useStoreApp();
  // 비밀번호 입력 중 사전 경고(같은 숫자 반복·연속 숫자·qwer 류·전화번호) — 직원 초대 화면과 같은 규칙
  const [passwordDraft, setPasswordDraft] = useState("");
  // 경고는 입력 중이 아니라 입력칸을 벗어날 때·제출할 때 보인다(치는 도중 빨간 글씨가 깜빡이지 않게)
  const [passwordChecked, setPasswordChecked] = useState(false);
  // 훅이라 조건·조기 반환보다 앞에 둔다. 모르는 동안(null)은 간편가입 구역을 그리지 않는다.
  const enabledProviders = useEnabledOAuthProviders();
  const visibleSignupOptions = SIGNUP_SOCIAL_OPTIONS.filter((option) => enabledProviders?.includes(option.provider));
  const socialSignup = searchParams.get("social") === "1";
  // 앱의 간편로그인에서 넘어온 가입(브라우저 창 안) — 가입을 마치면 웹 화면으로 이어 가지 않고 «앱으로 돌아가기»를 안내한다(2026-11-17)
  const fromApp = searchParams.get("fromApp") === "1";
  // 카카오 연결 화면 등에서 "기존 학부모 계정 활성화"로 들어온 경우. 가입 방법 고르기를 건너뛰고 휴대폰 인증부터 한다.
  const existingMode = !socialSignup && searchParams.get("existing") === "1";
  // 리디렉션 복귀 때 되살린 값 — 주소에 값이 있으면 주소가 먼저다
  const [restoredNext, setRestoredNext] = useState("");
  const [restoredHandoff, setRestoredHandoff] = useState("");
  const enrollmentHandoff = searchParams.get("enrollmentHandoff") || restoredHandoff;
  const requestedNext = searchParams.get("next") || restoredNext || "/mypage";
  const initialName = searchParams.get("name") || "";
  const initialPhone = (searchParams.get("phone") || "").replace(/[^0-9]/g, "");
  const [step, setStep] = useState<Step>(socialSignup || existingMode ? "phone" : "method");
  const [phone, setPhone] = useState(initialPhone);
  const [otp, setOtp] = useState("");
  const [challengeToken, setChallengeToken] = useState("");
  const [proof, setProof] = useState("");
  const [loading, setLoading] = useState(false);
  // 주소의 ?error= 는 누구나 만들 수 있다 — 한국어 안내만 보여 주는 publicErrorText 를 거친다.
  const [error, setError] = useState<string | null>(() => {
    const raw = searchParams.get("error");
    return raw ? publicErrorText(new Error(raw), "간편로그인을 완료하지 못했습니다. 다시 시도해 주세요.") : null;
  });
  // 이미 가입된 번호 → 비밀번호를 잊었을 수 있으니 «아이디·비밀번호 찾기»를 함께 보여 준다.
  const [registeredPhone, setRegisteredPhone] = useState(false);
  const [socialSessionMissing, setSocialSessionMissing] = useState(false);
  // 간편로그인 + 이미 가입된 번호 → 본인인증으로 기존 계정에 연결(2026-10-26). 모바일은 인증창에서 돌아올 때 주소에 결과가 붙는다.
  const [phoneRegistered, setPhoneRegistered] = useState(socialSignup && searchParams.has("identityVerificationId"));
  const [activationUrl, setActivationUrl] = useState("");
  // 간편가입은 본인인증 하나로 확인한다(2026-11-17 원장 지시). 본인 명의 휴대폰이 아닌 분만 문자 인증 샛길을 연다.
  const [smsFallback, setSmsFallback] = useState(false);
  // 본인인증으로 확인된 이름 — 계정 정보 단계의 이름 칸에 미리 넣는다(고칠 수 있다)
  const [verifiedName, setVerifiedName] = useState("");
  // fromApp=1: 앱에서 가입 전에 간편로그인을 눌러 이 화면으로 넘어온 경우(2026-11-17 긴급). 왜 여기로 왔는지 먼저 알려 준다.
  const [notice, setNotice] = useState<string | null>(() => {
    if (searchParams.get("fromApp") !== "1") return null;
    // social=1 이 같이 오면 앱에서 한 카카오·구글 인증이 이어져 있다 — 휴대폰 인증만 남았다고 알려 준다.
    return socialSignup
      ? "간편로그인은 확인됐어요. 본인인증 한 번이면 끝납니다. 마치면 앱으로 자동으로 돌아가요."
      : "아직 가입 전이라 로그인이 되지 않았어요. 여기서 회원가입을 먼저 해 주세요. 가입을 마친 뒤 이 창을 닫고 앱에서 다시 로그인하시면 됩니다.";
  });
  // 가입할 때 고르는 역할(원장 결정 2026-10-25). 학부모는 바로 열리고, 선생님·기사님은
  // 가입을 마친 뒤 «역할 추가 신청» 화면에서 신청 → 원장 확인 후 열린다.
  // 고르기만 해서 직원 화면이 열리면 아무나 학생 개인정보를 보게 되므로 여기서는 신청 화면으로 안내만 한다.
  const [wantsParent, setWantsParent] = useState(true);
  const [staffRoles, setStaffRoles] = useState<Array<"INSTRUCTOR" | "DRIVER">>([]);
  // 직원 역할을 골랐고 따로 가려던 곳이 없으면, 가입 후 신청 화면으로 이어 간다.
  // 이 값은 간편가입(구글·Apple)으로 다른 사이트에 다녀와도 next 로 그대로 돌아온다.
  const next = staffRoles.length > 0 && requestedNext === "/mypage"
    ? `/mypage/roles?request=${staffRoles.join(",")}`
    : requestedNext;
  const noRoleChosen = !wantsParent && staffRoles.length === 0;
  const weakWarning = parentPasswordWarning(passwordDraft, { phone, minLength: PARENT_PASSWORD_MIN });
  function toggleStaffRole(role: "INSTRUCTOR" | "DRIVER") {
    setStaffRoles((current) => (current.includes(role) ? current.filter((value) => value !== role) : [...current, role]));
  }

  // 인증창을 열기 직전 — 모바일은 인증창에서 «리디렉션»으로 이 화면에 다시 들어오며 상태가 모두 사라진다
  function saveIdentityState() {
    window.sessionStorage.setItem(
      SIGNUP_IDENTITY_STATE_KEY,
      serializeSignupIdentityState({ wantsParent, staffRoles, next: requestedNext, enrollmentHandoff }, Date.now()),
    );
  }

  // PC 팝업으로 결과를 받았으면 리디렉션 대비로 저장한 상태는 지운다(검수 A-3)
  function clearIdentityState() {
    window.sessionStorage.removeItem(SIGNUP_IDENTITY_STATE_KEY);
  }

  // 리디렉션 복귀(주소에 identityVerificationId): 저장해 둔 단계·역할·next·수강신청서 표를 되살린다.
  // 단계가 «phone» 이 되면 그 안의 본인인증 버튼이 주소의 결과를 받아 확인을 이어 간다(버튼 쪽이 이 탭에서 시작한 건만 처리).
  useEffect(() => {
    // 인증 취소로 돌아오면 주소에 code 만 붙을 수 있다 — 그때는 저장값이 있을 때만 되살린다(다른 code 와 섞이지 않게)
    const returned = searchParams.has("identityVerificationId");
    if (!returned && !searchParams.has("code")) return;
    let raw: string | null = null;
    try {
      raw = window.sessionStorage.getItem(SIGNUP_IDENTITY_STATE_KEY);
      window.sessionStorage.removeItem(SIGNUP_IDENTITY_STATE_KEY);
    } catch {
      // 저장소가 막힌 환경 — 아래에서 주소만으로 판단한다
    }
    const saved = parseSignupIdentityState(raw, Date.now());
    if (!returned && !saved) return;
    if (saved) {
      setWantsParent(saved.wantsParent);
      setStaffRoles(saved.staffRoles);
      setRestoredNext(saved.next);
      setRestoredHandoff(saved.enrollmentHandoff);
    }
    // 저장값이 없어도 인증 결과를 받을 버튼은 있어야 한다(역할은 기본값 학부모)
    setStep("phone");
    // 처음 한 번만 — 주소의 인증 결과는 버튼이 읽고 지운다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * 가입이 끝났을 때. 앱에서 넘어온 간편가입이면 이 창에 머무르지 않고 앱으로 돌아가 로그인까지 끝낸다
   * (/auth/native/resume 이 살려 둔 앱 로그인 요청을 마무리한다. 시간이 지났으면 그 화면이 «앱에서 다시 로그인» 안내를 띄운다).
   */
  function finishSignup() {
    // 앱에서 넘어온 간편가입은 완료 화면의 «앱으로 돌아가기» 버튼이 /auth/native/resume 으로 보낸다(아래 done 단계).
    // 스크립트로 자동 이동하지 않는다 — 누름 없이 앱을 여는 이동은 브라우저가 막을 수 있고, 막히면 창이 그대로 남는다.
    setStep("done");
  }

  /** 본인인증 결과가 «가입 이어가기»일 때 — 문자 인증을 통과했을 때와 같은 다음 단계로 간다. */
  function continueFromIdentity(data: IdentitySignupHandoff) {
    setError(null);
    setRegisteredPhone(false);
    if (data.existingParent === "LINKED") {
      if (fromApp) { finishSignup(); return; }
      window.location.assign(data.redirectPath || "/mypage");
      return;
    }
    if (data.existingParent === "ACTIVATE" && data.activationUrl) {
      setActivationUrl(data.activationUrl);
      setStep("existing");
      return;
    }
    if (!data.challengeToken || !data.proof) {
      setError("본인인증 결과를 확인하지 못했어요. 다시 시도해 주세요.");
      return;
    }
    setChallengeToken(data.challengeToken);
    setProof(data.proof);
    setVerifiedName(data.verifiedName || "");
    // 인증된 본인 번호 — «전화번호를 비밀번호로» 경고가 본인인증 경로에서도 뜨게(검수 A-2)
    if (data.verifiedPhone) setPhone(data.verifiedPhone.replace(/[^0-9]/g, ""));
    if (existingMode) setNotice("학원에 등록된 보호자 정보를 찾지 못해 새 계정 만들기로 이어 갑니다. 이미 다니고 있다면 학원에 알려 둔 번호인지 확인해 주세요.");
    setStep("account");
  }

  async function startPhoneVerification(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const data = await postJson("/api/auth/parent-signup/start", { phone, social: socialSignup });
      if (!data.challengeToken) throw new Error("인증 요청을 다시 시도해 주세요.");
      setChallengeToken(data.challengeToken);
      setStep("phone");
    } catch (reason) {
      setError(friendlyError(reason));
      setSocialSessionMissing(reason instanceof ApiError && Boolean(reason.data.socialSessionMissing));
      setPhoneRegistered(socialSignup && reason instanceof ApiError && Boolean(reason.data.phoneRegistered));
      setRegisteredPhone(reason instanceof ApiError && Boolean(reason.data.registeredPhone));
    } finally {
      setLoading(false);
    }
  }

  async function verifyPhone(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const data = await postJson("/api/auth/parent-signup/verify-otp", {
        challengeToken,
        otp,
        next,
      });
      // 학원에 이미 등록된 보호자: 간편로그인 계정이 바로 연결됐으면 원래 가려던 화면으로 간다.
      if (data.existingParent === "LINKED") {
        // 앱에서 넘어온 경우는 이 브라우저 창에서 웹을 이어 쓰지 않게 완료 화면의 «앱으로 돌아가기» 안내로(2026-11-17 검수 반영)
        if (fromApp) { finishSignup(); return; }
        // 서버가 검증한 경로만 쓴다(주소창의 next 를 그대로 믿지 않는다)
        window.location.assign(data.redirectPath || "/mypage");
        return;
      }
      // 학원에 이미 등록된 보호자: 문자 인증은 끝났으니 아이디·비밀번호만 정하는 활성화 화면으로 안내한다.
      if (data.existingParent === "ACTIVATE" && data.activationUrl) {
        setActivationUrl(data.activationUrl);
        setStep("existing");
        return;
      }
      if (!data.proof) throw new Error("인증번호 확인을 다시 시도해 주세요.");
      setProof(data.proof);
      if (existingMode) setNotice("학원에 등록된 보호자 정보를 찾지 못해 새 계정 만들기로 이어 갑니다. 이미 다니고 있다면 학원에 알려 둔 번호인지 확인해 주세요.");
      setStep("account");
    } catch (reason) {
      setError(friendlyError(reason));
    } finally {
      setLoading(false);
    }
  }

  async function completeSignup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") || "");
    if (!socialSignup && weakWarning) {
      setPasswordChecked(true);
      setError(weakWarning);
      return;
    }
    if (password !== String(form.get("passwordConfirm") || "")) {
      setError("비밀번호가 서로 다릅니다.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await postJson("/api/auth/parent-signup/complete", {
        challengeToken,
        proof,
        enrollmentHandoff: enrollmentHandoff || undefined,
        next,
        username: String(form.get("username") || "").trim(),
        ...(socialSignup ? {} : { password }),
        name: String(form.get("name") || "").trim(),
        consents: {
          terms: form.get("terms") === "on",
          privacy: form.get("privacy") === "on",
          age: form.get("age") === "on",
        },
      });
      // 서버가 바로 로그인까지 해 두었으면 «로그인하기» 없이 가려던 화면(마이페이지 등)으로 간다.
      // 로그인을 못 했으면 지금처럼 완료 화면에서 로그인 안내(폴백).
      // 단, 앱에서 넘어온 경우는 이 브라우저 창에서 웹을 이어 쓰지 않게 완료 화면에서 «앱으로 돌아가기»를 안내한다.
      if (data.sessionEstablished && !fromApp) {
        window.location.assign(safeInternalRedirect(next));
        return;
      }
      finishSignup();
    } catch (reason) {
      setError(friendlyError(reason));
    } finally {
      setLoading(false);
    }
  }

  const progress = step === "method" ? 1 : step === "phone" ? 2 : step === "account" || step === "existing" ? 3 : 4;
  const continueParams = new URLSearchParams({ next });
  if (enrollmentHandoff) continueParams.set("enrollmentHandoff", enrollmentHandoff);
  if (initialName) continueParams.set("name", initialName);
  if (initialPhone) continueParams.set("phone", initialPhone);

  return (
    <div className="space-y-6">
      {step !== "done" && (
        <div aria-label={`가입 ${progress}/3단계`} className="flex gap-2">
          {[1, 2, 3].map((number) => (
            <span key={number} className={`h-1.5 flex-1 rounded-full ${number <= progress ? "bg-brand-orange-500 dark:bg-brand-neon-lime" : "bg-[var(--color-public-line)] dark:bg-[var(--color-public-line)]"}`} />
          ))}
        </div>
      )}

      {error && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {/* 간편가입 세션이 끊긴 경우(카카오톡 안 브라우저에서 잦다) — 휴대폰 인증 방식으로 바로 이어 간다 */}
      {socialSignup && socialSessionMissing && (
        <a href={parentAuthEntryHref("signup", searchParams, { existing: true })} className="flex min-h-12 w-full items-center justify-center rounded-xl border border-[var(--color-public-accent)] px-4 text-sm font-medium text-[var(--color-public-accent)]">
          아이디·휴대폰 인증으로 계속
        </a>
      )}
      {/* 문자 인증 샛길에서 «이미 가입된 번호»로 막힌 경우에만 여기서 본인인증 버튼을 다시 보여 준다 */}
      {socialSignup && smsFallback && phoneRegistered && <IdentityLinkButton onSignup={continueFromIdentity} next={next} />}
      {/* 문자 인증 샛길에서 이미 가입된 번호 — 본인인증 쪽은 버튼 바로 아래에 같은 링크를 둔다(검수 A-5) */}
      {registeredPhone && smsFallback && (
        <Link href="/login/forgot" className="flex min-h-12 w-full items-center justify-center rounded-xl border border-[var(--color-public-accent)] px-4 text-sm font-medium text-[var(--color-public-accent)]">
          아이디·비밀번호 찾기
        </Link>
      )}
      {notice && <p role="status" className="rounded-xl bg-[var(--color-public-tint)] px-3 py-2 text-xs leading-5 text-[var(--color-public-ink)]">{notice}</p>}

      {step === "method" && (
        <>
          <div>
            <h2 className="text-xl font-bold text-[var(--color-public-ink)] dark:text-white">회원가입</h2>
            <p className="mt-1 text-sm text-[var(--color-public-muted)] dark:text-[var(--color-public-muted)]">어떤 일로 이용하시나요? 여러 개 고를 수 있어요.</p>
          </div>
          <div className="grid grid-cols-3 gap-2" role="group" aria-label="이용 역할">
            {[
              { key: "PARENT", label: "학부모", on: wantsParent, toggle: () => setWantsParent((value) => !value) },
              { key: "INSTRUCTOR", label: "선생님", on: staffRoles.includes("INSTRUCTOR"), toggle: () => toggleStaffRole("INSTRUCTOR") },
              { key: "DRIVER", label: "기사님", on: staffRoles.includes("DRIVER"), toggle: () => toggleStaffRole("DRIVER") },
            ].map((option) => (
              <button
                key={option.key}
                type="button"
                aria-pressed={option.on}
                onClick={option.toggle}
                className={`flex min-h-12 items-center justify-center rounded-xl border text-sm font-medium transition ${option.on ? "border-[var(--color-public-accent)] bg-[var(--color-public-tint)] text-[var(--color-public-strong)] dark:border-brand-neon-lime dark:bg-brand-neon-lime/10 dark:text-brand-neon-lime" : "border-gray-300 text-[var(--color-public-muted)] dark:border-[var(--color-public-line)] dark:text-[var(--color-public-muted)]"}`}
              >
                {option.label}
              </button>
            ))}
          </div>
          {staffRoles.length > 0 && (
            <p className="rounded-xl bg-[var(--color-academy-warning-soft)] px-3 py-2 text-xs leading-5 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              선생님·기사님 화면은 학생 정보를 보게 되어 <b>원장님 확인 후</b> 열립니다. 가입을 마치면 신청 화면으로 이어집니다.
            </p>
          )}
          <button type="button" onClick={() => setStep("phone")} disabled={noRoleChosen} className="flex min-h-12 w-full items-center justify-center rounded-xl bg-[var(--color-public-accent)] px-4 font-bold text-white hover:bg-[var(--color-public-strong)] disabled:opacity-40 dark:bg-brand-neon-lime dark:text-brand-navy-900">
            아이디로 가입하기
          </button>
          {/* Supabase 에서 켜진 간편가입만 보인다 — 꺼진 버튼은 누르면 Supabase 오류 화면이 떴다(2026-10-25). */}
          {/* 스토어 앱: 간편가입 대신 한 줄 안내(앱 밖으로 나가 돌아오지 못한다) */}
          {storeApp === true && !noRoleChosen && (
            <p className="text-center text-xs leading-5 text-[var(--color-public-muted)]">{STORE_APP_PASSWORD_LOGIN_NOTICE}</p>
          )}
          {storeApp === false && visibleSignupOptions.length > 0 && !noRoleChosen && (
            <>
              <div className="flex items-center gap-3 text-xs text-[var(--color-public-muted)]"><span className="h-px flex-1 bg-[var(--color-public-line)]" />간편가입<span className="h-px flex-1 bg-[var(--color-public-line)]" /></div>
              <div className="grid gap-3">
                {/* <Link> 금지 — 미리 불러오기가 로그인 열쇠(PKCE)를 덮어써 간편가입이 「만료」로 실패한다(login/page.tsx 와 같음). */}
                {visibleSignupOptions.map((option) => (
                  <a
                    key={option.provider}
                    href={`/auth/oauth/${option.provider}?intent=parent-signup&${continueParams.toString()}`}
                    className="flex min-h-12 items-center justify-center gap-2 rounded-xl border border-gray-300 bg-white px-4 text-sm font-medium text-[var(--color-public-ink)]"
                  >
                    {/* 흰색 테두리 버튼은 애플 가이드라인의 「White Outline」 스타일과 맞는다 */}
                    {option.provider === "apple" && <AppleLogo />}
                    {option.label}
                  </a>
                ))}
              </div>
              <p className="text-center text-xs leading-5 text-[var(--color-public-muted)]">간편가입도 처음 한 번은 안전한 계정 연결을 위해 휴대폰 인증이 필요합니다.</p>
            </>
          )}
        </>
      )}

      {/* 본인인증이 기본(간편가입 2026-11-17, 아이디 가입·기존 계정 활성화 2026-11-18 4단계). 번호를 따로 묻지 않는다 — 본인인증이 번호·이름을 한 번에 확인한다.
          기존 계정이 있으면 안내(간편가입은 그 계정에 연결), 학원에 등록된 보호자면 활성화로, 처음이면 새 계정으로 서버가 갈라 준다.
          본인 명의 휴대폰이 아닌 분만 문자 인증 샛길을 연다. */}
      {step === "phone" && !challengeToken && !smsFallback && (
        <div className="space-y-4">
          <div>
            <h2 className="text-xl font-bold">{existingMode ? "기존 학부모 계정 활성화" : "본인 확인"}</h2>
            <p className="mt-1 text-sm text-[var(--color-public-muted)] dark:text-[var(--color-public-muted)]">
              {existingMode
                ? "학원에 알려 주신 보호자 휴대폰의 명의로 본인인증하면, 등록된 계정을 바로 쓸 수 있게 이어 드려요."
                : "본인 명의 휴대폰으로 한 번만 인증하면 됩니다. 이미 학원에 다니는 학부모님은 기존 정보가 그대로 연결돼요."}
            </p>
          </div>
          {initialPhone && !socialSignup && (
            <p className="rounded-xl bg-[var(--color-public-tint)] px-3 py-2 text-xs leading-5 text-[var(--color-public-ink)]">
              수강신청서에 적은 보호자 번호의 명의로 인증해야 신청서가 계정에 연결됩니다.
            </p>
          )}
          <IdentityLinkButton
            onSignup={continueFromIdentity}
            // 이미 가입된 번호면 화면이 문구가 아니라 표식으로 «아이디·비밀번호 찾기»를 띄운다
            onFailure={(data) => setRegisteredPhone(Boolean(data.registeredPhone))}
            beforeStart={saveIdentityState}
            afterPopup={clearIdentityState}
            next={next}
            {...(socialSignup ? {} : ANON_IDENTITY_URLS)}
            label="본인인증하고 계속"
            hint="PASS·카카오·토스 등으로 인증합니다. 휴대폰 번호는 인증 화면에서 한 번만 입력해요."
          />
          {/* 이미 가입된 번호 — 본인인증 버튼 바로 아래에(검수 A-5) */}
          {registeredPhone && (
            <Link href="/login/forgot" className="flex min-h-12 w-full items-center justify-center rounded-xl border border-[var(--color-public-accent)] px-4 text-sm font-medium text-[var(--color-public-accent)]">
              아이디·비밀번호 찾기
            </Link>
          )}
          <button type="button" onClick={() => { setSmsFallback(true); setError(null); setRegisteredPhone(false); }} className="min-h-11 w-full text-sm text-[var(--color-public-muted)] underline">
            {SMS_FALLBACK_LINK_LABEL}
          </button>
        </div>
      )}

      {step === "phone" && !challengeToken && smsFallback && (
        <form onSubmit={startPhoneVerification} className="space-y-4">
          {existingMode ? (
            <div><h2 className="text-xl font-bold">기존 학부모 계정 활성화</h2><p className="mt-1 text-sm text-[var(--color-public-muted)] dark:text-[var(--color-public-muted)]">학원에 알려 주신 보호자 휴대폰 번호를 입력해 주세요. 문자 인증이 끝나면 등록된 계정을 바로 쓸 수 있게 이어 드려요.</p></div>
          ) : (
            <div><h2 className="text-xl font-bold">휴대폰 인증</h2><p className="mt-1 text-sm text-[var(--color-public-muted)] dark:text-[var(--color-public-muted)]">본인 명의로 사용하는 번호를 입력해 주세요.</p></div>
          )}
          {/* 어떤 번호든 같은 문구 — 등록 여부는 문자 인증을 통과한 뒤에만 알려 준다 */}
          <p className="text-xs leading-5 text-[var(--color-public-muted)]">이미 학원에 다니는 학부모님도 학원에 알려 준 번호로 인증하면 기존 정보가 그대로 연결돼요.</p>
          <label className="block text-sm font-semibold">휴대폰 번호<input className={`${inputClass} mt-2`} type="tel" value={phone} onChange={(event) => setPhone(event.target.value.replace(/[^0-9]/g, ""))} inputMode="numeric" autoComplete="tel" placeholder="01012345678" minLength={10} maxLength={11} required /></label>
          {initialPhone && (
            <p className="rounded-xl bg-[var(--color-public-tint)] px-3 py-2 text-xs leading-5 text-[var(--color-public-ink)]">
              수강신청서의 보호자 번호를 불러왔습니다. 이 번호로 본인 인증해야 신청서가 계정에 연결됩니다.
            </p>
          )}
          <button disabled={loading} className="min-h-12 w-full rounded-xl bg-brand-orange-500 font-bold text-white disabled:opacity-50">{loading ? "보내는 중..." : "인증번호 받기"}</button>
          <button type="button" onClick={() => { setSmsFallback(false); setError(null); setRegisteredPhone(false); }} className="min-h-11 w-full text-sm text-[var(--color-public-muted)] underline">
            본인인증으로 돌아가기
          </button>
        </form>
      )}

      {step === "phone" && challengeToken && (
        <form onSubmit={verifyPhone} className="space-y-4">
          <div><h2 className="text-xl font-bold">인증번호 입력</h2><p className="mt-1 text-sm text-[var(--color-public-muted)] dark:text-[var(--color-public-muted)]">{phone}로 보낸 6자리 번호를 입력해 주세요.</p></div>
          <label className="block text-sm font-semibold">인증번호<input className={`${inputClass} mt-2 text-center text-xl tracking-[0.4em]`} value={otp} onChange={(event) => setOtp(event.target.value.replace(/[^0-9]/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" required /></label>
          <button disabled={loading || otp.length !== 6} className="min-h-12 w-full rounded-xl bg-brand-orange-500 font-bold text-white disabled:opacity-50">{loading ? "확인 중..." : "인증 완료"}</button>
          <button type="button" onClick={() => { setChallengeToken(""); setOtp(""); setError(null); }} className="w-full text-sm text-[var(--color-public-muted)] underline">번호 다시 입력하기</button>
        </form>
      )}

      {step === "account" && (
        <form onSubmit={completeSignup} className="space-y-4">
          <div><h2 className="text-xl font-bold">계정 정보</h2><p className="mt-1 text-sm text-[var(--color-public-muted)] dark:text-[var(--color-public-muted)]">로그인에 사용할 정보만 입력하면 끝입니다.</p></div>
          {/* 2026-11-18 원장 결정: 이 칸은 «닉네임»(화면에 보이는 이름·나중에 고칠 수 있음). 본인인증 실명은 서버가 따로 보관해 결제창 이름에 쓴다 */}
          <div>
            <label className="block text-sm font-semibold">닉네임<input name="name" defaultValue={verifiedName || initialName} className={`${inputClass} mt-2`} autoComplete="nickname" required /></label>
            <p className="mt-1 text-xs text-[var(--color-public-muted)]">학원 앱에서 보이는 이름이에요. 본인인증 실명은 따로 보관돼요.</p>
          </div>
          <label className="block text-sm font-semibold">로그인 아이디<input name="username" className={`${inputClass} mt-2`} autoComplete="username" minLength={4} maxLength={20} pattern="[A-Za-z][A-Za-z0-9_]{3,19}" placeholder="영문으로 시작, 영문·숫자·밑줄" required /></label>
          {!socialSignup && <label className="block text-sm font-semibold">비밀번호<input name="password" type="password" value={passwordDraft} onChange={(event) => { setPasswordDraft(event.target.value); setPasswordChecked(false); }} onBlur={() => setPasswordChecked(true)} className={`${inputClass} mt-2`} autoComplete="new-password" minLength={8} placeholder="8자 이상, 숫자·영문 섞어서" required /></label>}
          {/* 옅은 바탕 + 진한 글자 — 다크 모드에서도 대비가 유지된다 */}
          {!socialSignup && passwordChecked && weakWarning && <p role="alert" className="-mt-2 rounded-lg bg-[var(--color-academy-danger-soft)] px-3 py-2 text-xs font-semibold text-[var(--color-academy-danger)]">{weakWarning}</p>}
          {!socialSignup && <label className="block text-sm font-semibold">비밀번호 확인<input name="passwordConfirm" type="password" className={`${inputClass} mt-2`} autoComplete="new-password" minLength={8} required /></label>}
          {/* 필수 동의 3개 — 약관은 새 탭이 아니라 같은 화면 안의 창으로 본다(앱에서 밖으로 나가지 않게, a5) */}
          <ParentConsentChecks policies={policies} />
          <button disabled={loading} className="min-h-12 w-full rounded-xl bg-brand-orange-500 font-bold text-white disabled:opacity-50">{loading ? "가입하는 중..." : "가입 완료"}</button>
        </form>
      )}

      {step === "existing" && (
        <div className="space-y-4 py-2 text-center">
          <h2 className="text-xl font-bold">이미 학원에 등록된 보호자입니다</h2>
          <p className="text-sm leading-6 text-[var(--color-public-muted)] dark:text-[var(--color-public-muted)]">인증이 끝났어요. 로그인에 쓸 아이디와 비밀번호만 정하면 바로 쓸 수 있어요. 자녀 정보는 학원에 등록된 그대로 연결됩니다.</p>
          <button type="button" onClick={() => window.location.assign(activationUrl)} className="min-h-12 w-full rounded-xl bg-brand-orange-500 font-bold text-white">
            비밀번호 정하러 가기
          </button>
          <p className="text-xs leading-5 text-[var(--color-public-muted)]">10분 안에 마쳐 주세요. 시간이 지나면 휴대폰 인증부터 다시 하면 됩니다.</p>
        </div>
      )}

      {step === "done" && (
        <div className="py-6 text-center">
          <h2 className="text-xl font-bold">가입이 완료됐습니다</h2>
          <p className="mt-2 text-sm text-[var(--color-public-muted)]">
            {socialSignup
              ? (enrollmentHandoff ? "수강신청서가 계정에 연결되었습니다." : "간편로그인으로 바로 이용할 수 있어요.")
              : (enrollmentHandoff ? "수강신청서가 계정에 연결되었습니다. 로그인해서 확인해주세요." : "이제 만든 아이디로 로그인해 주세요.")}
          </p>
          {/* 앱에서 넘어온 가입: 앱으로 여는 버튼은 두지 않는다 — 진행 중인 앱 로그인 요청 없이 앱 주소를 열면
              앱이 «요청을 확인하지 못했습니다»로 막는다. 창을 닫으면 앱이 알아서 정리한다(앱 1.0.6). */}
          {fromApp && socialSignup ? (
            <div className="mt-6">
              {/* <Link> 금지 — 미리 불러오기가 1회용 복귀 요청을 써 버린다. 사용자가 직접 누르는 평범한 링크여야 앱이 열린다. */}
              <a href="/auth/native/resume" className="flex min-h-12 items-center justify-center rounded-xl bg-[var(--color-public-accent)] font-bold text-white hover:bg-[var(--color-public-strong)]">앱으로 돌아가기</a>
              <p className="mt-3 text-xs leading-5 text-[var(--color-public-muted)]">누르면 앱이 열리며 로그인됩니다. 열리지 않으면 이 창을 닫고 앱에서 다시 로그인해 주세요.</p>
            </div>
          ) : fromApp ? (
            <div role="status" className="mt-6 rounded-xl border border-[var(--color-public-accent)] px-4 py-4 text-left text-sm leading-relaxed">
              <p className="font-semibold">이제 앱으로 돌아가 주세요</p>
              <ol className="mt-2 list-decimal space-y-1 pl-5">
                <li>이 창 왼쪽 위의 <b className="font-semibold">×</b>(아이폰은 «취소»)를 눌러 창을 닫습니다.</li>
                <li>앱 로그인 화면에서 {socialSignup ? "방금 쓰신 간편로그인 버튼으로" : "만드신 아이디로"} 다시 로그인합니다.</li>
              </ol>
            </div>
          ) : socialSignup ? (
            <a href={safeInternalRedirect(next)} className="mt-6 flex min-h-12 items-center justify-center rounded-xl bg-[var(--color-public-accent)] font-bold text-white hover:bg-[var(--color-public-strong)]">시작하기</a>
          ) : (
            <Link href={`/login?${new URLSearchParams({ redirect: next }).toString()}`} className="mt-6 flex min-h-12 items-center justify-center rounded-xl bg-brand-orange-500 font-bold text-white">로그인하기</Link>
          )}
        </div>
      )}
    </div>
  );
}
