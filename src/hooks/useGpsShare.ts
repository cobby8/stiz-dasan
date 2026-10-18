"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createDriverGpsController, type GpsSnapshot } from "@/lib/shuttle/driverGpsController";
export type { GpsState, GpsTransmission } from "@/lib/shuttle/driverGpsController";

export function useGpsShare(token: string, label?: string) {
  const credentials = useRef({ token, label });
  useEffect(() => { credentials.current = { token, label }; }, [token, label]);
  const [snapshot, setSnapshot] = useState<GpsSnapshot>({ state: "off", transmission: "idle", lastSentAt: null, accuracy: null, lastLocationAt: null });
  const controller = useRef<ReturnType<typeof createDriverGpsController> | null>(null);
  useEffect(() => {
    controller.current = createDriverGpsController({ geolocation: navigator.geolocation, credentials: () => credentials.current, publish: setSnapshot });
    return () => { controller.current?.dispose(); controller.current = null; };
  }, []);
  const start = useCallback(() => controller.current?.start(), []);
  const stop = useCallback(async () => controller.current?.stop() ?? false, []);
  return { ...snapshot, isOn: snapshot.state === "active" || snapshot.state === "requesting", start, stop };
}
