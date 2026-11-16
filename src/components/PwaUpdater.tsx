"use client";

import { useEffect } from "react";
import { serviceWorkerAllowed } from "@/lib/storeApp";

const SERVICE_WORKER_URL = "/sw.js";

export default function PwaUpdater() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    // 스토어 앱 안: 서비스 워커를 쓰지 않는다 — 이미 등록된 것은 지운다(이유는 serviceWorkerAllowed 설명).
    // 지운 뒤 다음 화면 이동부터 요청이 앱 이름표를 달고 서버로 바로 간다.
    if (!serviceWorkerAllowed(navigator.userAgent)) {
      navigator.serviceWorker
        .getRegistrations()
        .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
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
