"use client";

import { publicErrorText } from "@/components/ui/public-error-text";
import { Suspense, useState } from "react";
import { login, signup } from "@/app/actions/auth";
import Image from "next/image";
import Link from "next/link";
import PublicSiteTheme from "@/components/PublicSiteTheme";
import { usePathname, useSearchParams } from "next/navigation";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { parentAuthEntryHref } from "@/lib/auth-entry-navigation";
import AppleLogo from "@/components/auth/AppleLogo";
import { useOAuthAvailability } from "@/hooks/useEnabledOAuthProviders";
import { useStoreApp, STORE_APP_PASSWORD_LOGIN_NOTICE } from "@/hooks/useStoreApp";
import { storeAppSocialLogin, storeAppSocialLoginHref } from "@/lib/storeApp";

function LoginContent() {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const isStaffMode =
    pathname === "/staff/login" || searchParams.get("mode") === "staff";
  const socialLoginParams = new URLSearchParams();
  const redirect = searchParams.get("redirect");
  const handoff = searchParams.get("handoff") || searchParams.get("enrollmentHandoff");
  socialLoginParams.set("intent", "login");
  if (redirect) socialLoginParams.set("next", redirect);
  if (handoff) socialLoginParams.set("enrollmentHandoff", handoff);
  const socialLoginQuery = socialLoginParams.toString();
  const parentSocialLoginOptions = [
    { provider: "google", label: "Google로 로그인", tone: "border-gray-300 bg-white text-[var(--color-public-ink)] hover:bg-[var(--color-public-tint)] dark:border-[var(--color-public-line)] dark:bg-[var(--color-public-paper)] dark:text-white dark:hover:bg-[var(--color-public-paper)]" },
    { provider: "kakao", label: "카카오로 로그인", tone: "border-[#FEE500] bg-[#FEE500] text-[#191919] hover:bg-[#f7dc00]" },
    { provider: "naver", label: "네이버로 로그인", tone: "border-[#03C75A] bg-[#03C75A] text-white hover:bg-[#02b350]" },
    // Apple 은 앱스토어 등록의 필수 요건(심사지침 4.8). 애플 가이드라인대로 로고가 붙은 검정 버튼.
    { provider: "apple", label: "Apple로 로그인", tone: "border-black bg-black text-white hover:bg-[var(--color-public-dark)] dark:border-white dark:bg-white dark:text-black dark:hover:bg-gray-100" },
  ];
  // 표에 있어도 Supabase 에서 켜진 것만 보인다. 꺼진 버튼을 누르면 Supabase 의 JSON 오류 화면이
  // 그대로 떴다(2026-10-25 운영: 구글·카카오). 모르는 동안(null)은 아무것도 그리지 않는다.
  const oauthAvailability = useOAuthAvailability();
  const enabledProviders = oauthAvailability?.providers ?? null;
  // 스토어 앱 여부. null = 아직 모름
  const storeApp = useStoreApp();
  const visibleSocialLoginOptions = parentSocialLoginOptions.filter((option) =>
    enabledProviders?.includes(option.provider as (typeof enabledProviders)[number]),
  );
  // 스토어 앱의 간편로그인(a1, 2026-11-13): 앱이 시스템 브라우저 로그인 기능을 갖췄고(사용자 에이전트 표식)
  // 서버 스위치가 켜졌을 때만 버튼을 보인다. 아니면 버튼을 숨기고 아이디·비밀번호 + 문자 인증 비밀번호 만들기로 안내.
  // storeApp === true 일 때만 계산한다(브라우저 전용 navigator 를 서버 그림에서 읽지 않게).
  const appSocialLogin =
    storeApp === true
      ? storeAppSocialLogin({
          userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent,
          nativeApp: oauthAvailability?.nativeApp,
          providers: enabledProviders === null ? null : visibleSocialLoginOptions.map((option) => option.provider),
        })
      : null;
  const [mode, setMode] = useState<"login" | "signup">("login");
  // 주소창 ?error= 값은 누구나 바꿀 수 있어 한국어 안내만 보여 준다(영어·개발 원문은 쉬운 안내로)
  const [error, setError] = useState<string | null>(searchParams.get("error") ? publicErrorText(searchParams.get("error"), "로그인하지 못했습니다. 다시 시도해 주세요.") : null);
  const [loading, setLoading] = useState(false);
  // 비밀번호 보기/숨기기 토글 상태
  const [showPassword, setShowPassword] = useState(false);
  // 개인정보보호법 준수: 회원가입 시 동의 체크박스 상태
  const [agreePrivacy, setAgreePrivacy] = useState(false);
  const [agreeTerms, setAgreeTerms] = useState(false);

  async function handleSubmit(formData: FormData) {
    setError(null);
    setLoading(true);

    const requestedPath =
      new URLSearchParams(window.location.search).get("redirect") ||
      (isStaffMode ? "/staff" : null);
    if (requestedPath?.startsWith("/") && !requestedPath.startsWith("//")) {
      formData.set("redirectTo", requestedPath);
    }
    const searchParams = new URLSearchParams(window.location.search);
    const handoff = searchParams.get("handoff") || searchParams.get("enrollmentHandoff");
    if (handoff) formData.set("enrollmentHandoff", handoff);

    try {
      const action = mode === "login" ? login : signup;
      const result = await action(formData);
      if (result?.error) {
        setError(result.error);
      }
      setLoading(false);
    } catch (err) {
      if (isRedirectError(err)) {
        throw err;
      }
      console.error("[login] 처리 실패", err);
      setError(publicErrorText(err, "처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요."));
      setLoading(false);
    }
  }

  return (
    // surface-warm 배경 — 공개 페이지와 동일한 따뜻한 톤
    <div className="min-h-screen bg-surface-warm dark:bg-[var(--color-public-paper)] flex items-center justify-center px-4 relative overflow-hidden">
      {/* 배경 장식 도형 — 공개 페이지 히어로 패턴과 통일된 반투명 원형 */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute right-0 top-0 w-96 h-96 border-[30px] border-[var(--color-public-dark)]/5 rounded-full translate-x-1/3 -translate-y-1/3" />
        <div className="absolute left-0 bottom-0 w-64 h-64 border-[20px] border-[var(--color-public-accent)] dark:border-brand-neon-lime/5 rounded-full -translate-x-1/4 translate-y-1/4" />
        <div className="absolute right-1/4 bottom-1/4 w-32 h-32 border-[10px] border-[var(--color-public-accent)] dark:border-brand-neon-lime/5 rounded-full" />
      </div>

      <div className="w-full max-w-md relative z-10">
        {/* 로고 & 타이틀 — STIZ 실제 로고 사용 + 용도 명확화 */}
        <div className="text-center mb-8">
          <div className="flex justify-center mb-4">
            <Image
              src="/stiz-logo.png"
              alt="STIZ 농구교실"
              width={160}
              height={40}
              className="h-10 w-auto object-contain"
            />
          </div>
          <h1 className="text-2xl font-bold text-[var(--color-public-ink)] dark:text-white">
            {isStaffMode ? "STIZ 관리자/선생님 로그인" : "STIZ 로그인"}
          </h1>
          <p className="text-[var(--color-public-ink)] dark:text-[var(--color-public-muted)] mt-1">
            {isStaffMode
              ? "가입한 휴대폰 번호(또는 이메일)로 로그인해 주세요."
              : "계정 권한에 맞는 화면으로 이동합니다"}
          </p>
        </div>

        {/* 카드 — 기존 구조 유지, 디자인 토큰 적용 */}
        <div className="bg-white dark:bg-[var(--color-public-tint)] text-[var(--color-public-ink)] dark:text-white rounded-2xl shadow-sm border border-[var(--color-public-line)] dark:border-[var(--color-public-line)] p-8">
          {/* 탭 — 기존 구조 유지 */}
          {!isStaffMode && <div className="flex mb-6 bg-[var(--color-public-tint)] dark:bg-[var(--color-public-paper)] rounded-lg p-1">
            <button
              type="button"
              onClick={() => {
                setMode("login");
                setError(null);
                setShowPassword(false); // 모드 전환 시 비밀번호 숨김으로 초기화
                setAgreePrivacy(false); // 동의 체크박스 초기화
                setAgreeTerms(false);
              }}
              className={`flex-1 py-2 text-sm font-medium rounded-md transition-colors ${
                mode === "login"
                  ? "bg-white text-[var(--color-public-ink)] dark:bg-brand-neon-lime dark:text-brand-navy-900 shadow-sm"
                  : "text-[var(--color-public-muted)] hover:text-[var(--color-public-muted)] dark:text-[var(--color-public-muted)] dark:hover:text-white"
              }`}
            >
              로그인
            </button>
            <button
              type="button"
              onClick={() => {
                window.location.href = parentAuthEntryHref("signup", searchParams);
              }}
              className={`flex-1 py-2 text-sm font-medium rounded-md transition-colors ${
                mode === "signup"
                  ? "bg-white text-[var(--color-public-ink)] dark:bg-brand-neon-lime dark:text-brand-navy-900 shadow-sm"
                  : "text-[var(--color-public-muted)] hover:text-[var(--color-public-muted)] dark:text-[var(--color-public-muted)] dark:hover:text-white"
              }`}
            >
              계정 만들기
            </button>
          </div>}

          {isStaffMode && (
            <div className="mb-6 rounded-xl border border-[var(--color-public-line)] bg-orange-50 p-4 text-sm text-[var(--color-public-ink)] dark:border-brand-neon-lime/30 dark:bg-brand-neon-lime/10 dark:text-[var(--color-public-ink)]">
              <div className="flex items-start gap-3">
                <div>
                  <p className="font-bold">처음 이용하시나요?</p>
                  <p className="mt-1 leading-6">원장님이 보내드린 <strong>개인 초대 링크</strong>에서 먼저 가입해 주세요. 이 화면에서는 관리자·선생님 계정을 새로 만들 수 없습니다.</p>
                </div>
              </div>
              <Link
                href="/about"
                className="mt-3 flex min-h-11 w-full items-center justify-center gap-1 rounded-lg border border-[var(--color-public-line)] bg-white px-3 font-medium text-[var(--color-public-ink)] dark:border-[var(--color-public-line)] dark:bg-[var(--color-public-paper)] dark:text-white"
              >
                초대 링크가 없다면 학원에 문의하기
              </Link>
            </div>
          )}

          {/* 에러 메시지 */}
          {error && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
              {error}
            </div>
          )}

          {/* 폼 — 기존 구조 100% 유지, 포커스 색상만 브랜드 오렌지로 통일 */}
          <form action={handleSubmit} className="space-y-4">
            {isStaffMode && <input type="hidden" name="loginContext" value="staff" />}
            {mode === "signup" && (
              <>
                <div>
                  <label
                    htmlFor="name"
                    className="block text-sm font-medium text-[var(--color-public-muted)] dark:text-[var(--color-public-ink)] mb-1"
                  >
                    이름
                  </label>
                  <input
                    id="name"
                    name="name"
                    type="text"
                    required
                    autoComplete="off"
                    placeholder="홍길동"
                    className="min-h-11 w-full px-4 py-2.5 border border-gray-300 bg-white text-[var(--color-public-ink)] placeholder:text-gray-400 rounded-lg focus:ring-2 focus:ring-[var(--color-public-accent)] dark:focus:ring-brand-neon-lime focus:border-[var(--color-public-accent)] dark:border-[var(--color-public-line)] dark:bg-[var(--color-public-paper)] dark:text-white dark:placeholder:text-[var(--color-public-muted)] outline-none transition-colors"
                  />
                </div>
              </>
            )}

            <div>
              <label
                htmlFor="email"
                className="block text-sm font-medium text-[var(--color-public-muted)] dark:text-[var(--color-public-ink)] mb-1"
              >
                {/* 화면 하나로 모두 로그인 — 선생님·기사님은 휴대폰 번호를 넣으면 된다(서버가 직원 계정으로 찾는다) */}
                {isStaffMode ? "휴대폰 번호 또는 이메일" : "로그인 아이디 (선생님은 휴대폰 번호)"}
              </label>
              <input
                id="email"
                name={isStaffMode ? "email" : "username"}
                // 직원은 휴대폰 번호(숫자)만 넣어도 된다 — 서버가 «번호@staff.stiz.kr» 로 바꾼다(b3). 그래서 email 형식 검사를 하지 않는다.
                type="text"
                required
                autoComplete="username"
                placeholder={isStaffMode ? "01012345678" : "로그인 아이디"}
                className="min-h-11 w-full px-4 py-2.5 border border-gray-300 bg-white text-[var(--color-public-ink)] placeholder:text-gray-400 rounded-lg focus:ring-2 focus:ring-[var(--color-public-accent)] dark:focus:ring-brand-neon-lime focus:border-[var(--color-public-accent)] dark:border-[var(--color-public-line)] dark:bg-[var(--color-public-paper)] dark:text-white dark:placeholder:text-[var(--color-public-muted)] outline-none transition-colors"
              />
            </div>

            <div>
              <label
                htmlFor="password"
                className="block text-sm font-medium text-[var(--color-public-muted)] dark:text-[var(--color-public-ink)] mb-1"
              >
                비밀번호
              </label>
              {/* 비밀번호 입력 + 보기/숨기기 토글을 감싸는 relative 컨테이너 */}
              <div className="relative">
                <input
                  id="password"
                  name="password"
                  type={showPassword ? "text" : "password"}
                  required
                  minLength={6}
                  autoComplete={mode === "login" ? "current-password" : "off"}
                  // 실제 규칙: 학부모 아이디 가입 8자 이상, 선생님·관리자(초대 가입) 10자 이상
                  placeholder={isStaffMode ? "비밀번호 (10자 이상)" : "비밀번호 (8자 이상)"}
                  className="min-h-11 w-full px-4 py-2.5 pr-12 border border-gray-300 bg-white text-[var(--color-public-ink)] placeholder:text-gray-400 rounded-lg focus:ring-2 focus:ring-[var(--color-public-accent)] dark:focus:ring-brand-neon-lime focus:border-[var(--color-public-accent)] dark:border-[var(--color-public-line)] dark:bg-[var(--color-public-paper)] dark:text-white dark:placeholder:text-[var(--color-public-muted)] outline-none transition-colors"
                />
                {/* 비밀번호 보기/숨기기 토글 버튼 — 눈 아이콘 인라인 SVG */}
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  // 누르는 영역 44×44 — 입력칸 오른쪽 끝에 붙인다
                  className="absolute right-0 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center text-[var(--color-public-muted)] hover:text-[var(--color-public-muted)] dark:text-[var(--color-public-muted)] transition-colors"
                  tabIndex={-1}
                  aria-label={showPassword ? "비밀번호 숨기기" : "비밀번호 보기"}
                >
                  {showPassword ? (
                    /* 눈 열림 아이콘 — 비밀번호가 보이는 상태 */
                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  ) : (
                    /* 눈 닫힘 아이콘 (사선 있음) — 비밀번호가 숨겨진 상태 */
                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                      <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
                      <line x1="1" y1="1" x2="23" y2="23" />
                    </svg>
                  )}
                </button>
              </div>
            </div>

            {/* 회원가입 모드에서만 개인정보 동의 체크박스 표시 (개인정보보호법 준수) */}
            {mode === "signup" && (
              <div className="space-y-3 pt-2 pb-1">
                <label className="flex min-h-11 items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={agreePrivacy}
                    onChange={(e) => setAgreePrivacy(e.target.checked)}
                    className="h-5 w-5 shrink-0 rounded border-gray-300 text-[var(--color-public-accent)] dark:text-brand-neon-lime focus:ring-[var(--color-public-accent)] dark:focus:ring-brand-neon-lime"
                  />
                  <span className="text-sm text-[var(--color-public-muted)] dark:text-[var(--color-public-ink)]">
                    <a
                      href="/privacy"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[var(--color-public-accent)] dark:text-brand-neon-lime underline underline-offset-2 hover:text-[var(--color-public-strong)] dark:hover:opacity-90"
                    >
                      개인정보 수집 및 이용
                    </a>
                    에 동의합니다 <span className="text-red-500">(필수)</span>
                  </span>
                </label>
                <label className="flex min-h-11 items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={agreeTerms}
                    onChange={(e) => setAgreeTerms(e.target.checked)}
                    className="h-5 w-5 shrink-0 rounded border-gray-300 text-[var(--color-public-accent)] dark:text-brand-neon-lime focus:ring-[var(--color-public-accent)] dark:focus:ring-brand-neon-lime"
                  />
                  <span className="text-sm text-[var(--color-public-muted)] dark:text-[var(--color-public-ink)]">
                    <a
                      href="/terms"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[var(--color-public-accent)] dark:text-brand-neon-lime underline underline-offset-2 hover:text-[var(--color-public-strong)] dark:hover:opacity-90"
                    >
                      이용약관
                    </a>
                    에 동의합니다 <span className="text-red-500">(필수)</span>
                  </span>
                </label>
              </div>
            )}

            {loading && (
              <div
                role="status"
                aria-live="polite"
                className="flex items-center gap-2 rounded-lg border border-[var(--color-public-line)] bg-orange-50 px-3 py-2 text-sm font-medium text-[var(--color-public-strong)] dark:border-brand-neon-lime/30 dark:bg-brand-neon-lime/10 dark:text-brand-neon-lime"
              >
                <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" />
                <span>
                  {mode === "login"
                    ? "로그인 중입니다. 이동할 때까지 잠시만 기다려 주세요."
                    : "계정을 만드는 중입니다. 잠시만 기다려 주세요."}
                </span>
              </div>
            )}

            {/* 제출 버튼 — 회원가입 모드에서는 두 체크박스 모두 체크해야 활성화 */}
            <button
              type="submit"
              disabled={
                loading ||
                (mode === "signup" && (!agreePrivacy || !agreeTerms))
              }
              className="flex min-h-11 w-full items-center justify-center gap-2 py-2.5 bg-[var(--color-public-accent)] dark:bg-brand-neon-lime dark:text-brand-navy-900 hover:bg-[var(--color-public-strong)] dark:hover:opacity-90 text-white font-semibold rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading && (
                <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" />
              )}
              <span>
                {loading
                  ? mode === "login"
                    ? "로그인 중..."
                    : "계정 생성 중..."
                  : mode === "login"
                    ? "로그인"
                    : "학부모 계정 만들기"}
              </span>
            </button>
            {/* 학부모 아이디는 메일을 받을 수 없는 주소라, 가입 휴대폰 문자 인증으로 찾는다(2026-11-13) */}
            {!isStaffMode && mode === "login" && (
              <p className="text-center text-sm">
                <Link href="/login/forgot" className="text-[var(--color-public-muted)] underline hover:text-[var(--color-public-accent)]">
                  아이디·비밀번호 찾기
                </Link>
              </p>
            )}
          </form>

          {/* 스토어 앱 + 앱 간편로그인 꺼짐(또는 옛 앱·켜진 제공자 없음): 간편로그인 대신 안내 + 비밀번호 만들기 연결 */}
          {!isStaffMode && mode === "login" && storeApp === true && appSocialLogin === "password-only" && (
            <div className="mt-6 space-y-1 text-center text-xs leading-5 text-[var(--color-public-muted)]">
              <p>{STORE_APP_PASSWORD_LOGIN_NOTICE}</p>
              {/* 간편로그인으로만 가입한 학부모는 문자 인증으로 비밀번호를 만들 수 있다(/login/forgot, 2026-11-13) */}
              <p>
                간편로그인으로만 가입하셨나요?{" "}
                <Link href="/login/forgot" className="inline-flex min-h-11 items-center font-medium text-[var(--color-public-accent)] underline">
                  문자 인증으로 비밀번호 만들기
                </Link>
              </p>
            </div>
          )}
          {/* 스토어 앱 + 앱 간편로그인 켜짐: 누르면 앱이 가로채 시스템 브라우저(크롬 탭·사파리 인증창)에서 로그인한다.
              링크는 정확히 «?intent=login» 만 — 앱이 이 모양만 가로챈다(다른 값이 붙으면 «준비 중»으로 막힌다). */}
          {!isStaffMode && mode === "login" && storeApp === true && appSocialLogin === "buttons" && (
            <div className="mt-6 space-y-4">
              <div className="flex items-center gap-3 text-xs font-semibold text-[var(--color-public-muted)] dark:text-[var(--color-public-muted)]">
                <span className="h-px flex-1 bg-[var(--color-public-line)] dark:bg-[var(--color-public-line)]" />
                간편 로그인
                <span className="h-px flex-1 bg-[var(--color-public-line)] dark:bg-[var(--color-public-line)]" />
              </div>
              <div className="grid gap-2">
                {visibleSocialLoginOptions.map((option) => (
                  <a
                    key={option.provider}
                    href={storeAppSocialLoginHref(option.provider)}
                    className={`flex min-h-11 items-center justify-center gap-2 rounded-lg border px-4 text-sm font-medium transition ${option.tone}`}
                  >
                    {option.provider === "apple" && <AppleLogo />}
                    {option.label}
                  </a>
                ))}
              </div>
              <p className="text-center text-xs leading-5 text-[var(--color-public-muted)] dark:text-[var(--color-public-muted)]">
                로그인 창에서 인증을 마치면 앱으로 돌아옵니다. 처음 이용하는 학부모님은 회원가입을 먼저 해 주세요.
              </p>
            </div>
          )}
          {!isStaffMode && mode === "login" && storeApp === false && visibleSocialLoginOptions.length > 0 && (
            <div className="mt-6 space-y-4">
              <div className="flex items-center gap-3 text-xs font-semibold text-[var(--color-public-muted)] dark:text-[var(--color-public-muted)]">
                <span className="h-px flex-1 bg-[var(--color-public-line)] dark:bg-[var(--color-public-line)]" />
                간편 로그인
                <span className="h-px flex-1 bg-[var(--color-public-line)] dark:bg-[var(--color-public-line)]" />
              </div>
              <div className="grid gap-2">
                {/* <Link> 금지 — 미리 불러오기(prefetch)가 시작 주소를 열 때마다 로그인 열쇠(PKCE)를 새로 덮어써
                    실제로 누른 로그인이 「만료」로 실패했다(2026-10-26). 일반 링크는 누를 때 한 번만 연다. */}
                {visibleSocialLoginOptions.map((option) => (
                  <a
                    key={option.provider}
                    href={`/auth/oauth/${option.provider}?${socialLoginQuery}`}
                    className={`flex min-h-11 items-center justify-center gap-2 rounded-lg border px-4 text-sm font-medium transition ${option.tone}`}
                  >
                    {option.provider === "apple" && <AppleLogo />}
                    {option.label}
                  </a>
                ))}
              </div>
              <p className="text-center text-xs leading-5 text-[var(--color-public-muted)] dark:text-[var(--color-public-muted)]">
                처음 이용하는 학부모님은 휴대폰 인증 후 계정이 연결됩니다.
              </p>
            </div>
          )}
        </div>

        {/* 하단 링크 — 기존 구조 유지 */}
        <div className="text-center mt-6">
          <Link href="/" className="text-sm text-[var(--color-public-ink)] hover:text-[var(--color-public-accent)] dark:text-[var(--color-public-ink)] dark:hover:text-brand-neon-lime transition-colors">
            홈페이지로 돌아가기
          </Link>
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <PublicSiteTheme className="public-auth-page">
    <Suspense fallback={<div className="min-h-screen bg-surface-warm dark:bg-[var(--color-public-paper)]" />}>
      <LoginContent />
    </Suspense>
    </PublicSiteTheme>
  );
}
