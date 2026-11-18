"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getStizIdentityBypass } from "@/lib/identity/brand";
import { SMS_FALLBACK_HINT } from "@/lib/identity/sms-fallback-label";

/**
 * 「본인인증으로 기존 계정에 연결」 — 간편로그인 후 「이미 가입된 번호」로 막힌 학부모용(2026-10-26).
 * mybdr IdentityVerifyButton 과 같은 방식(PortOne V2 + KG이니시스 통합인증). PC=팝업, 모바일=리디렉션.
 * SDK 는 설치하지 않고 포트원 공식 주소에서 불러온다.
 */

type PortOneSdk = {
  requestIdentityVerification: (request: Record<string, unknown>) => Promise<{ code?: string; message?: string; identityVerificationId?: string } | undefined>;
};

declare global {
  interface Window {
    PortOne?: PortOneSdk;
  }
}

const SDK_URL = "https://cdn.portone.io/v2/browser-sdk.js";
const PENDING_KEY = "stiz:identity-link-pending";
const REDIRECT_PARAMS = ["identityVerificationId", "identityVerificationTxId", "code", "message", "pgCode", "pgMessage", "transactionType"];

function loadSdk(): Promise<PortOneSdk> {
  if (window.PortOne) return Promise.resolve(window.PortOne);
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SDK_URL;
    script.async = true;
    script.onload = () => (window.PortOne ? resolve(window.PortOne) : reject(new Error("SDK")));
    script.onerror = () => reject(new Error("SDK"));
    document.head.appendChild(script);
  });
}

function urlWithoutRedirectParams(): string {
  const url = new URL(window.location.href);
  for (const key of REDIRECT_PARAMS) url.searchParams.delete(key);
  return url.toString();
}

/** 실패 응답의 추가 표식(registeredPhone 등)을 부르는 화면이 알 수 있게 담아 던진다 */
class IdentityRequestError extends Error {
  data: Record<string, unknown>;
  constructor(message: string, data: Record<string, unknown>) {
    super(message);
    this.data = data;
  }
}

async function postJson(url: string, body?: unknown) {
  const response = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new IdentityRequestError(typeof data?.error === "string" ? data.error : "본인인증 연결에 실패했어요. 다시 시도해 주세요.", (data ?? {}) as Record<string, unknown>);
  return data as Record<string, unknown>;
}

/** 본인인증 결과가 «기존 계정 연결»이 아니라 «가입 이어가기»일 때 화면에 넘기는 값(문자 인증 확인 응답과 같은 모양) */
export type IdentitySignupHandoff = {
  challengeToken?: string;
  proof?: string;
  verifiedName?: string;
  existingParent?: "LINKED" | "ACTIVATE";
  activationUrl?: string;
  redirectPath?: string;
  /** 인증된 본인 번호(숫자만) — «전화번호를 비밀번호로» 경고 비교용(2026-11-18 검수 A-2) */
  verifiedPhone?: string;
};

// 기본 주소 = 간편가입(로그인된 간편로그인 사용자) 본인인증. 로그인 전 본인인증(아이디 가입·활성화·찾기)은
// 부르는 화면이 startUrl·verifyUrl 을 넘긴다(2026-11-18 4단계). 기본값을 그대로 두면 기존 사용처 동작은 같다.
const DEFAULT_START_URL = "/api/auth/parent-link/start";
const DEFAULT_VERIFY_URL = "/api/auth/parent-link/verify";

export default function IdentityLinkButton({
  onSignup,
  onResult,
  onFailure,
  beforeStart,
  afterPopup,
  next,
  startUrl = DEFAULT_START_URL,
  verifyUrl = DEFAULT_VERIFY_URL,
  label = "본인인증으로 기존 계정에 연결",
  hint = "휴대폰 명의자 본인인증(PASS·카카오·토스 등)을 하면, 같은 번호·같은 이름의 학부모 계정에 바로 연결됩니다.",
}: {
  onSignup?: (data: IdentitySignupHandoff) => void;
  /** 주면 확인 응답 전체를 이 함수가 받는다(찾기 화면처럼 «가입 이어가기»가 아닌 곳). onSignup·이동보다 먼저 */
  onResult?: (data: Record<string, unknown>) => void;
  /** 확인이 실패했을 때 응답 표식(registeredPhone 등)을 받는다 — 문구는 이 버튼이 그대로 보여 준다 */
  onFailure?: (data: Record<string, unknown>) => void;
  /** 인증창을 열기 직전 — 모바일은 인증창에서 «리디렉션»으로 돌아오며 화면 상태가 사라지므로, 부르는 화면이 여기서 저장한다 */
  beforeStart?: () => void;
  /** PC 팝업 결과를 받은 직후(성공·취소 모두) — 리디렉션 대비로 저장한 상태를 지울 때(검수 A-3) */
  afterPopup?: () => void;
  next?: string;
  startUrl?: string;
  verifyUrl?: string;
  label?: string;
  hint?: string;
} = {}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const handledRef = useRef(false);

  const confirm = useCallback(async (identityVerificationId: string) => {
    const data = await postJson(verifyUrl, { identityVerificationId, next });
    if (onResult) {
      onResult(data);
      return;
    }
    // 로그인 수단이 있는 계정이 없는 번호(처음 오신 분·학원이 등록해 둔 보호자) → 가입 화면이 이어 간다(문자 인증 없이).
    if (data.signup === true && onSignup) {
      onSignup(data as IdentitySignupHandoff);
      return;
    }
    // 기존 계정으로 로그인됐다 — 같은 간편로그인을 그 계정에 붙이러 간다(확인창이 한 번 더 뜬다).
    window.location.href = typeof data.next === "string" ? data.next : "/mypage/login-methods";
  }, [next, onSignup, onResult, verifyUrl]);

  // 실패 문구는 이 버튼이 보이고, 표식은 부르는 화면에 넘긴다
  const fail = useCallback((reason: unknown) => {
    setError(reason instanceof Error ? reason.message : "본인인증 연결에 실패했어요.");
    if (reason instanceof IdentityRequestError) onFailure?.(reason.data);
  }, [onFailure]);

  // 모바일: 인증창에서 돌아오면 주소에 결과가 붙어 있다.
  useEffect(() => {
    if (handledRef.current) return;
    const params = new URLSearchParams(window.location.search);
    const returnedId = params.get("identityVerificationId");
    if (!returnedId) {
      // 취소로 돌아오면 주소에 code 만 붙을 수 있다 — 이 탭에서 시작한 인증이 있을 때만 «취소» 안내(검수 A-3)
      if (!params.get("code")) return;
      let started = "";
      try {
        started = window.sessionStorage.getItem(PENDING_KEY) || "";
        if (started) window.sessionStorage.removeItem(PENDING_KEY);
      } catch {
        // 저장소가 막힌 환경 — 이 탭의 인증인지 알 수 없어 건드리지 않는다
      }
      if (!started) return;
      handledRef.current = true;
      window.history.replaceState(null, "", urlWithoutRedirectParams());
      setError("본인인증이 취소됐어요. 다시 시도할 수 있어요.");
      return;
    }
    handledRef.current = true;
    let pending = "";
    try {
      pending = window.sessionStorage.getItem(PENDING_KEY) || "";
      window.sessionStorage.removeItem(PENDING_KEY);
    } catch {
      // 저장소가 막힌 환경
    }
    window.history.replaceState(null, "", urlWithoutRedirectParams());
    // 이 탭에서 시작한 인증만 처리한다. 주소의 message 는 누구나 꾸밀 수 있어 화면에 싣지 않는다.
    if (pending !== returnedId || params.get("code")) {
      setError("본인인증이 취소되었거나 확인하지 못했어요. 다시 시도해 주세요.");
      return;
    }
    setBusy(true);
    confirm(returnedId)
      .catch(fail)
      .finally(() => setBusy(false));
  }, [confirm, fail]);

  async function start() {
    if (busy) return;
    setError("");
    const storeId = process.env.NEXT_PUBLIC_PORTONE_STORE_ID;
    const channelKey = process.env.NEXT_PUBLIC_PORTONE_IDENTITY_CHANNEL_KEY;
    if (!storeId || !channelKey) {
      // 본인인증이 꺼진 환경 — 같은 화면의 문자 인증 샛길로 안내(검수 A-1)
      setError(`본인인증 설정이 아직 끝나지 않았어요. ${SMS_FALLBACK_HINT}`);
      return;
    }
    setBusy(true);
    try {
      // 건 번호는 서버가 만든다(간편가입 = 이 간편로그인 사용자 표식, 로그인 전 = 이 브라우저 nonce 쿠키 표식).
      const { identityVerificationId } = await postJson(startUrl);
      if (typeof identityVerificationId !== "string") throw new Error("본인인증을 시작하지 못했어요.");
      const sdk = await loadSdk().catch(() => {
        throw new Error("본인인증 모듈을 불러오지 못했어요. 새로고침 후 다시 시도해 주세요.");
      });
      try {
        window.sessionStorage.setItem(PENDING_KEY, identityVerificationId);
      } catch {
        // PC 팝업 흐름은 영향 없음
      }
      // 모바일 리디렉션 대비 — 화면 상태 저장(실패해도 인증은 진행)
      try {
        beforeStart?.();
      } catch {
        // 저장소가 막힌 환경
      }
      const result = await sdk.requestIdentityVerification({
        storeId,
        channelKey,
        identityVerificationId,
        redirectUrl: urlWithoutRedirectParams(),
        // KG이니시스 통합인증 필수값 — 빠지면 인증창이 열리기 전에 실패한다(mybdr 2026-09-17 사고).
        bypass: getStizIdentityBypass(),
      });
      // PC 팝업 — 여기서 결과가 온다(모바일 리디렉션이면 여기까지 오지 않는다).
      try {
        window.sessionStorage.removeItem(PENDING_KEY);
      } catch {
        // 무시
      }
      // 팝업으로 끝났으니 리디렉션 대비로 저장한 화면 상태는 필요 없다
      try {
        afterPopup?.();
      } catch {
        // 저장소가 막힌 환경
      }
      if (result?.code) {
        setError("본인인증이 취소되었어요.");
        return;
      }
      await confirm(result?.identityVerificationId ?? identityVerificationId);
    } catch (reason) {
      fail(reason);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-2">
      <button
        type="button"
        onClick={start}
        disabled={busy}
        className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-[var(--color-public-accent)] px-4 text-sm font-semibold text-white hover:bg-[var(--color-public-strong)] disabled:opacity-50 dark:bg-brand-neon-lime dark:text-brand-navy-900"
      >
        {busy ? "확인 중..." : label}
      </button>
      <p className="text-xs leading-5 text-[var(--color-public-muted)] dark:text-[var(--color-public-muted)]">
        {hint}
      </p>
      {error && <p role="alert" className="rounded-xl bg-[var(--color-academy-danger-soft)] px-3 py-2 text-sm font-semibold text-[var(--color-academy-danger)] dark:bg-red-950/40 dark:text-red-200">{error}</p>}
    </div>
  );
}
