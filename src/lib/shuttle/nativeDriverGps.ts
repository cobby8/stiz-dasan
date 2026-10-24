import type { GpsSnapshot } from "./driverGpsController";

type NativeSnapshot = GpsSnapshot & { running: boolean; message: string | null };
type Transport = { postMessage: (message: string) => void };
type BridgeWindow = Window & { StizDriverGpsTransport?: Transport };

export function nativeGpsTransport(target: Window): Transport | null {
  const transport = (target as BridgeWindow).StizDriverGpsTransport;
  return transport && typeof transport.postMessage === "function" ? transport : null;
}

/** 기기 서비스의 상태를 읽는다. 화면이 닫혀도 native 서비스에는 중단을 요청하지 않는다. */
export function createNativeDriverGps(options: {
  target: Window;
  transport: Transport;
  credentials: () => { token: string; label?: string };
  publish: (snapshot: NativeSnapshot) => void;
}) {
  let disposed = false;
  let last: NativeSnapshot = { state: "off", transmission: "idle", lastSentAt: null, accuracy: null, lastLocationAt: null, running: false, message: null };
  let stopTimer: ReturnType<typeof setTimeout> | null = null;
  let resolveStop: ((ok: boolean) => void) | null = null;
  const publish = (snapshot: NativeSnapshot) => {
    last = snapshot;
    if (!disposed) options.publish(snapshot);
  };
  const post = (action: string) => options.transport.postMessage(JSON.stringify({ action, ...options.credentials() }));
  const asDate = (value: unknown): Date | null => {
    if (typeof value !== "string") return null;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? new Date(timestamp) : null;
  };
  function onSnapshot(event: Event) {
    const value: unknown = (event as CustomEvent).detail;
    if (!value || typeof value !== "object") return;
    const data = value as Record<string, unknown>;
    if (data.token !== options.credentials().token || typeof data.running !== "boolean") return;
    if (!["off", "requesting", "active", "denied", "error"].includes(String(data.state)) ||
        !["idle", "sending", "sent", "error", "stopping", "stopped", "stop-unknown"].includes(String(data.transmission))) return;
    publish({ state: data.state as GpsSnapshot["state"], transmission: data.transmission as GpsSnapshot["transmission"],
      lastSentAt: asDate(data.lastSentAt), lastLocationAt: asDate(data.lastLocationAt),
      accuracy: typeof data.accuracy === "number" && Number.isFinite(data.accuracy) && data.accuracy >= 0 ? data.accuracy : null,
      running: data.running, message: typeof data.error === "string" ? data.error.slice(0, 240) : null });
    if (resolveStop && !last.running && (last.transmission === "stopped" || last.transmission === "stop-unknown")) {
      if (stopTimer) clearTimeout(stopTimer);
      stopTimer = null;
      const resolve = resolveStop;
      resolveStop = null;
      resolve(last.transmission === "stopped");
    }
  }
  options.target.addEventListener("stiz-driver-gps", onSnapshot);
  // 재진입은 새 운행을 시작하지 않고 기기에 남은 실제 운행 상태를 복구한다.
  try { post("snapshot"); } catch { publish({ ...last, state: "error", transmission: "error" }); }
  return {
    start() {
      if (disposed || resolveStop) return;
      try { post("start"); } catch { publish({ ...last, state: "error", transmission: "error" }); }
    },
    stop(): Promise<boolean> {
      if (disposed || resolveStop) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        resolveStop = resolve;
        stopTimer = setTimeout(() => {
          stopTimer = null;
          resolveStop = null;
          // 응답이 없으면 기기 중단까지도 확인하지 못한 상태다. false로만 반환하고 사실을 꾸미지 않는다.
          resolve(false);
          publish({ ...last, transmission: "error" });
          try { post("snapshot"); } catch { /* 기기 연결 실패 상태를 유지한다. */ }
        }, 15_000);
        try { post("stop"); } catch {
          if (stopTimer) clearTimeout(stopTimer);
          stopTimer = null;
          resolveStop = null;
          publish({ ...last, state: "error", transmission: "error" });
          resolve(false);
        }
      });
    },
    dispose() {
      disposed = true;
      options.target.removeEventListener("stiz-driver-gps", onSnapshot);
      if (stopTimer) clearTimeout(stopTimer);
      stopTimer = null;
      resolveStop?.(false);
      resolveStop = null;
    },
  };
}
