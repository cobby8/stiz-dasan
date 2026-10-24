"use client";

import { useEffect, useState } from "react";
import { getDriverUpcoming, type DriverScheduledStop } from "@/lib/shuttle/driverUpcoming";

/** 화면 복귀·자정·휴대폰 시계 변경도 반영하되 서버 렌더와 최초 화면은 동일하게 시작합니다. */
export function useDriverUpcoming(stops: readonly DriverScheduledStop[], date: string) {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    const update = () => setNow(new Date());
    const onVisible = () => { if (!document.hidden) update(); };
    update();
    const timer = window.setInterval(update, 15_000);
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", update);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return now ? getDriverUpcoming(stops, date, now) : { nextKey: null, remainingMinutes: null, clockLabel: null, isViewingToday: false };
}
