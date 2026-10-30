"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { RegularShuttleStop } from "@/lib/shuttle/regularSheet";
import AdminModal from "@/components/admin/AdminModal";
import AdminQuickActionMenu, { type AdminQuickAction } from "@/components/admin/AdminQuickActionMenu";
import AdminPanelActions from "@/components/admin/AdminPanelActions";
import ListDetailPanel from "@/components/admin/list/ListDetailPanel";
import ListViewToggle, { useRememberedListView, type ListViewOption } from "@/components/admin/list/ListViewToggle";
import LocationPickerModal, { type MapLocationData } from "@/components/maps/LocationPickerModal";
import {
  formatRosterMonths,
  groupRosterDay,
  classTimeKey,
  nextServiceMonth,
  placementKey,
  rosterRowIdsForStudent,
  WEEKDAY_LABELS,
  type RosterClassSlot,
  type RosterScope,
  type RosterStudentEntry,
} from "@/lib/shuttle/regularRosterEditLogic";
import type { RosterStudentContext, RosterStudentSearchResult } from "@/lib/shuttle/regularRosterEdit";
import { checkRosterRows } from "@/lib/shuttle/regularRosterCheckLogic";
import { defaultStopFromRiding, enrolledClassSlots, resolveCellPlacement, resolveStudentPoint, studentRosterRows, type PlacementOverride, type ResolvedStudentPoint, type StudentPointSource } from "@/lib/shuttle/regularRosterPlacementLogic";
import DriverOrderView from "./DriverOrderView";
import AddRiderRoutePanel, { type PanelDirection } from "./AddRiderRoutePanel";

// 셔틀 명단 — 사이트가 정규 셔틀 명단의 원장이다. 월 → 요일 → 수업시간별 학생(등원·하원 정류장).
// 학생 추가·빼기·반이동·정류장 수정은 /api/admin/shuttle/regular-roster 로 바로 저장한다.
// 차량 배정은 정규 배차 화면에서 따로 한다(명단이 바뀌면 배차 화면이 자동으로 변동을 감지).

type Entry = RosterStudentEntry<RegularShuttleStop>;
// coordSource: 좌표를 어디서 가져왔는지(학생 추가 추천의 학생 위치 우선순위에 쓴다). 저장 요청에는 보내지 않는다.
type StopDraft = { stopName: string; arriveTime: string; latitude: number | null; longitude: number | null; coordSource?: StudentPointSource | null };
type Dialog =
  | {
    kind: "add";
    query: string;
    results: RosterStudentSearchResult[] | null;
    student: RosterStudentSearchResult | null;
    manualName: string;
    /** 고른 수업(요일·수업시간) — 학생을 고르면 등록 수업으로 미리 채운다. */
    slots: RosterClassSlot[];
    manualWeekday: number; // 등록 수업에 없는 수업을 직접 추가할 때
    manualClassTime: string;
    /** 등록 수업·상세 위치·학원/차고지 좌표(서버 조회). */
    context: RosterStudentContext | null;
    contextLoading: boolean;
    contextError: boolean; // 불러오기 실패 — 「등록 수업 없음」과 구분해 안내한다
    /** 칸(요일·수업·방향)별 원장이 바꾼 넣을 자리·시각. 없으면 추천. */
    overrides: Record<string, PlacementOverride>;
    useBoard: boolean;
    board: StopDraft;
    useAlight: boolean;
    alightSame: boolean; // 하원 정류장 = 등원 정류장(도착시각만 따로)
    alight: StopDraft;
    scope: RosterScope;
  }
  | { kind: "move"; entry: Entry; weekday: number; classTime: string; scope: RosterScope }
  | { kind: "stop"; entry: Entry; direction: "BOARD" | "ALIGHT"; draft: StopDraft; applyToAll: boolean; scope: RosterScope }
  | { kind: "remove"; entry: Entry; weekday: number; scope: RosterScope };
type PickerTarget = "board" | "alight" | "stop";

const WD_ORDER = [1, 2, 3, 4, 5, 6, 0]; // 월→일
// 보기 전환(학생 목록 | 기사님 화면) — 고른 보기를 브라우저에 기억한다(목록 개편 공통 규칙)
type RosterView = "students" | "driver";
const ROSTER_VIEW_STORAGE_KEY = "admin-shuttle-roster-view";
const ROSTER_VIEW_VALUES: readonly RosterView[] = ["students", "driver"];
const ROSTER_VIEW_OPTIONS: ReadonlyArray<ListViewOption<RosterView>> = [
  { value: "students", label: "학생 목록", icon: "list" },
  { value: "driver", label: "기사님 화면(운행 순서)", icon: "directions_bus" },
];
const EMPTY_DRAFT: StopDraft = { stopName: "", arriveTime: "", latitude: null, longitude: null };
const INPUT = "w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-semibold dark:border-gray-600 dark:bg-gray-900 dark:text-white";
const LABEL = "flex flex-col gap-1 text-[11px] font-bold text-gray-500 dark:text-gray-400";

function tel(p: string | null): string | null { if (!p) return null; const d = p.replace(/[^0-9]/g, ""); return d.length >= 9 ? `tel:${d}` : null; }
function fmtImported(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso); if (Number.isNaN(d.getTime())) return "";
  const p = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return `${g("month")}/${g("day")} ${g("hour")}:${g("minute")}`;
}

/** 선택 월보다 가까운 과거 월(빈 달에서 「이전 달 명단 복사」 원본). */
function closestPreviousMonth(months: string[], serviceMonth: string): string {
  return [...months].filter((month) => month < serviceMonth).sort((a, b) => b.localeCompare(a))[0] ?? "";
}

function draftFromRow(row: RegularShuttleStop | null): StopDraft {
  if (!row) return { ...EMPTY_DRAFT };
  return { stopName: row.stopName, arriveTime: row.arriveTime ?? "", latitude: row.latitude ?? null, longitude: row.longitude ?? null };
}
function toStopBody(d: StopDraft) {
  return { stopName: d.stopName, arriveTime: d.arriveTime || null, latitude: d.latitude, longitude: d.longitude };
}
function entryIds(entry: Entry): string[] {
  return [entry.board?.id, entry.alight?.id].filter((id): id is string => Boolean(id));
}

type RegularLocationLinkState = {
  id: string;
  studentId: string;
  studentName: string;
  status: "ACTIVE" | "SUBMITTED" | "EXPIRED" | "REVOKED";
  expiresAt: string;
  lastSubmittedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

const LOCATION_LINK_STATUS: Record<RegularLocationLinkState["status"], string> = {
  ACTIVE: "입력 대기",
  SUBMITTED: "제출 완료",
  EXPIRED: "만료",
  REVOKED: "취소",
};

export default function RegularShuttleClient({ initialStops, initialMonth, months, currentMonth }: {
  initialStops: RegularShuttleStop[];
  initialMonth: string;
  months: string[];
  currentMonth: string;
}) {
  const [stops, setStops] = useState<RegularShuttleStop[]>(initialStops);
  const [serviceMonth, setServiceMonth] = useState(initialMonth);
  const [availableMonths, setAvailableMonths] = useState(months);
  const [locationLinkBusy, setLocationLinkBusy] = useState<string | null>(null);
  const [locationLink, setLocationLink] = useState<{ id: string; studentId: string; studentName: string; url: string; expiresAt: string } | null>(null);
  const [locationLinks, setLocationLinks] = useState<Record<string, RegularLocationLinkState>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showDispatchHint, setShowDispatchHint] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [dialogErr, setDialogErr] = useState<string | null>(null);
  const [picker, setPicker] = useState<PickerTarget | null>(null);
  // 보기 전환: 학생별 목록 / 기사님 화면(운행 순서). 기사님 화면 보기에서 고친 뒤 저장 안 했으면 전환 전에 묻는다.
  const [view, setView] = useRememberedListView<RosterView>(ROSTER_VIEW_STORAGE_KEY, ROSTER_VIEW_VALUES, "students");
  // 행 클릭 상세 패널: 수업시간 + 학생 키로 찾는다(같은 날 두 수업을 타는 학생도 구분). 명단을 다시 읽어도 최신 값으로 보인다.
  const [detail, setDetail] = useState<{ classTime: string; key: string } | null>(null);
  const [orderDirty, setOrderDirty] = useState(false);
  const onOrderDirty = useCallback((d: boolean) => setOrderDirty(d), []);
  const confirmLeaveOrder = () => !orderDirty || window.confirm("기사님 화면 보기에서 저장하지 않은 순서·시각 변경이 있습니다. 이동하면 사라집니다. 계속할까요?");
  // 그 요일 기사님 화면이 정규 배차 저장 노선을 쓰는지(방향별). null = 아직 모름/조회 실패.
  const [routeStatus, setRouteStatus] = useState<{ PICKUP: boolean; DROPOFF: boolean } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/admin/shuttle/regular-location-links", { cache: "no-store" })
      .then(async (response) => {
        const result = await response.json().catch(() => null);
        if (!response.ok) throw new Error(result?.error || "위치 링크 상태를 불러오지 못했습니다.");
        if (cancelled) return;
        const latest: Record<string, RegularLocationLinkState> = {};
        for (const link of (result.links ?? []) as RegularLocationLinkState[]) {
          if (!latest[link.studentId] || link.createdAt > latest[link.studentId].createdAt) latest[link.studentId] = link;
        }
        setLocationLinks(latest);
      })
      .catch((error) => { if (!cancelled) setErr(error instanceof Error ? error.message : "위치 링크 상태를 불러오지 못했습니다."); });
    return () => { cancelled = true; };
  }, []);

  // 월 선택지 = 저장된 달 + 이번 달 + 다음 달(새 달 명단을 만들 수 있게).
  const monthOptions = useMemo(
    () => [...new Set([...availableMonths, currentMonth, nextServiceMonth(currentMonth), serviceMonth])].sort((a, b) => b.localeCompare(a)),
    [availableMonths, currentMonth, serviceMonth],
  );
  const previousMonth = closestPreviousMonth(availableMonths, serviceMonth);
  // 편집 모달의 기본 적용 범위: 지난 달을 고칠 때는 「이 달만」(지난 기록 정정이 이번·다음 달까지 번지지 않게), 그 외엔 「이 달부터 계속」.
  const defaultScope: RosterScope = serviceMonth < currentMonth ? "THIS_MONTH" : "FROM_THIS_MONTH";

  // 요일 탭: 월~토는 항상, 일요일은 명단이 있을 때만. 탭마다 학생 수를 보여준다.
  const weekdays = useMemo(() => WD_ORDER
    .map((w) => ({ weekday: w, count: groupRosterDay(stops, w).reduce((n, g) => n + g.students.length, 0) }))
    .filter((w) => w.weekday !== 0 || w.count > 0), [stops]);
  const [active, setActive] = useState<number>(() => weekdays.find((w) => w.count > 0)?.weekday ?? 1);
  const groups = useMemo(() => groupRosterDay(stops, active), [stops, active]);
  // 상세 패널 대상 — 지금 요일 묶음에서 다시 찾는다(요일을 바꾸거나 학생이 빠지면 패널이 저절로 닫힌다)
  const detailEntry = detail ? groups.find((g) => g.classTime === detail.classTime)?.students.find((e) => e.key === detail.key) ?? null : null;
  // 이 달에 쓰인 수업시간(추가·반이동 입력 자동완성용).
  const classTimes = useMemo(() => [...new Set(stops.map((s) => s.classTime).filter((c): c is string => Boolean(c)))].sort(), [stops]);
  // 명단 점검(기사님 화면에서 빠지거나 어긋나 보일 행). 자동으로 고치지 않고 알리기만 한다.
  const issues = useMemo(() => checkRosterRows(stops), [stops]);
  const laterMonths = useMemo(() => availableMonths.filter((m) => m > serviceMonth).sort(), [availableMonths, serviceMonth]);

  // 요일·월이 바뀌면 그 요일의 정규 배차 저장 노선 사용 여부를 다시 확인한다(조회 전용).
  useEffect(() => {
    let cancelled = false;
    setRouteStatus(null);
    void fetch(`/api/admin/shuttle/regular-roster?routeStatus=1&month=${encodeURIComponent(serviceMonth)}&weekday=${active}`, { cache: "no-store" })
      .then(async (r) => { const j = await r.json().catch(() => null); if (!cancelled && r.ok && j?.status) setRouteStatus(j.status); })
      .catch(() => { /* 표시용 정보라 실패해도 조용히 넘어간다 */ });
    return () => { cancelled = true; };
  }, [serviceMonth, active]);

  async function loadMonth(month: string) {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/admin/shuttle/regular?month=${encodeURIComponent(month)}`, { cache: "no-store" });
      const j = await r.json().catch(() => null);
      if (!r.ok) throw new Error(j?.error || "명단을 불러오지 못했습니다.");
      setServiceMonth(month); setStops(j.stops ?? []); setAvailableMonths(j.months ?? []);
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : "명단을 불러오지 못했습니다."); }
    finally { setBusy(false); }
  }

  // 명단 편집 API 호출 공통 — 실패하면 서버의 한국어 메시지를 그대로 던진다.
  async function rosterCall(method: "POST" | "PATCH" | "DELETE", body: Record<string, unknown>) {
    const r = await fetch("/api/admin/shuttle/regular-roster", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => null);
    if (!r.ok) throw new Error(j?.error || "처리하지 못했습니다.");
    return j;
  }

  // 모달 안 저장: 성공하면 모달을 닫고 명단을 다시 읽는다. 실패하면 모달 안에 오류를 보여준다.
  // 적용 범위(scope)는 모달 상태에서 함께 보낸다. 결과 문구에 실제 반영된 달을 붙인다(예: "10월·11월에 반영").
  async function submitDialog(method: "POST" | "PATCH" | "DELETE", body: Record<string, unknown>, done: string) {
    if (busy) return;
    setBusy(true); setDialogErr(null);
    try {
      const j = await rosterCall(method, { ...body, serviceMonth, scope: dialog && "scope" in dialog ? dialog.scope : undefined });
      const applied: string[] = Array.isArray(j?.appliedMonths) ? j.appliedMonths : [];
      const skipped: string[] = Array.isArray(j?.skippedMonths) ? j.skippedMonths : [];
      // 학생 추가: 이후 달에서 고른 자리의 기준 정차를 못 찾아 그 수업 맨 뒤에 넣은 달
      const endPlaced: string[] = Array.isArray(j?.endPlacedMonths) ? j.endPlacedMonths : [];
      const monthNote = applied.length > 0
        ? ` · ${formatRosterMonths(applied)}에 반영${skipped.length > 0 ? ` (${formatRosterMonths(skipped)}은 해당 학생 행이 없거나 이미 달라 건너뜀)` : ""}${endPlaced.length > 0 ? ` (${formatRosterMonths(endPlaced)}은 기준 정차가 없어 맨 뒤에 넣음 — 그 달 기사님 화면에서 확인)` : ""}`
        : "";
      setDialog(null); setMsg(`${done}${monthNote}`); setErr(null); setShowDispatchHint(true);
    } catch (e: unknown) { setDialogErr(e instanceof Error ? e.message : "처리하지 못했습니다."); setBusy(false); return; }
    setBusy(false);
    await loadMonth(serviceMonth);
  }

  async function copyMonth(sourceMonth: string, targetMonth: string) {
    if (busy || !window.confirm(`${sourceMonth} 명단을 ${targetMonth} 명단으로 복사할까요?\n복사한 뒤 ${targetMonth}에서 바뀐 학생만 고치면 됩니다.`)) return;
    setBusy(true); setErr(null); setMsg(null);
    try {
      const j = await rosterCall("POST", { action: "copyMonth", sourceMonth, targetMonth });
      setMsg(`${targetMonth} 명단을 만들었습니다 · ${j.copied}개 정류장`); setShowDispatchHint(true);
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : "명단을 만들지 못했습니다."); setBusy(false); return; }
    setBusy(false);
    await loadMonth(targetMonth);
  }

  function openAdd() {
    setDialogErr(null);
    setDialog({
      kind: "add", query: "", results: null, student: null, manualName: "",
      slots: [], manualWeekday: active, manualClassTime: groups[0]?.classTime ?? "",
      context: null, contextLoading: false, contextError: false, overrides: {},
      useBoard: true, board: { ...EMPTY_DRAFT }, useAlight: true, alightSame: true, alight: { ...EMPTY_DRAFT },
      scope: defaultScope,
    });
    // 학생을 고르기 전에도 추천 거리 계산에 쓸 학원·차고지 좌표는 받아 둔다(이름만 입력하는 경우).
    void loadAddContext(null);
  }

  // 학생 추가 정보 불러오기(조회 전용) — 등록 수업·상세 위치·학원/차고지 좌표.
  // 학생을 골랐으면 등록 수업으로 수업 칸을 미리 채운다(원장이 체크를 풀 수 있다).
  async function loadAddContext(studentId: string | null) {
    setDialog((d) => (d?.kind === "add" ? { ...d, contextLoading: true, contextError: false } : d));
    try {
      const r = await fetch(`/api/admin/shuttle/regular-roster?context=1&studentId=${encodeURIComponent(studentId ?? "")}`, { cache: "no-store" });
      const j = await r.json().catch(() => null);
      if (!r.ok) throw new Error(j?.error || "학생 정보를 불러오지 못했습니다.");
      const context = j.context as RosterStudentContext;
      setDialog((d) => {
        if (d?.kind !== "add") return d;
        // 그사이 다른 학생을 골랐으면 늦게 온 응답은 버린다.
        if ((d.student?.id ?? null) !== (context.student?.id ?? null)) return d;
        // 등록 수업을 미리 고르되, 원장이 이미 직접 추가해 둔 수업 칸은 지우지 않고 합친다.
        const enrolled = studentId
          // 휴원(PAUSED) 수업은 미리 체크하지 않는다 — 원장이 복귀할 수업을 눌러 고른다.
          ? enrolledClassSlots(context.enrolled, stops).filter((o) => !o.paused).map((o) => ({ weekday: o.weekday, classTime: o.classTime }))
          : [];
        const slots = [...enrolled, ...d.slots.filter((s) => !enrolled.some((o) => o.weekday === s.weekday && classTimeKey(o.classTime) === classTimeKey(s.classTime)))];
        // 정류장 입력칸이 비어 있으면 이 학생이 이미 타는 셔틀 정류장으로 미리 채운다(같은 방향 우선, 원장이 바꿀 수 있다).
        let { board, alight, alightSame } = d;
        if (d.student && context.student) {
          const riding = studentRosterRows(stops, { id: d.student.id, name: d.student.name, parentPhone: context.student.parentPhone ?? d.student.parentPhone });
          const fill = (cur: StopDraft, dir: "BOARD" | "ALIGHT"): StopDraft => {
            if (cur.stopName.trim()) return cur;
            const def = defaultStopFromRiding(riding, dir);
            return def ? { ...cur, stopName: def.stopName, latitude: def.latitude, longitude: def.longitude, coordSource: "ROSTER_STOP" } : cur;
          };
          board = fill(board, "BOARD");
          alight = fill(alight, "ALIGHT");
          // 하원을 따로 채웠고 등원과 다른 정류장이면 「등원과 같은 정류장」을 푼다.
          if (alightSame && !d.alight.stopName.trim() && alight.stopName && alight.stopName !== board.stopName) alightSame = false;
        }
        return { ...d, context, contextLoading: false, contextError: false, slots, board, alight, alightSame };
      });
    } catch (e: unknown) {
      setDialog((d) => (d?.kind === "add" ? { ...d, contextLoading: false, contextError: true } : d));
      setDialogErr(e instanceof Error ? e.message : "학생 정보를 불러오지 못했습니다.");
    }
  }

  async function searchStudents() {
    if (dialog?.kind !== "add" || !dialog.query.trim()) return;
    setDialogErr(null);
    try {
      const r = await fetch(`/api/admin/shuttle/regular-roster?q=${encodeURIComponent(dialog.query.trim())}`, { cache: "no-store" });
      const j = await r.json().catch(() => null);
      if (!r.ok) throw new Error(j?.error || "학생을 찾지 못했습니다.");
      setDialog((d) => (d?.kind === "add" ? { ...d, results: j.students ?? [] } : d));
    } catch (e: unknown) { setDialogErr(e instanceof Error ? e.message : "학생을 찾지 못했습니다."); }
  }

  // 학생 선택 — 학생 상세에 저장된 등·하원 위치가 있으면 정류장 칸을 미리 채운다.
  function pickStudent(student: RosterStudentSearchResult) {
    setDialog((d) => {
      if (d?.kind !== "add") return d;
      const fromPlace = (p: RosterStudentSearchResult["pickup"], cur: StopDraft): StopDraft =>
        p ? { ...cur, stopName: p.name || p.address, latitude: p.latitude, longitude: p.longitude, coordSource: "STUDENT_PLACE" } : cur;
      const board = fromPlace(student.pickup, d.board);
      const alight = fromPlace(student.dropoff, d.alight);
      // 학생을 고르면 자리 선택은 비우고 정보를 새로 불러온다(직접 추가해 둔 수업 칸은 남겨 등록 수업과 합친다).
      return { ...d, student, results: null, board, alight, alightSame: student.dropoff ? false : d.alightSame, overrides: {}, context: null };
    });
    void loadAddContext(student.id);
  }

  // 학생 추가 모달의 방향별 정류장(하원 = 등원과 같으면 등원 정류장). 운행표 패널과 저장이 같은 값을 쓴다.
  // 학생 위치 = 지도 지정 > 명단 정류장(이름 일치·후보 칩) > 학생 상세 위치 > 이미 타는 셔틀 정류장(resolveStudentPoint).
  // 「등원과 같은 정류장」이면 하원도 등원과 같은 위치를 쓴다.
  function addDirections(d: Extract<Dialog, { kind: "add" }>): (PanelDirection & { draft: StopDraft; resolved: ResolvedStudentPoint })[] {
    const student = d.context?.student?.id && d.context.student.id === d.student?.id ? d.context.student : d.student;
    const places = { pickup: student?.pickup ?? null, dropoff: student?.dropoff ?? null };
    const riding = ridingRows(d);
    const resolve = (dir: "BOARD" | "ALIGHT", draft: StopDraft) => resolveStudentPoint({ direction: dir, draft, rosterStops: stops, places, riding });
    const boardRes = resolve("BOARD", d.board);
    const same = d.alightSame && d.useBoard;
    const alight = same ? d.board : d.alight;
    const alightRes = same ? boardRes : resolve("ALIGHT", alight);
    return [
      ...(d.useBoard ? [{ dir: "BOARD" as const, stopName: d.board.stopName, point: boardRes.point, pointLabel: boardRes.label, draft: d.board, resolved: boardRes }] : []),
      ...(d.useAlight ? [{ dir: "ALIGHT" as const, stopName: alight.stopName, point: alightRes.point, pointLabel: alightRes.label, draft: alight, resolved: alightRes }] : []),
    ];
  }

  function saveAdd() {
    if (dialog?.kind !== "add") return;
    const dirs = addDirections(dialog);
    const studentId = dialog.student?.id ?? null;
    // 칸(수업×방향)마다 운행표 패널과 같은 계산으로 넣을 자리·시각을 정해 보낸다.
    const placements = dialog.slots.flatMap((slot) => dirs.map((d) => {
      const res = resolveCellPlacement({
        stops, weekday: slot.weekday, classTime: slot.classTime, direction: d.dir, stopName: d.stopName, student: d.point,
        academy: dialog.context?.academy ?? null, depot: dialog.context?.depot ?? null, studentId,
        override: dialog.overrides[placementKey(slot.weekday, slot.classTime, d.dir)],
      });
      const base = { weekday: slot.weekday, classTime: slot.classTime, direction: d.dir, mode: res.request.mode, rowId: res.request.rowId };
      // 합류는 시각을 보내지 않는다 — 서버가 대상 정차 시각을 그대로 복사한다.
      return res.request.mode === "JOIN" ? base : { ...base, arriveTime: res.arriveTime };
    }));
    const stopBody = (dir: "BOARD" | "ALIGHT") => {
      const d = dirs.find((x) => x.dir === dir);
      // 시각은 칸마다 다르므로 정류장에는 넣지 않고 placements 로 보낸다.
      if (!d) return null;
      // 명단 정류장과 이름이 같은데 입력값에 좌표가 없으면 그 정류장 좌표로 채워 저장한다.
      const fill = d.resolved.fillCoords;
      return toStopBody({ ...d.draft, arriveTime: "", ...(fill ? { latitude: fill.lat, longitude: fill.lng } : {}) });
    };
    void submitDialog("POST", {
      action: "add",
      studentId,
      studentName: dialog.student ? dialog.student.name : dialog.manualName,
      slots: dialog.slots,
      placements,
      board: stopBody("BOARD"),
      alight: stopBody("ALIGHT"),
    }, `${dialog.student?.name ?? dialog.manualName} 학생을 명단에 추가했습니다(운행표에서 고른 자리). 「기사님 화면」 보기에서 확인해 주세요.`);
  }

  // 정류장 입력값 갱신(추가 폼의 등원·하원, 정류장 수정 폼 공용).
  function patchDraft(target: PickerTarget, patch: Partial<StopDraft>) {
    setDialog((d) => {
      if (!d) return d;
      if (target === "stop" && d.kind === "stop") return { ...d, draft: { ...d.draft, ...patch } };
      if (target === "board" && d.kind === "add") return { ...d, board: { ...d.board, ...patch } };
      if (target === "alight" && d.kind === "add") return { ...d, alight: { ...d.alight, ...patch } };
      return d;
    });
  }
  function draftOf(target: PickerTarget): StopDraft {
    if (dialog?.kind === "stop") return dialog.draft;
    if (dialog?.kind === "add") return target === "alight" ? dialog.alight : dialog.board;
    return EMPTY_DRAFT;
  }
  // 지도에서 고른 위치 → 좌표 저장. 정류장 이름이 비어 있으면 장소명(없으면 주소)으로 채운다.
  function onPicked(value: MapLocationData) {
    if (!picker) return;
    const cur = draftOf(picker);
    patchDraft(picker, { latitude: value.latitude, longitude: value.longitude, stopName: cur.stopName || value.placeName || value.address, coordSource: "MAP" });
    setPicker(null);
  }

  async function createParentLocationLink(studentId: string, studentName: string, reissue = false) {
    if (locationLinkBusy) return;
    if (reissue && !window.confirm(`${studentName} 학생의 기존 링크를 취소하고 새 링크를 발급할까요? 기존 링크는 즉시 사용할 수 없게 됩니다.`)) return;
    setLocationLinkBusy(studentId); setErr(null); setMsg(null);
    try {
      const response = await fetch("/api/admin/shuttle/regular-location-links", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ studentId }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.path) throw new Error(result?.error || "위치 입력 링크를 만들지 못했습니다.");
      const url = `${window.location.origin}${result.path}`;
      const nextLink: RegularLocationLinkState = { id: result.id, studentId, studentName: result.studentName ?? studentName, status: "ACTIVE", expiresAt: result.expiresAt, lastSubmittedAt: null, revokedAt: null, createdAt: new Date().toISOString() };
      setLocationLinks((current) => ({ ...current, [studentId]: nextLink }));
      setLocationLink({ id: result.id, studentId, studentName: result.studentName ?? studentName, url, expiresAt: result.expiresAt });
      try { await navigator.clipboard.writeText(url); setMsg(`${result.studentName ?? studentName} 위치 입력 링크를 복사했습니다.`); }
      catch { setMsg(`${result.studentName ?? studentName} 위치 입력 링크를 만들었습니다. 아래 링크를 직접 복사해 주세요.`); }
    } catch (error) {
      setErr(error instanceof Error ? error.message : "위치 입력 링크를 만들지 못했습니다.");
    } finally {
      setLocationLinkBusy(null);
    }
  }

  async function revokeParentLocationLink(link: RegularLocationLinkState) {
    if (locationLinkBusy || !window.confirm(`${link.studentName} 학생의 위치 입력 링크를 취소할까요?`)) return;
    setLocationLinkBusy(link.studentId); setErr(null); setMsg(null);
    try {
      const response = await fetch("/api/admin/shuttle/regular-location-links", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ linkId: link.id }) });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.error || "링크를 취소하지 못했습니다.");
      setLocationLinks((current) => ({ ...current, [link.studentId]: { ...link, status: "REVOKED", revokedAt: new Date().toISOString() } }));
      if (locationLink?.id === link.id) setLocationLink(null);
      setMsg(`${link.studentName} 위치 입력 링크를 취소했습니다.`);
    } catch (error) {
      setErr(error instanceof Error ? error.message : "링크를 취소하지 못했습니다.");
    } finally {
      setLocationLinkBusy(null);
    }
  }

  // 정규 셔틀 기사 고정 링크 복사 — 하나만 전달하면 매일 '오늘 요일' 운행이 자동으로 뜬다.
  async function copyRegularRunLink() {
    setErr(null); setMsg(null);
    try {
      const r = await fetch("/api/admin/shuttle/regular-run-link", { method: "POST" });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "링크 생성 실패");
      const url = `${window.location.origin}${j.path}`;
      try { await navigator.clipboard.writeText(url); setMsg("기사님 운행 링크를 복사했습니다(매일 열면 오늘 요일 운행)"); }
      catch { setMsg(`기사님 링크: ${url}`); }
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : "링크를 만들지 못했습니다."); }
  }

  // ── 학생 행 작업(⚡ 메뉴·상세 패널이 같은 목록을 쓴다) ──
  // 반이동·정류장 수정·빼기는 예전 카드의 버튼과 같은 모달을 같은 값으로 연다(저장 동작은 그대로).
  function openMove(entry: Entry, classTime: string) {
    setDialogErr(null); setDialog({ kind: "move", entry, weekday: active, classTime, scope: defaultScope });
  }
  function openStop(entry: Entry) {
    setDialogErr(null); const dir = entry.board ? "BOARD" : "ALIGHT"; setDialog({ kind: "stop", entry, direction: dir, draft: draftFromRow(entry.board ?? entry.alight), applyToAll: false, scope: defaultScope });
  }
  function openRemove(entry: Entry) {
    setDialogErr(null); setDialog({ kind: "remove", entry, weekday: active, scope: defaultScope });
  }
  function buildRosterActions(entry: Entry, classTime: string): AdminQuickAction[] {
    const tp = tel(entry.parentPhone);
    const link = entry.studentId ? locationLinks[entry.studentId] : undefined;
    const canReissue = link?.status === "ACTIVE" || link?.status === "SUBMITTED";
    const linkBusy = locationLinkBusy === entry.studentId;
    const actions: AdminQuickAction[] = [
      { key: "move", label: "반이동", icon: "swap_horiz", onSelect: () => openMove(entry, classTime) },
      { key: "stop", label: "정류장 수정", icon: "edit_location_alt", onSelect: () => openStop(entry) },
    ];
    // 학부모 전화 — 예전 「📞 학부모」 링크와 같은 tel: 주소로 건다
    if (tp) actions.push({ key: "call", label: "학부모 전화", icon: "call", onSelect: () => { window.location.href = tp; } });
    // 학부모 위치 입력 링크 — 학생 id 가 있을 때만(예전과 같은 조건). 이미 있으면 재발급·취소
    if (entry.studentId) {
      const studentId = entry.studentId;
      actions.push({ key: "location-link", label: canReissue ? "링크 재발급" : "위치 링크", icon: "share_location", disabled: linkBusy, onSelect: () => void createParentLocationLink(studentId, entry.studentName, canReissue) });
      if (canReissue && link) actions.push({ key: "location-revoke", label: "링크 취소", icon: "link_off", tone: "danger", disabled: linkBusy, onSelect: () => void revokeParentLocationLink(link) });
    }
    actions.push({ key: "remove", label: "빼기", icon: "person_remove", tone: "danger", onSelect: () => openRemove(entry) });
    return actions;
  }

  // 정류장 칸: 이름 + 좌표 없음 경고(배차 지도에 안 나오는 학생을 목록에서 바로 알아보게). 이용 안 하면 흐리게.
  // ⚠️ 컴포넌트(<StopCell />)로 쓰지 않고 함수로 호출한다 — 렌더마다 새 컴포넌트가 되지 않게.
  function stopCell(row: RegularShuttleStop | null) {
    if (!row) return <span className="text-[var(--color-academy-muted)]">이용 안 함</span>;
    const hasCoord = row.latitude != null && row.longitude != null;
    return (
      <span className="inline-flex items-center gap-1.5">
        <span className="font-bold text-[var(--color-academy-ink)]">{row.stopName}</span>
        {!hasCoord && <span className="rounded bg-[var(--color-academy-warning-soft)] px-1.5 py-0.5 text-xs font-black text-[var(--color-academy-warning)]">⚠ 좌표 없음</span>}
      </span>
    );
  }

  // 행 키보드(Enter·Space) = 상세 패널. 행 안의 ⚡ 버튼 등에서 누른 키는 가로채지 않는다.
  function handleRowKeyDown(event: React.KeyboardEvent<HTMLElement>, classTime: string, key: string) {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setDetail({ classTime, key });
    }
  }

  // withTime=false: 학생 추가 — 시각은 운행표 패널에서 칸(요일·수업)마다 정한다.
  function stopFields(target: PickerTarget, title?: string, withTime = true) {
    const d = draftOf(target);
    const hasCoord = d.latitude != null && d.longitude != null;
    return (
      <div className="space-y-2">
        <div className={withTime ? "grid grid-cols-[1fr_6rem] gap-2" : ""}>
          <label className={LABEL}>{title ?? "정류장 이름"}
            <input value={d.stopName} onChange={(e) => patchDraft(target, { stopName: e.target.value })} placeholder="예: 다산자이 정문" className={INPUT} />
          </label>
          {withTime && (
            <label className={LABEL}>도착시각
              <input value={d.arriveTime} onChange={(e) => patchDraft(target, { arriveTime: e.target.value })} placeholder="16:40" inputMode="numeric" className={INPUT} />
            </label>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => setPicker(target)} className="inline-flex min-h-9 items-center gap-1 rounded-lg border border-gray-200 px-3 text-[12.5px] font-black text-gray-700 dark:border-gray-600 dark:text-gray-200">
            <span className="material-symbols-outlined text-base">location_on</span>{hasCoord ? "지도에서 다시 지정" : "지도에서 위치 지정"}
          </button>
          {hasCoord
            ? <span className="text-[11.5px] font-bold text-green-700 dark:text-green-300">좌표 있음</span>
            : <span className="text-[11.5px] font-bold text-amber-600 dark:text-amber-300">⚠ 좌표 없음 — 배차 지도에 안 나옵니다</span>}
        </div>
      </div>
    );
  }

  // 학생 추가: 이 학생이 이 달 이미 타는 행 — studentId 일치 + 이름(공백 무시)+학부모 전화 끝4자리 일치(명단 화면과 같은 묶음 규칙).
  function ridingRows(d: Extract<Dialog, { kind: "add" }>): RegularShuttleStop[] {
    if (!d.student) return [];
    const parentPhone = (d.context?.student?.id === d.student.id ? d.context.student.parentPhone : null) ?? d.student.parentPhone;
    return studentRosterRows(stops, { id: d.student.id, name: d.student.name, parentPhone });
  }

  // 학생 추가: 정류장 후보 — 학생 상세 위치(등·하원) + 이 달 이미 타는 정류장. 누르면 이름·좌표를 채운다.
  function stopCandidates(target: "board" | "alight") {
    if (dialog?.kind !== "add") return null;
    const student = dialog.context?.student ?? dialog.student;
    const dir = target === "board" ? "BOARD" : "ALIGHT";
    const places = target === "board"
      ? ([["등원 위치", student?.pickup], ["하원 위치", student?.dropoff]] as const)
      : ([["하원 위치", student?.dropoff], ["등원 위치", student?.pickup]] as const);
    const out: { key: string; label: string; draft: Partial<StopDraft> }[] = [];
    for (const [label, p] of places) {
      if (p) out.push({ key: `place-${label}`, label: `학생 ${label} · ${p.name || p.address}`, draft: { stopName: p.name || p.address, latitude: p.latitude, longitude: p.longitude, coordSource: "STUDENT_PLACE" } });
    }
    {
      const seen = new Set<string>();
      for (const s of ridingRows(dialog)) {
        if (s.direction !== dir || seen.has(s.stopName)) continue;
        seen.add(s.stopName);
        out.push({ key: `row-${s.id}`, label: `지금 ${dir === "BOARD" ? "등원" : "하원"} 정류장 · ${s.stopName}`, draft: { stopName: s.stopName, latitude: s.latitude ?? null, longitude: s.longitude ?? null, coordSource: "ROSTER_STOP" } });
      }
    }
    if (out.length === 0) return null;
    return (
      <div className="mt-2 flex flex-wrap items-center gap-1">
        <span className="text-[11px] font-bold text-gray-400">후보</span>
        {out.map((c) => (
          <button key={c.key} type="button" onClick={() => patchDraft(target, c.draft)}
            className="rounded-lg border border-gray-200 px-2 py-1 text-[11.5px] font-bold text-gray-600 dark:border-gray-600 dark:text-gray-300">{c.label}</button>
        ))}
      </div>
    );
  }

  // 적용 범위 선택 — 명단은 달별이라 이 달을 고쳐도 이미 만들어진 다음 달엔 그대로 남는다. 기본은 「이 달부터 계속」.
  function scopeFields(scope: RosterScope) {
    const laterMonths = availableMonths.filter((m) => m > serviceMonth).sort();
    const options: { value: RosterScope; label: string; hint: string }[] = [
      { value: "FROM_THIS_MONTH", label: "이 달부터 계속 적용(기본)", hint: laterMonths.length > 0 ? `${formatRosterMonths([serviceMonth, ...laterMonths])} 명단에 함께 반영합니다.` : "이후 달 명단이 생기면 이 달 명단을 복사해 만듭니다." },
      { value: "THIS_MONTH", label: "이 달만", hint: `${formatRosterMonths([serviceMonth])} 명단만 고칩니다.` },
    ];
    return (
      <fieldset className="mt-3 rounded-xl border border-gray-200 p-3 dark:border-gray-700">
        <legend className="px-1 text-[11px] font-bold text-gray-500 dark:text-gray-400">적용 범위</legend>
        <div className="flex flex-col gap-1.5">
          {options.map((o) => (
            <label key={o.value} className="flex items-start gap-2 text-[12.5px] font-bold text-gray-700 dark:text-gray-200">
              <input type="radio" name="roster-scope" className="mt-0.5" checked={scope === o.value}
                onChange={() => setDialog((d) => (d ? { ...d, scope: o.value } : d))} />
              <span>{o.label}<span className="block text-[11px] font-semibold text-gray-400">{o.hint}</span></span>
            </label>
          ))}
        </div>
      </fieldset>
    );
  }

  function renderDialog() {
    if (!dialog) return null;
    const footer = (onSave: () => void, saveLabel: string, danger = false) => (
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={() => setDialog(null)} className="rounded-xl border border-gray-200 px-4 py-2 text-sm font-bold text-gray-600 dark:border-gray-700 dark:text-gray-200">취소</button>
        <button type="button" disabled={busy} onClick={onSave}
          className={`rounded-xl px-4 py-2 text-sm font-black text-white disabled:opacity-50 ${danger ? "bg-red-600" : "bg-brand-navy-900 dark:bg-brand-neon-lime dark:text-brand-navy-900"}`}>{busy ? "저장 중…" : saveLabel}</button>
      </div>
    );
    const errBox = dialogErr && <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs font-bold text-red-700 dark:bg-red-950/30 dark:text-red-200">⚠ {dialogErr}</p>;

    if (dialog.kind === "add") {
      const set = (patch: Partial<Extract<Dialog, { kind: "add" }>>) => setDialog((d) => (d?.kind === "add" ? { ...d, ...patch } : d));
      const studentId = dialog.student?.id ?? null;
      // 이 학생이 이 달 명단에서 이미 타는 행(학생 연결 행 + 이름·전화로 같은 학생인 미연결 행).
      const riding = ridingRows(dialog);
      // 등록 수업 → 수업 칩(명단에 같은 시각 글자가 있으면 그 글자). 늦게 온 다른 학생 응답은 쓰지 않는다.
      const enrolledOptions = studentId && dialog.context?.student?.id === studentId ? enrolledClassSlots(dialog.context.enrolled, stops) : [];
      const sameSlot = (a: RosterClassSlot, b: RosterClassSlot) => a.weekday === b.weekday && classTimeKey(a.classTime) === classTimeKey(b.classTime);
      const hasSlot = (o: RosterClassSlot) => dialog.slots.some((s) => sameSlot(s, o));
      // 직접 추가한 수업도 칩으로 보여 줘서 눌러 뺄 수 있게 한다.
      const extraSlots = dialog.slots.filter((s) => !enrolledOptions.some((o) => sameSlot(o, s)))
        .map((s) => ({ ...s, label: `${WEEKDAY_LABELS[s.weekday]} ${s.classTime} · 직접 추가`, paused: false, enrolledTime: s.classTime }));
      const hasActiveEnrolled = enrolledOptions.some((o) => !o.paused);
      const toggleSlot = (o: RosterClassSlot) => set({ slots: hasSlot(o) ? dialog.slots.filter((s) => !sameSlot(s, o)) : [...dialog.slots, { weekday: o.weekday, classTime: o.classTime }] });
      return (
        <div className="p-4">
          <h4 id="roster-dialog-title" className="text-base font-black text-gray-900 dark:text-white">학생 추가 · {serviceMonth}</h4>
          <div className="mt-3 space-y-4">
            {/* 학생 선택 */}
            {dialog.student ? (
              <div className="flex items-center justify-between rounded-xl bg-gray-50 px-3 py-2 dark:bg-gray-900">
                <p className="text-sm font-black text-gray-900 dark:text-white">{dialog.student.name}<span className="ml-2 text-xs font-bold text-gray-500">{dialog.student.grade ?? ""}</span></p>
                <button type="button" onClick={() => set({ student: null, slots: [], overrides: {} })} className="text-xs font-black text-gray-500">다시 선택</button>
              </div>
            ) : (
              <div>
                <div className="flex gap-2">
                  <input value={dialog.query} data-admin-modal-initial-focus onChange={(e) => set({ query: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void searchStudents(); } }}
                    placeholder="학생 이름 검색" className={INPUT} />
                  <button type="button" onClick={() => void searchStudents()} className="shrink-0 rounded-lg bg-brand-navy-900 px-3 text-sm font-black text-white dark:bg-brand-neon-lime dark:text-brand-navy-900">검색</button>
                </div>
                {dialog.results && (
                  <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto">
                    {dialog.results.length === 0 && <li className="px-1 text-xs text-gray-400">검색 결과가 없습니다. 아래에 이름만 입력해 추가할 수도 있습니다.</li>}
                    {dialog.results.map((s) => (
                      <li key={s.id}>
                        <button type="button" onClick={() => pickStudent(s)} className="flex w-full items-center justify-between rounded-lg border border-gray-200 px-3 py-2 text-left text-sm hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-900">
                          <span className="font-bold text-gray-900 dark:text-white">{s.name} <span className="text-xs text-gray-500">{s.grade ?? ""}</span></span>
                          <span className="text-[11px] text-gray-500">{s.parentPhone ? `학부모 …${s.parentPhone.replace(/\D/g, "").slice(-4)}` : ""}{s.pickup || s.dropoff ? " · 위치 저장됨" : ""}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <label className={`${LABEL} mt-2`}>학생 계정이 없으면 이름만 입력
                  <input value={dialog.manualName} onChange={(e) => set({ manualName: e.target.value })} placeholder="예: 홍길동" className={INPUT} />
                </label>
              </div>
            )}

            {/* 이 학생이 이 달 이미 타는 셔틀 — 같은 수업을 또 넣지 않도록, 정류장 후보로도 쓴다. */}
            {riding.length > 0 && (
              <div className="rounded-xl bg-gray-50 px-3 py-2 text-[12px] text-gray-600 dark:bg-gray-900 dark:text-gray-300">
                <p className="font-black">이 달 이미 타는 셔틀</p>
                <ul className="mt-0.5 space-y-0.5">
                  {riding.map((s, i) => <li key={s.id ?? i}>{WEEKDAY_LABELS[s.weekday]} {s.classTime} {s.direction === "BOARD" ? "등원" : "하원"} · 「{s.stopName}」 {s.arriveTime ?? ""}</li>)}
                </ul>
              </div>
            )}

            {/* 수업(요일·수업시간) — 등록 수업을 불러와 미리 고른다. 등록 수업에 없는 수업은 아래에서 직접 추가. */}
            <div>
              <p className="text-[11px] font-bold text-gray-500 dark:text-gray-400">수업(요일·수업시간)</p>
              {dialog.contextLoading && <p className="mt-1 text-[12px] text-gray-400">등록 수업을 불러오는 중…</p>}
              {dialog.student && !dialog.contextLoading && dialog.contextError && (
                <p className="mt-1 text-[12px] font-bold text-red-600">학생 정보를 불러오지 못했습니다(아래에서 수업을 직접 추가할 수 있습니다).</p>
              )}
              {dialog.student && !dialog.contextLoading && !dialog.contextError && enrolledOptions.length === 0 && (
                <p className="mt-1 text-[12px] font-bold text-amber-600">등록 수업이 없습니다. 아래에서 직접 추가해 주세요.</p>
              )}
              {dialog.student && !dialog.contextLoading && !dialog.contextError && enrolledOptions.length > 0 && !hasActiveEnrolled && (
                <p className="mt-1 text-[12px] font-bold text-amber-600">휴원 중인 수업이 있습니다 — 복귀할 수업을 눌러 고르세요.</p>
              )}
              <div className="mt-1 flex flex-wrap gap-1">
                {[...enrolledOptions, ...extraSlots].map((o) => {
                  const on = hasSlot(o);
                  return (
                    <button key={`${o.weekday}|${o.classTime}`} type="button" aria-pressed={on} onClick={() => toggleSlot(o)}
                      className={`min-h-9 rounded-lg px-2.5 text-left text-[12.5px] font-black ${on ? "bg-brand-navy-900 text-white dark:bg-brand-neon-lime dark:text-brand-navy-900" : "bg-gray-100 text-gray-500 dark:bg-gray-900"}`}>
                      {on ? "✓ " : ""}{o.label}
                      {o.paused && <span className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10.5px] font-black text-amber-800 dark:bg-amber-500/20 dark:text-amber-200">휴원</span>}
                    </button>
                  );
                })}
              </div>
              <div className="mt-2 grid grid-cols-[5.5rem_1fr_auto] gap-2">
                <select value={dialog.manualWeekday} onChange={(e) => set({ manualWeekday: Number(e.target.value) })} aria-label="직접 추가할 요일" className={INPUT}>
                  {WD_ORDER.map((w) => <option key={w} value={w}>{WEEKDAY_LABELS[w]}요일</option>)}
                </select>
                <input value={dialog.manualClassTime} onChange={(e) => set({ manualClassTime: e.target.value })} list="roster-class-times" placeholder="17:00~18:00" aria-label="직접 추가할 수업시간" className={INPUT} />
                <button type="button" disabled={!dialog.manualClassTime.trim()} onClick={() => {
                  const slot = { weekday: dialog.manualWeekday, classTime: dialog.manualClassTime.trim() };
                  if (!hasSlot(slot)) set({ slots: [...dialog.slots, slot] });
                }} className="rounded-lg border border-gray-200 px-3 text-[12.5px] font-black text-gray-700 disabled:opacity-40 dark:border-gray-600 dark:text-gray-200">직접 추가</button>
              </div>
            </div>

            {/* 등원 */}
            <fieldset className="rounded-xl border border-gray-200 p-3 dark:border-gray-700">
              <label className="flex items-center gap-2 text-sm font-black text-blue-700 dark:text-blue-300">
                <input type="checkbox" checked={dialog.useBoard} onChange={(e) => set({ useBoard: e.target.checked })} /> 등원 셔틀 이용
              </label>
              {dialog.useBoard && <div className="mt-2">{stopFields("board", "등원 정류장", false)}{stopCandidates("board")}</div>}
            </fieldset>

            {/* 하원 */}
            <fieldset className="rounded-xl border border-gray-200 p-3 dark:border-gray-700">
              <label className="flex items-center gap-2 text-sm font-black text-orange-600 dark:text-orange-300">
                <input type="checkbox" checked={dialog.useAlight} onChange={(e) => set({ useAlight: e.target.checked })} /> 하원 셔틀 이용
              </label>
              {dialog.useAlight && (
                <div className="mt-2 space-y-2">
                  {dialog.useBoard && (
                    <label className="flex items-center gap-2 text-[12.5px] font-bold text-gray-600 dark:text-gray-300">
                      <input type="checkbox" checked={dialog.alightSame} onChange={(e) => set({ alightSame: e.target.checked })} /> 등원과 같은 정류장
                    </label>
                  )}
                  {dialog.useBoard && dialog.alightSame ? (
                    <p className="text-[12px] text-gray-500 dark:text-gray-400">등원 정류장 「{dialog.board.stopName || "미입력"}」에서 내립니다. 하원 시각은 아래 운행표에서 정합니다.</p>
                  ) : <>{stopFields("alight", "하원 정류장", false)}{stopCandidates("alight")}</>}
                </div>
              )}
            </fieldset>

            {/* 현재 운행표 대조 · 넣을 자리(추천 기본) */}
            {dialog.slots.length === 0
              ? <p className="rounded-xl border border-dashed border-gray-300 p-3 text-center text-[12px] text-gray-400 dark:border-gray-600">수업을 고르면 그 수업의 현재 운행표와 넣을 자리 추천이 나옵니다.</p>
              : (
                <AddRiderRoutePanel
                  stops={stops}
                  slots={dialog.slots}
                  directions={addDirections(dialog)}
                  academy={dialog.context?.academy ?? null}
                  depot={dialog.context?.depot ?? null}
                  studentId={dialog.student?.id ?? null}
                  overrides={dialog.overrides}
                  onOverride={(key, next) => setDialog((d) => {
                    if (d?.kind !== "add") return d;
                    const overrides = { ...d.overrides };
                    if (next) overrides[key] = next; else delete overrides[key];
                    return { ...d, overrides };
                  })}
                />
              )}
          </div>
          {scopeFields(dialog.scope)}
          {errBox}
          {footer(saveAdd, "추가")}
        </div>
      );
    }

    if (dialog.kind === "move") {
      return (
        <div className="p-4">
          <h4 id="roster-dialog-title" className="text-base font-black text-gray-900 dark:text-white">반이동 · {dialog.entry.studentName}</h4>
          <p className="mt-1 text-xs text-gray-500">{WEEKDAY_LABELS[active]}요일 {dialog.entry.board?.classTime ?? dialog.entry.alight?.classTime ?? ""} 등·하원을 옮깁니다. 정류장은 그대로입니다.</p>
          <div className="mt-3 grid grid-cols-[6rem_1fr] gap-2">
            <label className={LABEL}>요일
              <select value={dialog.weekday} onChange={(e) => setDialog({ ...dialog, weekday: Number(e.target.value) })} className={INPUT}>
                {WD_ORDER.map((w) => <option key={w} value={w}>{WEEKDAY_LABELS[w]}요일</option>)}
              </select>
            </label>
            <label className={LABEL}>수업시간
              <input value={dialog.classTime} onChange={(e) => setDialog({ ...dialog, classTime: e.target.value })} list="roster-class-times" className={INPUT} />
            </label>
          </div>
          {scopeFields(dialog.scope)}
          {errBox}
          {footer(() => void submitDialog("PATCH", { action: "move", ids: entryIds(dialog.entry), weekday: dialog.weekday, classTime: dialog.classTime }, `${dialog.entry.studentName} 학생을 ${WEEKDAY_LABELS[dialog.weekday]}요일 ${dialog.classTime}으로 옮겼습니다.`), "옮기기")}
        </div>
      );
    }

    if (dialog.kind === "stop") {
      const row = dialog.direction === "BOARD" ? dialog.entry.board : dialog.entry.alight;
      return (
        <div className="p-4">
          <h4 id="roster-dialog-title" className="text-base font-black text-gray-900 dark:text-white">정류장 수정 · {dialog.entry.studentName}</h4>
          {dialog.entry.board && dialog.entry.alight && (
            <div className="mt-3 flex gap-1 rounded-xl bg-gray-100 p-1 dark:bg-gray-900">
              {(["BOARD", "ALIGHT"] as const).map((dir) => (
                <button key={dir} type="button" onClick={() => setDialog({ ...dialog, direction: dir, draft: draftFromRow(dir === "BOARD" ? dialog.entry.board : dialog.entry.alight) })}
                  className={`min-h-9 flex-1 rounded-lg text-sm font-black ${dialog.direction === dir ? "bg-white text-brand-navy-900 shadow dark:bg-gray-700 dark:text-white" : "text-gray-500"}`}>{dir === "BOARD" ? "등원" : "하원"}</button>
              ))}
            </div>
          )}
          <div className="mt-3">{stopFields("stop")}</div>
          <label className="mt-3 flex items-start gap-2 text-[12.5px] font-bold text-gray-600 dark:text-gray-300">
            <input type="checkbox" className="mt-0.5" checked={dialog.applyToAll} onChange={(e) => setDialog({ ...dialog, applyToAll: e.target.checked })} />
            <span>이 달 「{row?.stopName}」 정류장 전체에 이름·좌표 함께 적용<span className="block text-[11px] font-semibold text-gray-400">도착시각은 이 학생 것만 바뀝니다.</span></span>
          </label>
          {scopeFields(dialog.scope)}
          {errBox}
          {footer(() => row?.id && void submitDialog("PATCH", { action: "editStop", id: row.id, stop: toStopBody(dialog.draft), applyToAll: dialog.applyToAll }, "정류장을 수정했습니다."), "저장")}
        </div>
      );
    }

    // 빼기 — 이 요일만 / 이 달 전체 요일
    const allIds = rosterRowIdsForStudent(stops, dialog.entry.key);
    const label = dialog.entry.studentName;
    return (
      <div className="p-4">
        <h4 id="roster-dialog-title" className="text-base font-black text-gray-900 dark:text-white">{label} 학생을 명단에서 뺄까요?</h4>
        <p className="mt-1 text-xs text-gray-500">퇴원·셔틀 중단일 때 씁니다. 빼면 이 달 배차 화면에서도 빠진 학생으로 표시됩니다.</p>
        {scopeFields(dialog.scope)}
        <div className="mt-4 flex flex-col gap-2">
          <button type="button" disabled={busy} onClick={() => void submitDialog("DELETE", { ids: entryIds(dialog.entry) }, `${label} 학생을 ${WEEKDAY_LABELS[dialog.weekday]}요일 명단에서 뺐습니다.`)}
            className="min-h-11 rounded-xl border border-red-200 px-4 text-sm font-black text-red-700 disabled:opacity-50 dark:border-red-800 dark:text-red-200">{WEEKDAY_LABELS[dialog.weekday]}요일만 빼기</button>
          <button type="button" disabled={busy} onClick={() => void submitDialog("DELETE", { ids: allIds }, `${label} 학생을 ${serviceMonth} 명단에서 모두 뺐습니다.`)}
            className="min-h-11 rounded-xl bg-red-600 px-4 text-sm font-black text-white disabled:opacity-50">{serviceMonth} 전체 요일 빼기 ({allIds.length}개 정류장)</button>
          <button type="button" onClick={() => setDialog(null)} className="min-h-11 rounded-xl border border-gray-200 px-4 text-sm font-bold text-gray-600 dark:border-gray-700 dark:text-gray-200">취소</button>
        </div>
        {errBox}
      </div>
    );
  }

  const pickerDraft = picker ? draftOf(picker) : null;

  return (
    <div className="mx-auto max-w-6xl px-4 py-4">
      <div className="rounded-2xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3 className="text-base font-black text-gray-900 dark:text-white">셔틀 명단</h3>
            <p className="mt-0.5 text-[11.5px] text-gray-400">이번 달·다음 달 명단은 직전 달을 복사해 자동으로 만들어집니다. 다음 달 변경은 월을 바꿔 미리 고쳐 두세요.</p>
          </div>
          <label className="flex flex-col gap-1 text-[11px] font-bold text-gray-500">월
            <select value={serviceMonth} disabled={busy} onChange={(e) => { if (confirmLeaveOrder()) void loadMonth(e.target.value); }} className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-bold dark:border-gray-600 dark:bg-gray-900">
              {monthOptions.map((month) => <option key={month} value={month}>{month}{month === currentMonth ? " (이번 달)" : ""}</option>)}
            </select>
          </label>
        </div>

        {/* 주요 동작 */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" onClick={openAdd} className="inline-flex min-h-10 items-center gap-1 rounded-xl bg-brand-navy-900 px-4 text-sm font-black text-white dark:bg-brand-neon-lime dark:text-brand-navy-900">
            <span className="material-symbols-outlined text-lg">person_add</span>학생 추가
          </button>
          <button type="button" onClick={copyRegularRunLink} className="inline-flex min-h-10 items-center gap-1 rounded-xl border border-gray-200 px-4 text-sm font-black text-gray-700 dark:border-gray-600 dark:text-gray-200">
            <span className="material-symbols-outlined text-lg">directions_bus</span>기사님 운행 링크 복사
          </button>
        </div>

        {err && <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs font-bold text-red-600">⚠ {err}</p>}
        {msg && <p className="mt-2 rounded-lg bg-green-50 px-3 py-2 text-xs font-bold text-green-700 dark:bg-green-900/30 dark:text-green-200">✓ {msg}</p>}
        {/* 저장 노선이 있는 요일만 정규 배차에서 다시 배정해야 한다. 없으면 기사님 화면이 이 명단 순서를 바로 쓴다. */}
        {showDispatchHint && (routeStatus?.PICKUP || routeStatus?.DROPOFF) && (
          <p className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs font-bold text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
            정규 배차 화면에서 새 학생을 차량에 배정하고 저장해야 기사님 화면에 반영됩니다.
            <Link href="/admin/shuttle/regular-dispatch" className="underline">정규 배차로 가기</Link>
          </p>
        )}
        {showDispatchHint && routeStatus && !routeStatus.PICKUP && !routeStatus.DROPOFF && (
          <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs font-bold text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
            기사님 화면은 이 명단 순서로 운행합니다. 「기사님 화면」 보기에서 순서·시각을 맞춰 주세요.
          </p>
        )}
        {locationLink && <div className="mt-2 rounded-xl border border-blue-200 bg-blue-50 p-3 text-xs dark:border-blue-800 dark:bg-blue-950/30">
          <p className="font-black text-blue-900 dark:text-blue-100">{locationLink.studentName} 학부모 위치 입력 링크</p>
          <div className="mt-2 flex items-center gap-2"><input readOnly value={locationLink.url} aria-label="학부모 위치 입력 링크" className="min-w-0 flex-1 rounded-lg border border-blue-200 bg-white px-2 py-2 text-gray-700 dark:border-blue-700 dark:bg-gray-900 dark:text-gray-100" /><button type="button" onClick={() => void navigator.clipboard.writeText(locationLink.url)} className="min-h-9 rounded-lg bg-blue-700 px-3 font-black text-white">복사</button></div>
          <p className="mt-1 text-blue-700 dark:text-blue-200">실제 문자는 발송되지 않습니다. 내용을 확인한 뒤 직접 전달해 주세요. · 만료 {fmtImported(locationLink.expiresAt)}</p>
          {locationLinks[locationLink.studentId] && <button type="button" onClick={() => void revokeParentLocationLink(locationLinks[locationLink.studentId])} className="mt-2 rounded-lg border border-red-200 px-3 py-1.5 font-black text-red-700 dark:border-red-800 dark:text-red-200">이 링크 취소</button>}
        </div>}

        {stops.length === 0 ? (
          <div className="mt-4 rounded-xl border border-dashed border-gray-300 p-8 text-center text-sm text-gray-400 dark:border-gray-600">
            <p>{serviceMonth} 명단이 아직 없습니다.</p>
            {previousMonth
              ? <button type="button" disabled={busy} onClick={() => void copyMonth(previousMonth, serviceMonth)} className="mt-3 rounded-xl bg-brand-navy-900 px-4 py-2 text-sm font-black text-white disabled:opacity-50 dark:bg-brand-neon-lime dark:text-brand-navy-900">{previousMonth} 명단 복사해 오기</button>
              : <p className="mt-1">위의 「학생 추가」로 명단을 만들어 주세요.</p>}
          </div>
        ) : (
          <>
            {/* 요일 탭 */}
            <div className="mt-3 flex flex-wrap items-center gap-1 rounded-xl bg-gray-100 p-1 dark:bg-gray-900">
              {weekdays.map((w) => (
                <button key={w.weekday} type="button" onClick={() => { if (w.weekday !== active && confirmLeaveOrder()) { setActive(w.weekday); setDetail(null); } }}
                  aria-pressed={active === w.weekday}
                  className={`min-h-11 rounded-lg px-3 text-sm font-black ${active === w.weekday ? "bg-white text-brand-navy-900 shadow dark:bg-gray-700 dark:text-white" : "text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"}`}>
                  {WEEKDAY_LABELS[w.weekday]}<span className="ml-1 text-xs font-bold tabular-nums text-gray-400">{w.count}</span>
                </button>
              ))}
            </div>

            {/* 보기 전환 — 학생 목록 / 기사님 화면(운행 순서). 고른 보기는 브라우저에 기억한다. */}
            <div className="mt-2">
              <ListViewToggle
                value={view}
                options={ROSTER_VIEW_OPTIONS}
                ariaLabel="명단 보기"
                onChange={(v) => {
                  if (v === view || (v === "students" && !confirmLeaveOrder())) return;
                  setView(v);
                  setDetail(null); // 돌아왔을 때 닫았던 상세 패널이 다시 뜨지 않게
                  // 기사님 화면 보기가 닫히면(언마운트) 고친 내용도 사라지므로 「저장 안 됨」 표시를 내린다.
                  if (v === "students") setOrderDirty(false);
                }}
              />
            </div>

            {/* 정규 배차 저장 노선이 있는 방향은 기사님 화면이 그 노선을 쓴다 → 여기 순서는 쓰이지 않는다(조회만). */}
            {routeStatus && (routeStatus.PICKUP || routeStatus.DROPOFF) && (
              <p className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-violet-200 bg-violet-50 px-3 py-2 text-xs font-bold text-violet-800 dark:border-violet-800 dark:bg-violet-950/30 dark:text-violet-200">
                이 요일 {[routeStatus.PICKUP && "등원", routeStatus.DROPOFF && "하원"].filter(Boolean).join("·")}은 정규 배차 저장 노선으로 운행 중 — 여기 순서는 기사님 화면에 쓰이지 않습니다.
                <Link href="/admin/shuttle/regular-dispatch" className="underline">정규 배차 보기</Link>
              </p>
            )}

            {/* 명단 점검 — 기사님 화면에서 빠지거나 어긋나 보일 행(이 달 전체). 자동으로 고치지 않는다. */}
            {issues.length > 0 && (
              <details className="mt-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-100">
                <summary className="cursor-pointer font-black">⚠ 명단 점검 {issues.length}건 — 기사님 화면에서 빠지거나 어긋나 보일 수 있습니다</summary>
                <ul className="mt-2 space-y-1">
                  {issues.map((issue, i) => <li key={`${issue.kind}-${i}`} className={issue.weekday === active ? "font-bold" : ""}>· {issue.message}</li>)}
                </ul>
                <p className="mt-2 font-bold">자동으로 고치지 않았습니다. 학생 목록 보기에서 학생 행의 ⚡(반이동·정류장 수정·빼기)로 고쳐 주세요.</p>
              </details>
            )}

            {view === "driver" && (
              <DriverOrderView
                stops={stops}
                weekday={active}
                serviceMonth={serviceMonth}
                laterMonths={laterMonths}
                defaultScope={defaultScope}
                savedRoute={routeStatus}
                onDirtyChange={onOrderDirty}
                onSaved={async (message) => { setMsg(message); setErr(null); await loadMonth(serviceMonth); }}
              />
            )}

            {view === "students" && groups.length === 0 && <div className="mt-3 rounded-xl border border-dashed border-gray-300 p-6 text-center text-sm text-gray-400 dark:border-gray-600">{WEEKDAY_LABELS[active]}요일 셔틀 이용 학생이 없습니다.</div>}

            {/* 학생 목록 — 수업시간 묶음(머리줄) 아래 학생 한 줄 행. 긴 값(메모·위치 링크 시각)은 행 클릭 상세 패널에서. */}
            {view === "students" && groups.length > 0 && (
              <div className="mt-3 overflow-hidden rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)]">
                <div className="overflow-x-auto">
                  {/* admin-list-table: 글자 왼쪽·시각 오른쪽(tabular)·한 줄(말줄임 없음, 좁으면 가로 스크롤) */}
                  <table className="admin-list-table w-full border-collapse text-sm">
                    <thead className="bg-[var(--color-academy-soft)] text-xs font-black text-[var(--color-academy-muted)]">
                      <tr>
                        <th className="px-2 py-2">이름</th>
                        <th className="px-2 py-2">등원 정류장</th>
                        <th className="admin-cell-num px-2 py-2">등원 시각</th>
                        <th className="px-2 py-2">하원 정류장</th>
                        <th className="admin-cell-num px-2 py-2">하원 시각</th>
                        <th className="hidden px-2 py-2 md:table-cell">위치 링크</th>
                        <th className="admin-cell-center px-2 py-2">관리</th>
                      </tr>
                    </thead>
                    {groups.map((g) => (
                      <tbody key={g.classTime || "none"} className="divide-y divide-[var(--color-academy-line)]">
                        <tr>
                          <th colSpan={7} scope="rowgroup" className="bg-[var(--color-academy-soft)] px-2 py-1.5 text-xs font-black text-[var(--color-academy-ink)]">
                            {g.classTime || "수업시간 미지정"} · <span className="tabular-nums">{g.students.length}</span>명
                          </th>
                        </tr>
                        {g.students.map((entry) => {
                          const link = entry.studentId ? locationLinks[entry.studentId] : undefined;
                          const note = entry.board?.note || entry.alight?.note;
                          return (
                            <tr
                              key={entry.key}
                              tabIndex={0}
                              aria-label={`${entry.studentName} 상세 보기`}
                              onClick={() => setDetail({ classTime: g.classTime, key: entry.key })}
                              onKeyDown={(event) => handleRowKeyDown(event, g.classTime, entry.key)}
                              className="cursor-pointer transition-colors hover:bg-[var(--color-academy-soft)] focus:bg-[var(--color-academy-primary-soft)] focus:outline-none"
                            >
                              <td className="px-2 py-1.5">
                                <span className="font-black text-[var(--color-academy-ink)]">{entry.studentName}</span>
                                {/* 메모가 있으면 표시만 — 내용은 상세 패널에서 전부 */}
                                {note && <span className="material-symbols-outlined ml-1 align-middle text-base text-[var(--color-academy-muted)]" aria-label="메모 있음" title="메모 있음">sticky_note_2</span>}
                              </td>
                              <td className="px-2 py-1.5">{stopCell(entry.board)}</td>
                              <td className="admin-cell-num px-2 py-1.5 text-[var(--color-academy-ink)]">{entry.board ? entry.board.arriveTime || "-" : ""}</td>
                              <td className="px-2 py-1.5">{stopCell(entry.alight)}</td>
                              <td className="admin-cell-num px-2 py-1.5 text-[var(--color-academy-ink)]">{entry.alight ? entry.alight.arriveTime || "-" : ""}</td>
                              <td className="hidden px-2 py-1.5 text-xs font-bold text-[var(--color-academy-muted)] md:table-cell">{link ? LOCATION_LINK_STATUS[link.status] : "-"}</td>
                              {/* 관리: ⚡ 메뉴(반이동·정류장 수정·학부모 전화·위치 링크·빼기). 눌러도 행 클릭(패널)이 같이 일어나지 않게 전파 차단 */}
                              <td className="admin-cell-center px-2 py-1.5" onClick={(event) => event.stopPropagation()}>
                                <AdminQuickActionMenu label={`${entry.studentName} 빠른 작업`} actions={buildRosterActions(entry, g.classTime)} />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    ))}
                  </table>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <datalist id="roster-class-times">{classTimes.map((c) => <option key={c} value={c} />)}</datalist>

      {/* 행 클릭 상세 패널 — 데스크톱 오른쪽 패널 / 모바일 하단 시트. 이미 불러온 명단 값만 보여 준다(새 조회 없음).
          작업 버튼은 행 ⚡ 와 같은 목록이고, 누르면 패널을 닫고 예전과 같은 모달을 연다(모달 두 겹 방지). */}
      {view === "students" && detailEntry && detail && (() => {
        const d = detailEntry;
        const link = d.studentId ? locationLinks[d.studentId] : undefined;
        const tp = tel(d.parentPhone);
        const stopDetail = (row: RegularShuttleStop | null) => row
          ? <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">{stopCell(row)}<span className="tabular-nums">{row.arriveTime || "시각 미정"}</span></span>
          : <span className="text-[var(--color-academy-muted)]">이용 안 함</span>;
        const notes = [...new Set([d.board?.note, d.alight?.note].filter((n): n is string => Boolean(n)))];
        const rows: { label: string; value: React.ReactNode }[] = [
          { label: "수업", value: <span className="tabular-nums">{WEEKDAY_LABELS[active]}요일 {detail.classTime || "수업시간 미지정"}</span> },
          { label: "등원", value: stopDetail(d.board) },
          { label: "하원", value: stopDetail(d.alight) },
          { label: "학부모", value: tp ? <a href={tp} className="font-bold tabular-nums text-[var(--color-academy-primary)] underline">{d.parentPhone}</a> : "-" },
          ...(d.studentPhone ? [{ label: "학생", value: <span className="tabular-nums">{d.studentPhone}</span> }] : []),
          { label: "위치 링크", value: link ? `${LOCATION_LINK_STATUS[link.status]}${link.lastSubmittedAt ? ` · 제출 ${fmtImported(link.lastSubmittedAt)}` : ""}${link.status === "ACTIVE" ? ` · 만료 ${fmtImported(link.expiresAt)}` : ""}` : d.studentId ? "발급 안 함" : "학생 연결 없음(링크 불가)" },
          ...(notes.length > 0 ? [{ label: "메모", value: notes.join(" / ") }] : []),
        ];
        return (
          <ListDetailPanel onClose={() => setDetail(null)} titleId="roster-detail-panel-title" panelClassName="p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
            <div className="mb-4 flex items-center gap-2">
              <h3 id="roster-detail-panel-title" className="min-w-0 break-keep text-lg font-black text-[var(--color-academy-ink)]">{d.studentName}</h3>
              <button type="button" onClick={() => setDetail(null)} aria-label="닫기"
                className="ml-auto inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)]">
                <span className="material-symbols-outlined" aria-hidden="true">close</span>
              </button>
            </div>
            <dl className="grid grid-cols-[5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
              {rows.map((row) => (
                <div key={row.label} className="contents">
                  <dt className="font-bold text-[var(--color-academy-muted)]">{row.label}</dt>
                  <dd className="min-w-0 break-keep break-words text-[var(--color-academy-ink)]">{row.value}</dd>
                </div>
              ))}
            </dl>
            {/* 공용 패널 버튼 줄 — ⚡ 와 같은 목록·같은 함수, 위험 작업은 오른쪽 끝으로 떨어진다 */}
            <AdminPanelActions actions={buildRosterActions(d, detail.classTime)} onBeforeSelect={() => setDetail(null)} />
          </ListDetailPanel>
        );
      })()}

      {/* 지도 선택 중에는 입력 모달을 잠시 내린다(두 모달의 Esc·Tab 처리가 겹치지 않게). 입력값은 dialog 상태에 남아 있다. */}
      {dialog && !picker && (
        <AdminModal titleId="roster-dialog-title" onClose={() => setDialog(null)} panelClassName="max-w-lg">
          {renderDialog()}
        </AdminModal>
      )}
      {picker && pickerDraft && (
        <LocationPickerModal
          title={picker === "alight" ? "하원 정류장 위치" : picker === "board" ? "등원 정류장 위치" : "정류장 위치"}
          initialValue={pickerDraft.latitude != null && pickerDraft.longitude != null
            ? { address: pickerDraft.stopName, placeName: pickerDraft.stopName, latitude: pickerDraft.latitude, longitude: pickerDraft.longitude, source: "MAP_PIN" }
            : undefined}
          onConfirm={onPicked}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  );
}
