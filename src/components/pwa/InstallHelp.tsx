"use client";

import { useState } from "react";
import {
  buildChromeIntentUrl,
  buildKakaoExternalUrl,
  getInAppBrowserLabel,
  getInAppEscapeSteps,
  shouldOfferChromeIntent,
  type InAppBrowserKind,
  type InstallPlatform,
} from "@/lib/pwa/installEnvironment";

/**
 * 인앱 브라우저(카카오톡 등) 탈출 안내용 공용 조각들 — /kakao-connect 가 쓴다.
 * 2026-11-18: 옛 «홈 화면 바로가기» 설치 화면 두 개를 지우면서, 그 화면만 쓰던
 * Safari 공유 버튼 그림·안드로이드 수동 설치 3단계 안내도 함께 지웠다.
 */

type OpenInChromeButtonProps = {
  platform: InstallPlatform;
  /** primary = 화면의 주 행동, secondary = 보조 권유 */
  variant?: "primary" | "secondary";
  label?: string;
};

/**
 * "크롬으로 열기" 버튼 (안드로이드 전용).
 *
 * 왜 필요한가: 카카오톡 인앱 브라우저에서는 홈 화면 추가가 막히고,
 * 삼성 인터넷으로 설치하면 Play 프로텍트가 "안전하지 않은 앱"으로 막는다. 크롬으로 열면 둘 다 해결된다.
 *
 * ⚠️ intent 스킴은 iOS에서 동작하지 않는다. 그래서 안드로이드가 아니면 **아예 렌더하지 않는다.**
 *    (눌러도 아무 일 없는 버튼은 사용자를 더 헤매게 만든다)
 */
export function OpenInChromeButton({
  platform,
  variant = "primary",
  label = "크롬으로 열기",
}: OpenInChromeButtonProps) {
  if (!shouldOfferChromeIntent(platform)) return null;

  const openChrome = () => {
    // 주소는 클릭 시점에 읽는다(서버 렌더 시 window가 없다).
    const intentUrl = buildChromeIntentUrl(window.location.href);
    // https가 아니면(개발용 http 등) 인텐트를 만들 수 없다 — 아무 것도 하지 않는다.
    if (!intentUrl) return;
    window.location.href = intentUrl;
  };

  return (
    <button
      type="button"
      onClick={openChrome}
      className={
        variant === "primary"
          ? "flex min-h-14 w-full items-center justify-center gap-2 rounded-2xl bg-[var(--brand-accent)] px-5 font-semibold text-[var(--brand-accent-contrast)] shadow-md"
          : "flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl border border-gray-300 bg-white px-4 text-sm font-medium text-gray-800 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
      }
    >
      {label}
    </button>
  );
}

type CopyAddressButtonProps = {
  /** 어두운 카드 위에 놓을 때 대비를 바꾼다 */
  tone?: "light" | "dark";
};

/**
 * 최후의 수단 — 주소 복사.
 * 어떤 인앱 브라우저든 주소만 복사하면 Safari 주소창에 붙여넣어 열 수 있다.
 * 복사 실패를 조용히 넘기면 사용자는 계속 막히므로 성공/실패를 반드시 알린다.
 */
export function CopyAddressButton({ tone = "light" }: CopyAddressButtonProps) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  const [address, setAddress] = useState("");

  const copy = async () => {
    const url = window.location.href;
    setAddress(url);
    try {
      // clipboard API는 https(또는 localhost)에서만 동작한다. 실패하면 아래에서 직접 안내한다.
      await navigator.clipboard.writeText(url);
      setStatus("copied");
    } catch {
      setStatus("failed");
    }
  };

  return (
    <div>
      <button
        type="button"
        onClick={copy}
        className={
          tone === "dark"
            ? "flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl border border-white/25 px-4 text-sm font-medium text-white"
            : "flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl border border-gray-300 bg-white px-4 text-sm font-medium text-gray-800 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
        }
      >
        주소 복사하기
      </button>
      <p aria-live="polite" className="mt-2 text-center text-xs font-medium text-gray-500 dark:text-gray-400">
        {status === "copied" && "복사됐어요. Safari 주소창에 붙여넣어 주세요."}
        {status === "failed" && "복사가 막혔어요. 아래 주소를 길게 눌러 복사해 주세요."}
      </p>
      {status === "failed" && (
        <p className="mt-1 select-all break-all rounded-xl bg-gray-100 px-3 py-2 text-center text-xs text-gray-700 dark:bg-gray-800 dark:text-gray-200">
          {address}
        </p>
      )}
    </div>
  );
}

type InAppBrowserEscapeCardProps = {
  inAppBrowser: InAppBrowserKind;
  platform: InstallPlatform;
  // 설치 안내가 아닌 화면(카카오 연결 등)에서 쓸 때 바꿔 넣는 설명. 없으면 설치 안내 문구 그대로.
  description?: string;
};

/**
 * 인앱 브라우저(카카오톡 등)에서 열렸을 때 보여주는 탈출 안내.
 * 현장에서 가장 많이 막히는 지점이라 다른 안내보다 위에 둔다.
 */
export function InAppBrowserEscapeCard({ inAppBrowser, platform, description }: InAppBrowserEscapeCardProps) {
  const label = getInAppBrowserLabel(inAppBrowser);
  const steps = getInAppEscapeSteps(inAppBrowser, platform);
  // 안드로이드는 크롬을 콕 집어 열 수 있으므로 이름을 그대로 말해 준다("브라우저"는 무엇을 말하는지 모른다).
  const browserName = platform === "ios" ? "Safari" : platform === "android" ? "크롬" : "브라우저";

  const openExternal = () => {
    // 카카오톡만 외부 브라우저를 여는 스킴을 제공한다. 이동하면 기본 브라우저로 같은 주소가 열린다.
    window.location.href = buildKakaoExternalUrl(window.location.href);
  };

  return (
    <section
      className="mt-4 rounded-3xl border border-brand-orange-200 bg-orange-50 p-5 dark:border-brand-neon-lime/30 dark:bg-brand-neon-lime/10"
      aria-labelledby="inapp-escape-title"
    >
      <div className="flex items-start gap-3">
        <div>
          <h2 id="inapp-escape-title" className="font-bold text-brand-navy-900 dark:text-white">
            {label}에서 열렸어요
          </h2>
          <p className="mt-1 text-sm leading-6 text-brand-navy-700 dark:text-gray-200">
            {description ?? `여기서는 홈 화면에 추가할 수 없어요. ${browserName}로 열어주세요.`}
          </p>
        </div>
      </div>

      {/* 안드로이드는 인앱 브라우저 종류와 무관하게 intent 스킴으로 크롬을 직접 지정해 열 수 있다.
          카카오톡·네이버·인스타 등 어디서 열렸든 이 버튼 하나로 빠져나간다. */}
      {platform === "android" ? (
        <div className="mt-4">
          <OpenInChromeButton platform={platform} />
        </div>
      ) : null}

      {/* iOS는 intent 스킴이 동작하지 않는다. 카카오톡이 공개한 외부 브라우저 스킴만 쓸 수 있다(기존 그대로). */}
      {inAppBrowser === "kakaotalk" && platform !== "android" ? (
        <button
          type="button"
          onClick={openExternal}
          className="mt-4 flex min-h-14 w-full items-center justify-center gap-2 rounded-2xl bg-[var(--brand-accent)] px-5 font-semibold text-[var(--brand-accent-contrast)] shadow-md"
        >
          {browserName}에서 열기
        </button>
      ) : null}

      {/* 스킴이 없는 앱은 메뉴로 빠져나가는 길을 알려준다. 카카오톡도 버튼이 막힐 때를 대비해 함께 보여준다. */}
      <ol className="mt-3 space-y-2" aria-label={`${label}에서 빠져나가는 방법`}>
        {steps.map((step, index) => (
          <li
            key={step}
            className="flex min-h-11 items-center gap-3 rounded-2xl bg-white px-3 py-2 dark:bg-gray-900"
          >
            <span className="grid size-7 shrink-0 place-items-center rounded-full bg-brand-navy-900 text-xs font-semibold text-white dark:bg-brand-neon-lime dark:text-brand-navy-900">
              {index + 1}
            </span>
            <span className="text-sm font-medium text-gray-800 dark:text-gray-100">{step}</span>
          </li>
        ))}
      </ol>

      <div className="mt-3">
        <CopyAddressButton />
      </div>
    </section>
  );
}
