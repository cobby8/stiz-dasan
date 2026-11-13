"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import AcademyTheme from "@/components/academy/AcademyTheme";
// 운행표 카드 목록 부품 — 관리자 운행표와 같은 카드 틀을 쓴다(이 화면은 mode="driver").
import RunBoard from "@/components/shuttle/run/RunBoard";
import { useRouteRetime } from "@/components/shuttle/run/useRouteRetime";
import DriverDateNav from "@/components/shuttle/DriverDateNav";
import DriverGpsIndicator from "@/components/shuttle/DriverGpsIndicator";
import { useGpsShare } from "@/hooks/useGpsShare";
import { useDriverUpcoming } from "@/hooks/useDriverUpcoming";
import { parseDriverScheduleTime } from "@/lib/shuttle/driverUpcoming";
import styles from "./DriverWorkspace.module.css";
import { StatusChoiceButton, StatusUndoButton } from "@/components/staff/StatusChoiceButton";
import { LiveStatusPill } from "@/components/staff/LiveStatusPill";
import { readBoardingResult, saveAndVerifyBoarding } from "@/lib/shuttle/driverStatusClient";
import { riderBoardingView, riderDefaultStatus, stopAbsenceSummary, type UnifiedRider, type UnifiedRow } from "@/lib/shuttle/unifiedDriverRunLogic";
import { userErrorMessage } from "@/components/staff/userErrorMessage";
import { todayKst } from "@/lib/datetime/kst";
import type { RunHoliday } from "@/lib/shuttle/regularRunDayRules";

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
  token = "", date, rows, initialBoarding, initialBoardingReliable = true, prevDate, nextDate, today, driverLabel, focusDirection = null, academy = null, holiday = null,
}: {
  token?: string;
  date: string;
  rows: UnifiedRow[];
  initialBoarding: Record<string, Status>;
  initialBoardingReliable?: boolean;
  prevDate: string | null;
  nextDate: string | null;
  today: string;
  driverLabel: string;
  /** 알림 «노선 확인하기»(?focus=BOARD|ALIGHT)로 열렸을 때 바뀐 방향 — 그 방향 첫 정규 카드로 바로 스크롤한다. */
  focusDirection?: "PICKUP" | "DROPOFF" | null;
  /** 학원 좌표 — 순서를 옮길 때 시각 다시 계산(등원 도착·하원 출발 기준). */
  academy?: { lat: number; lng: number } | null;
  /** 그날 정규 수업 휴무(연간일정) — 맨 위 «오늘은 휴무(사유)». 정규 줄은 서버가 이미 «휴무»로 잠가 보낸다. */
  holiday?: RunHoliday | null;
}) {
  const router = useRouter();
  const accountRun = !token;
  const [boarding, setBoarding] = useState<Record<string, Status>>(initialBoarding);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [saveStates, setSaveStates] = useState<Record<string, { state: "saving" | "saved" | "failed" | "unknown"; message: string }>>({});
  const locks = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [menuKey, setMenuKey] = useState<string | null>(null);
  const [runState, setRunState] = useState<"idle" | "running" | "ended">("idle");
  // 게슈탈트 T-01: «운행 종료»는 운전 중 잘못 누르면 위치 공유가 바로 끊긴다 → 화면 안 확인 단계를 둔다.
  // (앱 웹뷰의 window.confirm 은 다른 창이 떠 있으면 iOS 에서 조용히 «취소»가 되므로 페이지 안 확인 UI 를 쓴다)
  const [confirmEnd, setConfirmEnd] = useState(false);

  // 순서 편집 — 기사님이 실제 운행 현장에서 카드 순서와 시간을 조정해 바로 저장한다.
  // 탑승 체크 키(rowId)는 유지하고 명단·확정 배차의 순서와 시각을 함께 저장한다.
  const [editing, setEditing] = useState(false);
  const [orderSourceRows, setOrderSourceRows] = useState(rows);
  const [sortOverride, setSortOverride] = useState<Record<string, SortKey>>({});
  const [timeOverride, setTimeOverride] = useState<Record<string, string>>({});
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [savingOrder, setSavingOrder] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  // 순서를 옮기면 그 묶음 시각을 지도 이동 시간으로 다시 계산한다(관리자 운행표와 같은 부품·같은 규칙).
  const { retime, notes: retimeNotes, cancelPending: cancelRetime, clearNote: clearRetimeNote } = useRouteRetime({ academy, token });
  // 새 서버 자료가 도착하면 이전 저장의 표시용 덮어쓰기는 무시한다.
  // 편집 중에는 원본 스냅샷을 유지해 다른 화면의 변경을 baseline 검증으로 잡는다.
  const useOrderOverrides = editing || orderSourceRows === rows;

  const { state: gpsState, transmission, lastSentAt, accuracy, mode: gpsMode = "web", nativeRunning = false, nativeMessage, start: gpsStart, stop: gpsStop } = useGpsShare(token, driverLabel);
  useEffect(() => {
    if (accountRun || gpsMode !== "native") return;
    setRunState(nativeRunning || gpsState === "requesting" || transmission === "stopping" ? "running" : transmission === "stopped" || transmission === "stop-unknown" ? "ended" : "idle");
  }, [accountRun, gpsMode, nativeRunning, gpsState, transmission]);
  function handleRunStart() { if (gpsMode === "web") setRunState("running"); gpsStart(); }
  async function handleRunEnd() { await gpsStop(); if (gpsMode === "web") setRunState("ended"); }
  // 운행 중이 아니게 되면(앱이 먼저 종료 등) 열려 있던 종료 확인은 닫는다.
  useEffect(() => { if (runState !== "running") setConfirmEnd(false); }, [runState]);

  // 날이 바뀐 화면(2026-11-13 b2) — 어제 열어 둔 운행표를 오늘 다시 보면 어제 명단이 그대로 보였다.
  // 화면으로 돌아올 때 오늘(KST)이 화면의 «오늘»과 다르면 새로 불러온다.
  // 단, 운행 중(위치 전송)이거나 순서 편집 중이면 건드리지 않는다 — 새로 불러오면 위치 전송·편집이 끊길 수 있다.
  useEffect(() => {
    const refreshIfNewDay = () => {
      if (document.visibilityState !== "visible" || runState === "running" || editing) return;
      if (todayKst() !== today) router.refresh();
    };
    document.addEventListener("visibilitychange", refreshIfNewDay);
    window.addEventListener("focus", refreshIfNewDay);
    return () => {
      document.removeEventListener("visibilitychange", refreshIfNewDay);
      window.removeEventListener("focus", refreshIfNewDay);
    };
  }, [today, runState, editing, router]);

  // PWA 설치 배너
  const deferredPromptRef = useRef<BeforeInstallPromptEvent | null>(null);
  const [showInstallBanner, setShowInstallBanner] = useState(false);
  useEffect(() => {
    if (accountRun) return;
    const handler = (e: Event) => {
      e.preventDefault();
      deferredPromptRef.current = e as BeforeInstallPromptEvent;
      setShowInstallBanner(true);
    };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, [accountRun]);
  async function installPwa() {
    if (!deferredPromptRef.current) return;
    await deferredPromptRef.current.prompt();
    setShowInstallBanner(false);
  }

  // 화면에 그릴 순서 = 서버가 준 시각순 + (편집했다면) 바뀐 정렬키.
  const ordered = useMemo(() => {
    const keyOf = (r: UnifiedRow): SortKey => {
      const base = (useOrderOverrides ? sortOverride[r.key] : undefined) ?? { minutes: r.minutes, seq: r.seq };
      return useOrderOverrides && timeOverride[r.key] !== undefined ? { ...base, minutes: parseDriverScheduleTime(timeOverride[r.key]) } : base;
    };
    return [...(editing ? orderSourceRows : rows)].sort((a, b) => {
      const ka = keyOf(a), kb = keyOf(b);
      if (ka.minutes == null && kb.minutes == null) return ka.seq - kb.seq;
      if (ka.minutes == null) return 1;   // 시간 미정은 언제나 맨 끝
      if (kb.minutes == null) return -1;
      return ka.minutes === kb.minutes ? ka.seq - kb.seq : ka.minutes - kb.minutes;
    });
  }, [rows, sortOverride, timeOverride, editing, orderSourceRows, useOrderOverrides]);

  // 순서를 옮기면 그 묶음 시각을 다시 계산한다(2026-11-13 원장 결정 — routeRetime.ts):
  //   등원은 첫 탑승 시각 고정, 하원은 학원 출발 시각 고정 → 지도 이동 시간 × 기사님 속도 배율을 쌓는다.
  //   방학특강 행이거나 좌표가 없는 정류장이 있는 등 계산할 수 없을 때만 예전처럼 «시각 칸은 자리에 두고 정류장만 바꾼다».
  function reorderGroup(sameGroup: UnifiedRow[], next: UnifiedRow[]) {
    const groupKey = next[0]?.groupKey;
    if (!groupKey) return;
    // seq 는 원래 명단 번호라 시각순과 어긋날 수 있다 → 오름차순으로 나눠 줘야 같은 시각에서도 새 순서가 유지된다.
    const slotSeq = sameGroup.map((slot) => sortOverride[slot.key]?.seq ?? slot.seq).sort((a, b) => a - b);
    if (next[0].kind === "REGULAR") {
      const saved = orderSourceRows.filter((r) => r.groupKey === groupKey && !r.isTerminal);
      const done = retime(groupKey, saved, sameGroup, next, displayTime, (times) => {
        const nextSort: Record<string, SortKey> = {};
        next.forEach((row, i) => { nextSort[row.key] = { minutes: parseDriverScheduleTime(times[row.key] ?? null), seq: slotSeq[i] }; });
        setSortOverride((current) => ({ ...current, ...nextSort }));
        setTimeOverride((current) => ({ ...current, ...times }));
      });
      if (done) return;
    }
    const nextOverride: Record<string, SortKey> = {};
    const nextTimes: Record<string, string> = {};
    sameGroup.forEach((row, index) => {
      nextOverride[next[index].key] = { minutes: parseDriverScheduleTime(displayTime(row)), seq: slotSeq[index] };
      nextTimes[next[index].key] = displayTime(row) ?? "";
    });
    setSortOverride((current) => ({ ...current, ...nextOverride }));
    setTimeOverride((current) => ({ ...current, ...nextTimes }));
  }

  function moveRow(row: UnifiedRow, dir: -1 | 1) {
    const sameGroup = ordered.filter((r) => r.groupKey === row.groupKey && !r.isTerminal);
    const idx = sameGroup.findIndex((r) => r.key === row.key);
    if (idx < 0 || !sameGroup[idx + dir]) return;
    const next = [...sameGroup];
    [next[idx], next[idx + dir]] = [next[idx + dir], next[idx]];
    reorderGroup(sameGroup, next);
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
    reorderGroup(sameGroup, next);
  }

  // 카드 끌기 시작 판정(startCardDrag)은 카드 틀과 함께 RunBoard 로 옮겼다.

  function displayTime(row: UnifiedRow): string | null {
    return useOrderOverrides && timeOverride[row.key] !== undefined ? timeOverride[row.key] || null : row.time;
  }

  // 알림으로 열렸으면 바뀐 방향(등원/하원)의 첫 정규 카드 — 처음 그릴 때 한 번만 그 자리로 스크롤한다.
  const focusKey = useMemo(
    () => (focusDirection ? rows.find((r) => !r.isTerminal && r.kind === "REGULAR" && r.direction === focusDirection)?.key ?? null : null),
    [focusDirection, rows],
  );
  useEffect(() => {
    if (!focusKey) return;
    // 위쪽 고정 머리줄에 가리지 않게 화면 가운데로 둔다.
    document.getElementById("run-focus")?.scrollIntoView({ block: "center" });
  }, [focusKey]);

  // 휴대폰의 시계로 강조만 갱신한다. 운행 순서와 서버의 탑승 기록은 바꾸지 않는다.
  const upcomingStops = useMemo(() => ordered.map((row) => ({ key: row.key, time: useOrderOverrides ? timeOverride[row.key] ?? row.time : row.time, isTerminal: row.isTerminal })), [ordered, timeOverride, useOrderOverrides]);
  const upcoming = useDriverUpcoming(upcomingStops, date);

  async function saveRegularOrder() {
    const makeOrderPayload = (source: UnifiedRow[], getTime: (row: UnifiedRow) => string | null) => source.filter((r) => r.kind === "REGULAR" && !r.isTerminal).flatMap((row) => {
      const rowIds = [...new Set(row.riders.map((r) => r.checkId).filter((id) => /^[0-9a-f-]{20,}$/i.test(id)))];
      return rowIds.length > 0 ? [{ rowIds, sortOrder: 0, arriveTime: getTime(row) }] : [];
    }).map((item, index) => ({ ...item, sortOrder: index }));
    const updates = makeOrderPayload(ordered, displayTime);
    // 화면을 연 뒤 관리자가 바꾼 내용을 덮어쓰지 않도록 마지막 조회 원본도 대조한다.
    const baseline = makeOrderPayload(orderSourceRows, (row) => row.time);
    if (updates.length === 0 || savingOrder) return;
    cancelRetime(); // 저장 중에 늦게 온 지도 계산이 화면 시각을 바꾸지 않게
    setSavingOrder(true);
    setSaveMessage(null);
    try {
      const res = await fetch("/api/shuttle/regular-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, date, updates, baseline }),
      });
      const json = await res.json().catch(() => null) as { ok?: boolean; verified?: boolean; updated?: number; error?: string } | null;
      if (!res.ok) throw new Error(json?.error || "저장하지 못했습니다.");
      const expected = new Set(updates.flatMap((item) => item.rowIds)).size;
      if (!json?.ok || !json.verified || json.updated !== expected) throw new Error("저장 결과를 확인하지 못했습니다. 편집 내용을 유지합니다. 다시 열기 전에 저장 상태를 확인해 주세요.");
      setSaveMessage(`저장 완료 · ${json?.updated ?? 0}개 행 반영`);
      setEditing(false);
      clearRetimeNote();
      router.refresh();
    } catch (error) {
      setSaveMessage(userErrorMessage(error, "저장하지 못했습니다."));
    } finally {
      setSavingOrder(false);
    }
  }

  // next = null 이면 «대기로 되돌리기»(저장 API 에 status: null — 예전 «같은 버튼 다시 누르기»와 같은 값).
  async function setStatus(rider: UnifiedRider, next: Status | null, verifyOnly = false) {
    const key = rider.key;
    if ((accountRun && rider.kind !== "REGULAR") || !initialBoardingReliable || locks.current.has(key) || (!verifyOnly && saveStates[key]?.state === "unknown")) return;
    const cur = boarding[key] ?? null;
    // 게슈탈트 T-04: 이미 그 상태인 버튼을 다시 눌러도 아무 일 없게(운전 중 두 번 눌림으로 체크가 풀리던 문제).
    // 되돌리기는 아래 별도 «대기로 되돌리기» 글자 버튼만 한다.
    if (!verifyOnly && cur === next) return;
    // 잠긴 줄(휴원·퇴원·첫 수업 전·휴무)은 «대기로 되돌리기»만 — 서버도 같은 이유로 거부한다(버튼이 잠겨 있어 보통 여기 안 온다).
    if (!verifyOnly && next !== null && riderBoardingView(rider, cur).blocked) return;
    locks.current.add(key);
    const target: Status | null = next;
    setBusy((x) => ({ ...x, [key]: true }));
    setSaveStates((states) => ({ ...states, [key]: { state: "saving", message: verifyOnly ? "저장 상태 확인 중…" : "저장 중…" } }));
    try {
      // 🚨 저장 경로는 종류별로 예전 그대로. 파라미터 이름·저장 키를 바꾸면 과거 기록과 끊긴다.
      const url = accountRun ? "/api/staff/shuttle/regular-boarding"
        : rider.kind === "SEASONAL" ? "/api/shuttle/boarding" : "/api/shuttle/regular-boarding";
      const body = accountRun ? { rowId: rider.checkId, status: target, date }
        : rider.kind === "SEASONAL"
        ? { token, direction: rider.direction, shuttleRequestId: rider.checkId, status: target, studentName: rider.name, date }
        : { token, rowId: rider.checkId, status: target, studentName: rider.name, date };
      const read = () => readBoardingResult(url, token, date, rider.checkId, rider.kind === "SEASONAL" ? rider.direction : undefined);
      const result = verifyOnly ? { ...await read(), matched: true } : await saveAndVerifyBoarding(url, body, read);
      if (!mounted.current) return;
      setBoarding((b) => { const n = { ...b }; if (result.status) n[key] = result.status; else delete n[key]; return n; });
      const time = result.checkedAt ? new Date(result.checkedAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Seoul" }) : null;
      setSaveStates((states) => ({ ...states, [key]: { state: result.matched ? "saved" : "failed", message: result.matched ? `${verifyOnly ? "저장 상태 확인 완료" : "저장 완료"}${time ? ` · ${time}` : ""}` : "바뀌지 않았습니다 · 지금 저장된 상태를 보여 드려요" } }));
    } catch {
      if (mounted.current) setSaveStates((states) => ({ ...states, [key]: { state: "unknown", message: "결과 확인 필요 · 저장 상태를 다시 확인해주세요" } }));
    } finally {
      locks.current.delete(key);
      if (mounted.current) setBusy((x) => ({ ...x, [key]: false }));
    }
  }

  // 화면 요약만 계산한다. 저장 중이거나 서버 확인이 안 된 기록은 완료로 세지 않는다.
  function checkSummary(riders: UnifiedRider[]) {
    // 결석 학생도 명단에 남아 있으므로 분모에 넣는다(원장 지시 2026-11-09). 기록이 없으면 기본 «결석»이라 체크된 것으로 센다.
    // 잠긴 줄(휴원·휴무 등)은 체크 대상이 아니라 분모에서 뺀다(원장 지시 2026-11-14 — 명단엔 남긴다).
    const targets = [...new Map(riders.map((rider) => [rider.key, rider])).values()].filter((rider) => !riderBoardingView(rider, boarding[rider.key]).blocked);
    const checked = targets.filter((rider) => {
      const state = saveStates[rider.key]?.state;
      return initialBoardingReliable && (!state || state === "saved") && riderBoardingView(rider, boarding[rider.key]).status != null;
    }).length;
    return { total: targets.length, checked };
  }
  const summary = checkSummary(rows.filter((row) => !row.isTerminal).flatMap((row) => row.riders));
  const stopRows = ordered.filter((r) => !r.isTerminal);
  const orderControls = !accountRun && stopRows.length > 0 && (!editing ? (
    <button type="button" onClick={() => { setOrderSourceRows(rows); setSortOverride({}); setTimeOverride({}); clearRetimeNote(); setEditing(true); }}
      className="academy-button-secondary shrink-0">
      순서·시간 수정
    </button>
  ) : (
    <div className="flex shrink-0 gap-1">
      <button type="button" disabled={savingOrder} onClick={saveRegularOrder}
        className="academy-button-primary">
        {savingOrder ? "저장 중..." : "저장"}
      </button>
      <button type="button" onClick={() => { setEditing(false); setSortOverride({}); setTimeOverride({}); clearRetimeNote(); }}
        className="academy-button-secondary">취소</button>
    </div>
  ));

  // 카드 머리 보조 정보(기사님 전용) — 체크 개수 + «결석 N명»(전원 결석이면 «정차 안 해도 됨»까지, 순서는 그대로 둔다).
  function renderStopMeta(row: UnifiedRow) {
    const checks = checkSummary(row.riders);
    const absence = stopAbsenceSummary(row.riders, boarding);
    return (
      <>
        <span>{initialBoardingReliable ? checks.total > 0 ? `체크 ${checks.checked}/${checks.total}${checks.checked === checks.total ? " · 체크 완료" : ""}` : "체크 대상 없음" : "기록 확인 필요"}</span>
        {absence.absentCount > 0 && <span className="font-semibold text-[var(--color-academy-danger)]">결석 {absence.absentCount}명{absence.allSkippable ? " · 정차 안 해도 됨" : ""}</span>}
        {/* 결석 없이 전원이 잠긴 줄(휴원·휴무 등)이면 같은 안내만 회색으로 */}
        {absence.absentCount === 0 && absence.allSkippable && <span className="font-semibold text-[var(--color-academy-muted)]">정차 안 해도 됨</span>}
      </>
    );
  }

  // 학생 한 명 줄(기사님 전용) — 탑승/미탑승 버튼·연락처·저장 상태. 카드 틀(RunBoard)이 학생마다 부른다.
  function renderRider(row: UnifiedRow, rider: UnifiedRider) {
    const isPickup = row.direction === "PICKUP";
    // 저장된 상태(없으면 null). 화면에 보이는 상태(status)는 결석 학생이면 기본 «결석»(NOSHOW)이 된다.
    const stored = boarding[rider.key] ?? null;
    const status = boarding[rider.key] ?? riderDefaultStatus(rider);
    const parent = digits(rider.parentPhone), child = digits(rider.studentPhone);
    const saveState = saveStates[rider.key];
    const isBusy = busy[rider.key] || !initialBoardingReliable || saveState?.state === "unknown";
    const selfLabel = isPickup ? "자차등원" : "자차하원";
    // 원장 지시(2026-11-09): 정규 결석 신고 학생은 명단에서 빼지 않는다 — 순서 그대로, «결석» 뱃지 + 흐린 행.
    // 탑승 버튼은 그대로 누를 수 있고(실제로 탔으면 체크), 기록이 없으면 기본 «결석»으로 보인다.
    const view = riderBoardingView(rider, stored);
    const rowKey = `${row.key}:${rider.checkId}`;
    // 원장 지시(2026-11-14): 휴원·퇴원·첫 수업 전·휴무 줄은 명단에 남기고 회색 행 + 뱃지, 탑승·미탑승 버튼은 잠근다.
    const locked = view.blocked;
    const rowTone = locked ? "bg-[var(--color-academy-neutral-soft)]" : view.dimmed ? "bg-[var(--color-academy-danger-soft)]" : "bg-[var(--color-academy-soft)]";
    return (
      <div key={rowKey} data-blocked={locked ? "true" : undefined} className={`${styles.rider} academy-driver-rider rounded-xl ${rowTone}`}>
        <div className={styles.riderMain}>
          <div className={styles.riderInfo}>
            <div className={styles.identity}>
              <span className={`break-all text-[19px] font-semibold ${view.dimmed ? "text-[var(--color-academy-muted)]" : "text-[var(--color-academy-ink)]"}`}>{rider.name}</span>
              {/* 결석 뱃지 — 이름 바로 옆, 진한 바탕 + 흰 글자(14px)로 운전 중에도 한눈에. 흐린 행 안에서도 흐리지 않는다.
                  실외 가독성 때문에 채움은 유지하고, 색만 꽉 찬 위험색 토큰(danger-fill)으로 통일(2026-11-09). */}
              {view.absentReported && (
                <span className="inline-flex items-center gap-0.5 rounded-md bg-[var(--color-academy-danger-fill)] px-2 py-0.5 text-sm font-semibold text-[var(--color-academy-on-primary)]">
                  {rider.absentLabel || "결석"}
                </span>
              )}
              {/* 잠금 뱃지(휴원·퇴원·첫 수업 전·휴무) — 결석(빨강)과 구분되는 회색 채움 + 흰 글자 14px */}
              {locked && (
                <span className="inline-flex items-center rounded-md bg-[var(--color-academy-neutral)] px-2 py-0.5 text-sm font-semibold text-[var(--color-academy-on-primary)]">
                  {rider.blockedLabel}
                </span>
              )}
              {rider.grade && <span className="text-sm text-[var(--color-academy-muted)]">{rider.grade}</span>}
            </div>
            {(parent || child) && <div className={styles.contacts}>
              {parent && <a href={`tel:${parent}`} aria-label={`${rider.name} 학부모 전화`}>학부모 전화</a>}
              {child && <a href={`tel:${child}`} aria-label={`${rider.name} 학생 전화`}>학생 전화</a>}
            </div>}
          </div>
          <div className={styles.boardingActions}>
            {/* 게슈탈트 T-04: 선생님 탑승 체크와 같은 상태 버튼(탑승=success, 미탑승=danger), 간격 12px */}
            <StatusChoiceButton tone="success" disabled={isBusy || locked} active={status === "BOARDED"} onClick={() => { setMenuKey(null); void setStatus(rider, "BOARDED"); }}
              className="text-[15px]">
              {isPickup ? "탑승" : "하차"}
            </StatusChoiceButton>
            <StatusChoiceButton tone="danger" disabled={isBusy || locked} active={status === "NOSHOW" || status === "SELF"} ariaExpanded={menuKey === rowKey}
              onClick={() => setMenuKey(menuKey === rowKey ? null : rowKey)} className="text-[15px]">
              미{isPickup ? "탑승" : "하차"}
            </StatusChoiceButton>
          </div>
        </div>
        {(rider.shuttleNote || (rider.absent && !view.absentReported && status !== "BOARDED" && status !== "SELF") || (!view.absentReported && status === "NOSHOW") || status === "SELF") && <div className={styles.riderNotes}>
              {/* 특강 «결석예정»은 종전대로(체크 대상 · 정규 결석 뱃지와 구분) */}
              {rider.absent && !view.absentReported && status !== "BOARDED" && status !== "SELF" && (
                <span className="rounded-md bg-[var(--color-academy-warning)] px-2 py-0.5 text-sm font-semibold text-[var(--color-academy-on-primary)]">결석예정</span>
              )}
              {/* 정규 결석 학생은 이름 옆 뱃지가 이미 «결석»이라 같은 말을 두 번 띄우지 않는다 */}
              {!view.absentReported && status === "NOSHOW" && <span className="rounded-md bg-[var(--color-academy-danger-fill)] px-2 py-0.5 text-sm font-semibold text-[var(--color-academy-on-primary)]">결석</span>}
              {status === "SELF" && <span className="rounded-md bg-[var(--color-driver-self)] px-2 py-0.5 text-sm font-semibold text-[var(--color-academy-on-primary)]">{selfLabel}</span>}
              {/* "오늘만" 셔틀 변경. 결석과 다른 색으로 둔다 — 아이는 수업에 오고,
                  기사님이 태우지 않거나 다른 곳으로 가야 한다는 뜻이다. */}
              {rider.shuttleNote && <span className="rounded-md bg-[var(--color-driver-note)] px-2 py-0.5 text-sm font-semibold text-[var(--color-academy-on-primary)]">{rider.shuttleNote}</span>}
        </div>}
        {(saveState || stored || view.absentDefault || locked) && <div className={styles.riderStatusLine}>
          {saveState ? <p role="status" className={`text-xs font-semibold ${saveState.state === "failed" || saveState.state === "unknown" ? "text-[var(--color-academy-danger)]" : "text-[var(--color-academy-muted)]"}`}>{saveState.message}{saveState.state === "unknown" && <button type="button" disabled={busy[rider.key]} onClick={() => void setStatus(rider, "BOARDED", true)} className="ml-2 inline-flex min-h-11 min-w-11 items-center underline">저장 상태 확인</button>}</p>
            : locked ? <p className="text-sm font-semibold text-[var(--color-academy-muted)]">{rider.blockedLabel === "휴무" ? "오늘은 수업이 없어 체크하지 않아요" : `${rider.blockedLabel}이라 체크하지 않아요`}</p>
            : view.absentDefault ? <p className="text-sm font-semibold text-[var(--color-academy-muted)]">이 아이는 안 태워도 돼요 (탔으면 «{isPickup ? "탑승" : "하차"}»)</p> : <span />}
          {/* 잘못 눌렀을 때만 쓰는 되돌리기 — 상태 버튼과 떨어진 작은 글자 버튼(결석 학생은 기본 «결석»으로 돌아간다) */}
          {stored && <StatusUndoButton disabled={isBusy} ariaLabel={`${rider.name} ${view.absentReported ? "결석으로" : "대기로"} 되돌리기`} onClick={() => { setMenuKey(null); void setStatus(rider, null); }} />}
        </div>}
        {menuKey === rowKey && !locked && (
          <div className="mt-2 flex gap-3">
            <StatusChoiceButton tone="danger" disabled={isBusy} active={status === "NOSHOW"} onClick={() => { void setStatus(rider, "NOSHOW"); setMenuKey(null); }}
              className="min-h-12 flex-1 text-base">결석(안 옴)</StatusChoiceButton>
            {/* 자차는 결석과 다른 «자차 색»(이 화면 CSS 변수 --color-driver-self) */}
            <button type="button" disabled={isBusy} aria-pressed={status === "SELF"} onClick={() => { void setStatus(rider, "SELF"); setMenuKey(null); }}
              className={`inline-flex min-h-12 flex-1 items-center justify-center gap-1 rounded-xl border-2 border-[var(--color-driver-self)] text-base font-medium ${status === "SELF" ? "bg-[var(--color-driver-self)] text-[var(--color-academy-on-primary)]" : "bg-[var(--color-academy-surface)] text-[var(--color-driver-self)]"}`}>{selfLabel}</button>
          </div>
        )}
      </div>
    );
  }

  return (
    <AcademyTheme role="driver" className={`${styles.workspace} mx-auto px-3 pb-8`}>
      {/* 운행 동작은 헤더 한 곳에 두고, 날짜는 아래 날짜 탐색에만 표시합니다. */}
      <header className={(accountRun ? "" : "sticky top-0 ") + "academy-staff-header z-10 -mx-3 mb-2 flex items-center justify-between gap-2 border-b px-3 py-2"}>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2"><Image src="/stiz-logo.png" alt="스티즈 농구교실" width={96} height={42} className="h-[42px] w-24 shrink-0 object-contain" /><h1 className="text-[17px] font-bold text-[var(--color-academy-ink)]">셔틀 운행</h1>{runState === "running" && <LiveStatusPill>운행 중</LiveStatusPill>}</div>
          {runState === "ended" && <p className="text-sm font-medium text-[var(--color-academy-muted)]">{transmission === "stop-unknown" ? "위치 공유를 멈췄습니다 · 운행 종료가 저장됐는지 확인해 주세요" : "운행이 종료되었습니다"}</p>}
        </div>
        {!accountRun && <div className={styles.headerActions}>
        {(runState === "running" || runState === "ended" || (gpsMode === "native" && runState === "idle" && (gpsState === "denied" || gpsState === "error"))) && (
          <DriverGpsIndicator gpsState={gpsState} transmission={transmission} lastSentAt={lastSentAt} accuracy={accuracy} onRetry={runState !== "ended" ? gpsStart : undefined} mode={gpsMode} nativeMessage={nativeMessage} />
        )}
        {(runState === "idle" || (runState === "ended" && transmission !== "stop-unknown")) && (
          <button type="button" onClick={handleRunStart}
            // 2026-11-13 UI 통일: 테마 주 버튼(44px·네이비). 운전 중 누르는 버튼이라 academy-button-sm 은 쓰지 않는다.
            className="academy-button-primary shrink-0">
            {runState === "ended" ? "다시 운행 시작" : "운행 시작"}
          </button>
        )}
        {runState === "ended" && transmission === "stop-unknown" && (
          <button type="button" onClick={handleRunEnd}
            className="academy-button-tonal shrink-0">
            종료 재확인
          </button>
        )}
        {runState === "running" && <button type="button" disabled={transmission === "stopping" || confirmEnd} onClick={() => setConfirmEnd(true)} aria-expanded={confirmEnd} className="academy-button-danger shrink-0">{transmission === "stopping" ? "종료 확인 중" : "운행 종료"}</button>}
        </div>}
      </header>

      {/* 운행 종료 확인 — 기본 초점은 안전한 «계속 운행». 종료 버튼은 12px 떼어 오른쪽에. */}
      {confirmEnd && runState === "running" && (
        <div role="alertdialog" aria-labelledby="driver-run-end-title" className="mb-2 rounded-xl border border-[var(--color-academy-danger)] bg-[var(--color-academy-danger-soft)] p-3">
          <p id="driver-run-end-title" className="text-base font-semibold text-[var(--color-academy-ink)]">운행을 종료할까요?</p>
          <p className="mt-0.5 text-sm text-[var(--color-academy-muted)]">위치 공유가 멈춥니다.</p>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <button type="button" autoFocus onClick={() => setConfirmEnd(false)} className="academy-button-secondary">계속 운행</button>
            <button type="button" disabled={transmission === "stopping"} onClick={() => { setConfirmEnd(false); void handleRunEnd(); }} className="academy-button-danger-solid">운행 종료</button>
          </div>
        </div>
      )}

      {/* PWA 설치 배너 */}
      {showInstallBanner && (
        <div className="mb-2 flex items-center gap-2 rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-primary-soft)] px-2">
          <p className="min-w-0 flex-1 text-sm font-medium text-[var(--color-academy-ink)]">홈 화면에서 빠르게 열기</p>
          <button type="button" onClick={installPwa}
            className="min-h-11 min-w-11 text-sm font-medium text-[var(--color-academy-primary)]">설치</button>
          <button type="button" onClick={() => setShowInstallBanner(false)} aria-label="설치 안내 닫기" className="min-h-11 min-w-11 shrink-0 text-sm font-medium text-[var(--color-academy-muted)]">닫기</button>
        </div>
      )}

      <DriverDateNav date={date} prevDate={prevDate} nextDate={nextDate} today={today} />
      {/* 휴무 안내(원장 지시 2026-11-14) — 연간일정상 정규 수업 없는 날. 정규 줄은 회색·버튼 잠금(실수 체크 방지). */}
      {holiday && (
        <p role="status" className="mb-2 rounded-xl border border-[var(--color-academy-cal-closed)] bg-[var(--color-academy-cal-closed-soft)] px-3 py-2 text-base font-semibold text-[var(--color-academy-ink)]">
          {date === today ? "오늘은" : "이날은"} 휴무 ({holiday.title}) <span className="text-sm font-medium text-[var(--color-academy-muted)]">· 정규 셔틀 체크 없음</span>
        </p>
      )}
      {!initialBoardingReliable && <p role="alert" className="mb-2 text-sm font-semibold text-[var(--color-academy-danger)]">체크 기록을 불러오지 못했습니다. 미체크로 판단하지 말고 <button type="button" className="inline-flex min-h-11 min-w-11 items-center underline" onClick={() => window.location.reload()}>기록 다시 불러오기</button>를 눌러주세요. 확인 전에는 체크를 잠시 막습니다.</p>}

      {/* 순서 편집 */}
      {stopRows.length > 0 && (
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className={styles.runSummary}>운행 순서 · {stopRows.length}곳 <span>{initialBoardingReliable ? summary.total > 0 ? `체크 ${summary.checked}/${summary.total}` : "체크 대상 없음" : "기록 확인 필요"}</span>{upcoming.clockLabel && <span>{upcoming.isViewingToday ? `현재 ${upcoming.clockLabel} · 예정 시각 기준` : "선택한 날짜의 운행"}</span>}</p>
          {orderControls}
        </div>
      )}
      {editing && <p className="mb-2 rounded-xl bg-[var(--color-academy-info-soft)] px-3 py-2 text-sm text-[var(--color-academy-info)]">순서를 바꾸면 첫 탑승(하원은 학원 출발) 시각은 그대로 두고 뒤 정류장 시각을 지도 이동 시간으로 다시 계산합니다. 시간을 직접 수정할 수도 있습니다. 정규 셔틀만 저장됩니다.</p>}
      {/* 옮긴 묶음마다 다시 계산 결과 한 줄(어느 묶음이 지도 기준·추정인지, 학원 도착이 늦는지) */}
      {editing && Object.values(retimeNotes).map((n) => (
        <p key={n.groupKey} role="status" className={`mb-1 px-1 text-sm font-medium ${n.warn ? "text-[var(--color-academy-danger)]" : "text-[var(--color-academy-muted)]"}`}>
          {rows.find((r) => r.groupKey === n.groupKey)?.groupLabel ?? ""} {n.text}
        </p>
      ))}
      {saveMessage && <p className="mb-2 rounded-xl bg-[var(--color-academy-soft)] px-3 py-2 text-sm font-semibold text-[var(--color-academy-ink)]">{saveMessage}</p>}

      {stopRows.length === 0 && (
        <p className="rounded-2xl bg-[var(--color-academy-soft)] px-4 py-6 text-center text-base text-[var(--color-academy-faint)]">선택한 날짜에는 운행이 없습니다.</p>
      )}

      {/* 카드 목록 = 운행표 부품(RunBoard). 정렬·편집 상태는 이 화면이 들고, 탑승 버튼은 renderRider 로 끼운다. */}
      <RunBoard
        rows={ordered}
        mode="driver"
        editing={editing}
        dragKey={dragKey}
        onDragKeyChange={setDragKey}
        onDropOn={moveDraggedRow}
        onMove={moveRow}
        displayTime={displayTime}
        onTimeChange={(row, value) => { cancelRetime(); setTimeOverride((current) => ({ ...current, [row.key]: value })); }}
        upcoming={upcoming}
        renderStopMeta={renderStopMeta}
        renderRider={renderRider}
        focusKey={focusKey}
      />

      <details className="mt-3 text-sm text-[var(--color-academy-muted)]"><summary className="min-h-11 cursor-pointer py-3 font-medium">탑승 체크 사용 안내</summary><p className="pb-2">체크 후 저장 완료를 확인하세요. 잘못 눌렀으면 이름 아래 «대기로 되돌리기»를 누르세요(같은 버튼을 다시 눌러도 바뀌지 않습니다). 미탑승에서는 결석·자차를 구분할 수 있습니다. 결석 신고된 아이는 빨간 «결석» 표시와 함께 기본이 결석이라 들르지 않아도 되고, 실제로 탔으면 «탑승»을 누르세요.</p></details>
    </AcademyTheme>
  );
}
