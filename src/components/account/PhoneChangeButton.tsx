"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { getStizIdentityBypass } from "@/lib/identity/brand";
import Link from "next/link";
import { customerMessage } from "@/components/parent/customerMessage";
import { PHONE_NAME_MISMATCH_MESSAGE } from "@/lib/account/phone-change-rules";

// 보호자 «연락처 바꾸기» 버튼 (2026-11-14 원장 결정 b6·c1) — 설정·아이 정보·방학특강 화면이 같이 쓴다.
// 누르면 본인 명의 휴대폰 인증(포트원 — 자녀·가족 연결과 같은 인증 창)이 열리고, 통과하면 계정 번호가 인증된 번호로 바뀐다.
// 새 번호를 직접 적는 칸은 없다(인증 없이 번호를 바꾸는 길을 만들지 않는다).
// 본인인증이 꺼진 환경에서는 버튼 대신 fallback(기존 안내)을 그린다.

const PENDING_KEY = "stiz:phone-change-verification:v1";
const REDIRECT_PARAMS = ["identityVerificationId", "identityVerificationTxId", "code", "message", "pgCode", "pgMessage", "transactionType"];
const SDK_SRC = "https://cdn.portone.io/v2/browser-sdk.js";

function cleanUrl() {
  const url = new URL(window.location.href);
  for (const key of REDIRECT_PARAMS) url.searchParams.delete(key);
  return url.toString();
}

async function phoneChangeRequest(body?: Record<string, unknown>) {
  const response = await fetch("/api/account/phone-change", {
    method: body ? "POST" : "GET", credentials: "same-origin", cache: "no-store",
    ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data || typeof data !== "object") {
    throw new Error(typeof data?.error === "string" ? data.error : "연락처를 바꾸지 못했어요. 다시 시도해 주세요.");
  }
  return data as Record<string, unknown>;
}

async function loadIdentitySdk() {
  if (window.PortOne) return window.PortOne;
  return new Promise<NonNullable<Window["PortOne"]>>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SDK_SRC;
    script.async = true;
    const timeout = window.setTimeout(() => { script.remove(); reject(new Error("본인인증 화면 연결이 늦어지고 있어요. 다시 시도해 주세요.")); }, 15000);
    script.onload = () => {
      window.clearTimeout(timeout);
      if (window.PortOne) resolve(window.PortOne);
      else { script.remove(); reject(new Error("본인인증 화면을 열지 못했어요. 다시 시도해 주세요.")); }
    };
    script.onerror = () => { window.clearTimeout(timeout); script.remove(); reject(new Error("본인인증 화면을 불러오지 못했어요. 연결을 확인한 뒤 다시 시도해 주세요.")); };
    document.head.appendChild(script);
  });
}

export default function PhoneChangeButton({
  enabled,
  label = "연락처 바꾸기",
  className = "academy-button-secondary",
  fallback = null,
  messageClassName = "mt-1 text-xs",
  nameOk,
  onSettingsPage = false,
}: {
  /** 서버가 이미 아는 경우(설정 화면). 안 주면 화면이 한 번 물어본다 */
  enabled?: boolean;
  label?: string;
  className?: string;
  /** 본인인증이 꺼진 환경에서 버튼 대신 보일 것(기존 안내·링크) */
  fallback?: ReactNode;
  messageClassName?: string;
  /** 계정 이름이 본인인증 이름 모양인가(서버가 아는 경우). false 면 인증 전에 미리 알린다 */
  nameOk?: boolean;
  /** 설정 화면 안인가 — 이름 칸이 바로 위에 있으므로 «이름 고치러 가기» 링크 대신 글만 */
  onSettingsPage?: boolean;
}) {
  const router = useRouter();
  const [available, setAvailable] = useState<boolean | null>(enabled ?? null);
  const [nameLooksOk, setNameLooksOk] = useState<boolean>(nameOk ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const locked = useRef(false);
  const redirected = useRef(false);

  useEffect(() => {
    if (enabled !== undefined) { setAvailable(enabled); return; }
    let alive = true;
    phoneChangeRequest().then((data) => { if (alive) { setAvailable(data.enabled === true); setNameLooksOk(data.nameOk !== false); } }).catch(() => { if (alive) setAvailable(false); });
    return () => { alive = false; };
  }, [enabled]);

  const confirm = useCallback(async (id: string) => {
    const result = await phoneChangeRequest({ action: "confirm", identityVerificationId: id });
    if (result.ok !== true) throw new Error("연락처를 바꾸지 못했어요. 다시 시도해 주세요.");
    setNotice(result.changed === true ? "연락처를 바꿨어요." : "이미 이 번호예요.");
    router.refresh();
  }, [router]);

  // 인증 창이 다른 화면으로 넘어갔다 돌아온 경우(휴대폰 브라우저) — 이 탭에서 시작한 건만 이어서 확인한다
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const returnedId = params.get("identityVerificationId");
    if (redirected.current || (!returnedId && !params.has("code"))) return;
    let pending = "";
    try { pending = sessionStorage.getItem(PENDING_KEY) ?? ""; } catch { /* 대조할 수 없는 인증은 쓰지 않는다 */ }
    if (!pending) return; // 다른 흐름(자녀 연결)의 복귀 — 건드리지 않는다
    redirected.current = true;
    try { sessionStorage.removeItem(PENDING_KEY); } catch { /* 무시 */ }
    window.history.replaceState(null, "", cleanUrl());
    if (!returnedId || pending !== returnedId || params.get("code")) {
      setError("본인인증이 취소됐어요. 다시 시도할 수 있어요.");
      return;
    }
    locked.current = true;
    setBusy(true);
    confirm(returnedId)
      .catch((reason) => setError(customerMessage(reason, "연락처를 바꾸지 못했어요. 다시 시도해 주세요.")))
      .finally(() => { locked.current = false; setBusy(false); });
  }, [confirm]);

  async function start() {
    if (locked.current) return;
    locked.current = true;
    setBusy(true); setError(""); setNotice("");
    try {
      const storeId = process.env.NEXT_PUBLIC_PORTONE_STORE_ID;
      const channelKey = process.env.NEXT_PUBLIC_PORTONE_IDENTITY_CHANNEL_KEY;
      if (!storeId || !channelKey) throw new Error("본인인증을 준비하고 있어요. 잠시 후 다시 확인해 주세요.");
      const started = await phoneChangeRequest({ action: "start" });
      const id = started.identityVerificationId;
      if (typeof id !== "string") throw new Error("본인인증을 시작하지 못했어요. 다시 시도해 주세요.");
      const sdk = await loadIdentitySdk();
      try { sessionStorage.setItem(PENDING_KEY, id); } catch { throw new Error("이 브라우저에서는 인증을 이어갈 수 없어요. Safari나 Chrome에서 다시 시도해 주세요."); }
      const response = await sdk.requestIdentityVerification({ storeId, channelKey, identityVerificationId: id, redirectUrl: cleanUrl(), bypass: getStizIdentityBypass() });
      try { sessionStorage.removeItem(PENDING_KEY); } catch { /* 서버도 인증 건과 로그인 계정을 함께 확인한다 */ }
      if (response?.code) throw new Error("본인인증이 취소됐어요. 다시 시도할 수 있어요.");
      if (response?.identityVerificationId && response.identityVerificationId !== id) throw new Error("본인인증 결과가 일치하지 않아요. 다시 시도해 주세요.");
      await confirm(id);
    } catch (reason) {
      setError(customerMessage(reason, "연락처를 바꾸지 못했어요. 다시 시도해 주세요."));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }

  if (available === null) return null;
  if (!available) return <>{fallback}</>;
  return (
    <>
      <button type="button" onClick={() => void start()} disabled={busy} className={className}>
        {busy ? "확인 중…" : label}
      </button>
      {/* 인증 전에 미리 — 계정 이름이 실명 모양이 아니면 인증해도 거절된다 */}
      {!nameLooksOk && !error && !notice && (
        <p className={`${messageClassName} basis-full text-[var(--color-academy-muted)]`}>
          계정 이름이 본인인증 이름과 같아야 해요.{" "}
          {onSettingsPage ? "위 «이름»을 먼저 바꿔 주세요." : <Link href="/mypage/settings" className="inline-flex min-h-11 items-center underline">이름 고치러 가기</Link>}
        </p>
      )}
      {error && (
        <p role="alert" className={`${messageClassName} basis-full text-[var(--color-academy-danger)]`}>
          {error}
          {/* 이름 불일치 — 고칠 곳으로 바로 */}
          {error === PHONE_NAME_MISMATCH_MESSAGE && !onSettingsPage && <>{" "}<Link href="/mypage/settings" className="inline-flex min-h-11 items-center underline">이름 고치러 가기</Link></>}
        </p>
      )}
      {notice && <p role="status" className={`${messageClassName} basis-full text-[var(--color-academy-success)]`}>{notice}</p>}
    </>
  );
}
