"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getStizIdentityBypass } from "@/lib/identity/brand";

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

async function postJson(url: string, body?: unknown) {
  const response = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data?.error === "string" ? data.error : "본인인증 연결에 실패했어요. 다시 시도해 주세요.");
  return data as Record<string, unknown>;
}

export default function IdentityLinkButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const handledRef = useRef(false);

  const confirm = useCallback(async (identityVerificationId: string) => {
    const data = await postJson("/api/auth/parent-link/verify", { identityVerificationId });
    // 기존 계정으로 로그인됐다 — 같은 간편로그인을 그 계정에 붙이러 간다(확인창이 한 번 더 뜬다).
    window.location.href = typeof data.next === "string" ? data.next : "/mypage/login-methods";
  }, []);

  // 모바일: 인증창에서 돌아오면 주소에 결과가 붙어 있다.
  useEffect(() => {
    if (handledRef.current) return;
    const params = new URLSearchParams(window.location.search);
    const returnedId = params.get("identityVerificationId");
    if (!returnedId) return;
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
      .catch((reason) => setError(reason instanceof Error ? reason.message : "본인인증 연결에 실패했어요."))
      .finally(() => setBusy(false));
  }, [confirm]);

  async function start() {
    if (busy) return;
    setError("");
    const storeId = process.env.NEXT_PUBLIC_PORTONE_STORE_ID;
    const channelKey = process.env.NEXT_PUBLIC_PORTONE_IDENTITY_CHANNEL_KEY;
    if (!storeId || !channelKey) {
      setError("본인인증 설정이 아직 끝나지 않았습니다. 학원에 문의해 주세요.");
      return;
    }
    setBusy(true);
    try {
      // 건 번호는 서버가 만든다(이 간편로그인 사용자 표식이 들어간다).
      const { identityVerificationId } = await postJson("/api/auth/parent-link/start");
      if (typeof identityVerificationId !== "string") throw new Error("본인인증을 시작하지 못했어요.");
      const sdk = await loadSdk().catch(() => {
        throw new Error("본인인증 모듈을 불러오지 못했어요. 새로고침 후 다시 시도해 주세요.");
      });
      try {
        window.sessionStorage.setItem(PENDING_KEY, identityVerificationId);
      } catch {
        // PC 팝업 흐름은 영향 없음
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
      if (result?.code) {
        setError("본인인증이 취소되었어요.");
        return;
      }
      await confirm(result?.identityVerificationId ?? identityVerificationId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "본인인증 연결에 실패했어요.");
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
        className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-brand-navy-900 px-4 text-sm font-bold text-white disabled:opacity-50 dark:bg-brand-neon-lime dark:text-brand-navy-900"
      >
        <span className="material-symbols-outlined text-lg" aria-hidden="true">verified_user</span>
        {busy ? "확인 중..." : "본인인증으로 기존 계정에 연결"}
      </button>
      <p className="text-xs leading-5 text-gray-500 dark:text-gray-400">
        휴대폰 명의자 본인인증(PASS·카카오·토스 등)을 하면, 같은 번호·같은 이름의 학부모 계정에 바로 연결됩니다.
      </p>
      {error && <p role="alert" className="rounded-xl bg-red-50 px-3 py-2 text-sm font-semibold text-red-700 dark:bg-red-950/40 dark:text-red-200">{error}</p>}
    </div>
  );
}
