"use client";

import { useEffect } from "react";
import { serviceWorkerAllowed } from "@/lib/storeApp";

const SERVICE_WORKER_URL = "/sw.js";

export default function PwaUpdater() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    // 스토어 앱 안: 서비스 워커를 쓰지 않는다 — 이미 등록된 것은 지운다(이유는 serviceWorkerAllowed 설명).
    // 지금 떠 있는 화면은 닫힐 때까지 옛 서비스 워커를 계속 쓰므로(화면 안 이동도 그 워커를 거친다),
    // 이 화면이 워커 아래에 있었고 실제로 지웠으면 한 번만 다시 불러온다. 한 번만 = sessionStorage 표시.
    if (!serviceWorkerAllowed(navigator.userAgent)) {
      const RELOAD_KEY = "stiz-app-sw-removed";
      const wasControlled = Boolean(navigator.serviceWorker.controller);
      navigator.serviceWorker
        .getRegistrations()
        .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
        .then((removed) => {
          if (!wasControlled || !removed.some(Boolean)) return;
          try {
            if (window.sessionStorage.getItem(RELOAD_KEY) === "1") return;
            window.sessionStorage.setItem(RELOAD_KEY, "1");
          } catch {
            return; // 저장소를 못 쓰면 반복 위험이 있어 다시 불러오지 않는다(앱을 다시 켜면 고쳐진다)
          }
          window.location.reload();
        })
        .catch(() => {});
      return;
    }

    const hadController = Boolean(navigator.serviceWorker.controller);
    let didReload = false;

    const reloadForFreshApp = () => {
      if (!hadController || didReload) return;
      didReload = true;
      window.location.reload();
    };

    const requestSkipWaiting = (worker?: ServiceWorker | null) => {
      worker?.postMessage({ type: "SKIP_WAITING" });
    };

    const handleControllerChange = () => {
      reloadForFreshApp();
    };

    navigator.serviceWorker.addEventListener("controllerchange", handleControllerChange);

    async function registerAndUpdate() {
      try {
        const registration = await navigator.serviceWorker.register(SERVICE_WORKER_URL, {
          updateViaCache: "none",
        });

        registration.addEventListener("updatefound", () => {
          const worker = registration.installing;
          if (!worker) return;

          worker.addEventListener("statechange", () => {
            if (worker.state === "installed" && navigator.serviceWorker.controller) {
              requestSkipWaiting(worker);
            }
          });
        });

        if (registration.waiting && navigator.serviceWorker.controller) {
          requestSkipWaiting(registration.waiting);
        }

        await registration.update();
      } catch (error) {
        console.warn("[PWA] Service worker update check failed", error);
      }
    }

    const updateWhenVisible = () => {
      if (document.visibilityState !== "visible") return;
      navigator.serviceWorker
        .getRegistration(SERVICE_WORKER_URL)
        .then((registration) => registration?.update())
        .catch(() => {});
    };

    registerAndUpdate();
    document.addEventListener("visibilitychange", updateWhenVisible);

    return () => {
      navigator.serviceWorker.removeEventListener("controllerchange", handleControllerChange);
      document.removeEventListener("visibilitychange", updateWhenVisible);
    };
  }, []);

  return null;
}
