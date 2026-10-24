"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createDriverGpsController, type GpsSnapshot } from "@/lib/shuttle/driverGpsController";
import { createNativeDriverGps, nativeGpsTransport } from "@/lib/shuttle/nativeDriverGps";
export type { GpsState, GpsTransmission } from "@/lib/shuttle/driverGpsController";

const subscribeMode = () => () => {};
const readMode = () => nativeGpsTransport(window) ? "native" as const : "web" as const;
const serverMode = () => "web" as const;

export function useGpsShare(token: string, label?: string) {
  const credentials = useRef({ token, label });
  useEffect(() => { credentials.current = { token, label }; }, [token, label]);
  const [snapshot, setSnapshot] = useState<GpsSnapshot>({ state: "off", transmission: "idle", lastSentAt: null, accuracy: null, lastLocationAt: null });
  const mode = useSyncExternalStore(subscribeMode, readMode, serverMode);
  const [nativeStatus, setNativeStatus] = useState<{ token: string; running: boolean; message: string | null } | null>(null);
  const controller = useRef<ReturnType<typeof createDriverGpsController> | null>(null);
  useEffect(() => {
    const transport = nativeGpsTransport(window);
    if (transport) {
      controller.current = createNativeDriverGps({ target: window, transport, credentials: () => credentials.current,
        publish: (value) => { setSnapshot(value); setNativeStatus({ token, running: value.running, message: value.message }); } });
    } else {
      controller.current = createDriverGpsController({ geolocation: navigator.geolocation, credentials: () => credentials.current, publish: setSnapshot });
    }
    return () => { controller.current?.dispose(); controller.current = null; };
  }, [token]);
  const start = useCallback(() => controller.current?.start(), []);
  const stop = useCallback(async () => controller.current?.stop() ?? false, []);
  return { ...snapshot, mode, nativeRunning: nativeStatus?.token === token && nativeStatus.running,
    nativeMessage: nativeStatus?.token === token ? nativeStatus.message : null,
    isOn: snapshot.state === "active" || snapshot.state === "requesting", start, stop };
}
