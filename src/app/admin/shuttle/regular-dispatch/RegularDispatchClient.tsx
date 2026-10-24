"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import RouteSection from "@/components/seasonal/RouteSection";
import DriverLocationPanel from "@/components/admin/DriverLocationPanel";
import DriverRequestPanel from "@/components/admin/DriverRequestPanel";
import type { DispatchSuggestion } from "@/lib/seasonal/shuttle-optimize";

// 정규 셔틀 동적배차 — 요일별로 관리한다. 요일 탭을 고르면 그 요일의 등원 → 하원 노선을 함께 보여준다.
// 방학특강 배차 화면(DispatchClient)과 동일 UX 를 재사용하되, 관리 단위가 "날짜"가 아니라 "요일"이다.
// RouteSection 에 apiBase="/api/admin/regular/dispatch" 를 주입해 정규 저장/불러오기/재계산 엔드포인트를 태운다.
// 명단 편집(무료탑승 드래그·학생 상세 모달)은 방학특강 전용이라 rosterEditable=false 로 끈다.

const REGULAR_API = "/api/admin/regular/dispatch";
const DOW_LABEL: Record<string, string> = {
  Mon: "월요일", Tue: "화요일", Wed: "수요일", Thu: "목요일", Fri: "금요일", Sat: "토요일", Sun: "일요일",
};

export default function RegularDispatchClient({ weekdays, initialDay, initialPickup, initialDropoff, serviceMonth, months, classTimeMismatches, drivers }: {
  weekdays: string[];            // 셔틀 학생이 있는 요일 목록("Mon" 등, 월→일 정렬)
  initialDay: string;            // 최초 표시 요일
  initialPickup: DispatchSuggestion;
  initialDropoff: DispatchSuggestion;
  serviceMonth: string;
  months: string[];
  classTimeMismatches: { dayOfWeek: string; studentName: string; pickupClassTime: string | null; dropoffClassTime: string | null }[];
  drivers: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [selectedDay, setDay] = useState<string>(initialDay);
  // 월 이동 뒤 이전 요일에 명단이 없으면 새 달의 선택 가능한 요일로 즉시 맞춘다.
  const day = weekdays.length > 0 && !weekdays.includes(selectedDay)
    ? (weekdays.includes(initialDay) ? initialDay : weekdays[0]) : selectedDay;
  const [timelinePickup, setTimelinePickup] = useState<DispatchSuggestion>(initialPickup);
  const [timelineDropoff, setTimelineDropoff] = useState<DispatchSuggestion>(initialDropoff);
  const [pickupReady, setPickupReady] = useState(true);
  const [dropoffReady, setDropoffReady] = useState(true);
  const timelineLoading = !pickupReady || !dropoffReady || timelinePickup.date !== day || timelineDropoff.date !== day;
  const [timelineError, setTimelineError] = useState<string | null>(null);
  const visibleMismatches = classTimeMismatches.filter((row) => row.dayOfWeek === day);
  const timelineRows = useMemo(() => buildTimelineRows(timelinePickup, timelineDropoff), [timelinePickup, timelineDropoff]);
  // 등원·하원 섹션의 '저장 안 한 변경' 여부. 요일·월을 바꾸면 화면이 새 노선으로 바뀌어 편집이 사라지므로 먼저 묻는다.
  const [dirtyPickup, setDirtyPickup] = useState(false);
  const [dirtyDropoff, setDirtyDropoff] = useState(false);
  const onPickupDirty = useCallback((d: boolean) => setDirtyPickup(d), []);
  const onDropoffDirty = useCallback((d: boolean) => setDirtyDropoff(d), []);
  // 배차 월이 바뀌면(router.push ?month=) 이 컴포넌트는 그대로 남아 RouteSection 이 다시 불러오지 않는다.
  // 월마다 다른 refreshKey 를 넘겨 새 달 노선을 다시 불러오게 한다(편집·「저장 안 됨」도 초기화) — 옛 달 노선이 새 달로 저장되는 사고 방지.
  const monthRefreshKey = Number(serviceMonth.replace(/\D/g, "")) || 0;
  const confirmLeave = () => !(dirtyPickup || dirtyDropoff) || window.confirm("저장하지 않은 노선 수정이 있습니다. 이동하면 사라집니다. 계속할까요?");
  // 기사님 실시간 위치·변경 요청 — 옛 노선 편성 화면에만 있던 진입 버튼을 이 화면으로 옮겼다(2026-10-03).
  const [showDriverLocations, setShowDriverLocations] = useState(false);
  const [showDriverRequests, setShowDriverRequests] = useState(false);
  const [pendingRequestCount, setPendingRequestCount] = useState(0);
  const loadPendingRequestCount = useCallback(() => {
    fetch("/api/admin/driver-requests", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { requests?: { status: string }[] } | null) => {
        if (d?.requests) setPendingRequestCount(d.requests.filter((r) => r.status === "PENDING").length);
      })
      .catch(() => null);
  }, []);
  useEffect(() => { loadPendingRequestCount(); }, [loadPendingRequestCount]);

  const onPickupRoute = useCallback((route: DispatchSuggestion, state: { ready: boolean; dirty: boolean; saved: boolean }) => {
    setTimelinePickup({ ...route, loadedFromSaved: state.saved }); setPickupReady(state.ready); setTimelineError(null);
  }, []);
  const onDropoffRoute = useCallback((route: DispatchSuggestion, state: { ready: boolean; dirty: boolean; saved: boolean }) => {
    setTimelineDropoff({ ...route, loadedFromSaved: state.saved }); setDropoffReady(state.ready); setTimelineError(null);
  }, []);

  return (
    <div className="mx-auto max-w-6xl px-4 py-4">
      <div className="rounded-2xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <h3 className="text-base font-black text-gray-900 dark:text-white">정규 셔틀 배차 · 하루 타임라인</h3>
          <div className="flex flex-wrap items-end gap-2">
            <button type="button" onClick={() => setShowDriverLocations(true)} className="min-h-10 rounded-lg border border-gray-200 bg-white px-3 text-sm font-black text-gray-700 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100">🗺 실시간 위치</button>
            <button type="button" onClick={() => setShowDriverRequests(true)} className="relative min-h-10 rounded-lg border border-gray-200 bg-white px-3 text-sm font-black text-gray-700 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100">
              📥 기사 요청
              {pendingRequestCount > 0 && (
                <span className="absolute -right-1.5 -top-1.5 grid h-5 min-w-[20px] place-items-center rounded-full bg-red-500 px-1 text-[11px] font-black text-white">{pendingRequestCount}</span>
              )}
            </button>
          <label className="flex flex-col gap-1 text-[11px] font-bold text-gray-500">배차 월
            <select value={serviceMonth} onChange={(event) => confirmLeave() && router.push(`/admin/shuttle/regular-dispatch?month=${encodeURIComponent(event.target.value)}`)} className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-bold dark:border-gray-600 dark:bg-gray-900">
              {months.map((month) => <option key={month} value={month}>{month}</option>)}
            </select>
          </label>
          </div>
        </div>
        {showDriverLocations && <DriverLocationPanel onClose={() => setShowDriverLocations(false)} />}
        {showDriverRequests && <DriverRequestPanel onClose={() => { setShowDriverRequests(false); loadPendingRequestCount(); }} />}
        {/* 원장 결정(2026-10-02): 지금 기사님 화면은 「셔틀 명단」 순서(폴백)로 운행 중이 기준이다.
            여기서 저장하면 그 요일·방향 기사님 화면이 저장 노선으로 바뀌므로 먼저 알린다. */}
        <p className="mt-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-[12.5px] font-bold text-amber-900 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-100">
          ⚠ 저장한 노선은 선택한 월·요일·방향의 기사님 화면에 반영됩니다. 저장 전 변경은 기사님에게 보이지 않습니다.
        </p>

        <p className="mt-0.5 text-[12.5px] text-gray-500 dark:text-gray-400">
          정류장 위치는 셔틀 명단에 저장된 정보를 사용합니다.
        </p>

        {/* 요일 탭 — 노선 관리 단위 */}
        <div className="mt-3 flex flex-wrap items-center gap-1 rounded-xl bg-gray-100 p-1 dark:bg-gray-900">
          {weekdays.length === 0 && <span className="px-2 py-1 text-sm font-bold text-gray-400">셔틀 이용 학생이 있는 요일이 없습니다.</span>}
          {weekdays.map((w) => (
            <button key={w} onClick={() => { if (w !== day && confirmLeave()) setDay(w); }}
              className={`min-h-9 rounded-lg px-4 text-sm font-black ${day === w ? "bg-white text-brand-navy-900 shadow dark:bg-gray-700 dark:text-white" : "text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"}`}>
              {DOW_LABEL[w] ?? w}
            </button>
          ))}
        </div>

        {visibleMismatches.length > 0 && <div className="mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-100"><p className="font-black">⚠ 등원·하원 수업시간이 다른 학생 {visibleMismatches.length}명</p><ul className="mt-1 space-y-1">{visibleMismatches.map((row) => <li key={`${row.studentName}-${row.pickupClassTime}-${row.dropoffClassTime}`}><b>{row.studentName}</b> · 등원 {row.pickupClassTime} / 하원 {row.dropoffClassTime}</li>)}</ul><p className="mt-1 font-bold">자동으로 고치지 않았습니다. 셔틀 명단 탭에서 수업시간을 확인해 주세요.</p></div>}

        <p className="mt-3 text-[12.5px] font-black text-gray-700 dark:text-gray-200">📅 {DOW_LABEL[day] ?? day} 시간순 노선</p>
        <div className="mt-2 overflow-hidden rounded-2xl border border-gray-200 dark:border-gray-700">
          <div className="flex items-center justify-between bg-brand-navy-900 px-4 py-2.5 text-white">
            <span className="font-black">🚐 하루 운행 흐름 · {dirtyPickup || dirtyDropoff ? "저장 전 변경" : timelinePickup.loadedFromSaved && timelineDropoff.loadedFromSaved ? "저장 노선" : "표시 노선"}</span>
            <span className="rounded-full bg-white/15 px-2.5 py-0.5 text-xs font-bold">{timelineRows.length}개 정차</span>
          </div>
          {timelineLoading && <p className="px-4 py-3 text-sm font-bold text-gray-500 dark:text-gray-300">노선을 다시 계산 중입니다…</p>}
          {timelineError && <p className="px-4 py-3 text-sm font-bold text-red-500">⚠ {timelineError}</p>}
          {!timelineLoading && !timelineError && timelineRows.length === 0 && (
            <p className="px-4 py-6 text-center text-sm font-bold text-gray-400">이 요일에 표시할 셔틀 정차가 없습니다.</p>
          )}
          {!timelineLoading && timelineRows.length > 0 && (
            <ol className="divide-y divide-gray-100 dark:divide-gray-700">
              {timelineRows.map((row, index) => (
                <li key={`${row.direction}-${row.vehicle}-${row.time}-${row.label}-${index}`} className="flex items-start gap-2.5 px-3 py-2.5">
                  <span className={`mt-0.5 rounded-full px-2 py-0.5 text-[11px] font-black ${row.direction === "PICKUP" ? "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200" : "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-200"}`}>
                    {row.direction === "PICKUP" ? "승차" : "하차"}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="text-sm font-black text-gray-900 dark:text-white">{row.time}</span>
                      <span className="truncate text-sm font-bold text-gray-700 dark:text-gray-200">{row.label}</span>
                      {row.isHub && <span className="rounded bg-green-600 px-1.5 text-[10px] font-black text-white">무료탑승</span>}
                    </div>
                    <p className="mt-0.5 text-[11.5px] font-bold text-gray-500">{row.vehicle}{row.trip ? ` · ${row.trip}` : ""} · {row.students.join(", ")}</p>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>

        {/* 실제 편집 영역 — 기본으로 펼쳐 둔다(위 타임라인은 요약). 문구 "방향별 세부 조정 열기"는 테스트가 지킨다. */}
        <details open className="mt-3 rounded-2xl border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-900/40">
          <summary className="cursor-pointer text-sm font-black text-gray-800 dark:text-gray-100">방향별 세부 조정 열기</summary>
          <p className="mt-1 text-[12px] text-gray-500 dark:text-gray-400">등원·하원은 각각 저장합니다.</p>
          <div className="mt-3 space-y-3">
            <RouteSection initial={initialPickup} date={day} refreshKey={monthRefreshKey} apiBase={REGULAR_API} rosterEditable={false} serviceMonth={serviceMonth} drivers={drivers} regularEditing onDirtyChange={onPickupDirty} onRouteChange={onPickupRoute} />
            <RouteSection initial={initialDropoff} date={day} refreshKey={monthRefreshKey} apiBase={REGULAR_API} rosterEditable={false} serviceMonth={serviceMonth} drivers={drivers} regularEditing onDirtyChange={onDropoffDirty} onRouteChange={onDropoffRoute} />
          </div>
        </details>
      </div>
    </div>
  );
}

function etaToMinutes(value: string | undefined | null, fallback: number | undefined | null): number {
  if (typeof fallback === "number" && Number.isFinite(fallback)) return fallback;
  const match = String(value ?? "").match(/(\d{1,2}):(\d{2})/);
  if (!match) return 9999;
  return Number(match[1]) * 60 + Number(match[2]);
}

function buildTimelineRows(pickup: DispatchSuggestion, dropoff: DispatchSuggestion) {
  const toRows = (suggestion: DispatchSuggestion, direction: "PICKUP" | "DROPOFF") => suggestion.vehicles.flatMap((vehicle) =>
    vehicle.stops.map((stop) => ({
      direction,
      time: stop.etaLabel?.match(/(\d{1,2}:\d{2})/)?.[1] ?? "--:--",
      minutes: etaToMinutes(stop.etaLabel, stop.etaManual ?? stop.etaMinutes),
      label: stop.label,
      isHub: Boolean(stop.isHub),
      vehicle: vehicle.vehicleName,
      trip: vehicle.tripLabel,
      students: stop.students.map((student) => student.grade ? `${student.name}·${student.grade}` : student.name),
    })),
  );
  return [...toRows(pickup, "PICKUP"), ...toRows(dropoff, "DROPOFF")]
    .sort((a, b) => a.minutes - b.minutes || (a.direction === "PICKUP" ? -1 : 1));
}
