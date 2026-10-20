"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  AndroidInstallSteps,
  CopyAddressButton,
  InAppBrowserEscapeCard,
  SafariShareIllustration,
} from "@/components/pwa/InstallHelp";
// 기기·인앱 브라우저 판별은 두 설치 화면이 공유하는 순수 모듈 한 곳에서만 한다.
import {
  detectInstallEnvironment,
  getAndroidInstallHint,
  type AndroidBrowserKind,
  type InAppBrowserKind,
  type InstallDeviceState,
  type InstallPlatform,
} from "@/lib/pwa/installEnvironment";
// 첫 1.5초 동안 무엇을 보여줄지(대기/설치버튼/수동안내)는 순수 모듈 한 곳에서만 판단한다.
import {
  INSTALL_PROMPT_WAIT_MS,
  resolveInstallScreenView,
} from "@/lib/pwa/installReadiness";

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

type NavigatorWithStandalone = Navigator & { standalone?: boolean };

// 루트 레이아웃의 인라인 스크립트가 하이드레이션 전에 잡아둔 설치 이벤트 보관 장소
type WindowWithInstallPrompt = Window & { __stizInstallPrompt?: InstallPromptEvent | null };

type DeviceState = "checking" | "installed" | InstallDeviceState;

export default function StaffAppInstallClient() {
  const [deviceState, setDeviceState] = useState<DeviceState>("checking");
  // 인앱 브라우저 여부는 기기 종류와 별개다(안드로이드 카카오톡도 있다). 상태를 따로 둔다.
  const [inAppBrowser, setInAppBrowser] = useState<InAppBrowserKind | null>(null);
  // 삼성 인터넷은 설치 메뉴 이름이 크롬과 달라서 안내 문구를 따로 골라야 한다.
  const [androidBrowser, setAndroidBrowser] = useState<AndroidBrowserKind>("other");
  const [platform, setPlatform] = useState<InstallPlatform>("other");
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const [isInstalling, setIsInstalling] = useState(false);
  // 크롬이 설치 신호를 1~2초 늦게 보낸다. 그 사이에 "설치 안 됨" 안내를 띄우면 선생님들이 닫아버린다.
  // 그래서 아주 짧은 대기 창을 두고, 그 창이 끝났는지만 여기서 기억한다.
  const [waitElapsed, setWaitElapsed] = useState(false);

  useEffect(() => {
    const navigatorWithStandalone = navigator as NavigatorWithStandalone;
    const isStandalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      navigatorWithStandalone.standalone === true;

    if (isStandalone) {
      setDeviceState("installed");
    } else {
      // 기기·브라우저별로 설치 방법이 다르므로 UA로 갈라 안내 문구를 바꾼다.
      const environment = detectInstallEnvironment({
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        maxTouchPoints: navigator.maxTouchPoints,
      });
      setDeviceState(environment.deviceState);
      setInAppBrowser(environment.inAppBrowser);
      setAndroidBrowser(environment.androidBrowser ?? "other");
      setPlatform(environment.platform);
    }

    const globalWindow = window as WindowWithInstallPrompt;

    // 1) 이미 붙잡혀 있는 이벤트가 있으면 즉시 사용한다. (버튼이 안 뜨던 진짜 원인 수정)
    if (globalWindow.__stizInstallPrompt) {
      setInstallPrompt(globalWindow.__stizInstallPrompt);
    }

    // 2) 캡처 스크립트가 새로 잡았다고 알려주면 그 값을 가져온다.
    const adoptStoredPrompt = () => {
      setInstallPrompt(globalWindow.__stizInstallPrompt ?? null);
    };

    // 3) 캡처 스크립트가 없거나 이벤트가 늦게 오는 경우 대비 (직접 구독 유지)
    const handleInstallPrompt = (event: Event) => {
      event.preventDefault();
      const promptEvent = event as InstallPromptEvent;
      globalWindow.__stizInstallPrompt = promptEvent;
      // 기기 판별은 건드리지 않는다 — PC에서도 설치할 수 있어야 하므로 설치 가능 여부와 기기를 분리한다.
      setInstallPrompt(promptEvent);
    };

    const handleInstalled = () => {
      globalWindow.__stizInstallPrompt = null;
      setInstallPrompt(null);
      setDeviceState("installed");
    };

    window.addEventListener("stiz:installprompt", adoptStoredPrompt);
    window.addEventListener("stiz:installed", handleInstalled);
    window.addEventListener("beforeinstallprompt", handleInstallPrompt);
    window.addEventListener("appinstalled", handleInstalled);

    // 대기 창 타이머. iOS·인앱 브라우저처럼 기다릴 필요가 없는 환경은
    // resolveInstallScreenView 가 애초에 대기로 보지 않으므로 타이머 결과와 무관하다.
    const waitTimer = window.setTimeout(() => setWaitElapsed(true), INSTALL_PROMPT_WAIT_MS);

    return () => {
      window.clearTimeout(waitTimer);
      window.removeEventListener("stiz:installprompt", adoptStoredPrompt);
      window.removeEventListener("stiz:installed", handleInstalled);
      window.removeEventListener("beforeinstallprompt", handleInstallPrompt);
      window.removeEventListener("appinstalled", handleInstalled);
    };
  }, []);

  const install = async () => {
    if (!installPrompt) return;
    setIsInstalling(true);
    try {
      await installPrompt.prompt();
      await installPrompt.userChoice;
      // 실제 설치 완료 표시는 appinstalled 이벤트에서만 전환합니다.
      // 사용자 수락은 설치 요청 승인일 뿐, 설치 완료를 보장하지 않습니다.
      // 한 번 쓴 이벤트는 재사용할 수 없으므로 전역 보관값도 함께 비운다.
      (window as WindowWithInstallPrompt).__stizInstallPrompt = null;
      setInstallPrompt(null);
    } finally {
      setIsInstalling(false);
    }
  };

  const isInstalled = deviceState === "installed";
  // 지금 화면에 무엇을 보여줄지(대기 표시/설치 버튼/수동 안내)는 순수 함수가 한 번에 정한다.
  const view = resolveInstallScreenView({
    deviceState,
    hasPrompt: installPrompt !== null,
    isInAppBrowser: inAppBrowser !== null,
    waitElapsed,
  });

  return (
    <main className="min-h-screen bg-surface-warm px-4 pb-[max(2rem,env(safe-area-inset-bottom))] pt-[max(1.25rem,env(safe-area-inset-top))] dark:bg-gray-950">
      <div className="mx-auto max-w-lg">
        <header className="flex min-h-11 items-center gap-2 text-brand-navy-900 dark:text-white">
          <span className="grid size-10 place-items-center rounded-xl bg-[var(--brand-accent)] text-[var(--brand-accent-contrast)]" aria-hidden="true">
            <span className="material-symbols-outlined">sports_soccer</span>
          </span>
          <div>
            <p className="text-lg font-black leading-tight">STIZ</p>
            <p className="text-xs font-bold text-gray-500 dark:text-gray-400">선생님 앱</p>
          </div>
        </header>

        <section className="mt-7 overflow-hidden rounded-[2rem] bg-brand-navy-900 px-5 py-7 text-white shadow-xl">
          <div className="mx-auto grid size-20 place-items-center rounded-[1.5rem] bg-[var(--brand-accent)] text-[var(--brand-accent-contrast)] shadow-lg">
            <span className="material-symbols-outlined text-4xl" aria-hidden="true">
              {isInstalled ? "check_circle" : "install_mobile"}
            </span>
          </div>
          <div className="mt-5 text-center">
            <p className="text-sm font-bold text-white/65">가입을 마친 선생님 전용</p>
            <h1 className="mt-1 text-balance text-3xl font-black leading-tight">
              {isInstalled ? "선생님 앱이 준비됐어요" : "스티즈 선생님 앱 설치"}
            </h1>
            <p className="mx-auto mt-3 max-w-sm text-balance text-sm leading-6 text-white/75">
              개인 초대 링크에서 가입을 마쳤다면, 출결 확인과 수업 관리를 홈 화면에서 바로 시작하세요.
            </p>
          </div>

          {/* 설치 전에는 행동이 '설치' 하나뿐이다. 웹으로 바로 들어가는 버튼을 두면 설치를 건너뛴다. */}
          {/* 브라우저 설치 프롬프트는 사용자 제스처(클릭) 안에서만 띄울 수 있어 자동 호출하지 않는다. */}
          {view.showInstallButton && installPrompt && (
            <div className="mt-6">
              <button
                type="button"
                onClick={install}
                disabled={isInstalling}
                className="flex min-h-16 w-full items-center justify-center gap-2 rounded-2xl bg-[var(--brand-accent)] px-5 text-lg font-black text-[var(--brand-accent-contrast)] shadow-md disabled:cursor-wait disabled:opacity-70"
              >
                <span className="material-symbols-outlined" aria-hidden="true">download</span>
                {isInstalling ? "설치 준비 중..." : "지금 앱 설치하기"}
              </button>
            </div>
          )}

          {/* 설치가 끝나면 이 화면은 할 일이 없다. 그런데 설치된 앱으로 이 주소가 열리면
              주소창도 뒤로가기도 없어서, 나갈 길이 없으면 사용자가 그대로 갇힌다.
              (실제 발생: 크롬 '앱 열기'가 보고 있던 주소를 그대로 앱 창으로 열었다) */}
          {isInstalled && (
            <div className="mt-6">
              <Link
                href="/staff"
                className="flex min-h-16 w-full items-center justify-center gap-2 rounded-2xl bg-[var(--brand-accent)] px-5 text-lg font-black text-[var(--brand-accent-contrast)] shadow-md"
              >
                <span className="material-symbols-outlined" aria-hidden="true">arrow_forward</span>
                선생님 페이지 열기
              </Link>
            </div>
          )}
        </section>

        {/* 설치 신호가 늦게 오는 1.5초 동안 보여주는 최소 표시.
            이 자리에 곧 안내 카드가 오므로 같은 카드 껍데기를 써서 화면이 크게 출렁이지 않게 한다. */}
        {view.showWaitingNotice && (
          <section
            className="mt-4 flex min-h-11 items-center gap-3 rounded-3xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900"
            aria-live="polite"
          >
            <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-[var(--brand-accent-soft)] text-[var(--brand-accent)]" aria-hidden="true">
              <span className="material-symbols-outlined animate-spin">progress_activity</span>
            </span>
            <p className="text-sm font-bold text-gray-600 dark:text-gray-300">설치 방법을 확인하고 있어요</p>
          </section>
        )}

        {/* 카카오톡 등 인앱 브라우저에서는 홈 화면 추가 자체가 막힌다. 탈출 안내를 먼저 보여준다. */}
        {view.showInAppEscape && inAppBrowser && (
          <InAppBrowserEscapeCard inAppBrowser={inAppBrowser} platform={platform} />
        )}

        {/* 아래 조건은 view.showManualGuide 와 같은 뜻이지만, 기존 계약(테스트)이 잠근 표현이라 그대로 남긴다. */}
        {view.showManualGuide && !isInstalled && deviceState !== "checking" && !inAppBrowser && (
          <section className="mt-4 rounded-3xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900" aria-labelledby="install-guide-title">
            <div className="flex items-start gap-3">
              <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-[var(--brand-accent-soft)] text-[var(--brand-accent)]" aria-hidden="true">
                <span className="material-symbols-outlined">touch_app</span>
              </span>
              <div>
                <h2 id="install-guide-title" className="font-black text-gray-900 dark:text-white">
                  {deviceState === "ios-browser" ? "Safari에서 열어주세요" : "홈 화면에 설치하는 방법"}
                </h2>
                <p className="mt-1 text-sm leading-6 text-gray-600 dark:text-gray-300">
                  {deviceState === "ios-safari" && "공유 버튼을 누른 뒤 ‘홈 화면에 추가’를 선택하세요."}
                  {deviceState === "ios-browser" && "아이폰은 Safari에서만 홈 화면에 추가할 수 있어요."}
                  {/* 브라우저마다 메뉴 이름이 다르다 — 실제 메뉴에 적힌 그대로 안내한다. */}
                  {deviceState === "android" && !installPrompt && getAndroidInstallHint(androidBrowser)}
                  {/* PC라도 설치 프롬프트가 잡혀 있으면 바로 설치할 수 있다고 알린다. */}
                  {deviceState === "other" && installPrompt && "이 브라우저에 설치할 수 있어요. 위 ‘지금 앱 설치하기’를 눌러주세요."}
                  {deviceState === "other" && !installPrompt && "휴대폰에서 이 링크를 열면 기기에 맞는 설치 방법을 바로 안내해 드려요."}
                </p>
                {/* 이미 설치돼 있으면 브라우저가 설치 이벤트를 아예 보내지 않는다. 오해하지 않도록 한 줄 덧붙인다. */}
                {!installPrompt && (deviceState === "android" || deviceState === "other") && (
                  <p className="mt-1 text-xs leading-5 text-gray-500 dark:text-gray-400">
                    이미 설치돼 있으면 설치 버튼이 나타나지 않습니다.
                  </p>
                )}
              </div>
            </div>

            {/* 아이폰 크롬·웨일 등: 애플 제한으로 설치가 불가능하다. 주소만 복사해 Safari로 옮기게 한다. */}
            {deviceState === "ios-browser" && (
              <div className="mt-4">
                <CopyAddressButton />
              </div>
            )}

            {/* iPhone(Safari) 3단계 안내 — 말로만 하면 공유 버튼을 못 찾으므로 그림을 함께 보여준다. */}
            {deviceState === "ios-safari" && (
              <>
                <SafariShareIllustration />
                <ol className="mt-4 space-y-3" aria-label="iPhone 설치 순서">
                  {[
                    ["ios_share", "Safari의 공유 버튼 누르기", "화면 아래쪽(또는 위쪽)에 있어요"],
                    ["add_box", "‘홈 화면에 추가’ 선택하기", "목록을 조금 내리면 보여요"],
                    ["add", "오른쪽 위 ‘추가’ 누르기", ""],
                  ].map(([icon, label, hint], index) => (
                    <li key={label} className="flex min-h-11 items-center gap-3 rounded-2xl bg-gray-50 px-3 py-2 dark:bg-gray-800">
                      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-brand-navy-900 text-sm font-black text-white">{index + 1}</span>
                      <span className="material-symbols-outlined text-[var(--brand-accent)]" aria-hidden="true">{icon}</span>
                      <span className="min-w-0">
                        <span className="block text-sm font-bold text-gray-800 dark:text-gray-100">{label}</span>
                        {hint && <span className="block text-xs text-gray-500 dark:text-gray-400">{hint}</span>}
                      </span>
                    </li>
                  ))}
                </ol>
              </>
            )}

            {/* Android 3단계 안내 — 설치 프롬프트가 안 뜨는 기기 대비. 삼성 인터넷은 메뉴 이름이 다르다. */}
            {deviceState === "android" && !installPrompt && (
              <AndroidInstallSteps androidBrowser={androidBrowser} />
            )}
          </section>
        )}

        {/* 설치 못 하는 분에게 남기는 유일한 대안 안내 한 줄 */}
        <p className="mt-6 text-center text-xs leading-5 text-gray-500 dark:text-gray-400">
          설치하지 않아도 웹에서 바로 사용할 수 있습니다.
        </p>
      </div>
    </main>
  );
}
