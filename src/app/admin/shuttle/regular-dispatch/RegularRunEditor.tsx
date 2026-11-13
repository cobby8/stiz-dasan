"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import AcademyTheme from "@/components/academy/AcademyTheme";
import DriverLocationPanel from "@/components/admin/DriverLocationPanel";
import DriverRequestPanel from "@/components/admin/DriverRequestPanel";
import { adminErrorText } from "@/components/admin/adminDisplayText";
// 기사님 화면과 같은 카드 틀(RunBoard) + 같은 순수 조립 함수(buildRegularRunRows) — 관리자 화면 = 기사님 화면.
import RunBoard from "@/components/shuttle/run/RunBoard";
// PC 오른쪽 노선 지도 — 방학특강·옛 정규 배차가 쓰던 카카오 지도 부품 그대로(마커 번호 + 선).
import { RouteMapCanvas, type RouteMapStop } from "@/components/seasonal/DispatchRouteMap";
import styles from "@/components/shuttle/DriverWorkspace.module.css";
import NewStudentDispatchPanel from "@/components/shuttle/assign/NewStudentDispatchPanel";
import { useRouteRetime } from "@/components/shuttle/run/useRouteRetime";
import type { DriverAssignBoard } from "@/lib/shuttle/driverAssign";
import { buildRegularRunRows } from "@/lib/shuttle/regularRunRows";
import { placeUntimedRegularStops, runBlockLabel } from "@/lib/shuttle/runBlocks";
import type { RegularShuttleStop } from "@/lib/shuttle/regularSheet";
import { parseDriverScheduleTime } from "@/lib/shuttle/driverUpcoming";
import { hasRosterArrivalTime, recommendExistingStopTime } from "@/lib/shuttle/regularRosterPlacementLogic";
import { formatRosterMonths, rosterStudentKeyResolver, WEEKDAY_LABELS, type RosterScope } from "@/lib/shuttle/regularRosterEditLogic";
import type { UnifiedRider, UnifiedRow } from "@/lib/shuttle/unifiedDriverRunLogic";
import { monthNote, RemoveRiderDialog, rosterCall, StopEditDialog, StudentShuttleDialog, type ReassignLink } from "./RunEditDialogs";

// 관리자 «정규 셔틀 운행표» — 2026-11-09 원장 결정:
//   · 관리자 배차 화면 = 기사님 화면과 똑같이 보이고, 같은 화면에서 직접 수정한다.
//   · 자동 제안(T맵 자동 노선)·차량 이동·⇄ 는 없앴다. 셔틀 명단(RegularShuttleStop)이 유일한 정본이다.
//   · 2026-11-09 원장 점검: 평소엔 기사님 화면처럼 «보기만». 화면 위 [수정] 하나를 누르면 편집 모드 —
//     카드마다 시각 칸 · 손잡이(⠿)로 끌어 순서 이동(▲▼ 보조) · 정류장 수정 · 학생 이름 → 셔틀 정보 창 · × 빼기.
//     순서·시각은 [저장]에 모아 보내고, 정류장·학생·빼기는 창에서 바로 저장한다(기존 API 그대로).
//   · 2026-11-10 원장 점검: «수정 버튼이 섹션마다 있는 게 자연스러움, 연필 모양 아이콘 버튼만 작게».
//     → 화면 위 [수정] 하나 대신 묶음 머리마다 작은 연필. 누른 묶음 하나만 편집 모드(editingGroup)이고,
//       그 머리 줄에 [취소][저장], 바로 아래 한 줄에 적용 범위. 다른 묶음은 보기 그대로. 저장 API 는 그대로.
//   · «배정 필요» = 신규 + 반 이동 재배정(기존 신규 배차 패널·같은 API). 반 이동 학생은 카드에도 표시.
//   · 바뀌면 서버가 기사님께 «노선 확인하기» 알림을 보낸다(regularRosterNotify).
// 정렬·편집 상태는 이 화면이 들고, 카드 그리기는 RunBoard(mode="admin")가 한다.

type SortKey = { minutes: number | null; seq: number };
type Dialog =
  | { kind: "student"; rowId: string }
  | { kind: "remove"; rowId: string }
  | { kind: "stop"; rowIds: string[] };

const DOW_ORDER = [1, 2, 3, 4, 5, 6, 0];

export default function RegularRunEditor({ stops, serviceMonth, months, currentMonth, initialWeekday, initialStudentId, initialStopId, academy = null }: {
  /** 그 달 셔틀 명단 전체(서버가 읽어 준다 — 저장 뒤 router.refresh 로 다시 받는다). */
  stops: RegularShuttleStop[];
  serviceMonth: string;
  months: string[];
  /** 이번 달(KST, 서버 계산) — 지난 달이면 적용 범위 기본을 «이번 달만»으로. */
  currentMonth: string;
  initialWeekday: number;
  /** 신청 학생 바로 보기(?studentId=) — 그 학생 셔틀 정보 창을 바로 연다. */
  initialStudentId?: string;
  initialStopId?: string;
  /** 학원 좌표(순서를 옮길 때 시각 다시 계산 — 등원 도착·하원 출발 기준). 없으면 학원 구간 없이 계산. */
  academy?: { lat: number; lng: number } | null;
}) {
  const router = useRouter();
  const laterMonths = useMemo(() => months.filter((m) => m > serviceMonth).sort(), [months, serviceMonth]);
  const defaultScope: RosterScope = serviceMonth < currentMonth ? "THIS_MONTH" : "FROM_THIS_MONTH";

  // 요일 탭 — 월~토는 항상, 일요일은 명단이 있을 때만. 탭마다 학생 수.
  const dayCounts = useMemo(() => {
    const riders = stops.filter((s) => (s.direction === "BOARD" || s.direction === "ALIGHT") && s.studentName);
    const keyOf = rosterStudentKeyResolver(riders);
    return DOW_ORDER.map((w) => ({ weekday: w, count: new Set(riders.filter((s) => s.weekday === w).map(keyOf)).size }))
      .filter((d) => d.weekday !== 0 || d.count > 0);
  }, [stops]);
  const [weekday, setWeekday] = useState(initialWeekday);

  // 운행표 카드 = 기사님 화면과 같은 함수(결석·오늘만 변경은 날마다 달라 «월+요일» 기본형에선 끈다).
  const rows = useMemo(() => buildRegularRunRows({ stops, weekday }), [stops, weekday]);
  const targetRow = rows.find((row) => row.riders.some((rider) => rider.checkId === initialStopId));
  const targetGroup = targetRow?.groupKey ?? null;
  const targetRowKey = targetRow?.key;
  const stopsById = useMemo(() => new Map(stops.filter((s) => s.id).map((s) => [s.id!, s])), [stops]);
  const missingTimes = useMemo(() => stops.filter((stop) =>
    stop.id && stop.studentName && (stop.direction === "BOARD" || stop.direction === "ALIGHT") &&
    !hasRosterArrivalTime(stop.arriveTime)
  ), [stops]);

  // ── 순서·시각 편집(기사님 화면 UnifiedDriverClient 와 같은 규칙: 같은 묶음 안에서만, 옮기면 시각 칸도 함께) ──
  // 편집 중인 묶음(수업시간 × 등/하원의 groupKey) 하나 — null 이면 보기 모드. 동시에 한 묶음만 편집한다.
  const [editingGroup, setEditingGroup] = useState<string | null>(targetGroup); // EDIT_GROUP
  const editing = editingGroup != null;
  const [sourceRows, setSourceRows] = useState<UnifiedRow[]>(rows);
  const [sortOverride, setSortOverride] = useState<Record<string, SortKey>>({});
  const [timeOverride, setTimeOverride] = useState<Record<string, string>>({});
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [orderScope, setOrderScope] = useState<RosterScope>(defaultScope);
  const [savingOrder, setSavingOrder] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 순서를 옮기면 그 묶음 시각을 지도 이동 시간으로 다시 계산한다(useRouteRetime).
  const { retime, note: retimeNote, cancelPending: cancelRetime, clearNote: clearRetimeNote } = useRouteRetime({ academy });

  function displayTime(row: UnifiedRow): string | null {
    return editing && timeOverride[row.key] !== undefined ? timeOverride[row.key] || null : row.time;
  }
  const ordered = useMemo(() => {
    const base = editing ? sourceRows : rows;
    const keyOf = (r: UnifiedRow): SortKey => {
      const k = (editing ? sortOverride[r.key] : undefined) ?? { minutes: r.minutes, seq: r.seq };
      return editing && timeOverride[r.key] !== undefined ? { ...k, minutes: parseDriverScheduleTime(timeOverride[r.key]) } : k;
    };
    const sorted = [...base].sort((a, b) => {
      const ka = keyOf(a), kb = keyOf(b);
      if (ka.minutes == null && kb.minutes == null) return ka.seq - kb.seq;
      if (ka.minutes == null) return 1;
      if (kb.minutes == null) return -1;
      return ka.minutes === kb.minutes ? ka.seq - kb.seq : ka.minutes - kb.minutes;
    });
    return placeUntimedRegularStops(sorted, (row) => keyOf(row).minutes != null);
  }, [rows, sourceRows, editing, sortOverride, timeOverride]);

  // 순서를 옮기면 그 묶음 시각을 다시 계산한다(2026-11-13 원장 결정 — routeRetime.ts):
  //   등원은 첫 탑승 시각 고정, 하원은 학원 출발 시각 고정 → 지도 이동 시간 × 기사님 속도 배율을 쌓는다.
  //   좌표가 없는 정류장이 있는 등 계산할 수 없을 때만 예전처럼 «시각 칸은 자리에 두고 정류장만 바꾼다».
  function reorderGroup(same: UnifiedRow[], next: UnifiedRow[]) {
    const groupKey = next[0]?.groupKey;
    if (!groupKey) return;
    // 정렬 칸(seq)은 자리 그대로 — 같은 시각이 나와도 새 순서가 유지된다.
    // seq 는 원래 명단 번호라 시각순과 어긋날 수 있다 → 오름차순으로 나눠 줘야 같은 시각에서도 새 순서가 유지된다.
    const slotSeq = same.map((slot) => sortOverride[slot.key]?.seq ?? slot.seq).sort((a, b) => a - b);
    const saved = sourceRows.filter((r) => r.groupKey === groupKey && !r.isTerminal);
    const done = retime(groupKey, saved, same, next, displayTime, (times) => {
      const nextSort: Record<string, SortKey> = {};
      next.forEach((row, i) => { nextSort[row.key] = { minutes: parseDriverScheduleTime(times[row.key] ?? null), seq: slotSeq[i] }; });
      setSortOverride((o) => ({ ...o, ...nextSort }));
      setTimeOverride((t) => ({ ...t, ...times }));
    });
    if (done) return;
    const nextSort: Record<string, SortKey> = {}, nextTimes: Record<string, string> = {};
    same.forEach((slot, i) => {
      nextSort[next[i].key] = { minutes: parseDriverScheduleTime(displayTime(slot)), seq: slotSeq[i] };
      nextTimes[next[i].key] = displayTime(slot) ?? "";
    });
    setSortOverride((o) => ({ ...o, ...nextSort }));
    setTimeOverride((t) => ({ ...t, ...nextTimes }));
  }
  function moveRow(row: UnifiedRow, dir: -1 | 1) {
    const same = ordered.filter((r) => r.groupKey === row.groupKey && !r.isTerminal);
    const idx = same.findIndex((r) => r.key === row.key);
    if (idx < 0 || !same[idx + dir]) return;
    const next = [...same];
    [next[idx], next[idx + dir]] = [next[idx + dir], next[idx]];
    reorderGroup(same, next);
  }
  function moveDragged(target: UnifiedRow) {
    if (!dragKey || dragKey === target.key) return;
    const from = ordered.find((r) => r.key === dragKey);
    if (!from || from.groupKey !== target.groupKey || from.isTerminal || target.isTerminal) return;
    const same = ordered.filter((r) => r.groupKey === target.groupKey && !r.isTerminal);
    const fromIdx = same.findIndex((r) => r.key === from.key), toIdx = same.findIndex((r) => r.key === target.key);
    if (fromIdx < 0 || toIdx < 0) return;
    const next = [...same];
    next.splice(fromIdx, 1);
    next.splice(toIdx, 0, from);
    reorderGroup(same, next);
  }

  // 묶음 머리 연필 → 그 묶음만 편집. 다른 묶음을 편집하다 저장 안 한 변경이 있으면 버릴지 먼저 묻는다.
  // 편집하는 묶음을 PC 지도에도 띄운다(고친 순서가 지도 번호로 바로 보이게).
  function startEditing(groupKey: string) {
    if (savingOrder || groupKey === editingGroup) return;
    if (orderDirty && !window.confirm("저장하지 않은 순서·시각 수정이 있습니다. 버리고 이 묶음을 수정할까요?")) return;
    setSourceRows(rows); setSortOverride({}); setTimeOverride({}); setOrderScope(defaultScope); setMessage(null); setError(null); clearRetimeNote();
    setEditingGroup(groupKey);
    setPickedGroup(groupKey);
  }
  function cancelEditing() { setEditingGroup(null); setSortOverride({}); setTimeOverride({}); clearRetimeNote(); }

  // 바뀐 묶음(수업시간 × 등/하원) 목록 — 저장할 때 보낼 것이자 «저장 안 한 변경이 있나» 판정.
  // 수업시간 글자는 명단 행 그대로(공백까지 — 서버가 글자 그대로 비교한다).
  const changedGroups = (() => {
    if (!editing) return [];
    const groupPayload = (list: UnifiedRow[], timeOf: (r: UnifiedRow) => string | null) => {
      const out = new Map<string, { rowIds: string[]; arriveTime: string | null }[]>();
      for (const r of list) {
        if (r.isTerminal || r.kind !== "REGULAR") continue;
        const rowIds = r.riders.map((x) => x.checkId);
        if (rowIds.length === 0) continue;
        out.set(r.groupKey, [...(out.get(r.groupKey) ?? []), { rowIds, arriveTime: timeOf(r) }]);
      }
      return out;
    };
    const after = groupPayload(ordered, displayTime);
    const before = groupPayload(sourceRows, (r) => r.time);
    return [...after.entries()].filter(([key, list]) =>
      JSON.stringify(list) !== JSON.stringify(before.get(key)) ||
      ordered.some((row) => row.groupKey === key && hasRosterArrivalTime(timeOverride[row.key]) &&
        row.riders.some((rider) => !hasRosterArrivalTime(stopsById.get(rider.checkId)?.arriveTime)))
    );
  })();
  const orderDirty = changedGroups.length > 0;

  // 편집 중 창(정류장·학생·빼기)에서 저장하면 router.refresh 로 명단이 새로 온다.
  // 순서·시각을 안 바꾼 상태면 편집 기준(sourceRows)을 새 명단으로 바꿔 끼운다(편집 모드는 유지).
  // React 권장 «렌더 중 이전 값 비교» 방식 — 효과(useEffect) 없이 한 번에 맞춘다.
  const [seenRows, setSeenRows] = useState(rows);
  if (seenRows !== rows) {
    setSeenRows(rows);
    if (editing && !orderDirty) { setSourceRows(rows); setSortOverride({}); setTimeOverride({}); }
  }

  // 저장 = 묶음마다 명단 «reorder»(그 묶음이 쓰던 순서 번호를 돌려 쓰고 시각을 넣는다). 바뀐 묶음만 보낸다.
  // keepEditing = 창을 열기 전 «먼저 저장» — 저장 뒤에도 편집 모드를 유지한다. 성공하면 true.
  async function saveOrder(keepEditing = false): Promise<boolean> {
    if (savingOrder) return false;
    const changed = changedGroups;
    if (changed.length === 0) { if (!keepEditing) cancelEditing(); return true; }
    cancelRetime(); // 저장 중에 늦게 온 지도 계산이 화면 시각을 바꾸지 않게
    setSavingOrder(true); setError(null); setMessage(null);
    let done = 0;
    let note = "";
    try {
      for (const [, list] of changed) {
        const head = stopsById.get(list[0].rowIds[0]);
        if (!head || head.classTime == null) throw new Error("명단이 그사이 바뀌었습니다. 화면을 새로고침해 주세요.");
        const j = await rosterCall("PATCH", {
          action: "reorder", serviceMonth, scope: orderScope, weekday, classTime: head.classTime,
          direction: head.direction, stops: list,
        });
        note = monthNote(j);
        done += 1;
      }
      setMessage(`순서·시각 저장 완료 · ${done}묶음${note} · 기사님께 알림을 보냈어요`);
      if (keepEditing) {
        // 새 명단이 오기 전까지 지금 순서·시각을 편집 기준으로 삼는다(화면이 옛 순서로 튀지 않게).
        setSourceRows(ordered.map((r, i) => ({ ...r, time: displayTime(r), minutes: parseDriverScheduleTime(displayTime(r)), seq: i })));
      } else {
        setEditingGroup(null);
      }
      setSortOverride({}); setTimeOverride({}); clearRetimeNote();
      return true;
    } catch (e) {
      // 앞 묶음은 이미 저장됐을 수 있다 — 몇 묶음이 저장됐는지 알리고 화면을 새로 읽는다.
      setError(`${done > 0 ? `${done}묶음은 저장됐고, ` : ""}${adminErrorText(e, "저장하지 못했습니다.")}`);
      setEditingGroup(null); setSortOverride({}); setTimeOverride({}); clearRetimeNote();
      return false;
    } finally {
      setSavingOrder(false);
      router.refresh();
    }
  }

  // ── 배정 필요(신규·반 이동) 연결 ──
  const [board, setBoard] = useState<DriverAssignBoard | null>(null);
  const [openRequest, setOpenRequest] = useState<{ studentId: string; legKey: string; nonce: number } | null>(null);
  // 옛 칸 행 id → 그 학생의 반 이동 재배정 칸(카드의 «반 이동» 표시·셔틀 정보 창에 쓴다).
  const reassignByRowId = useMemo(() => {
    const map = new Map<string, ReassignLink[]>();
    for (const s of board?.students ?? []) {
      for (const leg of s.legs) {
        if (!leg.reassign) continue;
        const link = { studentId: s.studentId, legKey: leg.key, label: leg.reassign.label };
        for (const id of leg.reassign.replaceRowIds) map.set(id, [...(map.get(id) ?? []), link]);
      }
    }
    return map;
  }, [board]);
  const reassignForStudent = useCallback((rowId: string): ReassignLink[] => {
    const sid = stopsById.get(rowId)?.studentId;
    const s = sid ? board?.students.find((x) => x.studentId === sid) : null;
    return s ? s.legs.filter((l) => l.reassign).map((l) => ({ studentId: s.studentId, legKey: l.key, label: l.reassign!.label })) : reassignByRowId.get(rowId) ?? [];
  }, [board, stopsById, reassignByRowId]);
  function openReassign(link: ReassignLink) { void guardThen(() => { setDialog(null); setOpenRequest({ studentId: link.studentId, legKey: link.legKey, nonce: Date.now() }); }); }

  // 순서·시각을 바꾼 채 다른 창을 열면, 창 저장 뒤 새 명단과 손댄 순서가 엉킨다 → 먼저 저장할지 묻는다.
  async function guardThen(open: () => void) {
    if (!orderDirty) { open(); return; }
    if (!window.confirm("바꾼 순서·시각을 먼저 저장할까요?")) return;
    if (await saveOrder(true)) open();
  }
  function openDialog(next: Dialog) { void guardThen(() => setDialog(next)); }

  // ── 편집 창 ──
  const [dialog, setDialog] = useState<Dialog | null>(() => {
    if (!initialStudentId || initialStopId) return null;
    const hit = stops.find((s) => s.studentId === initialStudentId && s.id && (s.direction === "BOARD" || s.direction === "ALIGHT"));
    return hit ? { kind: "student", rowId: hit.id! } : null;
  });
  function afterSaved(text: string) { setDialog(null); setError(null); setMessage(text); router.refresh(); }

  // 기사님 위치·요청(옛 배차 화면에서 그대로 옮김).
  const [showLocations, setShowLocations] = useState(false);
  const [showRequests, setShowRequests] = useState(false);
  const [pendingRequests, setPendingRequests] = useState(0);
  const loadPendingRequests = useCallback(() => {
    fetch("/api/admin/driver-requests", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { requests?: { status: string }[] } | null) => { if (d?.requests) setPendingRequests(d.requests.filter((r) => r.status === "PENDING").length); })
      .catch(() => null);
  }, []);
  useEffect(() => { loadPendingRequests(); }, [loadPendingRequests]);

  // 등원·하원 수업시간이 다른 학생(명단 자료 점검 — 자동으로 고치지 않는다).
  const mismatches = useMemo(() => {
    const day = stops.filter((s) => s.weekday === weekday && s.studentName && (s.direction === "BOARD" || s.direction === "ALIGHT"));
    const keyOf = rosterStudentKeyResolver(day);
    const by = new Map<string, { name: string; board: string | null; alight: string | null }>();
    for (const s of day) {
      const k = keyOf(s);
      const v = by.get(k) ?? { name: s.studentName!, board: null, alight: null };
      if (s.direction === "BOARD") v.board = s.classTime; else v.alight = s.classTime;
      by.set(k, v);
    }
    return [...by.values()].filter((v) => v.board && v.alight && v.board !== v.alight);
  }, [stops, weekday]);

  function confirmLeave() { return !orderDirty || window.confirm("저장하지 않은 순서·시각 수정이 있습니다. 이동하면 사라집니다. 계속할까요?"); }

  const stopRows = ordered.filter((r) => !r.isTerminal);
  // 적용 범위 고르기 글자(예: «11월부터 계속» / «11월만»).
  const monthLabel = `${Number(serviceMonth.slice(5, 7))}월`;
  // 고른 범위가 어느 달 명단에 들어가는지(예: «11월~12월 명단에 반영»). 다음 달 명단이 아직 없으면 복사 안내.
  const scopeHint = orderScope === "THIS_MONTH"
    ? `${formatRosterMonths([serviceMonth])} 명단만`
    : laterMonths.length > 0 ? `${formatRosterMonths([serviceMonth, ...laterMonths])} 명단에 반영` : "다음 달은 이 달을 복사해 만들어요";
  const riderCount = new Set(stopRows.flatMap((r) => r.riders.map((x) => x.checkId))).size;

  // ── PC 오른쪽 노선 지도(≥1024px) ──
  // 블록 머리를 누르면 그 묶음(수업시간 × 등/하원)을 지도에 띄운다. 고른 게 없거나 요일이 바뀌어 사라지면 첫 묶음.
  // 마커 번호 = 카드 순번(화면에 보이는 숫자 그대로) — 순서·시각을 바꾸면 지도도 바로 따라간다.
  const [pickedGroup, setPickedGroup] = useState<string | null>(targetGroup);
  useEffect(() => {
    if (!initialStopId || !targetRowKey) return;
    const cards = document.querySelectorAll<HTMLElement>("[data-run-key]");
    [...cards].find((card) => card.dataset.runKey === targetRowKey)?.scrollIntoView({ block: "center" });
  }, [initialStopId, targetRowKey]);
  const mapGroupKey = stopRows.some((r) => r.groupKey === pickedGroup) ? pickedGroup : stopRows[0]?.groupKey ?? null;
  const mapRows = stopRows.filter((r) => r.groupKey === mapGroupKey);
  const mapStopsNow: RouteMapStop[] = stopRows
    .map((r, i) => ({ row: r, badge: String(i + 1) }))
    .filter(({ row }) => row.groupKey === mapGroupKey && row.lat != null && row.lng != null)
    .map(({ row, badge }) => ({ lat: row.lat!, lng: row.lng!, label: row.label, badge, kind: "stop" as const }));
  // 지도는 «좌표·이름·순번»이 실제로 바뀔 때만 다시 그린다 — 시각만 고칠 때 지도 확대·위치가 초기화되지 않게(리뷰 반영).
  const mapStopsKey = mapStopsNow.map((s) => `${s.badge}|${s.lat}|${s.lng}|${s.label}`).join(";");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const mapStops = useMemo(() => mapStopsNow, [mapStopsKey]);
  // 휴대폰·좁은 화면에서는 지도를 만들지 않는다(카카오 지도 불러오기 생략). 처음 그릴 땐 false → 화면에 붙은 뒤 판정.
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const sync = () => setWide(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  // 카드 머리 보조 줄(관리자) — 보기 모드 = 학생 수. 편집 모드 = 한 줄 카드 오른쪽 «정류장 수정»(학생 수는 칩으로 보인다).
  // 편집 중인 묶음의 카드만 편집용으로 그린다(다른 묶음 카드는 보기 그대로).
  function renderStopMeta(row: UnifiedRow) {
    const rowEditing = editingGroup === row.groupKey;
    const missing = rowEditing && row.riders.map((rider) => stopsById.get(rider.checkId))
      .find((stop) => stop && !hasRosterArrivalTime(stop.arriveTime));
    const recommendation = missing ? recommendExistingStopTime(stops, missing) : null;
    return (
      <>
        {!rowEditing && <span>{row.riders.length}명</span>}
        {rowEditing && (() => {
          // 다시 계산으로 바뀐 시각은 «이전 시각»을 작게 함께 보여 준다(무엇이 바뀌었는지 저장 전에 확인).
          const before = sourceRows.find((r) => r.key === row.key)?.time ?? null;
          const now = displayTime(row);
          return before && now && before !== now ? <span className="text-xs text-[var(--color-academy-muted)]">이전 {before}</span> : null;
        })()}
        {recommendation && (
          <button type="button" disabled={savingOrder} onClick={() => setTimeOverride((values) => ({ ...values, [row.key]: recommendation }))}
            className="min-h-11 px-1 text-xs font-medium text-[var(--color-academy-primary)] underline">
            추천 {recommendation} 적용
          </button>
        )}
        {missing && !recommendation && <span className="text-xs text-[var(--color-academy-warning)]">정차 순서와 시각 확인 필요</span>}
        {rowEditing && row.kind === "REGULAR" && row.riders.length > 0 && (
          <button type="button" disabled={savingOrder} onClick={() => openDialog({ kind: "stop", rowIds: row.riders.map((x) => x.checkId) })}
            aria-label={`${row.label} 정류장 수정`} title="정류장 수정(이름·위치·시각)"
            className="inline-flex min-h-11 items-center gap-0.5 whitespace-nowrap rounded-lg px-1 text-sm font-medium text-[var(--color-academy-primary)] underline underline-offset-2">
            정류장
          </button>
        )}
      </>
    );
  }

  // 학생 한 줄(관리자) — 보기 모드는 이름만(기사님 화면처럼). 편집 모드는 칩: 이름(누르면 셔틀 정보 창) · «빼기»(명단에서 빼기).
  // 2026-11-13 UI 통일: × 아이콘만 있던 빼기 버튼을 글자 «빼기»로(아이콘만 있는 버튼 금지).
  // 반 이동 표시는 배정 할 일이라 두 모드 모두 누를 수 있다.
  // 색: «반 이동» 버튼은 주의 할 일로 이동하는 버튼 — 주황 채움 대신 옅은 주의 바탕 + 진한 주의 글자 + 테두리(2026-11-09)
  function renderRider(row: UnifiedRow, rider: UnifiedRider) {
    const links = reassignByRowId.get(rider.checkId) ?? [];
    // 편집 모드 = 한 줄 카드 안의 «칩»(이름 → 셔틀 정보 창 · × → 명단에서 빼기). 넓게 빈 학생 칸을 없앤다.
    // 편집 중인 묶음의 학생만 칩 — 다른 묶음은 보기 줄 그대로.
    if (editingGroup === row.groupKey) {
      return (
        <span key={`${row.key}:${rider.checkId}`} className="inline-flex items-center rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)]">
          <button type="button" disabled={savingOrder} onClick={() => openDialog({ kind: "student", rowId: rider.checkId })} aria-label={`${rider.name} 셔틀 정보 수정`}
            className="min-h-11 pl-2 pr-0.5 text-left text-sm font-medium text-[var(--color-academy-ink)] underline decoration-dotted underline-offset-4">{rider.name}</button>
          {links.map((l) => (
            <button key={l.legKey} type="button" disabled={savingOrder} onClick={() => openReassign(l)} aria-label={`${rider.name} ${l.label} 재배정`} title="반 이동 · 재배정"
              className="inline-flex min-h-11 items-center gap-0.5 rounded-md border border-[var(--color-academy-warning)] bg-[var(--color-academy-warning-soft)] px-1.5 text-xs font-medium text-[var(--color-academy-warning)]">
              반 이동
            </button>
          ))}
          <button type="button" disabled={savingOrder} onClick={() => openDialog({ kind: "remove", rowId: rider.checkId })} aria-label={`${rider.name} 명단에서 빼기`}
            className="inline-flex min-h-11 items-center whitespace-nowrap px-2 text-xs font-medium text-[var(--color-academy-danger)]">
            빼기
          </button>
        </span>
      );
    }
    return (
      <div key={`${row.key}:${rider.checkId}`} className={`${styles.rider} rounded-xl bg-[var(--color-academy-soft)]`}>
        <div className={styles.riderMain}>
          <div className={styles.riderInfo}>
            <div className={styles.identity}>
              <span className="break-all text-lg font-semibold text-[var(--color-academy-ink)]">{rider.name}</span>
              {rider.grade && <span className="text-sm text-[var(--color-academy-muted)]">{rider.grade}</span>}
              {links.map((l) => (
                <button key={l.legKey} type="button" disabled={savingOrder} onClick={() => openReassign(l)} aria-label={`${rider.name} ${l.label} 재배정`}
                  className="inline-flex min-h-11 items-center gap-0.5 rounded-md border border-[var(--color-academy-warning)] bg-[var(--color-academy-warning-soft)] px-2 text-sm font-medium text-[var(--color-academy-warning)]">
                  반 이동 · 재배정
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // 편집 중인 묶음 머리 줄 오른쪽 — [취소][저장] 작게(테마 academy-button-sm: PC 36px · 터치 화면 44px).
  function renderEditActions() {
    return (
      <>
        <button type="button" onClick={() => { if (confirmLeave()) cancelEditing(); }} disabled={savingOrder} className="academy-button-secondary academy-button-sm">취소</button>
        <button type="button" onClick={() => void saveOrder()} disabled={savingOrder} className="academy-button-primary academy-button-sm">{savingOrder ? "저장 중…" : "저장"}</button>
      </>
    );
  }
  // 편집 중인 묶음 머리 바로 아래 한 줄 — 저장 안 됨 표시 · 끌기 안내 · 적용 범위(N월부터 계속 / N월만).
  function renderEditBar() {
    return (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-[var(--color-academy-line)] px-2 py-1">
        <p className="mr-auto text-xs text-[var(--color-academy-muted)]">
          {orderDirty && <span className="mr-1 text-sm font-semibold text-[var(--color-academy-warning)]">저장 안 됨 ·</span>}
          ⠿ 끌어서 순서 변경
        </p>
        {retimeNote && retimeNote.groupKey === editingGroup && (
          // 순서를 옮긴 뒤 시각 다시 계산 결과 — 학원 도착이 수업 시작보다 늦거나 계산을 못 했으면 경고색.
          <p role="status" className={`basis-full text-xs ${retimeNote.warn ? "text-[var(--color-academy-warning)]" : "text-[var(--color-academy-muted)]"}`}>
            {retimeNote.text}
          </p>
        )}
        <label className="flex items-center gap-1 text-sm font-medium text-[var(--color-academy-muted)]">
          적용
          <select value={orderScope} onChange={(e) => setOrderScope(e.target.value as RosterScope)} aria-label="순서·시각 적용 범위"
            className="min-h-11 rounded-lg border border-[var(--color-academy-line-input)] bg-[var(--color-academy-surface)] px-2 text-sm text-[var(--color-academy-ink)]">
            <option value="FROM_THIS_MONTH">{monthLabel}부터 계속</option>
            <option value="THIS_MONTH">{monthLabel}만</option>
          </select>
          <span className="text-xs font-normal">{scopeHint}</span>
        </label>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-3">
      {/* 한 줄 머리: 제목 · 월 · 기사님 위치·요청(컴팩트 — 히어로 없음) */}
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="academy-section-title mr-auto">정규 셔틀 운행표</h3>
        <select value={serviceMonth} aria-label="운행 월" onChange={(e) => { if (!confirmLeave()) return; cancelEditing(); router.push(`/admin/shuttle/regular-dispatch?month=${encodeURIComponent(e.target.value)}`); }}
          className="min-h-11 rounded-lg border border-[var(--color-academy-line-input)] bg-[var(--color-academy-surface)] px-3 text-sm">
          {months.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <button type="button" onClick={() => {
          if (confirmLeave()) router.push(`/admin/shuttle/regular?${new URLSearchParams({ month: serviceMonth, weekday: String(weekday), add: "1" })}`);
        }} className="academy-button-primary">
          학생 추가
        </button>
        <button type="button" onClick={() => setShowLocations(true)} className="academy-button-secondary">
          실시간 위치
        </button>
        <button type="button" onClick={() => setShowRequests(true)} className="academy-button-secondary relative">
          기사 요청
          {pendingRequests > 0 && <span className="absolute -right-1.5 -top-1.5 grid h-5 min-w-5 place-items-center rounded-full bg-[var(--color-academy-danger)] px-1 text-xs font-semibold tabular-nums text-[var(--color-academy-on-primary)]">{pendingRequests}</span>}
        </button>
        {/* 편집은 묶음 머리마다 작은 연필로 들어간다(2026-11-10) — 화면 위 [수정] 버튼은 없앴다. */}
      </div>
      {showLocations && <DriverLocationPanel onClose={() => setShowLocations(false)} />}
      {showRequests && <DriverRequestPanel onClose={() => { setShowRequests(false); loadPendingRequests(); }} />}

      {/* 요일 탭(학생 수) */}
      <div role="tablist" aria-label="요일" className="mt-2 flex flex-wrap gap-1">
        {dayCounts.map((d) => (
          <button key={d.weekday} type="button" role="tab" aria-selected={weekday === d.weekday}
            // 요일을 바꾸면 묶음 편집을 끝낸다(요일마다 묶음이 다르다) — 손댄 순서·시각이 있으면 먼저 확인.
            onClick={() => { if (d.weekday !== weekday && confirmLeave()) { cancelEditing(); setWeekday(d.weekday); } }}
            // 요일 탭 = «지금 보는 것» — 보조 색, ✓ 없음(테마 academy-choice is-tab)
            className={`academy-choice is-tab${weekday === d.weekday ? " is-selected" : ""}`}>
            {WEEKDAY_LABELS[d.weekday]} <span className="text-xs font-normal tabular-nums">{d.count}</span>
          </button>
        ))}
      </div>

      {/* 배정 필요(신규 + 반 이동) — 한 줄 요약, 누르면 펼침. 넣으면 운행표를 다시 읽는다. */}
      <NewStudentDispatchPanel key={serviceMonth} month={serviceMonth} selectedWeekday={weekday}
        onAssigned={() => { setMessage(null); router.refresh(); }} onBoard={setBoard} openRequest={openRequest} />
      {missingTimes.length > 0 && (
        <details className="mt-2 rounded-lg bg-[var(--color-academy-warning-soft)] p-3 text-sm">
          <summary className="cursor-pointer font-medium text-[var(--color-academy-warning)]">배차 필요 · 시각 미입력 {missingTimes.length}건</summary>
          <ul className="mt-2 flex flex-wrap gap-2">
            {missingTimes.map((stop) => (
              <li key={stop.id}>
                <button type="button" className="inline-flex min-h-10 max-w-full flex-wrap items-center gap-x-2 rounded-full border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-3 py-1 text-left text-xs text-[var(--color-academy-ink)] hover:border-[var(--color-academy-warning)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-academy-warning)]" onClick={() => {
                  if (!confirmLeave()) return;
                  router.push(`/admin/shuttle/regular-dispatch?${new URLSearchParams({ month: serviceMonth, studentId: stop.studentId ?? "", stopId: stop.id! })}`);
                }}>
                  <span className="font-semibold">{stop.studentName}</span>
                  <span>{WEEKDAY_LABELS[stop.weekday]}요일 {stop.direction === "BOARD" ? "등원" : "하원"}</span>
                  <span className="text-[var(--color-academy-muted)]">{stop.classTime ?? "수업시간 미입력"}</span>
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}

      {mismatches.length > 0 && (
        <p className="mt-2 rounded-lg bg-[var(--color-academy-warning-soft)] px-3 py-2 text-xs text-[var(--color-academy-warning)]">
          등원·하원 수업시간이 다른 학생 {mismatches.length}명 — {mismatches.map((m) => `${m.name}(등원 ${m.board}/하원 ${m.alight})`).join(", ")}. 학생 이름을 눌러 확인해 주세요.
        </p>
      )}
      {message && <p role="status" className="mt-2 rounded-lg bg-[var(--color-academy-success-soft)] px-3 py-2 text-sm text-[var(--color-academy-success)]">{message}</p>}
      {error && <p role="alert" className="mt-2 rounded-lg bg-[var(--color-academy-danger-soft)] px-3 py-2 text-sm text-[var(--color-academy-danger)]">{error}</p>}

      {/* PC(≥1024px) = 왼쪽 운행표 · 오른쪽 고정 지도. 좁은 화면은 운행표만(지도 숨김). */}
      <div className="mt-2 lg:grid lg:grid-cols-[minmax(0,1fr)_300px] lg:items-start lg:gap-4">
      {/* 운행표 — 기사님 화면과 같은 카드(같은 CSS·같은 테마). 탑승 버튼 대신 편집 손잡이. */}
      <AcademyTheme role="driver" className={`${styles.workspace} mx-auto min-w-0`}>
        {stopRows.length > 0 && (
          <p className={`${styles.runSummary} mb-2`}>{WEEKDAY_LABELS[weekday]}요일 운행 순서 · {stopRows.length}곳 <span>학생 {riderCount}명</span></p>
        )}
        {stopRows.length === 0 && <p className="rounded-2xl bg-[var(--color-academy-soft)] px-4 py-6 text-center text-base text-[var(--color-academy-faint)]">{WEEKDAY_LABELS[weekday]}요일에는 운행이 없습니다.</p>}
        <RunBoard
          rows={ordered}
          mode="admin"
          editing={editing}
          // 묶음 하나만 편집 — 머리 연필로 들어가고, 그 머리 줄에 [취소][저장]·아래 한 줄에 적용 범위.
          editingGroupKey={editingGroup}
          onEditBlock={startEditing}
          renderEditActions={renderEditActions}
          renderEditBar={renderEditBar}
          dragKey={dragKey}
          onDragKeyChange={setDragKey}
          onDropOn={moveDragged}
          onMove={moveRow}
          displayTime={displayTime}
          onTimeChange={(row, value) => { cancelRetime(); setTimeOverride((t) => ({ ...t, [row.key]: value })); }}
          renderStopMeta={renderStopMeta}
          renderRider={renderRider}
          selectedGroupKey={wide ? mapGroupKey : null}
          // 지도가 없는 좁은 화면에서는 머리를 누를 이유가 없으니 글자만(버튼 아님).
          onSelectBlock={wide ? setPickedGroup : undefined}
        />
      </AcademyTheme>

      {/* 노선 지도(PC 전용) — 고른 묶음의 정류장을 카드 순번대로 마커 + 점선. 내려도 늘 보이게 sticky. */}
      {stopRows.length > 0 && (
        <aside aria-label="노선 지도" className="hidden lg:sticky lg:top-[4.5rem] lg:block">
          <div className="overflow-hidden rounded-2xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)]">
            <p className="flex flex-wrap items-center gap-x-1.5 px-3 py-2 text-sm font-semibold text-[var(--color-academy-ink)]">
              {mapRows[0] ? runBlockLabel(mapRows[0]) : "노선"}
              <span className="text-xs font-normal text-[var(--color-academy-muted)]">정류장 {mapRows.length}곳</span>
            </p>
            {wide
              ? <RouteMapCanvas start={null} end={null} stops={mapStops} heightClass="h-[58vh]" />
              : <div className="h-[58vh] bg-[var(--color-academy-soft)]" />}
            {mapStops.length < mapRows.length && (
              <p className="border-t border-[var(--color-academy-line)] px-3 py-2 text-xs text-[var(--color-academy-warning)]">
                위치가 없는 정류장 {mapRows.length - mapStops.length}곳은 지도에 안 보여요 — «정류장 수정»에서 위치를 정해 주세요.
              </p>
            )}
            <p className="border-t border-[var(--color-academy-line)] px-3 py-2 text-xs text-[var(--color-academy-muted)]">왼쪽 묶음 머리를 누르면 그 노선을 보여 줘요.</p>
          </div>
        </aside>
      )}
      </div>

      {dialog?.kind === "student" && (
        <StudentShuttleDialog key={dialog.rowId} stops={stops} rowId={dialog.rowId} serviceMonth={serviceMonth} laterMonths={laterMonths} defaultScope={defaultScope}
          reassign={reassignForStudent(dialog.rowId)} onOpenReassign={openReassign} onClose={() => setDialog(null)} onSaved={afterSaved} />
      )}
      {dialog?.kind === "remove" && (
        <RemoveRiderDialog key={dialog.rowId} stops={stops} rowId={dialog.rowId} serviceMonth={serviceMonth} laterMonths={laterMonths} defaultScope={defaultScope}
          onClose={() => setDialog(null)} onSaved={afterSaved} />
      )}
      {dialog?.kind === "stop" && (
        <StopEditDialog key={dialog.rowIds.join(",")} stops={stops} rowIds={dialog.rowIds} serviceMonth={serviceMonth} laterMonths={laterMonths} defaultScope={defaultScope}
          onClose={() => setDialog(null)} onSaved={afterSaved} />
      )}
    </div>
  );
}
