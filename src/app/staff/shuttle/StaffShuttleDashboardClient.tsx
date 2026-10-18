"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ShuttleRideStatusButtons from "./ShuttleRideStatusButtons";
import { confirmedTimeLabel } from "@/lib/shuttle/time";

type Direction = "PICKUP" | "DROPOFF";
type RideStatus = "PENDING" | "BOARDED" | "DROPPED_OFF" | "NO_SHOW";

type Passenger = {
  id: string;
  studentNameSnapshot?: string | null;
  rideStatus?: string | null;
};

type Stop = {
  id: string;
  name: string;
  address?: string | null;
  roadAddress?: string | null;
  latitude?: number | string | null;
  longitude?: number | string | null;
  // 관리자가 노선을 짜며 확정한 실제 도착 시각. 학부모에게 문자로 나가는 값과 같다.
  plannedAt?: string | Date | null;
  passengers: Passenger[];
};

type Route = {
  id: string;
  name: string;
  direction: Direction;
  serviceDate?: string | Date | null;
  passengerCount: number;
  vehicle?: { name?: string | null } | null;
  stops: Stop[];
};

type Dashboard = {
  todayKey: string;
  routes: Route[];
};

type RefreshMessage = { tone: "success" | "error"; text: string } | null;

const DONE_STATUSES = new Set<RideStatus>(["BOARDED", "DROPPED_OFF"]);
const SHUTTLE_AUTO_REFRESH_MS = 60_000;

export default function StaffShuttleDashboardClient({
  dashboard,
  canManageShuttle,
}: {
  dashboard: Dashboard;
  canManageShuttle: boolean;
}) {
  const [currentDashboard, setCurrentDashboard] = useState(dashboard);
  const [rideStatuses, setRideStatuses] = useState<Record<string, RideStatus>>(() => initialRideStatuses(dashboard.routes));
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState<RefreshMessage>(null);
  const refreshInFlightRef = useRef(false);
  const refreshAfterInFlightRef = useRef(false);
  const mutationVersionRef = useRef(0);
  const pendingMutationsRef = useRef(0);
  const { todayRoutes, upcomingRoutes, needsReviewRoutes } = useMemo(
    () => splitRoutesByDate(currentDashboard.routes, currentDashboard.todayKey),
    [currentDashboard],
  );
  const passengerCount = todayRoutes.reduce((sum, route) => sum + route.passengerCount, 0);
  const statusSummary = useMemo(() => summarizeRideStatuses(todayRoutes, rideStatuses), [todayRoutes, rideStatuses]);

  const refreshDashboard = useCallback(async (announce = false) => {
    if (refreshInFlightRef.current) {
      if (announce) {
        setIsRefreshing(true);
        setRefreshMessage(null);
      }
      return;
    }
    refreshInFlightRef.current = true;
    const mutationVersionAtStart = mutationVersionRef.current;
    if (announce) {
      setIsRefreshing(true);
      setRefreshMessage(null);
    }
    try {
      const response = await fetch("/api/staff/shuttle", { method: "GET", cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.dashboard) throw new Error(body.error || "운행 정보를 불러오지 못했습니다.");
      const nextDashboard = body.dashboard as Dashboard;
      setCurrentDashboard(nextDashboard);
      if (pendingMutationsRef.current === 0 && mutationVersionRef.current === mutationVersionAtStart) {
        setRideStatuses(initialRideStatuses(nextDashboard.routes));
      }
      if (announce) setRefreshMessage({ tone: "success", text: "최신 운행 정보를 불러왔습니다." });
    } catch (error) {
      if (announce) {
        setRefreshMessage({
          tone: "error",
          text: error instanceof Error ? error.message : "운행 정보를 불러오지 못했습니다.",
        });
      }
    } finally {
      refreshInFlightRef.current = false;
      setIsRefreshing(false);
      if (refreshAfterInFlightRef.current && pendingMutationsRef.current === 0) {
        refreshAfterInFlightRef.current = false;
        window.setTimeout(() => void refreshDashboard(), 0);
      }
    }
  }, []);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshDashboard();
    }, SHUTTLE_AUTO_REFRESH_MS);
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void refreshDashboard();
    };
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [refreshDashboard]);

  function handleStatusChange(passengerId: string, status: RideStatus) {
    mutationVersionRef.current += 1;
    setRideStatuses((current) => ({ ...current, [passengerId]: status }));
  }

  function handleMutationStateChange(isPending: boolean) {
    pendingMutationsRef.current = Math.max(0, pendingMutationsRef.current + (isPending ? 1 : -1));
    if (!isPending && pendingMutationsRef.current === 0) {
      if (refreshInFlightRef.current) refreshAfterInFlightRef.current = true;
      else void refreshDashboard();
    }
  }

  return (
    <main className="mx-auto min-h-[calc(100dvh-9rem)] max-w-lg px-4 py-5">
      {/* 운행 대시보드도 교사 홈과 같은 밝은 역할 헤더를 사용합니다. */}
      <section className="academy-hero rounded-3xl p-5 text-[var(--color-academy-ink)]">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-bold text-[var(--color-academy-muted)]">셔틀 기사 앱</p>
            <h1 className="mt-1 text-2xl font-black">오늘 운행</h1>
          </div>
          <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-[var(--brand-accent)] text-[var(--brand-accent-contrast)]">
            <span className="material-symbols-outlined" aria-hidden="true">airport_shuttle</span>
          </span>
        </div>
      </section>

      <section className="mt-4 grid grid-cols-2 gap-3">
        <StatusCard label="운행 상태" value={todayRoutes.length ? "확정" : "대기"} />
        <StatusCard label="오늘 노선" value={`${todayRoutes.length}개 · ${passengerCount}명`} />
      </section>

      <section className="mt-3 grid grid-cols-3 gap-2">
        <StatusCard label="체크 대기" value={`${statusSummary.pending}명`} tone={statusSummary.pending ? "warning" : "neutral"} compact />
        <StatusCard label="체크 완료" value={`${statusSummary.done}명`} tone="success" compact />
        <StatusCard label="미탑승" value={`${statusSummary.noShow}명`} tone={statusSummary.noShow ? "danger" : "neutral"} compact />
      </section>

      <section className="mt-4 flex items-center justify-between gap-3">
        <h2 className="font-black text-gray-900 dark:text-white">오늘 운행</h2>
        <button
          type="button"
          onClick={() => void refreshDashboard(true)}
          disabled={isRefreshing}
          className="flex min-h-10 shrink-0 items-center gap-1.5 rounded-xl bg-white px-3 text-xs font-black text-gray-700 shadow-sm disabled:opacity-60 dark:bg-gray-900 dark:text-gray-200"
        >
          <span className={`material-symbols-outlined text-lg ${isRefreshing ? "animate-spin" : ""}`} aria-hidden="true">refresh</span>
          {isRefreshing ? "불러오는 중" : "새로고침"}
        </button>
      </section>
      {refreshMessage && (
        <p className={`mt-2 text-xs font-bold ${refreshMessage.tone === "error" ? "text-red-600 dark:text-red-300" : "text-emerald-700 dark:text-emerald-300"}`} role={refreshMessage.tone === "error" ? "alert" : "status"}>
          {refreshMessage.text}
        </p>
      )}

      <section className="mt-3 space-y-3">
        {todayRoutes.length ? todayRoutes.map((route) => (
          <RouteCard key={route.id} route={route} rideStatuses={rideStatuses} onStatusChange={handleStatusChange} onMutationStateChange={handleMutationStateChange} canCheckRideStatus />
        )) : (
          <div className="rounded-3xl border border-dashed border-gray-300 bg-white p-8 text-center shadow-sm dark:border-gray-800 dark:bg-gray-900">
            <span className="material-symbols-outlined text-4xl text-gray-400" aria-hidden="true">event_busy</span>
            <h2 className="mt-3 font-black text-gray-900 dark:text-white">오늘 확정된 운행이 없습니다</h2>
            <p className="mt-2 text-sm leading-6 text-gray-500 dark:text-gray-400">
              관리자가 오늘 노선을 확정하면 여기에 표시됩니다.
            </p>
          </div>
        )}
      </section>

      {upcomingRoutes.length > 0 && (
        <section className="mt-6">
          <h2 className="font-black text-gray-900 dark:text-white">예정된 운행</h2>
          <div className="mt-3 space-y-3">
            {upcomingRoutes.map((route) => (
              <RouteCard key={route.id} route={route} rideStatuses={rideStatuses} onStatusChange={handleStatusChange} />
            ))}
          </div>
        </section>
      )}

      {needsReviewRoutes.length > 0 && (
        <section className="mt-6">
          <div>
            <h2 className="font-black text-gray-900 dark:text-white">일정 확인 필요</h2>
            <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">운행 날짜가 지정되지 않아 탑승 상태를 처리할 수 없는 노선입니다.</p>
          </div>
          <div className="mt-3 space-y-3">
            {needsReviewRoutes.map((route) => (
              <RouteCard key={route.id} route={route} rideStatuses={rideStatuses} onStatusChange={handleStatusChange} />
            ))}
          </div>
        </section>
      )}

      {canManageShuttle && (
        <Link
          href="/admin/shuttle"
          className="mt-4 flex min-h-12 items-center justify-center gap-2 rounded-2xl bg-[var(--brand-accent)] px-4 text-sm font-black text-[var(--brand-accent-contrast)] shadow-sm"
        >
          <span className="material-symbols-outlined" aria-hidden="true">settings</span>
          관리자 셔틀 설정으로 이동
        </Link>
      )}
    </main>
  );
}

function RouteCard({
  route,
  rideStatuses,
  onStatusChange,
  onMutationStateChange,
  canCheckRideStatus = false,
}: {
  route: Route;
  rideStatuses: Record<string, RideStatus>;
  onStatusChange: (passengerId: string, status: RideStatus) => void;
  onMutationStateChange?: (isPending: boolean) => void;
  canCheckRideStatus?: boolean;
}) {
  return (
    <article className="rounded-3xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-black text-[var(--brand-accent)]">
                  {route.direction === "PICKUP" ? "등원" : "하원"} · {formatRouteDate(route.serviceDate)}
                </p>
                <h2 className="mt-1 text-lg font-black text-gray-900 dark:text-white">{route.name}</h2>
                <p className="mt-1 text-xs font-bold text-gray-500 dark:text-gray-400">
                  {route.vehicle?.name || "차량 미지정"} · {route.passengerCount}명
                </p>
              </div>
              <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-200">
                <span className="material-symbols-outlined" aria-hidden="true">route</span>
              </span>
            </div>
            <ol className="mt-4 space-y-3">
              {route.stops.map((stop, index) => {
                const url = mapUrl(stop.latitude, stop.longitude, stop.name);
                // 관리자가 확정한 시각(UTC 저장)을 한국시간으로 바꿔 기사에게 보여준다.
                const plannedTime = confirmedTimeLabel(stop.plannedAt);
                const hasPlannedTime = plannedTime !== "시간 미정";
                return (
                  <li key={stop.id} className="rounded-2xl bg-gray-50 p-3 dark:bg-gray-950">
                    <div className="flex items-start gap-3">
                      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-gray-950 text-sm font-black text-white dark:bg-white dark:text-gray-950">{index + 1}</span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <h3 className="break-words text-sm font-black text-gray-900 dark:text-white">{stop.name}</h3>
                            <p className={`mt-1 inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-xs font-black ${hasPlannedTime ? "bg-white text-gray-900 shadow-sm dark:bg-gray-800 dark:text-white" : "bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-200"}`}>
                              <span className="material-symbols-outlined text-sm" aria-hidden="true">schedule</span>
                              확정 시간 {plannedTime}
                            </p>
                            <p className="mt-1 break-words text-xs leading-5 text-gray-500 dark:text-gray-400">{stop.roadAddress || stop.address}</p>
                          </div>
                          {url && (
                            <a href={url} target="_blank" rel="noreferrer" aria-label={`${stop.name} 지도에서 열기`} className="grid size-10 shrink-0 place-items-center rounded-xl bg-white text-gray-700 shadow-sm dark:bg-gray-800 dark:text-gray-200">
                              <span className="material-symbols-outlined" aria-hidden="true">map</span>
                            </a>
                          )}
                        </div>
                        <div className="mt-2 space-y-2">
                          {stop.passengers.map((passenger) => {
                            const rideStatus = rideStatuses[passenger.id] ?? normalizeRideStatus(passenger.rideStatus);
                            return (
                              <div key={passenger.id} className="rounded-2xl bg-white p-2 dark:bg-gray-900">
                                <div className="flex items-center justify-between gap-2">
                                  <span className="min-w-0 truncate text-sm font-black text-gray-800 dark:text-gray-100">
                                    {passenger.studentNameSnapshot || "학생"}
                                  </span>
                                  <RideStatusPill status={rideStatus} />
                                </div>
                                {canCheckRideStatus ? (
                                  <ShuttleRideStatusButtons
                                    routeId={route.id}
                                    passengerId={passenger.id}
                                    direction={route.direction}
                                    status={rideStatus}
                                    onStatusChange={(status) => onStatusChange(passenger.id, status)}
                                    onMutationStateChange={onMutationStateChange}
                                  />
                                ) : (
                                  <p className="mt-2 text-[11px] font-bold text-gray-400">운행 당일에 탑승 상태를 체크할 수 있습니다.</p>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>
          </article>
  );
}

function splitRoutesByDate(routes: Route[], todayKey: string) {
  const todayRoutes: Route[] = [];
  const upcomingRoutes: Route[] = [];
  const needsReviewRoutes: Route[] = [];
  for (const route of routes) {
    const serviceDateKey = routeDateKey(route.serviceDate);
    if (!serviceDateKey) needsReviewRoutes.push(route);
    else if (serviceDateKey === todayKey) todayRoutes.push(route);
    else if (serviceDateKey > todayKey) upcomingRoutes.push(route);
    else needsReviewRoutes.push(route);
  }
  return { todayRoutes, upcomingRoutes, needsReviewRoutes };
}

function routeDateKey(value?: string | Date | null) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function initialRideStatuses(routes: Route[]) {
  const statuses: Record<string, RideStatus> = {};
  for (const route of routes) {
    for (const stop of route.stops) {
      for (const passenger of stop.passengers) {
        statuses[passenger.id] = normalizeRideStatus(passenger.rideStatus);
      }
    }
  }
  return statuses;
}

function summarizeRideStatuses(routes: Route[], statuses: Record<string, RideStatus>) {
  const summary = { pending: 0, done: 0, noShow: 0 };
  for (const route of routes) {
    for (const stop of route.stops) {
      for (const passenger of stop.passengers) {
        const status = statuses[passenger.id] ?? normalizeRideStatus(passenger.rideStatus);
        if (status === "NO_SHOW") summary.noShow += 1;
        else if (DONE_STATUSES.has(status)) summary.done += 1;
        else summary.pending += 1;
      }
    }
  }
  return summary;
}

function normalizeRideStatus(status?: string | null): RideStatus {
  return status === "BOARDED" || status === "DROPPED_OFF" || status === "NO_SHOW" ? status : "PENDING";
}

function formatRouteDate(value?: string | Date | null) {
  if (!value) return "정기";
  return new Intl.DateTimeFormat("ko-KR", { month: "short", day: "numeric", weekday: "short" }).format(new Date(value));
}

function mapUrl(lat: number | string | null | undefined, lng: number | string | null | undefined, name: string) {
  if (lat == null || lng == null) return null;
  return `https://map.kakao.com/link/map/${encodeURIComponent(name)},${lat},${lng}`;
}

function RideStatusPill({ status }: { status: RideStatus }) {
  const label = status === "BOARDED" ? "탑승" : status === "DROPPED_OFF" ? "하차" : status === "NO_SHOW" ? "미탑승" : "대기";
  const color = status === "BOARDED" || status === "DROPPED_OFF"
    ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
    : status === "NO_SHOW"
      ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-200"
      : "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300";

  return <span className={`shrink-0 rounded-full px-2 py-1 text-[11px] font-black ${color}`}>{label}</span>;
}

function StatusCard({
  label,
  value,
  tone = "neutral",
  compact = false,
}: {
  label: string;
  value: string;
  tone?: "neutral" | "success" | "warning" | "danger";
  compact?: boolean;
}) {
  const toneClass =
    tone === "success"
      ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
      : tone === "warning"
        ? "bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-200"
        : tone === "danger"
          ? "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-200"
          : "bg-white text-gray-900 dark:bg-gray-900 dark:text-white";

  return (
    <div className={`rounded-2xl p-4 shadow-sm ${toneClass}`}>
      <p className={`font-bold opacity-70 ${compact ? "text-[11px]" : "text-xs"}`}>{label}</p>
      <p className={`mt-2 font-black ${compact ? "text-base" : "text-lg"}`}>{value}</p>
    </div>
  );
}
