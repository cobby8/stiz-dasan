"use client";

/**
 * GuideTourTrigger -- 입학 가이드 투어 v2 (driver.js 기반)
 *
 * 이 파일 하나가 모든 투어 로직을 담당한다.
 * - 플로팅 "입학 가이드" 버튼
 * - 첫 방문 자동 제안 토스트
 * - Phase 1~4 투어 실행 (driver.js SVG cutout)
 * - 모바일 햄버거 메뉴 2단계 안내
 * - 투어 중단 시 재개 기능 (localStorage)
 * - 투어 완료 축하 토스트
 *
 * 핵심 원칙:
 * 1. 작은 요소만 하이라이트 (메뉴 링크, 버튼, 드롭다운 등)
 * 2. 사용자가 직접 클릭하여 페이지 이동
 * 3. driver.js SVG cutout 사용 (CSS hack 절대 금지)
 * 4. 페이지 간 상태: URL ?tour=N 파라미터
 */

import { useEffect, useState, useCallback, useRef, Suspense } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import FontFreeIcon from "../ui/FontFreeIcon";
import type { Driver } from "driver.js";

// 투어 완료 여부를 localStorage에 저장하는 키
const STORAGE_KEY = "stiz_tour_completed";

// 투어 완료 여부 확인
function isCompleted(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

// 투어 완료로 표시
function markCompleted() {
  try {
    localStorage.setItem(STORAGE_KEY, "true");
  } catch {}
}

// ========================================
// 투어 중단/재개를 위한 Phase 저장 함수들
// ========================================
const PHASE_KEY = "stiz_tour_phase";
const MENU_LAYOUT_CHANGE_EVENT = "stiz:tour-menu-layout-change";
let driverGeneration = 0;
let releaseMenuResizeGuard = () => {};

// 현재 진행 중인 Phase를 localStorage에 저장
function savePhase(phase: string) {
  try {
    localStorage.setItem(PHASE_KEY, phase);
  } catch {}
}

// 저장된 Phase 읽기 (없으면 null)
function getSavedPhase(): string | null {
  try {
    return localStorage.getItem(PHASE_KEY);
  } catch {
    return null;
  }
}

// 저장된 Phase 삭제 (투어 완료 시)
function clearSavedPhase() {
  try {
    localStorage.removeItem(PHASE_KEY);
  } catch {}
}

/**
 * driver.js와 스타일을 동적 로드하는 헬퍼
 * 빌드 번들에 포함되지 않도록 dynamic import 사용
 */
async function loadDriver() {
  const { driver } = await import("driver.js");
  await import("driver.js/dist/driver.css");
  await import("./tourStyles.css");
  return (config: Parameters<typeof driver>[0]) => {
    releaseMenuResizeGuard();
    driverGeneration += 1;
    const removeResizeGuard = () => {
      window.removeEventListener("resize", checkMenuLayout);
      fontObserver.disconnect();
    };
    const checkMenuLayout = () => {
      const element = instance.getActiveElement();
      const step = instance.getActiveStep();
      if (!step || !isHiddenTourMenuTarget(element)) return;
      // 확인 카드의 자동 진행을 호출하지 않고 실제 닫기 경로로 정리한다.
      const close = step.popover?.onCloseClick ?? instance.getConfig().onCloseClick;
      if (close) close(element, step, { driver: instance, config: instance.getConfig(), state: instance.getState() });
      else instance.destroy();
      window.dispatchEvent(new Event(MENU_LAYOUT_CHANGE_EVENT));
    };
    const fontObserver = new MutationObserver(checkMenuLayout);
    releaseMenuResizeGuard = removeResizeGuard;
    const instance = driver({
      // 강조 전환 도중 빠르게 확인하면 다음 단계가 생략되는 경합을 없앤다.
      animate: false,
      onPopoverRender: prepareTourPopover,
      ...config,
      onHighlighted: (...args) => {
        window.addEventListener("resize", checkMenuLayout);
        fontObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
        // 헤더가 실제 여유 공간을 측정한 뒤 메뉴를 바꾸는 시점도 확인한다.
        const header = document.querySelector("header.public-site-header[data-menu-layout]");
        if (header) fontObserver.observe(header, { attributes: true, attributeFilter: ["data-menu-layout"] });
        config?.onHighlighted?.(...args);
      },
      onDestroyed: (...args) => {
        removeResizeGuard();
        config?.onDestroyed?.(...args);
      },
    });
    return instance;
  };
}

function isHiddenTourMenuTarget(element: Element | undefined) {
  const target = element?.getAttribute("data-tour-target") ?? "";
  if (!element || (target !== "hamburger" && !target.startsWith("nav-") && !target.startsWith("mobile-nav-"))) return false;
  // 서랍 닫힘의 React 반영보다 먼저 발생한 폭·글씨 변경도 놓치지 않는다.
  if (target.startsWith("mobile-nav-") && !usesDrawerNavigation()) return true;
  const rect = element.getBoundingClientRect();
  return element.getClientRects().length === 0 || !!element.closest("[inert]") || getComputedStyle(element).visibility === "hidden"
    || rect.right <= 0 || rect.left >= window.innerWidth || rect.bottom <= 0 || rect.top >= window.innerHeight;
}

function waitForOpenedTourMenu(instance: Driver, selector: string, showMenu: () => void) {
  const button = document.querySelector('[data-tour-target="hamburger"]');
  if (!button) return;
  const generation = driverGeneration;
  const openMenu = () => {
    instance.destroy();
    window.setTimeout(() => {
      // 이전 안내의 늦은 콜백이 새 안내를 덮지 않도록 한다.
      if (generation !== driverGeneration) return;
      const target = document.querySelector(selector);
      if (!usesDrawerNavigation() || !target || isHiddenTourMenuTarget(target)) {
        window.dispatchEvent(new Event(MENU_LAYOUT_CHANGE_EVENT));
        return;
      }
      showMenu();
    }, 400);
  };
  const config = instance.getConfig();
  instance.setConfig({
    ...config,
    onDestroyed: (...args) => {
      button.removeEventListener("click", openMenu);
      config.onDestroyed?.(...args);
    },
  });
  button.addEventListener("click", openMenu, { once: true });
}

/**
 * DOM 요소가 나타날 때까지 폴링하는 헬퍼
 *
 * 페이지 이동 후 React 렌더링이 완료되기 전에 driver.js가
 * 실행되면 대상 요소를 못 찾는 문제를 해결한다.
 * 최대 maxWait(ms) 동안 interval(ms) 간격으로 요소를 찾고,
 * 시간 초과 시 null을 반환하여 호출자가 스킵 처리할 수 있게 한다.
 */
function waitForElement(
  selector: string,
  maxWait: number = 3000,
  interval: number = 100
): Promise<Element | null> {
  return new Promise((resolve) => {
    // 이미 있으면 바로 반환
    const existing = document.querySelector(selector);
    if (existing) {
      resolve(existing);
      return;
    }
    let elapsed = 0;
    const timer = setInterval(() => {
      elapsed += interval;
      const el = document.querySelector(selector);
      if (el) {
        clearInterval(timer);
        resolve(el);
      } else if (elapsed >= maxWait) {
        // 시간 초과 — 요소를 못 찾음
        clearInterval(timer);
        resolve(null);
      }
    }, interval);
  });
}

/**
 * 진행률 HTML을 생성하는 헬퍼
 * 각 popover description 앞에 "N/4 단계" 표시를 추가
 */
function progressLabel(step: number, total: number = 5): string {
  return `<span style="display:inline-block;color:#999;font-size:11px;margin-bottom:4px">${step}/${total} 단계</span><br/>`;
}

/**
 * 투어 완료 축하 토스트를 화면 하단에 표시
 * 5초 후 자동으로 사라진다
 */
function showCompletionToast() {
  const toast = document.createElement("div");
  toast.id = "tour-completion-toast";
  toast.innerHTML = `
    <div style="position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:99999;
      background:white;border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,0.15);
      padding:24px 32px;max-width:360px;text-align:center;
      animation:tourSlideUp 0.3s ease-out">
      <div style="font-size:36px;margin-bottom:8px">🎉</div>
      <div style="font-size:18px;font-weight:700;color:#1a1a2e;margin-bottom:6px">둘러보기 완료!</div>
      <div style="font-size:13px;color:#666;line-height:1.6">
        궁금한 프로그램을 찾으셨나요?<br/>
        <a href="/apply" style="color:var(--brand-accent);font-weight:600;text-decoration:underline">
          체험수업 신청하기 →
        </a>
      </div>
    </div>
  `;
  document.body.appendChild(toast);
  // 5초 후 서서히 사라짐
  setTimeout(() => {
    const inner = toast.querySelector("div");
    if (inner) {
      inner.style.opacity = "0";
      inner.style.transition = "opacity 0.3s";
    }
    setTimeout(() => toast.remove(), 300);
  }, 5000);
}

/**
 * 하이라이트된 링크 클릭 시 투어용 URL로 이동하는 헬퍼
 *
 * Next.js Link는 DOM href가 아닌 React props의 href를 사용하므로,
 * DOM의 href를 바꿔도 무시된다. 따라서 capture phase에서 이벤트를
 * 가로채서 routerPush로 직접 이동하는 방식을 사용한다.
 */
function setupLinkCapture(
  selector: string,
  tourUrl: string,
  driverInstance: { destroy: () => void },
  routerPush: (url: string) => void
): (() => void) | null {
  const link = document.querySelector(selector) as HTMLElement;
  if (!link) return null;

  const handleClick = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    driverInstance.destroy();
    routerPush(tourUrl);
  };

  // capture: true → Next.js Link의 React 합성 이벤트보다 먼저 실행
  link.addEventListener("click", handleClick, { capture: true, once: true });

  // cleanup 함수 반환 (driver 종료 시 리스너 제거)
  return () => {
    link.removeEventListener("click", handleClick, { capture: true });
  };
}

// ========================================
// Phase 1: 메인(/) -> 프로그램안내 메뉴 클릭 유도
// ========================================
function usesDrawerNavigation(): boolean {
  // 태블릿·큰 글씨도 실제 보이는 메뉴를 따라 안내한다.
  const trigger = document.querySelector<HTMLElement>('[data-tour-target="hamburger"]');
  return !!trigger && trigger.getClientRects().length > 0 && getComputedStyle(trigger).visibility !== "hidden";
}

function revealDesktopTourMenu(selector: string): () => void {
  // 안내 대상이 하위 메뉴라면 안내가 끝날 때까지 실제 메뉴도 펼쳐 둔다.
  const group = document.querySelector(selector)?.closest<HTMLElement>(".public-nav-group");
  if (!group) return () => {};
  const previous = group.getAttribute("data-public-tour-open");
  group.setAttribute("data-public-tour-open", "true");
  return () => {
    if (previous === null) group.removeAttribute("data-public-tour-open");
    else group.setAttribute("data-public-tour-open", previous);
  };
}

function refreshTourAfterHighlight(_element: unknown, _step: unknown, { driver }: {
  driver: { refresh: () => void };
}) {
  // 첫 표시의 스타일·위치 계산이 끝난 다음 프레임에 다시 정렬한다.
  driver.refresh();
}

function prepareTourPopover({ wrapper }: { wrapper: HTMLElement }) {
  // 첫 측정부터 폭을 확정해 큰 글씨의 최초 안내도 화면 밖으로 밀리지 않게 한다.
  wrapper.style.width = "min(340px, calc(100vw - 24px))";
}

async function runPhase1(routerPush: (url: string) => void) {
  savePhase("1"); // 재개 기능용 Phase 저장
  const driverFn = await loadDriver();
  const isMobile = usesDrawerNavigation();

  if (isMobile) {
    // 모바일: 먼저 햄버거 버튼을 하이라이트하여 메뉴 열기 유도
    const d = driverFn({
      showProgress: false,
      allowClose: true,
      smoothScroll: false, // B-1: sticky 헤더 스크롤 충돌 방지
      overlayColor: "rgba(0,0,0,0.6)",
      stageRadius: 8,
      stagePadding: 8,
      steps: [
        {
          element: '[data-tour-target="hamburger"]',
          popover: {
            title: "메뉴를 열어주세요",
            description:
              progressLabel(1) +
              "먼저 메뉴를 열어서 프로그램을 살펴볼 거예요.",
            side: "bottom" as const,
            align: "end" as const,
            showButtons: ["close"] as any,
          },
        },
      ],
    });
    d.drive();

    // 햄버거 클릭 감지 -> 사이드바 열린 후 메뉴 링크 하이라이트
    waitForOpenedTourMenu(d, '[data-tour-target="mobile-nav-programs"]', () => {
            // href 복원 함수를 저장할 변수
            let restoreHref: (() => void) | null = null;

            const d2 = driverFn({
              showProgress: false,
              allowClose: true,
              smoothScroll: false, // B-1: sticky 헤더 스크롤 충돌 방지
              overlayColor: "rgba(0,0,0,0.6)",
              stageRadius: 4,
              stagePadding: 4,
              steps: [
                {
                  element: '[data-tour-target="mobile-nav-programs"]',
                  popover: {
                    title: "프로그램 안내",
                    description:
                      progressLabel(1) +
                      "여기를 눌러서 프로그램과 수강료를 확인해보세요!",
                    side: "left" as const,
                    showButtons: ["close"] as any,
                  },
                },
              ],
              // B-2: driver 종료 시 href 복원
              onDestroyed: () => {
                if (restoreHref) restoreHref();
              },
            });
            d2.drive();

            // B-2: href 직접 교체 방식으로 Link 클릭 충돌 해결
            restoreHref = setupLinkCapture(
              '[data-tour-target="mobile-nav-programs"]',
              "/programs?tour=2",
              d2,
              routerPush
            );
    });
  } else {
    // PC: 데스크탑 네비의 "프로그램안내" 링크 하이라이트
    const restoreMenu = revealDesktopTourMenu('[data-tour-target="nav-programs"]');
    // href 복원 함수를 저장할 변수
    let restoreHref: (() => void) | null = null;

    const d = driverFn({
      showProgress: false,
      allowClose: true,
      smoothScroll: false, // B-1: sticky 헤더 스크롤 충돌 방지
      // 최초 스타일 적용과 메뉴 전개가 끝난 위치로 안내 말풍선을 다시 맞춘다.
      onHighlighted: refreshTourAfterHighlight,
      overlayColor: "rgba(0,0,0,0.6)",
      stageRadius: 8,
      stagePadding: 10,
      steps: [
        {
          element: '[data-tour-target="nav-programs"]',
          popover: {
            title: "프로그램 안내",
            description:
              progressLabel(1) +
              "먼저 프로그램을 살펴볼까요? 여기를 눌러주세요!",
            side: "bottom" as const,
            align: "center" as const,
            showButtons: ["close"] as any,
          },
        },
      ],
      // B-2: driver 종료 시 href 복원
      onDestroyed: () => {
        if (restoreHref) restoreHref();
        restoreMenu();
      },
    });
    d.drive();

    // B-2: href 직접 교체 방식으로 Link 클릭 충돌 해결
    restoreHref = setupLinkCapture(
      '[data-tour-target="nav-programs"]',
      "/programs?tour=2",
      d,
      routerPush
    );
  }
}

// ========================================
// Phase 2: 프로그램(/programs?tour=2)
// 프로그램 카드 확인 -> 수업시간표 클릭 유도
// ========================================
async function runPhase2(routerPush: (url: string) => void) {
  savePhase("2"); // 재개 기능용 Phase 저장
  const driverFn = await loadDriver();
  // 첫 번째 프로그램 카드만 하이라이트 — 전체 그리드는 viewport보다 커서 하이라이트 효과가 없음
  const cardEl = await waitForElement('[data-tour-target="program-cards"] > div:first-child');

  // 요소를 못 찾으면 카드 하이라이트를 건너뛰고 네비 안내로 스킵
  if (!cardEl) {
    highlightScheduleNav(driverFn, routerPush);
    return;
  }

  // 첫 번째 카드가 보이도록 먼저 스크롤
  cardEl.scrollIntoView({ behavior: "smooth", block: "start" });

  // X 버튼 클릭 시 투어 중단, "확인했어요" 클릭 시 다음 Phase로 진행
  let closedByUser = false;

  const d = driverFn({
    showProgress: false,
    allowClose: false,
    // 정보 확인 페이지: 오버레이 없이 말풍선만 (콘텐츠를 가리지 않음)
    overlayOpacity: 0,
    stagePadding: 0,
    doneBtnText: "확인했어요",
    nextBtnText: "확인했어요",
    steps: [
      {
        element: '[data-tour-target="program-cards"]',
        popover: {
          title: "프로그램 안내 📋",
          description:
            progressLabel(2) +
            "스크롤하여 프로그램과 수강료를 확인하세요!",
          side: "bottom" as const,
          showButtons: ["close", "next"] as any,
        },
      },
    ],
    // X 버튼 클릭: 투어 중단 (다음 단계 실행 안 함)
    onCloseClick: () => {
      closedByUser = true;
      clearSavedPhase();
      d.destroy();
    },
    onDestroyed: () => {
      if (closedByUser) return; // X로 닫으면 다음 단계 실행 안 함
      setTimeout(
        () => highlightScheduleNav(driverFn, routerPush),
        100
      );
    },
  });

  // 스크롤 완료 후 driver 시작
  setTimeout(() => d.drive(), 500);
}

/** 시간표 네비게이션 하이라이트 (Phase 2에서 호출) */
function highlightScheduleNav(
  driverFn: any,
  routerPush: (url: string) => void,
) {
  if (usesDrawerNavigation()) {
    // 모바일: 햄버거 -> 사이드바 -> 시간표 링크
    const d = driverFn({
      showProgress: false,
      allowClose: true,
      smoothScroll: false, // B-1: sticky 헤더 스크롤 충돌 방지
      overlayColor: "rgba(0,0,0,0.6)",
      stageRadius: 8,
      stagePadding: 8,
      steps: [
        {
          element: '[data-tour-target="hamburger"]',
          popover: {
            title: "시간표를 볼까요?",
            description: progressLabel(2) + "메뉴를 열어주세요!",
            side: "bottom" as const,
            align: "end" as const,
            showButtons: ["close"] as any,
          },
        },
      ],
    });
    d.drive();
    waitForOpenedTourMenu(d, '[data-tour-target="mobile-nav-schedule"]', () => {
            let restoreHref: (() => void) | null = null;

            const d2 = driverFn({
              showProgress: false,
              allowClose: true,
              smoothScroll: false, // B-1: sticky 헤더 스크롤 충돌 방지
              overlayColor: "rgba(0,0,0,0.6)",
              stageRadius: 4,
              stagePadding: 4,
              steps: [
                {
                  element: '[data-tour-target="mobile-nav-schedule"]',
                  popover: {
                    title: "수업시간표",
                    description:
                      progressLabel(2) +
                      "여기를 눌러서 시간표를 확인해보세요!",
                    side: "left" as const,
                    showButtons: ["close"] as any,
                  },
                },
              ],
              onDestroyed: () => {
                if (restoreHref) restoreHref();
              },
            });
            d2.drive();

            // B-2: href 직접 교체
            restoreHref = setupLinkCapture(
              '[data-tour-target="mobile-nav-schedule"]',
              "/schedule?tour=3",
              d2,
              routerPush
            );
    });
  } else {
    // PC: 데스크탑 네비의 "수업시간표" 링크
    const restoreMenu = revealDesktopTourMenu('[data-tour-target="nav-schedule"]');
    let restoreHref: (() => void) | null = null;

    const d = driverFn({
      showProgress: false,
      allowClose: true,
      smoothScroll: false, // B-1: sticky 헤더 스크롤 충돌 방지
      onHighlighted: refreshTourAfterHighlight,
      overlayColor: "rgba(0,0,0,0.6)",
      stageRadius: 8,
      stagePadding: 10,
      steps: [
        {
          element: '[data-tour-target="nav-schedule"]',
          popover: {
            title: "수업시간표",
            description:
              progressLabel(2) +
              "시간표도 확인해볼까요? 여기를 눌러주세요!",
            side: "bottom" as const,
            showButtons: ["close"] as any,
          },
        },
      ],
      onDestroyed: () => {
        if (restoreHref) restoreHref();
        restoreMenu();
      },
    });
    d.drive();

    // B-2: href 직접 교체
    restoreHref = setupLinkCapture(
      '[data-tour-target="nav-schedule"]',
      "/schedule?tour=3",
      d,
      routerPush
    );
  }
}

// ========================================
// Phase 3: 시간표(/schedule?tour=3)
// 시간표 그리드 확인 -> 수업 찾기 클릭 유도
// ========================================
async function runPhase3(routerPush: (url: string) => void) {
  savePhase("3"); // 재개 기능용 Phase 저장
  const driverFn = await loadDriver();
  const gridEl = await waitForElement('[data-tour-target="schedule-grid"]');

  if (!gridEl) {
    highlightSimulatorNav(driverFn, routerPush);
    return;
  }

  // 시간표 상단으로 스크롤
  gridEl.scrollIntoView({ behavior: "smooth", block: "start" });

  let closedByUser = false;

  const d = driverFn({
    showProgress: false,
    allowClose: false,
    // 정보 확인 페이지: 오버레이 없이 말풍선만 (시간표를 가리지 않음)
    overlayOpacity: 0,
    stagePadding: 0,
    doneBtnText: "확인했어요",
    nextBtnText: "확인했어요",
    steps: [
      {
        element: '[data-tour-target="schedule-grid"]',
        popover: {
          title: "수업 시간표 📅",
          description:
            progressLabel(3) + "스크롤하여 시간표를 확인하세요!",
          side: "bottom" as const,
          showButtons: ["close", "next"] as any,
        },
      },
    ],
    // X 버튼 클릭: 투어 중단 (다음 단계 실행 안 함)
    onCloseClick: () => {
      closedByUser = true;
      clearSavedPhase();
      d.destroy();
    },
    onDestroyed: () => {
      if (closedByUser) return; // X로 닫으면 다음 단계 실행 안 함
      setTimeout(
        () => highlightSimulatorNav(driverFn, routerPush),
        100
      );
    },
  });

  // 스크롤 완료 후 driver 시작 (500ms 대기)
  setTimeout(() => d.drive(), 500);
}

/** 수업 찾기 네비게이션 하이라이트 (Phase 3에서 호출) */
function highlightSimulatorNav(
  driverFn: any,
  routerPush: (url: string) => void,
) {
  if (usesDrawerNavigation()) {
    // 모바일: 햄버거 -> 사이드바 -> 수업 찾기 링크
    const d = driverFn({
      showProgress: false,
      allowClose: true,
      smoothScroll: false, // B-1: sticky 헤더 스크롤 충돌 방지
      overlayColor: "rgba(0,0,0,0.6)",
      stageRadius: 8,
      stagePadding: 8,
      steps: [
        {
          element: '[data-tour-target="hamburger"]',
          popover: {
            title: "수업을 찾아볼까요?",
            description: progressLabel(3) + "메뉴를 열어주세요!",
            side: "bottom" as const,
            align: "end" as const,
            showButtons: ["close"] as any,
          },
        },
      ],
    });
    d.drive();
    waitForOpenedTourMenu(d, '[data-tour-target="mobile-nav-simulator"]', () => {
            let restoreHref: (() => void) | null = null;

            const d2 = driverFn({
              showProgress: false,
              allowClose: true,
              smoothScroll: false, // B-1: sticky 헤더 스크롤 충돌 방지
              overlayColor: "rgba(0,0,0,0.6)",
              stageRadius: 4,
              stagePadding: 4,
              steps: [
                {
                  element: '[data-tour-target="mobile-nav-simulator"]',
                  popover: {
                    title: "우리 아이 수업 찾기",
                    description:
                      progressLabel(3) + "딱 맞는 수업을 찾아볼까요?",
                    side: "left" as const,
                    showButtons: ["close"] as any,
                  },
                },
              ],
              onDestroyed: () => {
                if (restoreHref) restoreHref();
              },
            });
            d2.drive();

            // B-2: href 직접 교체
            restoreHref = setupLinkCapture(
              '[data-tour-target="mobile-nav-simulator"]',
              "/simulator?tour=4",
              d2,
              routerPush
            );
    });
  } else {
    // PC: 데스크탑 네비의 "우리 아이 수업 찾기" 링크
    let restoreHref: (() => void) | null = null;

    const d = driverFn({
      showProgress: false,
      allowClose: true,
      smoothScroll: false, // B-1: sticky 헤더 스크롤 충돌 방지
      overlayColor: "rgba(0,0,0,0.6)",
      stageRadius: 8,
      stagePadding: 10,
      steps: [
        {
          element: '[data-tour-target="nav-simulator"]',
          popover: {
            title: "우리 아이 수업 찾기",
            description:
              progressLabel(3) +
              "딱 맞는 수업을 찾아볼까요? 여기를 눌러주세요!",
            side: "bottom" as const,
            showButtons: ["close"] as any,
          },
        },
      ],
      onDestroyed: () => {
        if (restoreHref) restoreHref();
      },
    });
    d.drive();

    // B-2: href 직접 교체
    restoreHref = setupLinkCapture(
      '[data-tour-target="nav-simulator"]',
      "/simulator?tour=4",
      d,
      routerPush
    );
  }
}

/**
 * 투어 완료 공통 헬퍼
 * Phase 저장 삭제 + 완료 표시 + 축하 토스트를 한 곳에서 처리한다.
 * 여러 곳에서 동일한 완료 로직을 반복하지 않기 위해 추출.
 */
function finishTour() {
  clearSavedPhase();
  markCompleted();
  showCompletionToast();
}

// ========================================
// Phase 4: 시뮬레이터(/simulator?tour=4)
// 5단계 서브스텝: 학년 선택 -> 다음 버튼 -> 요일/시간 안내 -> 수업 찾기 -> 결과 확인
// 사용자가 시뮬레이터를 직접 조작하면서 투어가 단계별로 안내하는 게임 튜토리얼 방식
// ========================================
async function runPhase4(routerPush: (url: string) => void) {
  savePhase("4"); // 재개 기능용 Phase 저장
  const driverFn = await loadDriver();

  // --- 서브스텝 4-1: 학년 선택 드롭다운 하이라이트 ---
  const selectEl = await waitForElement('[data-tour-target="grade-select"]');

  // 요소를 못 찾으면 투어를 완료 처리 (에러 없이 정상 종료)
  if (!selectEl) {
    finishTour();
    return;
  }

  let closedByUser = false;

  // 4-1: 학년 선택 카드 전체를 하이라이트
  // 학년 선택 + "다음 단계" 클릭을 하나의 스텝으로 안내
  const d1 = driverFn({
    showProgress: false,
    allowClose: false,
    overlayColor: "rgba(0,0,0,0.5)",
    stageRadius: 12,
    stagePadding: 10,
    steps: [
      {
        element: '[data-tour-target="grade-select"]',
        popover: {
          title: "학년을 선택해 주세요 📝",
          description:
            progressLabel(4) +
            "학년을 선택하고 '다음 단계' 버튼을 눌러주세요!",
          side: "top" as const,
          showButtons: ["close"] as any,
        },
      },
    ],
    onCloseClick: () => {
      closedByUser = true;
      clearSavedPhase();
      d1.destroy();
    },
  });
  d1.drive();

  // "다음 단계" 버튼 클릭을 감지 → step 2로 전환됨 → grade-select가 DOM에서 사라짐
  // 그래서 "다음 단계" 클릭 시 즉시 driver를 destroy하고 step 2 대기로 넘어감
  await new Promise<void>((resolve) => {
    if (closedByUser) { resolve(); return; }

    // "다음 단계" 버튼 클릭 감지 (grade-select 카드 안의 버튼)
    const checkAndBind = () => {
      const nextBtn = document.querySelector('[data-tour-target="grade-select"] button') as HTMLElement;
      if (nextBtn) {
        nextBtn.addEventListener("click", () => {
          d1.destroy();
          resolve();
        }, { once: true });
      } else {
        // 버튼이 아직 없으면 100ms 후 재시도
        setTimeout(checkAndBind, 100);
      }
    };
    checkAndBind();
  });

  if (closedByUser) return;

  // --- 서브스텝 4-2: 요일/시간대 선택 안내 ---
  // step 전환 후 step2 카드가 렌더링될 때까지 대기
  await waitForStep2Card(driverFn, closedByUser, routerPush);
}

/**
 * 서브스텝 4-3 ~ 4-5: 2단계 카드가 나타난 후의 안내 흐름
 * - 4-3: 요일/시간대 선택 영역 안내 (읽기 전용)
 * - 4-4: "수업 찾기" 버튼 클릭 유도
 * - 4-5: 결과 카드 확인 + 투어 완료
 */
async function waitForStep2Card(driverFn: any, parentClosed: boolean, routerPush: (url: string) => void) {
  if (parentClosed) return;

  // 2단계 카드가 렌더링될 때까지 대기 (step 전환 애니메이션 포함)
  const step2Card = await waitForElement('[data-tour-target="sim-step2-card"]');
  if (!step2Card) {
    finishTour();
    return;
  }

  let closedByUser = false;

  // 요일/시간 선택: 오버레이 없이 말풍선만 (사용자가 자유롭게 조작)
  const d3 = driverFn({
    showProgress: false,
    allowClose: false,
    overlayOpacity: 0,
    stagePadding: 0,
    doneBtnText: "선택했어요",
    nextBtnText: "선택했어요",
    steps: [
      {
        element: '[data-tour-target="sim-step2-card"]',
        popover: {
          title: "요일과 시간을 선택하세요 📅",
          description:
            progressLabel(4) +
            "요일과 시간대를 선택하고 '수업 찾기'를 눌러주세요!",
          side: "top" as const,
          showButtons: ["close", "next"] as any,
        },
      },
    ],
    onCloseClick: () => {
      closedByUser = true;
      clearSavedPhase();
      d3.destroy();
    },
    onDestroyed: () => {
      if (closedByUser) return;
      // "선택했어요" 클릭 후 → 바로 "수업 찾기" 버튼 안내
      setTimeout(() => runSubStep4_4(driverFn, routerPush), 100);
    },
  });

  // step2 카드로 자동 스크롤 후 드라이브
  step2Card.scrollIntoView({ behavior: "smooth", block: "center" });
  setTimeout(() => d3.drive(), 400);
}

/**
 * 서브스텝 4-4: "수업 찾기" 버튼 클릭 유도
 * 사용자가 직접 버튼을 눌러서 3단계(결과)로 이동하게 한다.
 */
async function runSubStep4_4(driverFn: any, routerPush: (url: string) => void) {
  const searchBtn = await waitForElement('[data-tour-target="sim-search-btn"]');
  if (!searchBtn) {
    finishTour();
    return;
  }

  let closedByUser = false;

  // 수업 찾기 버튼으로 스크롤
  (searchBtn as HTMLElement).scrollIntoView({ behavior: "smooth", block: "center" });

  const d4 = driverFn({
    showProgress: false,
    allowClose: false,
    overlayColor: "rgba(0,0,0,0.5)",
    stageRadius: 12,
    stagePadding: 10,
    steps: [
      {
        element: '[data-tour-target="sim-search-btn"]',
        popover: {
          title: "수업을 찾아볼까요? 🔍",
          description:
            progressLabel(4) +
            "'수업 찾기' 버튼을 눌러보세요!",
          side: "top" as const,
          showButtons: ["close"] as any,
        },
      },
    ],
    onCloseClick: () => {
      closedByUser = true;
      clearSavedPhase();
      d4.destroy();
    },
  });
  d4.drive();

  // "수업 찾기" 버튼 클릭 감지 -> 3단계(결과) 표시
  await new Promise<void>((resolve) => {
    if (closedByUser) { resolve(); return; }

    const onClick = () => {
      d4.destroy();
      resolve();
    };
    (searchBtn as HTMLElement).addEventListener("click", onClick, { once: true });
  });

  if (closedByUser) return;

  // --- 서브스텝 4-5: 결과 카드 확인 → 체험신청 페이지로 안내 ---
  await runSubStep4_5(driverFn, routerPush);
}

/**
 * 서브스텝 4-5: 검색 결과 확인 → 체험신청 페이지로 안내
 */
async function runSubStep4_5(driverFn: any, routerPush: (url: string) => void) {
  const resultsEl = await waitForElement('[data-tour-target="sim-results"]');
  if (!resultsEl) {
    routerPush("/apply?tour=5");
    return;
  }

  resultsEl.scrollIntoView({ behavior: "smooth", block: "start" });

  let closedByUser = false;

  const d5 = driverFn({
    showProgress: false,
    allowClose: false,
    // 정보 확인: 오버레이 없이 말풍선만 (결과를 자유롭게 확인)
    overlayOpacity: 0,
    stagePadding: 0,
    doneBtnText: "체험수업 신청하러 가기!",
    nextBtnText: "체험수업 신청하러 가기!",
    steps: [
      {
        element: '[data-tour-target="sim-results"]',
        popover: {
          title: "수업을 찾았어요! 🎉",
          description:
            progressLabel(4) +
            "스크롤하여 결과를 확인하고, 체험수업을 신청해보세요!",
          side: "bottom" as const,
          showButtons: ["close", "next"] as any,
        },
      },
    ],
    onCloseClick: () => {
      closedByUser = true;
      clearSavedPhase();
      d5.destroy();
    },
    onDestroyed: () => {
      if (closedByUser) return;
      // "체험수업 신청하러 가기!" 클릭 → /apply 페이지로 이동 (Phase 5)
      routerPush("/apply?tour=5");
    },
  });
  d5.drive();
}

// ========================================
// Phase 5: 체험신청(/apply?tour=5)
// "체험수업 신청하기" 버튼 하이라이트 → 클릭 시 투어 종료
// ========================================
async function runPhase5() {
  savePhase("5");
  const driverFn = await loadDriver();

  const btn = await waitForElement('[data-tour-target="trial-apply-btn"]');
  if (!btn) {
    finishTour();
    return;
  }

  // 다른 Phase에는 있는데 여기만 누락됐던 scrollIntoView 추가
  (btn as HTMLElement).scrollIntoView({ behavior: "smooth", block: "center" });

  let closedByUser = false;

  const d = driverFn({
    showProgress: false,
    allowClose: false,
    overlayColor: "rgba(0,0,0,0.5)",
    stageRadius: 12,
    stagePadding: 10,
    steps: [
      {
        element: '[data-tour-target="trial-apply-btn"]',
        popover: {
          title: "체험수업을 신청해 보세요! 🏀",
          description:
            progressLabel(5) +
            "체험수업을 신청하면 실제 수업을 경험할 수 있어요! (체험비 1만원)",
          side: "top" as const,
          showButtons: ["close"] as any,
        },
      },
    ],
    onCloseClick: () => {
      closedByUser = true;
      clearSavedPhase();
      d.destroy();
    },
  });
  d.drive();

  // "체험수업 신청하기" 버튼 클릭 감지 → 투어 완료
  (btn as HTMLElement).addEventListener("click", () => {
    d.destroy();
    finishTour();
  }, { once: true });
}

// ========================================
// 메인 컴포넌트
// ========================================

function TourTriggerInner({ autoStart = false }: { autoStart?: boolean }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const [mounted, setMounted] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // URL의 ?tour=N 파라미터 읽기
  const tourPhase = searchParams.get("tour");
  // router를 ref로 저장하여 useEffect 의존성에서 제외 (재실행 방지)
  const routerRef = useRef(router);
  routerRef.current = router;
  const routerPush = useCallback(
    (url: string) => routerRef.current.push(url),
    []
  );

  useEffect(() => {
    const restartMenuGuide = async () => {
      const phase = getSavedPhase();
      if (phase === "1") {
        await runPhase1(routerPush);
      } else if (phase === "2" || phase === "3") {
        const driverFn = await loadDriver();
        // 이미 확인한 정보 카드는 반복하지 않고 현재 메뉴 안내만 다시 연다.
        if (phase === "2") highlightScheduleNav(driverFn, routerPush);
        else highlightSimulatorNav(driverFn, routerPush);
      }
    };
    window.addEventListener(MENU_LAYOUT_CHANGE_EVENT, restartMenuGuide);
    return () => window.removeEventListener(MENU_LAYOUT_CHANGE_EVENT, restartMenuGuide);
  }, [routerPush]);

  // ?tour=N 파라미터에 따라 해당 Phase 자동 실행 (1회만)
  const hasRunPhase = useRef<string | null>(null);
  useEffect(() => {
    if (!mounted || !tourPhase) return;
    // 같은 phase를 중복 실행하지 않음
    if (hasRunPhase.current === tourPhase) return;
    hasRunPhase.current = tourPhase;

    const timer = setTimeout(() => {
      switch (tourPhase) {
        case "2":
          runPhase2(routerPush);
          break;
        case "3":
          runPhase3(routerPush);
          break;
        case "4":
          runPhase4(routerPush);
          break;
        case "5":
          runPhase5();
          break;
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [mounted, tourPhase, routerPush]);

  // 첫 방문 자동 제안 (메인 페이지에서 3초 후 토스트 표시)
  useEffect(() => {
    if (!mounted || pathname !== "/" || tourPhase || isCompleted()) return;
    const timer = setTimeout(() => setShowPrompt(true), 3000);
    return () => clearTimeout(timer);
  }, [mounted, pathname, tourPhase]);

  // 투어를 처음부터 시작하는 함수
  const startTourFromBeginning = useCallback(() => {
    setShowPrompt(false);
    clearSavedPhase();
    runPhase1(routerPush);
  }, [routerPush]);

  // "입학 가이드" 버튼 또는 토스트에서 투어 시작 (재개 지원)
  const startTour = useCallback(() => {
    setShowPrompt(false);
    const savedPhase = getSavedPhase();

    // 저장된 Phase가 2 이상이면 해당 페이지로 바로 이동
    if (savedPhase && parseInt(savedPhase) >= 2) {
      const phasePages: Record<string, string> = {
        "2": "/programs?tour=2",
        "3": "/schedule?tour=3",
        "4": "/simulator?tour=4",
        "5": "/apply?tour=5",
      };
      if (phasePages[savedPhase]) {
        routerPush(phasePages[savedPhase]);
        return;
      }
    }

    // Phase 1부터 시작
    runPhase1(routerPush);
  }, [routerPush]);

  const hasAutoStarted = useRef(false);
  useEffect(() => {
    if (!mounted || !autoStart || hasAutoStarted.current) return;
    hasAutoStarted.current = true;
    startTour();
  }, [autoStart, mounted, startTour]);

  // 토스트 닫기 (투어 완료로 처리하여 다시 안 뜨게)
  const dismissPrompt = useCallback(() => {
    setShowPrompt(false);
    markCompleted();
  }, []);

  // 투어 진행 중이거나 admin 페이지면 버튼 숨김
  if (tourPhase || pathname.startsWith("/admin")) return null;

  // 클라이언트에서만 저장된 Phase 확인 (SSR 안전)
  const hasSavedPhase = mounted ? getSavedPhase() : null;

  return (
    <>
      {/* 플로팅 입학 가이드 버튼 — 챗봇 버튼 바로 위, 같은 열. 위치는 public-floating-btn--guide(CSS) */}
      <button
        onClick={startTour}
        className="public-floating-btn public-floating-btn--guide fixed right-6 z-50 w-14 h-14 rounded-full bg-white dark:bg-black text-brand-orange-500 dark:text-brand-neon-lime shadow-lg hover:shadow-xl hover:scale-105 transition-all duration-200 flex items-center justify-center border-2 border-brand-orange-500 dark:border-brand-neon-lime"
        aria-label="입학 가이드 시작"
        title="입학 가이드"
      >
        <FontFreeIcon name="school" size={26} />
      </button>

      {/* 첫 방문 자동 제안 토스트 -- 메인 페이지에서만, 3초 후 표시 */}
      {showPrompt && (
        <div className="public-floating-btn public-floating-btn--prompt fixed right-4 z-50 bg-white dark:bg-gray-800 rounded-2xl shadow-2xl p-5 max-w-xs border border-gray-100 dark:border-gray-800 animate-in slide-in-from-bottom-4">
          {hasSavedPhase ? (
            <>
              {/* 이전에 중단된 투어가 있는 경우 */}
              <p className="text-sm font-bold text-gray-900 dark:text-white mb-1">
                이어서 볼까요? 🏀
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
                이전에 보시던 둘러보기가 있어요.
              </p>
              <div className="flex gap-2">
                <button
                  onClick={startTourFromBeginning}
                  className="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-600 dark:text-gray-300 transition-colors"
                >
                  처음부터
                </button>
                <button
                  onClick={startTour}
                  className="px-4 py-1.5 text-xs font-bold text-white dark:text-black bg-brand-orange-500 dark:bg-brand-neon-lime dark:text-brand-navy-900 hover:bg-brand-orange-600 dark:hover:bg-lime-400 rounded-lg transition-colors"
                >
                  이어서 보기
                </button>
              </div>
            </>
          ) : (
            <>
              {/* 첫 방문 사용자 */}
              <p className="text-sm font-bold text-gray-900 dark:text-white mb-1">
                처음 오셨나요?
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
                학원 둘러보기를 시작할까요?
              </p>
              <div className="flex gap-2">
                <button
                  onClick={dismissPrompt}
                  className="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-600 dark:text-gray-300 transition-colors"
                >
                  괜찮아요
                </button>
                <button
                  onClick={startTour}
                  className="px-4 py-1.5 text-xs font-bold text-white dark:text-black bg-brand-orange-500 dark:bg-brand-neon-lime dark:text-brand-navy-900 hover:bg-brand-orange-600 dark:hover:bg-lime-400 rounded-lg transition-colors"
                >
                  시작하기
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}

// useSearchParams()는 반드시 Suspense 안에서 사용해야 함
export default function GuideTourTrigger({ autoStart = false }: { autoStart?: boolean }) {
  return (
    <Suspense fallback={null}>
      <TourTriggerInner autoStart={autoStart} />
    </Suspense>
  );
}
