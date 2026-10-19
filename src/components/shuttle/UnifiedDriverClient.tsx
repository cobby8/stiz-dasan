"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import AcademyTheme from "@/components/academy/AcademyTheme";
import type { PointerEvent } from "react";
import { tmapNavigationCoordinateUrl } from "@/lib/maps/coordinate-links";
import DriverDateNav from "@/components/shuttle/DriverDateNav";
import GpsShareBar from "@/components/shuttle/GpsShareBar";
import { useGpsShare } from "@/hooks/useGpsShare";
import { readBoardingResult, saveAndVerifyBoarding } from "@/lib/shuttle/driverStatusClient";
import { type UnifiedRider, type UnifiedRow } from "@/lib/shuttle/unifiedDriverRunLogic";

// 기사님 통합 운행 화면 — 그날 방학특강·정규를 **가리지 않고 출발 시각 순서대로 한 줄씩** 나열한다.
// 기사님은 위에서부터 순서대로 다니면 된다.
// ★ 기사님 연세·운전 중 한 손 조작을 고려해 라이트 모드 고정 + 큰 글자·큰 버튼(dark: 미사용).
// ⚠️ 탑승 체크는 행이 들고 있는 종류(kind)대로 **기존 API·기존 파라미터** 그대로 저장한다.

// PWA 설치 이벤트 타입 (브라우저 전용, 표준 미포함)
interface BeforeInstallPromptEvent extends Event { prompt(): Promise<void> }

// SELF = 자차(부모 차) 등·하원. 셔틀엔 안 탔지만 결석(안 옴)과는 구분한다.
type Status = "BOARDED" | "NOSHOW" | "SELF";
/** 순서 편집 중에만 쓰는 정렬 덮어쓰기(원본 rows 는 건드리지 않는다). */
type SortKey = { minutes: number | null; seq: number };

function digits(p: string | null): string | null { if (!p) return null; const d = p.replace(/[^0-9]/g, ""); return d.length >= 9 ? d : null; }

export default function UnifiedDriverClient({
  token, date, rows, initialBoarding, initialBoardingReliable = true, prevDate, nextDate, today, driverLabel,
}: {
  token: string;
  date: string;
  rows: UnifiedRow[];
  initialBoarding: Record<string, Status>;
  initialBoardingReliable?: boolean;
  prevDate: string | null;
  nextDate: string | null;
  today: string;
  driverLabel: string;
}) {
  const [boarding, setBoarding] = useState<Record<string, Status>>(initialBoarding);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [saveStates, setSaveStates] = useState<Record<string, { state: "saving" | "saved" | "failed" | "unknown"; message: string }>>({});
  const locks = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [menuKey, setMenuKey] = useState<string | null>(null);
  const [runState, setRunState] = useState<"idle" | "running" | "ended">("idle");

  // 순서 편집 — 기사님이 실제 운행 현장에서 카드 순서와 시간을 조정해 바로 저장한다.
  // 기존 탑승 체크 키(rowId)는 그대로 두고 RegularShuttleStop.sortOrder/arriveTime 만 바꾼다.
  const [editing, setEditing] = useState(false);
  const [sortOverride, setSortOverride] = useState<Record<string, SortKey>>({});
  const [timeOverride, setTimeOverride] = useState<Record<string, string>>({});
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [savingOrder, setSavingOrder] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  const { state: gpsState, transmission, lastSentAt, accuracy, start: gpsStart, stop: gpsStop } = useGpsShare(token, driverLabel);
  function handleRunStart() { setRunState("running"); gpsStart(); }
  async function handleRunEnd() { await gpsStop(); setRunState("ended"); }

  // PWA 설치 배너
  const deferredPromptRef = useRef<BeforeInstallPromptEvent | null>(null);
  const [showInstallBanner, setShowInstallBanner] = useState(false);
  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault();
      deferredPromptRef.current = e as BeforeInstallPromptEvent;
      setShowInstallBanner(true);
    };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);
  async function installPwa() {
    if (!deferredPromptRef.current) return;
    await deferredPromptRef.current.prompt();
    setShowInstallBanner(false);
  }

  // 화면에 그릴 순서 = 서버가 준 시각순 + (편집했다면) 바뀐 정렬키.
  const ordered = useMemo(() => {
    const keyOf = (r: UnifiedRow): SortKey => sortOverride[r.key] ?? { minutes: r.minutes, seq: r.seq };
    return [...rows].sort((a, b) => {
      const ka = keyOf(a), kb = keyOf(b);
      if (ka.minutes == null && kb.minutes == null) return ka.seq - kb.seq;
      if (ka.minutes == null) return 1;   // 시간 미정은 언제나 맨 끝
      if (kb.minutes == null) return -1;
      return ka.minutes === kb.minutes ? ka.seq - kb.seq : ka.minutes - kb.minutes;
    });
  }, [rows, sortOverride]);

  function moveRow(row: UnifiedRow, dir: -1 | 1) {
    const sameGroup = ordered.filter((r) => r.groupKey === row.groupKey && !r.isTerminal);
    const idx = sameGroup.findIndex((r) => r.key === row.key);
    const other = sameGroup[idx + dir];
    if (!other) return;
    const keyOf = (r: UnifiedRow): SortKey => sortOverride[r.key] ?? { minutes: r.minutes, seq: r.seq };
    const a = keyOf(row), b = keyOf(other);
    setSortOverride((o) => ({ ...o, [row.key]: b, [other.key]: a }));
  }

  function moveDraggedRow(target: UnifiedRow) {
    if (!dragKey || dragKey === target.key) return;
    const from = ordered.find((r) => r.key === dragKey);
    if (!from || from.groupKey !== target.groupKey || from.isTerminal || target.isTerminal) return;
    const sameGroup = ordered.filter((r) => r.groupKey === target.groupKey && !r.isTerminal);
    const fromIdx = sameGroup.findIndex((r) => r.key === from.key);
    const toIdx = sameGroup.findIndex((r) => r.key === target.key);
    if (fromIdx < 0 || toIdx < 0) return;
    const next = [...sameGroup];
    next.splice(fromIdx, 1);
    next.splice(toIdx, 0, from);
    const nextOverride: Record<string, SortKey> = {};
    sameGroup.forEach((row, index) => {
      const targetOrder = next[index];
      nextOverride[targetOrder.key] = sortOverride[row.key] ?? { minutes: row.minutes, seq: row.seq };
    });
    setSortOverride((current) => ({ ...current, ...nextOverride }));
  }

  function startCardDrag(event: PointerEvent, row: UnifiedRow) {
    if (!editing || row.kind !== "REGULAR" || row.isTerminal) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest("button,input,a")) return;
    setDragKey(row.key);
  }

  function displayTime(row: UnifiedRow): string | null {
    return timeOverride[row.key] ?? row.time;
  }

  async function saveRegularOrder() {
    const regularRows = ordered.filter((r) => r.kind === "REGULAR" && !r.isTerminal);
    const updates = regularRows.flatMap((row, index) => {
      const rowIds = [...new Set(row.riders.map((r) => r.checkId).filter((id) => /^[0-9a-f-]{20,}$/i.test(id)))];
      return rowIds.length > 0 ? [{ rowIds, sortOrder: index, arriveTime: displayTime(row) }] : [];
    });
    if (updates.length === 0 || savingOrder) return;
    setSavingOrder(true);
    setSaveMessage(null);
    try {
      const res = await fetch("/api/shuttle/regular-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, date, updates }),
      });
      const json = await res.json().catch(() => null) as { updated?: number; error?: string } | null;
      if (!res.ok) throw new Error(json?.error || "저장하지 못했습니다.");
      setSaveMessage(`저장 완료 · ${json?.updated ?? 0}개 행 반영`);
      setEditing(false);
    } catch (error) {
      setSaveMessage(error instanceof Error ? error.message : "저장하지 못했습니다.");
    } finally {
      setSavingOrder(false);
    }
  }

  async function setStatus(rider: UnifiedRider, next: Status, verifyOnly = false) {
    const key = rider.key;
    if (!initialBoardingReliable || locks.current.has(key) || (!verifyOnly && saveStates[key]?.state === "unknown")) return;
    locks.current.add(key);
    const cur = boarding[key] ?? null;
    const target: Status | null = cur === next ? null : next; // 같은 버튼 다시 누르면 대기로
    setBusy((x) => ({ ...x, [key]: true }));
    setSaveStates((states) => ({ ...states, [key]: { state: "saving", message: verifyOnly ? "저장 상태 확인 중…" : "저장 중…" } }));
    try {
      // 🚨 저장 경로는 종류별로 예전 그대로. 파라미터 이름·저장 키를 바꾸면 과거 기록과 끊긴다.
      const url = rider.kind === "SEASONAL" ? "/api/shuttle/boarding" : "/api/shuttle/regular-boarding";
      const body = rider.kind === "SEASONAL"
        ? { token, direction: rider.direction, shuttleRequestId: rider.checkId, status: target, studentName: rider.name, date }
        : { token, rowId: rider.checkId, status: target, studentName: rider.name, date };
      const read = () => readBoardingResult(url, token, date, rider.checkId, rider.kind === "SEASONAL" ? rider.direction : undefined);
      const result = verifyOnly ? { ...await read(), matched: true } : await saveAndVerifyBoarding(url, body, read);
      if (!mounted.current) return;
      setBoarding((b) => { const n = { ...b }; if (result.status) n[key] = result.status; else delete n[key]; return n; });
      const time = result.checkedAt ? new Date(result.checkedAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Seoul" }) : null;
      setSaveStates((states) => ({ ...states, [key]: { state: result.matched ? "saved" : "failed", message: result.matched ? `${verifyOnly ? "서버 상태 확인 완료" : "저장 완료"}${time ? ` · ${time}` : ""}` : "변경 미반영 · 서버의 현재 상태를 표시합니다" } }));
    } catch {
      if (mounted.current) setSaveStates((states) => ({ ...states, [key]: { state: "unknown", message: "결과 확인 필요 · 저장 상태를 다시 확인해주세요" } }));
    } finally {
      locks.current.delete(key);
      if (mounted.current) setBusy((x) => ({ ...x, [key]: false }));
    }
  }

  // 화면 요약만 계산한다. 저장 중이거나 서버 확인이 안 된 기록은 완료로 세지 않는다.
  function checkSummary(riders: UnifiedRider[]) {
    const targets = [...new Map(riders.filter((rider) => !(rider.kind === "REGULAR" && rider.absent)).map((rider) => [rider.key, rider])).values()];
    const checked = targets.filter((rider) => {
      const state = saveStates[rider.key]?.state;
      return initialBoardingReliable && (!state || state === "saved") && ["BOARDED", "NOSHOW", "SELF"].includes(boarding[rider.key]);
    }).length;
    return { total: targets.length, checked };
  }
  const summary = checkSummary(rows.filter((row) => !row.isTerminal).flatMap((row) => row.riders));
  const stopRows = ordered.filter((r) => !r.isTerminal);
  const orderControls = stopRows.length > 0 && (!editing ? (
    <button type="button" onClick={() => setEditing(true)}
      className="min-h-11 shrink-0 rounded-lg border border-gray-300 bg-white px-2 py-1 text-[13px] font-bold text-gray-600 active:bg-gray-100">
      ↕ 순서·시간 수정
    </button>
  ) : (
    <div className="flex shrink-0 gap-1">
      <button type="button" disabled={savingOrder} onClick={saveRegularOrder}
        className="min-h-11 rounded-lg bg-blue-600 px-3 py-1 text-[13px] font-bold text-white active:bg-blue-700">
        {savingOrder ? "저장 중..." : "저장"}
      </button>
      <button type="button" onClick={() => { setEditing(false); setSortOverride({}); setTimeOverride({}); }}
        className="min-h-11 rounded-lg border border-gray-300 bg-white px-3 py-1 text-[13px] font-bold text-gray-600">취소</button>
    </div>
  ));
  let seq = 0;

  return (
    <AcademyTheme role="driver" className="mx-auto max-w-lg px-3 pb-28">
      {/* 운행 동작은 헤더 한 곳에 두고, 날짜는 아래 날짜 탐색에만 표시합니다. */}
      <header className="academy-staff-header sticky top-0 z-10 -mx-3 mb-2 flex items-center justify-between gap-2 border-b px-3 py-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2"><Image src="/stiz-logo.png" alt="스티즈 농구교실" width={96} height={42} className="h-[42px] w-24 shrink-0 object-contain" /><h1 className="text-[17px] font-extrabold text-[var(--color-academy-ink)]">셔틀 운행</h1></div>
          {runState === "ended" && <p className="text-[13px] font-bold text-gray-600">운행이 종료되었습니다</p>}
        </div>
        {runState === "idle" && (
          <button type="button" onClick={handleRunStart}
            className="h-11 shrink-0 rounded-xl bg-[var(--color-academy-primary)] px-3 text-[14px] font-black text-white active:opacity-80">
            운행 시작
          </button>
        )}
        {runState === "running" && <button type="button" onClick={handleRunEnd} className="h-11 shrink-0 rounded-xl border border-red-300 bg-white px-3 text-[14px] font-bold text-red-600 active:bg-red-50">운행 종료</button>}
      </header>

      {/* PWA 설치 배너 */}
      {showInstallBanner && (
        <div className="mb-2 flex items-center gap-2 rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-primary-soft)] px-2">
          <p className="min-w-0 flex-1 text-[14px] font-bold text-[var(--color-academy-ink)]">홈 화면에서 빠르게 열기</p>
          <button type="button" onClick={installPwa}
            className="min-h-11 min-w-11 text-[14px] font-bold text-[var(--color-academy-primary)]">설치</button>
          <button type="button" onClick={() => setShowInstallBanner(false)} aria-label="설치 안내 닫기" className="h-11 w-11 shrink-0 text-[20px] text-[var(--color-academy-primary)]">×</button>
        </div>
      )}

      {/* 운행 중 */}
      {runState === "running" && (
        <div className="mb-2">
          <GpsShareBar gpsState={gpsState} transmission={transmission} lastSentAt={lastSentAt} accuracy={accuracy} onRetry={gpsStart} />
        </div>
      )}

      {/* 운행 종료 후 */}
      {runState === "ended" && (
        <div className="mb-2">
          <GpsShareBar gpsState={gpsState} transmission={transmission} lastSentAt={lastSentAt} accuracy={accuracy} />
        </div>
      )}

      <DriverDateNav date={date} prevDate={prevDate} nextDate={nextDate} today={today} />
      {!initialBoardingReliable && <p role="alert" className="mb-2 text-sm font-bold text-red-700">체크 기록을 불러오지 못했습니다. 미체크로 판단하지 말고 <button type="button" className="underline" onClick={() => window.location.reload()}>기록 다시 불러오기</button>를 눌러주세요. 확인 전에는 체크를 잠시 막습니다.</p>}

      {/* 순서 편집 */}
      {stopRows.length > 0 && (
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="text-[14px] font-bold text-gray-600">운행 순서 · {stopRows.length}곳<br /><span className="text-[13px] font-semibold text-[var(--color-academy-primary)]">{initialBoardingReliable ? summary.total > 0 ? `체크 ${summary.checked}/${summary.total}` : "체크 대상 없음" : "기록 확인 필요"}</span></p>
          {orderControls}
        </div>
      )}
      {editing && <p className="mb-2 rounded-xl bg-blue-50 px-3 py-2 text-[13px] font-bold text-blue-700">카드를 끌어서 순서를 바꾸고, 시간을 눌러 수정한 뒤 저장하세요. 정규 셔틀만 저장됩니다.</p>}
      {saveMessage && <p className="mb-2 rounded-xl bg-gray-100 px-3 py-2 text-[13px] font-black text-gray-700">{saveMessage}</p>}

      {stopRows.length === 0 && (
        <p className="rounded-2xl bg-gray-50 px-4 py-6 text-center text-[16px] font-bold text-gray-400">오늘은 운행이 없습니다.</p>
      )}

      <ol className="space-y-2.5">
        {ordered.map((row) => {
          // 차고지 출발·학원 도착 같은 안내 줄 — 얇은 회색 한 줄(탑승 체크 없음).
          if (row.isTerminal) {
            return (
              <li key={row.key} className="flex items-center gap-2 rounded-xl bg-gray-100 px-4 py-2.5 text-[15px] font-bold text-gray-700">
                <span className="shrink-0 text-[15px] font-black text-gray-500">{row.time}</span>
                <span className="min-w-0 flex-1">{row.label}</span>
                {row.subLabel && <span className="shrink-0 text-[13px] font-semibold text-gray-400">{row.subLabel}</span>}
              </li>
            );
          }
          seq += 1;
          const isPickup = row.direction === "PICKUP";
          const url = tmapNavigationCoordinateUrl({ latitude: row.lat, longitude: row.lng, name: row.label });
          const editable = editing && row.kind === "REGULAR";
          const checks = checkSummary(row.riders);
          return (
            <li
              key={row.key}
              draggable={editable}
              onDragStart={() => editable && setDragKey(row.key)}
              onDragOver={(event) => {
                if (editable) event.preventDefault();
              }}
              onDrop={() => editable && moveDraggedRow(row)}
              onDragEnd={() => setDragKey(null)}
              onPointerDown={(event) => startCardDrag(event, row)}
              onPointerEnter={() => editable && dragKey && moveDraggedRow(row)}
              onPointerUp={() => setDragKey(null)}
              onPointerCancel={() => setDragKey(null)}
              className={`academy-driver-stop rounded-2xl border p-3 ${editable ? "touch-none cursor-grab active:cursor-grabbing" : ""} ${dragKey === row.key ? "opacity-60" : ""} ${
              editing ? "border-blue-200 bg-blue-50" : row.warn ? "border-amber-300 bg-amber-50" : row.isHub ? "border-green-300 bg-green-50" : "border-gray-200 bg-white"
            }`}>
              <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-2">
                {editable ? (
                  <div className="flex shrink-0 flex-col gap-0.5" aria-label="순서 변경">
                    <button type="button" onClick={() => moveRow(row, -1)}
                      aria-label={`${row.label} 순서 위로`} className="h-11 w-11 rounded-lg border border-gray-300 text-[16px] font-black text-gray-600">▲</button>
                    <button type="button" onClick={() => moveRow(row, 1)}
                      aria-label={`${row.label} 순서 아래로`} className="h-11 w-11 rounded-lg border border-gray-300 text-[16px] font-black text-gray-600">▼</button>
                  </div>
                ) : (
                  <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-[15px] font-black text-white ${row.isHub ? "bg-green-600" : "bg-[var(--color-academy-primary)]"}`}>
                    {seq}
                  </span>
                )}
                <div className="min-w-0"><span className="text-[18px] font-black leading-tight text-gray-900">{row.label}</span><p className="mt-1 text-[13px] font-bold text-gray-500">{initialBoardingReliable ? checks.total > 0 ? `체크 ${checks.checked}/${checks.total}${checks.checked === checks.total ? " · 체크 완료" : ""}` : row.riders.some((rider) => rider.kind === "REGULAR" && rider.absent) ? "사전 결석 · 체크 대상 없음" : "체크 대상 없음" : "기록 확인 필요"}</p></div>
                {editable ? (
                  <input
                    type="time"
                    value={displayTime(row) ?? ""}
                    onChange={(event) => setTimeOverride((current) => ({ ...current, [row.key]: event.target.value }))}
                    className="col-span-3 mt-2 h-12 w-full min-w-0 rounded-xl border-2 border-blue-200 bg-white px-3 text-[22px] font-black text-blue-700"
                    aria-label={`${row.label} 정차 시간`}
                  />
                ) : (
                  <div className="flex shrink-0 flex-col items-end">
                    <span className={`${displayTime(row) ? "text-[26px] text-[var(--color-academy-primary)]" : "text-[15px] text-gray-400"} whitespace-nowrap font-black leading-none`}>{displayTime(row) ?? "시간 미정"}</span>
                    {url && (
                      <a href={url} className="inline-flex min-h-11 items-center gap-1 rounded-lg px-1 text-[13px] font-bold text-[var(--color-academy-primary)] active:bg-[var(--color-academy-primary-soft)]">
                        <span aria-hidden="true" className="material-symbols-outlined text-[17px]">near_me</span> 길안내
                      </a>
                    )}
                  </div>
                )}
                <div className="col-span-3 mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] font-semibold text-gray-500">
                  <span className="font-bold text-[var(--color-academy-primary)]">{row.kind === "SEASONAL" ? "특강" : "정규"} · {isPickup ? "등원" : "하원"}</span>
                  {row.groupLabel && <span>{row.groupLabel}</span>}
                  {row.isHub && <span className="font-bold text-green-700">무료 거점</span>}
                  {row.pending && <span className="font-bold text-amber-700">순서 확인 필요</span>}
                  {row.warn && <span className="font-bold text-amber-700">노선 밖 승객 · 정차 확인 필요</span>}
                </div>
              </div>

              {row.isHub && row.riders.length === 0 && <p className="mt-1.5 text-[15px] font-bold text-green-700">무료 거점(워크인, 정원 별도)</p>}

              {row.riders.length > 0 && (
                <div className="mt-1.5 space-y-1">
                  {row.riders.map((rider) => {
                    const status = boarding[rider.key] ?? null;
                    const parent = digits(rider.parentPhone), child = digits(rider.studentPhone);
                    const saveState = saveStates[rider.key];
                    const isBusy = busy[rider.key] || !initialBoardingReliable || saveState?.state === "unknown";
                    const selfLabel = isPickup ? "자차등원" : "자차하원";
                    // 정규는 그날 결석 신고가 자동 매칭되면 아예 체크 대상에서 뺀다(종전 동작 그대로).
                    const lockedAbsent = rider.absent && rider.kind === "REGULAR";
                    const rowKey = `${row.key}:${rider.checkId}`;
                    return (
                      <div key={rowKey} className={`academy-driver-rider rounded-xl px-2.5 py-2 ${lockedAbsent ? "bg-red-50" : "bg-gray-50"}`}>
                        <div className="academy-driver-rider-main grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
                          <div className="academy-driver-rider-info min-w-0">
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                              <span className={`break-all text-[19px] font-black ${lockedAbsent ? "text-gray-400 line-through" : "text-gray-900"}`}>{rider.name}</span>
                              {rider.grade && <span className="text-[14px] text-gray-500">{rider.grade}</span>}
                              {lockedAbsent && <span className="rounded-md bg-red-500 px-2 py-0.5 text-[13px] font-black text-white">오늘 결석</span>}
                              {rider.absent && !lockedAbsent && status !== "BOARDED" && status !== "SELF" && (
                                <span className="rounded-md bg-amber-400 px-2 py-0.5 text-[13px] font-black text-white">결석예정</span>
                              )}
                              {!lockedAbsent && status === "NOSHOW" && <span className="rounded-md bg-red-500 px-2 py-0.5 text-[13px] font-black text-white">결석</span>}
                              {!lockedAbsent && status === "SELF" && <span className="rounded-md bg-violet-600 px-2 py-0.5 text-[13px] font-black text-white">{selfLabel}</span>}
                              {/* "오늘만" 셔틀 변경. 결석과 다른 색으로 둔다 — 아이는 수업에 오고,
                                  기사님이 태우지 않거나 다른 곳으로 가야 한다는 뜻이다. */}
                              {rider.shuttleNote && <span className="rounded-md bg-blue-600 px-2 py-0.5 text-[13px] font-black text-white">{rider.shuttleNote}</span>}
                              {!lockedAbsent && parent && <a href={`tel:${parent}`} className="inline-flex min-h-11 items-center text-[14px] font-bold text-blue-600">학부모 전화</a>}
                              {!lockedAbsent && child && <a href={`tel:${child}`} className="inline-flex min-h-11 items-center text-[14px] font-bold text-green-600">학생 전화</a>}
                            </div>
                          </div>
                          {lockedAbsent ? (
                            <span className="rounded-xl border-2 border-red-300 px-3 py-2 text-[15px] font-black text-red-500">미{isPickup ? "탑승" : "하차"}(결석)</span>
                          ) : (
                            <div className="flex items-center gap-1.5">
                              <button type="button" disabled={isBusy} onClick={() => { setMenuKey(null); setStatus(rider, "BOARDED"); }}
                                aria-pressed={status === "BOARDED"}
                                className={`h-11 min-w-[60px] rounded-xl text-[15px] font-black ${status === "BOARDED" ? "bg-green-600 text-white" : "border-2 border-green-400 text-green-700"}`}>
                                {isPickup ? "탑승" : "하차"}
                              </button>
                              <button type="button" disabled={isBusy} onClick={() => setMenuKey(menuKey === rowKey ? null : rowKey)}
                                aria-pressed={status === "NOSHOW" || status === "SELF"} aria-expanded={menuKey === rowKey}
                                className={`h-11 min-w-[60px] rounded-xl text-[15px] font-black ${status === "NOSHOW" || status === "SELF" ? "bg-gray-700 text-white" : "border-2 border-gray-300 text-gray-600"}`}>
                                미{isPickup ? "탑승" : "하차"}
                              </button>
                            </div>
                          )}
                        </div>
                        {saveState && <p role="status" className={`mt-1 text-xs font-semibold ${saveState.state === "failed" || saveState.state === "unknown" ? "text-red-700" : "text-gray-600"}`}>{saveState.message}{saveState.state === "unknown" && <button type="button" disabled={busy[rider.key]} onClick={() => void setStatus(rider, "BOARDED", true)} className="ml-2 underline">저장 상태 확인</button>}</p>}
                        {!lockedAbsent && menuKey === rowKey && (
                          <div className="mt-2 flex gap-2">
                            <button type="button" disabled={isBusy} onClick={() => { setStatus(rider, "NOSHOW"); setMenuKey(null); }}
                              className={`h-13 flex-1 rounded-xl py-3 text-[16px] font-black ${status === "NOSHOW" ? "bg-red-500 text-white" : "border-2 border-red-300 text-red-600"}`}>❌ 결석(안 옴)</button>
                            <button type="button" disabled={isBusy} onClick={() => { setStatus(rider, "SELF"); setMenuKey(null); }}
                              className={`h-13 flex-1 rounded-xl py-3 text-[16px] font-black ${status === "SELF" ? "bg-violet-600 text-white" : "border-2 border-violet-300 text-violet-700"}`}>🚗 {selfLabel}</button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </li>
          );
        })}
      </ol>

      <details className="mt-3 text-[14px] font-semibold text-gray-500"><summary className="min-h-11 cursor-pointer py-3">탑승 체크 사용 안내</summary><p className="pb-2">체크 후 저장 완료를 확인하세요. 같은 버튼을 다시 누르면 대기로 돌아갑니다. 미탑승에서는 결석·자차를 구분할 수 있습니다.</p></details>
    </AcademyTheme>
  );
}
