"use client";

import { useEffect, useState } from "react";
import { STORE_APP_START_FLAG_KEY, appUpdateNotice, isInStoreAppForUpdateNotice, storeAppVersionOf, type AppUpdateNotice, type StoreAppLatest } from "@/lib/storeApp";
import { STORE_APP_PACKAGE, appUpdateTarget } from "@/lib/app-install-links";
import { loadStoreAppLatest } from "@/lib/storeApp/latestVersionClient";

/**
 * 업데이트 안내 판정을 화면에서 쓰는 훅 — 맨 위 배너와 설정 «앱 정보» 버전 줄이 같이 쓴다.
 * - 서버 그림·판정 전에는 null(아무것도 그리지 않는다).
 * - 브라우저(앱 아님)면 요청을 보내지 않고 바로 «none». «앱 안»은 isInStoreAppForUpdateNotice 로 좁게 본다.
 * - 앱 안이면 최신 버전을 한 번 알아 와(6시간 기억) @/lib/storeApp 의 appUpdateNotice 로 판정한다.
 */
export function useAppUpdateNotice(requiredMin: Partial<StoreAppLatest> | null = null): AppUpdateNotice | null {
  const [notice, setNotice] = useState<AppUpdateNotice | null>(null);
  const requiredAndroid = requiredMin?.android;
  const requiredIos = requiredMin?.ios;

  useEffect(() => {
    let alive = true;
    // 사용자 에이전트·앱 표식은 브라우저에서만 읽을 수 있어 화면이 뜬 뒤 판정한다
    const userAgent = window.navigator.userAgent;
    let storage: Storage | null = null;
    let startFlag: string | null = null;
    try {
      storage = window.sessionStorage;
      startFlag = storage.getItem(STORE_APP_START_FLAG_KEY);
    } catch {
      // 저장소를 못 쓰는 환경 — 기억 없이 진행
    }
    // 안내용 «앱 안» 판정은 좁게 본다(isStoreApp 은 다른 앱이 연 브라우저도 앱으로 볼 수 있다 — storeApp.ts 설명 참고)
    const inApp = isInStoreAppForUpdateNotice({ userAgent, referrer: document.referrer, startFlag, packageName: STORE_APP_PACKAGE });
    void loadStoreAppLatest({ inApp, fetchImpl: (url, init) => window.fetch(url, init), storage, nowMs: Date.now() }).then((latest) => {
      if (!alive) return;
      setNotice(
        latest
          ? appUpdateNotice({ inApp, app: storeAppVersionOf(userAgent), target: appUpdateTarget(userAgent), latest, requiredMin: { android: requiredAndroid, ios: requiredIos } })
          : { level: "none", storeUrl: null, latestVersion: "" }, // 브라우저
      );
    });
    return () => { alive = false; };
  }, [requiredAndroid, requiredIos]);

  return notice;
}
