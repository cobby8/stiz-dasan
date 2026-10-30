"use client";

import { publicErrorText } from "@/components/ui/public-error-text";
import { useEffect, useRef, useState } from "react";
import { RouteMapCanvas } from "@/components/seasonal/DispatchRouteMap";
import type { DispatchSuggestion, DispatchChange } from "@/lib/seasonal/shuttle-optimize";
import StudentDetailModal from "@/components/seasonal/StudentDetailModal";
import { confirmedEtaMin, etaMinToLabel, reapplyManualEtaVehicles } from "@/lib/seasonal/shuttleStopEta";
// 정차 병합의 단일 기준(같은 장소 ≤30m). 서버(자동 제안·증분 배차)와 같은 판정을 쓴다.
import { findSamePlaceIndex } from "@/lib/seasonal/stopMerge";
// 정규 배차 손편집(차량 간 정차·학생 이동, 학생 빼기)의 순수 계산. 화면은 결과만 반영한다.
import { moveStopToVehicle, moveStudentToVehicle, removeStudentFromRoute, overCapacityVehicles, runTimeChange, type EditResult } from "@/lib/regular/regularRouteEdit";

// 한 방향(등원 또는 하원)의 노선 섹션 — 목록 + 지도 + 순서변경/재계산/무료탑승 드래그/출발조정/저장을 자립적으로 담는다.
// 날짜·기준위치가 바뀌면(refreshKey) 그 방향을 다시 계산한다.

function sameSavedRoute(route: DispatchSuggestion, saved: { vehicles?: unknown[]; classStart?: string | null; classEnd?: string | null }): boolean {
  const clean = (value: unknown): unknown => Array.isArray(value) ? value.map(clean) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== "isAbsent").sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, clean(item)])) : value;
  return JSON.stringify(clean(route.vehicles)) === JSON.stringify(clean(saved.vehicles)) && route.classStart === saved.classStart && route.classEnd === saved.classEnd;
}

function tel(p: string | null): string | null { if (!p) return null; const d = p.replace(/[^0-9]/g, ""); return d.length >= 9 ? `tel:${d}` : null; }
function parseHHMM(s: string | null): number | null { if (!s || !/^\d{1,2}:\d{2}$/.test(s)) return null; const [h, m] = s.split(":").map(Number); return h * 60 + m; }
function fmtHHMM(mins: number): string { const v = ((Math.round(mins) % 1440) + 1440) % 1440; return `${String(Math.floor(v / 60)).padStart(2, "0")}:${String(v % 60).padStart(2, "0")}`; }
function shiftHHMM(s: string | null, delta: number): string | null { const m = parseHHMM(s); return m == null ? s : fmtHHMM(m + delta); }
function shiftLabel(label: string | undefined, delta: number): string | undefined {
  if (!label) return label; const mt = label.match(/^(\d{1,2}:\d{2})(.*)$/); if (!mt) return label; return `${shiftHHMM(mt[1], delta)}${mt[2]}`;
}
function fmtSaved(iso: string): string {
  const d = new Date(iso); if (Number.isNaN(d.getTime())) return "";
  const p = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return `${g("month")}/${g("day")} ${g("hour")}:${g("minute")}`;
}

const ROAD_FACTOR = 1.3, SPEED_KM_PER_MIN = 0.4;
const MIN_PER_KM = ROAD_FACTOR / SPEED_KM_PER_MIN;
const STOP_DWELL_MIN = 1.5, PICKUP_BUFFER_MIN = 10, DROPOFF_BUFFER_MIN = 5;
type Pt = { lat: number; lng: number };
function haversineKm(a: Pt, b: Pt): number {
  const R = 6371, toR = (d: number) => (d * Math.PI) / 180;
  const dLat = toR(b.lat - a.lat), dLng = toR(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function segMin(a: Pt, b: Pt): number { return haversineKm(a, b) * MIN_PER_KM + STOP_DWELL_MIN; }

type Run = DispatchSuggestion["vehicles"][number];
function recomputeRunTimes(cur: DispatchSuggestion, run: Run, pinnedDepart?: string | null): Run {
  const isPickup = cur.direction === "PICKUP";
  const startPt: Pt = isPickup ? (cur.depot ?? cur.academy) : cur.academy;
  const endPt: Pt = isPickup ? cur.academy : (cur.depot ?? cur.academy);
  const order = run.stops;
  const path: Pt[] = [startPt, ...order, endPt];
  const segs: number[] = [];
  for (let i = 1; i < path.length; i++) segs.push(segMin(path[i - 1], path[i]));
  const sum = segs.reduce((a, b) => a + b, 0) || 1;
  const scale = run.tmapMinutes != null && run.tmapMinutes > 0 ? run.tmapMinutes / sum : 1;
  const seg = segs.map((s) => s * scale);
  // 정규 셔틀은 같은 요일의 여러 수업시간을 한 저장 payload에 담는다.
  // 개별 실행의 앵커를 우선해야 순서 변경·경로 재계산 때 전체 일과의 최저/최고 시각으로 되돌아가지 않는다.
  const csMin = parseHHMM(run.classStart ?? cur.classStart), ceMin = parseHHMM(run.classEnd ?? cur.classEnd);
  const times = new Array<number>(path.length).fill(0);
  const pinMin = pinnedDepart ? parseHHMM(pinnedDepart) : null;
  if (pinMin != null) {
    times[0] = pinMin;
    for (let i = 1; i < path.length; i++) times[i] = times[i - 1] + seg[i - 1];
  } else if (isPickup) {
    times[path.length - 1] = (csMin ?? 0) - PICKUP_BUFFER_MIN;
    for (let i = path.length - 2; i >= 0; i--) times[i] = times[i + 1] - seg[i];
  } else {
    times[0] = (ceMin ?? 0) + DROPOFF_BUFFER_MIN;
    for (let i = 1; i < path.length; i++) times[i] = times[i - 1] + seg[i - 1];
  }
  // 자동값(etaMinutes)은 항상 최신 재계산값으로 갱신해 '다시 계산' 리셋의 기준이 되게 하고,
  // 표시 라벨은 확정값(etaManual)이 있으면 그것을, 없으면 자동값을 쓴다(확정 정차는 재계산에도 불변).
  const stops = order.map((s, i) => {
    const autoMin = Math.round(times[i + 1]);
    const base = { ...s, etaMinutes: autoMin };
    return s.etaManual != null
      ? { ...base, etaLabel: etaMinToLabel(s.etaManual, cur.direction) }
      : { ...base, etaLabel: etaMinToLabel(autoMin, cur.direction) };
  });
  return {
    ...run, stops,
    departTime: fmtHHMM(times[0]),
    arriveTime: fmtHHMM(times[path.length - 1]),
    depotTime: cur.depot ? fmtHHMM(isPickup ? times[0] : times[path.length - 1]) : null,
  };
}

// 위치변경 자동 반영(순수) — 좌표가 바뀐 학생이 앉은 정차의 좌표만 새 좌표로 갱신한다.
// 차량 배정·정차 순서는 절대 바꾸지 않는다. 공유 정차(여러 명)면 그 학생만 인접 정차로 분리한다.
// 반환 reroute = 좌표가 바뀌어 T맵 경로 재계산이 필요한 차량 인덱스.
function relocateInPlace(
  vehiclesInput: DispatchSuggestion["vehicles"],
  changes: DispatchChange[],
): { vehicles: DispatchSuggestion["vehicles"]; reroute: number[] } {
  const vs = vehiclesInput.map((v) => ({ ...v, stops: v.stops.map((s) => ({ ...s, students: [...s.students] })) }));
  const reroute = new Set<number>();
  for (const c of changes) {
    if (c.isHub || c.lat == null || c.lng == null) continue; // 무료탑승·무좌표는 자동 반영 대상 아님
    let done = false;
    for (let vi = 0; vi < vs.length && !done; vi++) {
      const stops = vs[vi].stops;
      for (let si = 0; si < stops.length; si++) {
        const idx = stops[si].students.findIndex((st) => String(st.requestId) === c.requestId);
        if (idx < 0) continue;
        const stop = stops[si];
        // ★ 이미 제자리(같은 장소)에 있으면 아무것도 하지 않는다.
        //   예전엔 여기서 "혼자가 아니면 무조건 분리"했다. 그래서 같은 아파트를 함께 쓰는 두 학생 중
        //   한 명의 좌표가 아주 조금 갱신되기만 해도 정차가 둘로 갈라졌다(2026-08-03 실제 사고 —
        //   합쳐 둔 롯데낙천대 정차가 재계산 때마다 다시 쪼개졌다).
        if (findSamePlaceIndex([stop], c.lat, c.lng) === 0) continue;
        if (stop.students.length === 1) {
          stops[si] = { ...stop, lat: c.lat, lng: c.lng, label: c.label || stop.label, approx: false };
        } else {
          // 혼자가 아니면 그 학생만 떼어낸다. 단, **옮겨 갈 자리에 이미 정차가 있으면 새로 만들지 않고 합친다** —
          // 그러지 않으면 같은 아파트에 정차가 두 개로 갈라져 기사님이 같은 곳을 두 번 들르게 된다.
          const [moved] = stop.students.splice(idx, 1);
          const target = findSamePlaceIndex(stops, c.lat, c.lng);
          if (target >= 0 && target !== si) stops[target] = { ...stops[target], students: [...stops[target].students, moved] };
          else stops.splice(si + 1, 0, { ...stop, lat: c.lat, lng: c.lng, label: c.label || stop.label, approx: false, isHub: false, students: [moved] });
        }
        vs[vi] = { ...vs[vi], path: undefined };
        reroute.add(vi);
        done = true;
        break;
      }
    }
  }
  return { vehicles: vs, reroute: [...reroute] };
}

// apiBase: 배차 제안·저장·재계산 API 접두 경로. 기본은 방학특강(seasonal) — 기존 호출부 무영향.
//   정규 셔틀은 "/api/admin/regular/dispatch" 를 주입해 같은 UI 를 재사용한다.
// rosterEditable: 명단 편집(무료탑승 드래그·학생 상세 모달) 허용 여부. 방학특강만 true(기본).
//   정규는 명단 편집 엔드포인트/상세 모달이 방학특강 전용이라 false 로 끈다(회귀 방지).
// regularEditing: 정규 배차 전용 손편집(차량 이동·학생 빼기·모바일 ↑↓·저장 안 됨 표시·이탈 경고·확인창).
//   기본 false — 방학특강 화면은 이 prop 을 주지 않으므로 기존 동작 그대로다.
// onDirtyChange: 저장 안 한 변경 여부를 부모에 알린다(정규 화면이 요일·월 전환 전에 확인창을 띄운다).
export default function RouteSection({ initial, date, refreshKey, apiBase = "/api/admin/seasonal/dispatch", rosterEditable = true, serviceMonth, drivers, regularEditing = false, onDirtyChange, onRouteChange }: { initial: DispatchSuggestion; date: string; refreshKey: number; apiBase?: string; rosterEditable?: boolean; serviceMonth?: string; drivers?: { id: string; name: string }[]; regularEditing?: boolean; onDirtyChange?: (dirty: boolean) => void; onRouteChange?: (route: DispatchSuggestion, state: { ready: boolean; dirty: boolean; saved: boolean }) => void }) {
  const direction = initial.direction;
  const isPickup = direction === "PICKUP";
  const [sug, setSug] = useState<DispatchSuggestion>(initial);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [departPinned, setDepartPinned] = useState<Record<number, boolean>>({});
  const [mapVehicle, setMapVehicle] = useState<number>(0);
  const [rerouting, setRerouting] = useState(false);
  const [recalcing, setRecalcing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(initial.savedAt ?? null);
  const [loadedFromSaved, setLoadedFromSaved] = useState(initial.loadedFromSaved === true);
  const [drag, setDrag] = useState<{ v: number; s: number } | null>(null);
  const [stuDrag, setStuDrag] = useState<{ v: number; s: number; i: number } | null>(null);
  // 학생 이름 클릭 → 상세 모달(승하차 위치 편집 포함). applicationId가 있어야 열린다.
  const [openStu, setOpenStu] = useState<{ applicationId: string; rosterId: string | null; requestId: string | null } | null>(null);
  const [hubBusy, setHubBusy] = useState(false);
  const [relocatedCount, setRelocatedCount] = useState(0); // 이번 로드에서 좌표 자동 반영된 학생 수(안내용)
  const [assignVi, setAssignVi] = useState<Record<string, number>>({}); // 신규자 requestId별 사용자가 고른 차량
  // 저장 안 한 손편집이 있는가. 편집 함수마다 true, 저장·자동 제안·저장본 불러오기 때 false.
  const [dirty, setDirty] = useState(false);
  // 편집 일련번호 — 편집마다 1 증가. 저장 요청 도중 생긴 편집을 「저장됨」으로 지우지 않으려고 쓴다.
  const editSeq = useRef(0);
  function markDirty() { editSeq.current += 1; setDirty(true); }
  // 정규 모드: 지금 화면의 노선이 현재 요일·월 기준으로 불러와진 상태인가.
  // 요일·월 전환 중이거나 전환이 실패하면 false → 옛 노선을 새 달로 저장하지 못하게 저장을 막는다.
  const [routeReady, setRouteReady] = useState(true);
  const scopeKey = `${apiBase}|${date}|${serviceMonth ?? ""}|${refreshKey}|${direction}`;
  const scopeRef = useRef(scopeKey); scopeRef.current = scopeKey;
  const routeScope = useRef(scopeKey);
  const requestSeq = useRef(0);
  const activeRequest = useRef(0);
  const [pendingReroute, setPendingReroute] = useState(false);
  const saveBlocked = !routeReady || loading || rerouting || recalcing || pendingReroute || sug.date !== date || routeScope.current !== scopeKey;
  useEffect(() => { onRouteChange?.(sug, { ready: routeReady && sug.date === date && routeScope.current === scopeKey, dirty, saved: loadedFromSaved }); }, [sug, routeReady, date, dirty, loadedFromSaved, onRouteChange, scopeKey]);

  // 부모(정규 화면)에 변경 여부 전달 — 요일·월 전환 시 확인창용.
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  // 정규 모드: 저장 안 한 변경이 있으면 새로고침·탭 닫기 때 브라우저 기본 경고를 띄운다.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [regularEditing, dirty]);

  const sugRef = useRef(sug); sugRef.current = sug;
  const departPinnedRef = useRef(departPinned); departPinnedRef.current = departPinned;
  const rerouteTimer = useRef<number | null>(null);
  const dirtyVehicles = useRef<Set<number>>(new Set());
  useEffect(() => { scopeRef.current = scopeKey; return () => { scopeRef.current = "unmounted"; if (rerouteTimer.current) window.clearTimeout(rerouteTimer.current); }; }, [scopeKey]);
  const firstRun = useRef(true); // 첫 렌더는 서버가 준 initial을 쓰고 재조회하지 않는다(중복 T맵 방지).

  async function generate(forDate: string, token = ++requestSeq.current, scope = scopeRef.current, preserveVersion = true) {
    const baselineVersion = preserveVersion && routeScope.current === scope ? savedAt : null;
    activeRequest.current = token;
    const current = () => scopeRef.current === scope && activeRequest.current === token;
    setLoading(true); setErr(null);
    try {
      const r = await fetch(apiBase, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ direction, date: forDate || null, serviceMonth: serviceMonth ?? null }),
      });
      const j = await r.json();
      if (!current()) return;
      if (!r.ok || !Array.isArray(j?.vehicles) || j.direction !== direction || j.date !== forDate) throw new Error("노선을 불러오지 못했습니다. 다시 시도해 주세요.");
      // 서버는 자동값만 계산한다 → 기존 화면의 수동 확정값(etaManual)을 키 매칭으로 다시 얹는다(확정 유지).
      const prior = routeScope.current === scope ? sugRef.current.vehicles : [];
      const recalculated = reapplyManualEtaVehicles<Run>(j.vehicles as Run[], prior, direction);
      // 정규 배차 재계산 시 같은 차량·회차의 담당 기사 선택은 유지한다.
      const vehicles = recalculated.map((vehicle: Run) => {
        const previous = prior.find((candidate) => candidate.vehicleName === vehicle.vehicleName
          && candidate.tripLabel === vehicle.tripLabel
          && candidate.classStart === vehicle.classStart
          && candidate.classEnd === vehicle.classEnd);
        return previous?.driverUserId ? { ...vehicle, driverUserId: previous.driverUserId } : vehicle;
      });
      routeScope.current = scope;
      setSug({ ...j, vehicles }); setSavedAt(baselineVersion); setLoadedFromSaved(false); setDepartPinned({}); setRelocatedCount(0); setDirty(true); setRouteReady(true);
    } catch { if (current()) { setErr("노선을 불러오지 못했습니다. 다시 시도해 주세요."); setRouteReady(false); } }
    finally { if (current()) setLoading(false); }
  }

  async function loadAndApplySaved(forDate: string, token = ++requestSeq.current, scope = scopeRef.current): Promise<boolean> {
    activeRequest.current = token;
    const current = () => scopeRef.current === scope && activeRequest.current === token;
    try {
      const r = await fetch(`${apiBase}/saved?date=${encodeURIComponent(forDate)}&direction=${direction}${serviceMonth ? `&serviceMonth=${encodeURIComponent(serviceMonth)}` : ""}`, { cache: "no-store" });
      const j = await r.json();
      if (!current()) return true;
      if (!r.ok || !("saved" in j)) throw new Error("저장된 노선을 불러오지 못했습니다.");
      if (j.saved === null) return false;
      if (!Array.isArray(j.saved.vehicles) || !j.saved.savedAt) throw new Error("저장된 노선을 확인하지 못했습니다.");
      const saved = j.saved as { vehicles: DispatchSuggestion["vehicles"]; classStart: string | null; classEnd: string | null; savedAt: string | null; added?: DispatchChange[]; locationChanged?: DispatchChange[] };
      const changes = saved.locationChanged ?? [];
      // 위치변경 자동 반영 — 저장 노선의 좌표만 갱신(차량 배정·순서 불변). 좌표 바뀐 차량은 아래에서 경로만 재계산.
      const { vehicles: fixed, reroute } = relocateInPlace(saved.vehicles, changes);
      // 헤더의 "탑승 N명"은 지금 화면에 그려질 저장 노선 기준으로 다시 센다.
      // (서버가 준 totalRiders는 '오늘 명단' 기준이라 저장 노선과 어긋날 수 있다 — 정차별 합과 헤더가 달라 보인다.)
      const shownRiders = fixed.reduce((acc, v) => acc + (v.stops ?? []).reduce((a, s) => a + (s.students?.length ?? 0), 0), 0);
      // added(신규·복귀)는 배너에서 '추천 배정'으로 쓰므로 그대로 싣고, locationChanged는 이미 반영했으니 비운다.
      routeScope.current = scope;
      setSug((cur) => ({ ...cur, date: forDate, vehicles: fixed, totalRiders: shownRiders, classStart: saved.classStart ?? cur.classStart, classEnd: saved.classEnd ?? cur.classEnd, added: saved.added ?? [], locationChanged: [] }));
      setSavedAt(saved.savedAt); setLoadedFromSaved(true); setDepartPinned({}); setErr(null); setSaveMsg(null);
      const relocated = changes.filter((c) => !c.isHub && c.lat != null && c.lng != null).length;
      setRelocatedCount(relocated);
      setDirty(relocated > 0); // 좌표 자동 반영분은 아직 저장 전이다
      setRouteReady(true);
      // 좌표가 바뀐 차량 + reconcile로 경로(path)가 무효화된 차량(취소 학생 등)을 T맵 재계산 예약.
      // (path가 비면 지도는 직선으로 그려지므로, 재계산으로 실도로 경로를 복구한다.)
      const need = new Set<number>(reroute);
      fixed.forEach((v, vi) => { if (!v.path && v.stops.length > 0) need.add(vi); });
      need.forEach((vi) => scheduleReroute(vi));
      return true;
    } catch (error) { if (current()) { setErr("저장된 노선을 불러오지 못했습니다. 다시 시도해 주세요."); setRouteReady(false); } throw error; }
  }

  async function switchTo(forDate: string) {
    const token = ++requestSeq.current, scope = scopeRef.current;
    activeRequest.current = token; setLoading(true); setRouteReady(false);
    if (rerouteTimer.current) window.clearTimeout(rerouteTimer.current);
    dirtyVehicles.current.clear(); setPendingReroute(false); setRerouting(false);
    try {
      const applied = forDate ? await loadAndApplySaved(forDate, token, scope) : false;
      if (scopeRef.current !== scope || activeRequest.current !== token) return;
      if (!applied) { setLoadedFromSaved(false); setSaveMsg(null); await generate(forDate, token, scope, false); }
    } catch { /* 조회 실패 시 이전 화면을 보존하고 저장을 차단한다. */ }
    finally { if (scopeRef.current === scope && activeRequest.current === token) setLoading(false); }
  }

  // 날짜/기준위치 변경 시 이 방향을 다시 계산한다. 첫 렌더는 서버 initial을 그대로 쓴다.
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; if (initial.date === date) return; }
    // 새 요일·월(refreshKey)을 다 불러올 때까지 저장 금지(정규 모드). 불러오기가 성공하면 generate/load 가 다시 연다.
    setRouteReady(false);
    void switchTo(date);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, refreshKey]);

  async function saveRoute() {
    if (saving || !sug.date || saveBlocked) return;
    // 정규 모드: 정원 초과 차량이 있으면 저장 전에 한 번 확인한다(손으로 옮기다 넘친 경우).
    if (regularEditing) {
      const over = overCapacityVehicles(sug.vehicles);
      if (over.length > 0 && !window.confirm(`정원을 넘은 차량이 있습니다.\n${over.map((o) => `· ${o.name}: ${o.passengers}/${o.capacity}명`).join("\n")}\n\n그래도 저장할까요?`)) return;
      // 이 요일·방향에 저장본이 아직 없으면, 첫 저장 순간 기사님 화면이 「셔틀 명단」 순서 → 이 노선으로 바뀐다. 한 번 확인한다.
      if (!loadedFromSaved && !savedAt && !window.confirm("지금 기사님 화면은 「셔틀 명단」 순서로 운행 중입니다.\n여기서 저장하면 이 요일·방향의 기사님 화면이 이 노선으로 바뀝니다.\n\n저장할까요?")) return;
    }
    const scopeAtStart = scopeRef.current;
    const snapshot = sug;
    const seqAtStart = editSeq.current; // 이 시점의 편집까지만 저장된다
    setSaving(true); setSaveMsg(null); setErr(null);
    try {
      const r = await fetch(`${apiBase}/saved`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedSavedAt: savedAt, date: sug.date, direction: sug.direction, vehicles: sug.vehicles, classStart: sug.classStart, classEnd: sug.classEnd, serviceMonth: serviceMonth ?? null }),
      });
      const j = await r.json();
      if (scopeRef.current !== scopeAtStart) return;
      if (!r.ok || j?.ok !== true || typeof j.savedAt !== "string" || !Number.isFinite(Date.parse(j.savedAt))) throw new Error(r.status === 409 ? "다른 창에서 노선이 변경되었습니다. 다시 불러온 뒤 수정해 주세요." : "저장 결과를 확인하지 못했습니다. 다시 불러와 확인해 주세요.");
      const check = await fetch(`${apiBase}/saved?date=${encodeURIComponent(snapshot.date!)}&direction=${direction}${serviceMonth ? `&serviceMonth=${encodeURIComponent(serviceMonth)}` : ""}&verify=1`, { cache: "no-store" });
      const verified = await check.json();
      if (scopeRef.current !== scopeAtStart) return;
      if (!check.ok || verified?.saved?.savedAt !== j.savedAt || !sameSavedRoute(snapshot, verified.saved)) throw new Error("저장한 내용과 조회 결과가 다릅니다. 다시 불러와 확인해 주세요.");
      setSavedAt(j.savedAt); setLoadedFromSaved(true); setSaveMsg(editSeq.current === seqAtStart ? "저장했습니다" : "저장 후 추가한 변경이 있습니다"); setRelocatedCount(0);
      // 저장 요청 중에 또 고쳤다면 그 편집은 아직 저장 전이다 → 「저장 안 됨」 유지.
      if (editSeq.current === seqAtStart) setDirty(false);
    } catch (e: unknown) { if (scopeRef.current === scopeAtStart) { setErr(publicErrorText(e, "노선을 저장하지 못했습니다.")); setDirty(true); setRouteReady(false); } }
    finally { setSaving(false); }
  }

  function setDriver(vIdx: number, driverUserId: string) {
    setSug((current) => ({
      ...current,
      vehicles: current.vehicles.map((vehicle, index) => index === vIdx
        ? { ...vehicle, driverUserId: driverUserId || null }
        : vehicle),
    }));
    setSaveMsg(null); markDirty();
  }

  // 저장된 노선 삭제 — 그 요일/방향 저장본을 지우고 자동 제안으로 되돌린다.
  async function deleteRoute() {
    if (saving || !sug.date || saveBlocked) return; // 정규: 요일·월 전환 중엔 새 달 저장본을 지우지 않는다
    const msg = regularEditing
      ? "저장된 노선을 지우고 자동 제안으로 초기화할까요?\n손으로 고친 순서·시각·배정이 사라집니다."
      : "이 요일의 저장된 노선을 삭제할까요? 삭제하면 자동 제안이 다시 기준이 됩니다.";
    if (typeof window !== "undefined" && !window.confirm(msg)) return;
    const scopeAtStart = scopeRef.current;
    setSaving(true); setSaveMsg(null); setErr(null);
    try {
      const r = await fetch(`${apiBase}/saved?date=${encodeURIComponent(sug.date)}&direction=${direction}${serviceMonth ? `&serviceMonth=${encodeURIComponent(serviceMonth)}` : ""}${savedAt ? `&expectedSavedAt=${encodeURIComponent(savedAt)}` : ""}`, { method: "DELETE" });
      const j = await r.json().catch(() => ({}));
      if (scopeRef.current !== scopeAtStart) return;
      if (!r.ok || j?.ok !== true) throw new Error(r.status === 409 ? "다른 창에서 노선이 변경되었습니다. 다시 불러와 주세요." : "노선을 삭제하지 못했습니다.");
      const check = await fetch(`${apiBase}/saved?date=${encodeURIComponent(sug.date)}&direction=${direction}${serviceMonth ? `&serviceMonth=${encodeURIComponent(serviceMonth)}` : ""}`, { cache: "no-store" });
      const verified = await check.json();
      if (scopeRef.current !== scopeAtStart) return;
      if (!check.ok || verified?.saved !== null) throw new Error("삭제 결과를 확인하지 못했습니다. 다시 불러와 주세요.");
      setSavedAt(null); setLoadedFromSaved(false); setSaveMsg("저장 노선을 삭제했습니다");
      await generate(sug.date ?? date, undefined, scopeRef.current, false); // 삭제가 확인된 뒤에는 새 저장본으로 시작한다
    } catch (e: unknown) { if (scopeRef.current === scopeAtStart) { setErr(publicErrorText(e, "노선을 삭제하지 못했습니다.")); setRouteReady(false); } }
    finally { setSaving(false); }
  }

  async function recalcPaths() {
    if (rerouting || loading || recalcing) return;
    if (dirty && !window.confirm("저장하지 않은 변경을 버리고 저장 노선을 다시 불러올까요?")) return;
    const scope = scopeRef.current;
    setRecalcing(true); setErr(null);
    try {
      const ok = await loadAndApplySaved(sug.date ?? date);
      if (!ok) { setErr("저장된 노선이 없습니다. 먼저 저장해주세요."); return; }
      // ⚠️ setSug는 비동기다. 바로 sugRef를 읽으면 **불러오기 이전의 옛 노선**이 잡힌다.
      //   2026-08-03 실제 사고: 이 자리에서 옛 노선을 읽어 재계산하고 자동 저장까지 해버려,
      //   무료거점 학생 한 명이 노선에서 사라지고 합쳐 둔 정차가 다시 갈라진 채 DB에 덮어써졌다.
      //   상태가 반영될 때까지 한 틱 양보한 뒤 읽는다.
      await new Promise((r) => setTimeout(r, 0));
      if (scopeRef.current !== scope) return;
      const cur = sugRef.current;
      for (let vi = 0; vi < cur.vehicles.length; vi++) {
        if (scopeRef.current !== scope) return;
        await rerouteVehicle(vi);
      }
      // ★ 자동 저장하지 않는다. 재계산 결과를 원장이 눈으로 확인한 뒤 [저장]을 누르게 한다.
      //   저장은 되돌릴 수 없고, 잘못된 재계산이 조용히 덮어쓰면 학생이 노선에서 사라진다(위 사고).
      setSaveMsg("경로를 다시 계산했습니다. 내용을 확인한 뒤 [저장]을 눌러주세요.");
    } catch (e: unknown) { setErr(publicErrorText(e, "경로 재계산에 실패했습니다.")); }
    finally { setRecalcing(false); }
  }

  function reorderStop(vIdx: number, from: number, to: number) {
    setSug((cur) => {
      const vehicles = cur.vehicles.map((v) => ({ ...v, stops: [...v.stops] }));
      const stops = vehicles[vIdx].stops;
      if (from < 0 || from >= stops.length || to < 0 || to >= stops.length || from === to) return cur;
      const [moved] = stops.splice(from, 1);
      stops.splice(to, 0, moved);
      const pinnedDepart = departPinned[vIdx] ? vehicles[vIdx].departTime : null;
      vehicles[vIdx] = { ...recomputeRunTimes(cur, vehicles[vIdx], pinnedDepart), path: undefined };
      return { ...cur, vehicles };
    });
    markDirty();
    scheduleReroute(vIdx);
  }

  // ── 정규 손편집: 차량 간 이동·학생 빼기 ─────────────────────────
  // 계산은 순수 모듈(regularRouteEdit)이 하고, 여기서는 바뀐 차량(touched)만 시각 재계산 + 경로 재계산을 건다.
  // 계산은 setSug updater 안에서 최신 상태(prev)로 한다(경로 재계산 결과 등과 엇갈려 덮어쓰지 않게).
  // 바뀔 차량(touched)은 호출하는 쪽이 미리 알기 때문에 경로 재계산 예약은 밖에서 한다.
  function routeEnds(cur: DispatchSuggestion) {
    return { start: isPickup ? (cur.depot ?? cur.academy) : cur.academy, end: isPickup ? cur.academy : (cur.depot ?? cur.academy) };
  }
  function applyRouteEdit(touched: number[], edit: (cur: DispatchSuggestion) => EditResult<Run>, riderDelta = 0) {
    setSug((prev) => {
      const r = edit(prev);
      if (r.touched.length === 0) return prev; // 잘못된 인덱스 등 — 아무것도 안 바뀜
      const pinned = departPinnedRef.current;
      const vehicles = r.vehicles.map((v, i) => r.touched.includes(i) ? recomputeRunTimes(prev, v, pinned[i] ? v.departTime : null) : v);
      return { ...prev, vehicles, totalRiders: Math.max(0, prev.totalRiders + riderDelta) };
    });
    markDirty(); setSaveMsg(null);
    touched.forEach((vi) => scheduleReroute(vi));
  }
  // 다른 수업시간 회차로 옮기면 학생이 다른 시각에 타게 된다 → 한 번 확인한다.
  function confirmRunTimeChange(vIdx: number, toV: number): boolean {
    const ch = runTimeChange(sug.vehicles[vIdx], sug.vehicles[toV], isPickup);
    return !ch || window.confirm(`수업시간이 다른 회차입니다(${ch.from} → ${ch.to}). 옮길까요?`);
  }
  function moveStop(vIdx: number, sIdx: number, toV: number) {
    if (!confirmRunTimeChange(vIdx, toV)) return;
    applyRouteEdit([vIdx, toV], (cur) => moveStopToVehicle(cur.vehicles, { v: vIdx, s: sIdx }, toV, routeEnds(cur)));
  }
  function moveStudent(vIdx: number, sIdx: number, i: number, toV: number) {
    if (!confirmRunTimeChange(vIdx, toV)) return;
    applyRouteEdit([vIdx, toV], (cur) => moveStudentToVehicle(cur.vehicles, { v: vIdx, s: sIdx, i }, toV, routeEnds(cur)));
  }
  function removeStudent(vIdx: number, sIdx: number, i: number) {
    const st = sug.vehicles[vIdx]?.stops[sIdx]?.students[i];
    if (!st) return;
    // 퇴원·셔틀 중단은 「셔틀 명단」에서 빼는 것이 원칙 — 여기서 빼면 이 저장본에서만 빠진다.
    if (!window.confirm(`${st.name} 학생을 이 노선에서 뺄까요?\n\n퇴원·셔틀 중단이라면 「셔틀 명단」에서 빼야 다음 자동 제안에서도 빠집니다.\n명단에 남아 있으면 기사님 화면 '확정 전' 칸에 계속 보입니다.\n(뺀 뒤 💾 저장해야 반영됩니다)`)) return;
    applyRouteEdit([vIdx], (cur) => removeStudentFromRoute(cur.vehicles, { v: vIdx, s: sIdx, i }), -1);
  }
  // 차량 선택 메뉴에 쓰는 이름(회차·인원 포함) — 옮길 차량의 여유를 바로 보게 한다.
  function vehicleOptionLabel(v: Run): string {
    return `${v.vehicleName}${v.tripLabel ? ` ${v.tripLabel}` : ""} (${v.passengers}/${v.capacity})`;
  }

  function scheduleReroute(vIdx: number) {
    setPendingReroute(true);
    const scope = scopeRef.current;
    dirtyVehicles.current.add(vIdx);
    if (rerouteTimer.current) window.clearTimeout(rerouteTimer.current);
    rerouteTimer.current = window.setTimeout(() => { if (scopeRef.current === scope) void runReroute(); }, 500);
  }
  async function runReroute() {
    const scope = scopeRef.current;
    const ids = [...dirtyVehicles.current]; dirtyVehicles.current.clear();
    if (ids.length === 0) return;
    setRerouting(true);
    try { for (const vIdx of ids) { if (scopeRef.current !== scope) return; await rerouteVehicle(vIdx); } }
    finally { if (scopeRef.current === scope) { setRerouting(false); setPendingReroute(dirtyVehicles.current.size > 0); } }
  }
  async function rerouteVehicle(vIdx: number) {
    const cur = sugRef.current;
    const scope = scopeRef.current, seq = editSeq.current, token = activeRequest.current;
    const v = cur.vehicles[vIdx];
    if (!v || v.stops.length === 0) return;
    const startPt = isPickup ? (cur.depot ?? cur.academy) : cur.academy;
    const endPt = isPickup ? cur.academy : (cur.depot ?? cur.academy);
    try {
      const r = await fetch(`${apiBase}/reroute`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start: { lat: startPt.lat, lng: startPt.lng }, end: { lat: endPt.lat, lng: endPt.lng }, waypoints: v.stops.map((s) => ({ lat: s.lat, lng: s.lng })) }),
      });
      const j = await r.json().catch(() => null);
      if (scopeRef.current !== scope || editSeq.current !== seq || activeRequest.current !== token) return;
      if (!r.ok || !j?.path) throw new Error("경로를 확인하지 못했습니다.");
      setDirty(true);
      setSug((prev) => {
        if (!prev.vehicles[vIdx] || scopeRef.current !== scope || editSeq.current !== seq || activeRequest.current !== token) return prev;
        const vehicles = prev.vehicles.map((vv, i) => (i !== vIdx ? vv
          : { ...vv, path: j.path as { lat: number; lng: number }[], tmapMinutes: j.totalMinutes ?? vv.tmapMinutes, tmapKm: j.totalKm ?? vv.tmapKm, provider: "TMAP" as const }));
        vehicles[vIdx] = recomputeRunTimes(prev, vehicles[vIdx], departPinnedRef.current[vIdx] ? vehicles[vIdx].departTime : null);
        return { ...prev, vehicles };
      });
    } catch { if (scopeRef.current === scope && editSeq.current === seq && activeRequest.current === token) { setErr("경로를 확인하지 못했습니다. 다시 불러와 주세요."); setRouteReady(false); } }
  }

  async function moveStudentToHub(vIdx: number, sIdx: number, stuIdx: number) {
    const st = sug.vehicles[vIdx]?.stops[sIdx]?.students[stuIdx];
    if (!st || hubBusy) return;
    setHubBusy(true); setErr(null);
    try {
      const target = st.rosterId ? { rosterId: st.rosterId } : { requestId: st.requestId };
      const newLabel = `무료탑승 · ${(st.pickupLabel || st.name).replace(/^무료탑승\s*·?\s*/, "")}`;
      const r = await fetch("/api/admin/seasonal/shuttle-roster", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...target, patch: { pickupLocation: newLabel } }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || "저장 실패");
      await generate(sug.date ?? date);
    } catch (e: unknown) { setErr(publicErrorText(e, "무료탑승으로 옮기지 못했습니다.")); }
    finally { setHubBusy(false); }
  }

  // 신규·복귀자 배정용 ─────────────────────────────
  function buildStudent(c: DispatchChange) {
    return { name: c.name, grade: c.grade, parentPhone: c.parentPhone, childPhone: c.childPhone, rosterId: c.rosterId, requestId: c.requestId, pickupLabel: c.label, applicationId: null };
  }
  // 한 차량에서 이 학생을 넣을 최적(추가비용 최소) 인접위치 k를 찾는다(기존 정차 순서 보존).
  function bestInsertK(cur: DispatchSuggestion, v: Run, S: Pt): number {
    const startPt: Pt = isPickup ? (cur.depot ?? cur.academy) : cur.academy;
    const endPt: Pt = isPickup ? cur.academy : (cur.depot ?? cur.academy);
    const pts: Pt[] = [startPt, ...v.stops.map((s) => ({ lat: s.lat, lng: s.lng })), endPt];
    let bestK = 0, bestCost = Infinity;
    for (let k = 0; k < pts.length - 1; k++) {
      const cost = haversineKm(pts[k], S) + haversineKm(S, pts[k + 1]) - haversineKm(pts[k], pts[k + 1]);
      if (cost < bestCost) { bestCost = cost; bestK = k; }
    }
    return bestK;
  }
  // 추천 차량 인덱스 — 정원 여유가 있는 차량 중 삽입 추가비용이 가장 작은 차량. hub 학생은 hub 있는 차량.
  function recommendVi(c: DispatchChange): number {
    const cur = sugRef.current;
    if (cur.vehicles.length === 0) return 0;
    if (c.isHub) { const vi = cur.vehicles.findIndex((v) => v.stops.some((s) => s.isHub) && v.passengers < v.capacity); return vi >= 0 ? vi : cur.vehicles.findIndex((v) => v.stops.some((s) => s.isHub)); }
    if (c.lat == null || c.lng == null) return 0;
    const S: Pt = { lat: c.lat, lng: c.lng };
    let best = -1, bestCost = Infinity;
    cur.vehicles.forEach((v, vi) => {
      if (v.passengers >= v.capacity) return;
      const k = bestInsertK(cur, v, S);
      const startPt: Pt = isPickup ? (cur.depot ?? cur.academy) : cur.academy;
      const endPt: Pt = isPickup ? cur.academy : (cur.depot ?? cur.academy);
      const pts: Pt[] = [startPt, ...v.stops.map((s) => ({ lat: s.lat, lng: s.lng })), endPt];
      const cost = haversineKm(pts[k], S) + haversineKm(S, pts[k + 1]) - haversineKm(pts[k], pts[k + 1]);
      if (cost < bestCost) { bestCost = cost; best = vi; }
    });
    return best >= 0 ? best : 0;
  }
  // 신규·복귀자를 선택한 차량에 배정한다(내가 결정). 동좌표는 병합, 아니면 최적위치 삽입 후 그 차량만 경로 재계산.
  function assignAdded(c: DispatchChange, vi: number) {
    const cur = sugRef.current;
    const v = cur.vehicles[vi];
    if (!v) { setErr("배정할 차량이 없습니다."); return; }
    let needReroute = false;
    setSug((prev) => {
      const vehicles = prev.vehicles.map((vv) => ({ ...vv, stops: vv.stops.map((s) => ({ ...s, students: [...s.students] })) }));
      const veh = vehicles[vi];
      if (!veh) return prev;
      const student = buildStudent(c);
      if (c.isHub) {
        const hub = veh.stops.find((s) => s.isHub);
        if (!hub) { setErr("이 차량에 무료탑승 거점이 없습니다."); return prev; }
        hub.students.push(student);
      } else if (c.lat != null && c.lng != null) {
        // 같은 장소(≤30m)면 기존 정차에 합친다. 기준은 stopMerge.ts 하나뿐 —
        // 예전엔 여기만 ±1e-5(약 1.1m)라, 자동 제안으로는 합쳐지던 같은 아파트가 손으로 배정하면 갈라졌다.
        const mi = findSamePlaceIndex(veh.stops, c.lat, c.lng);
        if (mi >= 0) veh.stops[mi].students.push(student);
        else { veh.stops.splice(bestInsertK(prev, veh, { lat: c.lat, lng: c.lng }), 0, { lat: c.lat, lng: c.lng, label: c.label, students: [student], approx: false, isHub: false }); needReroute = true; }
      } else { setErr(`${c.name}: 좌표가 없어 무료탑승으로만 배정할 수 있습니다.`); return prev; }
      const passengers = veh.stops.reduce((a, s) => a + s.students.length, 0);
      const pinnedDepart = departPinned[vi] ? veh.departTime : null;
      vehicles[vi] = { ...recomputeRunTimes(prev, veh, pinnedDepart), passengers, over: passengers > veh.capacity, ...(needReroute ? { path: undefined } : {}) };
      return { ...prev, vehicles, added: (prev.added ?? []).filter((a) => a.requestId !== c.requestId) };
    });
    markDirty();
    if (needReroute) scheduleReroute(vi);
  }

  function setDepartTime(vIdx: number, newDepart: string) {
    setDepartPinned((p) => ({ ...p, [vIdx]: true }));
    markDirty();
    setSug((cur) => {
      const vehicles = cur.vehicles.map((v, i) => {
        if (i !== vIdx) return v;
        const oldMin = parseHHMM(v.departTime), newMin = parseHHMM(newDepart);
        if (oldMin == null || newMin == null) return v;
        const delta = newMin - oldMin;
        if (delta === 0) return v;
        // 확정(etaManual) 정차는 절대값을 유지한다(출발시각 이동에 흔들리지 않음). 자동 정차만 delta만큼 민다.
        return { ...v, departTime: shiftHHMM(v.departTime, delta), arriveTime: shiftHHMM(v.arriveTime, delta), depotTime: shiftHHMM(v.depotTime, delta), stops: v.stops.map((s) => s.etaManual != null ? s : ({ ...s, etaLabel: shiftLabel(s.etaLabel, delta), etaMinutes: s.etaMinutes != null ? s.etaMinutes + delta : s.etaMinutes })) };
      });
      return { ...cur, vehicles };
    });
  }

  // 정차 시각 편집(T2) — 관리자가 input(HH:MM)으로 고치면 그 값을 etaManual에 '확정'하고 라벨을 확정값으로 갱신한다.
  function setStopEta(vIdx: number, sIdx: number, value: string) {
    const min = parseHHMM(value);
    if (min == null) return; // 빈값/잘못된 입력은 무시(기존 값 유지)
    markDirty();
    setSug((cur) => ({
      ...cur,
      vehicles: cur.vehicles.map((v, i) => i !== vIdx ? v
        : { ...v, stops: v.stops.map((s, j) => j !== sIdx ? s : ({ ...s, etaManual: min, etaLabel: etaMinToLabel(min, cur.direction) })) }),
    }));
  }
  // '다시 계산' — 그 정차의 확정을 풀고(etaManual=null) 자동값(etaMinutes)으로 되돌린다.
  function resetStopEta(vIdx: number, sIdx: number) {
    markDirty();
    setSug((cur) => ({
      ...cur,
      vehicles: cur.vehicles.map((v, i) => i !== vIdx ? v
        : { ...v, stops: v.stops.map((s, j) => {
            if (j !== sIdx) return s;
            const auto = s.etaMinutes;
            return { ...s, etaManual: null, etaLabel: auto != null ? etaMinToLabel(auto, cur.direction) : s.etaLabel };
          }) }),
    }));
  }
  // input[type=time]에 넣을 확정 시각(HH:MM). 확정값 우선, 없으면 자동값, 그것도 없으면 라벨 앞의 시각.
  function stopEtaHHMM(s: Run["stops"][number]): string {
    const m = confirmedEtaMin(s);
    if (m != null) return fmtHHMM(m);
    const mt = s.etaLabel?.match(/^(\d{1,2}:\d{2})/);
    return mt ? mt[1] : "";
  }

  // 정규 모드 · 학생 이름 옆 도구: ⇄(다른 차량으로 이 학생만) + ×(이번 노선에서 빼기).
  // 혼자 타는 일반 정차는 정차 「→ 차량 이동」과 같으므로 ⇄ 를 숨겨 화면을 단순하게 둔다.
  function renderStudentTools(vIdx: number, sIdx: number, i: number, s: Run["stops"][number], name: string) {
    const canMove = sug.vehicles.length > 1 && (s.students.length > 1 || !!s.isHub);
    return (
      <span className="ml-0.5 inline-flex items-center gap-0.5 align-middle print:hidden">
        {canMove && (
          <select value="" onChange={(e) => { if (e.target.value !== "") moveStudent(vIdx, sIdx, i, Number(e.target.value)); }}
            aria-label={`${name} 학생만 다른 차량으로 이동`} title="이 학생만 다른 차량으로"
            className="w-6 cursor-pointer appearance-none rounded border border-gray-200 bg-white text-center text-[10px] font-black text-gray-500 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-300">
            <option value="">⇄</option>
            {sug.vehicles.map((ov, oi) => oi === vIdx ? null : <option key={oi} value={oi}>{vehicleOptionLabel(ov)}</option>)}
          </select>
        )}
        <button type="button" draggable={false} onClick={() => removeStudent(vIdx, sIdx, i)} aria-label={`${name} 학생을 이 노선에서 빼기`} title="이 노선에서 빼기"
          className="grid h-4 w-4 place-items-center rounded text-[11px] font-black leading-none text-gray-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/30">×</button>
      </span>
    );
  }

  const activeMapIdx = sug.vehicles.length ? Math.min(Math.max(mapVehicle, 0), sug.vehicles.length - 1) : 0;
  const mapStartPt = isPickup ? (sug.depot ?? sug.academy) : sug.academy;
  const mapEndPt = isPickup ? sug.academy : (sug.depot ?? sug.academy);
  const sectionTime = (sug.timeGroups?.length ?? 0) > 1 ? "시간대별" : (isPickup ? sug.classStart : sug.classEnd);

  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
      {/* 섹션 헤더: 시간 · 방향 */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 pb-2 dark:border-gray-700">
        <div className="flex items-center gap-2">
          <span className={`grid h-8 w-8 place-items-center rounded-xl text-lg ${isPickup ? "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200" : "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-200"}`}>{isPickup ? "⬆" : "⬇"}</span>
          <div>
            <p className="text-[15px] font-black text-gray-900 dark:text-white">{sectionTime ?? "-"} · {isPickup ? "등원" : "하원"}</p>
            <p className="text-[11.5px] font-bold text-gray-500">{sug.timeGroups && sug.timeGroups.length > 1 ? `${sug.timeGroups.length}개 수업시간` : `${sug.classStart ?? "-"}${sug.classEnd ? `~${sug.classEnd}` : ""} 수업`} · 탑승 {sug.totalRiders}명{rerouting ? " · 🔄 경로 재계산…" : ""}</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 print:hidden">
          {regularEditing && dirty && <span className="rounded-full bg-amber-100 px-2 py-1 text-[11px] font-black text-amber-800 dark:bg-amber-500/20 dark:text-amber-200">● 저장 안 됨</span>}
          <button onClick={() => {
            // 정규 모드: 저장본을 보고 있거나 손편집이 있으면 덮어쓰기 전에 확인한다.
            if (regularEditing && (loadedFromSaved || dirty) && !window.confirm("손으로 고친 순서·시각·배정이 사라집니다. 계속할까요?")) return;
            setLoadedFromSaved(false); setSaveMsg(null); void generate(date);
          }} disabled={loading || saving || rerouting || recalcing || pendingReroute} className="rounded-lg bg-brand-navy-900 px-2.5 py-1.5 text-[12px] font-black text-white disabled:opacity-50 dark:bg-brand-neon-lime dark:text-brand-navy-900">{loading ? "계산 중…" : "⚡ 자동 제안"}</button>
          <button onClick={saveRoute} disabled={saving || saveBlocked || sug.vehicles.length === 0} className="rounded-lg bg-brand-orange-500 px-2.5 py-1.5 text-[12px] font-black text-white disabled:opacity-50">{saving ? "저장 중…" : "💾 저장"}</button>
          {loadedFromSaved && <button onClick={() => void recalcPaths()} disabled={loading || rerouting || recalcing} className="rounded-lg border border-blue-300 px-2.5 py-1.5 text-[12px] font-black text-blue-700 disabled:opacity-50 dark:border-blue-500/40 dark:text-blue-300">{recalcing ? "계산 중…" : "🗺 경로 재계산"}</button>}
          {loadedFromSaved && <button onClick={deleteRoute} disabled={saving || saveBlocked} className="rounded-lg border border-red-300 px-2.5 py-1.5 text-[12px] font-black text-red-600 disabled:opacity-50 dark:border-red-500/40 dark:text-red-300">{regularEditing ? "↺ 자동 제안으로 초기화" : "🗑 노선 삭제"}</button>}
        </div>
      </div>

      {!routeReady && <button type="button" onClick={() => void switchTo(date)} disabled={loading} className="rounded-lg border px-3 py-2 text-sm font-bold">다시 불러오기</button>}
      {err && <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs font-bold text-red-600">⚠ {err}</p>}
      {loadedFromSaved && <p className="mt-2 rounded-lg bg-blue-50 px-3 py-2 text-[11.5px] font-bold text-blue-700 dark:bg-blue-900/30 dark:text-blue-200">💾 저장된 노선{savedAt ? ` · ${fmtSaved(savedAt)} 저장` : ""}</p>}
      {saveMsg && <p className="mt-2 rounded-lg bg-green-50 px-3 py-2 text-[11.5px] font-bold text-green-700 dark:bg-green-900/30 dark:text-green-200">✓ {saveMsg}</p>}

      {/* 위치 미세조정 자동 반영 안내 — 좌표가 바뀐 학생의 경로만 자동 갱신됐다. 배정·순서는 그대로. */}
      {relocatedCount > 0 && (
        <p className="mt-2 rounded-lg bg-blue-50 px-3 py-2 text-[11.5px] font-bold text-blue-700 dark:bg-blue-900/30 dark:text-blue-200 print:hidden">
          📍 위치 변경 {relocatedCount}명 · 배정과 순서는 유지했습니다. 확인 후 <b>저장</b>해 주세요.
        </p>
      )}

      {/* 신규·복귀자 추천 배정 — 자동으로 끼워넣지 않고, 추천 차량을 보여주고 원장이 직접 배정한다.
          원장 전용 화면에서만 렌더링된다(기사님 화면은 이 컴포넌트를 쓰지 않는다). */}
      {(sug.added ?? []).length > 0 && (
        <div className="mt-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 dark:border-amber-500/40 dark:bg-amber-500/10 print:hidden">
          <p className="text-[12px] font-black text-amber-800 dark:text-amber-200">🙋 신규·복귀 {(sug.added ?? []).length}명 · 탑승 차량 선택</p>
          <ul className="mt-1.5 space-y-1.5">
            {(sug.added ?? []).map((c) => {
              const rec = recommendVi(c);
              const chosen = assignVi[c.requestId] ?? rec;
              const noCoord = !c.isHub && (c.lat == null || c.lng == null);
              return (
                <li key={c.requestId} className="flex flex-wrap items-center gap-1.5 rounded-lg bg-white px-2.5 py-1.5 dark:bg-gray-900/50">
                  <span className="text-[12.5px] font-black text-gray-900 dark:text-white">{c.name}</span>
                  <span className="text-[11px] font-bold text-gray-500">{c.isHub ? "🆓 무료탑승" : (c.label || "위치")}</span>
                  {noCoord
                    ? <span className="ml-auto text-[11px] font-bold text-red-500">위치 미등록 · 무료탑승만 가능</span>
                    : (
                      <span className="ml-auto flex items-center gap-1">
                        {!c.isHub && sug.vehicles.length > 1 && (
                          <select value={chosen} onChange={(e) => setAssignVi((m) => ({ ...m, [c.requestId]: Number(e.target.value) }))}
                            className="rounded-lg border border-gray-200 px-1.5 py-1 text-[11px] font-bold dark:border-gray-600 dark:bg-gray-900 dark:text-white">
                            {sug.vehicles.map((v, i) => <option key={i} value={i}>{v.vehicleName}{v.tripLabel ? ` ${v.tripLabel}` : ""}{i === rec ? " ★추천" : ""}</option>)}
                          </select>
                        )}
                        <button onClick={() => assignAdded(c, c.isHub ? rec : chosen)} disabled={hubBusy}
                          className="rounded-lg bg-brand-orange-500 px-2.5 py-1 text-[11px] font-black text-white disabled:opacity-50">
                          {c.isHub ? "🆓 무료탑승 배정" : `${sug.vehicles[chosen]?.vehicleName ?? ""}에 배정`}
                        </button>
                      </span>
                    )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {sug.vehicles.length === 0 && <div className="mt-3 rounded-xl border border-dashed border-gray-300 p-6 text-center text-sm text-gray-400">이 날짜에 배차할 {isPickup ? "등원" : "하원"} 셔틀 학생이 없습니다.</div>}

      <div className="mt-3 lg:grid lg:grid-cols-2 lg:items-start lg:gap-4">
        <div className="grid min-w-0 gap-3">
          {sug.vehicles.map((v, vIdx) => (
            <div key={vIdx} className="overflow-hidden rounded-2xl border border-gray-200 dark:border-gray-700">
              <div className="flex items-center justify-between bg-brand-navy-900 px-4 py-2.5 text-white">
                <span className="font-black">🚐 {v.vehicleName}{v.tripLabel ? ` · ${v.tripLabel}` : ""}</span>
                <span className="flex items-center gap-2">
                  <button type="button" onClick={() => setMapVehicle(vIdx)} className="rounded-full bg-white/15 px-2.5 py-0.5 text-xs font-bold hover:bg-white/25 print:hidden">🗺 지도</button>
                  <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${v.over ? "bg-red-500" : "bg-white/15"}`}>{v.passengers} / {v.capacity}명{regularEditing && v.over ? " · 정원 초과" : ""}</span>
                </span>
              </div>
              <div className="flex items-center gap-2 border-b border-gray-100 bg-gray-50 px-3 py-1.5 text-[11px] font-bold dark:border-gray-700 dark:bg-gray-900/50">
                {v.provider === "TMAP"
                  ? <span className="rounded bg-blue-100 px-1.5 py-0.5 text-blue-700 dark:bg-blue-900/50 dark:text-blue-200">T맵 실도로</span>
                  : <span className="rounded bg-gray-200 px-1.5 py-0.5 text-gray-600 dark:bg-gray-700 dark:text-gray-300">직선 추정</span>}
                {v.tmapMinutes != null && <span className="text-gray-500">약 {v.tmapMinutes}분{v.tmapKm != null ? ` · ${v.tmapKm}km` : ""}</span>}
                {drivers && <label className="ml-auto flex items-center gap-1 print:hidden">담당 기사
                  <select value={v.driverUserId ?? ""} onChange={(event) => setDriver(vIdx, event.target.value)} className="rounded-md border border-gray-200 bg-white px-1.5 py-1 text-[11px] font-bold text-gray-700 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100">
                    <option value="">미배정</option>
                    {drivers.map((driver) => <option key={driver.id} value={driver.id}>{driver.name}</option>)}
                  </select>
                </label>}
              </div>
              <ol className="divide-y divide-gray-100 dark:divide-gray-700">
                <li className="flex items-center gap-2.5 bg-gray-50/60 px-3 py-2 dark:bg-gray-900/40">
                  <span className="grid h-6 w-6 place-items-center rounded-full bg-gray-600 text-[11px] text-white">{isPickup ? "🚏" : "🏫"}</span>
                  <span className="text-[12px] font-bold text-gray-600 dark:text-gray-300">{isPickup ? (sug.depot ? `${sug.depot.name.replace(/^차고지 · /, "차고지 ")} 출발` : "출발") : `${sug.academy.name} 출발`}</span>
                  <label className="ml-auto flex items-center gap-1 text-[11px] font-bold text-gray-500 print:hidden">
                    출발
                    <input type="time" value={v.departTime ?? ""} onChange={(e) => setDepartTime(vIdx, e.target.value)} className="rounded-lg border border-gray-200 px-1.5 py-0.5 text-[11.5px] font-black text-gray-700 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100" />
                  </label>
                  {v.departTime && <span className="hidden text-[11.5px] font-black text-gray-500 print:inline">{v.departTime} 출발</span>}
                </li>
                {v.stops.map((s, sIdx) => (
                  <li key={sIdx}
                    onDragOver={(e) => { if (drag && drag.v === vIdx) e.preventDefault(); else if (stuDrag && s.isHub) e.preventDefault(); }}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (drag && drag.v === vIdx && drag.s !== sIdx) reorderStop(vIdx, drag.s, sIdx);
                      else if (stuDrag && s.isHub) moveStudentToHub(stuDrag.v, stuDrag.s, stuDrag.i);
                      setDrag(null); setStuDrag(null);
                    }}
                    className={`flex items-start gap-2 px-3 py-2.5 ${s.isHub ? "bg-green-50/70 dark:bg-green-900/15" : ""} ${drag && drag.v === vIdx && drag.s === sIdx ? "opacity-40" : ""} ${stuDrag && s.isHub ? "ring-2 ring-inset ring-green-400" : ""}`}>
                    <span draggable onDragStart={(e) => { setDrag({ v: vIdx, s: sIdx }); e.dataTransfer.effectAllowed = "move"; }} onDragEnd={() => setDrag(null)} title="드래그해서 순서 변경" className="mt-0.5 shrink-0 cursor-move select-none text-base leading-none text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 print:hidden">⠿</span>
                    <span className={`mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full text-[11px] font-black text-white ${s.isHub ? "bg-green-600" : "bg-brand-orange-500"}`}>{s.isHub ? "🆓" : sIdx + 1}</span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-bold text-gray-900 dark:text-white">
                        {s.label}
                        {s.isHub
                          ? <>
                              <span className="ml-1 rounded bg-green-600 px-1.5 text-[10px] font-black text-white">무료 탑승 거점</span>
                              {s.students.length > 0 && <span className="ml-1 rounded bg-lime-200 px-1.5 text-[10px] font-black text-brand-navy-900">{s.students.length}명</span>}
                            </>
                          : <span className="ml-1 rounded bg-lime-200 px-1.5 text-[10px] font-black text-brand-navy-900">{s.students.length}명</span>}
                        {s.approx && !s.isHub && <span className="ml-1 rounded bg-amber-100 px-1.5 text-[10px] font-black text-amber-700">추정</span>}
                      </div>
                      <div className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-[11.5px] text-gray-500">
                        {s.isHub ? (
                          <>
                            {s.students.map((st, i) => { const t = tel(st.parentPhone); const canOpen = rosterEditable && !!st.applicationId; return <span key={i} className="font-bold text-green-800 dark:text-green-200"><button type="button" onClick={() => canOpen && setOpenStu({ applicationId: st.applicationId!, rosterId: st.rosterId, requestId: st.requestId })} className={canOpen ? "underline decoration-dotted underline-offset-2 hover:text-green-600" : ""}>{st.name}{st.grade ? `·${st.grade}` : ""}</button>{t && <a href={t} draggable={false} className="ml-0.5 text-green-600">📞</a>}{regularEditing && renderStudentTools(vIdx, sIdx, i, s, st.name)}</span>; })}
                            <span className="text-green-700 dark:text-green-300">학생을 여기로 끌어다 놓으면 무료 거점 {isPickup ? "탑승" : "하차"}으로 지정됩니다 · 워크인 정원 별도</span>
                          </>
                        ) : (
                          s.students.map((st, i) => {
                            const t = tel(st.parentPhone);
                            const canOpen = rosterEditable && !!st.applicationId;
                            return <span key={i} draggable={rosterEditable} onDragStart={(e) => { if (!rosterEditable) return; setStuDrag({ v: vIdx, s: sIdx, i }); e.dataTransfer.effectAllowed = "move"; }} onDragEnd={() => setStuDrag(null)} title={rosterEditable ? "드래그해서 무료 거점으로 이동 · 이름 클릭 시 상세" : undefined} className={rosterEditable ? "cursor-grab select-none rounded px-0.5 hover:bg-lime-100 dark:hover:bg-lime-900/30" : "select-none rounded px-0.5"}>
                              <button type="button" draggable={false} onClick={() => canOpen && setOpenStu({ applicationId: st.applicationId!, rosterId: st.rosterId, requestId: st.requestId })} className={canOpen ? "font-bold underline decoration-dotted underline-offset-2 hover:text-brand-orange-600" : "font-bold"}>{st.name}{st.grade ? `·${st.grade}` : ""}</button>{t && <a href={t} draggable={false} className="ml-0.5 font-bold text-green-600">📞</a>}{regularEditing && renderStudentTools(vIdx, sIdx, i, s, st.name)}</span>;
                          })
                        )}
                      </div>
                    </div>
                    {/* 정규 모드 · 휴대폰: 드래그가 불안정해 한 칸씩 확실히 옮기는 버튼(RegularRouteSection 과 같은 패턴). */}
                    {regularEditing && (
                      <div className="flex shrink-0 flex-col gap-1 sm:hidden print:hidden" aria-label={`${s.label} 정차 순서 변경`}>
                        <button type="button" disabled={sIdx === 0} onClick={() => reorderStop(vIdx, sIdx, sIdx - 1)} aria-label={`${s.label} 위로 이동`} className="grid h-7 w-7 place-items-center rounded-md border border-gray-200 text-xs font-black disabled:opacity-30 dark:border-gray-600 dark:text-gray-200">↑</button>
                        <button type="button" disabled={sIdx === v.stops.length - 1} onClick={() => reorderStop(vIdx, sIdx, sIdx + 1)} aria-label={`${s.label} 아래로 이동`} className="grid h-7 w-7 place-items-center rounded-md border border-gray-200 text-xs font-black disabled:opacity-30 dark:border-gray-600 dark:text-gray-200">↓</button>
                      </div>
                    )}
                    {/* 정차 시각 편집(T2): input으로 직접 확정. 수정 시 '확정(수정됨)' 뱃지 + [다시 계산] 리셋. */}
                    <div className="flex flex-col items-end gap-0.5 print:hidden">
                      <div className="flex items-center gap-1">
                        <input type="time" value={stopEtaHHMM(s)} onChange={(e) => setStopEta(vIdx, sIdx, e.target.value)}
                          title="정차 시각을 직접 확정합니다" draggable={false}
                          className={`rounded-lg border px-1.5 py-0.5 text-[11.5px] font-black dark:bg-gray-900 ${s.etaManual != null ? "border-blue-400 text-blue-700 dark:border-blue-500 dark:text-blue-200" : "border-gray-200 text-blue-600 dark:border-gray-600 dark:text-blue-300"}`} />
                        <span className="whitespace-nowrap text-[10px] font-black text-gray-400">{isPickup ? "승차" : "하차"}</span>
                      </div>
                      {s.etaManual != null && (
                        <div className="flex items-center gap-1">
                          <span className="rounded bg-blue-100 px-1 text-[9px] font-black text-blue-700 dark:bg-blue-900/40 dark:text-blue-200">확정(수정됨)</span>
                          <button type="button" onClick={() => resetStopEta(vIdx, sIdx)} title="자동 계산값으로 되돌립니다"
                            className="text-[10px] font-black text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">↺ 다시 계산</button>
                        </div>
                      )}
                      {/* 정규 모드: 정차를 통째로 다른 차량(회차)으로 옮긴다. 같은 장소가 있으면 합쳐진다. */}
                      {regularEditing && sug.vehicles.length > 1 && (
                        <select value="" onChange={(e) => { if (e.target.value !== "") moveStop(vIdx, sIdx, Number(e.target.value)); }}
                          aria-label={`${s.label} 정차를 다른 차량으로 이동`}
                          className="max-w-[9rem] rounded-lg border border-gray-200 bg-white px-1 py-0.5 text-[10.5px] font-bold text-gray-600 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200">
                          <option value="">→ 차량 이동</option>
                          {sug.vehicles.map((ov, oi) => oi === vIdx ? null : <option key={oi} value={oi}>{vehicleOptionLabel(ov)}</option>)}
                        </select>
                      )}
                    </div>
                    {s.etaLabel && <span className="hidden whitespace-nowrap text-[11.5px] font-black text-black print:inline">{s.etaLabel}</span>}
                  </li>
                ))}
                <li className="flex items-center gap-2.5 bg-gray-50 px-3 py-2.5 dark:bg-gray-900">
                  <span className="grid h-6 w-6 place-items-center rounded-full bg-brand-navy-900 text-[11px] text-white">{isPickup ? "🏫" : "🚏"}</span>
                  <span className="text-[12.5px] font-bold text-gray-700 dark:text-gray-200">{isPickup ? `${sug.academy.name} 도착` : (sug.depot ? `${sug.depot.name.replace(/^차고지 · /, "차고지 ")} 복귀` : "복귀")}</span>
                  {isPickup && v.arriveTime && <span className="ml-auto text-[11.5px] font-black text-gray-500">{v.arriveTime} 도착</span>}
                  {!isPickup && v.depotTime && <span className="ml-auto text-[11.5px] font-black text-gray-500">{v.depotTime} 복귀</span>}
                </li>
              </ol>
            </div>
          ))}
        </div>

        {sug.vehicles.length > 0 && (
          <aside className="mt-3 lg:mt-0 lg:sticky lg:top-4 print:hidden">
            <div className="overflow-hidden rounded-2xl border border-gray-200 dark:border-gray-700">
              <div className="flex items-center justify-between gap-2 bg-brand-navy-900 px-3 py-2 text-white">
                <span className="text-xs font-black">🗺 {isPickup ? "등원" : "하원"} 경로{rerouting ? " · 🔄" : ""}</span>
                {sug.vehicles.length > 1 && (
                  <select value={activeMapIdx} onChange={(e) => setMapVehicle(Number(e.target.value))} className="rounded bg-white/15 px-2 py-1 text-[11px] font-bold text-white">
                    {sug.vehicles.map((v, i) => <option key={i} value={i} className="text-black">{v.vehicleName}{v.tripLabel ? ` ${v.tripLabel}` : ""}</option>)}
                  </select>
                )}
              </div>
              <RouteMapCanvas
                start={{ lat: mapStartPt.lat, lng: mapStartPt.lng, label: isPickup ? "차고지" : "학원" }}
                end={{ lat: mapEndPt.lat, lng: mapEndPt.lng, label: isPickup ? "학원" : "차고지" }}
                stops={sug.vehicles[activeMapIdx].stops.map((s, i) => ({ lat: s.lat, lng: s.lng, label: s.label, badge: s.isHub ? "무료" : String(i + 1), kind: s.isHub ? "hub" : "stop" }))}
                path={sug.vehicles[activeMapIdx].path}
                heightClass="h-[46vh] lg:h-[52vh]"
              />
            </div>
          </aside>
        )}
      </div>

      {sug.unassigned.length > 0 && (
        <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 dark:border-amber-500/30 dark:bg-amber-500/10">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-[12.5px] font-black text-amber-800 dark:text-amber-200">⚠ 좌표가 없어 배차하지 못한 학생 {sug.unassigned.length}명</div>
            {!rosterEditable && <a href="#regular-stop-coordinate-setup" className="rounded-lg bg-amber-700 px-3 py-1.5 text-xs font-black text-white">좌표 설정으로 이동</a>}
          </div>
          {rosterEditable ? (
            <div className="mt-1 text-[12px] text-amber-700 dark:text-amber-200">{sug.unassigned.map((u) => `${u.name}(${u.label ?? "위치없음"})`).join(", ")}</div>
          ) : (
            <details className="mt-2 text-[12px] text-amber-700 dark:text-amber-200"><summary className="cursor-pointer font-bold">누락 학생 확인</summary><div className="mt-1">{sug.unassigned.map((u) => `${u.name}(${u.label ?? "위치없음"})`).join(", ")}</div></details>
          )}
        </div>
      )}

      {openStu && (
        <StudentDetailModal
          applicationId={openStu.applicationId}
          save={{ rosterId: openStu.rosterId, requestId: openStu.requestId }}
          onChanged={() => { void switchTo(sug.date ?? date); }}
          onClose={() => setOpenStu(null)}
        />
      )}
    </section>
  );
}
