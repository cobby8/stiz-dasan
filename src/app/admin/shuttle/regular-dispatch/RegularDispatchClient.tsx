"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import RouteSection from "@/components/seasonal/RouteSection";
import DriverLocationPanel from "@/components/admin/DriverLocationPanel";
import DriverRequestPanel from "@/components/admin/DriverRequestPanel";
import type { DispatchSuggestion } from "@/lib/seasonal/shuttle-optimize";

// 정규 셔틀 동적배차 — 요일별로 관리한다. 요일 탭을 고르면 그 요일의 등원·하원 회차를 시간순으로 섞어 보여준다.
// 방학특강 배차 화면(DispatchClient)과 동일 UX 를 재사용하되, 관리 단위가 "날짜"가 아니라 "요일"이다.
// RouteSection 에 apiBase="/api/admin/regular/dispatch" 를 주입해 정규 저장/불러오기/재계산 엔드포인트를 태운다.
// 명단 편집(무료탑승 드래그·학생 상세 모달)은 방학특강 전용이라 rosterEditable=false 로 끈다.

const REGULAR_API = "/api/admin/regular/dispatch";
const DOW_LABEL: Record<string, string> = {
  Mon: "월요일", Tue: "화요일", Wed: "수요일", Thu: "목요일", Fri: "금요일", Sat: "토요일", Sun: "일요일",
};

export default function RegularDispatchClient({ weekdays, initialDay, initialPickup, initialDropoff, serviceMonth, months, classTimeMismatches, drivers, initialStudentId }: {
  weekdays: string[];            // 셔틀 학생이 있는 요일 목록("Mon" 등, 월→일 정렬)
  initialDay: string;            // 최초 표시 요일
  initialPickup: DispatchSuggestion;
  initialDropoff: DispatchSuggestion;
  serviceMonth: string;
  months: string[];
  classTimeMismatches: { dayOfWeek: string; studentName: string; pickupClassTime: string | null; dropoffClassTime: string | null }[];
  drivers: { id: string; name: string }[];
  initialStudentId?: string;
}) {
  const router = useRouter();
  const [selectedDay, setDay] = useState<string>(initialDay);
  // 월 이동 뒤 이전 요일에 명단이 없으면 새 달의 선택 가능한 요일로 즉시 맞춘다.
  const day = weekdays.length > 0 && !weekdays.includes(selectedDay)
    ? (weekdays.includes(initialDay) ? initialDay : weekdays[0]) : selectedDay;
  const visibleMismatches = classTimeMismatches.filter((row) => row.dayOfWeek === day);
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
            <select value={serviceMonth} onChange={(event) => confirmLeave() && router.push(`/admin/shuttle/regular-dispatch?month=${encodeURIComponent(event.target.value)}${initialStudentId ? `&studentId=${encodeURIComponent(initialStudentId)}` : ""}`)} className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-bold dark:border-gray-600 dark:bg-gray-900">
              {months.map((month) => <option key={month} value={month}>{month}</option>)}
            </select>
          </label>
          </div>
        </div>
        {initialStudentId && <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-[var(--color-academy-soft)] p-3 text-sm text-[var(--color-academy-ink)]">
          <span>신청 학생의 배차를 확인 중입니다. 노선 저장 후 안내 문구를 확인해 주세요.</span>
          <Link href={`/admin/shuttle/regular?month=${encodeURIComponent(serviceMonth)}&studentId=${encodeURIComponent(initialStudentId)}`} onClick={event => { if (!confirmLeave()) event.preventDefault(); }} className="inline-flex min-h-11 items-center rounded-lg border border-[var(--color-academy-line)] px-3 font-bold">선택 학생 명단·안내 보기</Link>
        </div>}
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

        {/* 시간대별 회차 목록(2026-11-05 원장 지시: 등원·하원 묶음 대신 시간순, 위쪽 정차 요약 표는 없앰).
            두 RouteSection 은 방향별 상태·저장을 그대로 갖고(timeOrdered), 이 flex 목록 안에 회차 카드를 CSS order 로 섞어 놓는다.
            순서: 등원 저장 바 · 하원 저장 바(맨 위) → 회차 카드 시간순(같은 시각이면 하원 먼저) → 등원·하원 지도(맨 아래). */}
        <p className="mt-3 text-[12px] text-gray-500 dark:text-gray-400">{DOW_LABEL[day] ?? day} 회차를 시간순으로 보여 줍니다. 저장은 등원·하원 바의 버튼으로 방향별로 합니다.</p>
        <div className="mt-2 flex flex-wrap gap-3">
          <RouteSection initial={initialPickup} date={day} refreshKey={monthRefreshKey} apiBase={REGULAR_API} rosterEditable={false} serviceMonth={serviceMonth} drivers={drivers} timeOrdered regularEditing onDirtyChange={onPickupDirty} />
          <RouteSection initial={initialDropoff} date={day} refreshKey={monthRefreshKey} apiBase={REGULAR_API} rosterEditable={false} serviceMonth={serviceMonth} drivers={drivers} timeOrdered regularEditing onDirtyChange={onDropoffDirty} />
        </div>
      </div>
    </div>
  );
}
